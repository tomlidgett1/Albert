BEGIN;

-- Shopify's Admin events ledger is retained for one year. When the worker can
-- no longer prove a continuous destroy-event watermark, stale deleted rows
-- must not remain queryable behind an otherwise-ready connection. This
-- lease-bound mutation blocks the exact active generation. Recovery is an
-- explicit full Disconnect, successful proof-producing local purge,
-- reconnect, and a new manual Start; reauthorisation alone is insufficient.
CREATE OR REPLACE FUNCTION control_plane.block_shopify_deletion_continuity(
  p_tenant_id text,
  p_connection_id text,
  p_connection_generation bigint,
  p_connector_key text,
  p_external_account_reference text,
  p_sync_run_id text,
  p_reason text,
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
     OR p_connector_key<>'shopify'
     OR length(p_external_account_reference) NOT BETWEEN 1 AND 300
     OR NOT control_plane.is_ulid(p_sync_run_id)
     OR p_reason NOT IN (
       'shopify_deletion_continuity_unproven',
       'shopify_deletion_watermark_missing',
       'shopify_deletion_retention_gap',
       'shopify_deletion_feed_unavailable'
     ) THEN
    RAISE EXCEPTION 'Shopify deletion-continuity input is invalid'
      USING ERRCODE='22023';
  END IF;

  lease_tenant:=control_plane.require_active_sync_job_lease(
    p_queue_name,p_message_id,p_job_request_id,p_worker_id,p_read_count
  );
  IF lease_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'Shopify deletion-continuity lease tenant mismatch'
      USING ERRCODE='42501';
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
    RAISE EXCEPTION 'Shopify deletion-continuity target differs from the leased job'
      USING ERRCODE='42501';
  END IF;

  UPDATE control_plane.connections AS connection
     SET ingestion_activated_at=NULL,
         ingestion_activated_by=NULL,
         ingestion_activated_generation=NULL,
         ingestion_blocked_reason=p_reason
   WHERE connection.tenant_id=p_tenant_id
     AND connection.connection_id=p_connection_id
     AND connection.connection_generation=p_connection_generation
     AND connection.connector_key='shopify'
     AND connection.external_account_reference=p_external_account_reference
     AND connection.status IN ('connected','degraded')
  RETURNING connection.connection_id INTO updated_connection_id;
  IF updated_connection_id IS NULL THEN
    RAISE EXCEPTION 'Shopify deletion-continuity target is not active at the leased generation'
      USING ERRCODE='55000';
  END IF;

  -- The UPDATE above waits for every currently issued analytical capability's
  -- connection share lock. Once it commits, revoke all remaining permits for
  -- this generation so no concurrent claim can publish after the block.
  DELETE FROM control_plane.sync_write_permits AS permit
   WHERE permit.tenant_id=p_tenant_id
     AND permit.connection_id=p_connection_id
     AND permit.connection_generation=p_connection_generation;

  UPDATE control_plane.readiness AS readiness
     SET state='blocked',progress=0,backfill_complete=false,
         reason_code=p_reason,
         reason_detail='Shopify destroy-event continuity is not provable within the one-year vendor retention window. Disconnect this store, wait for verified local deletion to complete, reconnect it, then explicitly Start ingestion.',
         evaluated_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE readiness.tenant_id=p_tenant_id
     AND readiness.connection_id=p_connection_id;
  RETURN updated_connection_id;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.block_shopify_deletion_continuity(
  text,text,bigint,text,text,text,text,text,text,bigint,text,integer
) FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_webhook_control,albert_transform_control,albert_semantic_control,
       albert_operator_diagnostic_control,albert_deletion_control;
GRANT EXECUTE ON FUNCTION control_plane.block_shopify_deletion_continuity(
  text,text,bigint,text,text,text,text,text,text,bigint,text,integer
) TO albert_sync_control;

-- OAuth configuration historically clears ingestion_blocked_reason. Preserve
-- a continuity block on the same connection identity so a token rotation or
-- cancelled disconnect cannot republish hidden data. Verified connection
-- deletion removes the analytical block and tombstones this control row's
-- external identity; the subsequent reconnect creates a fresh connection.
CREATE OR REPLACE FUNCTION control_plane.preserve_shopify_deletion_continuity_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF OLD.connector_key='shopify'
     AND OLD.ingestion_blocked_reason IN (
       'shopify_deletion_continuity_unproven',
       'shopify_deletion_watermark_missing',
       'shopify_deletion_retention_gap',
       'shopify_deletion_feed_unavailable'
     ) THEN
    NEW.ingestion_blocked_reason:=OLD.ingestion_blocked_reason;
    NEW.ingestion_activated_at:=NULL;
    NEW.ingestion_activated_by:=NULL;
    NEW.ingestion_activated_generation:=NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS preserve_shopify_deletion_continuity_block
  ON control_plane.connections;
CREATE TRIGGER preserve_shopify_deletion_continuity_block
BEFORE UPDATE OF ingestion_blocked_reason,ingestion_activated_at,
                 ingestion_activated_by,ingestion_activated_generation
ON control_plane.connections
FOR EACH ROW
EXECUTE FUNCTION control_plane.preserve_shopify_deletion_continuity_block();

REVOKE ALL ON FUNCTION control_plane.preserve_shopify_deletion_continuity_block()
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;

-- Surface the exact safety reason to the manual-start API without expanding
-- the browser's authority. The original definer still performs every tenant,
-- role, connection and queue mutation check.
ALTER FUNCTION public.albert_start_connection_ingestion(text)
  RENAME TO albert_start_connection_ingestion_before_shopify_continuity;

CREATE FUNCTION public.albert_start_connection_ingestion(p_connection_id text)
RETURNS TABLE(accepted boolean,sync_run_id text,job_request_id text,reason text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  result record;
  selected_reason text;
  selected_tenant text;
BEGIN
  SELECT * INTO result
    FROM public.albert_start_connection_ingestion_before_shopify_continuity(
      p_connection_id
    );
  selected_reason:=result.reason;
  IF result.accepted IS FALSE AND result.reason='operator_blocked' THEN
    selected_tenant:=control_plane.require_current_tenant_id();
    SELECT connection.ingestion_blocked_reason INTO selected_reason
      FROM control_plane.connections AS connection
     WHERE connection.tenant_id=selected_tenant
       AND connection.connection_id=p_connection_id
       AND connection.connector_key='shopify'
       AND connection.ingestion_blocked_reason IN (
         'shopify_deletion_continuity_unproven',
         'shopify_deletion_watermark_missing',
         'shopify_deletion_retention_gap',
         'shopify_deletion_feed_unavailable'
       );
    selected_reason:=coalesce(selected_reason,result.reason);
  END IF;
  RETURN QUERY SELECT result.accepted,result.sync_run_id,
                      result.job_request_id,selected_reason;
END;
$$;

REVOKE ALL ON FUNCTION
  public.albert_start_connection_ingestion_before_shopify_continuity(text)
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;
GRANT EXECUTE ON FUNCTION
  public.albert_start_connection_ingestion_before_shopify_continuity(text)
TO albert_migration_owner;
REVOKE ALL ON FUNCTION public.albert_start_connection_ingestion(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_start_connection_ingestion(text)
TO authenticated;

COMMIT;
