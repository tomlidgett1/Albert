-- Transform capability issuance holds FOR SHARE on connections for the whole
-- analytical transaction (minutes on large batches). Sync's auth-health probe
-- previously always UPDATEd that row, taking RowExclusiveLock and timing out
-- (55P03) whenever a transform for the same connection was in flight.
--
-- Healthy -> healthy (the common path during InitialBackfill) does not need a
-- row mutation. Skip the UPDATE when auth_health is already the requested
-- value so Share and RowExclusive no longer contend on the hot path.
-- Auth transitions (expiring/expired/revoked/error) still UPDATE.

BEGIN;

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

COMMIT;
