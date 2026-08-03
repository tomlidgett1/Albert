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

export type SyncCursor = Readonly<{
  value: string;
  sourceUpdatedAt?: string;
}>;

type SyncJobBase = Readonly<{
  schemaVersion: 1;
  type: SyncJobType;
  tenantId: string;
  connectionId: string;
  connectorId: "lightspeed-r" | "xero" | "deputy";
  externalAccountReference: string;
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
  }>;

export type IncrementalSyncJob = SyncJobBase &
  Readonly<{
    type: "IncrementalSync";
    stream: string;
    cursor?: SyncCursor;
    reason: "webhook" | "schedule" | "manual" | "continuation";
    webhookReceiptId?: string;
  }>;

export type ReconciliationSweepJob = SyncJobBase &
  Readonly<{
    type: "ReconciliationSweep";
    stream?: string;
    cursor?: SyncCursor;
    lookbackFrom: string;
    lookbackTo: string;
  }>;

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
    error: Readonly<{ code: string; retryable: boolean; detail?: string }>,
    options: Readonly<{ retryDelaySeconds: number; maxAttempts: number }>,
  ): Promise<"retry_wait" | "failed">;
  /** Delay capacity/rate-limited work without consuming a failure budget. */
  defer(
    claim: ClaimedSyncJob,
    reason: Readonly<{ code: string; detail?: string }>,
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
    input: Omit<ReconciliationSweepJob, "schemaVersion" | "type" | "syncRunId" | "batchId" | "requestedAt">,
    options?: Readonly<{ delaySeconds?: number; idempotencyKey?: string }>,
  ): Promise<string>;
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CONNECTORS = new Set(["lightspeed-r", "xero", "deputy"]);

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
  if (value.cursor !== undefined && !isCursor(value.cursor)) {
    throw new Error("Sync queue payload has an invalid cursor.");
  }

  if (value.type === "InitialBackfill") {
    if (
      !isRecord(value.range) ||
      !isIsoTimestamp(value.range.from) ||
      !isIsoTimestamp(value.range.to) ||
      new Date(value.range.from) > new Date(value.range.to) ||
      !["recent", "thirteen_months", "full_history"].includes(String(value.phase)) ||
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
  return value as SyncJob & Readonly<{ jobRequestId: string }>;
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
    stream: "stream" in job ? job.stream : undefined,
    cursor: "cursor" in job ? job.cursor : undefined,
    range: job.type === "InitialBackfill" ? job.range : undefined,
    phase: job.type === "InitialBackfill" ? job.phase : undefined,
    lookbackFrom: job.type === "ReconciliationSweep" ? job.lookbackFrom : undefined,
    lookbackTo: job.type === "ReconciliationSweep" ? job.lookbackTo : undefined,
    webhookReceiptId: job.type === "IncrementalSync" ? job.webhookReceiptId : undefined,
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
    input: Omit<ReconciliationSweepJob, "schemaVersion" | "type" | "syncRunId" | "batchId" | "requestedAt">,
    options: Readonly<{ delaySeconds?: number; idempotencyKey?: string }> = {},
  ): Promise<string> {
    const job: ReconciliationSweepJob = { ...base("ReconciliationSweep"), ...input };
    const receipt = await this.queue.enqueue(job, {
      priority: "standard",
      idempotencyKey: options.idempotencyKey ?? syncJobIdempotencyKey(job),
      delaySeconds: options.delaySeconds,
    });
    return receipt.jobRequestId;
  }
}
