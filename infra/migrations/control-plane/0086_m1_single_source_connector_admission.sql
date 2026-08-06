-- Every connector guard in the control plane enumerated the three ingesting
-- packs inline. Adding an authorization-only pack therefore required editing
-- table constraints and five separate function bodies, and missing one failed
-- the connect at its final write -- after the browser had already returned
-- from the vendor with a consumed authorization code.
--
-- Replace the scattered literals with one source of truth. A new connector now
-- changes exactly one list, and an unknown provider is still rejected: the
-- helper enumerates, it does not pattern-match.
--
-- The five functions below are reproduced verbatim from their latest prior
-- definitions with only the guard expression repointed, so no behaviour other
-- than connector admission changes.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.is_known_connector(p_connector text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $function$
  SELECT p_connector IN (
    'lightspeed-r', 'xero', 'deputy', 'square',
    'shopify', 'stripe', 'momence', 'meta-ads', 'google-ads'
  );
$function$;

REVOKE ALL ON FUNCTION control_plane.is_known_connector(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_plane.is_known_connector(text)
  TO service_role, authenticated, albert_sync_control, albert_webhook_control;

-- Table constraints that enumerated the same list inline.
ALTER TABLE control_plane.canonical_transform_jobs
  DROP CONSTRAINT IF EXISTS canonical_transform_jobs_connector_id_check;
ALTER TABLE control_plane.canonical_transform_jobs
  ADD CONSTRAINT canonical_transform_jobs_connector_id_check
  CHECK (control_plane.is_known_connector(connector_id));

ALTER TABLE control_plane.reconciliation_stream_sweeps
  DROP CONSTRAINT IF EXISTS reconciliation_stream_sweeps_connector_id_check;
ALTER TABLE control_plane.reconciliation_stream_sweeps
  ADD CONSTRAINT reconciliation_stream_sweeps_connector_id_check
  CHECK (control_plane.is_known_connector(connector_id));

-- Reproduced from 0040_m0_m8_narrow_connection_mutation_capabilities.sql with the connector guard
-- repointed at control_plane.is_known_connector.
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
     OR NOT control_plane.is_known_connector(p_provider)
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

-- Reproduced from 0077_m2_auth_health_skip_unchanged_update.sql with the connector guard
-- repointed at control_plane.is_known_connector.
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
  current_auth_health text;
  updated_connection_id text;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR p_connection_generation<1
     OR NOT control_plane.is_known_connector(p_connector_key)
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

  SELECT connection.auth_health, connection.connection_id
    INTO current_auth_health, updated_connection_id
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id=p_tenant_id
     AND connection.connection_id=p_connection_id
     AND connection.connection_generation=p_connection_generation
     AND connection.connector_key=p_connector_key
     AND connection.external_account_reference=p_external_account_reference
     AND connection.status IN ('connected','degraded');
  IF updated_connection_id IS NULL THEN
    RAISE EXCEPTION 'connection auth-health target is not active at the leased generation'
      USING ERRCODE='55000';
  END IF;

  -- Unchanged healthy/expiring probes must not fight transform ShareLocks.
  IF current_auth_health IS NOT DISTINCT FROM p_auth_health THEN
    RETURN updated_connection_id;
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

-- Reproduced from 0002_m1_public_runtime.sql with the connector guard
-- repointed at control_plane.is_known_connector.
CREATE OR REPLACE FUNCTION control_plane.create_oauth_session(
  p_tenant_id text,
  p_initiated_by uuid,
  p_provider text,
  p_state_nonce_hash text,
  p_pkce_verifier_secret_reference text,
  p_redirect_uri text,
  p_requested_scopes text[],
  p_expires_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  generated_session text := control_plane.generate_ulid();
BEGIN
  IF NOT control_plane.is_known_connector(p_provider)
     OR p_state_nonce_hash !~ '^[0-9a-f]{64}$'
     OR p_redirect_uri !~ '^https://'
     OR p_expires_at <= now()
     OR p_expires_at > now() + interval '30 minutes'
     OR p_pkce_verifier_secret_reference IS NULL
     OR length(btrim(p_pkce_verifier_secret_reference)) = 0 THEN
    RAISE EXCEPTION 'OAuth session input is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.memberships AS membership
    WHERE membership.tenant_id = p_tenant_id
      AND membership.user_id = p_initiated_by
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'manager')
  ) THEN
    RAISE EXCEPTION 'OAuth initiator is not a connection administrator' USING ERRCODE = '42501';
  END IF;

  INSERT INTO control_plane.oauth_sessions (
    tenant_id, oauth_session_id, initiated_by, provider, state_nonce_hash,
    pkce_verifier_secret_reference, redirect_uri, requested_scopes,
    status, expires_at
  ) VALUES (
    p_tenant_id, generated_session, p_initiated_by, p_provider,
    p_state_nonce_hash, p_pkce_verifier_secret_reference, p_redirect_uri,
    coalesce(p_requested_scopes, ARRAY[]::text[]), 'pending', p_expires_at
  );

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    p_tenant_id, control_plane.generate_ulid(), p_initiated_by, 'service',
    'oauth.session_created', 'oauth_session', generated_session,
    jsonb_build_object('provider', p_provider, 'expires_at', p_expires_at)
  );
  RETURN generated_session;
END;
$$;

-- Reproduced from 0003_m2_ingestion_operations.sql with the connector guard
-- repointed at control_plane.is_known_connector.
CREATE OR REPLACE FUNCTION public.albert_create_connection(
  p_connector_key text,
  p_display_name text
)
RETURNS TABLE (connection_id text, connector_key text, display_name text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  generated_connection text := control_plane.generate_ulid();
BEGIN
  IF NOT control_plane.has_tenant_role(selected_tenant, ARRAY['owner', 'manager']::text[]) THEN
    RAISE EXCEPTION 'owner or manager role required' USING ERRCODE = '42501';
  END IF;
  IF NOT control_plane.is_known_connector(p_connector_key)
     OR length(btrim(p_display_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'connection input is invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.connections (
    tenant_id, connection_id, connector_key, display_name, status,
    auth_health, authorised_by
  ) VALUES (
    selected_tenant, generated_connection, p_connector_key, btrim(p_display_name),
    'pending', 'unknown', actor
  );
  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action,
    resource_type, resource_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'connection.created', 'connection', generated_connection,
    jsonb_build_object('connector_key', p_connector_key)
  );
  RETURN QUERY SELECT generated_connection, p_connector_key, btrim(p_display_name), 'pending'::text;
END;
$$;

-- Reproduced from 0033_m2_durable_reconciliation_sweeps.sql with the connector guard
-- repointed at control_plane.is_known_connector.
CREATE OR REPLACE FUNCTION control_plane.register_reconciliation_stream(
  p_tenant_id text,
  p_connection_id text,
  p_connection_generation bigint,
  p_reconciliation_sweep_id text,
  p_connector_id text,
  p_stream text,
  p_required boolean,
  p_domains text[],
  p_late_edit_strategy text,
  p_deletion_strategy text,
  p_source_total_strategy text,
  p_lookback_from timestamptz,
  p_lookback_to timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE existing control_plane.reconciliation_stream_sweeps%ROWTYPE;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR NOT control_plane.is_ulid(p_reconciliation_sweep_id)
     OR p_connection_generation < 1
     OR NOT control_plane.is_known_connector(p_connector_id)
     OR p_stream !~ '^[a-z][a-z0-9_]*$'
     OR coalesce(cardinality(p_domains),0)=0
     OR p_late_edit_strategy NOT IN ('modified_field','full_snapshot','append_only')
     OR p_deletion_strategy NOT IN (
       'soft_delete','verified_delete_feed','authoritative_identity_scan','immutable_append_only'
     )
     OR p_source_total_strategy NOT IN ('provider_reported','count_distinct_complete_scan')
     OR p_lookback_from > p_lookback_to
     OR (p_deletion_strategy='immutable_append_only' AND p_late_edit_strategy<>'append_only') THEN
    RAISE EXCEPTION 'reconciliation stream registration is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.connections connection
     WHERE connection.tenant_id=p_tenant_id
       AND connection.connection_id=p_connection_id
       AND connection.connector_key=p_connector_id
       AND connection.connection_generation=p_connection_generation
       AND connection.status IN ('connected','degraded')
  ) THEN
    RAISE EXCEPTION 'reconciliation connection generation is stale' USING ERRCODE='55000';
  END IF;

  SELECT * INTO existing
    FROM control_plane.reconciliation_stream_sweeps
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id
     AND connection_generation=p_connection_generation
     AND reconciliation_sweep_id=p_reconciliation_sweep_id AND stream=p_stream
   FOR UPDATE;
  IF FOUND THEN
    IF existing.connector_id<>p_connector_id OR existing.required<>p_required
       OR existing.domains<>p_domains
       OR existing.late_edit_strategy<>p_late_edit_strategy
       OR existing.deletion_strategy<>p_deletion_strategy
       OR existing.source_total_strategy<>p_source_total_strategy
       OR existing.lookback_from<>p_lookback_from OR existing.lookback_to<>p_lookback_to THEN
      RAISE EXCEPTION 'reconciliation stream registration conflicts with durable plan'
        USING ERRCODE='55000';
    END IF;
    RETURN;
  END IF;

  INSERT INTO control_plane.reconciliation_stream_sweeps (
    tenant_id,connection_id,connection_generation,reconciliation_sweep_id,
    connector_id,stream,required,domains,late_edit_strategy,deletion_strategy,
    source_total_strategy,lookback_from,lookback_to
  ) VALUES (
    p_tenant_id,p_connection_id,p_connection_generation,p_reconciliation_sweep_id,
    p_connector_id,p_stream,p_required,p_domains,p_late_edit_strategy,p_deletion_strategy,
    p_source_total_strategy,p_lookback_from,p_lookback_to
  );
END;
$$;

COMMIT;
