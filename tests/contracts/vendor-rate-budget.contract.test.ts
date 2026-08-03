import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../infra/migrations/control-plane/0008_durable_vendor_rate_budgets.sql",
  import.meta.url,
);

test("vendor request reservations are atomic, connection-scoped, and runtime-isolated", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /CREATE OR REPLACE FUNCTION control_plane\.reserve_vendor_api_request/iu);
  assert.match(migration, /FROM control_plane\.vendor_rate_budgets[\s\S]*FOR UPDATE/iu);
  assert.match(migration, /theoretical_arrival_at/iu);
  assert.match(migration, /blocked_until/iu);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION control_plane\.reserve_vendor_api_request[\s\S]*FROM PUBLIC, anon, authenticated, service_role, albert_webhook_control/iu,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION control_plane\.reserve_vendor_api_request[\s\S]*TO albert_sync_control/iu,
  );
});

test("capacity deferral retains the durable queue message without a dead-letter threshold", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const deferSection = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION control_plane.defer_sync_job"));
  assert.match(deferSection, /pgmq\.set_vt/iu);
  assert.match(deferSection, /status = 'retry_wait'/iu);
  assert.doesNotMatch(deferSection.split("REVOKE ALL ON FUNCTION", 1)[0] ?? "", /p_max_attempts|pgmq\.archive/iu);
});
