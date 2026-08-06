import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function migrationSql(): Promise<string> {
  // 0092 supersedes 0087's definer with the queue-contract-complete payload;
  // the structural assertions read the executable version.
  return readFile(
    new URL("infra/migrations/control-plane/0092_m2_manual_sync_coordinator_payload.sql", root),
    "utf8",
  );
}

async function routeSource(): Promise<string> {
  return readFile(new URL("app/api/connections/sync/route.ts", root), "utf8");
}

test("manual sync enqueues an InitialBackfill coordinator, never a stream-less IncrementalSync", async () => {
  const sql = await migrationSql();

  const enqueue = /control_plane\.enqueue_sync_job\(\s*jsonb_build_object\(([\s\S]*?)\)\s*,\s*'backfill'/u.exec(sql);
  assert.ok(enqueue, "the definer must enqueue through control_plane.enqueue_sync_job");
  const payload = enqueue[1];

  // worker.ts routes any job without a `stream` key to the coordinator fan-out,
  // and throws incremental_sync_requires_stream for a coordinator-shaped
  // IncrementalSync. A "sync everything" button must therefore take the
  // InitialBackfill coordinator shape.
  assert.match(payload, /'type',\s*'InitialBackfill'/u);
  assert.doesNotMatch(payload, /'stream'/u);
  assert.doesNotMatch(payload, /IncrementalSync/u);

  // The queue contract refuses an InitialBackfill without its window and plan
  // lifecycle — a missing range made the enqueued message a poison pill that
  // threw inside the worker's claim on every visibility window.
  assert.match(payload, /'range',\s*jsonb_build_object\(/u);
  assert.match(payload, /'phase',\s*'recent'/u);
  assert.match(payload, /'replayVersion',\s*1/u);
  assert.match(payload, /'planMode',\s*'progressive'/u);

  // A job must not outlive a disconnect/reconnect and write under a stale
  // credential: the generation is captured at enqueue time.
  assert.match(payload, /'connectionGeneration',\s*v_connection\.connection_generation/u);
});

test("manual sync requests are idempotent within a minute bucket", async () => {
  const sql = await migrationSql();
  assert.match(sql, /floor\(extract\(epoch FROM now\(\)\) \/ 60\)/u);
  assert.match(sql, /'manual:' \|\| v_connection\.connection_id \|\| ':' \|\| v_bucket::text/u);
  // An in-flight run is reported, not doubled.
  assert.match(sql, /run\.status IN \('queued', 'running', 'retry_wait'\)/u);
  assert.match(sql, /'sync_already_running'/u);
});

test("manual sync rate limit is seeded in the migration for the FK-referenced policy table", async () => {
  // The policy seed lives in 0087; 0092 only supersedes the definer body.
  const sql = await readFile(
    new URL("infra/migrations/control-plane/0087_m2_manual_sync_request.sql", root),
    "utf8",
  );
  assert.match(sql, /INSERT INTO control_plane\.rate_limit_policies/u);
  assert.match(sql, /\('connection\.manual_sync', 6, 3600, true\)/u);
  assert.match(sql, /ON CONFLICT \(action\) DO UPDATE/u);
});

test("manual sync declines with codes the boundary owns copy for, and audits acceptance", async () => {
  const sql = await migrationSql();
  const route = await routeSource();

  const declineCodes = [
    "no_active_organisation",
    "insufficient_role",
    "connection_not_found",
    "connection_not_connected",
    "account_not_selected",
    "sync_already_running",
  ];
  for (const code of declineCodes) {
    assert.match(sql, new RegExp(`'${code}'`, "u"), `definer must return ${code}`);
    assert.match(route, new RegExp(`${code}`, "u"), `route must map ${code} to user copy`);
  }
  // The database returns codes; the boundary owns the wording.
  assert.doesNotMatch(sql, /RETURN QUERY SELECT false, NULL::text, '[A-Z][^']* /u);

  assert.match(sql, /'connection\.manual_sync_requested'/u);
  assert.match(sql, /INSERT INTO control_plane\.audit_log/u);
});

test("manual sync stays a definer-only path with the enqueue grant unwidened", async () => {
  const sql = await migrationSql();
  assert.match(sql, /SECURITY DEFINER/u);
  assert.match(sql, /SET search_path = pg_catalog/u);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.albert_request_manual_sync\(text\) FROM PUBLIC/u);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.albert_request_manual_sync\(text\) FROM anon/u);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.albert_request_manual_sync\(text\) TO authenticated/u);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION control_plane\.enqueue_sync_job/u);
});

test("the sync route enforces same-origin, role, rate limit and bounded body before the RPC", async () => {
  const route = await routeSource();
  const rpcAt = route.indexOf("albert_request_manual_sync");
  assert.ok(rpcAt > 0, "route must call the definer RPC");
  for (const guard of [
    "assertSameOriginMutation(request)",
    'consumeAlbertRateLimit("connection.manual_sync")',
    "readBoundedJsonBody(request)",
    '["owner", "manager"].includes(tenant.role)',
  ]) {
    const guardAt = route.indexOf(guard);
    assert.ok(guardAt > -1 && guardAt < rpcAt, `${guard} must run before the RPC`);
  }
  // Tenant scope comes from the session inside the definer, never the body.
  assert.doesNotMatch(route, /tenantId|tenant_id/u);
});
