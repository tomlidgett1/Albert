import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

type AdminUpgrade = Readonly<{
  id: string;
  checksum: string;
  body: string;
}>;

type AppliedAdminUpgrade = Readonly<{
  upgrade_id: string;
  checksum_sha256: string;
}>;

const CONTROL_PLANE_UPGRADE_DIRECTORY = "infra/bootstrap-upgrades/control-plane";
const CONTROL_PLANE_STREAM = "control-plane";
const ADMIN_LOCK = "albert:admin-bootstrap-upgrades:control-plane";

export function assertProtectedAdminDatabaseUrl(encoded: string): void {
  let parsed: URL;
  try {
    parsed = new URL(encoded);
  } catch {
    throw new Error("CONTROL_PLANE_ADMIN_DATABASE_URL must be a PostgreSQL URL.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("CONTROL_PLANE_ADMIN_DATABASE_URL must be a PostgreSQL URL.");
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" ||
    parsed.hostname === "::1" || parsed.hostname === "[::1]";
  const sslMode = parsed.searchParams.get("sslmode");
  if (!local && !["require", "verify-ca", "verify-full"].includes(sslMode ?? "")) {
    throw new Error(
      "Remote CONTROL_PLANE_ADMIN_DATABASE_URL must require TLS with sslmode=require or stronger.",
    );
  }
}

async function loadAdminUpgrades(directory: string): Promise<readonly AdminUpgrade[]> {
  const absolute = resolve(directory);
  const files = (await readdir(absolute))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error(`No administrator upgrades found in ${directory}.`);

  const versions = new Set<string>();
  const upgrades: AdminUpgrade[] = [];
  for (const id of files) {
    const version = id.slice(0, 4);
    if (versions.has(version)) {
      throw new Error(`Duplicate administrator upgrade version ${version} in ${directory}.`);
    }
    versions.add(version);
    const sql = await readFile(resolve(absolute, id), "utf8");
    const transaction = /^\s*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/iu.exec(sql);
    if (!transaction) {
      throw new Error(`${id} must contain one explicit outer BEGIN/COMMIT transaction.`);
    }
    upgrades.push(Object.freeze({
      id,
      body: transaction[1]!,
      checksum: createHash("sha256").update(sql).digest("hex"),
    }));
  }
  return Object.freeze(upgrades);
}

export function assertExactAdminUpgradePrefix(
  local: readonly Pick<AdminUpgrade, "id" | "checksum">[],
  applied: readonly AppliedAdminUpgrade[],
): void {
  if (applied.length > local.length) {
    throw new Error("Control-plane database contains administrator upgrades missing from this release.");
  }
  for (const [index, prior] of applied.entries()) {
    const expected = local[index];
    if (!expected || prior.upgrade_id !== expected.id) {
      throw new Error(
        `Control-plane administrator upgrade history is not an exact release prefix at position ${index + 1}.`,
      );
    }
    if (prior.checksum_sha256 !== expected.checksum) {
      throw new Error(`Administrator upgrade ${expected.id} changed after it was applied.`);
    }
  }
}

export async function assertControlPlaneAdminIdentity(client: Client): Promise<void> {
  const identity = await client.query<{ current_user: string; session_user: string }>(
    "SELECT current_user, session_user",
  );
  if (identity.rows[0]?.current_user !== "postgres" ||
      identity.rows[0]?.session_user !== "postgres") {
    throw new Error(
      "Administrator bootstrap upgrades require the protected postgres control-plane login.",
    );
  }
}

export async function applyControlPlaneAdminUpgrades(client: Client): Promise<void> {
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [ADMIN_LOCK]);
  try {
    const upgrades = await loadAdminUpgrades(CONTROL_PLANE_UPGRADE_DIRECTORY);
    await client.query("CREATE SCHEMA IF NOT EXISTS albert_bootstrap");
    await client.query(`
    CREATE TABLE IF NOT EXISTS albert_bootstrap.applied_admin_upgrade (
      stream text NOT NULL,
      upgrade_id text NOT NULL,
      checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      applied_by text NOT NULL,
      PRIMARY KEY (stream, upgrade_id),
      CHECK (stream = 'control-plane')
    )
    `);
    await client.query(
      "REVOKE ALL ON TABLE albert_bootstrap.applied_admin_upgrade FROM PUBLIC, anon, authenticated, service_role",
    );

    const applied = await client.query<AppliedAdminUpgrade>(
      `SELECT upgrade_id, checksum_sha256
       FROM albert_bootstrap.applied_admin_upgrade
      WHERE stream=$1
      ORDER BY upgrade_id`,
      [CONTROL_PLANE_STREAM],
    );
    assertExactAdminUpgradePrefix(upgrades, applied.rows);

    for (const upgrade of upgrades.slice(applied.rows.length)) {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
        await client.query(upgrade.body);
        await client.query(
          `INSERT INTO albert_bootstrap.applied_admin_upgrade (
           stream, upgrade_id, checksum_sha256, applied_by
         ) VALUES ($1,$2,$3,session_user)`,
          [CONTROL_PLANE_STREAM, upgrade.id, upgrade.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      process.stdout.write(`applied admin-bootstrap/${upgrade.id}\n`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [ADMIN_LOCK])
      .catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.CONTROL_PLANE_ADMIN_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("CONTROL_PLANE_ADMIN_DATABASE_URL is required.");
  assertProtectedAdminDatabaseUrl(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "albert-admin-bootstrap-upgrades-control-plane",
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await assertControlPlaneAdminIdentity(client);
    await applyControlPlaneAdminUpgrades(client);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
