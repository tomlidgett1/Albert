BEGIN;

-- Local and hosted Supabase expose `postgres` as a protected non-superuser.
-- pg_cron rejects any explicit username from that identity as scheduling for
-- another role. NULL means the current SECURITY DEFINER identity and preserves
-- the same fixed postgres-owned execution boundary without role impersonation.
DO $$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'managed-postgres cron compatibility requires the protected postgres login';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_install_foundation_cron_jobs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM cron.schedule_in_database(
    'albert-incremental-sync-scheduler',
    '*/5 * * * *',
    'SELECT control_plane.enqueue_due_incremental_syncs()',
    current_database(),
    NULL,
    true
  );
  PERFORM cron.schedule_in_database(
    'albert-nightly-reconciliation',
    '17 2 * * *',
    'SELECT control_plane.enqueue_nightly_reconciliation_sweeps()',
    current_database(),
    NULL,
    true
  );
  PERFORM cron.schedule_in_database(
    'albert-oauth-session-expiry',
    '*/10 * * * *',
    'SELECT control_plane.expire_oauth_sessions()',
    current_database(),
    NULL,
    true
  );
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_install_deletion_cron_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM cron.schedule_in_database(
    'albert-deletion-scheduler',
    '*/5 * * * *',
    'SELECT control_plane.enqueue_due_deletions()',
    current_database(),
    NULL,
    true
  );
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_install_conversation_reaper_cron_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM cron.schedule_in_database(
    'albert-conversation-turn-reaper',
    '* * * * *',
    'SELECT control_plane.reap_expired_conversation_turns()',
    current_database(),
    NULL,
    true
  );
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_install_sync_lifecycle_cron_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM cron.schedule_in_database(
    'albert-sync-lifecycle-recovery',
    '*/5 * * * *',
    'SELECT control_plane.recover_sync_stream_phases()',
    current_database(),
    NULL,
    true
  );
END;
$$;

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
    NULL,
    true
  );
END;
$$;

REVOKE ALL ON FUNCTION extensions.albert_install_foundation_cron_jobs()
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_deletion_control;
REVOKE ALL ON FUNCTION extensions.albert_install_deletion_cron_job()
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_deletion_control;
REVOKE ALL ON FUNCTION extensions.albert_install_conversation_reaper_cron_job()
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_deletion_control;
REVOKE ALL ON FUNCTION extensions.albert_install_sync_lifecycle_cron_job()
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_deletion_control;
REVOKE ALL ON FUNCTION extensions.albert_install_xero_inbox_retention_cron_job()
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_deletion_control;

GRANT EXECUTE ON FUNCTION extensions.albert_install_foundation_cron_jobs(),
  extensions.albert_install_deletion_cron_job(),
  extensions.albert_install_conversation_reaper_cron_job(),
  extensions.albert_install_sync_lifecycle_cron_job(),
  extensions.albert_install_xero_inbox_retention_cron_job()
  TO albert_control_migration_owner;

COMMIT;
