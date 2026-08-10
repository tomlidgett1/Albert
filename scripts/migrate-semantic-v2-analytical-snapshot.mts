import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { bindSemanticV2LiveProject } from "./lib/semantic-v2-schema-audit.js";
import {
  buildSnapshotDumpArguments,
  buildTargetSnapshotGuardSql,
  buildTenantRemapSql,
  postgresProcessEnvironment,
  qualifiedSnapshotTable,
  snapshotReceiptDigest,
  SNAPSHOT_ABORT_SQL,
  V2_SNAPSHOT_SCHEMAS,
  type SnapshotTable,
} from "./lib/semantic-v2-snapshot-migration.js";

const { Client } = pg;
const MAX_SAFE_ERROR_BYTES = 32 * 1024;

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`${prefix}... is required.`);
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function tenantTables(client: pg.Client): Promise<SnapshotTable[]> {
  const result = await client.query<{ schema_name: SnapshotTable["schema"]; table_name: string }>(
    `SELECT namespace.nspname AS schema_name,class.relname AS table_name
       FROM pg_catalog.pg_class AS class
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=class.relnamespace
       JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid=class.oid
      WHERE class.relkind IN ('r','p')
        AND namespace.nspname=ANY($1::text[])
        AND attribute.attname='tenant_id'
        AND attribute.attnum>0 AND NOT attribute.attisdropped
      ORDER BY namespace.nspname,class.relname`,
    [[...V2_SNAPSHOT_SCHEMAS]],
  );
  return result.rows.map(({ schema_name: schema, table_name: table }) => ({ schema, table }));
}

async function columnContract(client: pg.Client, tables: readonly SnapshotTable[]) {
  const allowed = new Set(tables.map((table) => `${table.schema}.${table.table}`));
  const result = await client.query<{
    schema_name: string;
    table_name: string;
    ordinal: number;
    column_name: string;
    data_type: string;
    not_null: boolean;
  }>(
    `SELECT namespace.nspname AS schema_name,class.relname AS table_name,
            attribute.attnum::integer AS ordinal,attribute.attname AS column_name,
            pg_catalog.format_type(attribute.atttypid,attribute.atttypmod) AS data_type,
            attribute.attnotnull AS not_null
       FROM pg_catalog.pg_class AS class
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=class.relnamespace
       JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid=class.oid
      WHERE class.relkind IN ('r','p')
        AND namespace.nspname=ANY($1::text[])
        AND attribute.attnum>0 AND NOT attribute.attisdropped
      ORDER BY namespace.nspname,class.relname,attribute.attnum`,
    [[...V2_SNAPSHOT_SCHEMAS]],
  );
  return result.rows.filter((row) => allowed.has(`${row.schema_name}.${row.table_name}`));
}

async function counts(
  client: pg.Client,
  tables: readonly SnapshotTable[],
  tenantId?: string,
): Promise<Record<string, number>> {
  const statements = tables.map((table, index) => {
    const qualified = qualifiedSnapshotTable(table);
    const predicate = tenantId ? ` WHERE tenant_id=$1` : "";
    return `SELECT ${index}::integer AS table_index,count(*)::bigint AS row_count FROM ${qualified}${predicate}`;
  });
  const result = await client.query<{ table_index: number; row_count: string }>(
    statements.join(" UNION ALL "),
    tenantId ? [tenantId] : [],
  );
  const bySchema = Object.fromEntries(V2_SNAPSHOT_SCHEMAS.map((schema) => [schema, 0]));
  for (const row of result.rows) {
    const count = Number(row.row_count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Snapshot row count is invalid.");
    const table = tables[row.table_index];
    if (!table) throw new Error("Snapshot count references an unknown table.");
    bySchema[table.schema] += count;
  }
  return bySchema;
}

function collectSafeError(stream: NodeJS.ReadableStream | null): () => string {
  let output = "";
  stream?.on("data", (chunk: Buffer | string) => {
    if (Buffer.byteLength(output) >= MAX_SAFE_ERROR_BYTES) return;
    output += Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
    output = output.slice(0, MAX_SAFE_ERROR_BYTES);
  });
  return () => output
    .replaceAll(/postgres(?:ql)?:\/\/[^\s]+/gu, "[database-url-redacted]")
    .replaceAll(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 1_000);
}

async function streamSnapshot(input: Readonly<{
  sourceUrl: string;
  targetUrl: string;
  tables: readonly SnapshotTable[];
  sourceTenantId: string;
  targetTenantId: string;
  sourceSnapshotId: string;
}>): Promise<void> {
  const dump = spawn("pg_dump", [
    ...buildSnapshotDumpArguments(input.tables, input.sourceSnapshotId),
  ], {
    env: postgresProcessEnvironment(
      input.sourceUrl,
      "albert-v2-snapshot-source",
      input.sourceTenantId,
    ),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const restore = spawn("psql", [
    "--dbname=postgres",
    "--single-transaction",
    "--set=ON_ERROR_STOP=1",
    "--quiet",
  ], {
    env: postgresProcessEnvironment(
      input.targetUrl,
      "albert-v2-snapshot-target",
      input.targetTenantId,
    ),
    stdio: ["pipe", "ignore", "pipe"],
  });
  const dumpError = collectSafeError(dump.stderr);
  const restoreError = collectSafeError(restore.stderr);
  restore.stdin.write(buildTargetSnapshotGuardSql(input.tables));
  dump.stdout.pipe(restore.stdin, { end: false });
  restore.stdin.on("error", () => {
    if (dump.exitCode === null) dump.kill("SIGTERM");
  });
  const completion = (process: ReturnType<typeof spawn>) => (
    new Promise<Readonly<{ code: number | null; error?: Error }>>((resolve) => {
      let settled = false;
      process.once("error", (error) => {
        if (!settled) {
          settled = true;
          resolve({ code: null, error });
        }
      });
      process.once("close", (code) => {
        if (!settled) {
          settled = true;
          resolve({ code });
        }
      });
    })
  );
  const dumpCompletion = completion(dump);
  const restoreCompletion = completion(restore);
  const first = await Promise.race([
    dumpCompletion.then((result) => ({ process: "dump" as const, result })),
    restoreCompletion.then((result) => ({ process: "restore" as const, result })),
  ]);
  let dumpResult: Awaited<typeof dumpCompletion>;
  let restoreResult: Awaited<typeof restoreCompletion>;
  if (first.process === "restore") {
    restoreResult = first.result;
    if (dump.exitCode === null) dump.kill("SIGTERM");
    dumpResult = await dumpCompletion;
  } else {
    dumpResult = first.result;
    if (dumpResult.error || dumpResult.code !== 0) {
      restore.stdin.end(SNAPSHOT_ABORT_SQL);
    } else {
      restore.stdin.end(buildTenantRemapSql(
        input.tables,
        input.sourceTenantId,
        input.targetTenantId,
      ));
    }
    restoreResult = await restoreCompletion;
  }
  if (dumpResult.error || restoreResult.error || dumpResult.code !== 0 || restoreResult.code !== 0) {
    const diagnostic = restoreError()
      || dumpError()
      || restoreResult.error?.message
      || dumpResult.error?.message
      || "no safe diagnostic";
    throw new Error(
      `Snapshot stream failed (dump=${String(dumpResult.code)}, restore=${String(restoreResult.code)}): ${diagnostic}`,
    );
  }
}

export async function migrateSemanticV2AnalyticalSnapshot(): Promise<void> {
  if (!process.argv.includes("--execute")) {
    throw new Error("Refusing to migrate an analytical snapshot without --execute.");
  }
  const sourceProjectRef = argument("source-project-ref");
  const targetProjectRef = argument("target-project-ref");
  const sourceTenantId = argument("source-tenant-id");
  const targetTenantId = argument("target-tenant-id");
  const sourceUrl = requiredEnvironment("ALBERT_V2_SOURCE_ANALYTICAL_DATABASE_URL");
  const targetUrl = requiredEnvironment("ANALYTICAL_ADMIN_DATABASE_URL");
  const sourceBinding = bindSemanticV2LiveProject(sourceUrl, sourceProjectRef);
  const targetBinding = bindSemanticV2LiveProject(targetUrl, targetProjectRef);
  assert.notEqual(sourceBinding.projectRef, targetBinding.projectRef);

  const source = new Client({ connectionString: sourceUrl, statement_timeout: 120_000 });
  const target = new Client({ connectionString: targetUrl, statement_timeout: 120_000 });
  await Promise.all([source.connect(), target.connect()]);
  let tables: SnapshotTable[];
  let before: Record<string, number>;
  let sourceSnapshotId: string;
  try {
    await Promise.all([
      source.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"),
      target.query("BEGIN TRANSACTION READ ONLY"),
    ]);
    await Promise.all([
      source.query("SELECT set_config('albert.tenant_id',$1,true)", [sourceTenantId]),
      target.query("SELECT set_config('albert.tenant_id',$1,true)", [targetTenantId]),
    ]);
    const exportedSnapshot = await source.query<{ snapshot_id: string }>(
      "SELECT pg_export_snapshot() AS snapshot_id",
    );
    sourceSnapshotId = exportedSnapshot.rows[0]?.snapshot_id ?? "";
    const [sourceTables, targetTables] = await Promise.all([
      tenantTables(source),
      tenantTables(target),
    ]);
    assert.deepEqual(targetTables, sourceTables, "Source and target tenant table sets differ.");
    tables = sourceTables;
    const [sourceColumns, targetColumns] = await Promise.all([
      columnContract(source, tables),
      columnContract(target, tables),
    ]);
    assert.deepEqual(targetColumns, sourceColumns, "Source and target snapshot schemas differ.");
    const sourceAll = await counts(source, tables);
    const sourceTenant = await counts(source, tables, sourceTenantId);
    const targetAll = await counts(target, tables);
    assert.deepEqual(
      sourceTenant,
      sourceAll,
      "The source snapshot contains rows outside the declared source tenant.",
    );
    assert.equal(sourceAll.source_lightspeed > 0, true, "Lightspeed snapshot is empty.");
    assert.equal(sourceAll.source_xero > 0, true, "Xero snapshot is empty.");
    assert.equal(
      Object.values(targetAll).every((count) => count === 0),
      true,
      "The target snapshot tables are not empty.",
    );
    before = sourceAll;
    await target.query("ROLLBACK");
  } catch (error) {
    await Promise.allSettled([source.query("ROLLBACK"), target.query("ROLLBACK")]);
    await Promise.allSettled([source.end(), target.end()]);
    throw error;
  }
  await target.end();

  try {
    await streamSnapshot({
      sourceUrl,
      targetUrl,
      tables,
      sourceTenantId,
      targetTenantId,
      sourceSnapshotId,
    });
  } finally {
    await source.query("ROLLBACK").catch(() => undefined);
    await source.end();
  }

  const verification = new Client({ connectionString: targetUrl, statement_timeout: 120_000 });
  await verification.connect();
  let after: Record<string, number>;
  try {
    await verification.query("BEGIN TRANSACTION READ ONLY");
    after = await counts(verification, tables, targetTenantId);
    assert.deepEqual(after, before, "The migrated snapshot row counts do not match the source.");
    const sourceResidue = await counts(verification, tables, sourceTenantId);
    assert.equal(
      Object.values(sourceResidue).every((count) => count === 0),
      true,
      "Source tenant identifiers remain in the target snapshot.",
    );
    await verification.query("ROLLBACK");
  } finally {
    await verification.end();
  }

  const body = Object.freeze({
    schemaVersion: 1,
    kind: "albert.semantic-v2-analytical-snapshot-migration",
    status: "passed",
    sourceProjectRef,
    targetProjectRef,
    sourceTenantId,
    targetTenantId,
    tableCount: tables.length,
    rowCounts: after,
    completedAt: new Date().toISOString(),
  });
  process.stdout.write(`${JSON.stringify({ ...body, receiptDigest: snapshotReceiptDigest(body) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrateSemanticV2AnalyticalSnapshot();
}
