import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ConnectorHttpError,
  type ConnectionHealth,
  type ConnectorPack,
} from "../../packages/connector-sdk/src/index.js";
import type {
  ClaimedSyncJob,
  DurableSyncQueue,
  SyncOrchestrator,
} from "../../packages/queue/src/index.js";
import type { RawBatchWriter } from "../../packages/storage/src/index.js";
import type { AnalyticalLandingStore } from "../../services/sync-workers/src/analytical-store.js";
import type { ControlPlaneStore } from "../../services/sync-workers/src/control-plane-store.js";
import { SyncJobProcessor } from "../../services/sync-workers/src/worker.js";

function coordinatorClaim(suffix: "1" | "2"): ClaimedSyncJob {
  return {
    queueName: "albert_sync_backfill",
    workerId: "worker-auth-health",
    messageId: suffix,
    readCount: 1,
    enqueuedAt: "2026-08-03T00:00:00.000Z",
    visibilityDeadline: "2026-08-03T00:15:00.000Z",
    job: {
      schemaVersion: 1,
      type: "InitialBackfill",
      tenantId: `01J0000000000000000000000${suffix}`,
      connectionId: "01J00000000000000000000003",
      connectionGeneration: 1,
      connectorId: "xero",
      externalAccountReference: "xero-tenant",
      syncRunId: `01J0000000000000000000001${suffix}`,
      batchId: `01J0000000000000000000002${suffix}`,
      requestedAt: "2026-08-03T00:00:00.000Z",
      jobRequestId: `01J0000000000000000000003${suffix}`,
      range: {
        from: "2026-07-03T00:00:00.000Z",
        to: "2026-08-03T00:00:00.000Z",
      },
      phase: "recent",
      replayVersion: 1,
      planMode: "progressive",
    },
  };
}

function processorHarness(health: () => ConnectionHealth) {
  const persisted: string[] = [];
  let listed = 0;
  let completed = 0;
  let failed = 0;
  let registered = 0;
  const queue = {
    async extendVisibility() { return "2026-08-03T00:15:00.000Z"; },
    async complete() { completed += 1; },
    async retryOrFail() { failed += 1; return "failed" as const; },
    async defer() { return "2026-08-03T00:15:00.000Z"; },
  } as unknown as DurableSyncQueue;
  const control = {
    async beginRun() { return "run" as const; },
    async acquireSyncWritePermit() { return "permit:test"; },
    async withSyncWritePermit<T>(
      _claim: ClaimedSyncJob,
      _permitId: string,
      operation: (capability: string) => Promise<T>,
    ) {
      return operation("capability:test");
    },
    async releaseSyncWritePermit() {},
    async loadConnection() {
      return {
        tenantId: "tenant",
        connectionId: "connection",
        connectorKey: "xero" as const,
        externalAccountReference: "xero-tenant",
        credentialRef: "credential:test",
      };
    },
    async recordConnectionAuthHealth(_job: unknown, value: string) { persisted.push(value); },
    async completeCoordinatorRun() {},
    async getCursor() {
      return {
        cursor: null,sourceWatermark:null,backfillComplete:false,
        connectionGeneration:0,coverage:null,
      };
    },
    async registerBackfillPlan(_job: unknown, plans: readonly unknown[]) {
      registered += plans.length;
    },
    async markBackfillPhaseEnqueued() {},
    async markRunFailed() {},
    vendorRateBudget() {
      return { async beforeRequest() {}, async observeResponse() {} };
    },
  } as unknown as ControlPlaneStore;
  const connector = {
    id: "xero",
    version: "test",
    apiVersion: "test",
    manifest: {
      streams: [{
        id: "invoices",resource: "Invoices",endpoint: "Invoices",
        recordIdField: "InvoiceID",modifiedField: "UpdatedDateUTC",
        pagination: "page",backfillStrategy: "time_windowed",
        lateEditStrategy: "modified_field",
        deletionStrategy: "soft_delete",
        sourceTotalStrategy: "count_distinct_complete_scan",
        dependencies: [],productDomains: ["accounting"],
        canonicalTargets: ["finance"],
      }],
      capabilities: {},
    },
    async check_connection() { return health(); },
    async list_streams() { listed += 1; return []; },
  } as unknown as ConnectorPack;
  const processor = new SyncJobProcessor(
    queue,
    {
      async enqueueInitialBackfill() {
        return "01J00000000000000000000999";
      },
    } as unknown as SyncOrchestrator,
    { get: () => connector },
    control,
    { async registerConnectorStreams() { return 1; } } as unknown as AnalyticalLandingStore,
    {} as RawBatchWriter,
    "worker-auth-health",
  );
  return {
    processor,
    persisted,
    stats: () => ({ listed, completed, failed, registered }),
  };
}

test("scheduled sync checks persist revoked health, stop extraction, and later restore healthy", async () => {
  let health: ConnectionHealth = "revoked";
  const harness = processorHarness(() => health);

  await harness.processor.process(coordinatorClaim("1"));
  assert.equal(harness.persisted.at(-1), "revoked");
  assert.deepEqual(harness.stats(), { listed: 0, completed: 0, failed: 1, registered: 0 });

  health = "healthy";
  await harness.processor.process(coordinatorClaim("2"));
  assert.equal(harness.persisted.at(-1), "healthy");
  assert.deepEqual(harness.stats(), { listed: 1, completed: 1, failed: 1, registered: 3 });
});

test("vendor 401 and 403 failures immediately supersede a successful health probe", async () => {
  const persisted: string[] = [];
  let rejectedStatus = 401;
  let queueFailure:
    | Readonly<{ code: string; retryable: boolean }>
    | undefined;
  const queue = {
    async retryOrFail(
      _claim: ClaimedSyncJob,
      error: Readonly<{ code: string; retryable: boolean }>,
    ) {
      queueFailure = error;
      return "failed" as const;
    },
    async defer() { return "2026-08-03T00:15:00.000Z"; },
  } as unknown as DurableSyncQueue;
  const control = {
    async beginRun() { return "run" as const; },
    async acquireSyncWritePermit() { return "permit:test"; },
    async withSyncWritePermit<T>(
      _claim: ClaimedSyncJob,
      _permitId: string,
      operation: (capability: string) => Promise<T>,
    ) {
      return operation("capability:test");
    },
    async releaseSyncWritePermit() {},
    async loadConnection() {
      return {
        tenantId: "tenant",
        connectionId: "connection",
        connectorKey: "xero" as const,
        externalAccountReference: "xero-tenant",
        credentialRef: "credential:test",
      };
    },
    async recordConnectionAuthHealth(_job: unknown, value: string) { persisted.push(value); },
    async markRunFailed() {},
    vendorRateBudget() {
      return { async beforeRequest() {}, async observeResponse() {} };
    },
  } as unknown as ControlPlaneStore;
  const connector = {
    id: "xero",
    version: "test",
    apiVersion: "test",
    async check_connection() { return "healthy" as const; },
    async list_streams() {
      throw new ConnectorHttpError(rejectedStatus, "The vendor rejected the access token.");
    },
  } as unknown as ConnectorPack;
  const processor = new SyncJobProcessor(
    queue,
    {} as SyncOrchestrator,
    { get: () => connector },
    control,
    { async registerConnectorStreams() { return 1; } } as unknown as AnalyticalLandingStore,
    {} as RawBatchWriter,
    "worker-auth-health",
  );

  await processor.process(coordinatorClaim("1"));
  rejectedStatus = 403;
  await processor.process(coordinatorClaim("2"));

  assert.deepEqual(persisted, ["healthy", "expired", "healthy", "error"]);
  assert.deepEqual(queueFailure, {
    code: "remote_unavailable",
    retryable: false,
  });
});

test("health persistence remains tenant-scoped and rides the existing sync schedules", async () => {
  const [
    worker, store, scheduler, scheduledRecovery, deferredDuringBackfill, queueContracts, operatorConsole,
  ] = await Promise.all([
    readFile(new URL("../../services/sync-workers/src/worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/sync-workers/src/control-plane-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../../infra/migrations/control-plane/0003_m2_ingestion_operations.sql", import.meta.url), "utf8"),
    readFile(new URL("../../infra/migrations/control-plane/0022_m2_schedule_pre_cursor_connection_checks.sql", import.meta.url), "utf8"),
    readFile(new URL("../../infra/migrations/control-plane/0073_m2_defer_incremental_during_backfill.sql", import.meta.url), "utf8"),
    readFile(new URL("../../packages/queue/src/contracts.ts", import.meta.url), "utf8"),
    readFile(new URL("../../infra/migrations/control-plane/0017_m2_operator_pipeline_console.sql", import.meta.url), "utf8"),
  ]);

  assert.match(worker, /connector\.check_connection\(context\)/u);
  assert.match(worker, /recordConnectionAuthHealth\(claim, authHealth\)/u);
  assert.match(store, /control_plane\.record_connection_auth_health\(/u);
  assert.match(store, /job\.connectionGeneration[\s\S]*job\.externalAccountReference[\s\S]*job\.jobRequestId[\s\S]*claim\.queueName[\s\S]*claim\.workerId[\s\S]*claim\.readCount/u);
  assert.doesNotMatch(store, /update control_plane\.connections/iu);
  assert.match(scheduler, /enqueue_due_incremental_syncs/u);
  assert.match(scheduler, /enqueue_nightly_reconciliation_sweeps/u);
  assert.match(scheduledRecovery, /connection\.last_checked_at <= p_now - interval '15 minutes'/u);
  assert.match(scheduledRecovery, /NOT EXISTS \([\s\S]*control_plane\.stream_cursors/u);
  assert.match(scheduledRecovery, /'type', 'InitialBackfill'/u);
  assert.match(scheduledRecovery, /'scheduled-auth-recovery:' \|\| candidate\.connection_id/u);
  assert.match(deferredDuringBackfill, /coalesce\(incomplete\.backfill_complete, false\) = false/u);
  assert.match(deferredDuringBackfill, /request\.job_type = 'InitialBackfill'/u);
  assert.match(queueContracts, /"InitialBackfill",\s*"IncrementalSync",\s*"ReconciliationSweep"/u);
  assert.match(operatorConsole, /'auth_health', connection\.auth_health/u);
  assert.match(operatorConsole, /'last_checked_at', connection\.last_checked_at/u);
});
