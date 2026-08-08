import { createHash } from "node:crypto";
import { ulid } from "ulid";

export const SYNC_JOB_TYPES = [
  "InitialBackfill",
  "IncrementalSync",
  "ReconciliationSweep",
] as const;

export type SyncJobType = (typeof SYNC_JOB_TYPES)[number];
export type SyncPriority = "high" | "standard" | "backfill";
export type SyncQueueName =
  | "albert_sync_high"
  | "albert_sync_standard"
  | "albert_sync_backfill";

export const SYNC_FAILURE_CODES = [
  "authentication_required",
  "backfill_completion_evidence_missing",
  "backfill_continuation_requires_stream",
  "backfill_plan_requires_coordinator",
  "backfill_phase_requires_stream",
  "backfill_successor_requires_stream",
  "capability_unavailable",
  "configuration_invalid",
  "connection_account_mismatch",
  "connection_generation_stale",
  "connection_not_ready",
  "connector_page_invalid_pagination_block",
  "connector_page_missing_continuation_cursor",
  "connector_page_non_advancing_cursor",
  "connector_stream_not_found",
  "credential_conflict",
  "cursor_invalid",
  "database_deadlock",
  "database_integrity_violation",
  "database_lock_timeout",
  "database_permission_denied",
  "database_serialization_conflict",
  "database_unavailable",
  "incremental_sync_requires_stream",
  "oauth_exchange_failed",
  "rate_limited",
  "reconnect_modified_watermark_missing",
  "reconciliation_snapshot_failed",
  "reconciliation_snapshot_incomplete",
  "remote_response_invalid",
  "remote_unavailable",
  "sync_analytical_capability_invalid",
  "sync_internal_error",
  "sync_operation_timeout",
  "sync_stream_phase_lease_stale",
  "sync_write_permit_invalid",
  "sync_write_permit_missing",
  "unexpected_sync_failure",
  "webhook_signature_invalid",
] as const;

export type SyncFailureCode = (typeof SYNC_FAILURE_CODES)[number];

const SYNC_FAILURE_CODE_SET: ReadonlySet<string> = new Set(SYNC_FAILURE_CODES);

export function asSyncFailureCode(value: string): SyncFailureCode {
  return SYNC_FAILURE_CODE_SET.has(value)
    ? value as SyncFailureCode
    : "unexpected_sync_failure";
}

export type SyncCursor = Readonly<{
  value: string;
  sourceUpdatedAt?: string;
}>;

export type SyncWebhookTombstone = Readonly<{
  kind: "tombstone";
  stream: string;
  sourceObjectType: string;
  sourceRecordId: string;
  observedAt: string;
}>;

export const RECONCILIATION_PHASES = [
  "late_edits",
  "identity_snapshot",
  "verify_snapshot",
  "apply_tombstones",
] as const;
export type ReconciliationPhase = (typeof RECONCILIATION_PHASES)[number];

type SyncJobBase = Readonly<{
  schemaVersion: 1;
  type: SyncJobType;
  tenantId: string;
  connectionId: string;
  connectorId: "lightspeed-r" | "xero" | "deputy" | "square" | "shopify" | "stripe" | "momence" | "meta-ads" | "google-ads";
  externalAccountReference: string;
  /** Fences every job and cursor to one immutable OAuth/connection epoch. */
  connectionGeneration: number;
  syncRunId: string;
  batchId: string;
  requestedAt: string;
  jobRequestId?: string;
}>;

export type InitialBackfillJob = SyncJobBase &
  Readonly<{
    type: "InitialBackfill";
    stream?: string;
    range: Readonly<{ from: string; to: string }>;
    cursor?: SyncCursor;
    phase: "recent" | "thirteen_months" | "full_history";
    /** Monotonic durable replay identity for this generation/stream/phase. */
    replayVersion: number;
    planMode: "progressive" | "resume_verified" | "single_pass";
  }>;

export type IncrementalSyncJob = SyncJobBase &
  Readonly<{
    type: "IncrementalSync";
    stream: string;
    cursor?: SyncCursor;
    reason: "webhook" | "schedule" | "manual" | "continuation";
    webhookReceiptId?: string;
    webhookTombstones?: readonly SyncWebhookTombstone[];
  }>;

export type ReconciliationSweepJob = SyncJobBase &
  Readonly<{
    type: "ReconciliationSweep";
    reconciliationSweepId: string;
    phase: ReconciliationPhase;
    stream?: string;
    cursor?: SyncCursor;
    lookbackFrom: string;
    lookbackTo: string;
  }>;

type ReconciliationEnqueueInput = Omit<
  ReconciliationSweepJob,
  "schemaVersion" | "type" | "syncRunId" | "batchId" | "requestedAt" |
  "reconciliationSweepId" | "phase"
> & Partial<Pick<ReconciliationSweepJob, "reconciliationSweepId" | "phase">>;

export type SyncJob = InitialBackfillJob | IncrementalSyncJob | ReconciliationSweepJob;

export type ClaimedSyncJob = Readonly<{
  queueName: SyncQueueName;
  workerId: string;
  messageId: string;
  readCount: number;
  enqueuedAt: string;
  visibilityDeadline: string;
  job: SyncJob & Readonly<{ jobRequestId: string }>;
}>;

export type QueueMetrics = Readonly<{
  queueName: SyncQueueName;
  queueLength: number;
  oldestMessageAgeSeconds: number | null;
  totalMessages: number;
}>;

export interface DurableSyncQueue {
  preflight(): Promise<void>;
  enqueue(
    job: SyncJob,
    options: Readonly<{
      priority: SyncPriority;
      idempotencyKey: string;
      delaySeconds?: number;
    }>,
  ): Promise<Readonly<{ jobRequestId: string; messageId: string; created: boolean }>>;
  claim(options: Readonly<{
    workerId: string;
    visibilityTimeoutSeconds: number;
  }>): Promise<ClaimedSyncJob | null>;
  extendVisibility(
    claim: ClaimedSyncJob,
    visibilityTimeoutSeconds: number,
  ): Promise<string>;
  complete(claim: ClaimedSyncJob, result?: Readonly<Record<string, unknown>>): Promise<void>;
  retryOrFail(
    claim: ClaimedSyncJob,
    error: Readonly<{ code: string; retryable: boolean }>,
    options: Readonly<{ retryDelaySeconds: number; maxAttempts: number }>,
  ): Promise<"retry_wait" | "failed">;
  /** Delay capacity/rate-limited work without consuming a failure budget. */
  defer(
    claim: ClaimedSyncJob,
    reason: Readonly<{ code: string }>,
    delaySeconds: number,
  ): Promise<string>;
  metrics(): Promise<readonly QueueMetrics[]>;
}

export interface SyncOrchestrator {
  enqueueInitialBackfill(
    input: Omit<InitialBackfillJob, "schemaVersion" | "type" | "syncRunId" | "batchId" | "requestedAt">,
    options?: Readonly<{ delaySeconds?: number; idempotencyKey?: string }>,
  ): Promise<string>;
  enqueueIncrementalSync(
    input: Omit<IncrementalSyncJob, "schemaVersion" | "type" | "syncRunId" | "batchId" | "requestedAt">,
    options?: Readonly<{ delaySeconds?: number; idempotencyKey?: string }>,
  ): Promise<string>;
  enqueueReconciliationSweep(
    input: ReconciliationEnqueueInput,
    options?: Readonly<{ delaySeconds?: number; idempotencyKey?: string }>,
  ): Promise<string>;
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CONNECTORS = new Set(["lightspeed-r", "xero", "deputy", "square", "shopify", "stripe", "momence", "meta-ads", "google-ads"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isCursor(value: unknown): value is SyncCursor {
  return (
    isRecord(value) &&
    typeof value.value === "string" &&
    value.value.length > 0 &&
    (value.sourceUpdatedAt === undefined || isIsoTimestamp(value.sourceUpdatedAt))
  );
}

const DEPUTY_TOMBSTONE_RESOURCE_BY_STREAM = Object.freeze({
  operational_units: "OperationalUnit",
  employees: "Employee",
  rosters: "Roster",
  timesheets: "Timesheet",
  leave: "Leave",
} as const);

function parseWebhookTombstones(
  value: unknown,
  stream: string,
  connectorId: string,
  reason: unknown,
  webhookReceiptId: unknown,
): readonly SyncWebhookTombstone[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 5_000 ||
      connectorId !== "deputy" || reason !== "webhook" ||
      typeof webhookReceiptId !== "string" || !ULID_PATTERN.test(webhookReceiptId)) {
    throw new Error("IncrementalSync webhook tombstones are invalid.");
  }
  const expectedResource = DEPUTY_TOMBSTONE_RESOURCE_BY_STREAM[
    stream as keyof typeof DEPUTY_TOMBSTONE_RESOURCE_BY_STREAM
  ];
  if (!expectedResource) throw new Error("IncrementalSync webhook tombstones are invalid.");
  const identities = new Set<string>();
  const parsed = value.map((candidate) => {
    if (!isRecord(candidate) || candidate.kind !== "tombstone" ||
        candidate.stream !== stream || candidate.sourceObjectType !== expectedResource ||
        typeof candidate.sourceRecordId !== "string" || !candidate.sourceRecordId.trim() ||
        candidate.sourceRecordId.length > 300 || /[\u0000-\u001f\u007f]/u.test(candidate.sourceRecordId) ||
        !isIsoTimestamp(candidate.observedAt)) {
      throw new Error("IncrementalSync webhook tombstones are invalid.");
    }
    const identity = `${candidate.sourceObjectType}:${candidate.sourceRecordId}`;
    if (identities.has(identity)) throw new Error("IncrementalSync webhook tombstones are duplicated.");
    identities.add(identity);
    return Object.freeze({
      kind: "tombstone" as const,
      stream,
      sourceObjectType: expectedResource,
      sourceRecordId: candidate.sourceRecordId,
      observedAt: candidate.observedAt,
    });
  });
  return Object.freeze(parsed);
}

export function parseSyncJob(value: unknown): SyncJob & Readonly<{ jobRequestId: string }> {
  if (!isRecord(value)) throw new Error("Sync queue payload must be an object.");
  for (const key of ["tenantId", "connectionId", "syncRunId", "batchId", "jobRequestId"] as const) {
    if (typeof value[key] !== "string" || !ULID_PATTERN.test(value[key])) {
      throw new Error(`Sync queue payload has an invalid ${key}.`);
    }
  }
  if (value.schemaVersion !== 1 || !SYNC_JOB_TYPES.includes(value.type as SyncJobType)) {
    throw new Error("Sync queue payload has an unsupported schema or job type.");
  }
  if (typeof value.connectorId !== "string" || !CONNECTORS.has(value.connectorId)) {
    throw new Error("Sync queue payload has an invalid connectorId.");
  }
  if (
    typeof value.externalAccountReference !== "string" ||
    !value.externalAccountReference.trim() ||
    !isIsoTimestamp(value.requestedAt)
  ) {
    throw new Error("Sync queue payload has invalid account or request metadata.");
  }
  const connectionGeneration = value.connectionGeneration ?? 1;
  if (!Number.isSafeInteger(connectionGeneration) || Number(connectionGeneration) < 1) {
    throw new Error("Sync queue payload has an invalid connectionGeneration.");
  }
  if (value.cursor !== undefined && !isCursor(value.cursor)) {
    throw new Error("Sync queue payload has an invalid cursor.");
  }

  if (value.type === "InitialBackfill") {
    const replayVersion = value.replayVersion ?? 1;
    const planMode = value.planMode ?? "progressive";
    if (
      !isRecord(value.range) ||
      !isIsoTimestamp(value.range.from) ||
      !isIsoTimestamp(value.range.to) ||
      new Date(value.range.from) > new Date(value.range.to) ||
      !["recent", "thirteen_months", "full_history"].includes(String(value.phase)) ||
      !Number.isSafeInteger(replayVersion) || Number(replayVersion) < 1 ||
      !["progressive", "resume_verified", "single_pass"].includes(String(planMode)) ||
      (value.stream !== undefined && (typeof value.stream !== "string" || !value.stream.trim()))
    ) {
      throw new Error("InitialBackfill payload is invalid.");
    }
  } else if (value.type === "IncrementalSync") {
    if (
      typeof value.stream !== "string" ||
      !value.stream.trim() ||
      !["webhook", "schedule", "manual", "continuation"].includes(String(value.reason))
    ) {
      throw new Error("IncrementalSync payload is invalid.");
    }
  } else if (
    (value.stream !== undefined && (typeof value.stream !== "string" || !value.stream.trim())) ||
    !isIsoTimestamp(value.lookbackFrom) ||
    !isIsoTimestamp(value.lookbackTo) ||
    new Date(value.lookbackFrom) > new Date(value.lookbackTo)
  ) {
    throw new Error("ReconciliationSweep payload is invalid.");
  }
  const reconciliationSweepId = value.type === "ReconciliationSweep"
    ? value.reconciliationSweepId ?? value.syncRunId
    : undefined;
  const reconciliationPhase = value.type === "ReconciliationSweep"
    ? value.phase ?? "late_edits"
    : undefined;
  if (
    value.type === "ReconciliationSweep" &&
    (
      typeof reconciliationSweepId !== "string" || !ULID_PATTERN.test(reconciliationSweepId) ||
      !RECONCILIATION_PHASES.includes(reconciliationPhase as ReconciliationPhase)
    )
  ) {
    throw new Error("ReconciliationSweep lifecycle metadata is invalid.");
  }
  const webhookTombstones = value.type === "IncrementalSync"
    ? parseWebhookTombstones(
        value.webhookTombstones,
        String(value.stream),
        String(value.connectorId),
        value.reason,
        value.webhookReceiptId,
      )
    : undefined;
  return {
    ...value,
    connectionGeneration: Number(connectionGeneration),
    ...(value.type === "InitialBackfill"
      ? {
          replayVersion: Number(value.replayVersion ?? 1),
          planMode: String(value.planMode ?? "progressive") as InitialBackfillJob["planMode"],
        }
      : {}),
    ...(value.type === "ReconciliationSweep"
      ? {
          reconciliationSweepId,
          phase: reconciliationPhase,
        }
      : {}),
    ...(webhookTombstones ? { webhookTombstones } : {}),
  } as SyncJob & Readonly<{ jobRequestId: string }>;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}

export function syncJobIdempotencyKey(job: SyncJob): string {
  const replayIdentity = {
    schemaVersion: job.schemaVersion,
    type: job.type,
    tenantId: job.tenantId,
    connectionId: job.connectionId,
    connectionGeneration: job.connectionGeneration,
    stream: "stream" in job ? job.stream : undefined,
    cursor: "cursor" in job ? job.cursor : undefined,
    range: job.type === "InitialBackfill" ? job.range : undefined,
    phase: job.type === "InitialBackfill" ? job.phase : undefined,
    replayVersion: job.type === "InitialBackfill" ? job.replayVersion : undefined,
    planMode: job.type === "InitialBackfill" ? job.planMode : undefined,
    lookbackFrom: job.type === "ReconciliationSweep" ? job.lookbackFrom : undefined,
    lookbackTo: job.type === "ReconciliationSweep" ? job.lookbackTo : undefined,
    reconciliationSweepId: job.type === "ReconciliationSweep" ? job.reconciliationSweepId : undefined,
    reconciliationPhase: job.type === "ReconciliationSweep" ? job.phase : undefined,
    webhookReceiptId: job.type === "IncrementalSync" ? job.webhookReceiptId : undefined,
    webhookTombstones: job.type === "IncrementalSync" ? job.webhookTombstones : undefined,
  };
  return `sync:${createHash("sha256").update(stable(replayIdentity)).digest("hex")}`;
}

function base<T extends SyncJobType>(type: T) {
  return {
    schemaVersion: 1 as const,
    type,
    syncRunId: ulid(),
    batchId: ulid(),
    requestedAt: new Date().toISOString(),
  };
}

export class DefaultSyncOrchestrator implements SyncOrchestrator {
  constructor(private readonly queue: DurableSyncQueue) {}

  async enqueueInitialBackfill(
    input: Omit<InitialBackfillJob, "schemaVersion" | "type" | "syncRunId" | "batchId" | "requestedAt">,
    options: Readonly<{ delaySeconds?: number; idempotencyKey?: string }> = {},
  ): Promise<string> {
    const job: InitialBackfillJob = { ...base("InitialBackfill"), ...input };
    const receipt = await this.queue.enqueue(job, {
      priority: "backfill",
      idempotencyKey: options.idempotencyKey ?? syncJobIdempotencyKey(job),
      delaySeconds: options.delaySeconds,
    });
    return receipt.jobRequestId;
  }

  async enqueueIncrementalSync(
    input: Omit<IncrementalSyncJob, "schemaVersion" | "type" | "syncRunId" | "batchId" | "requestedAt">,
    options: Readonly<{ delaySeconds?: number; idempotencyKey?: string }> = {},
  ): Promise<string> {
    const job: IncrementalSyncJob = { ...base("IncrementalSync"), ...input };
    const receipt = await this.queue.enqueue(job, {
      priority: job.reason === "webhook" || job.reason === "manual" ? "high" : "standard",
      idempotencyKey: options.idempotencyKey ?? syncJobIdempotencyKey(job),
      delaySeconds: options.delaySeconds,
    });
    return receipt.jobRequestId;
  }

  async enqueueReconciliationSweep(
    input: ReconciliationEnqueueInput,
    options: Readonly<{ delaySeconds?: number; idempotencyKey?: string }> = {},
  ): Promise<string> {
    const identity = base("ReconciliationSweep");
    const job: ReconciliationSweepJob = {
      ...identity,
      ...input,
      reconciliationSweepId: input.reconciliationSweepId ?? identity.syncRunId,
      phase: input.phase ?? "late_edits",
    };
    const receipt = await this.queue.enqueue(job, {
      priority: "standard",
      idempotencyKey: options.idempotencyKey ?? syncJobIdempotencyKey(job),
      delaySeconds: options.delaySeconds,
    });
    return receipt.jobRequestId;
  }
}
