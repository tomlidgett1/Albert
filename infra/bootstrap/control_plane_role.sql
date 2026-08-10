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
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

-- The Claude Agent SDK process receives no database credential. Its host
-- service uses this narrow identity only for opaque session transcripts and
-- conversation/session binding; all analytical reads still go through the
-- separately signed semantic-query service.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'albert_anthropic_control'
  ) THEN
    CREATE ROLE albert_anthropic_control
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
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
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
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
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
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
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

-- The operator diagnostic service can only consume one-use reveal grants and
-- record their outcomes. It has no direct table privileges in the control
-- plane and is deliberately independent from the semantic-query identity.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'albert_operator_diagnostic_control'
  ) THEN
    CREATE ROLE albert_operator_diagnostic_control
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END;
$$;

ALTER ROLE albert_control_migration_owner NOINHERIT;
ALTER ROLE albert_deletion_control NOINHERIT;
ALTER ROLE albert_sync_control NOINHERIT;
ALTER ROLE albert_webhook_control NOINHERIT;
ALTER ROLE albert_transform_control NOINHERIT;
ALTER ROLE albert_semantic_control NOINHERIT;
ALTER ROLE albert_anthropic_control NOINHERIT;
ALTER ROLE albert_operator_diagnostic_control NOINHERIT;

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
    'GRANT CONNECT ON DATABASE %I TO albert_anthropic_control',
    current_database()
  );
END;
$$;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO albert_operator_diagnostic_control',
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
-- Public RPCs are migration-owned SECURITY DEFINER functions. Modern
-- Supabase/PostgreSQL installations revoke CREATE on public from PUBLIC, so
-- the DDL-only owner needs this explicit schema capability before migration
-- 0002 can install the authenticated API boundary.
GRANT USAGE, CREATE ON SCHEMA public
  TO albert_control_migration_owner;
GRANT USAGE ON SCHEMA extensions TO albert_semantic_control;
GRANT REFERENCES ON TABLE auth.users TO albert_control_migration_owner;
-- Organisation membership RPCs resolve an already-registered, confirmed user
-- by email and return only the scoped member directory. The migration owner
-- receives column-level reads rather than broad Auth administration rights.
GRANT SELECT (id, email, email_confirmed_at) ON TABLE auth.users
  TO albert_control_migration_owner;
GRANT SELECT, INSERT, UPDATE ON TABLE storage.buckets
  TO albert_control_migration_owner;

-- Extensions are enabled by the Supabase administrator before this bootstrap.
-- The migration owner can inspect pgmq and invoke only the fixed queue
-- installer below. Runtime access is through SECURITY DEFINER wrappers.
REVOKE ALL ON SCHEMA pgmq, cron FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq, cron FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pgmq, cron FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq, cron FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA pgmq TO albert_control_migration_owner;
GRANT SELECT ON TABLE pgmq.meta TO albert_control_migration_owner;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO albert_control_migration_owner;

-- pgmq.create() is security-invoker and alters the pgmq extension while it
-- materialises queue tables, so a separate migration owner cannot call it on
-- managed Supabase. Keep that extension-owner capability behind this
-- administrator-owned, fixed-input installer rather than granting broad
-- extension ownership to Albert's deployment role.
CREATE OR REPLACE FUNCTION extensions.albert_install_foundation_queues()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  queue text;
BEGIN
  FOREACH queue IN ARRAY ARRAY[
    'albert_sync_high',
    'albert_sync_standard',
    'albert_sync_backfill',
    'albert_sync_deadletter'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pgmq.meta WHERE queue_name = queue) THEN
      PERFORM pgmq.create(queue);
    END IF;
    EXECUTE format(
      'GRANT ALL PRIVILEGES ON TABLE pgmq.%I, pgmq.%I TO albert_control_migration_owner',
      'q_' || queue,
      'a_' || queue
    );
    EXECUTE format(
      'GRANT ALL PRIVILEGES ON SEQUENCE pgmq.%I TO albert_control_migration_owner',
      'q_' || queue || '_msg_id_seq'
    );
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION extensions.albert_install_foundation_queues()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION extensions.albert_install_foundation_queues()
  TO albert_control_migration_owner;

CREATE OR REPLACE FUNCTION extensions.albert_install_deletion_queue()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pgmq.meta WHERE queue_name = 'albert_deletion'
  ) THEN
    PERFORM pgmq.create('albert_deletion');
  END IF;
  GRANT ALL PRIVILEGES ON TABLE
    pgmq.q_albert_deletion,
    pgmq.a_albert_deletion
  TO albert_control_migration_owner;
  GRANT ALL PRIVILEGES ON SEQUENCE pgmq.q_albert_deletion_msg_id_seq
  TO albert_control_migration_owner;
END;
$$;
REVOKE ALL ON FUNCTION extensions.albert_install_deletion_queue()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION extensions.albert_install_deletion_queue()
  TO albert_control_migration_owner;

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

-- Installed after the conversation lease migration exists. A fixed command
-- keeps crash recovery durable without granting the migration role arbitrary
-- pg_cron scheduling authority.
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
    'postgres',
    true
  );
END;
$$;
REVOKE ALL ON FUNCTION extensions.albert_install_conversation_reaper_cron_job()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION extensions.albert_install_conversation_reaper_cron_job()
  TO albert_control_migration_owner;

-- Installed after the generation-fenced stream lifecycle exists. Recovery is
-- reconstructed from immutable phase plans and never from process memory.
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
    'postgres',
    true
  );
END;
$$;
REVOKE ALL ON FUNCTION extensions.albert_install_sync_lifecycle_cron_job()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION extensions.albert_install_sync_lifecycle_cron_job()
  TO albert_control_migration_owner;

-- The managed administrator may SET ROLE during deployment. Runtime roles are
-- intentionally not granted this membership.
GRANT albert_control_migration_owner TO postgres;
GRANT albert_operator_diagnostic_control TO postgres;
