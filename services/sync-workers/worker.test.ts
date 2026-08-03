import assert from "node:assert/strict";
import test from "node:test";

import type {
  ConnectorContext,
  ConnectorPack,
} from "../../packages/connector-sdk/src/index.js";
import { ConnectorError } from "../../packages/connector-sdk/src/index.js";
import type {
  ClaimedSyncJob,
  DurableSyncQueue,
  SyncOrchestrator,
} from "../../packages/queue/src/index.js";
import type { RawBatchWriter } from "../../packages/storage/src/index.js";
import type { AnalyticalLandingStore } from "./src/analytical-store.js";
import type { ControlPlaneStore } from "./src/control-plane-store.js";
import { SyncJobProcessor } from "./src/worker.js";

test("a hung connector cannot outlive the sync operation lease budget", async () => {
  let connectorSignal: AbortSignal | undefined;
  let failedCode: string | undefined;
  let retry:
    | Readonly<{ code: string; retryable: boolean; delaySeconds: number }>
    | undefined;
  const queue = {
    async retryOrFail(
      _claim: ClaimedSyncJob,
      error: Readonly<{ code: string; retryable: boolean }>,
      options: Readonly<{ retryDelaySeconds: number }>,
    ) {
      retry = {
        code: error.code,
        retryable: error.retryable,
        delaySeconds: options.retryDelaySeconds,
      };
      return "retry_wait" as const;
    },
    async defer() { return new Date().toISOString(); },
  } as unknown as DurableSyncQueue;
  const control = {
    async beginRun() { return "run" as const; },
    async loadConnection() {
      return {
        tenantId: "tenant",
        connectionId: "connection",
        connectorKey: "xero" as const,
        externalAccountReference: "xero-tenant",
        credentialRef: "credential:test",
      };
    },
    async getCursor() { return { cursor: { value: "cursor" }, backfillComplete: true }; },
    async markRunFailed(
      _job: unknown,
      _attempt: number,
      code: string,
    ) { failedCode = code; },
    vendorRateBudget() {
      return {
        async beforeRequest() {},
        async observeResponse() {},
      };
    },
  } as unknown as ControlPlaneStore;
  const connector = {
    id: "xero",
    version: "test",
    apiVersion: "test",
    async list_streams() {
      return [{ id: "invoices", label: "Invoices", domains: ["finance"], cursorKind: "page" }];
    },
    async incremental_sync(context: ConnectorContext) {
      connectorSignal = context.abortSignal;
      return await new Promise<never>(() => undefined);
    },
  } as unknown as ConnectorPack;
  const claim = {
    queueName: "albert_sync_standard",
    workerId: "worker-test",
    messageId: "1",
    readCount: 1,
    enqueuedAt: new Date().toISOString(),
    visibilityDeadline: new Date(Date.now() + 900_000).toISOString(),
    job: {
      schemaVersion: 1,
      type: "IncrementalSync",
      tenantId: "01J00000000000000000000001",
      connectionId: "01J00000000000000000000002",
      connectorId: "xero",
      externalAccountReference: "xero-tenant",
      syncRunId: "01J00000000000000000000003",
      batchId: "01J00000000000000000000004",
      requestedAt: new Date().toISOString(),
      jobRequestId: "01J00000000000000000000005",
      stream: "invoices",
      cursor: { value: "cursor" },
      reason: "schedule",
    },
  } as const satisfies ClaimedSyncJob;
  const processor = new SyncJobProcessor(
    queue,
    {} as SyncOrchestrator,
    { get: () => connector },
    control,
    {} as AnalyticalLandingStore,
    {} as RawBatchWriter,
    "worker-test",
    { operationTimeoutMs: 20 },
  );

  const startedAt = Date.now();
  await processor.process(claim);

  assert.ok(Date.now() - startedAt < 1_000, "sync operation outlived its deadline");
  assert.equal(connectorSignal?.aborted, true);
  assert.equal(failedCode, "remote_unavailable");
  assert.deepEqual(retry, {
    code: "remote_unavailable",
    retryable: true,
    delaySeconds: 30,
  });
});

test("long vendor backoff is durably deferred without consuming the failure budget", async () => {
  let deferredSeconds: number | undefined;
  let retried = false;
  const queue = {
    async defer(_claim: ClaimedSyncJob, _reason: unknown, delaySeconds: number) {
      deferredSeconds = delaySeconds;
      return new Date(Date.now() + delaySeconds * 1_000).toISOString();
    },
    async retryOrFail() { retried = true; return "retry_wait" as const; },
  } as unknown as DurableSyncQueue;
  const control = {
    async beginRun() { return "run" as const; },
    async loadConnection() {
      return {
        tenantId: "tenant",
        connectionId: "connection",
        connectorKey: "xero" as const,
        externalAccountReference: "xero-tenant",
        credentialRef: "credential:test",
      };
    },
    async markRunFailed() {},
    vendorRateBudget() {
      return { async beforeRequest() {}, async observeResponse() {} };
    },
  } as unknown as ControlPlaneStore;
  const connector = {
    id: "xero",
    version: "test",
    apiVersion: "test",
    async list_streams() {
      throw new ConnectorError("RATE_LIMITED", "Xero requested a long backoff.", {
        retryable: true,
        retryAfterMs: 3_600_000,
      });
    },
  } as unknown as ConnectorPack;
  const claim = {
    queueName: "albert_sync_standard",
    workerId: "worker-test",
    messageId: "1",
    readCount: 1,
    enqueuedAt: new Date().toISOString(),
    visibilityDeadline: new Date(Date.now() + 900_000).toISOString(),
    job: {
      schemaVersion: 1,
      type: "IncrementalSync",
      tenantId: "01J00000000000000000000001",
      connectionId: "01J00000000000000000000002",
      connectorId: "xero",
      externalAccountReference: "xero-tenant",
      syncRunId: "01J00000000000000000000003",
      batchId: "01J00000000000000000000004",
      requestedAt: new Date().toISOString(),
      jobRequestId: "01J00000000000000000000005",
      stream: "invoices",
      cursor: { value: "cursor" },
      reason: "schedule",
    },
  } as const satisfies ClaimedSyncJob;
  const processor = new SyncJobProcessor(
    queue,
    {} as SyncOrchestrator,
    { get: () => connector },
    control,
    {} as AnalyticalLandingStore,
    {} as RawBatchWriter,
    "worker-test",
  );

  await processor.process(claim);

  assert.equal(deferredSeconds, 3_600);
  assert.equal(retried, false);
});
