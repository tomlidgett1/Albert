import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Client } from "pg";
import {
  applyControlPlaneAdminUpgrades,
  assertControlPlaneAdminIdentity,
  assertExactAdminUpgradePrefix,
  assertProtectedAdminDatabaseUrl,
} from "../../scripts/admin-bootstrap-upgrades.js";

const root = new URL("../../", import.meta.url);

class ExistingBootstrapDatabase {
  readonly statements: string[] = [];
  readonly applied: Array<{ upgrade_id: string; checksum_sha256: string }> = [];
  bodyExecutions = 0;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: Row[] }> {
    this.statements.push(sql);
    if (/SELECT current_user, session_user/u.test(sql)) {
      return {
        rows: [{ current_user: "postgres", session_user: "postgres" } as unknown as Row],
      };
    }
    if (/SELECT upgrade_id, checksum_sha256/u.test(sql)) {
      return { rows: this.applied.map((row) => ({ ...row } as unknown as Row)) };
    }
    if (/INSERT INTO albert_bootstrap\.applied_admin_upgrade/u.test(sql)) {
      this.applied.push({
        upgrade_id: String(values[1]),
        checksum_sha256: String(values[2]),
      });
    } else if (
      /CREATE OR REPLACE FUNCTION extensions\.albert_install_xero_inbox_retention/u.test(sql)
      || /CREATE OR REPLACE FUNCTION extensions\.albert_auth_uid/u.test(sql)
      || /CREATE OR REPLACE FUNCTION extensions\.albert_install_raw_payload_bucket/u.test(sql)
      || /CREATE OR REPLACE FUNCTION extensions\.albert_raw_storage_machine_authorized/u.test(sql)
      || /CREATE OR REPLACE FUNCTION extensions\.albert_install_tenant_deletion_receipt_auth_reference/u.test(sql)
      || /CREATE OR REPLACE FUNCTION extensions\.albert_install_user_rate_limit_retention_cron_job/u.test(sql)
      || /CREATE OR REPLACE FUNCTION extensions\.albert_raw_storage_sync_authorized/u.test(sql)
      || /CREATE OR REPLACE FUNCTION extensions\.albert_protected_dogfood_auth_audit_proof/u.test(sql)
      || /CREATE OR REPLACE FUNCTION extensions\.albert_finalize_vendor_attestation_boundary/u.test(sql)
      || /CREATE ROLE albert_anthropic_control/u.test(sql)
      || /CREATE OR REPLACE FUNCTION extensions\.albert_install_authorization_connector_providers/u.test(sql)
      || /CREATE OR REPLACE FUNCTION extensions\.albert_install_shopify_privacy_queue/u.test(sql)
    ) {
      this.bodyExecutions += 1;
    }
    return { rows: [] };
  }
}

test("administrator upgrade history accepts only an immutable exact prefix", () => {
  const local = [
    { id: "0001_first.sql", checksum: "a".repeat(64) },
    { id: "0002_second.sql", checksum: "b".repeat(64) },
  ] as const;
  assert.doesNotThrow(() => assertExactAdminUpgradePrefix(local, [
    { upgrade_id: "0001_first.sql", checksum_sha256: "a".repeat(64) },
  ]));
  assert.throws(() => assertExactAdminUpgradePrefix(local, [
    { upgrade_id: "0002_second.sql", checksum_sha256: "b".repeat(64) },
  ]), /exact release prefix/u);
  assert.throws(() => assertExactAdminUpgradePrefix(local, [
    { upgrade_id: "0001_first.sql", checksum_sha256: "f".repeat(64) },
  ]), /changed after it was applied/u);
});

test("an already-bootstrapped database upgrades without reading or changing its base checksum", async () => {
  const database = new ExistingBootstrapDatabase();
  const client = database as unknown as Client;
  await assertControlPlaneAdminIdentity(client);
  await applyControlPlaneAdminUpgrades(client);
  assert.equal(database.applied.length, 13);
  assert.deepEqual(database.applied.map((row) => row.upgrade_id), [
    "0001_xero_inbox_retention_cron.sql",
    "0002_supabase_auth_compatibility_boundary.sql",
    "0003_managed_postgres_cron_identity.sql",
    "0004_raw_payload_bucket_installer.sql",
    "0005_raw_storage_machine_authority.sql",
    "0006_tenant_deletion_receipt_auth_reference.sql",
    "0007_user_rate_limit_retention_cron.sql",
    "0008_lease_bound_raw_storage_deletion.sql",
    "0009_protected_dogfood_auth_audit_proof.sql",
    "0010_vendor_connection_attestor_authority.sql",
    "0011_anthropic_control_runtime_authority.sql",
    "0012_authorization_connector_provider_bridge.sql",
    "0013_shopify_privacy_queue.sql",
  ]);
  assert.ok(database.applied.every((row) => /^[0-9a-f]{64}$/u.test(row.checksum_sha256)));
  assert.equal(database.bodyExecutions, 13);
  assert.ok(database.statements.every((sql) => !/applied_bootstrap(?!_)/u.test(sql)));

  await applyControlPlaneAdminUpgrades(client);
  assert.equal(database.applied.length, 13);
  assert.equal(database.bodyExecutions, 13, "an applied immutable upgrade must not execute twice");
});

test("protected administrator URLs reject plaintext remote credentials before connection", () => {
  assert.doesNotThrow(() => assertProtectedAdminDatabaseUrl(
    "postgresql://postgres:secret@127.0.0.1:5432/postgres",
  ));
  assert.doesNotThrow(() => assertProtectedAdminDatabaseUrl(
    "postgresql://postgres:secret@db.example/postgres?sslmode=verify-full",
  ));
  assert.throws(() => assertProtectedAdminDatabaseUrl(
    "postgresql://postgres:secret@db.example/postgres",
  ), /must require TLS/u);
  assert.throws(() => assertProtectedAdminDatabaseUrl("https://db.example/postgres"), /PostgreSQL URL/u);
});

test("fresh bootstrap and later upgrades reject a non-postgres owner identity", async () => {
  const client = {
    query: async () => ({
      rows: [{ current_user: "supabase_admin", session_user: "supabase_admin" }],
    }),
  } as unknown as Client;
  await assert.rejects(
    assertControlPlaneAdminIdentity(client),
    /protected postgres control-plane login/u,
  );
});

test("fixed administrator installers are versioned and sequenced before migrations", async () => {
  const [base, upgrade, cronUpgrade, receiptUpgrade, limiterUpgrade, migration, runner] = await Promise.all([
    readFile(new URL("infra/bootstrap/control_plane_role.sql", root), "utf8"),
    readFile(new URL(
      "infra/bootstrap-upgrades/control-plane/0001_xero_inbox_retention_cron.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/bootstrap-upgrades/control-plane/0003_managed_postgres_cron_identity.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/bootstrap-upgrades/control-plane/0006_tenant_deletion_receipt_auth_reference.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/bootstrap-upgrades/control-plane/0007_user_rate_limit_retention_cron.sql",
      root,
    ), "utf8"),
    readFile(new URL(
      "infra/migrations/control-plane/0035_m8_xero_webhook_retention_hardening.sql",
      root,
    ), "utf8"),
    readFile(new URL("scripts/migrate.ts", root), "utf8"),
  ]);
  assert.doesNotMatch(base, /albert_install_xero_inbox_retention_cron_job/u);
  assert.match(upgrade, /SECURITY DEFINER[\s\S]*albert-xero-inbox-retention/u);
  assert.doesNotMatch(upgrade, /albert_operator_diagnostic_control/u);
  assert.match(cronUpgrade, /current_user <> 'postgres' OR session_user <> 'postgres'/u);
  assert.equal((cronUpgrade.match(/cron\.schedule_in_database\(/gu) ?? []).length, 7);
  assert.match(cronUpgrade, /current_database\(\),\s*NULL,\s*true/gu);
  assert.doesNotMatch(cronUpgrade, /current_database\(\),\s*'postgres'/u);
  assert.doesNotMatch(cronUpgrade, /albert_install_[a-z_]+\([^)]*[a-z_]+[^)]*\)/u);
  assert.match(receiptUpgrade,
    /migration_id = '0053_m8_user_bound_tenant_deletion_receipts\.sql'[\s\S]*PERFORM extensions\.albert_install_tenant_deletion_receipt_auth_reference\(\)/u,
    "An already-migrated cell must install and consume the managed Auth reference grant.");
  assert.match(limiterUpgrade,
    /albert-user-rate-limit-retention[\s\S]*purge_user_rate_limit_buckets\(\)[\s\S]*current_database\(\),\s*NULL,\s*true/u,
    "Pseudonymous rate-limit buckets require fixed bounded-retention scheduling.");
  assert.match(migration, /SELECT extensions\.albert_install_xero_inbox_retention_cron_job\(\)/u);
  const identity = runner.indexOf("await assertControlPlaneAdminIdentity(client)");
  const protectedUrl = runner.indexOf("assertProtectedAdminDatabaseUrl(databaseUrl)");
  const bootstrap = runner.indexOf("await applyBootstrap(client, target, bootstrap)");
  const upgrades = runner.indexOf("await applyControlPlaneAdminUpgrades(client)");
  const activateOwner = runner.indexOf("await client.query(`SET ROLE");
  assert.ok(protectedUrl >= 0 && protectedUrl < identity);
  assert.ok(identity >= 0 && identity < bootstrap && bootstrap < upgrades && upgrades < activateOwner);
});
