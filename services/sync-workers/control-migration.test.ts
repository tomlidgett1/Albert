import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../infra/migrations/control-plane/0002_m1_public_runtime.sql",
  import.meta.url,
);
const operationsMigrationUrl = new URL(
  "../../infra/migrations/control-plane/0003_m2_ingestion_operations.sql",
  import.meta.url,
);
const bootstrapUrl = new URL(
  "../../infra/bootstrap/control_plane_role.sql",
  import.meta.url,
);

test("configuration mutation RPCs require owner or manager", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const functionName of [
    "public.albert_answer_blocking_question",
    "public.albert_decide_identity_match",
  ]) {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${functionName}`);
    assert.notEqual(start, -1, `${functionName} must exist`);
    const body = sql.slice(start, sql.indexOf("$$;", start));
    assert.match(body, /has_tenant_role\(selected_tenant, ARRAY\['owner', 'manager'\]::text\[\]\)/);
    assert.match(body, /ERRCODE = '42501'/);
  }
});

test("conversation history retains initial and incomplete turns without events", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.albert_conversation_history");
  assert.notEqual(start, -1);
  const body = sql.slice(start, sql.indexOf("$$;", start));
  assert.match(body, /p_after_sequence = 0/);
  assert.match(body, /turn\.status IN \('running', 'failed'\)/);
});

test("M2 installs durable periodic incremental, reconciliation, and expiry schedules", async () => {
  const sql = await readFile(operationsMigrationUrl, "utf8");
  const bootstrap = await readFile(bootstrapUrl, "utf8");
  assert.match(sql, /pg_catalog\.pg_extension WHERE extname = 'pg_cron'/);
  assert.match(sql, /extensions\.albert_install_foundation_cron_jobs\(\)/);
  assert.doesNotMatch(sql, /cron\.schedule\(/);
  assert.match(sql, /enqueue_due_incremental_syncs/);
  assert.match(sql, /WHEN 'lightspeed-r' THEN 900/);
  assert.match(sql, /WHEN 'xero' THEN 3600/);
  assert.match(sql, /enqueue_nightly_reconciliation_sweeps/);
  assert.match(sql, /p_now - interval '7 days'/);
  assert.match(bootstrap, /cron\.schedule_in_database/);
  assert.match(bootstrap, /'albert-incremental-sync-scheduler'/);
  assert.match(bootstrap, /'albert-nightly-reconciliation'/);
  assert.match(bootstrap, /'albert-oauth-session-expiry'/);
  assert.match(bootstrap, /current_database\(\),\s*'postgres',\s*true/g);
  assert.doesNotMatch(bootstrap, /GRANT (?:USAGE|EXECUTE).*cron TO albert_control_migration_owner/);
});

test("M2 queue terminal transitions are fenced to the current unexpired worker lease", async () => {
  const sql = await readFile(operationsMigrationUrl, "utf8");
  assert.match(sql, /require_active_sync_job_lease\(/);
  assert.match(sql, /attempt\.worker_id = p_worker_id/);
  assert.match(sql, /attempt\.attempt_number = p_read_count/);
  assert.match(sql, /attempt\.visibility_deadline > clock_timestamp\(\)/);
  assert.match(sql, /later\.attempt_number > attempt\.attempt_number/);
  assert.match(sql, /NEW\.visibility_deadline > OLD\.visibility_deadline/);
  assert.doesNotMatch(sql, /ON CONFLICT \(tenant_id, job_request_id, attempt_number\) DO NOTHING/);
});
