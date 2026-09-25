BEGIN;

-- Vendor-attestation tables are administrator-owned after upgrade 0010.
-- Historical migration 0124 must widen their exact provider checks without
-- regaining ownership, so a fresh bootstrap consumes this one-use bridge.
CREATE OR REPLACE FUNCTION extensions.albert_install_lightspeed_x_vendor_attestor_provider()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,control_plane,extensions
AS $$
BEGIN
  IF NOT pg_has_role(session_user,'albert_control_migration_owner','MEMBER') THEN
    RAISE EXCEPTION 'control-plane migration authority is required' USING ERRCODE='42501';
  END IF;
  IF to_regclass('albert_migrations.applied_migration') IS NOT NULL AND EXISTS (
    SELECT 1 FROM albert_migrations.applied_migration
     WHERE stream='control-plane'
       AND migration_id='0124_m1_lightspeed_x_connector_admission.sql'
  ) THEN
    RAISE EXCEPTION 'Lightspeed X vendor-attestor provider bridge has already been consumed'
      USING ERRCODE='55000';
  END IF;

  ALTER TABLE control_plane.live_vendor_attestation_challenges
    DROP CONSTRAINT IF EXISTS live_vendor_attestation_challenges_provider_check;
  ALTER TABLE control_plane.live_vendor_attestation_challenges
    ADD CONSTRAINT live_vendor_attestation_challenges_provider_check CHECK (
      provider IN (
        'lightspeed-r','lightspeed-x','xero','deputy','square','shopify',
        'stripe','momence','meta-ads','google-ads'
      )
    );

  ALTER TABLE control_plane.live_vendor_attestation_results
    DROP CONSTRAINT IF EXISTS live_vendor_attestation_results_provider_check;
  ALTER TABLE control_plane.live_vendor_attestation_results
    ADD CONSTRAINT live_vendor_attestation_results_provider_check CHECK (
      provider IN (
        'lightspeed-r','lightspeed-x','xero','deputy','square','shopify',
        'stripe','momence','meta-ads','google-ads'
      )
    );

  EXECUTE 'REVOKE ALL ON FUNCTION extensions.albert_install_lightspeed_x_vendor_attestor_provider() FROM albert_control_migration_owner';
END;
$$;

ALTER FUNCTION extensions.albert_install_lightspeed_x_vendor_attestor_provider()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION extensions.albert_install_lightspeed_x_vendor_attestor_provider()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION extensions.albert_install_lightspeed_x_vendor_attestor_provider()
  TO albert_control_migration_owner;

COMMIT;
