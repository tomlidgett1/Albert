BEGIN;

-- OAuth callback responses are replayable after a committed worker response is
-- lost. Multi-account choices already live on the session; the terminal
-- connection/job identity is persisted alongside the consumed transition.
ALTER TABLE control_plane.oauth_sessions
  ADD COLUMN IF NOT EXISTS completion_result jsonb;
ALTER TABLE control_plane.oauth_sessions
  DROP CONSTRAINT IF EXISTS oauth_sessions_completion_result_check;
ALTER TABLE control_plane.oauth_sessions
  ADD CONSTRAINT oauth_sessions_completion_result_check CHECK (
    completion_result IS NULL
    OR (
      status='consumed'
      AND jsonb_typeof(completion_result)='object'
      AND coalesce(control_plane.is_ulid(completion_result->>'connectionId'),false)
      AND coalesce(control_plane.is_ulid(completion_result->>'jobRequestId'),false)
    )
  );
COMMENT ON COLUMN control_plane.oauth_sessions.completion_result IS
  'Non-secret terminal connection and initial-job identifiers used to replay a committed OAuth callback after response loss.';

-- A browser can request a disconnect, but it cannot choose either the tenant
-- or actor written into the durable deletion intent.  Both identities are
-- derived inside this SECURITY DEFINER transaction and the exact connection
-- row is the serialization point for concurrent disconnect/reconnect calls.
CREATE OR REPLACE FUNCTION public.albert_disconnect_connection(
  p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  selected_tenant text:=control_plane.require_current_tenant_id();
  actor uuid:=auth.uid();
  connection_row control_plane.connections%ROWTYPE;
  request_row control_plane.deletion_requests%ROWTYPE;
  generated_request_id text;
  requested_at timestamptz:=clock_timestamp();
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='42501';
  END IF;
  IF NOT control_plane.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'connection id is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT control_plane.has_tenant_role(
    selected_tenant,ARRAY['owner','manager']::text[]
  ) THEN
    RAISE EXCEPTION 'owner or manager role required' USING ERRCODE='42501';
  END IF;

  SELECT connection.* INTO connection_row
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id=selected_tenant
     AND connection.connection_id=p_connection_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection was not found' USING ERRCODE='P0002';
  END IF;

  SELECT request.* INTO request_row
    FROM control_plane.deletion_requests AS request
   WHERE request.tenant_id=selected_tenant
     AND request.connection_id=p_connection_id
     AND request.scope='connection'
     AND request.status IN ('queued','running','retry_wait','verifying','failed')
   FOR UPDATE;

  IF FOUND THEN
    -- A repeated request is idempotent only while the original disconnect
    -- fence is still in force.  An active request paired with a live
    -- connection indicates corrupt lifecycle state and must not be hidden.
    IF connection_row.status<>'disconnected'
       OR connection_row.auth_health<>'revoked' THEN
      RAISE EXCEPTION 'active deletion is not fenced by the connection'
        USING ERRCODE='55000';
    END IF;
    IF request_row.status IN ('queued','retry_wait','failed') THEN
      PERFORM control_plane.enqueue_deletion_request(
        request_row.deletion_request_id
      );
      SELECT request.* INTO STRICT request_row
        FROM control_plane.deletion_requests AS request
       WHERE request.tenant_id=selected_tenant
         AND request.deletion_request_id=request_row.deletion_request_id;
    END IF;
    RETURN jsonb_build_object(
      'deletionRequestId',request_row.deletion_request_id,
      'status',request_row.status
    );
  END IF;

  IF connection_row.status NOT IN ('connected','degraded') THEN
    RAISE EXCEPTION 'connection is not active' USING ERRCODE='55000';
  END IF;

  generated_request_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.deletion_requests (
    tenant_id,deletion_request_id,connection_id,scope,status,requested_by,
    remote_revocation_status,credential_destroyed_at,
    credential_destruction_due_at,purge_due_at,progress,requested_at
  ) VALUES (
    selected_tenant,generated_request_id,p_connection_id,'connection','queued',actor,
    'pending',NULL,requested_at+interval '15 minutes',requested_at,
    jsonb_build_object(
      'disconnect_intent',jsonb_build_object(
        'durable',true,
        'requestedAt',requested_at
      )
    ),requested_at
  );

  -- Fence all acquisition/ingress paths before publishing the deletion job.
  -- If queue publication fails, PostgreSQL rolls these writes and the intent
  -- back together, leaving the existing connection usable and retryable.
  DELETE FROM control_plane.deputy_webhook_material
   WHERE tenant_id=selected_tenant AND connection_id=p_connection_id;
  UPDATE control_plane.connections
     SET status='disconnected',auth_health='revoked',
         disconnected_at=requested_at
   WHERE tenant_id=selected_tenant AND connection_id=p_connection_id;
  UPDATE control_plane.readiness
     SET state='blocked',reason_code='connection_disconnected',
         reason_detail='Connection data is scheduled for deletion.',
         evaluated_at=requested_at
   WHERE tenant_id=selected_tenant AND connection_id=p_connection_id;
  INSERT INTO control_plane.audit_log (
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata
  ) VALUES (
    selected_tenant,control_plane.generate_ulid(),actor,'user',
    'connection.disconnect_requested','connection',p_connection_id,
    jsonb_build_object(
      'deletion_request_id',generated_request_id,
      'previous_status',connection_row.status,
      'connection_generation',connection_row.connection_generation,
      'durable_before_credential_destruction',true
    )
  );

  PERFORM control_plane.enqueue_deletion_request(generated_request_id);
  SELECT request.* INTO STRICT request_row
    FROM control_plane.deletion_requests AS request
   WHERE request.tenant_id=selected_tenant
     AND request.deletion_request_id=generated_request_id;
  RETURN jsonb_build_object(
    'deletionRequestId',request_row.deletion_request_id,
    'status',request_row.status
  );
END;
$$;

-- Re-authorisation can supersede a disconnect only while the original
-- credential is demonstrably intact and no deletion attempt has started.
-- The OAuth session, connection identity, and active request are all derived
-- and locked here; this function cannot create, retarget, or enqueue a request.
CREATE OR REPLACE FUNCTION control_plane.cancel_reconnectable_connection_deletion(
  p_tenant_id text,
  p_connection_id text,
  p_oauth_session_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  session_row control_plane.oauth_sessions%ROWTYPE;
  connection_row control_plane.connections%ROWTYPE;
  request_row control_plane.deletion_requests%ROWTYPE;
  cancelled_at timestamptz:=clock_timestamp();
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR NOT control_plane.is_ulid(p_oauth_session_id) THEN
    RAISE EXCEPTION 'reconnect cancellation identity is invalid'
      USING ERRCODE='22023';
  END IF;

  SELECT session.* INTO session_row
    FROM control_plane.oauth_sessions AS session
   WHERE session.tenant_id=p_tenant_id
     AND session.oauth_session_id=p_oauth_session_id
     AND session.status='exchanging'
     AND session.expires_at>clock_timestamp()
     AND session.selected_account_reference IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oauth_reconnect_session_not_found' USING ERRCODE='P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.memberships AS membership
     WHERE membership.tenant_id=session_row.tenant_id
       AND membership.user_id=session_row.initiated_by
       AND membership.status='active'
       AND membership.role IN ('owner','manager')
  ) THEN
    RAISE EXCEPTION 'oauth_reconnect_actor_unauthorised' USING ERRCODE='42501';
  END IF;

  SELECT connection.* INTO connection_row
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id=session_row.tenant_id
     AND connection.connection_id=p_connection_id
     AND connection.connector_key=session_row.provider
     AND connection.external_account_reference=
         session_row.selected_account_reference
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oauth_reconnect_connection_mismatch' USING ERRCODE='22023';
  END IF;

  SELECT request.* INTO request_row
    FROM control_plane.deletion_requests AS request
   WHERE request.tenant_id=connection_row.tenant_id
     AND request.connection_id=connection_row.connection_id
     AND request.scope='connection'
     AND request.status IN ('queued','running','retry_wait','verifying','failed')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF connection_row.status<>'disconnected'
     OR connection_row.auth_health<>'revoked'
     OR request_row.status NOT IN ('queued','retry_wait','failed')
     OR request_row.started_at IS NOT NULL
     OR request_row.credential_destroyed_at IS NOT NULL
     OR request_row.remote_revocation_status<>'pending'
     OR EXISTS (
       SELECT 1 FROM control_plane.deletion_job_attempts AS attempt
        WHERE attempt.tenant_id=request_row.tenant_id
          AND attempt.deletion_request_id=request_row.deletion_request_id
     )
     OR (request_row.progress
           - 'disconnect_intent'
           - 'requested'
           - 'requestedAt')<>'{}'::jsonb
     OR NOT EXISTS (
       SELECT 1
         FROM control_plane.oauth_token_refs AS token
         JOIN control_plane.oauth_secret_envelopes AS envelope
           ON envelope.tenant_id=token.tenant_id
          AND envelope.token_ref_id=token.token_ref_id
          AND envelope.retired_at IS NULL
        WHERE token.tenant_id=request_row.tenant_id
          AND token.connection_id=request_row.connection_id
     ) THEN
    RAISE EXCEPTION 'connection_deletion_irreversible' USING ERRCODE='55000';
  END IF;

  UPDATE control_plane.deletion_requests
     SET status='cancelled',completed_at=cancelled_at,
         progress=progress||jsonb_build_object(
           'reconnected',true,
           'reconnectedAt',cancelled_at,
           'oauthSessionId',session_row.oauth_session_id
         )
   WHERE tenant_id=request_row.tenant_id
     AND deletion_request_id=request_row.deletion_request_id;
  INSERT INTO control_plane.audit_log (
    tenant_id,audit_id,actor_user_id,actor_type,action,
    resource_type,resource_id,audit_metadata
  ) VALUES (
    request_row.tenant_id,control_plane.generate_ulid(),session_row.initiated_by,
    'user','connection.deletion_cancelled_by_reconnect','connection',
    request_row.connection_id,jsonb_build_object(
      'deletion_request_id',request_row.deletion_request_id,
      'oauth_session_id',session_row.oauth_session_id
    )
  );
  RETURN request_row.deletion_request_id;
END;
$$;

-- Browser users retain read access to connection state, but every mutation is
-- now mediated by an actor/tenant-deriving RPC.  The OAuth worker keeps its
-- existing connection write capability for finalisation and generation
-- fencing, while losing all generic deletion-table and queue-publication power.
DROP POLICY IF EXISTS tenant_connection_admins_insert ON control_plane.connections;
DROP POLICY IF EXISTS tenant_connection_admins_update ON control_plane.connections;
DROP POLICY IF EXISTS tenant_connection_admins_delete ON control_plane.connections;
REVOKE INSERT,UPDATE,DELETE ON TABLE control_plane.connections FROM authenticated;

DROP POLICY IF EXISTS sync_runtime_access ON control_plane.deletion_requests;
DROP POLICY IF EXISTS sync_runtime_read ON control_plane.deletion_requests;
REVOKE SELECT,INSERT,UPDATE,DELETE ON TABLE control_plane.deletion_requests
  FROM albert_sync_control;
REVOKE EXECUTE ON FUNCTION control_plane.enqueue_deletion_request(text)
  FROM albert_sync_control;

REVOKE ALL ON FUNCTION public.albert_disconnect_connection(text)
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_webhook_control,albert_transform_control,albert_semantic_control,
       albert_operator_diagnostic_control,albert_deletion_control;
GRANT EXECUTE ON FUNCTION public.albert_disconnect_connection(text)
  TO authenticated;

REVOKE ALL ON FUNCTION control_plane.cancel_reconnectable_connection_deletion(
  text,text,text
) FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_webhook_control,albert_transform_control,albert_semantic_control,
       albert_operator_diagnostic_control,albert_deletion_control;
GRANT EXECUTE ON FUNCTION control_plane.cancel_reconnectable_connection_deletion(
  text,text,text
) TO albert_sync_control;

COMMIT;
