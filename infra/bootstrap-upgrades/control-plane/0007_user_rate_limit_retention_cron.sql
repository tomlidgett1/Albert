BEGIN;

-- pg_cron scheduling is a protected managed-Supabase administrator action.
-- Expose one fixed-input capability to migration 0056 and consume the grant in
-- the same transaction so no general scheduling authority reaches migrations.
DO $$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'user rate-limit retention scheduling requires the protected postgres login';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_install_user_rate_limit_retention_cron_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM cron.schedule_in_database(
    'albert-user-rate-limit-retention',
    '19 * * * *',
    'SELECT control_plane.purge_user_rate_limit_buckets()',
    current_database(),
    NULL,
    true
  );
  REVOKE EXECUTE ON FUNCTION
    extensions.albert_install_user_rate_limit_retention_cron_job()
    FROM albert_control_migration_owner;
END;
$$;

REVOKE ALL ON FUNCTION
  extensions.albert_install_user_rate_limit_retention_cron_job()
  FROM PUBLIC,anon,authenticated,service_role,
       albert_sync_control,albert_webhook_control,albert_transform_control,
       albert_semantic_control,albert_operator_diagnostic_control,
       albert_deletion_control;
GRANT EXECUTE ON FUNCTION
  extensions.albert_install_user_rate_limit_retention_cron_job()
  TO albert_control_migration_owner;

-- Repair the inverse upgrade order for an existing cell. The fixed installer
-- is idempotent by pg_cron's named-job upsert and revokes its own grant.
DO $$
BEGIN
  IF to_regclass('albert_migrations.applied_migration') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM albert_migrations.applied_migration
       WHERE stream = 'control-plane'
         AND migration_id = '0056_m1_user_bound_organisation_creation_rate_limit.sql'
    ) THEN
      PERFORM extensions.albert_install_user_rate_limit_retention_cron_job();
    END IF;
  END IF;
END;
$$;

COMMIT;
