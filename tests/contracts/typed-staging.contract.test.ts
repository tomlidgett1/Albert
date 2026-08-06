import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ulid } from "ulid";
import { deputyManifest } from "../../connectors/deputy/manifest.js";
import { lightspeedRManifest } from "../../connectors/lightspeed-r/manifest.js";
import { xeroManifest } from "../../connectors/xero/manifest.js";
import {
  buildStagingContracts,
  projectSourceRecord,
  projectStagingFields,
  stagingColumnName,
  type ConnectorManifest,
} from "../../packages/connector-sdk/src/index.js";
import type { SyncJob } from "../../packages/queue/src/index.js";
import type { RawBatchManifest } from "../../packages/storage/src/index.js";
import {
  createConnectorStagingBatchMigration,
  createConnectorStagingMigration,
  parseConnectorStagingMigrationOptions,
} from "../../scripts/generate-connector-staging.js";
import { AnalyticalLandingStore } from "../../services/sync-workers/src/analytical-store.js";
import type { TransactionalPostgres } from "../../services/sync-workers/src/database.js";

const manifests = [lightspeedRManifest, xeroManifest, deputyManifest] as const;

// Stream counts are computed from the manifests at runtime, never pinned:
// Lightspeed carries 90 spec-generated streams today and the Xero pack is
// being widened by parallel work, so a hardcoded count is guaranteed drift.
function streamCount(scoped: readonly ConnectorManifest[]): number {
  return scoped.reduce((count, manifest) => count + manifest.streams.length, 0);
}

type Fixture = Readonly<{
  responses: Readonly<Record<string, unknown>>;
}>;

function readFixture(path: string): Fixture {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Fixture;
}

function fixtureRecords(
  manifest: ConnectorManifest,
  fixture: Fixture,
  stream: ConnectorManifest["streams"][number],
): readonly Readonly<Record<string, unknown>>[] {
  const response = fixture.responses[stream.id];
  const candidate = manifest.id === "deputy"
    ? response
    : response && typeof response === "object"
      ? (response as Readonly<Record<string, unknown>>)[stream.resource]
      : undefined;
  if (candidate === undefined || candidate === null) return [];
  return (Array.isArray(candidate) ? candidate : [candidate]) as readonly Readonly<Record<string, unknown>>[];
}

/** Column sets per staging table created by a generated migration file. */
function parseCreatedTables(sql: string, schema: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const tableMatcher = new RegExp(
    `CREATE TABLE IF NOT EXISTS "${schema}"\\."([a-z0-9_]+)" \\(([\\s\\S]*?)\\n\\);`,
    "gu",
  );
  for (const match of sql.matchAll(tableMatcher)) {
    const columns = new Set<string>();
    for (const line of (match[2] ?? "").split("\n")) {
      const column = /^\s*"([a-z0-9_]+)"\s/u.exec(line);
      if (column?.[1]) columns.add(column[1]);
    }
    tables.set(match[1] ?? "", columns);
  }
  return tables;
}

/** Folds `ALTER TABLE … ADD COLUMN` statements into the created-table column sets. */
function applyAddedColumns(
  tables: Map<string, Set<string>>,
  sql: string,
  schema: string,
): number {
  let added = 0;
  const alterMatcher = new RegExp(`ALTER TABLE ${schema}\\."([a-z0-9_]+)"([\\s\\S]*?);`, "gu");
  for (const match of sql.matchAll(alterMatcher)) {
    const columns = tables.get(match[1] ?? "");
    assert.ok(columns, `An additive migration alters unknown staging table ${match[1]}.`);
    for (const column of (match[2] ?? "").matchAll(/ADD COLUMN IF NOT EXISTS "([a-z0-9_]+)"/gu)) {
      if (column[1]) {
        columns.add(column[1]);
        added += 1;
      }
    }
  }
  return added;
}

test("typed staging migrations fully cover every connector field contract", () => {
  const contracts = buildStagingContracts(manifests);
  assert.equal(contracts.length, streamCount(manifests));
  for (const manifest of manifests) {
    for (const stream of manifest.streams) {
      const contract = contracts.find(
        (candidate) => candidate.connectorId === manifest.id && candidate.stream === stream.id,
      );
      assert.ok(contract, `Missing ${manifest.id}.${stream.id} typed staging contract`);
      const allDispositions = manifest.fieldCoverage.filter((field) => field.stream === stream.id);
      const dispositions = allDispositions.filter((field) => field.disposition !== "unsupported");
      assert.equal(contract.fields.length, dispositions.length);
      assert.ok(allDispositions.every((field) => Boolean(field.stagingType)));
      assert.equal(new Set(contract.fields.map((field) => field.column)).size, contract.fields.length);
    }
  }

  // Applied migrations are immutable baselines: they are pinned by content
  // hash and never regenerated. A contract change lands as a NEW additive
  // migration which must then be folded into the coverage checks below.
  const baseline = readFileSync(
    new URL("../../infra/migrations/analytical/0005_m3_typed_connector_staging.sql", import.meta.url),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(baseline).digest("hex"),
    "089c94db4e3f496db70670e54b13d34d754ed3341a6b3ba284cd9eb5c1aaca36",
    "migration 0005 is an immutable applied baseline",
  );
  const legacyVendor = readFileSync(
    new URL("../../infra/migrations/analytical/0093_m3_lightspeed_vendor_staging.sql", import.meta.url),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(legacyVendor).digest("hex"),
    "cbacd269f4141de553693476eddaefb5783fc52717b42712cd36b366a23ee0e9",
    "migration 0093 is an immutable applied baseline",
  );
  const fullStaging = readFileSync(
    new URL("../../infra/migrations/analytical/0121_m2_lightspeed_full_staging.sql", import.meta.url),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(fullStaging).digest("hex"),
    "cf90279ad00dfca20929d2e2c22c7c1c19573d5e133e94ed707c14491bfb327c",
    "migration 0121 is an immutable applied baseline",
  );
  const childContext = readFileSync(
    new URL("../../infra/migrations/analytical/0125_m3_lightspeed_child_context_columns.sql", import.meta.url),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(childContext).digest("hex"),
    "7d92069a160dc376312ccb7cdea3a7c6ea068dda6de4dd17a430a01f552d5b1d",
    "migration 0125 is an immutable applied baseline",
  );

  // Lightspeed's applied DDL is 0121 (the 90 generated tables) PLUS the 0125
  // additive parent-context columns. Coverage has evolved since 0121 was
  // generated, so the invariant is set coverage, not byte identity: every
  // contract table exists and every contract column exists in the union of
  // the applied migrations. A new Lightspeed stream or column fails here
  // until its additive migration lands and is added to this union.
  const lightspeedTables = parseCreatedTables(fullStaging, "source_lightspeed");
  assert.equal(lightspeedTables.size, lightspeedRManifest.streams.length);
  assert.ok(applyAddedColumns(lightspeedTables, childContext, "source_lightspeed") > 0);
  for (const contract of contracts.filter((candidate) => candidate.connectorId === "lightspeed-r")) {
    const columns = lightspeedTables.get(contract.table);
    assert.ok(columns, `source_lightspeed.${contract.table} has no applied CREATE TABLE migration`);
    for (const field of contract.fields) {
      assert.ok(
        columns.has(field.column),
        `source_lightspeed.${contract.table}.${field.column} is missing from the applied migrations; create a new additive migration`,
      );
    }
    for (const field of lightspeedRManifest.fieldCoverage) {
      if (field.stream !== contract.stream || field.disposition !== "unsupported") continue;
      const column = stagingColumnName(field.field);
      if (contract.fields.some((staged) => staged.column === column)) continue;
      assert.ok(
        !columns.has(column),
        `source_lightspeed.${contract.table}.${column} stages an unsupported field; unsupported fields remain in immutable raw storage only`,
      );
    }
  }
  const lightspeedSet = `${fullStaging}\n${childContext}`;
  assert.equal(
    fullStaging.match(/^CREATE TABLE IF NOT EXISTS/gmu)?.length,
    lightspeedRManifest.streams.length,
  );
  assert.equal(
    lightspeedSet.match(/ENABLE ROW LEVEL SECURITY;/gu)?.length,
    lightspeedRManifest.streams.length,
  );
  assert.equal(
    lightspeedSet.match(/^CREATE POLICY tenant_scope/gmu)?.length,
    lightspeedRManifest.streams.length,
  );
  assert.doesNotMatch(lightspeedSet, /raw_payload|access_token|refresh_token/iu);

  // Deputy is unchanged, so its contracts remain fully covered by baseline 0005.
  const deputyTables = parseCreatedTables(baseline, "source_deputy");
  for (const contract of contracts.filter((candidate) => candidate.connectorId === "deputy")) {
    const columns = deputyTables.get(contract.table);
    assert.ok(columns, `source_deputy.${contract.table} has no applied CREATE TABLE migration`);
    for (const field of contract.fields) {
      assert.ok(
        columns.has(field.column),
        `source_deputy.${contract.table}.${field.column} is missing from migration 0005`,
      );
    }
  }
  assert.doesNotMatch(baseline, /dp_meta_data/iu, "unsupported fields remain in immutable raw storage only");

  // Xero is mid-rebuild in a parallel session: its manifest already declares
  // the widened xero_* streams but no staging migrations exist for them yet,
  // so migration coverage is asserted only for lightspeed-r and deputy.
  // Extend the coverage checks to Xero once its staging migration lands.
});

test("typed staging generator allocates a new migration and refuses to regenerate a stream", async (context) => {
  const migrationsDirectory = await mkdtemp(join(tmpdir(), "albert-staging-generator-"));
  context.after(async () => rm(migrationsDirectory, { recursive: true, force: true }));
  const priorPath = join(migrationsDirectory, "0094_m5_existing.sql");
  const priorSql = "BEGIN;\n-- immutable prior migration\nCOMMIT;\n";
  await writeFile(priorPath, priorSql, "utf8");

  const createdPath = await createConnectorStagingMigration({
    connector: "lightspeed-r",
    stream: "ls_vendors",
    name: "new_vendor_stream",
    migrationsDirectory,
  });
  assert.equal(createdPath, join(migrationsDirectory, "0095_m3_new_vendor_stream.sql"));
  assert.match(
    await readFile(createdPath, "utf8"),
    /CREATE TABLE IF NOT EXISTS "source_lightspeed"\."ls_vendors"/u,
  );
  assert.equal(await readFile(priorPath, "utf8"), priorSql);

  await assert.rejects(
    createConnectorStagingMigration({
      connector: "lightspeed-r",
      stream: "ls_vendors",
      name: "duplicate_vendor_stream",
      migrationsDirectory,
    }),
    /already exists.*never rewrite or regenerate an applied migration/iu,
  );
  assert.throws(
    () => parseConnectorStagingMigrationOptions(["--connector", "lightspeed-r", "--stream", "ls_vendors"]),
    /Usage:/u,
  );
  assert.throws(
    () => parseConnectorStagingMigrationOptions([
      "--connector", "lightspeed-r", "--stream", "ls_vendors", "--all-new", "--name", "conflicting_modes",
    ]),
    /Usage:/u,
  );
});

test("typed staging batch generator creates every missing stream table and refuses an empty rerun", async (context) => {
  const migrationsDirectory = await mkdtemp(join(tmpdir(), "albert-staging-batch-"));
  context.after(async () => rm(migrationsDirectory, { recursive: true, force: true }));
  // One stream table already exists: the batch must skip it, never throw and
  // never regenerate it.
  const vendorPath = await createConnectorStagingMigration({
    connector: "lightspeed-r",
    stream: "ls_vendors",
    name: "vendor_stream",
    migrationsDirectory,
  });
  const vendorSql = await readFile(vendorPath, "utf8");

  const batch = await createConnectorStagingBatchMigration({
    connector: "lightspeed-r",
    name: "lightspeed_full_staging",
    migrationsDirectory,
  });
  assert.equal(batch.migrationPath, join(migrationsDirectory, "0002_m3_lightspeed_full_staging.sql"));
  assert.deepEqual(batch.skippedStreams, ["ls_vendors"]);
  const expectedCreated = lightspeedRManifest.streams
    .map((stream) => stream.id)
    .filter((id) => id !== "ls_vendors");
  assert.deepEqual([...batch.createdStreams].sort(), [...expectedCreated].sort());

  const batchSql = await readFile(batch.migrationPath, "utf8");
  assert.equal(
    batchSql.match(/^CREATE TABLE IF NOT EXISTS/gmu)?.length,
    lightspeedRManifest.streams.length - 1,
  );
  assert.doesNotMatch(batchSql, /"source_lightspeed"\."ls_vendors"/u);
  for (const streamId of expectedCreated) {
    assert.match(
      batchSql,
      new RegExp(`CREATE TABLE IF NOT EXISTS "source_lightspeed"\\."${streamId}"`, "u"),
    );
  }
  assert.equal(await readFile(vendorPath, "utf8"), vendorSql);

  // Nothing new remains, so a second batch run must refuse to write at all.
  await assert.rejects(
    createConnectorStagingBatchMigration({
      connector: "lightspeed-r",
      name: "nothing_new",
      migrationsDirectory,
    }),
    /refusing to write an empty migration/iu,
  );
  assert.deepEqual(
    (await readdir(migrationsDirectory)).sort(),
    ["0001_m3_vendor_stream.sql", "0002_m3_lightspeed_full_staging.sql"],
  );
});

test("all approved fields in sanitized vendor recordings project into typed columns", () => {
  // The Xero pack is mid-rebuild in a parallel session: its sanitized
  // recording still keys the legacy streams, so this assertion is scoped to
  // the packs whose recordings match their manifests. Restore Xero here once
  // its recording is regenerated for the widened xero_* streams.
  const recordedManifests = [lightspeedRManifest, deputyManifest] as const;
  const fixtures = new Map([
    ["lightspeed-r", readFixture("../../connectors/lightspeed-r/fixtures/sanitized-recording.json")],
    ["deputy", readFixture("../../connectors/deputy/fixtures/sanitized-recording.json")],
  ]);
  const contracts = buildStagingContracts(recordedManifests);
  let projectedRecords = 0;
  for (const manifest of recordedManifests) {
    const fixture = fixtures.get(manifest.id);
    assert.ok(fixture);
    for (const stream of manifest.streams) {
      const contract = contracts.find(
        (candidate) => candidate.connectorId === manifest.id && candidate.stream === stream.id,
      );
      assert.ok(contract);
      const records = fixtureRecords(manifest, fixture, stream);
      assert.ok(records.length >= 1, `${manifest.id}.${stream.id} has no sanitized fixture record`);
      for (const fields of records) {
        const supportedFields = new Set(contract.fields.map((field) => field.sourceField));
        const stagedFields = Object.fromEntries(
          Object.entries(fields).filter(([field]) => supportedFields.has(field)),
        );
        const result = projectStagingFields(
          contract,
          projectSourceRecord({ schemaVersion: manifest.packVersion, fields: stagedFields }),
        );
        assert.deepEqual(result.issues, [], `${manifest.id}.${stream.id} failed typed projection`);
        assert.equal(Object.keys(result.values).length, contract.fields.length);
        projectedRecords += 1;
      }
    }
  }
  assert.ok(projectedRecords >= streamCount(recordedManifests));
});

test("typed staging rejects drift, invalid values, dates, and JSON shapes, and rounds lossy decimals", () => {
  const contracts = buildStagingContracts(manifests);
  const sales = contracts.find(
    (contract) => contract.connectorId === "lightspeed-r" && contract.stream === "ls_sales",
  );
  assert.ok(sales);
  const salesResult = projectStagingFields(
    sales,
    projectSourceRecord({
      schemaVersion: lightspeedRManifest.packVersion,
      fields: {
        saleID: "601",
        total: "not-a-number",
        undocumentedField: "drift",
      },
    }),
  );
  assert.deepEqual(
    salesResult.issues.map((issue) => [issue.code, issue.path]),
    [
      ["schema_drift", "undocumentedField"],
      ["normalization_invalid", "total"],
    ],
  );

  // Decimals with more than four fractional digits are half-up rounded into
  // numeric(19,4) rather than quarantined, so Lightspeed averages can land.
  const lossyResult = projectStagingFields(
    sales,
    projectSourceRecord({
      schemaVersion: lightspeedRManifest.packVersion,
      fields: { saleID: "601", total: "1.23456" },
    }),
  );
  assert.deepEqual(lossyResult.issues, []);
  assert.equal(lossyResult.values["total"], "1.2346");

  const items = contracts.find(
    (contract) => contract.connectorId === "lightspeed-r" && contract.stream === "ls_items",
  );
  assert.ok(items);
  const itemResult = projectStagingFields(
    items,
    projectSourceRecord({
      schemaVersion: lightspeedRManifest.packVersion,
      fields: { itemID: "401", TaxClass: "not-an-object" },
    }),
  );
  assert.deepEqual(
    itemResult.issues.map((issue) => [issue.code, issue.path]),
    [["normalization_invalid", "TaxClass"]],
  );

  const shipments = contracts.find(
    (contract) => contract.connectorId === "lightspeed-r" && contract.stream === "ls_order_shipments",
  );
  assert.ok(shipments);
  const shipmentResult = projectStagingFields(
    shipments,
    projectSourceRecord({
      schemaVersion: lightspeedRManifest.packVersion,
      fields: { orderShipmentID: "901", paymentDueDate: "2026-02-30" },
    }),
  );
  assert.deepEqual(
    shipmentResult.issues.map((issue) => [issue.code, issue.path]),
    [["normalization_invalid", "paymentDueDate"]],
  );

  // The Xero pack is mid-rebuild; this assertion holds against the widened
  // xero_invoices stream today. Scope it down to Lightspeed (covered above)
  // if the rebuild renames the stream before its recording lands.
  const invoices = contracts.find(
    (contract) => contract.connectorId === "xero" && contract.stream === "xero_invoices",
  );
  assert.ok(invoices);
  const invoiceResult = projectStagingFields(
    invoices,
    projectSourceRecord({
      schemaVersion: "1.0.0",
      fields: { InvoiceID: "invoice-1", Date: "2026-02-30" },
    }),
  );
  assert.deepEqual(invoiceResult.issues.map((issue) => issue.path), ["Date"]);
});

class RecordingDatabase implements TransactionalPostgres {
  readonly calls: Array<Readonly<{ sql: string; values: readonly unknown[] }>> = [];

  constructor(
    private readonly reconciliationFenceMatches = false,
    private readonly quarantineResolutionMatches = false,
  ) {}

  async transaction<T>(work: (client: RecordingDatabase) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<Readonly<{ rows: readonly Row[] }>> {
    this.calls.push({ sql, values });
    if (/select 1 from ingestion\.source_records source/iu.test(sql)) {
      const rows: readonly Record<string, unknown>[] = this.reconciliationFenceMatches
        ? [{ matched: true }]
        : [];
      // A Postgres client resolves the caller-selected structural row type at
      // runtime. Keep the fixture value unknown at that boundary instead of
      // pretending the concrete mock row is assignable to every possible Row.
      return { rows: rows as unknown as readonly Row[] };
    }
    if (/update ingestion\.quarantine_records/iu.test(sql)) {
      const rows: readonly Record<string, unknown>[] = this.quarantineResolutionMatches
        ? [{ source_object_type: values[3], source_record_id: values[5] }]
        : [];
      return { rows: rows as unknown as readonly Row[] };
    }
    return { rows: [] };
  }
}

function jobAndManifest(): Readonly<{ job: SyncJob; manifest: RawBatchManifest }> {
  const connectionId = ulid();
  const syncRunId = ulid();
  const batchId = ulid();
  const job: SyncJob = {
    schemaVersion: 1,
    type: "IncrementalSync",
    tenantId: "tenant-typed-staging",
    connectionId,
    connectionGeneration: 1,
    connectorId: "lightspeed-r",
    externalAccountReference: "account-101",
    syncRunId,
    batchId,
    requestedAt: "2026-08-03T00:00:00.000Z",
    stream: "ls_sales",
    reason: "schedule",
  };
  const manifest: RawBatchManifest = {
    tenantId: job.tenantId,
    connectionId,
    syncRunId,
    batchId,
    connectorKey: "lightspeed-r",
    connectorVersion: lightspeedRManifest.packVersion,
    apiVersion: lightspeedRManifest.apiVersion,
    externalAccountReference: job.externalAccountReference,
    stream: "ls_sales",
    extractedAt: "2026-08-03T00:00:00.000Z",
    cursorStart: null,
    cursorEnd: null,
    contentHash: "b".repeat(64),
    schemaFingerprint: "c".repeat(64),
    recordCount: 1,
    compressedBytes: 256,
    objectKeys: ["raw/tenant/batch.jsonl.gz"],
  };
  return { job, manifest };
}

test("landing atomically writes the generic lineage seam and physical typed stream table", async () => {
  const db = new RecordingDatabase();
  const store = new AnalyticalLandingStore(db, "lightspeed-r/2.0.0");
  const { job, manifest } = jobAndManifest();
  const result = await store.land(job, manifest, [{
    sourceObjectType: "Sale",
    sourceRecordId: "601",
    sourceUpdatedAt: "2026-08-03T00:00:00.000Z",
    payload: { privateRawOnlyValue: "must-not-land" },
    normalized: projectSourceRecord({
      schemaVersion: lightspeedRManifest.packVersion,
      fields: {
        saleID: "601",
        shopID: "101",
        total: "1499.0000",
        timeStamp: "2026-08-03T00:00:00.000Z",
        completed: "true",
      },
    }),
    payloadHash: "a".repeat(64),
  }]);

  assert.equal(result.stagedRecordCount, 1);
  assert.deepEqual(result.quarantined, []);
  assert.deepEqual(result.resolved, []);
  assert.ok(db.calls.some((call) => /insert into ingestion\.source_records/iu.test(call.sql)));
  const typedInsert = db.calls.find(
    (call) => /insert into "source_lightspeed"\."ls_sales"/iu.test(call.sql),
  );
  assert.ok(typedInsert);
  assert.match(typedInsert.sql, /"total"/u);
  assert.match(typedInsert.sql, /\$\d+::numeric\(19,4\)/u);
  assert.doesNotMatch(JSON.stringify(db.calls.map((call) => call.values)), /must-not-land/u);
});

test("malformed normalized rows are quarantined before either staging table is written", async () => {
  const db = new RecordingDatabase();
  const store = new AnalyticalLandingStore(db, "lightspeed-r/2.0.0");
  const { job, manifest } = jobAndManifest();
  const result = await store.land(job, manifest, [{
    sourceObjectType: "Sale",
    sourceRecordId: "602",
    payload: { saleID: "602", total: "not-a-number" },
    normalized: projectSourceRecord({
      schemaVersion: lightspeedRManifest.packVersion,
      fields: { saleID: "602", total: "not-a-number" },
    }),
    payloadHash: "d".repeat(64),
  }]);

  assert.equal(result.stagedRecordCount, 0);
  assert.deepEqual(result.quarantined.map((issue) => [issue.code, issue.path]), [
    ["normalization_invalid", "total"],
  ]);
  assert.ok(db.calls.some((call) => /insert into ingestion\.quarantine_records/iu.test(call.sql)));
  assert.ok(!db.calls.some((call) => /insert into ingestion\.source_records/iu.test(call.sql)));
  assert.ok(!db.calls.some((call) => /insert into "source_lightspeed"\."ls_sales"/iu.test(call.sql)));
});

test("a corrected valid replay resolves its prior analytical quarantine identity", async () => {
  const db = new RecordingDatabase(false,true);
  const store = new AnalyticalLandingStore(db,"lightspeed-r/2.0.0");
  const {job,manifest}=jobAndManifest();
  const result = await store.land(job,manifest,[{
    sourceObjectType:"Sale",
    sourceRecordId:"603",
    sourceUpdatedAt:"2026-08-03T00:00:00.000Z",
    payload:{saleID:"603",total:"10.0000"},
    normalized:projectSourceRecord({
      schemaVersion:lightspeedRManifest.packVersion,
      fields:{saleID:"603",shopID:"101",total:"10.0000"},
    }),
    payloadHash:"f".repeat(64),
  }]);

  assert.deepEqual(result.resolved,[{
    sourceObjectType:"Sale",
    sourceRecordId:"603",
  }]);
  const resolution = db.calls.find((call) => /update ingestion\.quarantine_records/iu.test(call.sql));
  assert.ok(resolution);
  assert.match(resolution.sql,/status='resolved'/iu);
  assert.match(resolution.sql,/replayed_in_sync_run_id=\$5/iu);
  assert.match(resolution.sql,/status='open'/iu);
});

test("a duplicate identity with any invalid replay row cannot resolve quarantine", async () => {
  const db = new RecordingDatabase(false,true);
  const store = new AnalyticalLandingStore(db,"lightspeed-r/2.0.0");
  const {job,manifest}=jobAndManifest();
  const valid = {
    sourceObjectType:"Sale",
    sourceRecordId:"604",
    payload:{saleID:"604",total:"10.0000"},
    normalized:projectSourceRecord({
      schemaVersion:lightspeedRManifest.packVersion,
      fields:{saleID:"604",shopID:"101",total:"10.0000"},
    }),
    payloadHash:"a".repeat(64),
  };
  const invalid = {
    ...valid,
    normalized:projectSourceRecord({
      schemaVersion:lightspeedRManifest.packVersion,
      fields:{saleID:"604",shopID:"101",total:"not-a-number"},
    }),
    payloadHash:"b".repeat(64),
  };

  const result=await store.land(job,manifest,[valid,invalid]);

  assert.equal(result.resolved.length,0);
  assert.equal(db.calls.some((call) => /update ingestion\.quarantine_records/iu.test(call.sql)),false);
});

test("reconciliation tombstones compare-and-swap the selected source version before staging", async () => {
  const { job: baseJob, manifest } = jobAndManifest();
  const job: SyncJob = {
    schemaVersion: 1,
    type: "ReconciliationSweep",
    tenantId: baseJob.tenantId,
    connectionId: baseJob.connectionId,
    connectionGeneration: 1,
    connectorId: "lightspeed-r",
    externalAccountReference: baseJob.externalAccountReference,
    syncRunId: baseJob.syncRunId,
    batchId: baseJob.batchId,
    requestedAt: "2026-08-03T00:00:00.000Z",
    reconciliationSweepId: ulid(),
    phase: "apply_tombstones",
    stream: "ls_sales",
    lookbackFrom: "2026-07-27T00:00:00.000Z",
    lookbackTo: "2026-08-03T00:00:00.000Z",
  };
  const record = {
    sourceObjectType: "Sale",
    sourceRecordId: "605",
    sourceUpdatedAt: "2026-08-03T00:00:00.000Z",
    payload: { kind: "albert_reconciliation_tombstone" },
    normalized: projectSourceRecord({
      schemaVersion: lightspeedRManifest.packVersion,
      fields: { saleID: "605", total: "10.0000" },
      tombstone: true,
    }),
    deletionSignal: {
      kind: "reconciliation_tombstone" as const,
      reconciliationSweepId: job.reconciliationSweepId,
      evidenceBatchIds: [ulid(),ulid()],
      expectedPayloadHash: "f".repeat(64),
      expectedSourceUpdatedAt: "2026-08-02T00:00:00.000Z",
      expectedIngestedAt: "2026-08-02T01:00:00.000Z",
    },
    payloadHash: "e".repeat(64),
  };

  const matched = new RecordingDatabase(true);
  await new AnalyticalLandingStore(matched,"lightspeed-r/2.0.0").land(
    job,manifest,[record],
  );
  const fenceIndex = matched.calls.findIndex((call) =>
    /select 1 from ingestion\.source_records source/iu.test(call.sql)
  );
  const sourceWriteIndex = matched.calls.findIndex((call) =>
    /insert into ingestion\.source_records/iu.test(call.sql)
  );
  assert.ok(fenceIndex >= 0 && sourceWriteIndex > fenceIndex);
  assert.match(matched.calls[fenceIndex]!.sql,/for update/iu);

  const changed = new RecordingDatabase(false);
  await assert.rejects(
    new AnalyticalLandingStore(changed,"lightspeed-r/2.0.0").land(job,manifest,[record]),
    /reconciliation_source_version_changed/iu,
  );
  assert.equal(changed.calls.some((call) =>
    /insert into ingestion\.source_records/iu.test(call.sql)
  ),false);
  assert.equal(changed.calls.some((call) =>
    /insert into "source_lightspeed"\."ls_sales"/iu.test(call.sql)
  ),false);
});
