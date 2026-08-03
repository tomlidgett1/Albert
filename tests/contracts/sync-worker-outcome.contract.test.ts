import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorError,
  type ConnectorPack,
} from "../../packages/connector-sdk/src/index.js";
import {
  PgmqDurableSyncQueue,
  type ClaimedSyncJob,
  type DurableSyncQueue,
  type SyncOrchestrator,
} from "../../packages/queue/src/index.js";
import type { RawBatchWriter } from "../../packages/storage/src/index.js";
import type { AnalyticalLandingStore } from "../../services/sync-workers/src/analytical-store.js";
import { identityProjectionFailure } from "../../services/sync-workers/src/canonical-pipeline.js";
import { ControlPlaneStore } from "../../services/sync-workers/src/control-plane-store.js";
import type { TransactionalPostgres } from "../../services/sync-workers/src/database.js";
import { SyncWorkerService } from "../../services/sync-workers/src/service.js";
import {
  SyncJobProcessor,
  type SyncProcessOutcome,
} from "../../services/sync-workers/src/worker.js";

const claim: ClaimedSyncJob = Object.freeze({
  queueName: "albert_sync_backfill",
  workerId: "sync-outcome-test",
  messageId: "1",
  readCount: 1,
  enqueuedAt: "2026-08-04T00:00:00.000Z",
  visibilityDeadline: "2026-08-04T00:15:00.000Z",
  job: Object.freeze({
    schemaVersion: 1,
    type: "InitialBackfill",
    tenantId: "01J00000000000000000000001",
    connectionId: "01J00000000000000000000002",
    connectionGeneration: 1,
    connectorId: "xero",
    externalAccountReference: "xero-tenant",
    syncRunId: "01J00000000000000000000003",
    batchId: "01J00000000000000000000004",
    requestedAt: "2026-08-04T00:00:00.000Z",
    jobRequestId: "01J00000000000000000000005",
    range: Object.freeze({
      from: "2026-07-04T00:00:00.000Z",
      to: "2026-08-04T00:00:00.000Z",
    }),
    phase: "recent",
    replayVersion: 1,
    planMode: "progressive",
  }),
});

function processorHarness(input: Readonly<{
  failure?: Error;
  queueOutcome?: "retry_wait" | "failed";
}> = {}) {
  let persistedFailure: Readonly<{ code: string; retryable: boolean }> | null = null;
  let deferredReason: Readonly<{ code: string }> | null = null;
  let completed = 0;
  const runFailures: string[] = [];
  const queue = {
    async complete() { completed += 1; },
    async retryOrFail(
      _claim: ClaimedSyncJob,
      failure: Readonly<{ code: string; retryable: boolean }>,
    ) {
      persistedFailure = failure;
      return input.queueOutcome ?? "retry_wait";
    },
    async defer(
      _claim: ClaimedSyncJob,
      reason: Readonly<{ code: string }>,
    ) {
      deferredReason = reason;
      return "2026-08-04T00:15:00.000Z";
    },
  } as unknown as DurableSyncQueue;
  const control = {
    async beginRun() { return input.failure ? "run" as const : "already_succeeded" as const; },
    async acquireSyncWritePermit() { return "01ARZ3NDEKTSV4RRFFQ69G5FAY"; },
    async releaseSyncWritePermit() {},
    async loadConnection() {
      return {
        tenantId: claim.job.tenantId,
        connectionId: claim.job.connectionId,
        connectorKey: "xero" as const,
        externalAccountReference: "xero-tenant",
        credentialRef: "credential:test",
      };
    },
    async recordConnectionAuthHealth() {},
    async markRunFailed(
      _job: unknown,
      _attempt: number,
      code: string,
    ) { runFailures.push(code); },
    vendorRateBudget() {
      return { async beforeRequest() {}, async observeResponse() {} };
    },
  } as unknown as ControlPlaneStore;
  const connector = {
    id: "xero",
    version: "test",
    apiVersion: "test",
    async check_connection() {
      if (input.failure) throw input.failure;
      return "healthy" as const;
    },
  } as unknown as ConnectorPack;
  return {
    processor: new SyncJobProcessor(
      queue,
      {} as SyncOrchestrator,
      { get: () => connector },
      control,
      {} as AnalyticalLandingStore,
      {} as RawBatchWriter,
      "sync-outcome-test",
    ),
    completed: () => completed,
    deferredReason: () => deferredReason,
    persistedFailure: () => persistedFailure,
    runFailures: () => runFailures,
  };
}

test("sync processor returns completed only after its durable completion transition", async () => {
  const harness = processorHarness();
  assert.deepEqual(await harness.processor.process(claim), { status: "completed" });
  assert.equal(harness.completed(), 1);
  assert.equal(harness.persistedFailure(), null);
});

test("retry outcome persists a bounded code and rejects secret or PII leakage", async () => {
  const secret = "Bearer sk-super-secret account@example.com";
  const harness = processorHarness({
    failure: new Error(`vendor exploded ${secret}`),
    queueOutcome: "retry_wait",
  });

  const outcome = await harness.processor.process(claim);
  assert.deepEqual(outcome, {
    status: "retry_scheduled",
    failure: { code: "unexpected_sync_failure", retryable: true },
    retryDelaySeconds: 30,
  });
  assert.deepEqual(harness.persistedFailure(), {
    code: "unexpected_sync_failure",
    retryable: true,
  });
  assert.deepEqual(harness.runFailures(), ["unexpected_sync_failure"]);
  assert.doesNotMatch(
    JSON.stringify({ outcome, failure: harness.persistedFailure() }),
    /sk-super-secret|account@example\.com|Bearer/u,
  );
});

test("terminal and rate-limited connector errors expose only trusted enum codes", async () => {
  const terminal = processorHarness({
    failure: new ConnectorError(
      "CONFIGURATION_INVALID",
      "Bearer sk-never-persist account@example.com",
      { retryable: false },
    ),
    queueOutcome: "failed",
  });
  assert.deepEqual(await terminal.processor.process(claim), {
    status: "failed",
    failure: { code: "configuration_invalid", retryable: false },
    retryDelaySeconds: 30,
  });
  assert.deepEqual(terminal.persistedFailure(), {
    code: "configuration_invalid",
    retryable: false,
  });

  const rateLimited = processorHarness({
    failure: new ConnectorError(
      "RATE_LIMITED",
      "Bearer sk-rate-limit-secret account@example.com",
      { retryable: true, retryAfterMs: 60_000 },
    ),
  });
  assert.deepEqual(await rateLimited.processor.process(claim), {
    status: "retry_scheduled",
    failure: { code: "rate_limited", retryable: true },
    retryDelaySeconds: 60,
  });
  assert.deepEqual(rateLimited.deferredReason(), { code: "rate_limited" });
  assert.equal(rateLimited.persistedFailure(), null);
  assert.doesNotMatch(
    JSON.stringify({ terminal: terminal.persistedFailure(), rateLimited: rateLimited.deferredReason() }),
    /sk-never-persist|sk-rate-limit-secret|account@example\.com|Bearer/u,
  );
});

test("durable sync persistence boundaries discard extra detail and invalid codes", async () => {
  const secret = "Bearer sk-boundary-secret account@example.com";
  const queueQueries: Array<Readonly<{ sql: string; values: readonly unknown[] }>> = [];
  const queue = new PgmqDurableSyncQueue({
    async query(sql: string, values: readonly unknown[] = []) {
      queueQueries.push({ sql, values });
      if (sql.includes("retry_or_fail_sync_job")) {
        return { rows: [{ outcome: "retry_wait" as const }] };
      }
      return { rows: [{ visibility_deadline: "2026-08-04T00:15:00.000Z" }] };
    },
  } as never);
  await queue.retryOrFail(
    claim,
    { code: "sk-boundary-secret", retryable: true, detail: secret } as never,
    { retryDelaySeconds: 30, maxAttempts: 8 },
  );
  await queue.defer(
    claim,
    { code: "sk-boundary-secret", detail: secret } as never,
    30,
  );

  assert.deepEqual(JSON.parse(String(queueQueries[0]!.values[5])), {
    code: "unexpected_sync_failure",
    retryable: true,
  });
  assert.deepEqual(JSON.parse(String(queueQueries[1]!.values[5])), {
    code: "unexpected_sync_failure",
  });

  const controlQueries: Array<Readonly<{ sql: string; values: readonly unknown[] }>> = [];
  const control = new ControlPlaneStore({
    async query() { return { rows: [] }; },
    async transaction<T>(operation: (client: {
      query(sql: string, values?: readonly unknown[]): Promise<Readonly<{ rows: readonly never[] }>>;
    }) => Promise<T>) {
      return operation({
        async query(sql: string, values: readonly unknown[] = []) {
          controlQueries.push({ sql, values });
          return { rows: [] };
        },
      });
    },
  } as unknown as TransactionalPostgres);
  await control.markRunFailed(
    { ...claim.job, stream: "invoices" },
    1,
    "sk-boundary-secret",
    true,
  );

  assert.equal(controlQueries[0]!.values[3], "unexpected_sync_failure");
  assert.equal(controlQueries[0]!.values[4], "unexpected_sync_failure");
  assert.equal(controlQueries[1]!.values[6], "unexpected_sync_failure");
  assert.doesNotMatch(
    JSON.stringify({ queueQueries, controlQueries }),
    /sk-boundary-secret|account@example\.com|Bearer/u,
  );
});

test("identity projection failure evidence is code-only even when database messages contain secrets", () => {
  const secret = "Bearer sk-identity-secret employee@example.com";
  const unexpected = identityProjectionFailure(new Error(`vendor rejected ${secret}`));
  assert.deepEqual(unexpected, {
    code: "unexpected_identity_projection_failure",
    retryable: true,
    retryDelaySeconds: 15,
  });

  const permanent = new Error(`identity decision candidate is invalid ${secret}`) as Error & {
    code: string;
  };
  permanent.code = "22023";
  assert.deepEqual(identityProjectionFailure(permanent), {
    code: "identity_projection_invalid",
    retryable: false,
    retryDelaySeconds: 1,
  });
  assert.doesNotMatch(
    JSON.stringify({ unexpected, permanent: identityProjectionFailure(permanent) }),
    /sk-identity-secret|employee@example\.com|Bearer/u,
  );
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("sync_outcome_test_timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function serviceHealthFor(outcome: SyncProcessOutcome) {
  let issued = false;
  const queue = {
    async preflight() {},
    async claim() {
      if (issued) return null;
      issued = true;
      return claim;
    },
    async extendVisibility() { return "2026-08-04T00:15:00.000Z"; },
  } as unknown as DurableSyncQueue;
  const processor = { async process() { return outcome; } } as unknown as SyncJobProcessor;
  const service = new SyncWorkerService(
    "sync-outcome-test",
    queue,
    processor,
    { emptyPollDelayMs: 5 },
  );
  const abort = new AbortController();
  const running = service.run(abort.signal);
  await waitUntil(() => service.health().activeJobs === 0 && service.health().lastClaimAt !== null);
  const health = service.health();
  abort.abort();
  await running;
  return health;
}

test("sync worker health advances completion only for completed work", async () => {
  const retried = await serviceHealthFor({
    status: "retry_scheduled",
    failure: { code: "database_unavailable", retryable: true },
    retryDelaySeconds: 30,
  });
  assert.equal(retried.lastCompletionAt, null);
  assert.equal(retried.lastErrorCode, "database_unavailable");

  const failed = await serviceHealthFor({
    status: "failed",
    failure: { code: "configuration_invalid", retryable: false },
    retryDelaySeconds: 30,
  });
  assert.equal(failed.lastCompletionAt, null);
  assert.equal(failed.lastErrorCode, "configuration_invalid");

  const completed = await serviceHealthFor({ status: "completed" });
  assert.match(completed.lastCompletionAt ?? "", /^20\d{2}-/u);
  assert.equal(completed.lastErrorCode, null);
});
