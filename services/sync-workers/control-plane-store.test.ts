import assert from "node:assert/strict";
import test from "node:test";
import type { ClaimedSyncJob, SyncJob } from "../../packages/queue/src/index.js";
import { ControlPlaneStore } from "./src/control-plane-store.js";
import type { TransactionalPostgres } from "./src/database.js";

const job = {
  schemaVersion: 1,
  type: "IncrementalSync",
  tenantId: "01J00000000000000000000001",
  connectionId: "01J00000000000000000000002",
  connectionGeneration: 2,
  connectorId: "xero",
  externalAccountReference: "xero-tenant",
  syncRunId: "01J00000000000000000000003",
  batchId: "01J00000000000000000000004",
  requestedAt: "2026-08-03T00:00:00.000Z",
  jobRequestId: "01J00000000000000000000005",
  stream: "invoices",
  cursor: { value: "opaque", sourceUpdatedAt: "2026-08-03T00:00:00.000Z" },
  reason: "schedule",
} as const satisfies SyncJob;

const claim = {
  queueName: "albert_sync_standard",
  workerId: "worker-auth-health",
  messageId: "91",
  readCount: 2,
  enqueuedAt: "2026-08-03T00:00:00.000Z",
  visibilityDeadline: "2026-08-03T00:15:00.000Z",
  job,
} as const satisfies ClaimedSyncJob;

test("cursor commit re-locks the connection generation before any mutable publication", async () => {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      return { rows: [] };
    },
  };
  const db = {
    async transaction<T>(work: (value: typeof client) => Promise<T>) {
      return work(client);
    },
  } as unknown as TransactionalPostgres;
  const store = new ControlPlaneStore(db);

  await assert.rejects(
    store.commitPage({
      job,
      cursor: job.cursor,
      sourceWatermark: job.cursor.sourceUpdatedAt,
      hasMore: false,
      recordCount: 1,
      quarantineCount: 0,
      domains: ["finance"],
      backfillComplete: false,
      coverage: null,
      mappingVersion: "v1",
    }),
    /connection_generation_stale/,
  );

  assert.equal(statements.length, 1);
  assert.match(statements[0] ?? "", /connection_generation=\$3[\s\S]*for update/iu);
  assert.doesNotMatch(statements[0] ?? "", /raw_batch_landings/iu);
});

test("auth-health observations are fenced to the credential generation that was probed", async () => {
  let values: readonly unknown[] | undefined;
  const db = {
    async query(_sql: string, parameters?: readonly unknown[]) {
      values = parameters;
      return { rows: [] };
    },
  } as unknown as TransactionalPostgres;
  const store = new ControlPlaneStore(db);

  await assert.rejects(
    store.recordConnectionAuthHealth(claim, "expired"),
    /connection_auth_health_target_missing/,
  );
  assert.deepEqual(values, [
    job.tenantId,
    job.connectionId,
    2,
    job.connectorId,
    job.externalAccountReference,
    job.syncRunId,
    "expired",
    job.jobRequestId,
    claim.queueName,
    91,
    claim.workerId,
    claim.readCount,
  ]);
});

test("quarantine recovery is delegated only through the exact leased resolution function", async () => {
  let sql = "";
  let values: readonly unknown[] = [];
  const db = {
    async query(statement: string, parameters: readonly unknown[] = []) {
      sql=statement;
      values=parameters;
      return {rows:[{resolved_count:"2"}]};
    },
  } as unknown as TransactionalPostgres;
  const store=new ControlPlaneStore(db);

  const resolved=await store.resolveQuarantineIndex({
    claim,
    permitId:"01J00000000000000000000006",
    stream:"invoices",
    records:[
      {sourceObjectType:"Invoice",sourceRecordId:"invoice-1"},
      {sourceObjectType:"Invoice",sourceRecordId:"invoice-2"},
    ],
  });

  assert.equal(resolved,2);
  assert.match(sql,/control_plane\.resolve_quarantine_items/iu);
  assert.deepEqual(values.slice(0,3),[
    "01J00000000000000000000006",claim.workerId,"invoices",
  ]);
  assert.deepEqual(JSON.parse(String(values[3])),[
    {sourceObjectType:"Invoice",sourceRecordId:"invoice-1"},
    {sourceObjectType:"Invoice",sourceRecordId:"invoice-2"},
  ]);
});
