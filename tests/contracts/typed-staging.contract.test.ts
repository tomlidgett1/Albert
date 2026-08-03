import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  renderTypedStagingMigration,
  type ConnectorManifest,
} from "../../packages/connector-sdk/src/index.js";
import type { SyncJob } from "../../packages/queue/src/index.js";
import type { RawBatchManifest } from "../../packages/storage/src/index.js";
import {
  createConnectorStagingMigration,
  parseConnectorStagingMigrationOptions,
} from "../../scripts/generate-connector-staging.js";
import { AnalyticalLandingStore } from "../../services/sync-workers/src/analytical-store.js";
import type { TransactionalPostgres } from "../../services/sync-workers/src/database.js";

const manifests = [lightspeedRManifest, xeroManifest, deputyManifest] as const;

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
  return (Array.isArray(candidate) ? candidate : [candidate]) as readonly Readonly<Record<string, unknown>>[];
}

test("typed staging migration is generated exactly from every connector field contract", () => {
  const contracts = buildStagingContracts(manifests);
  assert.equal(contracts.length, 31);
  assert.equal(manifests.reduce((count, manifest) => count + manifest.fieldCoverage.length, 0), 757);
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

  const baseline = readFileSync(
    new URL("../../infra/migrations/analytical/0005_m3_typed_connector_staging.sql", import.meta.url),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(baseline).digest("hex"),
    "089c94db4e3f496db70670e54b13d34d754ed3341a6b3ba284cd9eb5c1aaca36",
    "migration 0005 is an immutable applied baseline",
  );
  const vendorManifest: ConnectorManifest = {
    ...lightspeedRManifest,
    streams: lightspeedRManifest.streams.filter((stream) => stream.id === "vendors"),
    fieldCoverage: lightspeedRManifest.fieldCoverage.filter((field) => field.stream === "vendors"),
  };
  const expectedVendorMigration = renderTypedStagingMigration([vendorManifest]);
  const additive = readFileSync(
    new URL("../../infra/migrations/analytical/0093_m3_lightspeed_vendor_staging.sql", import.meta.url),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(additive).digest("hex"),
    "cbacd269f4141de553693476eddaefb5783fc52717b42712cd36b366a23ee0e9",
    "migration 0093 is an immutable applied baseline",
  );
  assert.equal(
    additive,
    expectedVendorMigration,
    "Vendor contract changed: create a new additive migration and extend this migration-set test; never rewrite migration 0093",
  );
  const migrationSet = `${baseline}\n${additive}`;
  assert.equal(baseline.match(/^CREATE TABLE IF NOT EXISTS/gmu)?.length, 30);
  assert.equal(additive.match(/^CREATE TABLE IF NOT EXISTS/gmu)?.length, 1);
  assert.equal(migrationSet.match(/^CREATE TABLE IF NOT EXISTS/gmu)?.length, 31);
  assert.equal(migrationSet.match(/ENABLE ROW LEVEL SECURITY;/gu)?.length, 31);
  assert.equal(migrationSet.match(/^CREATE POLICY tenant_scope/gmu)?.length, 31);
  assert.doesNotMatch(migrationSet, /raw_payload|access_token|refresh_token/iu);
  assert.doesNotMatch(migrationSet, /dp_meta_data/iu, "unsupported fields remain in immutable raw storage only");
});

test("typed staging generator allocates a new migration and refuses to regenerate a stream", async (context) => {
  const migrationsDirectory = await mkdtemp(join(tmpdir(), "albert-staging-generator-"));
  context.after(async () => rm(migrationsDirectory, { recursive: true, force: true }));
  const priorPath = join(migrationsDirectory, "0094_m5_existing.sql");
  const priorSql = "BEGIN;\n-- immutable prior migration\nCOMMIT;\n";
  await writeFile(priorPath, priorSql, "utf8");

  const createdPath = await createConnectorStagingMigration({
    connector: "lightspeed-r",
    stream: "vendors",
    name: "new_vendor_stream",
    migrationsDirectory,
  });
  assert.equal(createdPath, join(migrationsDirectory, "0095_m3_new_vendor_stream.sql"));
  assert.match(
    await readFile(createdPath, "utf8"),
    /CREATE TABLE IF NOT EXISTS "source_lightspeed"\."vendors"/u,
  );
  assert.equal(await readFile(priorPath, "utf8"), priorSql);

  await assert.rejects(
    createConnectorStagingMigration({
      connector: "lightspeed-r",
      stream: "vendors",
      name: "duplicate_vendor_stream",
      migrationsDirectory,
    }),
    /already exists.*never rewrite or regenerate an applied migration/iu,
  );
  assert.throws(
    () => parseConnectorStagingMigrationOptions(["--connector", "lightspeed-r", "--stream", "vendors"]),
    /Usage:/u,
  );
});

test("all approved fields in sanitized vendor recordings project into typed columns", () => {
  const fixtures = new Map([
    ["lightspeed-r", readFixture("../../connectors/lightspeed-r/fixtures/sanitized-recording.json")],
    ["xero", readFixture("../../connectors/xero/fixtures/sanitized-recording.json")],
    ["deputy", readFixture("../../connectors/deputy/fixtures/sanitized-recording.json")],
  ]);
  const contracts = buildStagingContracts(manifests);
  let projectedRecords = 0;
  for (const manifest of manifests) {
    const fixture = fixtures.get(manifest.id);
    assert.ok(fixture);
    for (const stream of manifest.streams) {
      const contract = contracts.find(
        (candidate) => candidate.connectorId === manifest.id && candidate.stream === stream.id,
      );
      assert.ok(contract);
      for (const fields of fixtureRecords(manifest, fixture, stream)) {
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
  assert.equal(projectedRecords, 31);
});

test("typed staging rejects drift, lossy decimals, invalid dates, and wrong JSON shapes", () => {
  const contracts = buildStagingContracts(manifests);
  const sales = contracts.find(
    (contract) => contract.connectorId === "lightspeed-r" && contract.stream === "sales",
  );
  assert.ok(sales);
  const salesResult = projectStagingFields(
    sales,
    projectSourceRecord({
      schemaVersion: "1.0.0",
      fields: {
        saleID: "sale-1",
        total: "1.23456",
        SaleLines: "not-an-object",
        undocumentedField: "drift",
      },
    }),
  );
  assert.deepEqual(
    salesResult.issues.map((issue) => [issue.code, issue.path]),
    [
      ["schema_drift", "undocumentedField"],
      ["normalization_invalid", "total"],
      ["normalization_invalid", "SaleLines"],
    ],
  );

  const invoices = contracts.find(
    (contract) => contract.connectorId === "xero" && contract.stream === "invoices",
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
    stream: "sales",
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
    stream: "sales",
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
  const store = new AnalyticalLandingStore(db, "lightspeed-r/1.1.0");
  const { job, manifest } = jobAndManifest();
  const result = await store.land(job, manifest, [{
    sourceObjectType: "Sale",
    sourceRecordId: "sale-1",
    sourceUpdatedAt: "2026-08-03T00:00:00.000Z",
    payload: { privateRawOnlyValue: "must-not-land" },
    normalized: projectSourceRecord({
      schemaVersion: "1.0.0",
      fields: {
        saleID: "sale-1",
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
    (call) => /insert into "source_lightspeed"\."sales"/iu.test(call.sql),
  );
  assert.ok(typedInsert);
  assert.match(typedInsert.sql, /"total"/u);
  assert.match(typedInsert.sql, /\$\d+::numeric\(19,4\)/u);
  assert.doesNotMatch(JSON.stringify(db.calls.map((call) => call.values)), /must-not-land/u);
});

test("malformed normalized rows are quarantined before either staging table is written", async () => {
  const db = new RecordingDatabase();
  const store = new AnalyticalLandingStore(db, "lightspeed-r/1.1.0");
  const { job, manifest } = jobAndManifest();
  const result = await store.land(job, manifest, [{
    sourceObjectType: "Sale",
    sourceRecordId: "sale-invalid",
    payload: { saleID: "sale-invalid", total: "1.23456" },
    normalized: projectSourceRecord({
      schemaVersion: "1.0.0",
      fields: { saleID: "sale-invalid", total: "1.23456" },
    }),
    payloadHash: "d".repeat(64),
  }]);

  assert.equal(result.stagedRecordCount, 0);
  assert.deepEqual(result.quarantined.map((issue) => [issue.code, issue.path]), [
    ["normalization_invalid", "total"],
  ]);
  assert.ok(db.calls.some((call) => /insert into ingestion\.quarantine_records/iu.test(call.sql)));
  assert.ok(!db.calls.some((call) => /insert into ingestion\.source_records/iu.test(call.sql)));
  assert.ok(!db.calls.some((call) => /insert into "source_lightspeed"\."sales"/iu.test(call.sql)));
});

test("a corrected valid replay resolves its prior analytical quarantine identity", async () => {
  const db = new RecordingDatabase(false,true);
  const store = new AnalyticalLandingStore(db,"lightspeed-r/1.1.0");
  const {job,manifest}=jobAndManifest();
  const result = await store.land(job,manifest,[{
    sourceObjectType:"Sale",
    sourceRecordId:"sale-repaired",
    sourceUpdatedAt:"2026-08-03T00:00:00.000Z",
    payload:{saleID:"sale-repaired",total:"10.0000"},
    normalized:projectSourceRecord({
      schemaVersion:"1.0.0",
      fields:{saleID:"sale-repaired",shopID:"101",total:"10.0000"},
    }),
    payloadHash:"f".repeat(64),
  }]);

  assert.deepEqual(result.resolved,[{
    sourceObjectType:"Sale",
    sourceRecordId:"sale-repaired",
  }]);
  const resolution = db.calls.find((call) => /update ingestion\.quarantine_records/iu.test(call.sql));
  assert.ok(resolution);
  assert.match(resolution.sql,/status='resolved'/iu);
  assert.match(resolution.sql,/replayed_in_sync_run_id=\$5/iu);
  assert.match(resolution.sql,/status='open'/iu);
});

test("a duplicate identity with any invalid replay row cannot resolve quarantine", async () => {
  const db = new RecordingDatabase(false,true);
  const store = new AnalyticalLandingStore(db,"lightspeed-r/1.1.0");
  const {job,manifest}=jobAndManifest();
  const valid = {
    sourceObjectType:"Sale",
    sourceRecordId:"sale-duplicate",
    payload:{saleID:"sale-duplicate",total:"10.0000"},
    normalized:projectSourceRecord({
      schemaVersion:"1.0.0",
      fields:{saleID:"sale-duplicate",shopID:"101",total:"10.0000"},
    }),
    payloadHash:"a".repeat(64),
  };
  const invalid = {
    ...valid,
    normalized:projectSourceRecord({
      schemaVersion:"1.0.0",
      fields:{saleID:"sale-duplicate",shopID:"101",total:"1.23456"},
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
    stream: "sales",
    lookbackFrom: "2026-07-27T00:00:00.000Z",
    lookbackTo: "2026-08-03T00:00:00.000Z",
  };
  const record = {
    sourceObjectType: "Sale",
    sourceRecordId: "sale-deleted",
    sourceUpdatedAt: "2026-08-03T00:00:00.000Z",
    payload: { kind: "albert_reconciliation_tombstone" },
    normalized: projectSourceRecord({
      schemaVersion: "1.0.0",
      fields: { saleID: "sale-deleted", total: "10.0000" },
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
  await new AnalyticalLandingStore(matched,"lightspeed-r/1.1.0").land(
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
    new AnalyticalLandingStore(changed,"lightspeed-r/1.1.0").land(job,manifest,[record]),
    /reconciliation_source_version_changed/iu,
  );
  assert.equal(changed.calls.some((call) =>
    /insert into ingestion\.source_records/iu.test(call.sql)
  ),false);
  assert.equal(changed.calls.some((call) =>
    /insert into "source_lightspeed"\."sales"/iu.test(call.sql)
  ),false);
});
