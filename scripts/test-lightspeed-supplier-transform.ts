import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ulid } from "ulid";

import { mapDeputyCanonical } from "../connectors/deputy/canonical.js";
import { mapSquareCanonical } from "../connectors/square/canonical.js";
import { mapShopifyCanonical } from "../connectors/shopify/canonical.js";
import { mapStripeCanonical } from "../connectors/stripe/canonical.js";
import { mapMomenceCanonical } from "../connectors/momence/canonical.js";
import { mapMetaAdsCanonical } from "../connectors/meta-ads/canonical.js";
import { mapGoogleAdsCanonical } from "../connectors/google-ads/canonical.js";
import { mapLightspeedCanonical } from "../connectors/lightspeed-r/canonical.js";
import { lightspeedRManifest } from "../connectors/lightspeed-r/manifest.js";
import { mapXeroCanonical } from "../connectors/xero/canonical.js";
import {
  hashPayload,
  projectSourceRecord,
  type ConnectorStream,
  type RawSourceRecord,
} from "../packages/connector-sdk/src/index.js";
import type { PostgresQueryClient, SyncJob } from "../packages/queue/src/index.js";
import type { RawBatchManifest } from "../packages/storage/src/index.js";
import type {
  CanonicalTransformBatch,
} from "../services/sync-workers/src/canonical-contract.js";
import { CanonicalTransformPipeline } from "../services/sync-workers/src/canonical-pipeline.js";
import type { TransactionalPostgres } from "../services/sync-workers/src/database.js";
import { AnalyticalLandingStore } from "../services/sync-workers/src/analytical-store.js";
import { PgTransactionalDatabase } from "../services/sync-workers/src/postgres.js";

const MAPPING_VERSION = "lightspeed-supplier-proof-v1";
const REQUESTED_AT = "2026-08-04T00:00:00.000Z";
const EXTERNAL_ACCOUNT_REFERENCE = "101";

type Fixture = Readonly<{
  responses: Readonly<Record<string, unknown>>;
}>;

type FixtureBatch = Readonly<{
  stream: string;
  job: SyncJob;
  transform: CanonicalTransformBatch;
  manifest: RawBatchManifest;
  record: RawSourceRecord;
  domains: readonly string[];
}>;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required by the Lightspeed supplier transform proof.`);
  return value;
}

function localCiDatabaseUrl(): string {
  assert.equal(
    requiredEnvironment("ALBERT_LIGHTSPEED_SUPPLIER_TEST_MODE"),
    "ci",
    "The Lightspeed supplier transform proof is restricted to its disposable CI database.",
  );
  const value = requiredEnvironment("ANALYTICAL_ADMIN_DATABASE_URL");
  const parsed = new URL(value);
  assert.ok(
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost",
    "The Lightspeed supplier transform proof refuses a non-local database.",
  );
  assert.equal(
    parsed.pathname,
    "/albert_ci",
    "The Lightspeed supplier transform proof requires the disposable albert_ci database.",
  );
  return value;
}

function queryRows<Row extends Record<string, unknown>>(
  rows: readonly Record<string, unknown>[],
): Readonly<{ rows: readonly Row[] }> {
  return { rows: rows as unknown as readonly Row[] };
}

/**
 * `publishControl=false` leaves mapping context as the pipeline's only control-
 * plane dependency. This strict fake keeps the proof on one disposable
 * analytical database while failing if the transform gains another hidden
 * control-plane dependency.
 */
class MappingContextDatabase implements TransactionalPostgres {
  private tenantId: string | null = null;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<Readonly<{ rows: readonly Row[] }>> {
    if (/set local role albert_transform_control/iu.test(sql)) {
      return queryRows<Row>([]);
    }
    if (/select current_user as role_name/iu.test(sql)) {
      return queryRows<Row>([{ role_name: "albert_transform_control" }]);
    }
    if (/set_config\('albert\.tenant_id'/iu.test(sql)) {
      this.tenantId = String(values[0] ?? "");
      return queryRows<Row>([{ set_config: this.tenantId }]);
    }
    if (/current_setting\('albert\.tenant_id'/iu.test(sql)) {
      return queryRows<Row>([{ tenant_scope: this.tenantId }]);
    }
    if (/from control_plane\.connections as connection/iu.test(sql)) {
      assert.equal(values[0], this.tenantId);
      assert.equal(values[2], "lightspeed-r");
      return queryRows<Row>([{
        timezone: "Australia/Melbourne",
        trading_day_cutoff: "00:00",
        base_currency: "AUD",
      }]);
    }
    throw new Error(`Unexpected control-plane query in supplier proof: ${sql.slice(0, 120)}`);
  }

  async transaction<T>(work: (client: PostgresQueryClient) => Promise<T>): Promise<T> {
    this.tenantId = null;
    try {
      return await work(this);
    } finally {
      this.tenantId = null;
    }
  }
}

function fixtureRecord(fixture: Fixture, streamId: string): Readonly<Record<string, unknown>> {
  const stream = lightspeedRManifest.streams.find((candidate) => candidate.id === streamId);
  assert.ok(stream, `Lightspeed fixture stream ${streamId} is not declared.`);
  const response = fixture.responses[streamId];
  assert.ok(response && typeof response === "object" && !Array.isArray(response));
  const candidate = (response as Readonly<Record<string, unknown>>)[stream.resource];
  const records = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
  assert.equal(records.length, 1, `Expected one ${stream.resource} fixture record.`);
  const record = records[0];
  assert.ok(record && typeof record === "object" && !Array.isArray(record));
  return record as Readonly<Record<string, unknown>>;
}

/**
 * A purchase-order line as the per-stream walk stages it: one flat row made of
 * the line's own OrderLine fields plus the parent context the projection
 * resolves from the walked Order header (vendor, destination shop, lifecycle,
 * currency; the 0125 additive columns). The Order header stream itself is a
 * lookup-only identity sweep.
 */
function purchaseOrderLineFields(fixture: Fixture): Readonly<Record<string, unknown>> {
  const line = fixtureRecord(fixture, "ls_purchase_order_lines");
  const order = fixtureRecord(fixture, "ls_purchase_orders");
  const parentContext: Record<string, unknown> = {};
  for (const field of [
    "vendorID", "shopID", "complete", "orderedDate", "receivedDate", "archived", "vendorCurrencyCode",
  ] as const) {
    if (order[field] !== undefined) parentContext[field] = order[field];
  }
  assert.ok(
    parentContext.vendorID,
    "The supplier proof requires a parent vendorID projected onto the order line.",
  );
  return { ...line, ...parentContext };
}

function sourceRecord(
  streamId: string,
  fields: Readonly<Record<string, unknown>>,
  schemaVersion = lightspeedRManifest.packVersion,
): RawSourceRecord {
  const stream = lightspeedRManifest.streams.find((candidate) => candidate.id === streamId);
  assert.ok(stream);
  const approved = new Set(
    lightspeedRManifest.fieldCoverage
      .filter((field) => field.stream === streamId && field.disposition !== "unsupported")
      .map((field) => field.field),
  );
  const projectedFields = Object.fromEntries(
    Object.entries(fields).filter(([field]) => approved.has(field)),
  );
  const rawId = fields[stream.recordIdField];
  assert.ok(typeof rawId === "string" || typeof rawId === "number");
  const rawUpdatedAt = stream.modifiedField ? fields[stream.modifiedField] : undefined;
  const sourceUpdatedAt = typeof rawUpdatedAt === "string" && Number.isFinite(Date.parse(rawUpdatedAt))
    ? new Date(rawUpdatedAt).toISOString()
    : undefined;
  const tombstone = fields.archived === true || fields.archived === 1 || fields.archived === "true";
  return {
    sourceObjectType: stream.resource,
    sourceRecordId: String(rawId),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    payload: fields,
    payloadHash: hashPayload(fields),
    normalized: projectSourceRecord({
      schemaVersion,
      fields: projectedFields,
      tombstone,
    }),
  };
}

function fixtureBatch(
  fixture: Fixture,
  tenantId: string,
  connectionId: string,
  streamId: string,
  options: Readonly<{
    schemaVersion?: string;
    connectorVersion?: string;
    connectionGeneration?: number;
    fields?: Readonly<Record<string, unknown>>;
  }> = {},
): FixtureBatch {
  const stream = lightspeedRManifest.streams.find((candidate) => candidate.id === streamId);
  assert.ok(stream);
  const batchId = ulid();
  const syncRunId = ulid();
  const record = sourceRecord(
    streamId,
    options.fields ?? fixtureRecord(fixture, streamId),
    options.schemaVersion ?? lightspeedRManifest.packVersion,
  );
  const job: SyncJob = {
    schemaVersion: 1,
    type: "IncrementalSync",
    tenantId,
    connectionId,
    connectionGeneration: options.connectionGeneration ?? 1,
    connectorId: "lightspeed-r",
    externalAccountReference: EXTERNAL_ACCOUNT_REFERENCE,
    syncRunId,
    batchId,
    requestedAt: REQUESTED_AT,
    stream: streamId,
    reason: "manual",
  };
  return {
    stream: streamId,
    job,
    transform: {
      tenantId,
      batchId,
      syncRunId,
      connectionId,
      connectionGeneration:options.connectionGeneration ?? 1,
      connectorId: "lightspeed-r",
      mappingVersion: MAPPING_VERSION,
    },
    manifest: {
      tenantId,
      connectionId,
      syncRunId,
      batchId,
      connectorKey: "lightspeed-r",
      connectorVersion: options.connectorVersion ?? lightspeedRManifest.packVersion,
      apiVersion: lightspeedRManifest.apiVersion,
      externalAccountReference: EXTERNAL_ACCOUNT_REFERENCE,
      stream: streamId,
      extractedAt: REQUESTED_AT,
      cursorStart: null,
      cursorEnd: null,
      contentHash: hashPayload(record.payload),
      schemaFingerprint: hashPayload(
        lightspeedRManifest.fieldCoverage
          .filter((field) => field.stream === streamId)
          .map((field) => [field.field, field.disposition, field.stagingType]),
      ),
      recordCount: 1,
      compressedBytes: Buffer.byteLength(JSON.stringify(record.payload)),
      objectKeys: [
        `tenant/${tenantId}/connection/${connectionId}/stream/${streamId}/date/2026-08-04/batch-${batchId}.jsonl.gz`,
      ],
    },
    record,
    domains: stream.productDomains,
  };
}

async function scalarCount(
  database: PgTransactionalDatabase,
  sql: string,
  tenantId: string,
): Promise<number> {
  const result = await database.query<{ row_count: string }>(sql, [tenantId]);
  return Number(result.rows[0]?.row_count ?? 0);
}

async function run(): Promise<void> {
  const database = new PgTransactionalDatabase(localCiDatabaseUrl(), {
    applicationName: "albert-ci-lightspeed-supplier-proof",
    maxConnections: 2,
  });
  try {
    const fixture = JSON.parse(await readFile(
      new URL("../connectors/lightspeed-r/fixtures/sanitized-recording.json", import.meta.url),
      "utf8",
    )) as Fixture;
    const tenantId = ulid();
    const connectionId = ulid();
    const landing = new AnalyticalLandingStore(database, MAPPING_VERSION);
    const pipeline = new CanonicalTransformPipeline(
      database,
      new MappingContextDatabase(),
      MAPPING_VERSION,
      {
        "lightspeed-r": mapLightspeedCanonical,
        xero: mapXeroCanonical,
        deputy: mapDeputyCanonical,
        square: mapSquareCanonical,
        "shopify": mapShopifyCanonical,
        "stripe": mapStripeCanonical,
        "momence": mapMomenceCanonical,
        "meta-ads": mapMetaAdsCanonical,
        "google-ads": mapGoogleAdsCanonical,
      },
      () => new Date(REQUESTED_AT),
    );
    const batches = new Map(
      [
        "ls_shops", "ls_categories", "ls_items", "ls_vendors",
        "ls_purchase_orders", "ls_purchase_order_lines",
      ].map((stream) => {
        // The purchase-order-line batch models the pack-1.0 legacy lineage the
        // replay lane repairs; its rows are flat and carry the parent context
        // the walk projects from the Order header.
        const batch = fixtureBatch(
          fixture,
          tenantId,
          connectionId,
          stream,
          stream === "ls_purchase_order_lines"
            ? {
                schemaVersion: "1.0.0",
                connectorVersion: "1.0.0",
                fields: purchaseOrderLineFields(fixture),
              }
            : {},
        );
        return [stream, batch] as const;
      }),
    );

    const registrationJob = batches.get("ls_shops")?.job;
    assert.ok(registrationJob);
    const registrationStreams: readonly ConnectorStream[] = lightspeedRManifest.streams.map(
      (stream) => ({
        id: stream.id,
        label: stream.resource,
        domains: stream.productDomains,
        cursorKind: stream.modifiedField ? "high_water_mark" : "none",
        backfillStrategy: stream.backfillStrategy,
        lateEditStrategy: stream.lateEditStrategy,
        deletionStrategy: stream.deletionStrategy,
        sourceTotalStrategy: stream.sourceTotalStrategy,
        availability: stream.availability ?? "required",
        dependencies: stream.dependencies,
        productDomains: stream.productDomains,
      }),
    );
    assert.equal(
      await landing.registerConnectorStreams({
        job: registrationJob,
        streams: registrationStreams,
      }),
      registrationStreams.length,
      "The disposable proof must register the same stream policy as the real worker before publishing page evidence.",
    );

    for (const batch of batches.values()) {
      const result = await landing.land(batch.job, batch.manifest, [batch.record]);
      assert.equal(result.stagedRecordCount, 1, `${batch.stream} did not reach typed staging.`);
      assert.deepEqual(result.quarantined, [], `${batch.stream} fixture was quarantined.`);
      await landing.recordConnectorStreamPage({
        job: batch.job,
        stream: batch.stream,
        records: [batch.record],
        landing: result,
        hasMore: false,
        nextCursorPresent: false,
        backfillComplete: false,
        coverage: null,
      });
    }

    for (const stream of ["ls_shops", "ls_categories", "ls_items"] as const) {
      const batch = batches.get(stream);
      assert.ok(batch);
      await pipeline.transformBatch(batch.transform, stream, batch.domains, false, false);
    }

    // The Order header stream is a lookup-only identity sweep: it transforms
    // before any supplier exists and must never materialise a purchase-order
    // line of its own.
    const orderHeader = batches.get("ls_purchase_orders");
    assert.ok(orderHeader);
    await pipeline.transformBatch(
      orderHeader.transform,
      orderHeader.stream,
      orderHeader.domains,
      false,
      false,
    );
    assert.equal(
      await scalarCount(
        database,
        "select count(*)::text as row_count from core.purchase_order_line where tenant_id=$1",
        tenantId,
      ),
      0,
      "The lookup-only Order header stream must not materialise purchase-order lines.",
    );

    const orderLines = batches.get("ls_purchase_order_lines");
    assert.ok(orderLines);
    const unresolvedOrderLine = await pipeline.transformBatch(
      orderLines.transform,
      orderLines.stream,
      orderLines.domains,
      false,
      false,
    );
    assert.equal(
      unresolvedOrderLine.quarantinedRows,
      1,
      "A present projected vendor_id must be quarantined instead of degrading to a null supplier foreign key.",
    );
    const unresolvedReference = await database.query<{
      error_code: string;
      error_path: string | null;
      status: string;
    }>(
      `select error_code,error_path,status
         from ingestion.quarantine_records
        where tenant_id=$1 and payload_batch_id=$2
        order by quarantine_id`,
      [tenantId, orderLines.job.batchId],
    );
    assert.deepEqual(unresolvedReference.rows, [{
      error_code: "canonical.canonical_reference_missing",
      error_path: "$projection",
      status: "open",
    }]);
    assert.equal(
      await scalarCount(
        database,
        "select count(*)::text as row_count from core.purchase_order_line where tenant_id=$1",
        tenantId,
      ),
      0,
      "The failed supplier resolution must roll back the purchase-order projection.",
    );

    const vendor = batches.get("ls_vendors");
    assert.ok(vendor);
    await pipeline.transformBatch(vendor.transform, vendor.stream, vendor.domains, false, false);

    assert.equal(
      await scalarCount(
        database,
        "select count(*)::text as row_count from core.purchase_order_line where tenant_id=$1",
        tenantId,
      ),
      0,
      "Vendor materialisation alone must not replay an order line before current-generation reconciliation.",
    );

    const orderLineRetry = fixtureBatch(
      fixture,
      tenantId,
      connectionId,
      "ls_purchase_order_lines",
      { fields: purchaseOrderLineFields(fixture) },
    );
    const retryLanding = await landing.land(
      orderLineRetry.job,
      orderLineRetry.manifest,
      [orderLineRetry.record],
    );
    assert.equal(retryLanding.stagedRecordCount, 1);
    assert.deepEqual(retryLanding.quarantined, []);
    await landing.recordConnectorStreamPage({
      job: orderLineRetry.job,
      stream: orderLineRetry.stream,
      records: [orderLineRetry.record],
      landing: retryLanding,
      hasMore: false,
      nextCursorPresent: false,
      backfillComplete: false,
      coverage: null,
    });
    const retryResult = await pipeline.transformBatch(
      orderLineRetry.transform,
      orderLineRetry.stream,
      orderLineRetry.domains,
      false,
      false,
    );
    assert.equal(retryResult.quarantinedRows, 0);

    const resolved = await database.query<{
      supplier_id: string;
      supplier_name: string;
      source_object_type: string;
      source_record_id: string;
      match_status: string;
    }>(
      `select line.supplier_id,supplier.name as supplier_name,
              link.source_object_type,link.source_record_id,link.match_status
         from core.purchase_order_line as line
         join core.supplier as supplier
           on supplier.tenant_id=line.tenant_id and supplier.id=line.supplier_id
         join core.entity_source_link as link
           on link.tenant_id=supplier.tenant_id
          and link.entity_type='supplier'
          and link.canonical_entity_id=supplier.id
          and link.connection_id=$2
          and link.valid_to is null
        where line.tenant_id=$1`,
      [tenantId, connectionId],
    );
    assert.deepEqual(resolved.rows, [{
      supplier_id: resolved.rows[0]?.supplier_id,
      supplier_name: "Example Cycle Supply",
      source_object_type: "Vendor",
      source_record_id: "802",
      match_status: "accepted",
    }]);
    assert.ok(resolved.rows[0]?.supplier_id, "The purchase-order supplier_id is required by this proof.");
    const healedReference = await database.query<{
      error_code: string;
      error_path: string | null;
      status: string;
      resolution_reason: string | null;
    }>(
      `select error_code,error_path,status,resolution_reason
         from ingestion.quarantine_records
        where tenant_id=$1 and payload_batch_id=$2
        order by quarantine_id`,
      [tenantId, orderLines.job.batchId],
    );
    assert.deepEqual(healedReference.rows, [{
      error_code: "canonical.canonical_reference_missing",
      error_path: "$projection",
      status: "resolved",
      resolution_reason: "canonical_projection_recovered",
    }]);
    process.stdout.write(
      "Lightspeed supplier reference quarantine and current-pack replay proof passed.\n",
    );
  } finally {
    await database.close();
  }
}

await run();
