import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../infra/migrations/control-plane/0021_m1_concurrency_safe_tenant_bootstrap.sql",
  import.meta.url,
);

test("first-user tenant bootstrap serializes by authenticated user before rechecking", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const functionStart = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.bootstrap_albert_tenant",
  );
  const functionEnd = migration.indexOf("$$;", functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const body = migration.slice(functionStart, functionEnd);

  const actorCheck = body.indexOf("IF actor IS NULL");
  const lock = body.indexOf("pg_catalog.pg_advisory_xact_lock");
  const perUserKey = body.indexOf("'albert:tenant-bootstrap:' || actor::text");
  const membershipRecheck = body.indexOf("SELECT membership.tenant_id");
  const existingReturn = body.indexOf("IF existing_tenant IS NOT NULL");
  const tenantInsert = body.indexOf("INSERT INTO control_plane.tenants");

  assert.ok(actorCheck >= 0 && actorCheck < lock, "authentication must precede locking");
  assert.ok(lock >= 0 && lock <= perUserKey, "the transaction lock must use the actor key");
  assert.ok(
    perUserKey < membershipRecheck && membershipRecheck < existingReturn,
    "membership must be rechecked only after the per-user lock",
  );
  assert.ok(
    existingReturn < tenantInsert,
    "the idempotent existing-tenant return must precede every bootstrap insert",
  );
  assert.match(body, /pg_catalog\.hashtextextended\([^)]*actor::text, 0\)/u);
});

test("bootstrap remains a narrow authenticated RPC with rollback-scoped locking", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /^BEGIN;[\s\S]*COMMIT;\s*$/u);
  assert.doesNotMatch(migration, /pg_advisory_lock\(/u);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.bootstrap_albert_tenant\(text, text\) FROM PUBLIC, anon/u,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.bootstrap_albert_tenant\(text, text\) TO authenticated/u,
  );
  assert.doesNotMatch(migration, /GRANT EXECUTE[\s\S]*service_role/u);
});

test("control-plane SQL runs a deterministic two-session bootstrap race", async () => {
  const sql = await readFile(
    new URL("../sql/control-plane-rls.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /dblink_connect\([\s\S]*albert_bootstrap_winner/u);
  assert.match(sql, /dblink_connect\([\s\S]*albert_bootstrap_contender/u);
  assert.match(sql, /pg_advisory_xact_lock\([\s\S]*albert:tenant-bootstrap:/u);
  assert.match(sql, /dblink_send_query\([\s\S]*bootstrap_albert_tenant/u);
  assert.match(sql, /dblink_is_busy\('albert_bootstrap_contender'\)=1/u);
  assert.match(sql, /dblink_get_result\('albert_bootstrap_contender'\)/u);
  assert.match(sql, /count\(\*\)=1[\s\S]*role='owner'[\s\S]*action='tenant\.bootstrap'/u);
  assert.doesNotMatch(sql, /pg_sleep\(/u);
});
