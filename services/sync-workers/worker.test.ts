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
    async resumeInitialBackfillCursor() { return null; },
    async acquireSyncWritePermit() { return "01ARZ3NDEKTSV4RRFFQ69G5FAY"; },
    async releaseSyncWritePermit() {},
    async withSyncWritePermit(_claim: unknown, _permitId: string, operation: (capability: string) => Promise<unknown>) {
      return operation(`test-capability-${"x".repeat(100)}`);
    },
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
    async recordConnectionAuthHealth() {},
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
    async check_connection() { return "healthy" as const; },
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
      connectionGeneration: 1,
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
    async acquireSyncWritePermit() { return "01ARZ3NDEKTSV4RRFFQ69G5FAY"; },
    async releaseSyncWritePermit() {},
    async withSyncWritePermit(_claim: unknown, _permitId: string, operation: (capability: string) => Promise<unknown>) {
      return operation(`test-capability-${"x".repeat(100)}`);
    },
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
    async recordConnectionAuthHealth() {},
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
      connectionGeneration: 1,
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

test("deep-history claims yield while recent phases keep the connection off the critical path", async () => {
  let deferredReason: { code: string } | undefined;
  let deferredSeconds: number | undefined;
  let runsBegun = 0;
  const queue = {
    async defer(_claim: ClaimedSyncJob, reason: { code: string }, delaySeconds: number) {
      deferredReason = reason;
      deferredSeconds = delaySeconds;
      return new Date(Date.now() + delaySeconds * 1_000).toISOString();
    },
  } as unknown as DurableSyncQueue;
  const control = {
    async beginRun() { runsBegun += 1; return "run" as const; },
    async openRecentBackfillPhases() { return 2; },
    vendorRateBudget() {
      return { async beforeRequest() {}, async observeResponse() {} };
    },
  } as unknown as ControlPlaneStore;
  const claim = {
    queueName: "albert_sync_backfill",
    workerId: "worker-test",
    messageId: "1",
    readCount: 1,
    enqueuedAt: new Date().toISOString(),
    visibilityDeadline: new Date(Date.now() + 900_000).toISOString(),
    job: {
      schemaVersion: 1,
      type: "InitialBackfill",
      tenantId: "01J00000000000000000000001",
      connectionId: "01J00000000000000000000002",
      connectionGeneration: 1,
      connectorId: "xero",
      externalAccountReference: "xero-tenant",
      syncRunId: "01J00000000000000000000003",
      batchId: "01J00000000000000000000004",
      requestedAt: new Date().toISOString(),
      jobRequestId: "01J00000000000000000000005",
      stream: "invoices",
      range: { from: "1970-01-01T00:00:00.000Z", to: new Date().toISOString() },
      phase: "full_history",
      replayVersion: 1,
      planMode: "progressive",
    },
  } as const satisfies ClaimedSyncJob;
  const processor = new SyncJobProcessor(
    queue,
    {} as SyncOrchestrator,
    { get: () => { throw new Error("connector must not be resolved for a yielded claim"); } },
    control,
    {} as AnalyticalLandingStore,
    {} as RawBatchWriter,
    "worker-test",
  );

  const outcome = await processor.process(claim);

  assert.equal(outcome.status, "retry_scheduled");
  assert.deepEqual(deferredReason, { code: "connection_not_ready" });
  assert.equal(typeof deferredSeconds, "number");
  assert.equal(runsBegun, 0);
});

test("a killed backfill replay keeps one immutable raw batch identity", async () => {
  const requestedAt = "2026-08-03T23:59:59.000Z";
  const extractedAtValues: string[] = [];
  let commits = 0;
  let completions = 0;
  let retries = 0;
  const queue = {
    async extendVisibility() { return new Date().toISOString(); },
    async complete() { completions += 1; },
    async retryOrFail() { retries += 1; return "retry_wait" as const; },
    async defer() { return new Date().toISOString(); },
  } as unknown as DurableSyncQueue;
  const control = {
    async beginRun() { return "run" as const; },
    async resumeInitialBackfillCursor() { return null; },
    async loadConnection() {
      return {
        tenantId: "tenant",
        connectionId: "connection",
        connectorKey: "xero" as const,
        externalAccountReference: "xero-tenant",
        credentialRef: "credential:test",
      };
    },
    async getCursor() { return { cursor: null, backfillComplete: false }; },
    async backfillPhase() {
      return { inheritedCoverage: null, required: true, strategy: "time_windowed" as const };
    },
    async nextBackfillPhase() { return null; },
    async openRecentBackfillPhases() { return 0; },
    async acquireSyncWritePermit() { return "01ARZ3NDEKTSV4RRFFQ69G5FAY"; },
    async releaseSyncWritePermit() {},
    async withSyncWritePermit(_claim: unknown, _permitId: string, operation: (capability: string) => Promise<unknown>) {
      return operation(`test-capability-${"x".repeat(100)}`);
    },
    async markLandingStarted() {},
    async markRunFailed() {},
    async recordConnectionAuthHealth() {},
    async recordQuarantineIndex() {},
    async commitPage() {
      commits += 1;
      if (commits === 1) throw new Error("control_plane_temporarily_unavailable");
    },
    async completePageRun() {},
    vendorRateBudget() {
      return { async beforeRequest() {}, async observeResponse() {} };
    },
  } as unknown as ControlPlaneStore;
  const connector = {
    id: "xero",
    version: "test",
    apiVersion: "test",
    manifest: { capabilities: {} },
    async check_connection() { return "healthy" as const; },
    async list_streams() {
      return [{
        id: "invoices",
        label: "Invoices",
        domains: ["finance"],
        cursorKind: "page",
        backfillStrategy: "time_windowed",
        availability: "required",
      }];
    },
    async initial_sync() {
      return {
        records: [],
        nextCursor: undefined,
        hasMore: false,
        coverage: {
          boundaryKind: "verified_empty",
          lowerBound: requestedAt,
          verification: "exhaustive_vendor_scan",
        },
      };
    },
    async describe_capabilities() { return []; },
  } as unknown as ConnectorPack;
  const rawWriter = {
    async write(context: { extractedAt: string }) {
      extractedAtValues.push(context.extractedAt);
      return {
        tenantId: "01J00000000000000000000001",
        connectionId: "01J00000000000000000000002",
        syncRunId: "01J00000000000000000000003",
        batchId: "01J00000000000000000000004",
        connectorKey: "xero",
        connectorVersion: "test",
        apiVersion: "test",
        externalAccountReference: "xero-tenant",
        stream: "invoices",
        extractedAt: context.extractedAt,
        cursorStart: null,
        cursorEnd: null,
        contentHash: "a".repeat(64),
        schemaFingerprint: "b".repeat(64),
        recordCount: 0,
        compressedBytes: 0,
        objectKeys: ["raw/test.jsonl.gz"],
      };
    },
  } as unknown as RawBatchWriter;
  const analytical = {
    version: "test-mapping",
    async land() { return { stagedRecordCount: 0, quarantined: [], resolved: [] }; },
    async recordConnectorStreamPage() {},
    async publishCapabilityObservations() { return 0; },
    async publishConnectorQualityResults() { return 7; },
    async refreshConnectorQualityRollup() {},
  } as unknown as AnalyticalLandingStore;
  const claim = {
    queueName: "albert_sync_backfill",
    workerId: "worker-test",
    messageId: "1",
    readCount: 1,
    enqueuedAt: requestedAt,
    visibilityDeadline: "2026-08-04T00:15:00.000Z",
    job: {
      schemaVersion: 1,
      type: "InitialBackfill",
      tenantId: "01J00000000000000000000001",
      connectionId: "01J00000000000000000000002",
      connectionGeneration: 1,
      connectorId: "xero",
      externalAccountReference: "xero-tenant",
      syncRunId: "01J00000000000000000000003",
      batchId: "01J00000000000000000000004",
      requestedAt,
      jobRequestId: "01J00000000000000000000005",
      stream: "invoices",
      range: { from: "1970-01-01T00:00:00.000Z", to: requestedAt },
      phase: "full_history",
      replayVersion: 1,
      planMode: "progressive",
    },
  } as const satisfies ClaimedSyncJob;
  const processor = new SyncJobProcessor(
    queue,
    {} as SyncOrchestrator,
    { get: () => connector },
    control,
    analytical,
    rawWriter,
    "worker-test",
  );

  await processor.process(claim);
  await processor.process({ ...claim, readCount: 2 });

  assert.deepEqual(extractedAtValues, [requestedAt, requestedAt]);
  assert.equal(retries, 1);
  assert.equal(completions, 1);
  assert.equal(commits, 2);
});

test("a blocked pagination page is durably quarantined without advancing the cursor", async () => {
  const events: string[] = [];
  let committed = 0;
  let completed = 0;
  let enqueued = 0;
  let failure: Readonly<{ code: string; retryable: boolean }> | undefined;
  const queue = {
    async extendVisibility() { return new Date().toISOString(); },
    async complete() { completed += 1; },
    async retryOrFail(
      _claim: ClaimedSyncJob,
      error: Readonly<{ code: string; retryable: boolean }>,
    ) {
      events.push("failed");
      failure = error;
      return "failed" as const;
    },
    async defer() { return new Date().toISOString(); },
  } as unknown as DurableSyncQueue;
  const control = {
    async beginRun() { return "run" as const; },
    async loadConnection() {
      return {
        tenantId: "01J00000000000000000000001",
        connectionId: "01J00000000000000000000002",
        connectorKey: "xero" as const,
        externalAccountReference: "xero-tenant",
        credentialRef: "credential:test",
        connectionGeneration: 1,
      };
    },
    async getCursor() {
      return {
        cursor: { value: "499" },
        backfillComplete: true,
        sourceWatermark: null,
        connectionGeneration: 1,
        coverage: null,
      };
    },
    async acquireSyncWritePermit() { return "01ARZ3NDEKTSV4RRFFQ69G5FAY"; },
    async releaseSyncWritePermit() {},
    async withSyncWritePermit(
      _claim: unknown,
      _permitId: string,
      operation: (capability: string) => Promise<unknown>,
    ) {
      return operation(`test-capability-${"x".repeat(100)}`);
    },
    async markLandingStarted() { events.push("landing-started"); },
    async recordQuarantineIndex() { events.push("control-quarantine"); },
    async recordConnectionAuthHealth() {},
    async markRunFailed() { events.push("run-failed"); },
    async commitPage() { committed += 1; },
    vendorRateBudget() {
      return { async beforeRequest() {}, async observeResponse() {} };
    },
  } as unknown as ControlPlaneStore;
  const record = {
    sourceObjectType: "Journal",
    sourceRecordId: "invalid:journal-number",
    sourceVersion: null,
    sourceUpdatedAt: null,
    payload: { JournalNumber: "not-a-number" },
    payloadHash: "c".repeat(64),
    normalized: null,
    validationIssues: [{
      code: "schema_invalid" as const,
      path: "$.JournalNumber",
      message: "JournalNumber must be a safe non-negative integer.",
    }],
  };
  const connector = {
    id: "xero",
    version: "test",
    apiVersion: "test",
    manifest: { capabilities: {} },
    async check_connection() { return "healthy" as const; },
    async list_streams() {
      return [{
        id: "journals",
        label: "Journals",
        domains: ["finance"],
        cursorKind: "offset",
        backfillStrategy: "exhaustive_offset",
        availability: "optional",
      }];
    },
    async incremental_sync() {
      return {
        records: [record],
        nextCursor: null,
        hasMore: true,
        paginationBlock: {
          code: "pagination_identity_invalid" as const,
          detail: "Xero returned a full Journals page without a valid JournalNumber.",
        },
      };
    },
    async describe_capabilities() { return []; },
  } as unknown as ConnectorPack;
  const rawWriter = {
    async write() {
      events.push("raw-written");
      return {
        tenantId: "01J00000000000000000000001",
        connectionId: "01J00000000000000000000002",
        syncRunId: "01J00000000000000000000003",
        batchId: "01J00000000000000000000004",
        connectorKey: "xero",
        connectorVersion: "test",
        apiVersion: "test",
        externalAccountReference: "xero-tenant",
        stream: "journals",
        extractedAt: "2026-08-03T00:00:00.000Z",
        cursorStart: { value: "499" },
        cursorEnd: null,
        contentHash: "a".repeat(64),
        schemaFingerprint: "b".repeat(64),
        recordCount: 1,
        compressedBytes: 1,
        objectKeys: ["raw/test.jsonl.gz"],
      };
    },
  } as unknown as RawBatchWriter;
  const analytical = {
    version: "test-mapping",
    async land() {
      events.push("analytical-quarantine");
      return {
        stagedRecordCount: 0,
        resolved: [],
        quarantined: [{
          sourceObjectType: record.sourceObjectType,
          sourceRecordId: record.sourceRecordId,
          payloadHash: record.payloadHash,
          code: "schema_invalid",
          path: "$.JournalNumber",
          message: "JournalNumber must be a safe non-negative integer.",
        }],
      };
    },
    async recordConnectorStreamPage() { events.push("stream-quality"); },
    async publishCapabilityObservations() {
      throw new Error("blocked pagination must not publish capabilities");
    },
    async publishConnectorQualityResults() { events.push("quality-results"); return 1; },
    async refreshConnectorQualityRollup() { events.push("quality-rollup"); },
  } as unknown as AnalyticalLandingStore;
  const orchestrator = {
    async enqueue() { enqueued += 1; },
  } as unknown as SyncOrchestrator;
  const claim = {
    queueName: "albert_sync_standard",
    workerId: "worker-test",
    messageId: "41",
    readCount: 1,
    enqueuedAt: "2026-08-03T00:00:00.000Z",
    visibilityDeadline: "2026-08-03T00:15:00.000Z",
    job: {
      schemaVersion: 1,
      type: "IncrementalSync",
      tenantId: "01J00000000000000000000001",
      connectionId: "01J00000000000000000000002",
      connectionGeneration: 1,
      connectorId: "xero",
      externalAccountReference: "xero-tenant",
      syncRunId: "01J00000000000000000000003",
      batchId: "01J00000000000000000000004",
      requestedAt: "2026-08-03T00:00:00.000Z",
      jobRequestId: "01J00000000000000000000005",
      stream: "journals",
      cursor: { value: "499" },
      reason: "schedule",
    },
  } as const satisfies ClaimedSyncJob;
  const processor = new SyncJobProcessor(
    queue,
    orchestrator,
    { get: () => connector },
    control,
    analytical,
    rawWriter,
    "worker-test",
  );

  await processor.process(claim);

  assert.deepEqual(events.slice(0, 7), [
    "raw-written",
    "landing-started",
    "analytical-quarantine",
    "stream-quality",
    "quality-results",
    "control-quarantine",
    "quality-rollup",
  ]);
  assert.equal(failure?.code, "remote_response_invalid");
  assert.equal(failure?.retryable, false);
  assert.equal(committed, 0);
  assert.equal(completed, 0);
  assert.equal(enqueued, 0);
});

test("an unavailable optional stream terminates with durable evidence", async () => {
  let unavailableMarked = 0;
  let completed = 0;
  let retried = 0;
  const queue = {
    async complete() { completed += 1; },
    async retryOrFail() { retried += 1; return "retry_wait" as const; },
    async defer() { return new Date().toISOString(); },
  } as unknown as DurableSyncQueue;
  const control = {
    async beginRun() { return "run" as const; },
    async acquireSyncWritePermit() { return "01ARZ3NDEKTSV4RRFFQ69G5FAY"; },
    async releaseSyncWritePermit() {},
    async withSyncWritePermit(_claim: unknown, _permitId: string, operation: (capability: string) => Promise<unknown>) {
      return operation(`test-capability-${"x".repeat(100)}`);
    },
    async loadConnection() {
      return {
        tenantId: "tenant",
        connectionId: "connection",
        connectorKey: "xero" as const,
        externalAccountReference: "xero-tenant",
        credentialRef: "credential:test",
        connectionGeneration: 1,
      };
    },
    async getCursor() {
      return {
        cursor: null,
        backfillComplete: false,
        sourceWatermark: null,
        connectionGeneration: 0,
        coverage: null,
      };
    },
    async backfillPhase() {
      return { inheritedCoverage: null, required: false, strategy: "exhaustive_offset" as const };
    },
    async recordConnectionAuthHealth() {},
    async markOptionalBackfillUnavailable() { unavailableMarked += 1; },
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
      return [{
        id: "journals",
        label: "Journals",
        domains: ["finance"],
        cursorKind: "offset",
        backfillStrategy: "exhaustive_offset",
        availability: "optional",
      }];
    },
    async initial_sync() {
      throw new ConnectorError(
        "CAPABILITY_UNAVAILABLE",
        "Xero Advanced tier and journals scope are unavailable.",
        { retryable: false },
      );
    },
  } as unknown as ConnectorPack;
  const claim = {
    queueName: "albert_sync_backfill",
    workerId: "worker-test",
    messageId: "22",
    readCount: 1,
    enqueuedAt: "2026-08-03T00:00:00.000Z",
    visibilityDeadline: "2026-08-03T00:15:00.000Z",
    job: {
      schemaVersion: 1,
      type: "InitialBackfill",
      tenantId: "01J00000000000000000000001",
      connectionId: "01J00000000000000000000002",
      connectionGeneration: 1,
      connectorId: "xero",
      externalAccountReference: "xero-tenant",
      syncRunId: "01J00000000000000000000003",
      batchId: "01J00000000000000000000004",
      requestedAt: "2026-08-03T00:00:00.000Z",
      jobRequestId: "01J00000000000000000000005",
      stream: "journals",
      range: { from: "2026-07-03T00:00:00.000Z", to: "2026-08-03T00:00:00.000Z" },
      phase: "recent",
      replayVersion: 1,
      planMode: "single_pass",
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

  assert.equal(unavailableMarked, 1);
  assert.equal(completed, 1);
  assert.equal(retried, 0);
});

test("a verified reconnect uses inclusive modified-since sync instead of an event-date backfill", async () => {
  const priorWatermark = "2026-07-28T10:15:00.000Z";
  let initialCalled = 0;
  let incrementalCursor: Readonly<{ value: string; sourceUpdatedAt?: string }> | undefined;
  const queue = {
    async retryOrFail() { return "retry_wait" as const; },
    async defer() { return new Date().toISOString(); },
  } as unknown as DurableSyncQueue;
  const control = {
    async beginRun() { return "run" as const; },
    async acquireSyncWritePermit() { return "01ARZ3NDEKTSV4RRFFQ69G5FAY"; },
    async releaseSyncWritePermit() {},
    async withSyncWritePermit(_claim: unknown, _permitId: string, operation: (capability: string) => Promise<unknown>) {
      return operation(`test-capability-${"x".repeat(100)}`);
    },
    async loadConnection() {
      return {
        tenantId: "tenant",
        connectionId: "connection",
        connectorKey: "xero" as const,
        externalAccountReference: "xero-tenant",
        credentialRef: "credential:test",
        connectionGeneration: 2,
      };
    },
    async getCursor() {
      return {
        cursor: { value: "prior-generation-opaque-cursor", sourceUpdatedAt: priorWatermark },
        sourceWatermark: priorWatermark,
        backfillComplete: true,
        connectionGeneration: 1,
        coverage: {
          boundaryKind: "verified_oldest" as const,
          lowerBound: "2018-01-01T00:00:00.000Z",
          verification: "exhaustive_vendor_scan" as const,
        },
      };
    },
    async backfillPhase() {
      return {
        inheritedCoverage: {
          boundaryKind: "verified_oldest" as const,
          lowerBound: "2018-01-01T00:00:00.000Z",
          verification: "exhaustive_vendor_scan" as const,
        },
        required: true,
        strategy: "time_windowed" as const,
      };
    },
    async recordConnectionAuthHealth() {},
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
      return [{
        id: "invoices",
        label: "Invoices",
        domains: ["finance"],
        cursorKind: "page",
        backfillStrategy: "time_windowed",
        availability: "required",
      }];
    },
    async initial_sync() {
      initialCalled += 1;
      throw new Error("event-date backfill must not run");
    },
    async incremental_sync(
      _context: ConnectorContext,
      _stream: unknown,
      cursor: Readonly<{ value: string; sourceUpdatedAt?: string }>,
    ) {
      incrementalCursor = cursor;
      throw new ConnectorError("REMOTE_UNAVAILABLE", "Stop after selecting the path.", {
        retryable: true,
      });
    },
  } as unknown as ConnectorPack;
  const claim = {
    queueName: "albert_sync_backfill",
    workerId: "worker-test",
    messageId: "31",
    readCount: 1,
    enqueuedAt: "2026-08-03T00:00:00.000Z",
    visibilityDeadline: "2026-08-03T00:15:00.000Z",
    job: {
      schemaVersion: 1,
      type: "InitialBackfill",
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
      range: { from: priorWatermark, to: "2026-08-03T00:00:00.000Z" },
      phase: "recent",
      replayVersion: 1,
      planMode: "resume_verified",
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

  assert.equal(initialCalled, 0);
  assert.deepEqual(incrementalCursor, {
    value: "prior-generation-opaque-cursor",
    sourceUpdatedAt: priorWatermark,
  });
});
