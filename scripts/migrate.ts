import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  applyControlPlaneAdminUpgrades,
  assertControlPlaneAdminIdentity,
  assertProtectedAdminDatabaseUrl,
} from "./admin-bootstrap-upgrades.js";
import { controlPlaneMigrationBody } from "./control-plane-auth-compat.js";

type Stream = "control-plane" | "analytical";

type Migration = Readonly<{
  id: string;
  checksum: string;
  body: string;
}>;

type AppliedMigration = Readonly<{
  migration_id: string;
  checksum_sha256: string;
}>;

const FRESH_ANALYTICAL_DATA_MIGRATIONS = new Map([
  [
    "0129_m5_retire_renamed_predecessor_pack_surface.sql",
    "e7a2633e5e9df29982dd4ac2031a4f6774a60def7aad6a7a17ef21079723ae6c",
  ],
  [
    "0131_m5_retire_capability_tombstones_after_activation.sql",
    "cf6a66b997095df92a0975fe94726106f269b84a733b2182ebe9e5cc33740fb7",
  ],
  [
    "0135_m2_xero_official_source_views.sql",
    "1daa4ccfdf4284c2593ad00827141449c83d67337b78a3bac27782ae733208a2",
  ],
  [
    "0136_m2_xero_pnl_lines.sql",
    "a94a5a0ebb8059eb3512c1fb66de0b9c35479781b942ba370d3e0fbf5df081d1",
  ],
  [
    "0137_m2_xero_gst_lines.sql",
    "471381fd878e1fab499dd5a0c81d5c8f0d6c0cf7218adc9384908ba34ae0deee",
  ],
  [
    "0169_m2_deputy_source_views_over_fivetran.sql",
    "003fa50c53fb5a54b7b66394a6362c99954c8b1ffa3bfbcf8576670fcb8db0a9",
  ],
]);

const FRESH_DEPUTY_SOURCE_VIEW_COMPATIBILITY = Object.freeze({
  id: "0134_m2_deputy_source_views.sql",
  checksum: "3c4b2ae020296affad452c187c3d9a4f3cee7802b3c6f3310a8f43488f073ae5",
});

const FRESH_DEPUTY_RAW_STUBS = `
CREATE SCHEMA IF NOT EXISTS "DEPUTYNEW";
CREATE TABLE IF NOT EXISTS "DEPUTYNEW".deputy_employee (
  "Id" text, "FirstName" text, "LastName" text, "DisplayName" text,
  "Position" text, "Active" boolean, "Paused" boolean, "StartDate" text,
  "TerminationDate" text, "Company" text, "Role" text, "Created" text,
  "Modified" text
);
CREATE TABLE IF NOT EXISTS "DEPUTYNEW".deputy_employeerole (
  "Id" text, "Role" text, "Ranking" text
);
CREATE TABLE IF NOT EXISTS "DEPUTYNEW".deputy_operationalunit (
  "Id" text, "OperationalUnitName" text, "Company" text, "CompanyName" text,
  "Active" boolean, "AddressObject__City" text, "AddressObject__State" text
);
CREATE TABLE IF NOT EXISTS "DEPUTYNEW".deputy_company (
  "Id" text, "CompanyName" text, "TradingName" text, "Active" boolean,
  "IsWorkplace" boolean, "IsPayrollEntity" boolean
);
CREATE TABLE IF NOT EXISTS "DEPUTYNEW".deputy_timesheet (
  "Id" text, "Employee" text, "_DPMetaData__EmployeeInfo__DisplayName" text,
  "Date" text, "StartTimeLocalized" text, "EndTimeLocalized" text,
  "TotalTime" text, "Cost__v_double" double precision, "Cost" text,
  "OnCost__v_double" double precision, "OnCost" text, "TimeApproved" boolean,
  "PayRuleApproved" boolean, "IsInProgress" boolean, "IsLeave" boolean,
  "LeaveId" text, "LeaveRule" text, "OperationalUnit" text,
  "_DPMetaData__OperationalUnitInfo__OperationalUnitName" text,
  "_DPMetaData__OperationalUnitInfo__CompanyName" text, "Roster" text,
  "EmployeeComment" text, "Created" text, "Modified" text, "Discarded" boolean
);
CREATE TABLE IF NOT EXISTS "DEPUTYNEW".deputy_roster (
  "Id" text, "Employee" text, "_DPMetaData__EmployeeInfo__DisplayName" text,
  "Date" text, "StartTimeLocalized" text, "EndTimeLocalized" text,
  "TotalTime" text, "Cost__v_double" double precision, "Cost" text,
  "Published" boolean, "Open" boolean, "MatchedByTimesheet" text,
  "OperationalUnit" text,
  "_DPMetaData__OperationalUnitInfo__OperationalUnitName" text,
  "_DPMetaData__OperationalUnitInfo__CompanyName" text, "Comment" text,
  "ConfirmStatus" text, "Created" text, "Modified" text
);
CREATE TABLE IF NOT EXISTS "DEPUTYNEW".deputy_leave (
  "Id" text, "Employee" text, "EmployeeName" text, "Company" text,
  "DateStart" text, "DateEnd" text, "Days__v_double" double precision,
  "Days" text, "TotalHours__v_double" double precision, "TotalHours" text,
  "Status" integer, "LeaveRule" text, "Comment" text,
  "ApprovalComment" text, "Created" text, "Modified" text
);
CREATE TABLE IF NOT EXISTS "DEPUTYNEW".deputy_leaverules (
  "Id" text, "Name" text, "PaidLeave" boolean, "Visible" boolean,
  "Description" text
);
`;

export function analyticalMigrationBody(
  migration: Readonly<{ id: string; checksum: string; body: string }>,
  bootstrap: boolean,
): string {
  const reviewedChecksum = FRESH_ANALYTICAL_DATA_MIGRATIONS.get(migration.id);
  if (
    bootstrap
    && migration.id === FRESH_DEPUTY_SOURCE_VIEW_COMPATIBILITY.id
  ) {
    if (migration.checksum !== FRESH_DEPUTY_SOURCE_VIEW_COMPATIBILITY.checksum) {
      throw new Error(
        `${migration.id} changed after its fresh-bootstrap Deputy compatibility review.`,
      );
    }
    return `${FRESH_DEPUTY_RAW_STUBS}\n${migration.body}`;
  }
  if (!bootstrap || !reviewedChecksum) return migration.body;
  if (migration.checksum !== reviewedChecksum)
    throw new Error(
      `${migration.id} changed after its fresh-bootstrap data-migration review.`,
    );
  return "SELECT 1 /* no predecessor pack rows exist in a fresh analytical database */;";
}

type Target = Readonly<{
  stream: Stream;
  directory: string;
  bootstrapFile: string;
  databaseUrlName: "CONTROL_PLANE_DATABASE_URL" | "ANALYTICAL_DATABASE_URL";
  roleName: "CONTROL_PLANE_MIGRATION_ROLE" | "ANALYTICAL_MIGRATION_ROLE";
  defaultRole: "albert_control_migration_owner" | "albert_migration_owner";
  deployerLogin: "albert_control_deployer" | "albert_analytical_deployer";
}>;

const targets: Readonly<Record<Stream, Target>> = Object.freeze({
  "control-plane": Object.freeze({
    stream: "control-plane",
    directory: "infra/migrations/control-plane",
    bootstrapFile: "infra/bootstrap/control_plane_role.sql",
    databaseUrlName: "CONTROL_PLANE_DATABASE_URL",
    roleName: "CONTROL_PLANE_MIGRATION_ROLE",
    defaultRole: "albert_control_migration_owner",
    deployerLogin: "albert_control_deployer",
  }),
  analytical: Object.freeze({
    stream: "analytical",
    directory: "infra/migrations/analytical",
    bootstrapFile: "infra/bootstrap/analytical_roles.sql",
    databaseUrlName: "ANALYTICAL_DATABASE_URL",
    roleName: "ANALYTICAL_MIGRATION_ROLE",
    defaultRole: "albert_migration_owner",
    deployerLogin: "albert_analytical_deployer",
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
    // A migration may open with `--` rationale lines before its transaction;
    // that prologue carries no statements, so it is stripped rather than run.
    const transaction = /^(?:\s*--[^\n]*\n)*\s*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/iu.exec(sql);
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

export function assertExactMigrationPrefix(
  local: readonly Pick<Migration, "id" | "checksum">[],
  applied: readonly AppliedMigration[],
  stream: Stream,
): void {
  if (applied.length > local.length) {
    throw new Error(`${stream} database contains migrations that are missing from this release.`);
  }
  for (const [index, prior] of applied.entries()) {
    const expected = local[index];
    if (!expected || prior.migration_id !== expected.id) {
      throw new Error(
        `${stream} migration history is not an exact release prefix at position ${index + 1}.`,
      );
    }
    if (prior.checksum_sha256 !== expected.checksum) {
      throw new Error(`${stream}/${expected.id} changed after it was applied.`);
    }
  }
}

async function applyBootstrap(
  client: Client,
  target: Target,
  requested: boolean,
): Promise<void> {
  if (!requested) return;
  const bootstrapSql = await readFile(resolve(target.bootstrapFile), "utf8");
  if (/^\s*\\/mu.test(bootstrapSql)) {
    throw new Error(`${target.bootstrapFile} contains unsupported psql meta-commands.`);
  }
  const checksum = createHash("sha256").update(bootstrapSql).digest("hex");
  const ledgerExists = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('albert_bootstrap.applied_bootstrap') IS NOT NULL AS exists",
  );
  if (ledgerExists.rows[0]?.exists) {
    const prior = await client.query<{ checksum_sha256: string }>(
      `SELECT checksum_sha256 FROM albert_bootstrap.applied_bootstrap
        WHERE stream=$1 AND bootstrap_file=$2`,
      [target.stream, target.bootstrapFile],
    );
    if (!prior.rows[0]) {
      throw new Error(`${target.stream} bootstrap ledger is missing the expected stream entry.`);
    }
    if (prior.rows[0].checksum_sha256 !== checksum) {
      throw new Error(`${target.stream} bootstrap changed after its one-time application.`);
    }
    process.stdout.write(`unchanged bootstrap/${target.stream}\n`);
    return;
  }

  const migrationLedgerExists = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('albert_migrations.applied_migration') IS NOT NULL AS exists",
  );
  if (migrationLedgerExists.rows[0]?.exists) {
    const priorCount = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM albert_migrations.applied_migration WHERE stream=$1",
      [target.stream],
    );
    if (Number(priorCount.rows[0]?.count ?? 0) > 0) {
      throw new Error(`${target.stream} has migration history but no checksummed bootstrap ledger.`);
    }
  }

  await client.query("BEGIN");
  try {
    await client.query(bootstrapSql);
    await client.query("CREATE SCHEMA albert_bootstrap");
    await client.query(`
      CREATE TABLE albert_bootstrap.applied_bootstrap (
        stream text PRIMARY KEY,
        bootstrap_file text NOT NULL,
        checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now(),
        applied_by text NOT NULL
      )
    `);
    await client.query(
      `INSERT INTO albert_bootstrap.applied_bootstrap (
         stream,bootstrap_file,checksum_sha256,applied_by
       ) VALUES ($1,$2,$3,session_user)`,
      [target.stream, target.bootstrapFile, checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  process.stdout.write(`bootstrapped ${target.stream}\n`);
}

async function ensureBootstrapMigrationRoleActivation(
  client: Client,
  target: Target,
  requested: boolean,
): Promise<void> {
  if (!requested) return;
  const access = await client.query<{
    can_set: boolean;
    current_user: string;
    session_user: string;
  }>(
    `SELECT pg_has_role(session_user,$1,'SET') AS can_set,
            current_user,session_user`,
    [target.defaultRole],
  );
  const identity = access.rows[0];
  if (identity?.can_set) return;

  // Supabase's protected postgres identity is intentionally not a superuser,
  // so unlike a conventional managed-Postgres administrator it cannot SET a
  // newly-created NOLOGIN role until membership is explicit. The control
  // bootstrap already records this same bounded grant. Reconcile it here for
  // the separately isolated analytical project without changing the immutable
  // bootstrap checksum or granting any runtime identity additional authority.
  if (
    target.stream !== "analytical" ||
    identity?.current_user !== "postgres" ||
    identity.session_user !== "postgres"
  ) {
    throw new Error(
      `${target.stream} bootstrap administrator cannot activate ${target.defaultRole}.`,
    );
  }
  await client.query(
    `GRANT ${quoteIdentifier(target.defaultRole)} TO ${quoteIdentifier(identity.session_user)}`,
  );
  const verified = await client.query<{ can_set: boolean }>(
    "SELECT pg_has_role(session_user,$1,'SET') AS can_set",
    [target.defaultRole],
  );
  if (!verified.rows[0]?.can_set) {
    throw new Error(
      `${target.stream} bootstrap administrator still cannot activate ${target.defaultRole}.`,
    );
  }
}

async function applyTarget(
  target: Target,
  environment: NodeJS.ProcessEnv,
  bootstrap: boolean,
): Promise<void> {
  const databaseUrl = environment[target.databaseUrlName]?.trim();
  if (!databaseUrl) throw new Error(`${target.databaseUrlName} is required.`);
  const requestedRole = environment[target.roleName]?.trim() || target.defaultRole;
  if (requestedRole !== target.defaultRole) {
    throw new Error(
      `${target.roleName} must be the dedicated ${target.defaultRole} role.`,
    );
  }
  const migrations = await loadMigrations(target.directory);
  if (bootstrap && target.stream === "control-plane") {
    // A control-plane bootstrap is the only migration mode that requires the
    // protected postgres administrator login. Reject a remote plaintext URL
    // before constructing a client so the credential is never sent in clear.
    assertProtectedAdminDatabaseUrl(databaseUrl);
  }
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

    if (bootstrap && target.stream === "control-plane") {
      await assertControlPlaneAdminIdentity(client);
    }
    await applyBootstrap(client, target, bootstrap);
    await ensureBootstrapMigrationRoleActivation(client, target, bootstrap);
    if (bootstrap && target.stream === "control-plane") {
      // Fresh databases apply the same immutable administrator stream used by
      // upgrades of existing databases. This happens before migration 0035,
      // which invokes the fixed retention-cron installer.
      await applyControlPlaneAdminUpgrades(client);
    }

    await client.query(`SET ROLE ${quoteIdentifier(requestedRole)}`);
    const identity = await client.query<{ current_user: string; session_user: string }>(
      "SELECT current_user, session_user",
    );
    const currentRole = identity.rows[0]?.current_user;
    const sessionUser = identity.rows[0]?.session_user;
    if (!currentRole || forbiddenMigrationRoles.has(currentRole)) {
      throw new Error(`Refusing to run migrations as runtime role ${currentRole ?? "unknown"}.`);
    }
    if (currentRole !== requestedRole) {
      throw new Error(
        `Migration role activation failed: expected ${requestedRole}, received ${currentRole}.`,
      );
    }
    if (
      environment.ALBERT_REQUIRE_DEPLOYER_LOGIN === "true" &&
      sessionUser !== target.deployerLogin
    ) {
      throw new Error(
        `Migration session must use the dedicated ${target.deployerLogin} login.`,
      );
    }

    // The deployer login itself deliberately has no extensions-schema access.
    // Resolve the managed-service bridge only after activating the dedicated
    // migration owner, which is also the identity that consumes these helpers.
    if (target.stream === "control-plane") {
      const authBridge = await client.query<{ ready: boolean }>(`
        SELECT
          to_regprocedure('extensions.albert_auth_uid()') IS NOT NULL
          AND to_regprocedure('extensions.albert_auth_jwt()') IS NOT NULL
          AND to_regprocedure('extensions.albert_auth_users_by_ids(uuid[])') IS NOT NULL
          AND to_regprocedure('extensions.albert_auth_confirmed_user_by_email(text)') IS NOT NULL
          AND to_regprocedure('extensions.albert_install_auth_user_foreign_keys()') IS NOT NULL
          AND to_regprocedure('extensions.albert_install_tenant_deletion_receipt_auth_reference()') IS NOT NULL
          AND to_regprocedure('extensions.albert_install_user_rate_limit_retention_cron_job()') IS NOT NULL
          AND to_regprocedure('extensions.albert_install_raw_payload_bucket()') IS NOT NULL
          AND to_regprocedure('extensions.albert_verify_raw_storage_machine_authority()') IS NOT NULL
          AND to_regprocedure('extensions.albert_raw_storage_machine_authorized(text)') IS NOT NULL
          AS ready
      `);
      if (!authBridge.rows[0]?.ready) {
        throw new Error(
          "Control-plane managed-service compatibility helpers are missing; run the protected administrator bootstrap upgrade first.",
        );
      }
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

    const applied = await client.query<AppliedMigration>(
      `SELECT migration_id, checksum_sha256
       FROM albert_migrations.applied_migration
       WHERE stream = $1
       ORDER BY migration_id`,
      [target.stream],
    );
    assertExactMigrationPrefix(migrations, applied.rows, target.stream);
    for (const migration of migrations.slice(applied.rows.length)) {
      const migrationBody =
        target.stream === "control-plane"
          ? controlPlaneMigrationBody(migration)
          : analyticalMigrationBody(migration, bootstrap);

      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
        await client.query(migrationBody);
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
