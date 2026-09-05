import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "pg";

import { analyticalMigrationBody } from "./migrate.js";

const FIXTURE_DATABASE = "albert_momence_0153_upgrade_ci";
const PREFIX_END = "0152_m8_shopify_deletion_closure.sql";
const TRANSITION = "0153_m2_momence_bounded_reconciliation_transition.sql";
const MIGRATION_DIRECTORY = resolve("infra/migrations/analytical");

type Migration = Readonly<{
  id: string;
  checksum: string;
  body: string;
}>;

function fixtureDatabaseUrl(adminDatabaseUrl: string): string {
  const parsed = new URL(adminDatabaseUrl);
  parsed.pathname = `/${FIXTURE_DATABASE}`;
  parsed.searchParams.delete("options");
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function quoteExternalIdentifier(identifier: string): string {
  if (identifier.length === 0 || identifier.length > 63 || identifier.includes("\0")) {
    throw new Error(`Unsafe external PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function externalColumnType(schema: string, table: string, column: string): string {
  if (schema === "DEPUTYNEW") {
    if (/^(?:Active|Paused|TimeApproved|PayRuleApproved|IsInProgress|IsLeave|Discarded|Published|Open|PaidLeave|Visible)$/u.test(column)) {
      return "boolean";
    }
    if (table === "deputy_leave" && column === "Status") return "integer";
    if (/__v_double$/u.test(column)) return "double precision";
    return "text";
  }
  if (/^(?:Is|Can|Enable|Show|Add|Has|ApprovedForSending|CurrentRecord)/u.test(column)) {
    return "boolean";
  }
  if (/^(?:Amount|SubTotal|TotalTax|Total|RemainingCredit|LineAmount|TaxAmount|Quantity|UnitAmount|CurrencyRate|BankAmount|TotalAmount|DebitTotal|CreditTotal|Wages|Deductions|Tax|Super|Reimbursement|Reimbursements|NetPay|Hours|NumberOfUnits|NormalEntitlement|AnnualSalary|RatePerUnit|NormalNumberOfUnits|NumberOfUnitsPerWeek|purchasePrice|disposalPrice|accountingBookValue|bookDepreciationDetail__priorAccumDepreciationAmount|bookDepreciationDetail__currentAccumDepreciationAmount|bookDepreciationDetail__currentGainLoss|bookDepreciationSetting__depreciationRate|Balances__.*|PaymentTerms__.*|FinancialYearEndDay|FinancialYearEndMonth|Size|SortOrder)$/u.test(column)) {
    return "numeric";
  }
  return "text";
}

async function loadMigrations(): Promise<readonly Migration[]> {
  const names = (await readdir(MIGRATION_DIRECTORY))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  const prefixIndex = names.indexOf(PREFIX_END);
  const transitionIndex = names.indexOf(TRANSITION);
  if (prefixIndex < 0 || transitionIndex !== prefixIndex + 1) {
    throw new Error(
      `${TRANSITION} must immediately follow ${PREFIX_END} in the analytical migration stream.`,
    );
  }

  const migrations: Migration[] = [];
  for (const id of names.slice(0, transitionIndex + 1)) {
    const sql = await readFile(resolve(MIGRATION_DIRECTORY, id), "utf8");
    const transaction = /^(?:\s*--[^\n]*\n)*\s*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/iu.exec(sql);
    if (!transaction) {
      throw new Error(`${id} must contain one explicit outer BEGIN/COMMIT transaction.`);
    }
    migrations.push({
      id,
      checksum: createHash("sha256").update(sql).digest("hex"),
      body: transaction[1]!,
    });
  }
  return migrations;
}

async function executeTransaction(
  client: Client,
  body: string,
  label: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '5min'");
    await client.query(body);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error(`Momence 0153 upgrade fixture failed during ${label}.`, { cause: error });
  }
}

async function installExternalLandingCompatibility(client: Client): Promise<void> {
  const migrationIds = [
    "0134_m2_deputy_source_views.sql",
    "0135_m2_xero_official_source_views.sql",
    "0136_m2_xero_pnl_lines.sql",
    "0137_m2_xero_gst_lines.sql",
  ];
  const sources = await Promise.all(
    migrationIds.map((id) => readFile(resolve(MIGRATION_DIRECTORY, id), "utf8")),
  );
  const relations = new Map<
    string,
    { schema: string; table: string; aliases: Set<string>; columns: Set<string> }
  >();
  for (const source of sources) {
    const aliases: Array<Readonly<{ schema: string; table: string; alias: string }>> = [];
    for (const match of source.matchAll(
      /(?:FROM|JOIN)\s+"([^"]+)"\.(?:"([^"]+)"|([a-z][a-z0-9_]*))\s+([a-z][a-z0-9_]*)/gu,
    )) {
      const schema = match[1]!;
      const table = match[2] ?? match[3]!;
      const alias = match[4]!;
      if (schema !== "DEPUTYNEW" && schema !== "XER_OFFICIAL") continue;
      const key = `${schema}\u0000${table}`;
      const relation = relations.get(key) ?? {
        schema,
        table,
        aliases: new Set<string>(),
        columns: new Set<string>(),
      };
      relation.aliases.add(alias);
      relations.set(key, relation);
      aliases.push({ schema, table, alias });
    }
    for (const relation of aliases) {
      const target = relations.get(`${relation.schema}\u0000${relation.table}`)!;
      const reference = new RegExp(`\\b${relation.alias}\\."([^"]+)"`, "gu");
      for (const match of source.matchAll(reference)) target.columns.add(match[1]!);
    }
  }

  await client.query('CREATE SCHEMA IF NOT EXISTS "DEPUTYNEW"');
  await client.query('CREATE SCHEMA IF NOT EXISTS "XER_OFFICIAL"');
  for (const relation of [...relations.values()].sort((left, right) =>
    `${left.schema}.${left.table}`.localeCompare(`${right.schema}.${right.table}`))) {
    if (relation.columns.size === 0) relation.columns.add("_dlt_fixture_placeholder");
    const definitions = [...relation.columns]
      .sort((left, right) => left.localeCompare(right))
      .map((column) =>
        `${quoteExternalIdentifier(column)} ${externalColumnType(relation.schema, relation.table, column)}`)
      .join(",");
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${quoteExternalIdentifier(relation.schema)}.${quoteExternalIdentifier(relation.table)} (${definitions})`,
    );
  }
}

async function main(): Promise<void> {
  const adminDatabaseUrl =
    process.env.MOMENCE_UPGRADE_TEST_ADMIN_DATABASE_URL?.trim()
    || process.env.ANALYTICAL_ADMIN_DATABASE_URL?.trim();
  if (!adminDatabaseUrl) {
    throw new Error(
      "MOMENCE_UPGRADE_TEST_ADMIN_DATABASE_URL or ANALYTICAL_ADMIN_DATABASE_URL is required.",
    );
  }

  const admin = new Client({
    connectionString: adminDatabaseUrl,
    application_name: "albert-momence-0153-upgrade-admin",
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  try {
    const identity = await admin.query<{ is_superuser: boolean }>(
      "SELECT rolsuper AS is_superuser FROM pg_roles WHERE rolname=session_user",
    );
    if (!identity.rows[0]?.is_superuser) {
      throw new Error("The isolated upgrade fixture requires a PostgreSQL test superuser.");
    }
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(FIXTURE_DATABASE)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(FIXTURE_DATABASE)}`);
  } finally {
    await admin.end();
  }

  let fixture: Client | undefined;
  try {
    fixture = new Client({
      connectionString: fixtureDatabaseUrl(adminDatabaseUrl),
      application_name: "albert-momence-0153-upgrade",
      connectionTimeoutMillis: 10_000,
    });
    await fixture.connect();
    const bootstrap = await readFile(resolve("infra/bootstrap/analytical_roles.sql"), "utf8");
    await fixture.query(bootstrap);
    await fixture.query("SET ROLE albert_migration_owner");
    const role = await fixture.query<{ current_user: string; session_user: string }>(
      "SELECT current_user,session_user",
    );
    if (role.rows[0]?.current_user !== "albert_migration_owner") {
      throw new Error("The fixture did not activate albert_migration_owner.");
    }

    const migrations = await loadMigrations();
    const prefix = migrations.slice(0, -1);
    for (const migration of prefix) {
      if (migration.id === "0134_m2_deputy_source_views.sql") {
        await installExternalLandingCompatibility(fixture);
      }
      await executeTransaction(
        fixture,
        analyticalMigrationBody(migration, true),
        migration.id,
      );
    }
    process.stdout.write(
      `Applied ${prefix.length} analytical migrations through ${PREFIX_END} as albert_migration_owner.\n`,
    );

    const seed = await readFile(
      resolve("tests/sql/analytical-momence-0153-upgrade-seed.sql"),
      "utf8",
    );
    await fixture.query(seed);

    const transition = migrations.at(-1)!;
    await executeTransaction(fixture, transition.body, transition.id);

    const assertions = await readFile(
      resolve("tests/sql/analytical-momence-0153-upgrade-assert.sql"),
      "utf8",
    );
    await fixture.query(assertions);
    process.stdout.write("Momence 0152 -> 0153 upgrade fixture passed.\n");
  } finally {
    await fixture?.end().catch(() => undefined);
    const cleanup = new Client({
      connectionString: adminDatabaseUrl,
      application_name: "albert-momence-0153-upgrade-cleanup",
      connectionTimeoutMillis: 10_000,
    });
    await cleanup.connect();
    try {
      await cleanup.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(FIXTURE_DATABASE)} WITH (FORCE)`,
      );
    } finally {
      await cleanup.end();
    }
  }
}

await main();
