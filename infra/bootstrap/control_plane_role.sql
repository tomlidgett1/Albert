-- Run once as the managed Supabase database administrator. The application
-- never receives membership in this role and the migration runner activates
-- it only for the control-plane migration stream.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'albert_control_migration_owner'
  ) THEN
    CREATE ROLE albert_control_migration_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

-- Deletion executes destructive, credential-bearing work under a dedicated
-- deployment login that is a member of this group only. All data access is
-- mediated by narrowly-scoped SECURITY DEFINER functions in the M8 migration;
-- the role itself receives no table or queue privileges.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'albert_deletion_control'
  ) THEN
    CREATE ROLE albert_deletion_control
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

-- Sync and OAuth exchange share one worker process because credential refresh
-- is part of extraction. This group is still constrained to the exact tables
-- and SECURITY DEFINER queue wrappers granted by migration 0007.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'albert_sync_control'
  ) THEN
    CREATE ROLE albert_sync_control
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

-- The Internet-facing vendor webhook edge has a still smaller identity. It
-- can resolve live connection IDs, deduplicate receipts, and call the fixed
-- enqueue wrapper; it cannot read encrypted OAuth material.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'albert_webhook_control'
  ) THEN
    CREATE ROLE albert_webhook_control
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

-- Canonical workers use a separate control-plane identity. It can claim and
-- project transform state, but it has no grant on OAuth token references,
-- encrypted credential stores, raw payload manifests, or sync queues.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'albert_transform_control'
  ) THEN
    CREATE ROLE albert_transform_control
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

-- Runtime identities are separate LOGIN roles provisioned by the deployment
-- platform. The semantic service receives membership only in this constrained
-- group, so a compromised model/query process cannot read OAuth credentials.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'albert_semantic_control'
  ) THEN
    CREATE ROLE albert_semantic_control
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO albert_transform_control',
    current_database()
  );
END;
$$;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT, CREATE ON DATABASE %I TO albert_control_migration_owner',
    current_database()
  );
END;
$$;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO albert_semantic_control',
    current_database()
  );
END;
$$;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO albert_deletion_control',
    current_database()
  );
END;
$$;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO albert_sync_control, albert_webhook_control',
    current_database()
  );
END;
$$;
GRANT USAGE ON SCHEMA auth, extensions, storage
  TO albert_control_migration_owner;
GRANT USAGE ON SCHEMA extensions TO albert_semantic_control;
GRANT REFERENCES ON TABLE auth.users TO albert_control_migration_owner;
GRANT SELECT, INSERT, UPDATE ON TABLE storage.buckets
  TO albert_control_migration_owner;

-- Extensions are enabled by the Supabase administrator before this bootstrap.
-- The migration owner can call pgmq, but cannot grant extension-owned objects
-- to runtime/browser roles. Runtime access is through SECURITY DEFINER wrappers.
REVOKE ALL ON SCHEMA pgmq, cron FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq, cron FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pgmq, cron FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq, cron FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA pgmq TO albert_control_migration_owner;
GRANT SELECT ON TABLE pgmq.meta TO albert_control_migration_owner;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO albert_control_migration_owner;

-- pg_cron records current_user as the job identity and later executes with
-- that identity's permissions. The DDL owner is intentionally NOLOGIN, so it
-- must never own scheduled jobs. This administrator-owned, fixed-input wrapper
-- is the only cron capability granted to the migration owner. It cannot be
-- repurposed to schedule arbitrary SQL as postgres.
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
    'postgres',
    true
  );
  PERFORM cron.schedule_in_database(
    'albert-nightly-reconciliation',
    '17 2 * * *',
    'SELECT control_plane.enqueue_nightly_reconciliation_sweeps()',
    current_database(),
    'postgres',
    true
  );
  PERFORM cron.schedule_in_database(
    'albert-oauth-session-expiry',
    '*/10 * * * *',
    'SELECT control_plane.expire_oauth_sessions()',
    current_database(),
    'postgres',
    true
  );
END;
$$;
REVOKE ALL ON FUNCTION extensions.albert_install_foundation_cron_jobs()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION extensions.albert_install_foundation_cron_jobs()
  TO albert_control_migration_owner;

-- Installed only after the deletion lifecycle migration exists. Keeping this
-- as a separate fixed-input wrapper avoids a window where pg_cron can invoke a
-- not-yet-created function during a multi-file deployment.
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
    'postgres',
    true
  );
END;
$$;
REVOKE ALL ON FUNCTION extensions.albert_install_deletion_cron_job()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION extensions.albert_install_deletion_cron_job()
  TO albert_control_migration_owner;

-- The managed administrator may SET ROLE during deployment. Runtime roles are
-- intentionally not granted this membership.
GRANT albert_control_migration_owner TO postgres;
