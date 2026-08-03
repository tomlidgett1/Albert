import {
  asSyncFailureCode,
  parseSyncJob,
  type ClaimedSyncJob,
  type DurableSyncQueue,
  type QueueMetrics,
  type SyncJob,
  type SyncPriority,
  type SyncQueueName,
} from "./contracts.js";

export interface PostgresQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Row[] }>>;
}

const QUEUES: readonly SyncQueueName[] = [
  "albert_sync_high",
  "albert_sync_standard",
  "albert_sync_backfill",
];

function asInteger(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`pgmq returned invalid ${name}.`);
  return number;
}

function asTimestamp(value: unknown, name: string): string {
  const timestamp = value instanceof Date ? value.toISOString() : String(value);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`pgmq returned invalid ${name}.`);
  return timestamp;
}

export class PgmqDurableSyncQueue implements DurableSyncQueue {
  constructor(private readonly db: PostgresQueryClient) {}

  async preflight(): Promise<void> {
    await this.db.query("select control_plane.assert_pgmq_ready()");
  }

  async enqueue(
    job: SyncJob,
    options: Readonly<{
      priority: SyncPriority;
      idempotencyKey: string;
      delaySeconds?: number;
    }>,
  ) {
    const result = await this.db.query<{
      job_request_id: string;
      queue_message_id: string | number;
      created: boolean;
    }>(
      `select job_request_id, queue_message_id, created
         from control_plane.enqueue_sync_job($1::jsonb, $2::text, $3::text, $4::integer)`,
      [JSON.stringify(job), options.priority, options.idempotencyKey, options.delaySeconds ?? 0],
    );
    const row = result.rows[0];
    if (!row) throw new Error("pgmq enqueue returned no receipt.");
    return {
      jobRequestId: row.job_request_id,
      messageId: String(row.queue_message_id),
      created: row.created,
    } as const;
  }

  async claim(options: Readonly<{ workerId: string; visibilityTimeoutSeconds: number }>) {
    for (const queue of QUEUES) {
      const result = await this.db.query<{
        message_id: string | number;
        read_count: string | number;
        enqueued_at: string | Date;
        visibility_deadline: string | Date;
        payload: unknown;
      }>(
        `select message_id, read_count, enqueued_at, visibility_deadline, payload
           from control_plane.claim_sync_jobs($1::text, $2::text, $3::integer, 1)`,
        [queue, options.workerId, options.visibilityTimeoutSeconds],
      );
      const row = result.rows[0];
      if (!row) continue;
      const job = parseSyncJob(row.payload);
      return Object.freeze({
        queueName: queue,
        workerId: options.workerId,
        messageId: String(row.message_id),
        readCount: asInteger(row.read_count, "read_count"),
        enqueuedAt: asTimestamp(row.enqueued_at, "enqueued_at"),
        visibilityDeadline: asTimestamp(row.visibility_deadline, "visibility_deadline"),
        job,
      }) satisfies ClaimedSyncJob;
    }
    return null;
  }

  async complete(
    claim: ClaimedSyncJob,
    result: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.db.query(
      `select control_plane.complete_sync_job(
         $1::text, $2::bigint, $3::text, $4::text, $5::integer, $6::jsonb
       )`,
      [
        claim.queueName,
        claim.messageId,
        claim.job.jobRequestId,
        claim.workerId,
        claim.readCount,
        JSON.stringify(result),
      ],
    );
  }

  async extendVisibility(
    claim: ClaimedSyncJob,
    visibilityTimeoutSeconds: number,
  ): Promise<string> {
    const result = await this.db.query<{ visibility_deadline: string | Date }>(
      `select control_plane.extend_sync_job_visibility(
         $1::text, $2::bigint, $3::text, $4::text, $5::integer, $6::integer
       ) as visibility_deadline`,
      [
        claim.queueName,
        claim.messageId,
        claim.job.jobRequestId,
        claim.workerId,
        claim.readCount,
        visibilityTimeoutSeconds,
      ],
    );
    const deadline = result.rows[0]?.visibility_deadline;
    if (!deadline) throw new Error("pgmq visibility extension returned no deadline.");
    return asTimestamp(deadline, "visibility_deadline");
  }

  async retryOrFail(
    claim: ClaimedSyncJob,
    error: Readonly<{ code: string; retryable: boolean }>,
    options: Readonly<{ retryDelaySeconds: number; maxAttempts: number }>,
  ) {
    const safeError = {
      code: asSyncFailureCode(error.code),
      retryable: error.retryable,
    };
    const result = await this.db.query<{ outcome: "retry_wait" | "failed" }>(
      `select control_plane.retry_or_fail_sync_job(
         $1::text, $2::bigint, $3::text, $4::text, $5::integer,
         $6::jsonb, $7::integer, $8::integer
       ) as outcome`,
      [
        claim.queueName,
        claim.messageId,
        claim.job.jobRequestId,
        claim.workerId,
        claim.readCount,
        JSON.stringify(safeError),
        options.retryDelaySeconds,
        error.retryable ? options.maxAttempts : 1,
      ],
    );
    const outcome = result.rows[0]?.outcome;
    if (outcome !== "retry_wait" && outcome !== "failed") {
      throw new Error("pgmq failure transition returned an invalid outcome.");
    }
    return outcome;
  }

  async defer(
    claim: ClaimedSyncJob,
    reason: Readonly<{ code: string }>,
    delaySeconds: number,
  ): Promise<string> {
    const safeReason = {
      code: asSyncFailureCode(reason.code),
    };
    const result = await this.db.query<{ visibility_deadline: string | Date }>(
      `select control_plane.defer_sync_job(
         $1::text, $2::bigint, $3::text, $4::text, $5::integer, $6::jsonb, $7::integer
       ) as visibility_deadline`,
      [
        claim.queueName,
        claim.messageId,
        claim.job.jobRequestId,
        claim.workerId,
        claim.readCount,
        JSON.stringify(safeReason),
        delaySeconds,
      ],
    );
    const deadline = result.rows[0]?.visibility_deadline;
    if (!deadline) throw new Error("pgmq defer transition returned no deadline.");
    return asTimestamp(deadline, "visibility_deadline");
  }

  async metrics(): Promise<readonly QueueMetrics[]> {
    const result = await this.db.query<{
      queue_name: SyncQueueName;
      queue_length: string | number;
      oldest_msg_age_sec: string | number | null;
      total_messages: string | number;
    }>(
      `select queue_name, queue_length, oldest_msg_age_sec, total_messages
         from control_plane.sync_queue_metrics()
        order by queue_name`,
    );
    return result.rows.map((row) => ({
      queueName: row.queue_name,
      queueLength: asInteger(row.queue_length, "queue_length"),
      oldestMessageAgeSeconds:
        row.oldest_msg_age_sec === null
          ? null
          : asInteger(row.oldest_msg_age_sec, "oldest_msg_age_sec"),
      totalMessages: asInteger(row.total_messages, "total_messages"),
    }));
  }
}
