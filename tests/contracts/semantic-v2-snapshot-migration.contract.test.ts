import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildSnapshotDumpArguments,
  buildTargetSnapshotGuardSql,
  buildTenantRemapSql,
  postgresProcessEnvironment,
  snapshotReceiptDigest,
  SNAPSHOT_ABORT_SQL,
  type SnapshotTable,
} from "../../scripts/lib/semantic-v2-snapshot-migration.js";

const tables: SnapshotTable[] = [
  { schema: "source_lightspeed", table: "ls_sales" },
  { schema: "source_xero", table: "xero_invoices" },
];

test("snapshot transfer allowlists exact tenant tables and never puts credentials in process arguments", () => {
  const args = buildSnapshotDumpArguments(tables, "00000003-0000001B-1");
  assert.ok(args.includes('--table="source_lightspeed"."ls_sales"'));
  assert.ok(args.includes('--table="source_xero"."xero_invoices"'));
  assert.ok(args.includes("--snapshot=00000003-0000001B-1"));
  assert.ok(args.includes("--enable-row-security"));
  assert.ok(args.every((value) => !value.includes("secret")));
  assert.throws(
    () => buildSnapshotDumpArguments(
      [{ schema: "public" as never, table: "users" }],
      "00000003-0000001B-1",
    ),
    /outside the migration allowlist/u,
  );
  const environment = postgresProcessEnvironment(
    "postgresql://operator:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=require",
    "snapshot-test",
    "01KZ4ZMVF5QNQ4TX35VF3WDJBM",
  );
  assert.equal(environment.PGPASSWORD, "secret");
  assert.equal(environment.PGSSLMODE, "require");
  assert.equal(environment.PGOPTIONS, "-c albert.tenant_id=01KZ4ZMVF5QNQ4TX35VF3WDJBM");
  assert.ok(args.every((value) => !value.includes(String(environment.PGPASSWORD))));
});

test("target guard locks every table and aborts if any target row exists", () => {
  const sql = buildTargetSnapshotGuardSql(tables);
  assert.match(sql, /^LOCK TABLE /u);
  assert.match(sql, /IN ACCESS EXCLUSIVE MODE/u);
  assert.equal((sql.match(/EXISTS \(SELECT 1 FROM/gu) ?? []).length, tables.length);
  assert.match(sql, /RAISE EXCEPTION/u);
});

test("tenant remapping is bounded to validated identifiers and every selected table", () => {
  const sql = buildTenantRemapSql(
    tables,
    "01KZ4ZMVF5QNQ4TX35VF3WDJBM",
    "01KZN20VTX2EWW1TQ2AA3MCPW6",
  );
  assert.match(sql, /UPDATE "source_lightspeed"\."ls_sales"/u);
  assert.match(sql, /UPDATE "source_xero"\."xero_invoices"/u);
  assert.equal((sql.match(/WHERE tenant_id=/gu) ?? []).length, tables.length);
  assert.throws(
    () => buildTenantRemapSql(tables, "unsafe", "01KZN20VTX2EWW1TQ2AA3MCPW6"),
    /identifier is invalid/u,
  );
});

test("migration entry point is explicit, atomic, receipt-bound, and never stages customer data on disk", async () => {
  const source = await readFile(
    new URL("../../scripts/migrate-semantic-v2-analytical-snapshot.mts", import.meta.url),
    "utf8",
  );
  assert.match(source, /--execute/u);
  assert.match(source, /BEGIN TRANSACTION READ ONLY/u);
  assert.match(source, /--single-transaction/u);
  assert.match(source, /ON_ERROR_STOP=1/u);
  assert.match(source, /pg_export_snapshot/u);
  assert.match(source, /SNAPSHOT_ABORT_SQL/u);
  assert.match(source, /dump\.stdout\.pipe\(restore\.stdin/u);
  assert.doesNotMatch(source, /writeFile|mkdtemp|tmpdir/u);
  assert.match(snapshotReceiptDigest({ b: 2, a: 1 }), /^[a-f0-9]{64}$/u);
  assert.equal(
    snapshotReceiptDigest({ b: 2, a: 1 }),
    snapshotReceiptDigest({ a: 1, b: 2 }),
  );
  assert.match(SNAPSHOT_ABORT_SQL, /albert_snapshot_dump_failed/u);
});
