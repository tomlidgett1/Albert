import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("sync and webhook control identities are NOLOGIN and explicitly assumed", async () => {
  const [bootstrap, migration, finalServiceRoleDeny, deputy, xero, attestation, postgres, sync, webhook] = await Promise.all([
    source("infra/bootstrap/control_plane_role.sql"),
    source("infra/migrations/control-plane/0007_runtime_service_isolation.sql"),
    source("infra/migrations/control-plane/0105_m0_service_role_final_deny.sql"),
    source("infra/migrations/control-plane/0009_deputy_webhook_security.sql"),
    source("infra/migrations/control-plane/0010_xero_webhook_inbox.sql"),
    source("infra/migrations/control-plane/0037_m7_verified_webhook_attestation_boundary.sql"),
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
  assert.match(attestation, /REVOKE ALL ON TABLE control_plane\.connections, control_plane\.webhook_receipts\s+FROM albert_webhook_control/i);
  assert.match(attestation, /REVOKE EXECUTE ON FUNCTION control_plane\.enqueue_deputy_webhook_sync\(/i);
  assert.match(attestation, /GRANT EXECUTE ON FUNCTION control_plane\.assert_webhook_attestation_ready\(text\),[\s\S]*TO albert_webhook_control/i);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA control_plane FROM service_role/i);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA control_plane FROM PUBLIC,\s*service_role/i);
  assert.match(migration, /REVOKE USAGE ON SCHEMA control_plane FROM service_role/i);
  assert.match(
    finalServiceRoleDeny,
    /REVOKE EXECUTE ON FUNCTION[\s\S]*enqueue_due_incremental_syncs\(timestamptz\)[\s\S]*renew_albert_turn_lease\(text,integer\)[\s\S]*is_known_connector\(text\)[\s\S]*FROM service_role/i,
  );
  assert.doesNotMatch(
    finalServiceRoleDeny,
    /ALL (?:TABLES|SEQUENCES|FUNCTIONS) IN SCHEMA control_plane/u,
  );
});

test("every post-isolation service_role grant is explicitly retired", async () => {
  const directory = new URL("infra/migrations/control-plane/", root);
  const files = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name) && name >= "0007_")
    .sort((left, right) => left.localeCompare(right));
  const grants: string[] = [];
  for (const file of files) {
    const sql = await readFile(new URL(file, directory), "utf8");
    for (const statement of sql.split(";")) {
      if (/^\s*GRANT\b/iu.test(statement) && /\bservice_role\b/iu.test(statement))
        grants.push(`${file}:${statement.replace(/\s+/gu, " ").trim()}`);
    }
  }
  assert.deepEqual(
    grants.map((grant) => grant.slice(0, 4)),
    ["0073", "0084", "0086"],
  );
  const finalDeny = await source(
    "infra/migrations/control-plane/0105_m0_service_role_final_deny.sql",
  );
  for (const routine of [
    "enqueue_due_incremental_syncs(timestamptz)",
    "renew_albert_turn_lease(text,integer)",
    "is_known_connector(text)",
  ])
    assert.match(finalDeny, new RegExp(routine.replace(/[()]/gu, "\\$&"), "u"));
});

test("public webhook identity cannot read encrypted credentials or user analytics", async () => {
  const [migration, deputy, xero, attestation, handler] = await Promise.all([
    source("infra/migrations/control-plane/0007_runtime_service_isolation.sql"),
    source("infra/migrations/control-plane/0009_deputy_webhook_security.sql"),
    source("infra/migrations/control-plane/0010_xero_webhook_inbox.sql"),
    source("infra/migrations/control-plane/0037_m7_verified_webhook_attestation_boundary.sql"),
    source("services/webhook-gateway/src/handler.ts"),
  ]);
  const finalWebhookBoundary = `${deputy}\n${xero}\n${attestation}`;

  assert.doesNotMatch(finalWebhookBoundary, /GRANT[^;]*(oauth_token_refs|oauth_secret_envelopes|oauth_session_secret_envelopes)[^;]*albert_webhook_control/i);
  assert.match(finalWebhookBoundary, /REVOKE[^;]*oauth_token_refs[^;]*albert_webhook_control/i);
  assert.doesNotMatch(migration, /GRANT[^;]*(conversations|conversation_turns|model_usage_ledger|catalogue_documents)[^;]*TO albert_(?:sync|webhook)_control/i);
  assert.doesNotMatch(migration, /ALTER ROLE[^;]*BYPASSRLS|GRANT\s+BYPASSRLS/i);
  assert.match(deputy, /DROP POLICY IF EXISTS webhook_runtime_read ON control_plane\.oauth_token_refs/i);
  assert.match(attestation, /webhook_attestation_nonces[\s\S]*PRIMARY KEY \(key_id, nonce\)/i);
  assert.doesNotMatch(attestation, /GRANT[^;]+webhook_attestation_keys[^;]+albert_webhook_control/i);
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

test("connection lifecycle authority is removed from generic table grants", async () => {
  const [lifecycle, connectionBoundary] = await Promise.all([
    source("infra/migrations/control-plane/0034_m8_connection_lifecycle_authority.sql"),
    source("infra/migrations/control-plane/0040_m0_m8_narrow_connection_mutation_capabilities.sql"),
  ]);

  assert.match(
    lifecycle,
    /REVOKE SELECT,INSERT,UPDATE,DELETE ON TABLE control_plane\.deletion_requests\s+FROM albert_sync_control/iu,
  );
  assert.match(
    lifecycle,
    /REVOKE EXECUTE ON FUNCTION control_plane\.enqueue_deletion_request\(text\)\s+FROM albert_sync_control/iu,
  );
  assert.match(
    lifecycle,
    /DROP POLICY IF EXISTS tenant_connection_admins_insert[\s\S]*DROP POLICY IF EXISTS tenant_connection_admins_update[\s\S]*DROP POLICY IF EXISTS tenant_connection_admins_delete/iu,
  );
  assert.match(
    lifecycle,
    /REVOKE INSERT,UPDATE,DELETE ON TABLE control_plane\.connections FROM authenticated/iu,
  );
  assert.match(
    lifecycle,
    /GRANT EXECUTE ON FUNCTION public\.albert_disconnect_connection\(text\)\s+TO authenticated/iu,
  );
  assert.doesNotMatch(
    lifecycle,
    /CREATE POLICY sync_runtime_(?:access|read) ON control_plane\.deletion_requests/iu,
  );
  assert.match(
    connectionBoundary,
    /REVOKE INSERT,UPDATE,DELETE ON TABLE control_plane\.connections\s+FROM albert_sync_control/iu,
  );
  assert.match(
    connectionBoundary,
    /REVOKE EXECUTE ON FUNCTION control_plane\.cancel_reconnectable_connection_deletion\([\s\S]*FROM albert_sync_control/iu,
  );
  assert.match(
    connectionBoundary,
    /GRANT EXECUTE ON FUNCTION control_plane\.finalize_oauth_connection_identity\([\s\S]*TO albert_sync_control/iu,
  );
  assert.match(
    connectionBoundary,
    /GRANT EXECUTE ON FUNCTION control_plane\.record_connection_auth_health\([\s\S]*TO albert_sync_control/iu,
  );
});

test("runtime login provisioner reconciles one NOINHERIT group per credential", async () => {
  const provisioner = await source("scripts/provision-runtime-logins.ts");
  assert.match(provisioner, /CREATE ROLE \$\{login\} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.match(provisioner, /ALTER ROLE \$\{login\} WITH LOGIN NOINHERIT CONNECTION LIMIT \$\{spec\.connectionLimit\} PASSWORD/);
  assert.doesNotMatch(provisioner, /ALTER ROLE \$\{login\}[^`\n]*\bNOSUPERUSER\b/u);
  assert.match(provisioner, /protected postgres will not rewrite a privileged role/);
  assert.match(provisioner, /did not converge to its safe role attributes/);
  assert.match(provisioner, /SELECT parent\.rolname AS role_name[\s\S]*pg_auth_members/);
  assert.match(provisioner, /REVOKE \$\{identifier\(membership\.role_name\)\} FROM \$\{login\}/);
  assert.match(provisioner, /GRANT \$\{group\} TO \$\{login\}/);
  assert.match(provisioner, /Required group \$\{group\} must not inherit or hold membership in another role/);
  assert.match(provisioner, /group === "albert_migration_owner"[\s\S]*new Set\(\["fivetran_user"\]\)/u);
  assert.match(provisioner, /parent\.admin_option \|\| !allowedParents\.has\(parent\.role_name\)/u);
  assert.match(provisioner, /does not have exactly one non-admin group membership/);
  assert.match(provisioner, /rolcanlogin,rolinherit,rolsuper/);
  assert.match(provisioner, /membership\.admin_option/);
  assert.match(provisioner, /must require TLS for a remote database/);
  assert.match(provisioner, /must contain between 32 and 256 bytes/);
  assert.doesNotMatch(provisioner, /service_role/);

  const memberships = [...provisioner.matchAll(/group: "([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(memberships.sort(), [
    "albert_anthropic_control",
    "albert_control_migration_owner",
    "albert_deletion_control",
    "albert_migration_owner",
    "albert_operator_diagnostic_control",
    "albert_semantic_control",
    "albert_sync_control",
    "albert_transform_control",
    "albert_webhook_control",
    "diagnostic_ro",
    "deletion_rw",
    "ingest_rw",
    "semantic_meta_rw",
    "semantic_ro",
    "transform_rw",
  ].sort());
});

test("the final control-plane deny covers current and future private functions", async () => {
  const migration = await source(
    "infra/migrations/control-plane/0172_m0_final_private_control_default_deny.sql",
  );
  assert.match(migration, /REVOKE USAGE ON SCHEMA control_plane FROM service_role/u);
  assert.doesNotMatch(migration, /REVOKE USAGE ON SCHEMA control_plane FROM [^;]*authenticated/u);
  assert.match(
    migration,
    /procedure\.proowner = \(SELECT oid FROM pg_catalog\.pg_roles WHERE rolname = current_user\)[\s\S]*REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role/u,
  );
  assert.match(
    migration,
    /ALTER DEFAULT PRIVILEGES FOR ROLE albert_control_migration_owner[\s\S]*REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/u,
  );
  assert.match(migration, /NOTIFY pgrst, 'reload schema'/u);
});

test("the final analytical deny covers Fivetran and capability implementations", async () => {
  const migration = await source(
    "infra/migrations/analytical/0179_m0_final_private_function_default_deny.sql",
  );
  assert.match(
    migration,
    /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA[\s\S]*ingestion,quality,semantic_internal,deletion_internal,capability_internal[\s\S]*FROM PUBLIC/u,
  );
  assert.equal(
    (migration.match(/ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner/gu) ?? []).length,
    5,
  );
});
