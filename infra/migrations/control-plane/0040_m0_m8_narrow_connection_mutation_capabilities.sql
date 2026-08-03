BEGIN;

-- A connection identity may be created or re-authorised only by consuming the
-- exact account, provider and actor bound to a live OAuth exchange.  Persist a
-- request/result binding before the caller moves credential envelopes so a
-- lost SQL response can be replayed without advancing the generation twice.
ALTER TABLE control_plane.oauth_sessions
  ADD COLUMN IF NOT EXISTS connection_finalization_request_hash text,
  ADD COLUMN IF NOT EXISTS connection_finalization_result jsonb;

ALTER TABLE control_plane.oauth_sessions
  DROP CONSTRAINT IF EXISTS oauth_sessions_connection_finalization_check;
ALTER TABLE control_plane.oauth_sessions
  ADD CONSTRAINT oauth_sessions_connection_finalization_check CHECK (
    (
      connection_finalization_request_hash IS NULL
      AND connection_finalization_result IS NULL
    ) OR (
      connection_finalization_request_hash ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(connection_finalization_result)='object'
      AND connection_finalization_result ?& ARRAY[
        'connectionId','connectionGeneration','provider','externalAccountReference'
      ]
      AND connection_finalization_result
            - 'connectionId' - 'connectionGeneration'
            - 'provider' - 'externalAccountReference'='{}'::jsonb
      AND control_plane.is_ulid(connection_finalization_result->>'connectionId')
      AND (connection_finalization_result->>'connectionGeneration') ~ '^[1-9][0-9]*$'
      AND connection_finalization_result->>'provider' IN ('lightspeed-r','xero','deputy')
      AND length(connection_finalization_result->>'externalAccountReference') BETWEEN 1 AND 300
      AND status IN ('exchanging','consumed')
    )
  );

COMMENT ON COLUMN control_plane.oauth_sessions.connection_finalization_request_hash IS
  'SHA-256 of the exact non-secret OAuth connection identity request; supports immutable response-loss replay.';
COMMENT ON COLUMN control_plane.oauth_sessions.connection_finalization_result IS
  'Exact connection id/generation returned by the first authorised identity finalisation.';

-- Account discovery metadata is display-only.  Reject oversized/deep values
-- and credential-shaped keys before a privileged function can persist them.
CREATE OR REPLACE FUNCTION control_plane.oauth_account_metadata_is_safe(
  p_value jsonb,
  p_depth integer DEFAULT 0
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
DECLARE
  member record;
  child jsonb;
  kind text:=jsonb_typeof(p_value);
BEGIN
  IF p_depth<0 OR p_depth>8 OR pg_column_size(p_value)>16384 THEN
    RETURN false;
  END IF;
  IF kind='object' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_value))>64 THEN RETURN false; END IF;
    FOR member IN SELECT key,value FROM jsonb_each(p_value) LOOP
      IF length(member.key) NOT BETWEEN 1 AND 80
         OR member.key ~* '(access.?token|refresh.?token|id.?token|secret|password|credential|authorization|cookie|pkce|code.?verifier|client.?secret|private.?key)'
         OR NOT control_plane.oauth_account_metadata_is_safe(member.value,p_depth+1) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  ELSIF kind='array' THEN
    IF jsonb_array_length(p_value)>100 THEN RETURN false; END IF;
    FOR child IN SELECT value FROM jsonb_array_elements(p_value) AS element(value) LOOP
      IF NOT control_plane.oauth_account_metadata_is_safe(child,p_depth+1) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  ELSIF kind='string' THEN
    RETURN length(p_value#>>'{}')<=1000;
  END IF;
  RETURN kind IN ('number','boolean','null');
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.finalize_oauth_connection_identity(
  p_tenant_id text,
  p_oauth_session_id text,
  p_initiated_by uuid,
  p_provider text,
  p_external_account_reference text,
  p_proposed_connection_id text,
  p_display_name text,
  p_account_metadata jsonb,
  p_provisional_credential_reference text
) RETURNS TABLE(
  connection_id text,
  connection_generation bigint,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  session_row control_plane.oauth_sessions%ROWTYPE;
  connection_row control_plane.connections%ROWTYPE;
  request_document jsonb;
  request_hash text;
  stored_result jsonb;
  selected_connection_id text;
  selected_generation bigint;
  cancelled_request_id text;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_oauth_session_id)
     OR NOT control_plane.is_ulid(p_proposed_connection_id)
     OR p_initiated_by IS NULL
     OR p_provider NOT IN ('lightspeed-r','xero','deputy')
     OR length(p_external_account_reference) NOT BETWEEN 1 AND 300
     OR p_external_account_reference<>btrim(p_external_account_reference)
     OR length(btrim(p_display_name)) NOT BETWEEN 1 AND 160
     OR length(p_provisional_credential_reference) NOT BETWEEN 1 AND 240
     OR p_account_metadata IS NULL
     OR NOT control_plane.oauth_account_metadata_is_safe(p_account_metadata) THEN
    RAISE EXCEPTION 'oauth connection finalization input is invalid'
      USING ERRCODE='22023';
  END IF;

  request_document:=jsonb_build_object(
    'tenantId',p_tenant_id,
    'oauthSessionId',p_oauth_session_id,
    'initiatedBy',p_initiated_by::text,
    'provider',p_provider,
    'externalAccountReference',p_external_account_reference,
    'proposedConnectionId',p_proposed_connection_id,
    'displayName',btrim(p_display_name),
    'accountMetadata',p_account_metadata,
    'provisionalCredentialReference',p_provisional_credential_reference
  );
  request_hash:=encode(
    extensions.digest(convert_to(request_document::text,'utf8'),'sha256'),'hex'
  );

  SELECT session.* INTO session_row
    FROM control_plane.oauth_sessions AS session
   WHERE session.tenant_id=p_tenant_id
     AND session.oauth_session_id=p_oauth_session_id
   FOR UPDATE;
  IF NOT FOUND
     OR session_row.initiated_by IS DISTINCT FROM p_initiated_by
     OR session_row.provider IS DISTINCT FROM p_provider
     OR session_row.selected_account_reference IS DISTINCT FROM p_external_account_reference THEN
    RAISE EXCEPTION 'oauth finalization session identity mismatch'
      USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.memberships AS membership
     WHERE membership.tenant_id=session_row.tenant_id
       AND membership.user_id=session_row.initiated_by
       AND membership.status='active'
       AND membership.role IN ('owner','manager')
  ) THEN
    RAISE EXCEPTION 'oauth finalization actor is not a connection administrator'
      USING ERRCODE='42501';
  END IF;

  IF session_row.connection_finalization_request_hash IS NOT NULL THEN
    IF session_row.connection_finalization_request_hash IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'oauth connection finalization replay differs from the original request'
        USING ERRCODE='55000';
    END IF;
    stored_result:=session_row.connection_finalization_result;
    BEGIN
      selected_connection_id:=stored_result->>'connectionId';
      selected_generation:=(stored_result->>'connectionGeneration')::bigint;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'oauth connection finalization result is invalid'
        USING ERRCODE='55000';
    END;
    IF stored_result->>'provider' IS DISTINCT FROM p_provider
       OR stored_result->>'externalAccountReference' IS DISTINCT FROM p_external_account_reference
       OR NOT EXISTS (
         SELECT 1 FROM control_plane.connections AS connection
          WHERE connection.tenant_id=p_tenant_id
            AND connection.connection_id=selected_connection_id
            AND connection.connector_key=p_provider
            AND connection.external_account_reference=p_external_account_reference
       ) THEN
      RAISE EXCEPTION 'oauth connection finalization replay target is invalid'
        USING ERRCODE='55000';
    END IF;
    connection_id:=selected_connection_id;
    connection_generation:=selected_generation;
    replayed:=true;
    RETURN NEXT;
    RETURN;
  END IF;

  IF session_row.status<>'exchanging'
     OR session_row.expires_at<=clock_timestamp()
     OR session_row.pkce_verifier_secret_reference IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM control_plane.oauth_session_secret_envelopes AS envelope
        WHERE envelope.tenant_id=session_row.tenant_id
          AND envelope.oauth_session_id=session_row.oauth_session_id
          AND envelope.secret_kind='pkce_verifier'
          AND envelope.secret_reference=session_row.pkce_verifier_secret_reference
          AND envelope.consumed_at IS NULL
          AND envelope.destroyed_at IS NULL
     )
     OR NOT EXISTS (
       SELECT 1
         FROM control_plane.oauth_session_secret_envelopes AS envelope
        WHERE envelope.tenant_id=session_row.tenant_id
          AND envelope.oauth_session_id=session_row.oauth_session_id
          AND envelope.secret_kind='exchanged_credential'
          AND envelope.secret_reference=p_provisional_credential_reference
          AND envelope.consumed_at IS NULL
          AND envelope.destroyed_at IS NULL
     ) THEN
    RAISE EXCEPTION 'oauth finalization session is not an active completed exchange'
      USING ERRCODE='55000';
  END IF;
  IF session_row.discovered_account_choices IS NOT NULL
     AND jsonb_array_length(session_row.discovered_account_choices)>0
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(session_row.discovered_account_choices) AS choice(document)
        WHERE choice.document->>'externalAccountId'=p_external_account_reference
     ) THEN
    RAISE EXCEPTION 'oauth finalization account was not offered by discovery'
      USING ERRCODE='42501';
  END IF;

  SELECT connection.* INTO connection_row
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id=p_tenant_id
     AND connection.connector_key=p_provider
     AND connection.external_account_reference=p_external_account_reference
   FOR UPDATE;

  IF FOUND THEN
    selected_connection_id:=connection_row.connection_id;
    IF connection_row.status='disconnected' THEN
      cancelled_request_id:=control_plane.cancel_reconnectable_connection_deletion(
        p_tenant_id,connection_row.connection_id,p_oauth_session_id
      );
      IF cancelled_request_id IS NULL THEN
        RAISE EXCEPTION 'disconnected connection has no reversible deletion intent'
          USING ERRCODE='55000';
      END IF;
    ELSIF connection_row.status NOT IN ('connected','degraded') THEN
      RAISE EXCEPTION 'connection lifecycle does not permit re-authorisation'
        USING ERRCODE='55000';
    END IF;

    UPDATE control_plane.connections AS connection
       SET display_name=btrim(p_display_name),
           status='connected',
           auth_health='healthy',
           account_metadata=p_account_metadata,
           authorised_by=session_row.initiated_by,
           authorised_at=clock_timestamp(),
           last_checked_at=clock_timestamp(),
           disconnected_at=NULL,
           connection_generation=connection.connection_generation+1
     WHERE connection.tenant_id=connection_row.tenant_id
       AND connection.connection_id=connection_row.connection_id
     RETURNING connection.connection_generation INTO selected_generation;
  ELSE
    IF EXISTS (
      SELECT 1 FROM control_plane.connections AS connection
       WHERE connection.tenant_id=p_tenant_id
         AND connection.connection_id=p_proposed_connection_id
    ) THEN
      RAISE EXCEPTION 'proposed connection id is already bound to another identity'
        USING ERRCODE='22023';
    END IF;
    INSERT INTO control_plane.connections (
      tenant_id,connection_id,connector_key,display_name,
      external_account_reference,status,auth_health,account_metadata,
      authorised_by,authorised_at,last_checked_at,connection_generation
    ) VALUES (
      p_tenant_id,p_proposed_connection_id,p_provider,btrim(p_display_name),
      p_external_account_reference,'connected','healthy',p_account_metadata,
      session_row.initiated_by,clock_timestamp(),clock_timestamp(),1
    );
    selected_connection_id:=p_proposed_connection_id;
    selected_generation:=1;
  END IF;

  stored_result:=jsonb_build_object(
    'connectionId',selected_connection_id,
    'connectionGeneration',selected_generation,
    'provider',p_provider,
    'externalAccountReference',p_external_account_reference
  );
  UPDATE control_plane.oauth_sessions AS session
     SET connection_finalization_request_hash=request_hash,
         connection_finalization_result=stored_result
   WHERE session.tenant_id=session_row.tenant_id
     AND session.oauth_session_id=session_row.oauth_session_id
     AND session.status='exchanging'
     AND session.connection_finalization_request_hash IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oauth connection finalization binding conflict'
      USING ERRCODE='55000';
  END IF;

  connection_id:=selected_connection_id;
  connection_generation:=selected_generation;
  replayed:=false;
  RETURN NEXT;
END;
$$;

-- Health observations are accepted only from the exact active queue attempt
-- whose immutable payload names the same tenant, connection, generation,
-- provider, source account and sync run.  This procedure cannot alter status,
-- generation, ownership, metadata or disconnect state.
CREATE OR REPLACE FUNCTION control_plane.record_connection_auth_health(
  p_tenant_id text,
  p_connection_id text,
  p_connection_generation bigint,
  p_connector_key text,
  p_external_account_reference text,
  p_sync_run_id text,
  p_auth_health text,
  p_job_request_id text,
  p_queue_name text,
  p_message_id bigint,
  p_worker_id text,
  p_read_count integer
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  lease_tenant text;
  request_payload jsonb;
  updated_connection_id text;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR p_connection_generation<1
     OR p_connector_key NOT IN ('lightspeed-r','xero','deputy')
     OR length(p_external_account_reference) NOT BETWEEN 1 AND 300
     OR NOT control_plane.is_ulid(p_sync_run_id)
     OR p_auth_health NOT IN ('healthy','expiring','expired','revoked','error') THEN
    RAISE EXCEPTION 'connection auth-health input is invalid' USING ERRCODE='22023';
  END IF;

  lease_tenant:=control_plane.require_active_sync_job_lease(
    p_queue_name,p_message_id,p_job_request_id,p_worker_id,p_read_count
  );
  IF lease_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'connection auth-health lease tenant mismatch' USING ERRCODE='42501';
  END IF;
  SELECT request.payload INTO request_payload
    FROM control_plane.sync_job_requests AS request
   WHERE request.tenant_id=lease_tenant
     AND request.job_request_id=p_job_request_id;
  IF request_payload->>'tenantId' IS DISTINCT FROM p_tenant_id
     OR request_payload->>'connectionId' IS DISTINCT FROM p_connection_id
     OR request_payload->>'connectionGeneration' IS DISTINCT FROM p_connection_generation::text
     OR request_payload->>'connectorId' IS DISTINCT FROM p_connector_key
     OR request_payload->>'externalAccountReference' IS DISTINCT FROM p_external_account_reference
     OR request_payload->>'syncRunId' IS DISTINCT FROM p_sync_run_id THEN
    RAISE EXCEPTION 'connection auth-health target differs from the leased job'
      USING ERRCODE='42501';
  END IF;

  UPDATE control_plane.connections AS connection
     SET auth_health=p_auth_health,last_checked_at=clock_timestamp()
   WHERE connection.tenant_id=p_tenant_id
     AND connection.connection_id=p_connection_id
     AND connection.connection_generation=p_connection_generation
     AND connection.connector_key=p_connector_key
     AND connection.external_account_reference=p_external_account_reference
     AND connection.status IN ('connected','degraded')
   RETURNING connection.connection_id INTO updated_connection_id;
  IF updated_connection_id IS NULL THEN
    RAISE EXCEPTION 'connection auth-health target is not active at the leased generation'
      USING ERRCODE='55000';
  END IF;
  RETURN updated_connection_id;
END;
$$;

-- Supersede migration 0007's permissive write policy.  Sync retains the read
-- access required for credential loading and scheduling, plus only the two
-- reviewed mutation capabilities above.
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.connections;
DROP POLICY IF EXISTS sync_runtime_write ON control_plane.connections;
DROP POLICY IF EXISTS sync_runtime_read ON control_plane.connections;
CREATE POLICY sync_runtime_read ON control_plane.connections
  FOR SELECT TO albert_sync_control USING (true);

REVOKE INSERT,UPDATE,DELETE ON TABLE control_plane.connections
  FROM albert_sync_control;
GRANT SELECT ON TABLE control_plane.connections TO albert_sync_control;

REVOKE ALL ON FUNCTION control_plane.oauth_account_metadata_is_safe(jsonb,integer)
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_webhook_control,albert_transform_control,albert_semantic_control,
       albert_operator_diagnostic_control,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.finalize_oauth_connection_identity(
  text,text,uuid,text,text,text,text,jsonb,text
) FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_webhook_control,albert_transform_control,albert_semantic_control,
       albert_operator_diagnostic_control,albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.record_connection_auth_health(
  text,text,bigint,text,text,text,text,text,text,bigint,text,integer
) FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_webhook_control,albert_transform_control,albert_semantic_control,
       albert_operator_diagnostic_control,albert_deletion_control;

-- Reconnect cancellation is an implementation detail of the OAuth-bound
-- finalizer; the sync role may no longer invoke it independently.
REVOKE EXECUTE ON FUNCTION control_plane.cancel_reconnectable_connection_deletion(
  text,text,text
) FROM albert_sync_control;

GRANT EXECUTE ON FUNCTION control_plane.finalize_oauth_connection_identity(
  text,text,uuid,text,text,text,text,jsonb,text
) TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.record_connection_auth_health(
  text,text,bigint,text,text,text,text,text,text,bigint,text,integer
) TO albert_sync_control;

COMMIT;
