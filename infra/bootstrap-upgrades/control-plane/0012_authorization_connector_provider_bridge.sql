BEGIN;

-- The vendor-attestation tables are deliberately owned by the managed
-- administrator after their security boundary is finalized. Historical
-- migration 0085 predates that ownership hand-off and must still be replayable
-- on a fresh database without granting the migration role lasting ownership.

CREATE OR REPLACE FUNCTION extensions.albert_install_authorization_connector_providers()
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
    SELECT 1
      FROM albert_migrations.applied_migration
     WHERE stream='control-plane'
       AND migration_id='0085_m1_authorization_only_connector_providers.sql'
  ) THEN
    RAISE EXCEPTION 'authorization connector provider bridge has already been consumed'
      USING ERRCODE='55000';
  END IF;

  ALTER TABLE control_plane.oauth_sessions
    DROP CONSTRAINT IF EXISTS oauth_sessions_provider_check;
  ALTER TABLE control_plane.oauth_sessions
    ADD CONSTRAINT oauth_sessions_provider_check CHECK (
      provider IN (
        'lightspeed-r','xero','deputy','square','shopify','stripe','momence',
        'meta-ads','google-ads'
      )
    );

  ALTER TABLE control_plane.live_vendor_attestation_challenges
    DROP CONSTRAINT IF EXISTS live_vendor_attestation_challenges_provider_check;
  ALTER TABLE control_plane.live_vendor_attestation_challenges
    ADD CONSTRAINT live_vendor_attestation_challenges_provider_check CHECK (
      provider IN (
        'lightspeed-r','xero','deputy','square','shopify','stripe','momence',
        'meta-ads','google-ads'
      )
    );

  ALTER TABLE control_plane.live_vendor_attestation_results
    DROP CONSTRAINT IF EXISTS live_vendor_attestation_results_provider_check;
  ALTER TABLE control_plane.live_vendor_attestation_results
    ADD CONSTRAINT live_vendor_attestation_results_provider_check CHECK (
      provider IN (
        'lightspeed-r','xero','deputy','square','shopify','stripe','momence',
        'meta-ads','google-ads'
      )
    );

  ALTER TABLE control_plane.oauth_sessions
    ADD COLUMN IF NOT EXISTS vendor_account_hint text
      CHECK (
        vendor_account_hint IS NULL
        OR vendor_account_hint ~ '^[a-z0-9][a-z0-9.-]{1,98}[a-z0-9]$'
      );
  ALTER TABLE control_plane.oauth_sessions
    DROP CONSTRAINT IF EXISTS oauth_sessions_vendor_account_hint_provider_check;
  ALTER TABLE control_plane.oauth_sessions
    ADD CONSTRAINT oauth_sessions_vendor_account_hint_provider_check CHECK (
      (provider='shopify' AND vendor_account_hint IS NOT NULL)
      OR (provider<>'shopify' AND vendor_account_hint IS NULL)
    );

  EXECUTE 'REVOKE ALL ON FUNCTION extensions.albert_install_authorization_connector_providers() FROM albert_control_migration_owner';
END;
$$;

ALTER FUNCTION extensions.albert_install_authorization_connector_providers()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION extensions.albert_install_authorization_connector_providers()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION extensions.albert_install_authorization_connector_providers()
  TO albert_control_migration_owner;

COMMIT;
