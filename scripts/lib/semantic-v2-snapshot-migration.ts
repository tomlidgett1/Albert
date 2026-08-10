import { createHash } from "node:crypto";

export const V2_SNAPSHOT_SCHEMAS = Object.freeze([
  "source_lightspeed",
  "source_xero",
  "core",
  "mart",
] as const);

export type SnapshotTable = Readonly<{
  schema: (typeof V2_SNAPSHOT_SCHEMAS)[number];
  table: string;
}>;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;
const POSTGRES_SNAPSHOT_ID = /^[0-9A-F]+-[0-9A-F]+-[0-9]+$/iu;

export const SNAPSHOT_ABORT_SQL = "SELECT albert_snapshot_dump_failed();\n";

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error("Snapshot table identifier is invalid.");
  return `"${value}"`;
}

export function qualifiedSnapshotTable(table: SnapshotTable): string {
  if (!V2_SNAPSHOT_SCHEMAS.includes(table.schema)) {
    throw new Error("Snapshot schema is outside the migration allowlist.");
  }
  return `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`;
}

export function buildSnapshotDumpArguments(
  tables: readonly SnapshotTable[],
  snapshotId: string,
): readonly string[] {
  if (tables.length === 0) throw new Error("Snapshot migration has no tenant-scoped tables.");
  if (!POSTGRES_SNAPSHOT_ID.test(snapshotId)) {
    throw new Error("PostgreSQL snapshot identifier is invalid.");
  }
  return Object.freeze([
    "--data-only",
    "--no-owner",
    "--no-privileges",
    "--format=plain",
    "--enable-row-security",
    "--dbname=postgres",
    `--snapshot=${snapshotId}`,
    ...tables.map((table) => `--table=${qualifiedSnapshotTable(table)}`),
  ]);
}

export function buildTargetSnapshotGuardSql(
  tables: readonly SnapshotTable[],
): string {
  if (tables.length === 0) throw new Error("Snapshot migration has no tenant-scoped tables.");
  const qualified = tables.map(qualifiedSnapshotTable);
  const occupied = qualified.map((table) => `EXISTS (SELECT 1 FROM ${table} LIMIT 1)`);
  return [
    `LOCK TABLE ${qualified.join(",")} IN ACCESS EXCLUSIVE MODE;`,
    "DO $albert_snapshot$",
    "BEGIN",
    `  IF ${occupied.join(" OR ")} THEN`,
    "    RAISE EXCEPTION 'Albert V2 snapshot target is not empty.';",
    "  END IF;",
    "END",
    "$albert_snapshot$;",
    "",
  ].join("\n");
}

export function buildTenantRemapSql(
  tables: readonly SnapshotTable[],
  sourceTenantId: string,
  targetTenantId: string,
): string {
  if (!ULID.test(sourceTenantId) || !ULID.test(targetTenantId)) {
    throw new Error("Snapshot tenant identifier is invalid.");
  }
  if (sourceTenantId === targetTenantId) {
    throw new Error("Snapshot source and target tenants must differ.");
  }
  return `${tables.map((table) => (
    `UPDATE ${qualifiedSnapshotTable(table)} SET tenant_id='${targetTenantId}' WHERE tenant_id='${sourceTenantId}';`
  )).join("\n")}\n`;
}

export function postgresProcessEnvironment(
  connectionString: string,
  applicationName: string,
  tenantId: string,
): NodeJS.ProcessEnv {
  if (!ULID.test(tenantId)) {
    throw new Error("Snapshot tenant identifier is invalid.");
  }
  let connection: URL;
  try {
    connection = new URL(connectionString);
  } catch {
    throw new Error("Snapshot database URL is invalid.");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(connection.protocol)) {
    throw new Error("Snapshot database URL must use PostgreSQL.");
  }
  const database = decodeURIComponent(connection.pathname.replace(/^\//u, ""));
  if (!connection.hostname || !connection.username || !database) {
    throw new Error("Snapshot database URL is incomplete.");
  }
  const sslMode = connection.searchParams.get("sslmode") ?? "require";
  if (sslMode !== "require" && sslMode !== "verify-full") {
    throw new Error("Snapshot database URL must require TLS.");
  }
  return Object.freeze({
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH,
    PGHOST: connection.hostname,
    PGPORT: connection.port || "5432",
    PGDATABASE: database,
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGSSLMODE: sslMode,
    PGAPPNAME: applicationName,
    PGOPTIONS: `-c albert.tenant_id=${tenantId}`,
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function snapshotReceiptDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
