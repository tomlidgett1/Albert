import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

type Stream = "control-plane" | "analytical";

type Migration = Readonly<{
  id: string;
  checksum: string;
  body: string;
}>;

type Target = Readonly<{
  stream: Stream;
  directory: string;
  bootstrapFile: string;
  databaseUrlName: "CONTROL_PLANE_DATABASE_URL" | "ANALYTICAL_DATABASE_URL";
  roleName: "CONTROL_PLANE_MIGRATION_ROLE" | "ANALYTICAL_MIGRATION_ROLE";
  defaultRole: "albert_control_migration_owner" | "albert_migration_owner";
}>;

const targets: Readonly<Record<Stream, Target>> = Object.freeze({
  "control-plane": Object.freeze({
    stream: "control-plane",
    directory: "infra/migrations/control-plane",
    bootstrapFile: "infra/bootstrap/control_plane_role.sql",
    databaseUrlName: "CONTROL_PLANE_DATABASE_URL",
    roleName: "CONTROL_PLANE_MIGRATION_ROLE",
    defaultRole: "albert_control_migration_owner",
  }),
  analytical: Object.freeze({
    stream: "analytical",
    directory: "infra/migrations/analytical",
    bootstrapFile: "infra/bootstrap/analytical_roles.sql",
    databaseUrlName: "ANALYTICAL_DATABASE_URL",
    roleName: "ANALYTICAL_MIGRATION_ROLE",
    defaultRole: "albert_migration_owner",
  }),
});

const forbiddenMigrationRoles = new Set([
  "anon",
  "authenticated",
  "service_role",
  "albert_deletion_control",
  "albert_sync_control",
  "albert_semantic_control",
  "albert_webhook_control",
  "albert_transform_control",
  "ingest_rw",
  "transform_rw",
  "semantic_ro",
  "semantic_meta_rw",
  "diagnostic_ro",
  "deletion_rw",
]);

function validateArguments(argv: readonly string[]): void {
  const unknown = argv.filter(
    (argument) => argument !== "--bootstrap" && !argument.startsWith("--target="),
  );
  if (unknown.length) throw new Error(`Unknown migration option: ${unknown.join(", ")}`);
  if (argv.filter((argument) => argument.startsWith("--target=")).length > 1) {
    throw new Error("Specify --target at most once.");
  }
}

function selectedStreams(argv: readonly string[]): readonly Stream[] {
  const option = argv.find((argument) => argument.startsWith("--target="));
  const requested = option?.slice("--target=".length) ?? "all";
  if (requested === "all") return ["control-plane", "analytical"];
  if (requested === "control-plane" || requested === "analytical") return [requested];
  throw new Error("--target must be control-plane, analytical, or all.");
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`Invalid PostgreSQL role identifier: ${value}`);
  }
  return `"${value}"`;
}

async function loadMigrations(directory: string): Promise<readonly Migration[]> {
  const absolute = resolve(directory);
  const files = (await readdir(absolute))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error(`No migrations found in ${directory}.`);

  const versions = new Set<string>();
  const migrations: Migration[] = [];
  for (const id of files) {
    const version = id.slice(0, 4);
    if (versions.has(version)) {
      throw new Error(`Duplicate migration version ${version} in ${directory}.`);
    }
    versions.add(version);
    const sql = await readFile(resolve(absolute, id), "utf8");
    const transaction = /^\s*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/iu.exec(sql);
    if (!transaction) {
      throw new Error(`${id} must contain one explicit outer BEGIN/COMMIT transaction.`);
    }
    migrations.push(Object.freeze({
      id,
      body: transaction[1]!,
      checksum: createHash("sha256").update(sql).digest("hex"),
    }));
  }
  return Object.freeze(migrations);
}

async function applyTarget(
  target: Target,
  environment: NodeJS.ProcessEnv,
  bootstrap: boolean,
): Promise<void> {
  const databaseUrl = environment[target.databaseUrlName]?.trim();
  if (!databaseUrl) throw new Error(`${target.databaseUrlName} is required.`);
  const requestedRole = environment[target.roleName]?.trim() || target.defaultRole;
  const migrations = await loadMigrations(target.directory);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: `albert-migration-${target.stream}`,
    connectionTimeoutMillis: 10_000,
  });

  await client.connect();
  let lockHeld = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      `albert:migrations:${target.stream}`,
    ]);
    lockHeld = true;

    if (bootstrap) {
      const bootstrapSql = await readFile(resolve(target.bootstrapFile), "utf8");
      if (/^\s*\\/mu.test(bootstrapSql)) {
        throw new Error(`${target.bootstrapFile} contains unsupported psql meta-commands.`);
      }
      await client.query(bootstrapSql);
      process.stdout.write(`bootstrapped ${target.stream}\n`);
    }

    await client.query(`SET ROLE ${quoteIdentifier(requestedRole)}`);
    const identity = await client.query<{ current_user: string; session_user: string }>(
      "SELECT current_user, session_user",
    );
    const currentRole = identity.rows[0]?.current_user;
    if (!currentRole || forbiddenMigrationRoles.has(currentRole)) {
      throw new Error(`Refusing to run migrations as runtime role ${currentRole ?? "unknown"}.`);
    }
    if (currentRole !== requestedRole) {
      throw new Error(
        `Migration role activation failed: expected ${requestedRole}, received ${currentRole}.`,
      );
    }

    await client.query("CREATE SCHEMA IF NOT EXISTS albert_migrations");
    await client.query(`
      CREATE TABLE IF NOT EXISTS albert_migrations.applied_migration (
        stream text NOT NULL,
        migration_id text NOT NULL,
        checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now(),
        applied_by text NOT NULL,
        PRIMARY KEY (stream, migration_id)
      )
    `);

    const applied = await client.query<{ migration_id: string; checksum_sha256: string }>(
      `SELECT migration_id, checksum_sha256
       FROM albert_migrations.applied_migration
       WHERE stream = $1`,
      [target.stream],
    );
    const appliedById = new Map(
      applied.rows.map((row) => [row.migration_id, row.checksum_sha256]),
    );
    for (const migration of migrations) {
      const priorChecksum = appliedById.get(migration.id);
      if (priorChecksum) {
        if (priorChecksum !== migration.checksum) {
          throw new Error(`${target.stream}/${migration.id} changed after it was applied.`);
        }
        process.stdout.write(`unchanged ${target.stream}/${migration.id}\n`);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
        await client.query(migration.body);
        await client.query(
          `INSERT INTO albert_migrations.applied_migration (
             stream, migration_id, checksum_sha256, applied_by
           ) VALUES ($1, $2, $3, $4)`,
          [target.stream, migration.id, migration.checksum, currentRole],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      process.stdout.write(`applied ${target.stream}/${migration.id}\n`);
    }
  } finally {
    if (lockHeld) {
      await client.query("RESET ROLE").catch(() => undefined);
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        `albert:migrations:${target.stream}`,
      ]).catch(() => undefined);
    }
    await client.end();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  validateArguments(argv);
  const streams = selectedStreams(argv);
  if (streams.length === 2) {
    const controlUrl = process.env.CONTROL_PLANE_DATABASE_URL?.trim();
    const analyticalUrl = process.env.ANALYTICAL_DATABASE_URL?.trim();
    if (controlUrl && analyticalUrl && controlUrl === analyticalUrl) {
      throw new Error("Control-plane and analytical migrations require separate databases.");
    }
  }
  for (const stream of streams) {
    await applyTarget(targets[stream], process.env, argv.includes("--bootstrap"));
  }
}

await main();
