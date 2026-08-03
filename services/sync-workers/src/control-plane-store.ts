import { ulid } from "ulid";
import type { RawBatchManifest, RawManifestRepository } from "../../../packages/storage/src/index.js";
import type { SyncJob } from "../../../packages/queue/src/index.js";
import type { ConnectionRuntimeRecord, TransactionalPostgres } from "./database.js";
import { PostgresVendorRateBudget } from "./vendor-rate-budget.js";

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export class ControlPlaneStore implements RawManifestRepository {
  constructor(private readonly db: TransactionalPostgres) {}

  vendorRateBudget(
    tenantId: string,
    connectionId: string,
    connectorId: SyncJob["connectorId"],
    options: Readonly<{ xeroDailyRequestLimit?: 1000 | 5000 }> = {},
  ): PostgresVendorRateBudget {
    return new PostgresVendorRateBudget(this.db, tenantId, connectionId, connectorId, options);
  }

  async acquireSyncWritePermit(job: SyncJob, workerId: string): Promise<void> {
    await this.db.query(
      "select control_plane.acquire_sync_write_permit($1,$2,$3,$4,1200)",
      [job.tenantId, job.connectionId, job.syncRunId, workerId],
    );
  }

  async releaseSyncWritePermit(job: SyncJob, workerId: string): Promise<void> {
    await this.db.query(
      "select control_plane.release_sync_write_permit($1,$2,$3)",
      [job.tenantId, job.syncRunId, workerId],
    );
  }

  async loadConnection(job: SyncJob): Promise<ConnectionRuntimeRecord> {
    const result = await this.db.query<{
      tenant_id: string;
      connection_id: string;
      connector_key: ConnectionRuntimeRecord["connectorKey"];
      external_account_reference: string | null;
      secret_reference: string | null;
    }>(
      `select connection.tenant_id,
              connection.connection_id,
              connection.connector_key,
              connection.external_account_reference,
              token.secret_reference
         from control_plane.connections as connection
         left join control_plane.oauth_token_refs as token
           on token.tenant_id = connection.tenant_id
          and token.connection_id = connection.connection_id
        where connection.tenant_id = $1
          and connection.connection_id = $2
          and connection.connector_key = $3
          and connection.status in ('connected', 'degraded')`,
      [job.tenantId, job.connectionId, job.connectorId],
    );
    const row = result.rows[0];
    if (!row || !row.external_account_reference || !row.secret_reference) {
      throw new Error("connection_not_ready");
    }
    if (row.external_account_reference !== job.externalAccountReference) {
      throw new Error("connection_account_mismatch");
    }
    return {
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      connectorKey: row.connector_key,
      externalAccountReference: row.external_account_reference,
      credentialRef: row.secret_reference,
    };
  }

  async beginRun(job: SyncJob, attemptNumber: number): Promise<"run" | "already_succeeded"> {
    return this.db.transaction(async (client) => {
      const existing = await client.query<{ status: string }>(
        `select status
           from control_plane.sync_runs
          where tenant_id = $1 and sync_run_id = $2
          for update`,
        [job.tenantId, job.syncRunId],
      );
      if (existing.rows[0]?.status === "succeeded") return "already_succeeded";

      if (!existing.rows[0]) {
        await client.query(
          `insert into control_plane.sync_runs (
             tenant_id, sync_run_id, connection_id, job_type, stream, status,
             attempt_number, queue_job_reference, cursor_start, scheduled_at,
             started_at
           ) values ($1, $2, $3, $4, $5, 'running', $6, $7, $8::jsonb, now(), now())`,
          [
            job.tenantId,
            job.syncRunId,
            job.connectionId,
            job.type,
            "stream" in job ? job.stream ?? null : null,
            attemptNumber,
            job.jobRequestId ?? null,
            json("cursor" in job ? job.cursor : null),
          ],
        );
      } else {
        await client.query(
          `update control_plane.sync_runs
              set status = 'running',
                  attempt_number = $3,
                  started_at = coalesce(started_at, now()),
                  finished_at = null,
                  error_code = null,
                  error_summary = null
            where tenant_id = $1 and sync_run_id = $2`,
          [job.tenantId, job.syncRunId, attemptNumber],
        );
      }
      return "run";
    });
  }

  async getCursor(tenantId: string, connectionId: string, stream: string) {
    const result = await this.db.query<{
      cursor_value: { value?: unknown; sourceUpdatedAt?: unknown } | null;
      backfill_complete: boolean;
    }>(
      `select cursor_value, backfill_complete
         from control_plane.stream_cursors
        where tenant_id = $1 and connection_id = $2 and stream = $3`,
      [tenantId, connectionId, stream],
    );
    const value = result.rows[0]?.cursor_value;
    return {
      cursor:
        value && typeof value.value === "string"
          ? {
              value: value.value,
              ...(typeof value.sourceUpdatedAt === "string"
                ? { sourceUpdatedAt: value.sourceUpdatedAt }
                : {}),
            }
          : null,
      backfillComplete: result.rows[0]?.backfill_complete ?? false,
    } as const;
  }

  async find(tenantId: string, batchId: string): Promise<RawBatchManifest | null> {
    const result = await this.db.query<{
      tenant_id: string;
      connection_id: string;
      sync_run_id: string;
      batch_id: string;
      connector_key: string;
      connector_version: string;
      api_version: string;
      stream: string;
      extracted_at: string | Date;
      cursor_start: RawBatchManifest["cursorStart"];
      cursor_end: RawBatchManifest["cursorEnd"];
      content_hash: string;
      schema_fingerprint: string;
      record_count: string | number;
      compressed_bytes: string | number;
      object_keys: string[];
    }>(
      `select manifest.*, connection.external_account_reference
         from control_plane.raw_batch_manifests as manifest
         join control_plane.connections as connection
           on connection.tenant_id = manifest.tenant_id
          and connection.connection_id = manifest.connection_id
        where manifest.tenant_id = $1 and manifest.batch_id = $2`,
      [tenantId, batchId],
    );
    const row = result.rows[0] as (typeof result.rows)[number] & {
      external_account_reference?: string;
    } | undefined;
    if (!row || row.object_keys.length !== 1 || !row.external_account_reference) return null;
    return {
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      syncRunId: row.sync_run_id,
      batchId: row.batch_id,
      connectorKey: row.connector_key,
      connectorVersion: row.connector_version,
      apiVersion: row.api_version,
      externalAccountReference: row.external_account_reference,
      stream: row.stream,
      extractedAt: new Date(row.extracted_at).toISOString(),
      cursorStart: row.cursor_start,
      cursorEnd: row.cursor_end,
      contentHash: row.content_hash,
      schemaFingerprint: row.schema_fingerprint,
      recordCount: Number(row.record_count),
      compressedBytes: Number(row.compressed_bytes),
      objectKeys: [row.object_keys[0]!],
    };
  }

  async registerUploaded(manifest: RawBatchManifest): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `insert into control_plane.raw_batch_manifests (
           tenant_id, batch_id, connection_id, sync_run_id, connector_key,
           connector_version, api_version, stream, extracted_at, cursor_start,
           cursor_end, content_hash, schema_fingerprint, record_count,
           compressed_bytes, object_keys
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
           $12, $13, $14, $15, $16::text[]
         ) on conflict (tenant_id, batch_id) do nothing`,
        [
          manifest.tenantId,
          manifest.batchId,
          manifest.connectionId,
          manifest.syncRunId,
          manifest.connectorKey,
          manifest.connectorVersion,
          manifest.apiVersion,
          manifest.stream,
          manifest.extractedAt,
          json(manifest.cursorStart),
          json(manifest.cursorEnd),
          manifest.contentHash,
          manifest.schemaFingerprint,
          manifest.recordCount,
          manifest.compressedBytes,
          [...manifest.objectKeys],
        ],
      );
      await client.query(
        `insert into control_plane.raw_batch_landings (tenant_id, batch_id, status)
         values ($1, $2, 'uploaded')
         on conflict (tenant_id, batch_id) do nothing`,
        [manifest.tenantId, manifest.batchId],
      );
    });
  }

  async markLandingStarted(tenantId: string, batchId: string): Promise<void> {
    await this.db.query(
      `update control_plane.raw_batch_landings
          set status = 'landing', attempt_count = attempt_count + 1, last_error = null
        where tenant_id = $1 and batch_id = $2 and status <> 'landed'`,
      [tenantId, batchId],
    );
  }

  async commitPage(input: Readonly<{
    job: SyncJob;
    cursor: unknown;
    sourceWatermark?: string;
    hasMore: boolean;
    recordCount: number;
    quarantineCount: number;
    domains: readonly string[];
    backfillComplete: boolean;
    mappingVersion: string;
  }>): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `update control_plane.raw_batch_landings
            set status = $3,
                staged_record_count = $4,
                quarantine_count = $5,
                analytical_committed_at = now(),
                last_error = null
          where tenant_id = $1 and batch_id = $2`,
        [
          input.job.tenantId,
          input.job.batchId,
          input.recordCount === 0 && input.quarantineCount > 0 ? "quarantined" : "landed",
          input.recordCount,
          input.quarantineCount,
        ],
      );
      if ("stream" in input.job && input.job.stream) {
        const advancesPrimaryCursor = input.job.type === "IncrementalSync" ||
          (input.job.type === "InitialBackfill" && input.job.phase === "recent");
        await client.query(
          `insert into control_plane.stream_cursors (
             tenant_id, connection_id, stream, cursor_value, source_watermark,
             last_successful_sync_at, backfill_complete, cursor_requested_at
           ) values (
             $1, $2, $3,
             case when $7 then $4::jsonb else null end,
             case when $7 then $5::timestamptz else null end,
             case when $7 then now() else null end,
             $6,
             case when $7 then $8::timestamptz else null end
           )
           on conflict (tenant_id, connection_id, stream) do update set
             cursor_value = case
               when not $7 then control_plane.stream_cursors.cursor_value
               when excluded.source_watermark is not null
                    and (
                      control_plane.stream_cursors.source_watermark is null
                      or excluded.source_watermark > control_plane.stream_cursors.source_watermark
                      or (
                        excluded.source_watermark = control_plane.stream_cursors.source_watermark
                        and excluded.cursor_requested_at >= coalesce(
                          control_plane.stream_cursors.cursor_requested_at,
                          '-infinity'::timestamptz
                        )
                      )
                    ) then excluded.cursor_value
               when excluded.source_watermark is null
                    and excluded.cursor_requested_at >= coalesce(
                      control_plane.stream_cursors.cursor_requested_at,
                      '-infinity'::timestamptz
                    ) then excluded.cursor_value
               else control_plane.stream_cursors.cursor_value
             end,
             source_watermark = case
               when $7 then greatest(
                 control_plane.stream_cursors.source_watermark,
                 excluded.source_watermark
               )
               else control_plane.stream_cursors.source_watermark
             end,
             last_successful_sync_at = case
               when $7 then now()
               else control_plane.stream_cursors.last_successful_sync_at
             end,
             cursor_requested_at = case
               when not $7 then control_plane.stream_cursors.cursor_requested_at
               when excluded.source_watermark is not null
                    and (
                      control_plane.stream_cursors.source_watermark is null
                      or excluded.source_watermark > control_plane.stream_cursors.source_watermark
                      or (
                        excluded.source_watermark = control_plane.stream_cursors.source_watermark
                        and excluded.cursor_requested_at >= coalesce(
                          control_plane.stream_cursors.cursor_requested_at,
                          '-infinity'::timestamptz
                        )
                      )
                    ) then excluded.cursor_requested_at
               when excluded.source_watermark is null
                    and excluded.cursor_requested_at >= coalesce(
                      control_plane.stream_cursors.cursor_requested_at,
                      '-infinity'::timestamptz
                    ) then excluded.cursor_requested_at
               else control_plane.stream_cursors.cursor_requested_at
             end,
             backfill_complete = control_plane.stream_cursors.backfill_complete or excluded.backfill_complete`,
          [
            input.job.tenantId,
            input.job.connectionId,
            input.job.stream,
            json(input.cursor),
            input.sourceWatermark ?? null,
            input.backfillComplete,
            advancesPrimaryCursor,
            input.job.requestedAt,
          ],
        );
      }
      for (const domain of input.domains) {
        await client.query(
          `insert into control_plane.readiness (
             tenant_id, connection_id, domain, state, progress, data_ready_through,
             backfill_complete, evaluated_at
           ) values ($1, $2, $3, $4, $5, $6, $7, now())
           on conflict (tenant_id, connection_id, domain) do update set
             state = case
               when control_plane.readiness.state in ('ready_partial', 'ready_complete')
                 then control_plane.readiness.state
               else excluded.state
             end,
             progress = greatest(coalesce(control_plane.readiness.progress, 0), excluded.progress),
             data_ready_through = control_plane.readiness.data_ready_through,
             backfill_complete = control_plane.readiness.backfill_complete,
             evaluated_at = now()`,
          [
            input.job.tenantId,
            input.job.connectionId,
            domain,
            "transforming",
            input.backfillComplete ? 0.9 : input.hasMore ? 0.45 : 0.7,
            null,
            false,
          ],
        );
      }
      await client.query(
        `select transform_job_id,created
           from control_plane.enqueue_canonical_transform_job(
             $1::text,$2::text,$3::text,$4::text[],$5::boolean
           )`,
        [
          input.job.tenantId,
          input.job.batchId,
          input.mappingVersion,
          [...input.domains],
          input.backfillComplete,
        ],
      );
      await client.query(
        `update control_plane.sync_runs
            set status = 'succeeded', cursor_end = $3::jsonb,
                record_count = $4, quarantine_count = $5, finished_at = now()
          where tenant_id = $1 and sync_run_id = $2`,
        [
          input.job.tenantId,
          input.job.syncRunId,
          json(input.cursor),
          input.recordCount,
          input.quarantineCount,
        ],
      );
    });
  }

  async markRunFailed(job: SyncJob, attemptNumber: number, code: string, detail: string): Promise<void> {
    await this.db.query(
      `update control_plane.sync_runs
          set status = 'retry_wait', error_code = $4, error_summary = $5
        where tenant_id = $1 and sync_run_id = $2
          and attempt_number = $3 and status <> 'succeeded'`,
      [job.tenantId, job.syncRunId, attemptNumber, code.slice(0, 120), detail.slice(0, 500)],
    );
  }

  async completeCoordinatorRun(job: SyncJob, childCount: number): Promise<void> {
    await this.db.query(
      `update control_plane.sync_runs
          set status = 'succeeded', record_count = 0, quarantine_count = 0,
              finished_at = now()
        where tenant_id = $1 and sync_run_id = $2 and status = 'running'`,
      [job.tenantId, job.syncRunId],
    );
    void childCount;
  }

  async recordQuarantineIndex(input: Readonly<{
    job: SyncJob;
    stream: string;
    batchObjectKey: string;
    records: readonly Readonly<{
      sourceObjectType: string;
      sourceRecordId?: string;
      payloadHash: string;
      code: string;
      path?: string;
      message: string;
    }>[];
  }>): Promise<void> {
    for (const record of input.records) {
      await this.db.query(
        `insert into control_plane.quarantine_items (
           tenant_id, quarantine_item_id, connection_id, sync_run_id, batch_id,
           stream, source_object_type, source_record_id, payload_hash,
           raw_object_key, error_code, error_path, error_summary, status
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'open')
         on conflict (
           tenant_id, batch_id, source_object_type, source_record_id, error_code, error_path
         ) do nothing`,
        [
          input.job.tenantId,
          ulid(),
          input.job.connectionId,
          input.job.syncRunId,
          input.job.batchId,
          input.stream,
          record.sourceObjectType,
          record.sourceRecordId ?? null,
          record.payloadHash,
          input.batchObjectKey,
          record.code,
          record.path ?? null,
          record.message.slice(0, 500),
        ],
      );
    }
  }
}
