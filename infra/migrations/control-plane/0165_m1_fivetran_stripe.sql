-- 0165: Fivetran Stripe joins the multi-service control-plane contract.
--
-- Stripe lands through Fivetran's native connector (service `stripe`) into
-- one destination schema per connection (`stripe_<connection_ulid>`). Albert
-- takes Stripe Connect OAuth itself and hands the grant to Fivetran. The
-- workspace projection names the dash connector key and a payments readiness
-- domain.

BEGIN;

ALTER TABLE control_plane.fivetran_connections
  DROP CONSTRAINT IF EXISTS fivetran_connections_service_check;
ALTER TABLE control_plane.fivetran_connections
  ADD CONSTRAINT fivetran_connections_service_check
  CHECK (service IN ('xero', 'light_speed_retail', 'deputy', 'stripe'));

CREATE OR REPLACE FUNCTION public.albert_fivetran_workspace_connections()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'connection_id', connection.connection_id,
    'connector_key', CASE connection.service
      WHEN 'xero' THEN 'fivetran-xero'
      WHEN 'light_speed_retail' THEN 'fivetran-lightspeed'
      WHEN 'deputy' THEN 'fivetran-deputy'
      WHEN 'stripe' THEN 'fivetran-stripe'
      ELSE 'fivetran-' || connection.service
    END,
    'display_name', connection.display_name,
    'status', connection.status,
    'auth_health', connection.auth_health,
    'account_metadata', connection.account_metadata,
    'authorised_at', connection.authorised_at,
    'last_checked_at', connection.last_checked_at,
    'manual_ingestion_start_required', false,
    'ingestion_blocked_reason', NULL,
    'ingestion_state', CASE
      WHEN connection.status = 'disconnected' THEN 'inactive'
      WHEN connection.last_sync_state IN ('syncing', 'rescheduled') THEN 'running'
      ELSE 'active'
    END,
    'readiness', jsonb_build_array(jsonb_build_object(
      'domain', CASE connection.service
        WHEN 'xero' THEN 'accounting'
        WHEN 'light_speed_retail' THEN 'sales'
        WHEN 'deputy' THEN 'workforce'
        WHEN 'stripe' THEN 'payments'
        ELSE 'source'
      END,
      'state', CASE
        WHEN connection.status = 'disconnected' THEN 'blocked'
        WHEN connection.status = 'blocked' THEN 'blocked'
        WHEN connection.last_sync_state IN ('syncing', 'rescheduled', 'scheduled') THEN 'syncing'
        WHEN connection.last_sync_state = 'succeeded' THEN 'ready_complete'
        WHEN connection.status = 'degraded' OR connection.last_sync_state = 'failed' THEN 'degraded'
        ELSE 'syncing'
      END,
      'progress', NULL,
      'data_ready_through', NULL,
      'backfill_complete', connection.last_sync_state = 'succeeded',
      'reason_code', NULL
    ))
  ) ORDER BY connection.created_at), '[]'::jsonb)
  FROM control_plane.fivetran_connections AS connection
  WHERE connection.tenant_id = control_plane.require_current_tenant_id()
    AND connection.status IN ('connected', 'degraded', 'blocked');
$$;

REVOKE ALL ON FUNCTION public.albert_fivetran_workspace_connections() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_fivetran_workspace_connections() TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
