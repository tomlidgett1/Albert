BEGIN;

-- Versioned administrator bootstrap upgrade. This is deliberately separate
-- from the one-time base bootstrap: already-bootstrapped databases retain the
-- original base checksum while gaining a fixed-input, administrator-owned
-- pg_cron installer for migration 0035.
CREATE OR REPLACE FUNCTION extensions.albert_install_xero_inbox_retention_cron_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM cron.schedule_in_database(
    'albert-xero-inbox-retention',
    '* * * * *',
    'SELECT control_plane.purge_xero_webhook_inbox(5000)',
    current_database(),
    'postgres',
    true
  );
END;
$$;

REVOKE ALL ON FUNCTION extensions.albert_install_xero_inbox_retention_cron_job()
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_deletion_control;
GRANT EXECUTE ON FUNCTION extensions.albert_install_xero_inbox_retention_cron_job()
  TO albert_control_migration_owner;

COMMIT;
