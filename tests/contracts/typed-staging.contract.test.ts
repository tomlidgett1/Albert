import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.equal(contracts.length, 30);
  assert.equal(manifests.reduce((count, manifest) => count + manifest.fieldCoverage.length, 0), 546);
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

  const generated = renderTypedStagingMigration(manifests);
  const committed = readFileSync(
    new URL("../../infra/migrations/analytical/0005_m3_typed_connector_staging.sql", import.meta.url),
    "utf8",
  );
  assert.equal(committed, generated, "Run npm run generate:connector-staging after manifest changes");
  assert.equal(generated.match(/^CREATE TABLE IF NOT EXISTS/gmu)?.length, 30);
  assert.equal(generated.match(/ENABLE ROW LEVEL SECURITY;/gu)?.length, 30);
  assert.equal(generated.match(/^CREATE POLICY tenant_scope/gmu)?.length, 30);
  assert.doesNotMatch(generated, /raw_payload|access_token|refresh_token/iu);
  assert.doesNotMatch(generated, /dp_meta_data/iu, "unsupported fields remain in immutable raw storage only");
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
  assert.equal(projectedRecords, 30);
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

  async transaction<T>(work: (client: RecordingDatabase) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<Readonly<{ rows: readonly Row[] }>> {
    this.calls.push({ sql, values });
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
  const store = new AnalyticalLandingStore(db, "lightspeed-r/1.0.0");
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
  const store = new AnalyticalLandingStore(db, "lightspeed-r/1.0.0");
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
