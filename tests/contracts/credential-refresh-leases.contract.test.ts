import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, root), "utf8");
}

test("refresh leases are durable, expiring, tenant/connection scoped and fenced", async () => {
  const migration = await source(
    "infra/migrations/control-plane/0008_durable_vendor_rate_budgets.sql",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS control_plane\.oauth_credential_refresh_leases/iu);
  assert.match(migration, /PRIMARY KEY \(tenant_id, credential_scope, scope_id\)/iu);
  assert.match(migration, /credential_scope = 'connection'[\s\S]*scope_id = connection_id/iu);
  assert.match(migration, /REFERENCES control_plane\.oauth_token_refs[\s\S]*ON DELETE CASCADE/iu);
  assert.match(migration, /lease\.lease_expires_at <= current_time/iu);
  assert.match(migration, /lease\.fencing_token \+ 1/iu);
  assert.match(migration, /CREATE OR REPLACE FUNCTION control_plane\.extend_credential_refresh_lease/iu);
  assert.match(migration, /CREATE OR REPLACE FUNCTION control_plane\.release_credential_refresh_lease/iu);
  assert.match(
    migration,
    /assert_credential_refresh_lease[\s\S]*lease_expires_at > clock_timestamp\(\)[\s\S]*FOR UPDATE/iu,
  );
});

test("deletion refresh leases remain fenced by the active deletion claim", async () => {
  const migration = await source(
    "infra/migrations/control-plane/0008_durable_vendor_rate_budgets.sql",
  );
  for (const functionName of [
    "acquire_deletion_credential_refresh_lease",
    "extend_deletion_credential_refresh_lease",
    "release_deletion_credential_refresh_lease",
    "rotate_deletion_credential_under_refresh_lease",
  ]) {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION control_plane.${functionName}`);
    assert.notEqual(start, -1, `${functionName} must exist`);
    const end = migration.indexOf("$$;", start);
    assert.match(
      migration.slice(start, end),
      /require_active_deletion_lease/iu,
      `${functionName} must prove the deletion job lease`,
    );
  }
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION control_plane\.acquire_credential_refresh_lease[\s\S]*albert_deletion_control/iu,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION control_plane\.acquire_deletion_credential_refresh_lease[\s\S]*TO albert_deletion_control/iu,
  );
});

test("all rotating-token connectors re-read after acquisition and publish with lease proof", async () => {
  const connectors = await Promise.all([
    source("connectors/lightspeed-r/index.ts"),
    source("connectors/xero/index.ts"),
    source("connectors/deputy/index.ts"),
  ]);
  for (const connector of connectors) {
    assert.match(connector, /vault\.withRefreshLease\(/u);
    assert.match(connector, /const latest = await this\.config\.vault\.read\(current\.credentialRef\)/u);
    assert.match(connector, /latest\.revision !== current\.revision/u);
    assert.match(connector, /compareAndSwap\([\s\S]*refreshLease/iu);
  }

  const [vault, sessionVault] = await Promise.all([
    source("services/sync-workers/src/credential-vault.ts"),
    source("services/sync-workers/src/oauth-session-store.ts"),
  ]);
  assert.match(vault, /assert_credential_refresh_lease/u);
  assert.match(sessionVault, /assert_credential_refresh_lease/u);
});
