-- Lightspeed Retail X-Series is a distinct connector contract from R-Series.
-- Admit its immutable connector id through the single connector source of
-- truth. Manual ingestion policy remains manifest-driven and generation-bound
-- by the generic functions introduced in 0122 and superseded in 0123.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.is_known_connector(p_connector text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT p_connector IN (
    'lightspeed-r', 'lightspeed-x', 'xero', 'deputy', 'square',
    'shopify', 'stripe', 'momence', 'meta-ads', 'google-ads'
  );
$function$;

REVOKE ALL ON FUNCTION control_plane.is_known_connector(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION control_plane.is_known_connector(text) FROM service_role;
GRANT EXECUTE ON FUNCTION control_plane.is_known_connector(text)
  TO authenticated, albert_sync_control, albert_webhook_control;

-- OAuth and independent-attestation tables predate the shared helper and keep
-- an enumerated provider CHECK. Widen them before an X-Series authorization
-- code can be exchanged, so the one-use code is never consumed by a callback
-- that subsequently fails to persist its session.
ALTER TABLE control_plane.oauth_sessions
  DROP CONSTRAINT IF EXISTS oauth_sessions_provider_check;
ALTER TABLE control_plane.oauth_sessions
  ADD CONSTRAINT oauth_sessions_provider_check CHECK (
    provider IN (
      'lightspeed-r', 'lightspeed-x', 'xero', 'deputy', 'square',
      'shopify', 'stripe', 'momence', 'meta-ads', 'google-ads'
    )
  );

ALTER TABLE control_plane.live_vendor_attestation_challenges
  DROP CONSTRAINT IF EXISTS live_vendor_attestation_challenges_provider_check;
ALTER TABLE control_plane.live_vendor_attestation_challenges
  ADD CONSTRAINT live_vendor_attestation_challenges_provider_check CHECK (
    provider IN (
      'lightspeed-r', 'lightspeed-x', 'xero', 'deputy', 'square',
      'shopify', 'stripe', 'momence', 'meta-ads', 'google-ads'
    )
  );

ALTER TABLE control_plane.live_vendor_attestation_results
  DROP CONSTRAINT IF EXISTS live_vendor_attestation_results_provider_check;
ALTER TABLE control_plane.live_vendor_attestation_results
  ADD CONSTRAINT live_vendor_attestation_results_provider_check CHECK (
    provider IN (
      'lightspeed-r', 'lightspeed-x', 'xero', 'deputy', 'square',
      'shopify', 'stripe', 'momence', 'meta-ads', 'google-ads'
    )
  );

-- X-Series is manual-start by contract. This is a defence-in-depth repair for
-- any connection row created during a rolling deployment; the OAuth worker's
-- manifest policy performs the same generation-bound write transactionally.
UPDATE control_plane.connections AS connection
   SET ingestion_start_mode = 'manual',
       ingestion_activated_at = NULL,
       ingestion_activated_by = NULL,
       ingestion_activated_generation = NULL,
       ingestion_blocked_reason = NULL
 WHERE connection.connector_key = 'lightspeed-x';

COMMENT ON COLUMN control_plane.connections.ingestion_activated_generation IS
  'Latest connection generation explicitly cleared for ingestion. Lightspeed X-Series and other manual-start packs require equality with connection_generation.';

COMMIT;
