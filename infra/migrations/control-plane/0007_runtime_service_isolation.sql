BEGIN;

-- These NOLOGIN groups are created by infra/bootstrap/control_plane_role.sql.
-- Runtime LOGIN identities are NOINHERIT members and every database adapter
-- must SET LOCAL ROLE before issuing application SQL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'albert_sync_control')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'albert_webhook_control') THEN
    RAISE EXCEPTION 'Run the control-plane role bootstrap before runtime isolation migrations.'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

-- Earlier foundation migrations retained Supabase's conventional service_role
-- during construction. Albert's production composition has no service-role
-- caller, so final-state isolation removes that broad capability completely.
-- Browser-facing access remains through the public schema and authenticated
-- RLS functions; service processes receive only the grants below.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA control_plane FROM service_role;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA control_plane FROM service_role;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA control_plane FROM service_role;
REVOKE USAGE ON SCHEMA control_plane FROM service_role;

GRANT USAGE ON SCHEMA control_plane TO albert_sync_control, albert_webhook_control;

-- The sync/OAuth process can touch only the control records required to
-- exchange and rotate credentials, land batches, advance cursors, publish
-- readiness, and schedule transformation/deletion work. It has no access to
-- conversations, model usage, semantic catalogue rows, operator records, or
-- deletion proofs.
GRANT SELECT ON TABLE control_plane.memberships TO albert_sync_control;
GRANT SELECT, INSERT, UPDATE ON TABLE control_plane.connections TO albert_sync_control;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  control_plane.oauth_token_refs,
  control_plane.oauth_secret_envelopes,
  control_plane.oauth_session_secret_envelopes
TO albert_sync_control;
GRANT SELECT, INSERT, UPDATE ON TABLE
  control_plane.oauth_sessions,
  control_plane.sync_runs,
  control_plane.stream_cursors,
  control_plane.readiness,
  control_plane.raw_batch_landings,
  control_plane.deletion_requests
TO albert_sync_control;
GRANT SELECT, INSERT ON TABLE control_plane.raw_batch_manifests TO albert_sync_control;
GRANT INSERT ON TABLE
  control_plane.quarantine_items,
  control_plane.audit_log
TO albert_sync_control;

-- The public webhook edge can resolve active connection identities, create and
-- advance deduplicated receipts, and invoke the fixed sync enqueue wrapper. It
-- cannot read token references beyond existence, encrypted envelopes, OAuth
-- sessions, sync runs, raw manifests, or any analytical database.
GRANT SELECT ON TABLE
  control_plane.connections,
  control_plane.oauth_token_refs
TO albert_webhook_control;
GRANT SELECT, INSERT, UPDATE ON TABLE control_plane.webhook_receipts TO albert_webhook_control;

REVOKE ALL ON FUNCTION control_plane.assert_pgmq_ready() FROM albert_sync_control, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.enqueue_sync_job(jsonb, text, text, integer) FROM albert_sync_control, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.claim_sync_jobs(text, text, integer, integer) FROM albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.complete_sync_job(text, bigint, text, text, integer, jsonb) FROM albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.extend_sync_job_visibility(text, bigint, text, text, integer, integer) FROM albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.retry_or_fail_sync_job(text, bigint, text, text, integer, jsonb, integer, integer) FROM albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.heartbeat_worker(text, text, text, timestamptz, integer, jsonb) FROM albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.sync_queue_metrics() FROM albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.enqueue_canonical_transform_job(text, text, text, text[], boolean) FROM albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.enqueue_deletion_request(text) FROM albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.acquire_sync_write_permit(text, text, text, text, integer) FROM albert_sync_control;
REVOKE ALL ON FUNCTION control_plane.release_sync_write_permit(text, text, text) FROM albert_sync_control;

GRANT EXECUTE ON FUNCTION control_plane.assert_pgmq_ready()
  TO albert_sync_control, albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.enqueue_sync_job(jsonb, text, text, integer)
  TO albert_sync_control, albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.claim_sync_jobs(text, text, integer, integer)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.complete_sync_job(text, bigint, text, text, integer, jsonb)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.extend_sync_job_visibility(text, bigint, text, text, integer, integer)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.retry_or_fail_sync_job(text, bigint, text, text, integer, jsonb, integer, integer)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.heartbeat_worker(text, text, text, timestamptz, integer, jsonb)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.sync_queue_metrics()
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.enqueue_canonical_transform_job(text, text, text, text[], boolean)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.enqueue_deletion_request(text)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.acquire_sync_write_permit(text, text, text, text, integer)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.release_sync_write_permit(text, text, text)
  TO albert_sync_control;

-- Cross-tenant worker access is explicit in RLS and remains bounded by the
-- table privileges above. Neither role has BYPASSRLS.
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.connections;
CREATE POLICY sync_runtime_access ON control_plane.connections
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_read ON control_plane.memberships;
CREATE POLICY sync_runtime_read ON control_plane.memberships
  FOR SELECT TO albert_sync_control USING (true);
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.oauth_token_refs;
CREATE POLICY sync_runtime_access ON control_plane.oauth_token_refs
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.oauth_secret_envelopes;
CREATE POLICY sync_runtime_access ON control_plane.oauth_secret_envelopes
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.oauth_sessions;
CREATE POLICY sync_runtime_access ON control_plane.oauth_sessions
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.oauth_session_secret_envelopes;
CREATE POLICY sync_runtime_access ON control_plane.oauth_session_secret_envelopes
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.sync_runs;
CREATE POLICY sync_runtime_access ON control_plane.sync_runs
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.stream_cursors;
CREATE POLICY sync_runtime_access ON control_plane.stream_cursors
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.readiness;
CREATE POLICY sync_runtime_access ON control_plane.readiness
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.raw_batch_manifests;
CREATE POLICY sync_runtime_access ON control_plane.raw_batch_manifests
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.raw_batch_landings;
CREATE POLICY sync_runtime_access ON control_plane.raw_batch_landings
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.quarantine_items;
CREATE POLICY sync_runtime_access ON control_plane.quarantine_items
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_access ON control_plane.deletion_requests;
CREATE POLICY sync_runtime_access ON control_plane.deletion_requests
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sync_runtime_insert ON control_plane.audit_log;
CREATE POLICY sync_runtime_insert ON control_plane.audit_log
  FOR INSERT TO albert_sync_control WITH CHECK (true);

DROP POLICY IF EXISTS webhook_runtime_read ON control_plane.connections;
CREATE POLICY webhook_runtime_read ON control_plane.connections
  FOR SELECT TO albert_webhook_control USING (true);
DROP POLICY IF EXISTS webhook_runtime_read ON control_plane.oauth_token_refs;
CREATE POLICY webhook_runtime_read ON control_plane.oauth_token_refs
  FOR SELECT TO albert_webhook_control USING (true);
DROP POLICY IF EXISTS webhook_runtime_access ON control_plane.webhook_receipts;
CREATE POLICY webhook_runtime_access ON control_plane.webhook_receipts
  FOR ALL TO albert_webhook_control USING (true) WITH CHECK (true);

COMMIT;
