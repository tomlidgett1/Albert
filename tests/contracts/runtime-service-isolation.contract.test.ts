import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("sync and webhook control identities are NOLOGIN and explicitly assumed", async () => {
  const [bootstrap, migration, deputy, xero, postgres, sync, webhook] = await Promise.all([
    source("infra/bootstrap/control_plane_role.sql"),
    source("infra/migrations/control-plane/0007_runtime_service_isolation.sql"),
    source("infra/migrations/control-plane/0009_deputy_webhook_security.sql"),
    source("infra/migrations/control-plane/0010_xero_webhook_inbox.sql"),
    source("services/sync-workers/src/postgres.ts"),
    source("services/sync-workers/src/main.ts"),
    source("services/webhook-gateway/src/main.ts"),
  ]);

  assert.match(bootstrap, /CREATE ROLE albert_sync_control\s+NOLOGIN[\s\S]*?NOSUPERUSER/i);
  assert.match(bootstrap, /CREATE ROLE albert_webhook_control\s+NOLOGIN[\s\S]*?NOSUPERUSER/i);
  assert.match(postgres, /set local role/);
  assert.match(postgres, /await client\.query\("begin"\);[\s\S]*assumedRoleSql[\s\S]*await work/);
  assert.match(sync, /assumedRole:\s*"albert_sync_control"/);
  assert.match(sync, /assumedRole:\s*"ingest_rw"/);
  assert.match(webhook, /assumedRole:\s*"albert_webhook_control"/);

  assert.match(migration, /GRANT SELECT ON TABLE\s+control_plane\.connections,\s+control_plane\.oauth_token_refs\s+TO albert_webhook_control/i);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE control_plane\.webhook_receipts TO albert_webhook_control/i);
  assert.match(deputy, /REVOKE ALL ON TABLE control_plane\.oauth_token_refs FROM albert_webhook_control/i);
  assert.match(deputy, /GRANT EXECUTE ON FUNCTION control_plane\.assert_deputy_webhook_gateway_ready\(text\[\]\)\s+TO albert_webhook_control/i);
  assert.match(deputy, /GRANT EXECUTE ON FUNCTION control_plane\.enqueue_deputy_webhook_sync\(text, text, text, text, timestamptz\)\s+TO albert_webhook_control/i);
  assert.match(xero, /REVOKE EXECUTE ON FUNCTION control_plane\.enqueue_sync_job\(jsonb, text, text, integer\)\s+FROM PUBLIC, albert_webhook_control/i);
  assert.match(xero, /GRANT EXECUTE ON FUNCTION control_plane\.accept_xero_webhook_inbox\(/i);
  assert.match(xero, /GRANT EXECUTE ON FUNCTION control_plane\.enqueue_xero_webhook_incremental\(/i);
  assert.match(xero, /GRANT EXECUTE ON FUNCTION control_plane\.enqueue_xero_webhook_gap_sweeps\(/i);
  assert.doesNotMatch(xero, /GRANT[^;]+ON TABLE[^;]+TO albert_webhook_control/i);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA control_plane FROM service_role/i);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA control_plane FROM service_role/i);
  assert.match(migration, /REVOKE USAGE ON SCHEMA control_plane FROM service_role/i);
});

test("public webhook identity cannot read encrypted credentials or user analytics", async () => {
  const [migration, deputy, xero, handler] = await Promise.all([
    source("infra/migrations/control-plane/0007_runtime_service_isolation.sql"),
    source("infra/migrations/control-plane/0009_deputy_webhook_security.sql"),
    source("infra/migrations/control-plane/0010_xero_webhook_inbox.sql"),
    source("services/webhook-gateway/src/handler.ts"),
  ]);
  const finalWebhookBoundary = `${deputy}\n${xero}`;

  assert.doesNotMatch(finalWebhookBoundary, /GRANT[^;]*(oauth_token_refs|oauth_secret_envelopes|oauth_session_secret_envelopes)[^;]*albert_webhook_control/i);
  assert.match(finalWebhookBoundary, /REVOKE[^;]*oauth_token_refs[^;]*albert_webhook_control/i);
  assert.doesNotMatch(migration, /GRANT[^;]*(conversations|conversation_turns|model_usage_ledger|catalogue_documents)[^;]*TO albert_(?:sync|webhook)_control/i);
  assert.doesNotMatch(migration, /ALTER ROLE[^;]*BYPASSRLS|GRANT\s+BYPASSRLS/i);
  assert.match(deputy, /DROP POLICY IF EXISTS webhook_runtime_read ON control_plane\.oauth_token_refs/i);
  assert.match(handler, /const accepted = await this\.dependencies\.xero\.accept\([\s\S]*return result\(200/i);
  const xeroBranch = handler.slice(
    handler.indexOf('if (pathname === "/v1/webhooks/xero")'),
    handler.indexOf("const deputyMatch"),
  );
  assert.doesNotMatch(xeroBranch, /resolveXero|raw\.put|persistAndRoute|finalize/);
});

test("runtime login provisioning is not delegated to application migrations", async () => {
  const migration = await source("infra/migrations/control-plane/0007_runtime_service_isolation.sql");
  assert.doesNotMatch(migration, /CREATE ROLE|ALTER ROLE[^;]*LOGIN/i);
  assert.match(migration, /Run the control-plane role bootstrap before runtime isolation migrations/);
});

test("runtime login provisioner reconciles one NOINHERIT group per credential", async () => {
  const provisioner = await source("scripts/provision-runtime-logins.ts");
  assert.match(provisioner, /ALTER ROLE \$\{login\} WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(provisioner, /SELECT parent\.rolname AS role_name[\s\S]*pg_auth_members/);
  assert.match(provisioner, /REVOKE \$\{identifier\(membership\.role_name\)\} FROM \$\{login\}/);
  assert.match(provisioner, /GRANT \$\{group\} TO \$\{login\}/);
  assert.match(provisioner, /must require TLS for a remote database/);
  assert.match(provisioner, /must contain between 32 and 256 bytes/);
  assert.doesNotMatch(provisioner, /service_role/);

  const memberships = [...provisioner.matchAll(/group: "([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(memberships.sort(), [
    "albert_control_migration_owner",
    "albert_deletion_control",
    "albert_migration_owner",
    "albert_semantic_control",
    "albert_sync_control",
    "albert_transform_control",
    "albert_webhook_control",
    "deletion_rw",
    "ingest_rw",
    "semantic_meta_rw",
    "semantic_ro",
    "transform_rw",
  ].sort());
});
