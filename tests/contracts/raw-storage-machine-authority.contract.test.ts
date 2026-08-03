import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadRawStorageMachineProvisioningConfig } from "../../scripts/provision-raw-storage-machine-users.js";

function jwt(role: string): string {
  return `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
}

const valid: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  SUPABASE_AUTH_URL: "http://127.0.0.1:54321",
  SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY: jwt("service_role"),
  CONTROL_PLANE_ADMIN_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  SUPABASE_STORAGE_S3_ENDPOINT: "http://127.0.0.1:54321/storage/v1/s3",
  SUPABASE_STORAGE_S3_REGION: "local",
  SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "stub",
  SUPABASE_STORAGE_S3_LEGACY_ANON_KEY: jwt("anon"),
  ALBERT_RAW_STORAGE_CREDENTIAL_GENERATION: "2026080301",
  ALBERT_RAW_STORAGE_SYNC_PASSWORD: "sync-machine-password-material-00000001",
  ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD: "webhook-machine-password-material-000001",
  ALBERT_RAW_STORAGE_DELETION_PASSWORD: "deletion-machine-password-material-00001",
};

test("protected machine-user provisioner accepts only generation-fenced distinct credentials", () => {
  const config = loadRawStorageMachineProvisioningConfig(valid);
  assert.equal(config.generation, 2_026_080_301);
  assert.equal(config.authUrl, "http://127.0.0.1:54321");
  assert.equal(config.storage.sync.machinePurpose, "sync");
  assert.equal(new Set(Object.values(config.passwords)).size, 3);
  assert.throws(() => loadRawStorageMachineProvisioningConfig({
    ...valid,
    SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY: jwt("anon"),
  }), /service-role JWT/);
  assert.throws(() => loadRawStorageMachineProvisioningConfig({
    ...valid,
    ALBERT_RAW_STORAGE_CREDENTIAL_GENERATION: "0",
  }), /positive safe integer/);
  assert.throws(() => loadRawStorageMachineProvisioningConfig({
    ...valid,
    ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD: valid.ALBERT_RAW_STORAGE_SYNC_PASSWORD,
  }), /distinct password material/);
});

test("raw Storage provisioning uses Auth Admin only outside runtime and binds exact app metadata", async () => {
  const [provisioner, sessionProvider, runtimeContract, release] = await Promise.all([
    readFile(new URL("../../scripts/provision-raw-storage-machine-users.ts", import.meta.url), "utf8"),
    readFile(new URL("../../packages/storage/src/session-credentials.ts", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/runtime-contract.json", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"),
  ]);
  assert.match(provisioner, /auth\.admin/u);
  assert.match(provisioner, /pg_advisory_xact_lock/u);
  assert.match(provisioner, /credential_generation/u);
  assert.match(provisioner, /albert_raw_storage_purpose/u);
  assert.match(provisioner, /albert_machine_principal/u);
  assert.match(sessionProvider, /grant_type=\$\{grantType\}/u);
  assert.match(sessionProvider, /refresh_token/u);
  assert.match(sessionProvider, /sessionToken/u);

  const contract = JSON.parse(runtimeContract) as {
    globallyForbiddenRuntimeValues: string[];
    runtimes: Record<string, { requiredSecretNames?: string[] }>;
  };
  assert.ok(contract.globallyForbiddenRuntimeValues.includes(
    "SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY",
  ));
  assert.deepEqual(
    contract.runtimes["sync-worker"]?.requiredSecretNames?.filter((name) =>
      name.startsWith("ALBERT_RAW_STORAGE_")
    ),
    ["ALBERT_RAW_STORAGE_SYNC_PASSWORD"],
  );
  assert.deepEqual(
    contract.runtimes["webhook-gateway"]?.requiredSecretNames?.filter((name) =>
      name.startsWith("ALBERT_RAW_STORAGE_")
    ),
    ["ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD"],
  );
  assert.deepEqual(
    contract.runtimes["deletion-worker"]?.requiredSecretNames?.filter((name) =>
      name.startsWith("ALBERT_RAW_STORAGE_")
    ),
    ["ALBERT_RAW_STORAGE_DELETION_PASSWORD"],
  );
  assert.match(release, /stage-raw-storage-session-secrets/u);
  assert.match(release, /SUPABASE_STORAGE_S3_LEGACY_ANON_KEY/u);
  assert.match(release, /provision:raw-storage-machine-users/u);
  assert.match(release, /SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY/u);
});

test("customer raw authority is lease-bound and exercised by exact runtime logins", async () => {
  const [migration, administratorUpgrade, ci, syncRuntime, webhookRuntime,
    deletionRuntime, s3Proof] = await Promise.all([
    readFile(new URL(
      "../../infra/migrations/control-plane/0057_m2_m7_m8_lease_bound_raw_storage_sessions.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../../infra/bootstrap-upgrades/control-plane/0008_lease_bound_raw_storage_deletion.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../sql/control-plane-raw-storage-sync-runtime.sql", import.meta.url), "utf8"),
    readFile(new URL("../sql/control-plane-raw-storage-webhook-runtime.sql", import.meta.url), "utf8"),
    readFile(new URL("../sql/control-plane-raw-storage-deletion-runtime.sql", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/test-raw-storage-s3-session.ts", import.meta.url), "utf8"),
  ]);

  for (const purpose of ["sync", "webhook", "deletion"] as const) {
    assert.match(migration, new RegExp(
      `raw_storage_${purpose}_session_grants[\\s\\S]*FORCE ROW LEVEL SECURITY`,
      "u",
    ));
    assert.match(migration, new RegExp(
      `issue_raw_storage_${purpose}_session[\\s\\S]*require_exact_runtime_login`,
      "u",
    ));
    assert.match(migration, new RegExp(
      `revoke_raw_storage_${purpose}_session`,
      "u",
    ));
  }
  assert.match(administratorUpgrade,
    /raw_storage_webhook_session_grants[\s\S]*NOT EXISTS \([\s\S]*deletion_requests/u);
  assert.match(administratorUpgrade, /auth_session_id=\$2/u);
  assert.match(administratorUpgrade, /grant_row\.object_key=\$3/u);
  assert.match(administratorUpgrade, /grant_row\.operation='purge'/u);

  assert.match(syncRuntime, /SET LOCAL ROLE albert_sync_control/u);
  assert.match(syncRuntime, /claim_sync_jobs/u);
  assert.match(syncRuntime, /acquire_sync_write_permit/u);
  assert.match(syncRuntime, /issue_raw_storage_sync_session/u);
  assert.match(syncRuntime, /revoke_raw_storage_sync_session/u);
  assert.match(webhookRuntime, /SET LOCAL ROLE albert_webhook_control/u);
  assert.match(webhookRuntime, /issue_raw_storage_webhook_session/u);
  assert.match(webhookRuntime, /revoke_raw_storage_webhook_session/u);
  assert.match(deletionRuntime, /SET LOCAL ROLE albert_deletion_control/u);
  assert.match(deletionRuntime, /claim_deletion_jobs/u);
  assert.match(deletionRuntime, /issue_raw_storage_deletion_session/u);
  assert.match(deletionRuntime, /revoke_raw_storage_deletion_session/u);

  assert.ok(ci.indexOf("provision:runtime-logins -- --target=control-plane") <
    ci.indexOf("control-plane-raw-storage-sync-runtime.sql"));
  assert.match(ci, /-U albert_sync_control_runtime/u);
  assert.match(ci, /-U albert_webhook_control_runtime/u);
  assert.match(ci, /-U albert_deletion_control_runtime/u);
  assert.match(s3Proof, /every issuer must reap crashed expired grants/u);
  assert.match(s3Proof, /sessionPool: syncPool/u);
  assert.match(s3Proof, /sessionPool: webhookPool/u);
  assert.match(s3Proof, /sessionPool: deletionPool/u);
});
