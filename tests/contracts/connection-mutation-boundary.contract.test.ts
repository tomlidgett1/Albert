import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("sync has no generic connection mutation path", async () => {
  const [migration, entries] = await Promise.all([
    source("infra/migrations/control-plane/0040_m0_m8_narrow_connection_mutation_capabilities.sql"),
    readdir(new URL("services/sync-workers/src/", root), { withFileTypes: true }),
  ]);
  const syncSources = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => source(`services/sync-workers/src/${entry.name}`)),
  );

  assert.doesNotMatch(
    syncSources.join("\n"),
    /(?:insert\s+into|update|delete\s+from)\s+control_plane\.connections\b/iu,
  );
  assert.match(
    migration,
    /REVOKE INSERT,UPDATE,DELETE ON TABLE control_plane\.connections\s+FROM albert_sync_control/iu,
  );
  assert.match(
    migration,
    /DROP POLICY IF EXISTS sync_runtime_access ON control_plane\.connections[\s\S]*CREATE POLICY sync_runtime_read ON control_plane\.connections\s+FOR SELECT TO albert_sync_control/iu,
  );
  assert.match(
    migration,
    /REVOKE EXECUTE ON FUNCTION control_plane\.cancel_reconnectable_connection_deletion\([\s\S]*FROM albert_sync_control/iu,
  );
});

test("OAuth connection finalization is exact, replay-bound, and cannot retarget lifecycle state", async () => {
  const [migration, store] = await Promise.all([
    source("infra/migrations/control-plane/0040_m0_m8_narrow_connection_mutation_capabilities.sql"),
    source("services/sync-workers/src/oauth-session-store.ts"),
  ]);
  const functionStart = migration.indexOf(
    "CREATE OR REPLACE FUNCTION control_plane.finalize_oauth_connection_identity",
  );
  const functionEnd = migration.indexOf(
    "CREATE OR REPLACE FUNCTION control_plane.record_connection_auth_health",
    functionStart,
  );
  const finalizer = migration.slice(functionStart, functionEnd);

  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  assert.match(finalizer, /SECURITY DEFINER/iu);
  assert.match(finalizer, /oauth_sessions AS session[\s\S]*FOR UPDATE/iu);
  assert.match(finalizer, /session_row\.initiated_by IS DISTINCT FROM p_initiated_by/iu);
  assert.match(finalizer, /session_row\.provider IS DISTINCT FROM p_provider/iu);
  assert.match(finalizer, /session_row\.selected_account_reference IS DISTINCT FROM p_external_account_reference/iu);
  assert.match(finalizer, /membership\.role IN \('owner','manager'\)/iu);
  assert.match(finalizer, /secret_kind='pkce_verifier'[\s\S]*secret_kind='exchanged_credential'/iu);
  assert.match(finalizer, /discovered_account_choices[\s\S]*externalAccountId/iu);
  assert.match(finalizer, /connection_finalization_request_hash IS NOT NULL[\s\S]*request_hash[\s\S]*replayed:=true/iu);
  assert.match(finalizer, /proposed connection id is already bound to another identity/iu);
  assert.match(finalizer, /connection_row\.status='disconnected'[\s\S]*cancelled_request_id IS NULL/iu);
  assert.match(finalizer, /connection_row\.status NOT IN \('connected','degraded'\)/iu);
  assert.match(finalizer, /SET display_name=[\s\S]*status='connected'[\s\S]*auth_health='healthy'[\s\S]*connection_generation=connection\.connection_generation\+1/iu);
  assert.match(store, /control_plane\.finalize_oauth_connection_identity\(/u);
  assert.doesNotMatch(store, /(?:insert into|update|delete from) control_plane\.connections/iu);
});

test("auth-health mutation is queue-lease and generation fenced", async () => {
  const [migration, store, worker] = await Promise.all([
    source("infra/migrations/control-plane/0040_m0_m8_narrow_connection_mutation_capabilities.sql"),
    source("services/sync-workers/src/control-plane-store.ts"),
    source("services/sync-workers/src/worker.ts"),
  ]);
  const functionStart = migration.indexOf(
    "CREATE OR REPLACE FUNCTION control_plane.record_connection_auth_health",
  );
  const functionEnd = migration.indexOf(
    "-- Supersede migration 0007",
    functionStart,
  );
  const health = migration.slice(functionStart, functionEnd);

  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  assert.match(health, /control_plane\.require_active_sync_job_lease\(/u);
  for (const field of [
    "tenantId",
    "connectionId",
    "connectionGeneration",
    "connectorId",
    "externalAccountReference",
    "syncRunId",
  ]) {
    assert.match(health, new RegExp(`request_payload->>'${field}'`, "u"));
  }
  assert.match(health, /connection\.connection_generation=p_connection_generation/iu);
  assert.match(health, /connection\.status IN \('connected','degraded'\)/iu);
  assert.doesNotMatch(health, /SET[\s\S]{0,120}(?:status|connection_generation|connector_key|external_account_reference)=/iu);
  assert.match(store, /control_plane\.record_connection_auth_health\(/u);
  assert.doesNotMatch(store, /update control_plane\.connections/iu);
  assert.match(worker, /recordConnectionAuthHealth\(claim,/u);
});

test("sync page commits fence connection generation without table UPDATE privilege", async () => {
  const [migration, store] = await Promise.all([
    source("infra/migrations/control-plane/0072_m2_sync_connection_generation_fence.sql"),
    source("services/sync-workers/src/control-plane-store.ts"),
  ]);
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION control_plane\.assert_sync_connection_generation_fence/u,
  );
  assert.match(migration, /SECURITY DEFINER/u);
  assert.match(migration, /FOR SHARE/u);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO albert_sync_control/u);
  assert.match(store, /assert_sync_connection_generation_fence\(/u);
  assert.doesNotMatch(
    store,
    /from control_plane\.connections[\s\S]{0,200}for (?:update|share)/iu,
  );
});
