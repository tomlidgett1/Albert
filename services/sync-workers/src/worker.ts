import {
  ConnectorError,
  ConnectorHttpError,
  createDeadlineSignal,
  hashPayload,
  raceWithSignal,
  type ConnectionHealth,
  type ConnectorPack,
  type ConnectorStream,
  type RawSourceRecord,
  type SyncCursor as ConnectorCursor,
} from "../../../packages/connector-sdk/src/index.js";
import {
  asSyncFailureCode,
  type ClaimedSyncJob,
  type DurableSyncQueue,
  type SyncFailureCode,
  type SyncJob,
  type SyncOrchestrator,
} from "../../../packages/queue/src/index.js";
import {
  type JsonValue,
  type RawBatchRecord,
} from "../../../packages/storage/src/index.js";
import { AnalyticalLandingStore } from "./analytical-store.js";
import type { ReconciliationTombstoneCandidate } from "./analytical-store.js";
import {
  ControlPlaneStore,
  type PersistedConnectionAuthHealth,
} from "./control-plane-store.js";
import { buildConnectorQualityResults } from "./connector-quality.js";
import {
  buildBackfillPlan,
  phaseCompletesBackfill,
  type BackfillPhasePlan,
} from "./sync-lifecycle.js";
import { appendVerifiedWebhookTombstones } from "./webhook-tombstones.js";
import type { SyncRawWriter } from "./raw-storage.js";

const DEFAULT_OPERATION_TIMEOUT_MS = 12 * 60_000;
const MAX_QUEUE_RETRY_DELAY_SECONDS = 7 * 24 * 60 * 60;

export type SyncFailureEvidence = Readonly<{
  code: SyncFailureCode;
  retryable: boolean;
  retryDelaySeconds: number;
}>;

export type SyncProcessOutcome =
  | Readonly<{ status: "completed" }>
  | Readonly<{
      status: "retry_scheduled" | "failed";
      failure: Readonly<{ code: SyncFailureCode; retryable: boolean }>;
      retryDelaySeconds: number;
    }>;

const DATABASE_FAILURE_CODES: Readonly<
  Record<string, Readonly<{ code: SyncFailureCode; retryable: boolean }>>
> = Object.freeze({
  "40001": Object.freeze({ code: "database_serialization_conflict", retryable: true }),
  "40P01": Object.freeze({ code: "database_deadlock", retryable: true }),
  "42501": Object.freeze({ code: "database_permission_denied", retryable: false }),
  "57P01": Object.freeze({ code: "database_unavailable", retryable: true }),
  "08000": Object.freeze({ code: "database_unavailable", retryable: true }),
  "08003": Object.freeze({ code: "database_unavailable", retryable: true }),
  "08006": Object.freeze({ code: "database_unavailable", retryable: true }),
  "23503": Object.freeze({ code: "database_integrity_violation", retryable: false }),
  "23505": Object.freeze({ code: "database_integrity_violation", retryable: false }),
});

const TRANSIENT_RUNTIME_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

const INTERNAL_FAILURE_CODES: Readonly<
  Record<string, Readonly<{ retryable: boolean; retryDelaySeconds?: number }>>
> = Object.freeze({
  backfill_completion_evidence_missing: Object.freeze({ retryable: false }),
  backfill_continuation_requires_stream: Object.freeze({ retryable: false }),
  backfill_plan_requires_coordinator: Object.freeze({ retryable: false }),
  backfill_phase_requires_stream: Object.freeze({ retryable: false }),
  backfill_successor_requires_stream: Object.freeze({ retryable: false }),
  connection_account_mismatch: Object.freeze({ retryable: false }),
  connection_generation_stale: Object.freeze({ retryable: false }),
  connection_not_ready: Object.freeze({ retryable: false }),
  connector_page_invalid_pagination_block: Object.freeze({ retryable: false }),
  connector_page_missing_continuation_cursor: Object.freeze({ retryable: false }),
  connector_page_non_advancing_cursor: Object.freeze({ retryable: false }),
  connector_stream_not_found: Object.freeze({ retryable: false }),
  incremental_sync_requires_stream: Object.freeze({ retryable: false }),
  reconnect_modified_watermark_missing: Object.freeze({ retryable: false }),
  reconciliation_snapshot_failed: Object.freeze({ retryable: false }),
  reconciliation_snapshot_incomplete: Object.freeze({ retryable: false }),
  sync_analytical_capability_invalid: Object.freeze({ retryable: false }),
  sync_stream_phase_lease_stale: Object.freeze({ retryable: true, retryDelaySeconds: 15 }),
  sync_write_permit_invalid: Object.freeze({ retryable: false }),
  sync_write_permit_missing: Object.freeze({ retryable: false }),
});

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

export function manifestBackfillStreams(connector: ConnectorPack): readonly ConnectorStream[] {
  // ConnectorPack.manifest is mandatory in production. The defensive empty
  // fallback keeps a rolling test/double compatible; normal fan-out still
  // registers the live list after a successful connection check.
  const contracts = connector.manifest?.streams;
  if (!contracts) return [];
  return contracts.map((stream) => ({
    id: stream.id,
    label: stream.resource,
    domains: stream.productDomains,
    cursorKind: stream.pagination === "offset"
      ? "offset" as const
      : stream.modifiedField
        ? "high_water_mark" as const
        : stream.pagination === "none"
          ? "none" as const
          : "page" as const,
    backfillStrategy: stream.backfillStrategy,
    lateEditStrategy: stream.lateEditStrategy,
    deletionStrategy: stream.deletionStrategy,
    sourceTotalStrategy: stream.sourceTotalStrategy,
    availability: stream.availability ?? "required",
    dependencies: stream.dependencies,
    productDomains: stream.productDomains,
  }));
}

/** Reduce arbitrary exceptions to a bounded code-only operational record. */
export function syncFailure(error: unknown): SyncFailureEvidence {
  if (error instanceof ConnectorError) {
    const code = asSyncFailureCode(error.code.toLowerCase());
    return Object.freeze({
      code,
      retryable: code === "unexpected_sync_failure" ? true : error.retryable,
      retryDelaySeconds: Math.min(
        MAX_QUEUE_RETRY_DELAY_SECONDS,
        Math.max(1, Math.ceil((error.retryAfterMs ?? 30_000) / 1_000)),
      ),
    });
  }
  if (error && typeof error === "object") {
    const candidate = error as Readonly<{ code?: unknown; name?: unknown }>;
    if (typeof candidate.code === "string") {
      const databaseFailure = DATABASE_FAILURE_CODES[candidate.code];
      if (databaseFailure) {
        return Object.freeze({
          ...databaseFailure,
          retryDelaySeconds: databaseFailure.retryable ? 30 : 1,
        });
      }
      if (TRANSIENT_RUNTIME_CODES.has(candidate.code)) {
        return Object.freeze({
          code: "remote_unavailable",
          retryable: true,
          retryDelaySeconds: 30,
        });
      }
    }
    if (candidate.name === "AbortError" || candidate.name === "TimeoutError") {
      return Object.freeze({
        code: "sync_operation_timeout",
        retryable: true,
        retryDelaySeconds: 30,
      });
    }
    if (candidate.name === "TypeError" || candidate.name === "SyntaxError") {
      return Object.freeze({
        code: "sync_internal_error",
        retryable: false,
        retryDelaySeconds: 1,
      });
    }
  }
  const candidate = error instanceof Error
    ? error.message.split(":", 1)[0]!.trim().toLowerCase()
    : "";
  const internal = INTERNAL_FAILURE_CODES[candidate];
  if (internal) {
    return Object.freeze({
      code: asSyncFailureCode(candidate),
      retryable: internal.retryable,
      retryDelaySeconds: internal.retryDelaySeconds ?? (internal.retryable ? 30 : 1),
    });
  }
  return Object.freeze({
    code: "unexpected_sync_failure",
    retryable: true,
    retryDelaySeconds: 30,
  });
}

function persistedAuthHealth(health: ConnectionHealth): PersistedConnectionAuthHealth {
  return health === "degraded" ? "error" : health;
}

function authHealthForFailure(
  error: unknown,
  connectionCheckInFlight: boolean,
): PersistedConnectionAuthHealth | null {
  if (error instanceof ConnectorHttpError) {
    if (error.status === 401) return "expired";
    if (error.status === 403) return "error";
    // A 400 during check_connection is normally an OAuth refresh rejection.
    // Outside that bounded check, a vendor 400 can be an ordinary query error.
    if (connectionCheckInFlight && error.status === 400) return "expired";
  }
  if (error instanceof ConnectorError) {
    const observed = error.details?.authHealth;
    if (observed === "expired" || observed === "revoked") return observed;
    if (error.code === "AUTHENTICATION_REQUIRED" || error.code === "OAUTH_EXCHANGE_FAILED") {
      return "expired";
    }
  }
  return connectionCheckInFlight ? "error" : null;
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
    private readonly rawWriter: SyncRawWriter,
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

  async process(
    claim: ClaimedSyncJob,
    shutdownSignal?: AbortSignal,
  ): Promise<SyncProcessOutcome> {
    const { job } = claim;
    const deadline = createDeadlineSignal(this.operationTimeoutMs);
    const deadlineSignal = deadline.signal;
    const operationSignal = shutdownSignal
      ? AbortSignal.any([shutdownSignal, deadlineSignal])
      : deadlineSignal;
    let connectionCheckInFlight = false;
    let activeStream: ConnectorStream | null = null;
    let activeBackfillPhase: Awaited<ReturnType<ControlPlaneStore["backfillPhase"]>> | null = null;
    let writePermitId: string | null = null;
    const withWriteFence = async <T>(operation: (capability: string) => Promise<T>): Promise<T> => {
      if (!writePermitId) throw new Error("sync_write_permit_missing");
      return this.control.withSyncWritePermit(claim, writePermitId, operation);
    };
    try {
      const run = await this.control.beginRun(job, claim.readCount);
      if (run === "already_succeeded") {
        await this.queue.complete(claim, { idempotentReplay: true });
        return Object.freeze({ status: "completed" });
      }
      writePermitId = await this.control.acquireSyncWritePermit(claim);
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
      const expectedStreams = manifestBackfillStreams(connector);
      connectionCheckInFlight = true;
      const connectionHealth = await this.connectorOperation(
        operationSignal,
        () => connector.check_connection(context),
      );
      connectionCheckInFlight = false;
      await this.control.recordConnectionAuthHealth(claim, persistedAuthHealth(connectionHealth));
      if (connectionHealth === "expired" || connectionHealth === "revoked") {
        throw new ConnectorError(
          "AUTHENTICATION_REQUIRED",
          `The ${connector.id} connection requires authorisation before sync can continue.`,
          { details: { authHealth: connectionHealth } },
        );
      }
      // Once the connection probe succeeds, persist the complete manifest
      // expectation set before extraction/fan-out. A revoked credential must
      // still have its auth health durably recorded even if analytics is down.
      if (expectedStreams.length > 0) {
        await withWriteFence((capability) =>
          this.analytical.registerConnectorStreams({ job, streams: expectedStreams }, capability));
      }
      const coordinatorBackfillPlans =
        job.type === "InitialBackfill" && !job.stream && expectedStreams.length > 0
        ? await this.prepareBackfillPlans(job, expectedStreams)
        : null;
      if (job.type === "ReconciliationSweep" && !job.stream) {
        await this.control.registerReconciliationPlan(job, expectedStreams);
      }
      const streams = [...(await this.connectorOperation(
        operationSignal,
        () => connector.list_streams(context),
      ))].sort(
        (left, right) => (left.priority ?? 100) - (right.priority ?? 100),
      );
      if (!("stream" in job) || !job.stream) {
        await this.fanOut(job, streams, coordinatorBackfillPlans);
        await this.queue.extendVisibility(claim, 900);
        await this.control.completeCoordinatorRun(job, streams.length);
        await this.queue.complete(claim, { fanOutStreams: streams.length });
        return Object.freeze({ status: "completed" });
      }
      const stream = streamForJob(streams, job);
      activeStream = stream;
      if (job.type === "ReconciliationSweep") {
        const acquired = await this.control.beginReconciliationPhase(claim as ClaimedSyncJob & {
          job: Extract<SyncJob, { type: "ReconciliationSweep" }>;
        });
        if (!acquired) {
          await this.control.completeCoordinatorRun(job, 0);
          await this.queue.complete(claim, { idempotentPhaseReplay: true });
          return Object.freeze({ status: "completed" });
        }
      }
      if (job.type === "InitialBackfill") {
        activeBackfillPhase = await this.control.backfillPhase(job);
      }
      const persisted = await this.control.getCursor(job.tenantId, job.connectionId, stream.id);
      let reconciliationCandidates: Awaited<ReturnType<AnalyticalLandingStore["reconciliationTombstoneCandidates"]>> = [];
      let page;
      if (job.type === "InitialBackfill") {
        if (job.planMode === "resume_verified") {
          const reconnectCursor = job.cursor ?? (
            persisted.connectionGeneration === job.connectionGeneration - 1
              ? persisted.cursor
              : null
          );
          if (
            !reconnectCursor ||
            (!job.cursor && reconnectCursor.sourceUpdatedAt !== job.range.from)
          ) {
            throw new Error("reconnect_modified_watermark_missing");
          }
          // Reauthorisation catch-up must use the connector's inclusive
          // modified-since path. An initial-sync date window would miss an old
          // invoice, sale or timesheet edited after the prior watermark.
          page = await this.connectorOperation(
            operationSignal,
            () => connector.incremental_sync(context, stream, reconnectCursor),
          );
        } else {
          page = await this.connectorOperation(
            operationSignal,
            () => connector.initial_sync(context, stream, job.range, job.cursor),
          );
        }
      } else if (job.type === "IncrementalSync") {
        const cursor = job.cursor ?? (
          persisted.connectionGeneration === job.connectionGeneration ? persisted.cursor : null
        );
        if (!cursor) {
          await this.orchestrator.enqueueInitialBackfill({
            tenantId: job.tenantId,
            connectionId: job.connectionId,
            connectorId: job.connectorId,
            externalAccountReference: job.externalAccountReference,
            connectionGeneration: job.connectionGeneration,
            range: {
              from: new Date(Date.now() - 31 * 86_400_000).toISOString(),
              to: new Date().toISOString(),
            },
            phase: "recent",
            replayVersion: 1,
            planMode: "progressive",
          }, { idempotencyKey: `missing-cursor:${job.tenantId}:${job.connectionId}:g${job.connectionGeneration}:${job.stream}` });
          await this.queue.extendVisibility(claim, 900);
          await this.control.completeCoordinatorRun(job, 1);
          await this.queue.complete(claim, { replacedByInitialBackfill: true });
          return Object.freeze({ status: "completed" });
        }
        page = await this.connectorOperation(
          operationSignal,
          () => connector.incremental_sync(context, stream, cursor),
        );
      } else if (job.type === "ReconciliationSweep" && job.phase === "apply_tombstones") {
        reconciliationCandidates = await withWriteFence((capability) =>
          this.analytical.reconciliationTombstoneCandidates({
            job,
            ...(job.cursor ? { afterKey: job.cursor.value } : {}),
            limit: 500,
          }, capability));
        const records = reconciliationCandidates.map((candidate) =>
          reconciliationTombstoneRecord(job, candidate)
        );
        page = {
          records,
          nextCursor: records.length === 500
            ? { value: reconciliationCandidates.at(-1)!.namespacedSourceKey }
            : null,
          hasMore: records.length === 500,
          sourceTotal: records.length,
        };
      } else {
        page = await this.connectorOperation(
          operationSignal,
          () => connector.reconciliation_sync(context, stream, {
            phase: job.phase as "late_edits" | "identity_snapshot" | "verify_snapshot",
            range: { from: job.lookbackFrom, to: job.lookbackTo },
            ...(job.cursor ? { cursor: job.cursor } : {}),
          }),
        );
      }
      if (job.type === "IncrementalSync" && job.webhookTombstones?.length) {
        page = {
          ...page,
          records: appendVerifiedWebhookTombstones({
            job,
            manifest: connector.manifest,
            records: page.records,
          }),
        };
      }
      if (page.hasMore && !page.nextCursor && !page.paginationBlock) {
        throw new Error("connector_page_missing_continuation_cursor");
      }
      if (page.paginationBlock && (!page.hasMore || page.nextCursor)) {
        throw new Error("connector_page_invalid_pagination_block");
      }
      if (
        page.hasMore &&
        page.nextCursor &&
        "cursor" in job &&
        job.cursor?.value === page.nextCursor.value
      ) {
        throw new Error("connector_page_non_advancing_cursor");
      }

      // The queue payload is the durable identity of this extraction attempt.
      // Reusing its request timestamp keeps the immutable raw object key stable
      // when a leased job is killed and replayed on a later UTC date.
      const extractedAt = job.requestedAt;
      operationSignal.throwIfAborted();
      {
        operationSignal.throwIfAborted();
        const manifest = await withWriteFence(() => this.rawWriter.write(
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
            { permitId: writePermitId!, workerId: claim.workerId },
          ));
        await this.control.markLandingStarted(job.tenantId, job.batchId);
        operationSignal.throwIfAborted();
        const landing = await withWriteFence((capability) =>
          this.analytical.land(job, manifest, page.records, capability));
        if (landing.resolved.length > 0) {
          await this.control.resolveQuarantineIndex({
            claim,
            permitId:writePermitId,
            stream:stream.id,
            records:landing.resolved,
          });
        }
        const completion = job.type === "InitialBackfill" && !page.hasMore
          ? phaseCompletesBackfill(job, page.coverage, activeBackfillPhase?.inheritedCoverage)
          : { complete: false, coverage: null };
        const expectsCompletionEvidence = job.type === "InitialBackfill" && !page.hasMore &&
          (job.planMode !== "progressive" || job.phase === "full_history");
        if (expectsCompletionEvidence && !completion.complete) {
          throw new Error("backfill_completion_evidence_missing");
        }
        const backfillComplete = completion.complete;
        let reconciliationSnapshot: Awaited<ReturnType<AnalyticalLandingStore["recordReconciliationSnapshotPage"]>> | null = null;
        let applicationsInBatch = 0;
        if (
          job.type === "ReconciliationSweep" &&
          (job.phase === "identity_snapshot" || job.phase === "verify_snapshot")
        ) {
          reconciliationSnapshot = await withWriteFence((capability) =>
            this.analytical.recordReconciliationSnapshotPage({
              job,stream,records:page.records,landing,hasMore:page.hasMore,
              ...(page.sourceTotal === undefined ? {} : { sourceTotal: page.sourceTotal }),
            }, capability));
          if (!page.hasMore && reconciliationSnapshot.status !== "complete") {
            throw new Error(`reconciliation_snapshot_${reconciliationSnapshot.status}`);
          }
        }
        if (job.type === "ReconciliationSweep" && job.phase === "apply_tombstones") {
          applicationsInBatch = await withWriteFence((capability) =>
            this.analytical.recordReconciliationTombstoneApplications({
              job,candidates:reconciliationCandidates,
            }, capability));
        }
        await withWriteFence((capability) => this.analytical.recordConnectorStreamPage({
            job,stream:stream.id,records:page.records,landing,hasMore:page.hasMore,
            nextCursorPresent:page.nextCursor !== null,backfillComplete,
            coverage:completion.coverage,
            ...(page.sourceTotal === undefined ? {} : { sourceTotal:page.sourceTotal }),
          }, capability));
        const capabilityObservations = (await this.connectorOperation(
          operationSignal,
          () => connector.describe_capabilities(context),
        )).filter((observation) =>
          connector.manifest.capabilities[observation.id]?.streams.includes(stream.id),
        );
        if (!page.paginationBlock) await withWriteFence((capability) => this.analytical.publishCapabilityObservations({
            job,
            packVersion: connector.version,
            stream: stream.id,
            sourceWatermark: latestSourceWatermark(page.records, extractedAt),
            recordCount: landing.stagedRecordCount,
            observations: capabilityObservations,
          }, capability));
        await withWriteFence((capability) => this.analytical.publishConnectorQualityResults({
            job,
            stream:stream.id,
            results:buildConnectorQualityResults({
              job,records:page.records,stagedRecordCount:landing.stagedRecordCount,
              quarantineCount:landing.quarantined.length,hasMore:page.hasMore,
              nextCursor:page.nextCursor,capabilities:capabilityObservations,
            }),
          }, capability));
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
        // Publish successor work before marking this run successful. Publication
        // is idempotent, so a retry is harmless; committing first would leave a
        // crash window in which a completed page has no durable continuation.
        if (page.hasMore && page.nextCursor) await this.enqueueContinuation(job, page.nextCursor);
        if (!page.hasMore && job.type === "InitialBackfill") {
          await this.enqueueNextBackfillPhase(job);
        }
        let totalApplied = applicationsInBatch;
        let reconciliationPhaseEvidence: Readonly<Record<string, unknown>> | null = null;
        if (!page.hasMore && job.type === "ReconciliationSweep") {
          if (job.phase === "apply_tombstones") {
            totalApplied = await withWriteFence((capability) =>
              this.analytical.completeConnectorReconciliation(job, capability));
          }
          await this.enqueueNextReconciliationPhase(job);
          reconciliationPhaseEvidence = {
            batchId:job.batchId,
            recordCount:landing.stagedRecordCount,
            quarantineCount:landing.quarantined.length,
            ...(reconciliationSnapshot ? {
              snapshotStatus:reconciliationSnapshot.status,
              uniqueCount:reconciliationSnapshot.uniqueCount,
              sourceTotal:reconciliationSnapshot.sourceTotal ?? null,
              membershipDeltaCount:reconciliationSnapshot.membershipDeltaCount ?? 0,
            } : {}),
            ...(job.phase === "apply_tombstones" ? {
              applicationsInBatch,totalApplied,
            } : {}),
          };
        }
        // Page-local "not observed" warnings can never overwrite the durable
        // worst-state roll-up for all current-generation required streams.
        await withWriteFence((capability) =>
          this.analytical.refreshConnectorQualityRollup(job, capability));
        if (page.paginationBlock) {
          throw new ConnectorError(
            "REMOTE_RESPONSE_INVALID",
            page.paginationBlock.detail,
            {
              retryable: false,
              details: { stream: stream.id, reason: page.paginationBlock.code },
            },
          );
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
          coverage: completion.coverage,
          mappingVersion: this.analytical.version,
          ...(reconciliationPhaseEvidence && job.type === "ReconciliationSweep" ? {
            reconciliationTransition: {
              claim: claim as ClaimedSyncJob & {
                job: Extract<SyncJob, { type: "ReconciliationSweep" }>;
              },
              evidence: reconciliationPhaseEvidence,
            },
          } : {}),
        });
        await this.queue.complete(claim, {
          batchId: job.batchId,
          stagedRecordCount: landing.stagedRecordCount,
          quarantineCount: landing.quarantined.length,
          continuationEnqueued: page.hasMore,
        });
        return Object.freeze({ status: "completed" });
      }
    } catch (error) {
      const authHealth = authHealthForFailure(error, connectionCheckInFlight);
      if (authHealth) {
        await this.control.recordConnectionAuthHealth(claim, authHealth).catch(() => undefined);
      }
      const failure = syncFailure(error);
      if (
        failure.code === "capability_unavailable" &&
        job.type === "ReconciliationSweep" &&
        activeStream?.availability === "optional"
      ) {
        await this.control.blockReconciliationPhase(claim as ClaimedSyncJob & {
          job: Extract<SyncJob, { type: "ReconciliationSweep" }>;
        }, {
          code: failure.code,
          retryable: failure.retryable,
          optional: true,
        });
        await this.control.completeCoordinatorRun(job, 0);
        await this.queue.complete(claim, { streamUnavailable:true,optional:true });
        return Object.freeze({ status: "completed" });
      } else if (
        failure.code === "capability_unavailable" &&
        job.type === "InitialBackfill" &&
        job.stream &&
        activeStream?.availability === "optional" &&
        activeBackfillPhase?.required === false
      ) {
        await this.control.markOptionalBackfillUnavailable(job, failure);
        await this.queue.complete(claim, {
          streamUnavailable: true,
          reasonCode: "capability_unavailable",
        });
        return Object.freeze({ status: "completed" });
      } else if (failure.code === "rate_limited" && failure.retryable) {
        await this.control.markRunFailed(
          job, claim.readCount, failure.code, false,
        ).catch(() => undefined);
        await this.queue.defer(
          claim,
          { code: failure.code },
          failure.retryDelaySeconds,
        );
        return Object.freeze({
          status: "retry_scheduled",
          failure: Object.freeze({ code: failure.code, retryable: true }),
          retryDelaySeconds: failure.retryDelaySeconds,
        });
      } else {
        if (
          job.type === "ReconciliationSweep" && job.stream &&
          (!failure.retryable || claim.readCount >= 8)
        ) {
          await this.control.blockReconciliationPhase(claim as ClaimedSyncJob & {
            job: Extract<SyncJob, { type: "ReconciliationSweep" }>;
          }, {
            code: failure.code,
            retryable: failure.retryable,
            attempt: claim.readCount,
          }).catch(() => undefined);
        }
        const outcome = await this.queue.retryOrFail(
          claim,
          { code: failure.code, retryable: failure.retryable },
          { retryDelaySeconds: failure.retryDelaySeconds, maxAttempts: 8 },
        );
        await this.control.markRunFailed(
          job,
          claim.readCount,
          failure.code,
          outcome === "failed",
        ).catch(() => undefined);
        return Object.freeze({
          status: outcome === "retry_wait" ? "retry_scheduled" : "failed",
          failure: Object.freeze({
            code: failure.code,
            retryable: outcome === "retry_wait",
          }),
          retryDelaySeconds: failure.retryDelaySeconds,
        });
      }
    } finally {
      if (writePermitId) {
        await this.control.releaseSyncWritePermit(
          job.tenantId,writePermitId,this.workerId,
        ).catch(() => undefined);
      }
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

  private async prepareBackfillPlans(
    job: Extract<SyncJob, { type: "InitialBackfill" }>,
    streams: readonly ConnectorStream[],
  ): Promise<readonly BackfillPhasePlan[]> {
    const plans: BackfillPhasePlan[] = [];
    for (const stream of streams) {
      const previous = await this.control.getCursor(job.tenantId, job.connectionId, stream.id);
      plans.push(...buildBackfillPlan(job, stream, previous));
    }
    await this.control.registerBackfillPlan(job, plans);
    return plans;
  }

  private async fanOut(
    job: SyncJob,
    streams: readonly ConnectorStream[],
    registeredBackfillPlans: readonly BackfillPhasePlan[] | null,
  ) {
    if (job.type === "InitialBackfill") {
      const plans = registeredBackfillPlans ?? await this.prepareBackfillPlans(job, streams);
      for (const plan of plans.filter((candidate) => candidate.phase === "recent")) {
        const jobRequestId = await this.orchestrator.enqueueInitialBackfill({
          tenantId: job.tenantId,
          connectionId: job.connectionId,
          connectionGeneration: job.connectionGeneration,
          connectorId: job.connectorId,
          externalAccountReference: job.externalAccountReference,
          stream: plan.stream,
          range: plan.range,
          phase: plan.phase,
          replayVersion: plan.replayVersion,
          planMode: plan.planMode,
        }, {
          idempotencyKey: `backfill-phase:${job.connectionId}:g${job.connectionGeneration}:${plan.stream}:${plan.phase}:v${plan.replayVersion}`,
        });
        await this.control.markBackfillPhaseEnqueued({
          job,
          stream: plan.stream,
          phase: plan.phase,
          replayVersion: plan.replayVersion,
          jobRequestId,
        });
      }
      return;
    }
    for (const stream of streams) {
      if (job.type === "ReconciliationSweep") {
        await this.orchestrator.enqueueReconciliationSweep({
          tenantId: job.tenantId,
          connectionId: job.connectionId,
          connectionGeneration: job.connectionGeneration,
          connectorId: job.connectorId,
          externalAccountReference: job.externalAccountReference,
          stream: stream.id,
          reconciliationSweepId: job.reconciliationSweepId,
          phase: "late_edits",
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
      const jobRequestId = await this.orchestrator.enqueueInitialBackfill({
        tenantId: job.tenantId,
        connectionId: job.connectionId,
        connectionGeneration: job.connectionGeneration,
        connectorId: job.connectorId,
        externalAccountReference: job.externalAccountReference,
        stream: job.stream,
        range: job.range,
        cursor,
        phase: job.phase,
        replayVersion: job.replayVersion,
        planMode: job.planMode,
      });
      if (!job.stream) throw new Error("backfill_continuation_requires_stream");
      await this.control.markBackfillPhaseEnqueued({
        job,
        stream: job.stream,
        phase: job.phase,
        replayVersion: job.replayVersion,
        jobRequestId,
      });
    } else if (job.type === "IncrementalSync") {
      await this.orchestrator.enqueueIncrementalSync({
        tenantId: job.tenantId,
        connectionId: job.connectionId,
        connectionGeneration: job.connectionGeneration,
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
        connectionGeneration: job.connectionGeneration,
        connectorId: job.connectorId,
        externalAccountReference: job.externalAccountReference,
        stream: job.stream,
        reconciliationSweepId: job.reconciliationSweepId,
        phase: job.phase,
        cursor,
        lookbackFrom: job.lookbackFrom,
        lookbackTo: job.lookbackTo,
      }, {
        idempotencyKey:`reconciliation-continuation:${job.connectionId}:g${job.connectionGeneration}:${job.reconciliationSweepId}:${job.stream}:${job.phase}:${cursor.value}`,
      });
    }
  }

  private async enqueueNextBackfillPhase(job: Extract<SyncJob, { type: "InitialBackfill" }>) {
    const next = await this.control.nextBackfillPhase(job);
    if (!next) return;
    const jobRequestId = await this.orchestrator.enqueueInitialBackfill({
      tenantId: job.tenantId,
      connectionId: job.connectionId,
      connectionGeneration: job.connectionGeneration,
      connectorId: job.connectorId,
      externalAccountReference: job.externalAccountReference,
      stream: job.stream,
      range: next.range,
      phase: next.phase,
      replayVersion: next.replayVersion,
      planMode: next.planMode,
    }, {
      delaySeconds: 30,
      idempotencyKey: `backfill-phase:${job.connectionId}:g${job.connectionGeneration}:${job.stream}:${next.phase}:v${next.replayVersion}`,
    });
    if (!job.stream) throw new Error("backfill_successor_requires_stream");
    await this.control.markBackfillPhaseEnqueued({
      job,
      stream: job.stream,
      phase: next.phase,
      replayVersion: next.replayVersion,
      jobRequestId,
    });
  }

  private async enqueueNextReconciliationPhase(
    job: Extract<SyncJob, { type: "ReconciliationSweep" }>,
  ): Promise<void> {
    if (!job.stream || job.phase === "apply_tombstones") return;
    const phase = job.phase === "late_edits"
      ? "identity_snapshot" as const
      : job.phase === "identity_snapshot"
        ? "verify_snapshot" as const
        : "apply_tombstones" as const;
    await this.orchestrator.enqueueReconciliationSweep({
      tenantId:job.tenantId,
      connectionId:job.connectionId,
      connectionGeneration:job.connectionGeneration,
      connectorId:job.connectorId,
      externalAccountReference:job.externalAccountReference,
      reconciliationSweepId:job.reconciliationSweepId,
      phase,
      stream:job.stream,
      lookbackFrom:job.lookbackFrom,
      lookbackTo:job.lookbackTo,
    }, {
      delaySeconds:5,
      idempotencyKey:`reconciliation-phase:${job.connectionId}:g${job.connectionGeneration}:${job.reconciliationSweepId}:${job.stream}:${phase}`,
    });
  }
}

function latestSourceWatermark(records: readonly RawSourceRecord[], fallback: string): string {
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    if (!record.sourceUpdatedAt) continue;
    const candidate = Date.parse(record.sourceUpdatedAt);
    if (!Number.isFinite(candidate)) continue;
    if (candidate > latestTimestamp) latestTimestamp = candidate;
  }
  return Number.isFinite(latestTimestamp) ? new Date(latestTimestamp).toISOString() : fallback;
}

function reconciliationTombstoneRecord(
  job: Extract<SyncJob, { type: "ReconciliationSweep" }>,
  candidate: ReconciliationTombstoneCandidate,
): RawSourceRecord {
  const payload = Object.freeze({
    kind: "albert_reconciliation_tombstone",
    reconciliationSweepId: job.reconciliationSweepId,
    connectionGeneration: job.connectionGeneration,
    stream: job.stream,
    sourceObjectType: candidate.sourceObjectType,
    sourceRecordId: candidate.sourceRecordId,
    observedAt: job.requestedAt,
    evidenceBatchIds: [
      candidate.firstSnapshotBatchId,
      candidate.verificationSnapshotBatchId,
    ],
  });
  return Object.freeze({
    sourceObjectType: candidate.sourceObjectType,
    sourceRecordId: candidate.sourceRecordId,
    sourceUpdatedAt: job.requestedAt,
    payload,
    payloadHash: hashPayload(payload),
    normalized: Object.freeze({ ...candidate.normalized, tombstone: true }),
    deletionSignal: Object.freeze({
      kind: "reconciliation_tombstone" as const,
      reconciliationSweepId: job.reconciliationSweepId,
      evidenceBatchIds: Object.freeze([
        candidate.firstSnapshotBatchId,
        candidate.verificationSnapshotBatchId,
      ]),
      expectedPayloadHash: candidate.expectedPayloadHash,
      expectedSourceUpdatedAt: candidate.expectedSourceUpdatedAt,
      expectedIngestedAt: candidate.expectedIngestedAt,
    }),
  });
}
