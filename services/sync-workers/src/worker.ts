import { ulid } from "ulid";
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
  type SyncPage,
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
import type { LandingResult, ReconciliationTombstoneCandidate } from "./analytical-store.js";
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
/** Insights New-style in-claim page walk. One queue claim drains many vendor pages. */
const BACKFILL_PAGES_PER_CLAIM = 50;

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
  "55P03": Object.freeze({ code: "database_lock_timeout", retryable: true }),
  "42501": Object.freeze({ code: "database_permission_denied", retryable: false }),
  "57P01": Object.freeze({ code: "database_unavailable", retryable: true }),
  "08000": Object.freeze({ code: "database_unavailable", retryable: true }),
  "08003": Object.freeze({ code: "database_unavailable", retryable: true }),
  "08006": Object.freeze({ code: "database_unavailable", retryable: true }),
  // Supabase/pgbouncer saturation on dogfood must defer, not dead-letter.
  "53300": Object.freeze({ code: "database_unavailable", retryable: true }),
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
        logMappedDatabaseFailure(error, databaseFailure.code);
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
  logUnexpectedSyncFailure(error);
  return Object.freeze({
    code: "unexpected_sync_failure",
    retryable: true,
    retryDelaySeconds: 30,
  });
}

function logUnexpectedSyncFailure(error: unknown): void {
  if (process.env.NODE_ENV === "production") return;
  console.error("Albert sync job unexpected failure", {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    code: error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code).slice(0, 120)
      : undefined,
  });
}

function logMappedDatabaseFailure(error: unknown, code: string): void {
  if (process.env.NODE_ENV === "production") return;
  const pg = error && typeof error === "object" ? error as Record<string, unknown> : null;
  console.error("Albert sync job database failure", {
    mappedCode: code,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    pgCode: pg && "code" in pg ? String(pg.code).slice(0, 120) : undefined,
    pgSchema: pg && "schema" in pg ? String(pg.schema).slice(0, 120) : undefined,
    pgTable: pg && "table" in pg ? String(pg.table).slice(0, 120) : undefined,
    pgDetail: pg && "detail" in pg ? String(pg.detail).slice(0, 300) : undefined,
    pgWhere: pg && "where" in pg ? String(pg.where).slice(0, 500) : undefined,
    stack: error instanceof Error ? error.stack?.split("\n").slice(0, 8).join(" | ").slice(0, 800) : undefined,
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
  private readonly vendorRateBudgetOptions: Readonly<Record<string, number | undefined>>;

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
      vendorRateBudgetOptions?: Readonly<Record<string, number | undefined>>;
      /**
       * Connectors whose ingestion is not yet cleared. OAuth already skips
       * their initial backfill; this stops a webhook or due-tick incremental
       * from becoming that same backfill by the missing-cursor path below.
       */
      suppressInitialBackfillFor?: ReadonlySet<SyncJob["connectorId"]>;
    }> = {},
  ) {
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (!Number.isFinite(this.operationTimeoutMs) || this.operationTimeoutMs <= 0) {
      throw new Error("Sync operation timeout must be a positive duration.");
    }
    this.vendorRateBudgetOptions = Object.freeze({ ...(options.vendorRateBudgetOptions ?? {}) });
    this.suppressInitialBackfillFor = options.suppressInitialBackfillFor ?? new Set();
  }

  private readonly suppressInitialBackfillFor: ReadonlySet<SyncJob["connectorId"]>;

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
    // Prefetch runs concurrent with raw upload. Any exit path that does not
    // await it must swallow rejection or Node exits the Fly machine.
    let prefetchPromise: Promise<SyncPage> | null = null;
    const abandonPrefetch = (): void => {
      if (!prefetchPromise) return;
      void prefetchPromise.catch(() => undefined);
      prefetchPromise = null;
    };
    const withWriteFence = async <T>(operation: (capability: string) => Promise<T>): Promise<T> => {
      if (!writePermitId) throw new Error("sync_write_permit_missing");
      return this.control.withSyncWritePermit(claim, writePermitId, operation);
    };
    try {
      // Critical-path scheduling: `recent` phases are what make domains
      // queryable for transforms and answers; deeper history only extends
      // coverage backwards. While any recent phase on this connection is
      // still open, yield deep-history claims back to the queue so worker
      // lanes stay on the critical path. Deferral is lease-preserving and
      // consumes no failure budget, so this cannot dead-letter the job.
      if (
        job.type === "InitialBackfill" && job.stream &&
        job.planMode === "progressive" && job.phase !== "recent"
      ) {
        const openRecentPhases = await this.control.openRecentBackfillPhases(
          job.tenantId,
          job.connectionId,
          job.connectionGeneration,
        );
        if (openRecentPhases > 0) {
          const deferSeconds = 90;
          await this.queue.defer(claim, { code: "connection_not_ready" }, deferSeconds);
          return Object.freeze({
            status: "retry_scheduled",
            failure: Object.freeze({
              code: "connection_not_ready" as const,
              retryable: true,
            }),
            retryDelaySeconds: deferSeconds,
          });
        }
      }
      const run = await this.control.beginRun(job, claim.readCount);
      if (run === "already_succeeded") {
        await this.queue.complete(claim, { idempotentReplay: true });
        return Object.freeze({ status: "completed" });
      }
      const runResumeCursor = job.type === "InitialBackfill" && claim.readCount > 1
        ? await this.control.resumeInitialBackfillCursor(job)
        : null;
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
          connector.manifest,
          this.vendorRateBudgetOptions,
        ),
      } as const;
      const expectedStreams = manifestBackfillStreams(connector);
      connectionCheckInFlight = true;
      const connectionHealth = await this.connectorOperation(
        operationSignal,
        () => connector.check_connection(context),
      );
      connectionCheckInFlight = false;
      const persistedHealth = persistedAuthHealth(connectionHealth);
      try {
        await this.control.recordConnectionAuthHealth(claim, persistedHealth);
      } catch (error) {
        // Transform capability issuance holds FOR SHARE on connections for the
        // whole analytical transaction. A healthy probe must not abort the
        // backfill when that ShareLock briefly blocks an auth-health write.
        const pgCode = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (persistedHealth !== "healthy" || (pgCode !== "55P03" && pgCode !== "40P01")) {
          throw error;
        }
      }
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
          const reconnectCursor = runResumeCursor ?? job.cursor ?? (
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
            () => connector.initial_sync(
              context,stream,job.range,runResumeCursor ?? job.cursor,
            ),
          );
        }
      } else if (job.type === "IncrementalSync") {
        const cursor = job.cursor ?? (
          persisted.connectionGeneration === job.connectionGeneration ? persisted.cursor : null
        );
        if (!cursor) {
          // A suppressed connector has no cursor by construction. Promoting
          // that to a backfill would reintroduce exactly the ingestion the
          // suppression exists to prevent, so retire the job instead.
          if (this.suppressInitialBackfillFor.has(job.connectorId)) {
            await this.control.completeCoordinatorRun(job, 0);
            await this.queue.complete(claim, { suppressedInitialBackfill: true });
            return Object.freeze({ status: "completed" });
          }
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
      // InitialBackfill walks many vendor pages inside one claim (Insights New
      // style). Incremental/reconciliation stay single-page for webhook/lease
      // semantics. Raw upload stays outside withWriteFence to avoid Storage
      // lock_timeout; subsequent pages mint a fresh batchId for immutability.
      const maxPagesPerClaim = job.type === "InitialBackfill" ? BACKFILL_PAGES_PER_CLAIM : 1;
      let pagesLanded = 0;
      let cumulativeStaged = 0;
      let cumulativeQuarantine = 0;
      let currentPage: SyncPage = page;
      let pageStartCursor: ConnectorCursor | undefined = job.type === "InitialBackfill"
        ? runResumeCursor ?? job.cursor
        : "cursor" in job ? job.cursor : undefined;
      let pageJob: SyncJob = job.type === "InitialBackfill" && runResumeCursor
        ? Object.freeze({ ...job,batchId:ulid(),cursor:runResumeCursor })
        : job;
      // Capability support derives from granted scopes, which cannot change
      // within one leased claim: resolve once instead of a credential-vault
      // read on every walked page.
      let capabilityObservationsForClaim:
        | Awaited<ReturnType<typeof connector.describe_capabilities>>
        | null = null;

      while (true) {
        pagesLanded += 1;
        if (pagesLanded > 1) {
          pageJob = Object.freeze({
            ...job,
            batchId:ulid(),
            ...(pageStartCursor ? { cursor:pageStartCursor } : {}),
          });
        }

        const canPrefetch = job.type === "InitialBackfill"
          && Boolean(currentPage.hasMore && currentPage.nextCursor)
          && pagesLanded < maxPagesPerClaim
          && !operationSignal.aborted;
        if (canPrefetch && currentPage.nextCursor && job.type === "InitialBackfill") {
          const nextCursor = currentPage.nextCursor;
          const backfillJob = job;
          prefetchPromise = this.connectorOperation(
            operationSignal,
            () => backfillJob.planMode === "resume_verified"
              ? connector.incremental_sync(context, stream, nextCursor)
              : connector.initial_sync(context, stream, backfillJob.range, nextCursor),
          );
          // The rejection stays unobserved until the post-landing await, which
          // is macrotasks away; without a handler attached now, Node treats a
          // fast prefetch failure as an unhandled rejection and exits the
          // Machine, killing every in-flight lane. The real await still
          // receives the original rejection.
          prefetchPromise.catch(() => undefined);
        } else {
          prefetchPromise = null;
        }

        operationSignal.throwIfAborted();
        // Kick raw upload, then await it before staging (upload overlaps the
        // prefetch started above on multipage backfills).
        //
        // A mid-walk page that yields zero rows for this stream has nothing to
        // make immutable and nothing to stage: the group leader's raw batches
        // already retain the shared payloads. Skipping the manifest, landing
        // and quality round-trips matters at scale — a sibling walk over 400
        // empty pages paid ~15 minutes of pure bookkeeping for zero staged
        // rows. The FINAL page always takes the full path (its quality row
        // carries cursorComplete/backfillComplete evidence, FK-bound to a real
        // manifest), and reconciliation phases land every page because their
        // snapshots count empty pages as evidence.
        const skippableEmptyPage = currentPage.records.length === 0 &&
          currentPage.hasMore && job.type === "InitialBackfill";
        let landing: LandingResult;
        let batchObjectKey: string | null = null;
        if (skippableEmptyPage) {
          landing = Object.freeze({ stagedRecordCount: 0, quarantined: [], resolved: [] });
        } else {
          const rawUpload = this.rawWriter.write(
            {
              tenantId: pageJob.tenantId,
              connectionId: pageJob.connectionId,
              syncRunId: pageJob.syncRunId,
              batchId: pageJob.batchId,
              connectorKey: pageJob.connectorId,
              connectorVersion: connector.version,
              apiVersion: connector.apiVersion,
              externalAccountReference: pageJob.externalAccountReference,
              stream: stream.id,
              extractedAt,
              cursorStart: ("cursor" in pageJob ? pageJob.cursor : null) as JsonValue | null,
              cursorEnd: currentPage.nextCursor as JsonValue | null,
            },
            currentPage.records.map(rawRecord),
            { permitId: writePermitId!, workerId: claim.workerId },
          );
          const manifest = await rawUpload;
          if (manifest.syncRunId !== pageJob.syncRunId) {
            throw new Error("raw_batch_sync_run_lineage_mismatch");
          }
          if (manifest.batchId !== pageJob.batchId) {
            // A crash-replayed page in this exact sync run resolved to its
            // originally registered immutable batch. Rebind only the batch ID;
            // cross-run reuse is forbidden by the manifest repository.
            pageJob = Object.freeze({ ...pageJob, batchId: manifest.batchId });
          }
          await this.control.markLandingStarted(pageJob.tenantId, pageJob.batchId);
          operationSignal.throwIfAborted();
          batchObjectKey = manifest.objectKeys[0] ?? null;
          landing = await withWriteFence((capability) =>
            this.analytical.land(pageJob, manifest, currentPage.records, capability));
        }
        if (landing.resolved.length > 0) {
          await this.control.resolveQuarantineIndex({
            claim,
            permitId: writePermitId,
            stream: stream.id,
            records: landing.resolved,
          });
        }
        const completion = job.type === "InitialBackfill" && !currentPage.hasMore
          ? phaseCompletesBackfill(job, currentPage.coverage, activeBackfillPhase?.inheritedCoverage)
          : { complete: false, coverage: null };
        const expectsCompletionEvidence = job.type === "InitialBackfill" && !currentPage.hasMore &&
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
              job, stream, records: currentPage.records, landing, hasMore: currentPage.hasMore,
              ...(currentPage.sourceTotal === undefined ? {} : { sourceTotal: currentPage.sourceTotal }),
            }, capability));
          if (!currentPage.hasMore && reconciliationSnapshot.status !== "complete") {
            throw new Error(`reconciliation_snapshot_${reconciliationSnapshot.status}`);
          }
        }
        if (job.type === "ReconciliationSweep" && job.phase === "apply_tombstones") {
          applicationsInBatch = await withWriteFence((capability) =>
            this.analytical.recordReconciliationTombstoneApplications({
              job, candidates: reconciliationCandidates,
            }, capability));
        }
        if (!skippableEmptyPage) {
          await withWriteFence((capability) => this.analytical.recordConnectorStreamPage({
            job: pageJob, stream: stream.id, records: currentPage.records, landing,
            hasMore: currentPage.hasMore,
            nextCursorPresent: currentPage.nextCursor !== null, backfillComplete,
            coverage: completion.coverage,
            ...(currentPage.sourceTotal === undefined ? {} : { sourceTotal: currentPage.sourceTotal }),
          }, capability));
        }
        if (capabilityObservationsForClaim === null) {
          capabilityObservationsForClaim = (await this.connectorOperation(
            operationSignal,
            () => connector.describe_capabilities(context),
          )).filter((observation) =>
            connector.manifest.capabilities[observation.id]?.streams.includes(stream.id),
          );
        }
        const capabilityObservations = capabilityObservationsForClaim;
        if (!currentPage.paginationBlock) {
          await withWriteFence((capability) => this.analytical.publishCapabilityObservations({
            job: pageJob,
            packVersion: connector.version,
            stream: stream.id,
            sourceWatermark: latestSourceWatermark(currentPage.records, extractedAt),
            recordCount: landing.stagedRecordCount,
            observations: capabilityObservations,
          }, capability));
        }
        await withWriteFence((capability) => this.analytical.publishConnectorQualityResults({
          job: pageJob,
          stream: stream.id,
          results: buildConnectorQualityResults({
            job: pageJob, records: currentPage.records, stagedRecordCount: landing.stagedRecordCount,
            quarantineCount: landing.quarantined.length, hasMore: currentPage.hasMore,
            nextCursor: currentPage.nextCursor, capabilities: capabilityObservations,
          }),
        }, capability));
        if (landing.quarantined.length > 0) {
          if (batchObjectKey === null) throw new Error("quarantine_requires_landed_batch");
          await this.control.recordQuarantineIndex({
            job: pageJob,
            stream: stream.id,
            batchObjectKey,
            records: landing.quarantined,
          });
        }
        operationSignal.throwIfAborted();
        await this.queue.extendVisibility(claim, 900);
        const finalCursor: ConnectorCursor = currentPage.nextCursor ??
          ("cursor" in pageJob && pageJob.cursor ? pageJob.cursor : persisted.cursor ?? { value: extractedAt });
        cumulativeStaged += landing.stagedRecordCount;
        cumulativeQuarantine += landing.quarantined.length;

        let totalApplied = applicationsInBatch;
        let reconciliationPhaseEvidence: Readonly<Record<string, unknown>> | null = null;
        const finalizeClaim = !currentPage.hasMore || prefetchPromise === null;
        if (finalizeClaim && !currentPage.hasMore && job.type === "ReconciliationSweep") {
          if (job.phase === "apply_tombstones") {
            totalApplied = await withWriteFence((capability) =>
              this.analytical.completeConnectorReconciliation(job, capability));
          }
          await this.enqueueNextReconciliationPhase(job);
          reconciliationPhaseEvidence = {
            batchId: pageJob.batchId,
            recordCount: landing.stagedRecordCount,
            quarantineCount: landing.quarantined.length,
            ...(reconciliationSnapshot ? {
              snapshotStatus: reconciliationSnapshot.status,
              uniqueCount: reconciliationSnapshot.uniqueCount,
              sourceTotal: reconciliationSnapshot.sourceTotal ?? null,
              membershipDeltaCount: reconciliationSnapshot.membershipDeltaCount ?? 0,
            } : {}),
            ...(job.phase === "apply_tombstones" ? {
              applicationsInBatch, totalApplied,
            } : {}),
          };
        }
        await withWriteFence((capability) =>
          this.analytical.refreshConnectorQualityRollup(pageJob, capability));
        if (currentPage.paginationBlock) {
          throw new ConnectorError(
            "REMOTE_RESPONSE_INVALID",
            currentPage.paginationBlock.detail,
            {
              retryable: false,
              details: { stream: stream.id, reason: currentPage.paginationBlock.code },
            },
          );
        }
        await this.control.commitPage({
          job: pageJob,
          cursor: finalCursor,
          sourceWatermark: finalCursor.sourceUpdatedAt,
          hasMore: currentPage.hasMore,
          keepRunOpen: true,
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

        if (!finalizeClaim && prefetchPromise) {
          const nextPage = await prefetchPromise;
          if (nextPage.hasMore && !nextPage.nextCursor && !nextPage.paginationBlock) {
            throw new Error("connector_page_missing_continuation_cursor");
          }
          if (nextPage.paginationBlock && (!nextPage.hasMore || nextPage.nextCursor)) {
            throw new Error("connector_page_invalid_pagination_block");
          }
          if (
            nextPage.hasMore &&
            nextPage.nextCursor &&
            currentPage.nextCursor?.value === nextPage.nextCursor.value
          ) {
            throw new Error("connector_page_non_advancing_cursor");
          }
          pageStartCursor = currentPage.nextCursor ?? undefined;
          currentPage = nextPage;
          continue;
        }

        // Publish successor work only when leaving the claim. Publication is
        // idempotent; committing first would leave a crash window with no
        // durable continuation.
        if (currentPage.hasMore && currentPage.nextCursor) {
          await this.enqueueContinuation(job, currentPage.nextCursor);
        }
        if (!currentPage.hasMore && job.type === "InitialBackfill") {
          await this.enqueueNextBackfillPhase(job);
        }
        await this.control.completePageRun(job);
        await this.queue.complete(claim, {
          batchId: pageJob.batchId,
          stagedRecordCount: cumulativeStaged,
          quarantineCount: cumulativeQuarantine,
          continuationEnqueued: currentPage.hasMore,
          pagesLanded,
        });
        return Object.freeze({ status: "completed" });
      }
    } catch (error) {
      const authHealth = authHealthForFailure(error, connectionCheckInFlight);
      if (authHealth) {
        await this.control.recordConnectionAuthHealth(claim, authHealth).catch(() => undefined);
      }
      const failure = syncFailure(error);
      // sync_runs keeps only the mapped code; without this line the vendor's
      // actual complaint (which endpoint, which relations, which HTTP status)
      // exists nowhere an operator can read it.
      console.error("Albert sync stream failure", {
        stream: job.stream ?? null,
        jobType: job.type,
        code: failure.code,
        message: error instanceof Error ? error.message : String(error),
        details: (error as { details?: unknown })?.details ?? null,
        status: (error as { status?: unknown })?.status ?? null,
      });
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
      abandonPrefetch();
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
      // Use the hashed default idempotency key. Embedding cursor.value inline
      // overflows the 240-char enqueue limit once vendor opaque cursors grow.
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
