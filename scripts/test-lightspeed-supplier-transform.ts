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
  makeNamespacedSourceKey,
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

function reconciliationRepairBatch(
  fixture: Fixture,
  tenantId: string,
  connectionId: string,
  connectionGeneration = 2,
): FixtureBatch {
  // The repair is a current-pack re-extraction of the vendor: it defaults to
  // the manifest's own pack version, in contrast to the pack-1.0 legacy
  // lineage the purchase-order-line batch models.
  const batch = fixtureBatch(fixture, tenantId, connectionId, "ls_vendors", {
    connectionGeneration,
  });
  const job: SyncJob = {
    schemaVersion: 1,
    type: "ReconciliationSweep",
    tenantId,
    connectionId,
    connectionGeneration,
    connectorId: "lightspeed-r",
    externalAccountReference: EXTERNAL_ACCOUNT_REFERENCE,
    syncRunId: batch.job.syncRunId,
    batchId: batch.job.batchId,
    requestedAt: REQUESTED_AT,
    reconciliationSweepId: ulid(),
    phase: "apply_tombstones",
    stream: "ls_vendors",
    lookbackFrom: "2025-07-01T00:00:00.000Z",
    lookbackTo: REQUESTED_AT,
  };
  return { ...batch, job };
}

async function establishCurrentReconciledRepairEvidence(
  database: PgTransactionalDatabase,
  tenantId: string,
  connectionId: string,
  repair: FixtureBatch,
): Promise<void> {
  const connectionGeneration = repair.job.connectionGeneration;
  await database.transaction(async (client) => {
    await client.query("select set_config('albert.tenant_id',$1,true)", [tenantId]);
    for (const streamId of ["ls_vendors", "ls_purchase_order_lines"] as const) {
      const stream = lightspeedRManifest.streams.find((candidate) => candidate.id === streamId);
      assert.ok(stream, `${streamId} is required by the supplier repair evidence.`);
      await client.query(
        `insert into quality.connector_stream_state (
           tenant_id,connection_id,connection_generation,connector_id,stream,required,
           late_edit_strategy,deletion_strategy,source_total_strategy,
           observed_page_count,cursor_chain_valid,cursor_complete,backfill_complete,
           reconciliation_completed_at,reconciliation_gap_count,
           unresolved_schema_drift_count,unresolved_enum_drift_count,
           unresolved_quarantine_count,last_page_at
         ) values (
           $1,$2,$3::bigint,'lightspeed-r',$4,true,
           $5,$6,$7,
           1,true,true,true,$8::timestamptz,0,0,0,0,$8::timestamptz
         )`,
        [
          tenantId,
          connectionId,
          connectionGeneration,
          streamId,
          stream.lateEditStrategy,
          stream.deletionStrategy,
          stream.sourceTotalStrategy,
          REQUESTED_AT,
        ],
      );
    }
    await client.query(
      `insert into quality.connector_stream_page_evidence (
         tenant_id,batch_id,connection_id,connection_generation,stream,evidence
       ) values ($1,$2,$3,$4::bigint,'ls_vendors',$5::jsonb)`,
      [tenantId, repair.job.batchId, connectionId, connectionGeneration, JSON.stringify({
        recordCount: 1,
        quarantineCount: 0,
        schemaDriftCount: 0,
        enumDriftCount: 0,
        tombstoneCount: 0,
        cursorLinkValid: true,
        cursorComplete: true,
        backfillComplete: false,
        jobType: "ReconciliationSweep",
        reconciliationPhase: "apply_tombstones",
      })],
    );
  });
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

    const repair = reconciliationRepairBatch(fixture, tenantId, connectionId);
    const repairLanding = await landing.land(repair.job, repair.manifest, [repair.record]);
    assert.equal(repairLanding.stagedRecordCount, 1);
    assert.deepEqual(repairLanding.quarantined, []);
    await establishCurrentReconciledRepairEvidence(database, tenantId, connectionId, repair);
    await assert.rejects(
      database.transaction(async (client) => {
        await client.query("select set_config('albert.tenant_id',$1,true)", [tenantId]);
        await client.query(
          `select semantic_internal.record_lightspeed_order_dependency_replay(
             $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text
           )`,
          [
            tenantId,
            connectionId,
            repair.job.batchId,
            repair.job.syncRunId,
            makeNamespacedSourceKey(
              "lightspeed-r",
              EXTERNAL_ACCOUNT_REFERENCE,
              orderLines.record.sourceObjectType,
              orderLines.record.sourceRecordId,
            ),
            orderLines.record.payloadHash,
            MAPPING_VERSION,
          ],
        );
      }),
      /canonical materialization is incomplete/iu,
      "Replay evidence must be rejected until the exact supplier-linked canonical lines exist.",
    );
    const duplicateReplayPipeline = new CanonicalTransformPipeline(
      database,
      new MappingContextDatabase(),
      MAPPING_VERSION,
      {
        "lightspeed-r": (stream, row, context) => {
          const commands = mapLightspeedCanonical(stream, row, context);
          return stream === "ls_purchase_order_lines" && commands[0]
            ? [...commands, commands[0]]
            : commands;
        },
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
    await assert.rejects(
      duplicateReplayPipeline.transformBatch(
        repair.transform,
        repair.stream,
        repair.domains,
        false,
        false,
      ),
      /canonical_dependency_replay_command_duplicate:811/u,
      "Duplicate canonical replay commands must fail before compatibility projection writes.",
    );
    assert.equal(
      await scalarCount(
        database,
        "select count(*)::text as row_count from core.purchase_order_line where tenant_id=$1",
        tenantId,
      ),
      0,
      "The duplicate-line replay transaction must not materialise a purchase order.",
    );
    await pipeline.transformBatch(repair.transform, repair.stream, repair.domains, false, false);

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
    const replayAudit = await database.query<{
      repair_batch_id: string;
      source_order_batch_id: string;
      legacy_origin_batch_id: string;
      connection_generation: string | number;
      result: string;
      materialized_command_count: string | number;
    }>(
      `select repair_batch_id,source_order_batch_id,legacy_origin_batch_id,
              connection_generation,result,materialized_command_count
         from semantic_internal.lightspeed_order_dependency_replay_audit
        where tenant_id=$1 and connection_id=$2`,
      [tenantId, connectionId],
    );
    assert.deepEqual(replayAudit.rows.map((row) => ({
      ...row,
      connection_generation: Number(row.connection_generation),
      materialized_command_count: Number(row.materialized_command_count),
    })), [{
      repair_batch_id: repair.job.batchId,
      source_order_batch_id: orderLines.job.batchId,
      legacy_origin_batch_id: orderLines.job.batchId,
      connection_generation: 2,
      result: "materialized",
      materialized_command_count: 1,
    }]);
    const replayGate = await database.query<{
      connection_generation: string | number;
      legacy_candidate_count: string | number;
      replay_audit_count: string | number;
      ready: boolean;
    }>(
      `select connection_generation,legacy_candidate_count,replay_audit_count,ready
         from semantic_internal.lightspeed_supplier_replay_gate_index
        where tenant_id=$1 and connection_id=$2`,
      [tenantId, connectionId],
    );
    assert.deepEqual(replayGate.rows.map((row) => ({
      connection_generation: Number(row.connection_generation),
      legacy_candidate_count: Number(row.legacy_candidate_count),
      replay_audit_count: Number(row.replay_audit_count),
      ready: row.ready,
    })), [{
      connection_generation: 2,
      legacy_candidate_count: 1,
      replay_audit_count: 1,
      ready: true,
    }]);

    const nextGenerationRepair = reconciliationRepairBatch(
      fixture,
      tenantId,
      connectionId,
      3,
    );
    const nextGenerationLanding = await landing.land(
      nextGenerationRepair.job,
      nextGenerationRepair.manifest,
      [nextGenerationRepair.record],
    );
    assert.equal(nextGenerationLanding.stagedRecordCount, 1);
    assert.deepEqual(nextGenerationLanding.quarantined, []);
    await establishCurrentReconciledRepairEvidence(
      database,
      tenantId,
      connectionId,
      nextGenerationRepair,
    );
    await assert.rejects(
      database.transaction(async (client) => {
        await client.query("select set_config('albert.tenant_id',$1,true)", [tenantId]);
        await client.query(
          `select semantic_internal.finalize_lightspeed_supplier_replay_gate(
             $1::text,$2::text,$3::text
           )`,
          [tenantId, connectionId, nextGenerationRepair.job.batchId],
        );
      }),
      /supplier replay remains incomplete: 0 of 1/iu,
      "A prior-generation replay audit must not satisfy the current generation gate.",
    );
    await pipeline.transformBatch(
      nextGenerationRepair.transform,
      nextGenerationRepair.stream,
      nextGenerationRepair.domains,
      false,
      false,
    );
    const generationEvidence = await database.query<{
      connection_generation: string | number;
    }>(
      `select connection_generation
         from semantic_internal.lightspeed_order_dependency_replay_audit
        where tenant_id=$1 and connection_id=$2
        order by connection_generation`,
      [tenantId, connectionId],
    );
    assert.deepEqual(
      generationEvidence.rows.map((row) => Number(row.connection_generation)),
      [2, 3],
      "Each reconciled credential generation requires independent replay evidence.",
    );
    const nextGenerationGate = await database.query<{
      connection_generation: string | number;
      ready: boolean;
      replay_audit_count: string | number;
    }>(
      `select connection_generation,ready,replay_audit_count
         from semantic_internal.lightspeed_supplier_replay_gate_index
        where tenant_id=$1 and connection_id=$2`,
      [tenantId, connectionId],
    );
    assert.deepEqual(nextGenerationGate.rows.map((row) => ({
      connection_generation: Number(row.connection_generation),
      ready: row.ready,
      replay_audit_count: Number(row.replay_audit_count),
    })), [{ connection_generation: 3, ready: true, replay_audit_count: 1 }]);
    process.stdout.write(
      "Lightspeed generation-scoped reconciled legacy Order replay proof passed.\n",
    );
  } finally {
    await database.close();
  }
}

await run();
