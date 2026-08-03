import assert from "node:assert/strict";
import test from "node:test";
import {
  DefaultSyncOrchestrator,
  PgmqDurableSyncQueue,
  parseSyncJob,
  type PostgresQueryClient,
} from "./src/index.js";

const ids = {
  tenantId: "01J00000000000000000000001",
  connectionId: "01J00000000000000000000002",
  syncRunId: "01J00000000000000000000003",
  batchId: "01J00000000000000000000004",
  jobRequestId: "01J00000000000000000000005",
};

test("queue parser rejects a tenantless payload", () => {
  assert.throws(() => parseSyncJob({ type: "IncrementalSync" }), /tenantId/);
});

test("pgmq adapter claims high priority before standard/backfill", async () => {
  const calls: string[] = [];
  const db: PostgresQueryClient = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      calls.push(String(values[0] ?? "preflight"));
      const rows = values[0] === "albert_sync_high"
        ? [{
            message_id: "42",
            read_count: "1",
            enqueued_at: "2026-08-03T10:00:00.000Z",
            visibility_deadline: "2026-08-03T10:05:00.000Z",
            payload: {
              ...ids,
              schemaVersion: 1,
              type: "IncrementalSync",
              connectionGeneration: 1,
              connectorId: "xero",
              externalAccountReference: "org-1",
              requestedAt: "2026-08-03T10:00:00.000Z",
              stream: "invoices",
              reason: "webhook",
            },
          }]
        : [];
      return { rows: rows as Row[] };
    },
  };
  const queue = new PgmqDurableSyncQueue(db);
  const claim = await queue.claim({ workerId: "worker-1", visibilityTimeoutSeconds: 300 });
  assert.equal(claim?.queueName, "albert_sync_high");
  assert.equal(claim?.workerId, "worker-1");
  assert.equal(claim?.readCount, 1);
  assert.deepEqual(calls, ["albert_sync_high"]);
});

test("orchestrator assigns webhook work to durable high-priority queue", async () => {
  const enqueued: Array<Record<string, unknown>> = [];
  const orchestrator = new DefaultSyncOrchestrator({
    async preflight() {},
    async enqueue(job, options) {
      enqueued.push({ job, options });
      return { jobRequestId: ids.jobRequestId, messageId: "1", created: true };
    },
    async claim() { return null; },
    async extendVisibility() { return new Date().toISOString(); },
    async complete() {},
    async retryOrFail() { return "retry_wait"; },
    async defer() { return new Date().toISOString(); },
    async metrics() { return []; },
  });
  await orchestrator.enqueueIncrementalSync({
    tenantId: ids.tenantId,
    connectionId: ids.connectionId,
    connectionGeneration: 1,
    connectorId: "xero",
    externalAccountReference: "org-1",
    stream: "invoices",
    reason: "webhook",
  });
  assert.equal((enqueued[0]?.options as { priority: string }).priority, "high");
});
