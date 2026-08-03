import {
  ConnectorError,
  createDeadlineSignal,
  raceWithSignal,
  type ConnectorPack,
  type ConnectorStream,
  type RawSourceRecord,
  type SyncCursor as ConnectorCursor,
} from "../../../packages/connector-sdk/src/index.js";
import {
  type ClaimedSyncJob,
  type DurableSyncQueue,
  type SyncJob,
  type SyncOrchestrator,
} from "../../../packages/queue/src/index.js";
import {
  RawBatchWriter,
  type JsonValue,
  type RawBatchRecord,
} from "../../../packages/storage/src/index.js";
import { AnalyticalLandingStore } from "./analytical-store.js";
import { ControlPlaneStore } from "./control-plane-store.js";

const DEFAULT_OPERATION_TIMEOUT_MS = 12 * 60_000;
const MAX_QUEUE_RETRY_DELAY_SECONDS = 7 * 24 * 60 * 60;

export interface ConnectorRegistry {
  get(connectorId: SyncJob["connectorId"]): ConnectorPack;
}

function assertJson(value: unknown, path = "payload", depth = 0): asserts value is JsonValue {
  if (depth > 80) throw new Error(`${path}_too_deep`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJson(child, `${path}_${index}`, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((child) => assertJson(child, path, depth + 1));
    return;
  }
  throw new Error(`${path}_not_json`);
}

function rawRecord(record: RawSourceRecord): RawBatchRecord {
  assertJson(record.payload);
  return {
    sourceObjectType: record.sourceObjectType,
    sourceRecordId: record.sourceRecordId,
    sourceUpdatedAt: record.sourceUpdatedAt,
    payloadHash: record.payloadHash,
    payload: record.payload,
  };
}

function streamForJob(streams: readonly ConnectorStream[], job: SyncJob): ConnectorStream {
  const requested = "stream" in job ? job.stream : undefined;
  const stream = streams.find((candidate) => candidate.id === requested);
  if (!stream) throw new Error(`connector_stream_not_found:${requested ?? "none"}`);
  return stream;
}

function connectorError(error: unknown) {
  if (error instanceof ConnectorError) {
    return {
      code: error.code.toLowerCase(),
      retryable: error.retryable,
      detail: error.message,
      retryDelaySeconds: Math.min(
        MAX_QUEUE_RETRY_DELAY_SECONDS,
        Math.max(1, Math.ceil((error.retryAfterMs ?? 30_000) / 1_000)),
      ),
    } as const;
  }
  const message = error instanceof Error ? error.message : "unknown_sync_error";
  const configuration = /not_ready|mismatch|not_found|invalid/i.test(message);
  return {
    code: message.split(":", 1)[0]!.replace(/[^a-z0-9_.-]/gi, "_").toLowerCase(),
    retryable: !configuration,
    detail: message,
    retryDelaySeconds: 30,
  } as const;
}

export class SyncJobProcessor {
  private readonly operationTimeoutMs: number;
  private readonly xeroDailyRequestLimit: 1000 | 5000;

  constructor(
    private readonly queue: DurableSyncQueue,
    private readonly orchestrator: SyncOrchestrator,
    private readonly registry: ConnectorRegistry,
    private readonly control: ControlPlaneStore,
    private readonly analytical: AnalyticalLandingStore,
    private readonly rawWriter: RawBatchWriter,
    private readonly workerId: string,
    options: Readonly<{
      operationTimeoutMs?: number;
      xeroDailyRequestLimit?: 1000 | 5000;
    }> = {},
  ) {
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (!Number.isFinite(this.operationTimeoutMs) || this.operationTimeoutMs <= 0) {
      throw new Error("Sync operation timeout must be a positive duration.");
    }
    this.xeroDailyRequestLimit = options.xeroDailyRequestLimit ?? 1000;
  }

  async process(claim: ClaimedSyncJob, shutdownSignal?: AbortSignal): Promise<void> {
    const { job } = claim;
    const deadline = createDeadlineSignal(this.operationTimeoutMs);
    const deadlineSignal = deadline.signal;
    const operationSignal = shutdownSignal
      ? AbortSignal.any([shutdownSignal, deadlineSignal])
      : deadlineSignal;
    try {
      const run = await this.control.beginRun(job, claim.readCount);
      if (run === "already_succeeded") {
        await this.queue.complete(claim, { idempotentReplay: true });
        return;
      }
      const connection = await this.control.loadConnection(job);
      const connector = this.registry.get(job.connectorId);
      const context = {
        tenantId: job.tenantId,
        connectionId: job.connectionId,
        credentialRef: connection.credentialRef,
        abortSignal: operationSignal,
        vendorRateBudget: this.control.vendorRateBudget(
          job.tenantId,
          job.connectionId,
          job.connectorId,
          { xeroDailyRequestLimit: this.xeroDailyRequestLimit },
        ),
      } as const;
      const streams = [...(await this.connectorOperation(
        operationSignal,
        () => connector.list_streams(context),
      ))].sort(
        (left, right) => (left.priority ?? 100) - (right.priority ?? 100),
      );

      if (!("stream" in job) || !job.stream) {
        await this.fanOut(job, streams);
        await this.queue.extendVisibility(claim, 900);
        await this.control.completeCoordinatorRun(job, streams.length);
        await this.queue.complete(claim, { fanOutStreams: streams.length });
        return;
      }
      const stream = streamForJob(streams, job);
      const persisted = await this.control.getCursor(job.tenantId, job.connectionId, stream.id);
      let page;
      if (job.type === "InitialBackfill") {
        page = await this.connectorOperation(
          operationSignal,
          () => connector.initial_sync(context, stream, job.range, job.cursor),
        );
      } else if (job.type === "IncrementalSync") {
        const cursor = job.cursor ?? persisted.cursor;
        if (!cursor) {
          await this.orchestrator.enqueueInitialBackfill({
            tenantId: job.tenantId,
            connectionId: job.connectionId,
            connectorId: job.connectorId,
            externalAccountReference: job.externalAccountReference,
            stream: job.stream,
            range: {
              from: new Date(Date.now() - 31 * 86_400_000).toISOString(),
              to: new Date().toISOString(),
            },
            phase: "recent",
          }, { idempotencyKey: `missing-cursor:${job.tenantId}:${job.connectionId}:${job.stream}` });
          await this.queue.extendVisibility(claim, 900);
          await this.control.completeCoordinatorRun(job, 1);
          await this.queue.complete(claim, { replacedByInitialBackfill: true });
          return;
        }
        page = await this.connectorOperation(
          operationSignal,
          () => connector.incremental_sync(context, stream, cursor),
        );
      } else {
        page = await this.connectorOperation(
          operationSignal,
          () => connector.initial_sync(
            context,
            stream,
            { from: job.lookbackFrom, to: job.lookbackTo },
            job.cursor,
          ),
        );
      }
      if (page.hasMore && !page.nextCursor) {
        throw new Error("connector_page_missing_continuation_cursor");
      }

      const extractedAt = new Date().toISOString();
      operationSignal.throwIfAborted();
      await this.control.acquireSyncWritePermit(job, this.workerId);
      try {
        operationSignal.throwIfAborted();
        const manifest = await this.rawWriter.write(
          {
            tenantId: job.tenantId,
            connectionId: job.connectionId,
            syncRunId: job.syncRunId,
            batchId: job.batchId,
            connectorKey: job.connectorId,
            connectorVersion: connector.version,
            apiVersion: connector.apiVersion,
            externalAccountReference: job.externalAccountReference,
            stream: stream.id,
            extractedAt,
            cursorStart: ("cursor" in job ? job.cursor : null) as JsonValue | null,
            cursorEnd: page.nextCursor as JsonValue | null,
          },
          page.records.map(rawRecord),
        );
        await this.control.markLandingStarted(job.tenantId, job.batchId);
        operationSignal.throwIfAborted();
        const landing = await this.analytical.land(job, manifest, page.records);
        if (landing.quarantined.length > 0) {
          await this.control.recordQuarantineIndex({
            job,
            stream: stream.id,
            batchObjectKey: manifest.objectKeys[0],
            records: landing.quarantined,
          });
        }
        // Fence the control-plane commit against a lease that expired while the
        // vendor call or analytical landing was in flight. Raw/staging writes are
        // immutable and idempotent; cursors and readiness must never be advanced
        // by a superseded worker.
        operationSignal.throwIfAborted();
        await this.queue.extendVisibility(claim, 900);
        const finalCursor: ConnectorCursor = page.nextCursor ??
          ("cursor" in job && job.cursor ? job.cursor : persisted.cursor ?? { value: extractedAt });
        const backfillComplete =
          job.type === "InitialBackfill" && job.phase === "full_history" && !page.hasMore;
        // Publish successor work before marking this run successful. Publication
        // is idempotent, so a retry is harmless; committing first would leave a
        // crash window in which a completed page has no durable continuation.
        if (page.hasMore && page.nextCursor) await this.enqueueContinuation(job, page.nextCursor);
        if (!page.hasMore && job.type === "InitialBackfill") {
          await this.enqueueNextBackfillPhase(job);
        }
        await this.control.commitPage({
          job,
          cursor: finalCursor,
          sourceWatermark: finalCursor.sourceUpdatedAt,
          hasMore: page.hasMore,
          recordCount: landing.stagedRecordCount,
          quarantineCount: landing.quarantined.length,
          domains: stream.domains,
          backfillComplete,
          mappingVersion: this.analytical.version,
        });
        await this.queue.complete(claim, {
          batchId: job.batchId,
          stagedRecordCount: landing.stagedRecordCount,
          quarantineCount: landing.quarantined.length,
          continuationEnqueued: page.hasMore,
        });
      } finally {
        await this.control.releaseSyncWritePermit(job, this.workerId).catch(() => undefined);
      }
    } catch (error) {
      const failure = connectorError(error);
      await this.control.markRunFailed(
        job,
        claim.readCount,
        failure.code,
        failure.detail,
      ).catch(() => undefined);
      if (failure.code === "rate_limited" && failure.retryable) {
        await this.queue.defer(
          claim,
          { code: failure.code, detail: failure.detail },
          failure.retryDelaySeconds,
        );
      } else {
        await this.queue.retryOrFail(
          claim,
          { code: failure.code, retryable: failure.retryable, detail: failure.detail },
          { retryDelaySeconds: failure.retryDelaySeconds, maxAttempts: 8 },
        );
      }
    } finally {
      deadline.clear();
    }
  }

  private async connectorOperation<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await raceWithSignal(operation, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      throw new ConnectorError(
        "REMOTE_UNAVAILABLE",
        "The connector operation exceeded its execution deadline.",
        { retryable: true, cause: error },
      );
    }
  }

  private async fanOut(job: SyncJob, streams: readonly ConnectorStream[]) {
    for (const stream of streams) {
      if (job.type === "InitialBackfill") {
        await this.orchestrator.enqueueInitialBackfill({
          tenantId: job.tenantId,
          connectionId: job.connectionId,
          connectorId: job.connectorId,
          externalAccountReference: job.externalAccountReference,
          stream: stream.id,
          range: job.range,
          cursor: job.cursor,
          phase: job.phase,
        });
      } else if (job.type === "ReconciliationSweep") {
        await this.orchestrator.enqueueReconciliationSweep({
          tenantId: job.tenantId,
          connectionId: job.connectionId,
          connectorId: job.connectorId,
          externalAccountReference: job.externalAccountReference,
          stream: stream.id,
          lookbackFrom: job.lookbackFrom,
          lookbackTo: job.lookbackTo,
        });
      } else {
        throw new Error("incremental_sync_requires_stream");
      }
    }
  }

  private async enqueueContinuation(job: SyncJob, cursor: ConnectorCursor) {
    if (job.type === "InitialBackfill") {
      await this.orchestrator.enqueueInitialBackfill({
        tenantId: job.tenantId,
        connectionId: job.connectionId,
        connectorId: job.connectorId,
        externalAccountReference: job.externalAccountReference,
        stream: job.stream,
        range: job.range,
        cursor,
        phase: job.phase,
      });
    } else if (job.type === "IncrementalSync") {
      await this.orchestrator.enqueueIncrementalSync({
        tenantId: job.tenantId,
        connectionId: job.connectionId,
        connectorId: job.connectorId,
        externalAccountReference: job.externalAccountReference,
        stream: job.stream,
        cursor,
        reason: "continuation",
      });
    } else {
      await this.orchestrator.enqueueReconciliationSweep({
        tenantId: job.tenantId,
        connectionId: job.connectionId,
        connectorId: job.connectorId,
        externalAccountReference: job.externalAccountReference,
        stream: job.stream,
        cursor,
        lookbackFrom: job.lookbackFrom,
        lookbackTo: job.lookbackTo,
      }, { idempotencyKey: `reconciliation-continuation:${job.tenantId}:${job.connectionId}:${job.stream}:${cursor.value}` });
    }
  }

  private async enqueueNextBackfillPhase(job: Extract<SyncJob, { type: "InitialBackfill" }>) {
    if (job.phase === "full_history") return;
    const nextPhase = job.phase === "recent" ? "thirteen_months" : "full_history";
    const nextRange = job.phase === "recent"
      ? {
          from: (() => {
            const boundary = new Date(job.range.to);
            boundary.setUTCMonth(boundary.getUTCMonth() - 13);
            return boundary.toISOString();
          })(),
          to: job.range.from,
        }
      : { from: "1970-01-01T00:00:00.000Z", to: job.range.from };
    if (Date.parse(nextRange.from) >= Date.parse(nextRange.to)) return;
    await this.orchestrator.enqueueInitialBackfill({
      tenantId: job.tenantId,
      connectionId: job.connectionId,
      connectorId: job.connectorId,
      externalAccountReference: job.externalAccountReference,
      stream: job.stream,
      range: nextRange,
      phase: nextPhase,
    }, {
      idempotencyKey: `backfill-phase:${job.tenantId}:${job.connectionId}:${job.stream}:${nextPhase}`,
    });
  }
}
