import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import {
  controlPlaneMigrationBody,
  reviewedControlPlaneAuthMigrations,
} from "../../scripts/control-plane-auth-compat.js";

const root = new URL("../../", import.meta.url);
const migrationDirectory = new URL("infra/migrations/control-plane/", root);
const directAuthDependency = /\bauth\.(?:users\b|uid\s*\(|jwt\s*\()/iu;
const directStorageBucketMutation = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+storage\.buckets\b/iu;

async function migration(id: string) {
  const sql = await readFile(new URL(id, migrationDirectory), "utf8");
  // A comment prologue before BEGIN; is legal: scripts/migrate.ts strips it
  // before asserting the single explicit transaction, and this must match.
  const transaction = /^(?:\s*--[^\n]*\n)*\s*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/iu.exec(sql);
  assert.ok(transaction, `${id} must remain a single explicit transaction`);
  return Object.freeze({
    id,
    checksum: createHash("sha256").update(sql).digest("hex"),
    body: transaction[1]!,
  });
}

test("every immutable direct Auth dependency has an exact compatibility review", async () => {
  const files = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  const reviewed = [...reviewedControlPlaneAuthMigrations()].sort();
  const discovered: string[] = [];
  for (const id of files) {
    const candidate = await migration(id);
    if (directAuthDependency.test(candidate.body)) discovered.push(id);
    const executable = controlPlaneMigrationBody(candidate);
    assert.doesNotMatch(executable, directAuthDependency);
    assert.doesNotMatch(executable, directStorageBucketMutation);
  }
  assert.deepEqual(discovered, reviewed);
  assert.equal(reviewed.length, 21);
});

test("compatibility conversion rejects unknown, changed, and count-drifted migrations", async () => {
  assert.throws(() => controlPlaneMigrationBody({
    id: "0043_unreviewed_auth.sql",
    checksum: "a".repeat(64),
    body: "CREATE TABLE control_plane.bad(user_id uuid REFERENCES auth.users(id));",
  }), /unreviewed direct Supabase Auth dependency/u);
  assert.throws(() => controlPlaneMigrationBody({
    id: "0043_unreviewed_storage.sql",
    checksum: "b".repeat(64),
    body: "DELETE FROM storage.buckets WHERE id='raw-payloads';",
  }), /unreviewed direct Supabase Storage bucket mutation/u);

  const foundation = await migration("0001_m1_control_plane_foundation.sql");
  assert.throws(() => controlPlaneMigrationBody({
    ...foundation,
    checksum: "f".repeat(64),
  }), /changed after its Auth compatibility review/u);
  assert.throws(() => controlPlaneMigrationBody({
    ...foundation,
    body: `${foundation.body}\nSELECT auth.uid();`,
  }), /reviewed auth\.uid\(\) count/u);
});

test("administrator managed-service bridges are fixed, private, and consumed by migrations", async () => {
  const [upgrade, storageUpgrade, storageAuthority, receiptReference, receiptMigration, boundary, authorityBoundary, runner, provisioner, roleDelegation, ci] = await Promise.all([
    readFile(new URL(
      "infra/bootstrap-upgrades/control-plane/0002_supabase_auth_compatibility_boundary.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/bootstrap-upgrades/control-plane/0004_raw_payload_bucket_installer.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/bootstrap-upgrades/control-plane/0005_raw_storage_machine_authority.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/bootstrap-upgrades/control-plane/0006_tenant_deletion_receipt_auth_reference.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/migrations/control-plane/0053_m8_user_bound_tenant_deletion_receipts.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/migrations/control-plane/0042_m0_m1_supabase_auth_compatibility_boundary.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/migrations/control-plane/0049_m2_raw_storage_machine_authority.sql",
      root,
    ), "utf8"),
    readFile(new URL("scripts/migrate.ts", root), "utf8"),
    readFile(new URL("scripts/provision-runtime-logins.ts", root), "utf8"),
    readFile(new URL("tests/sql/control-plane-test-role-delegation.sql", root), "utf8"),
    readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
  ]);

  assert.match(upgrade, /current_user <> 'postgres' OR session_user <> 'postgres'/u);
  assert.match(upgrade, /CREATE OR REPLACE FUNCTION extensions\.albert_auth_uid\(\)/u);
  assert.match(upgrade, /CREATE OR REPLACE FUNCTION extensions\.albert_auth_jwt\(\)/u);
  assert.match(upgrade, /albert_auth_users_by_ids\(p_user_ids uuid\[\]\)/u);
  assert.match(upgrade, /albert_auth_confirmed_user_by_email[\s\S]*email_confirmed_at IS NOT NULL/u);
  assert.match(upgrade, /albert_install_auth_user_foreign_keys\(\)[\s\S]*SECURITY DEFINER/u);
  assert.equal((upgrade.match(/\('control_plane','/gu) ?? []).length, 28);
  assert.match(upgrade, /REVOKE SELECT \(id, email, email_confirmed_at\)[\s\S]*FROM albert_control_migration_owner/u);
  assert.match(upgrade, /REVOKE EXECUTE ON FUNCTION extensions\.albert_install_auth_user_foreign_keys\(\)[\s\S]*FROM albert_control_migration_owner/u);
  assert.doesNotMatch(upgrade, /GRANT\s+(?:authenticated|service_role)\s+TO\s+albert_control_migration_owner/iu);
  assert.doesNotMatch(upgrade, /albert_install_auth_user_foreign_keys\([^)]*[a-z_]+[^)]*\)/u);

  assert.match(storageUpgrade, /rolbypassrls/u);
  assert.match(storageUpgrade, /albert_install_raw_payload_bucket\(\)[\s\S]*SECURITY DEFINER/u);
  assert.match(storageUpgrade, /'raw-payloads'[\s\S]*52428800[\s\S]*application\/gzip/u);
  assert.match(storageUpgrade, /REVOKE EXECUTE ON FUNCTION extensions\.albert_install_raw_payload_bucket\(\)/u);
  assert.doesNotMatch(storageUpgrade, /albert_install_raw_payload_bucket\([^)]*[a-z_]+[^)]*\)/u);

  assert.match(storageAuthority, /raw_storage_machine_principal[\s\S]*REFERENCES auth\.users\(id\)/u);
  assert.equal((storageAuthority.match(/CREATE POLICY albert_raw_/gu) ?? []).length, 6);
  assert.match(storageAuthority, /albert_raw_sync_insert[\s\S]*FOR INSERT/u);
  assert.match(storageAuthority, /albert_raw_sync_select[\s\S]*FOR SELECT/u);
  assert.match(storageAuthority, /albert_raw_webhook_insert[\s\S]*FOR INSERT/u);
  assert.match(storageAuthority, /albert_raw_webhook_select[\s\S]*FOR SELECT/u);
  assert.match(storageAuthority, /albert_raw_deletion_select[\s\S]*FOR SELECT/u);
  assert.match(storageAuthority, /albert_raw_deletion_delete[\s\S]*FOR DELETE/u);
  assert.doesNotMatch(storageAuthority, /CREATE POLICY albert_raw_[^\n]+[\s\S]{0,100}FOR UPDATE/u);
  assert.match(storageAuthority, /REVOKE ALL ON TABLE albert_bootstrap\.raw_storage_machine_principal/u);

  assert.match(receiptReference, /current_user <> 'postgres' OR session_user <> 'postgres'/u);
  assert.match(receiptReference, /tenant_deletion_receipts_requested_by_fkey/u);
  assert.match(receiptReference, /REFERENCES auth\.users\(id\)[\s\S]*ON DELETE CASCADE/u);
  assert.match(receiptReference, /REVOKE EXECUTE ON FUNCTION[\s\S]*FROM albert_control_migration_owner/u);
  assert.doesNotMatch(receiptReference, /albert_install_tenant_deletion_receipt_auth_reference\([^)]*[a-z_]+[^)]*\)/u);
  assert.match(receiptMigration, /SELECT extensions\.albert_install_tenant_deletion_receipt_auth_reference\(\)/u);

  assert.match(boundary, /SELECT extensions\.albert_install_raw_payload_bucket\(\)/u);
  assert.match(boundary, /SELECT extensions\.albert_install_auth_user_foreign_keys\(\)/u);
  assert.match(boundary, /auth_reference_count <> 28/u);
  assert.match(boundary, /migration owner must not inherit another database role/u);
  assert.doesNotMatch(boundary, directAuthDependency);
  assert.match(authorityBoundary, /SELECT extensions\.albert_verify_raw_storage_machine_authority\(\)/u);
  assert.match(authorityBoundary, /service_role must not enter the raw Storage policy boundary/u);
  assert.match(runner, /controlPlaneMigrationBody\(migration\)/u);
  assert.match(runner, /managed-service compatibility helpers are missing/u);
  const roleActivation = runner.indexOf("await client.query(`SET ROLE");
  const bridgePreflight = runner.indexOf("const authBridge");
  assert.ok(
    roleActivation >= 0 && bridgePreflight > roleActivation,
    "the least-privilege deployer must activate the migration owner before resolving private helpers",
  );
  assert.match(provisioner, /Required group \$\{group\} must not inherit or hold membership in another role/u);

  assert.match(roleDelegation, /DISPOSABLE TEST DATABASES ONLY/u);
  assert.match(roleDelegation, /current_setting\('albert\.test_role_delegation', true\) IS DISTINCT FROM 'on'/u);
  assert.match(roleDelegation, /current_user<>'postgres' OR session_user<>'postgres'/u);
  assert.match(roleDelegation, /WITH ADMIN FALSE, INHERIT FALSE, SET TRUE/u);
  assert.equal((roleDelegation.match(/'albert_(?:deletion|sync|webhook|transform|semantic)_control'/gu) ?? []).length, 5);
  assert.doesNotMatch(roleDelegation, /EXECUTE\s+FORMAT|\bformat\s*\(/iu);
  assert.match(ci, /control-plane-test-role-delegation\.sql[\s\S]*PGOPTIONS: -c albert\.test_role_delegation=on/u);
});
