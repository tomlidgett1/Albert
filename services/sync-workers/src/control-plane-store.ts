import { ulid } from "ulid";
import type { RawBatchManifest, RawManifestRepository } from "../../../packages/storage/src/index.js";
import {
  asSyncFailureCode,
  type ClaimedSyncJob,
  type SyncJob,
} from "../../../packages/queue/src/index.js";
import type {
  ConnectorStream,
  SyncPage,
} from "../../../packages/connector-sdk/src/index.js";
import type { ConnectionRuntimeRecord, TransactionalPostgres } from "./database.js";
import type { MachineSessionIdentity } from "../../../packages/storage/src/session-credentials.js";
import { PostgresVendorRateBudget } from "./vendor-rate-budget.js";
import type { BackfillPhasePlan } from "./sync-lifecycle.js";
import type { RawStorageSyncGrant } from "./raw-storage.js";

export type PersistedConnectionAuthHealth = "healthy" | "expired" | "revoked" | "error";

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function phaseOrdinal(phase: BackfillPhasePlan["phase"]): number {
  return phase === "recent" ? 1 : phase === "thirteen_months" ? 2 : 3;
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

  async registerReconciliationPlan(
    job: Extract<SyncJob, { type: "ReconciliationSweep" }>,
    streams: readonly ConnectorStream[],
  ): Promise<void> {
    if (job.stream) throw new Error("reconciliation_plan_requires_coordinator");
    await this.db.transaction(async (client) => {
      for (const stream of streams) {
        await client.query(
          `select control_plane.register_reconciliation_stream(
             $1,$2,$3::bigint,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12::timestamptz,$13::timestamptz
           )`,
          [
            job.tenantId,job.connectionId,job.connectionGeneration,
            job.reconciliationSweepId,job.connectorId,stream.id,
            stream.availability === "required",[...stream.domains],
            stream.lateEditStrategy,stream.deletionStrategy,stream.sourceTotalStrategy,
            job.lookbackFrom,job.lookbackTo,
          ],
        );
      }
    });
  }

  async beginReconciliationPhase(
    claim: ClaimedSyncJob & Readonly<{ job: Extract<SyncJob, { type: "ReconciliationSweep" }> }>,
  ): Promise<boolean> {
    const { job } = claim;
    if (!job.stream || !job.jobRequestId) throw new Error("reconciliation_phase_identity_missing");
    const result = await this.db.query<{ acquired: boolean }>(
      `select control_plane.begin_reconciliation_phase(
         $1,$2,$3::bigint,$4,$5,$6,$7,$8,$9::bigint,$10,$11::integer
       ) as acquired`,
      [job.tenantId,job.connectionId,job.connectionGeneration,job.reconciliationSweepId,
        job.stream,job.phase,job.jobRequestId,claim.queueName,claim.messageId,
        claim.workerId,claim.readCount],
    );
    return result.rows[0]?.acquired === true;
  }

  async completeReconciliationPhase(
    claim: ClaimedSyncJob & Readonly<{ job: Extract<SyncJob, { type: "ReconciliationSweep" }> }>,
    evidence: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const { job } = claim;
    if (!job.stream) throw new Error("reconciliation_phase_stream_missing");
    const result = await this.db.query<{ next_phase: string }>(
      `select control_plane.complete_reconciliation_phase(
         $1,$2,$3::bigint,$4,$5,$6,$7::jsonb,$8,$9,$10::bigint,$11,$12::integer
       ) as next_phase`,
      [job.tenantId,job.connectionId,job.connectionGeneration,job.reconciliationSweepId,
        job.stream,job.phase,JSON.stringify(evidence),job.jobRequestId,
        claim.queueName,claim.messageId,claim.workerId,claim.readCount],
    );
    const next = result.rows[0]?.next_phase;
    if (!next) throw new Error("reconciliation_phase_transition_missing");
    return next;
  }

  async blockReconciliationPhase(
    claim: ClaimedSyncJob & Readonly<{ job: Extract<SyncJob, { type: "ReconciliationSweep" }> }>,
    error: Readonly<{
      code: string;
      retryable: boolean;
      optional?: boolean;
      attempt?: number;
    }>,
  ): Promise<void> {
    const { job } = claim;
    if (!job.stream) return;
    const safeError = {
      code: asSyncFailureCode(error.code),
      retryable: error.retryable,
      ...(error.optional === undefined ? {} : { optional: error.optional }),
      ...(error.attempt === undefined ? {} : { attempt: error.attempt }),
    };
    await this.db.query(
      `select control_plane.block_reconciliation_phase(
         $1,$2,$3::bigint,$4,$5,$6,$7::jsonb,$8,$9,$10::bigint,$11,$12::integer
      )`,
      [job.tenantId,job.connectionId,job.connectionGeneration,job.reconciliationSweepId,
        job.stream,job.phase,JSON.stringify(safeError),job.jobRequestId,
        claim.queueName,claim.messageId,claim.workerId,claim.readCount],
    );
  }

  async acquireSyncWritePermit(claim: ClaimedSyncJob): Promise<string> {
    const { job } = claim;
    const result = await this.db.query<{ permit_id: unknown }>(
      `select permit_id from control_plane.acquire_sync_write_permit(
         $1::text,$2::text,$3::bigint,$4::text,$5::text,$6::text,$7::bigint,
         $8::text,$9::integer,1200
       )`,
      [job.tenantId, job.connectionId, job.connectionGeneration, job.syncRunId,
        job.jobRequestId, claim.queueName, claim.messageId, claim.workerId, claim.readCount],
    );
    const permitId = result.rows[0]?.permit_id;
    if (typeof permitId !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(permitId)) {
      throw new Error("sync_write_permit_invalid");
    }
    return permitId;
  }

  async releaseSyncWritePermit(tenantId: string, permitId: string, workerId: string): Promise<void> {
    await this.db.query(
      "select control_plane.release_sync_write_permit($1,$2,$3)",
      [tenantId, permitId, workerId],
    );
  }

  async issueRawStorageSyncSession(input: Readonly<{
    permitId: string;
    workerId: string;
    objectKey: string;
    identity: MachineSessionIdentity;
  }>): Promise<RawStorageSyncGrant> {
    const result = await this.db.query<{
      grant_id: unknown;
      tenant_id: unknown;
      connection_id: unknown;
      object_key: unknown;
      expires_at: unknown;
    }>(
      `select * from control_plane.issue_raw_storage_sync_session(
         $1::text,$2::text,$3::text,$4::uuid,$5::uuid,$6::timestamptz
       )`,
      [
        input.permitId,input.workerId,input.objectKey,input.identity.userId,
        input.identity.sessionId,input.identity.tokenExpiresAt.toISOString(),
      ],
    );
    const row = result.rows[0];
    if (
      typeof row?.grant_id !== "string" ||
      typeof row.tenant_id !== "string" ||
      typeof row.connection_id !== "string" ||
      typeof row.object_key !== "string" ||
      !(typeof row.expires_at === "string" || row.expires_at instanceof Date)
    ) {
      throw new Error("sync_raw_storage_grant_invalid");
    }
    return Object.freeze({
      grantId: row.grant_id,
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      objectKey: row.object_key,
      expiresAt: new Date(row.expires_at).toISOString(),
    });
  }

  async revokeRawStorageSyncSession(input: Readonly<{
    tenantId: string;
    permitId: string;
    workerId: string;
    grantId: string;
  }>): Promise<void> {
    const result = await this.db.query<{ revoked: boolean }>(
      `select control_plane.revoke_raw_storage_sync_session(
         $1::text,$2::text,$3::text,$4::text
       ) as revoked`,
      [input.tenantId,input.permitId,input.workerId,input.grantId],
    );
    if (result.rows[0]?.revoked !== true) {
      throw new Error("sync_raw_storage_grant_revocation_failed");
    }
  }

  async withSyncWritePermit<T>(
    claim: ClaimedSyncJob,
    permitId: string,
    operation: (analyticalCapability: string) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (client) => {
      const result = await client.query<{ capability: unknown }>(
        `select control_plane.assert_sync_write_permit_and_issue_capability(
           $1::text,$2::text
         ) as capability`,
        [permitId, claim.workerId],
      );
      const capability = result.rows[0]?.capability;
      if (typeof capability !== "string" || capability.length < 100 || capability.length > 4096) {
        throw new Error("sync_analytical_capability_invalid");
      }
      // The control transaction intentionally remains open while the callback
      // executes. Its row-share locks make reconnect/deletion wait until the
      // raw or analytical write is fully committed.
      return operation(capability);
    });
  }

  async loadConnection(job: SyncJob): Promise<ConnectionRuntimeRecord> {
    const result = await this.db.query<{
      tenant_id: string;
      connection_id: string;
      connector_key: ConnectionRuntimeRecord["connectorKey"];
      external_account_reference: string | null;
      secret_reference: string | null;
      connection_generation: string | number;
    }>(
      `select connection.tenant_id,
              connection.connection_id,
              connection.connector_key,
              connection.external_account_reference,
              connection.connection_generation,
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
    const connectionGeneration = Number(row.connection_generation);
    if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration !== job.connectionGeneration) {
      throw new Error("connection_generation_stale");
    }
    return {
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      connectorKey: row.connector_key,
      externalAccountReference: row.external_account_reference,
      credentialRef: row.secret_reference,
      connectionGeneration,
    };
  }

  async recordConnectionAuthHealth(
    claim: ClaimedSyncJob,
    authHealth: PersistedConnectionAuthHealth,
  ): Promise<void> {
    const { job } = claim;
    const result = await this.db.query<{ connection_id: string }>(
      `select control_plane.record_connection_auth_health(
         $1::text,$2::text,$3::bigint,$4::text,$5::text,$6::text,$7::text,
         $8::text,$9::text,$10::bigint,$11::text,$12::integer
       ) as connection_id`,
      [
        job.tenantId,
        job.connectionId,
        job.connectionGeneration,
        job.connectorId,
        job.externalAccountReference,
        job.syncRunId,
        authHealth,
        job.jobRequestId,
        claim.queueName,
        Number(claim.messageId),
        claim.workerId,
        claim.readCount,
      ],
    );
    if (!result.rows[0]) throw new Error("connection_auth_health_target_missing");
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
             started_at, connection_generation, backfill_phase, replay_version
           ) values ($1, $2, $3, $4, $5, 'running', $6, $7, $8::jsonb, now(), now(),
             $9, $10, $11)`,
          [
            job.tenantId,
            job.syncRunId,
            job.connectionId,
            job.type,
            "stream" in job ? job.stream ?? null : null,
            attemptNumber,
            job.jobRequestId ?? null,
            json("cursor" in job ? job.cursor : null),
            job.connectionGeneration,
            job.type === "InitialBackfill" ? job.phase : null,
            job.type === "InitialBackfill" ? job.replayVersion : null,
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
      if (job.type === "InitialBackfill" && job.stream) {
        const phase = await client.query<{ status: string }>(
          `update control_plane.sync_stream_phases
              set status='running',started_at=coalesce(started_at,now()),last_error=null
            where tenant_id=$1 and connection_id=$2 and connection_generation=$3
              and stream=$4 and phase=$5 and replay_version=$6
              and status in ('queued','running')
              and (
                predecessor_phase is null or exists (
                  select 1 from control_plane.sync_stream_phases predecessor
                   where predecessor.tenant_id=sync_stream_phases.tenant_id
                     and predecessor.connection_id=sync_stream_phases.connection_id
                     and predecessor.connection_generation=sync_stream_phases.connection_generation
                     and predecessor.stream=sync_stream_phases.stream
                     and predecessor.phase=sync_stream_phases.predecessor_phase
                     and predecessor.status='succeeded'
                )
              )
          returning status`,
          [
            job.tenantId,
            job.connectionId,
            job.connectionGeneration,
            job.stream,
            job.phase,
            job.replayVersion,
          ],
        );
        if (!phase.rows[0]) throw new Error("sync_stream_phase_lease_stale");
      }
      return "run";
    });
  }

  async getCursor(tenantId: string, connectionId: string, stream: string) {
    const result = await this.db.query<{
      cursor_value: { value?: unknown; sourceUpdatedAt?: unknown } | null;
      backfill_complete: boolean;
      source_watermark: string | Date | null;
      connection_generation: string | number;
      coverage_boundary_kind: NonNullable<SyncPage["coverage"]>["boundaryKind"] | null;
      coverage_lower_bound: string | Date | null;
      coverage_verification: NonNullable<SyncPage["coverage"]>["verification"] | null;
      coverage_detail: string | null;
    }>(
      `select cursor_value, backfill_complete, source_watermark, connection_generation,
              coverage_boundary_kind, coverage_lower_bound, coverage_verification, coverage_detail
         from control_plane.stream_cursors
        where tenant_id = $1 and connection_id = $2 and stream = $3`,
      [tenantId, connectionId, stream],
    );
    const value = result.rows[0]?.cursor_value;
    const row = result.rows[0];
    const lowerBound = row?.coverage_lower_bound
      ? new Date(row.coverage_lower_bound).toISOString()
      : null;
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
      sourceWatermark: row?.source_watermark
        ? new Date(row.source_watermark).toISOString()
        : null,
      connectionGeneration: Number(row?.connection_generation ?? 0),
      coverage: row?.coverage_boundary_kind && row.coverage_verification && lowerBound
        ? {
            boundaryKind: row.coverage_boundary_kind,
            lowerBound,
            verification: row.coverage_verification,
            ...(row.coverage_detail ? { detail: row.coverage_detail } : {}),
          }
        : null,
    } as const;
  }

  async registerBackfillPlan(
    job: Extract<SyncJob, { type: "InitialBackfill" }>,
    plans: readonly BackfillPhasePlan[],
  ): Promise<void> {
    if (job.stream) throw new Error("backfill_plan_requires_coordinator");
    await this.db.transaction(async (client) => {
      for (const plan of plans) {
        const sameStream = plans
          .filter((candidate) => candidate.stream === plan.stream)
          .sort((left, right) => phaseOrdinal(left.phase) - phaseOrdinal(right.phase));
        const index = sameStream.findIndex((candidate) => candidate.phase === plan.phase);
        const predecessor = index > 0 ? sameStream[index - 1]?.phase ?? null : null;
        await client.query(
          `select control_plane.register_sync_stream_phase(
             $1,$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10::text[],$11::text[],$12,$13,$14,$15::jsonb
           )`,
          [
            job.tenantId,
            job.connectionId,
            job.connectionGeneration,
            plan.stream,
            plan.phase,
            index + 1,
            plan.planMode,
            plan.strategy,
            plan.required,
            [...plan.domains],
            [...plan.dependencies],
            plan.range.from,
            plan.range.to,
            predecessor,
            json(plan.inheritedCoverage),
          ],
        );
      }
      await client.query(
        `select control_plane.seal_sync_dependency_plan($1,$2,$3::bigint)`,
        [job.tenantId,job.connectionId,job.connectionGeneration],
      );
    });
  }

  async markBackfillPhaseEnqueued(
    input: Readonly<{
      job: Extract<SyncJob, { type: "InitialBackfill" }>;
      stream: string;
      phase: Extract<SyncJob, { type: "InitialBackfill" }>["phase"];
      replayVersion: number;
      jobRequestId: string;
    }>,
  ): Promise<void> {
    await this.db.query(
      `select control_plane.mark_sync_stream_phase_enqueued(
         $1,$2,$3::bigint,$4,$5,$6,$7
       )`,
      [
        input.job.tenantId,
        input.job.connectionId,
        input.job.connectionGeneration,
        input.stream,
        input.phase,
        input.replayVersion,
        input.jobRequestId,
      ],
    );
  }

  async backfillPhase(
    job: Extract<SyncJob, { type: "InitialBackfill" }>,
  ): Promise<Readonly<{
    inheritedCoverage: SyncPage["coverage"] | null;
    required: boolean;
    strategy: BackfillPhasePlan["strategy"];
  }>> {
    if (!job.stream) throw new Error("backfill_phase_requires_stream");
    const result = await this.db.query<{
      required: boolean;
      backfill_strategy: BackfillPhasePlan["strategy"];
      inherited_coverage: boolean;
      coverage_boundary_kind: NonNullable<SyncPage["coverage"]>["boundaryKind"] | null;
      coverage_lower_bound: string | Date | null;
      coverage_verification: NonNullable<SyncPage["coverage"]>["verification"] | null;
      coverage_detail: string | null;
    }>(
      `select required,backfill_strategy,inherited_coverage,coverage_boundary_kind,
              coverage_lower_bound,coverage_verification,coverage_detail
         from control_plane.sync_stream_phases
        where tenant_id=$1 and connection_id=$2 and connection_generation=$3
          and stream=$4 and phase=$5 and replay_version=$6`,
      [
        job.tenantId,
        job.connectionId,
        job.connectionGeneration,
        job.stream,
        job.phase,
        job.replayVersion,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("sync_stream_phase_missing");
    const lowerBound = row.coverage_lower_bound
      ? new Date(row.coverage_lower_bound).toISOString()
      : null;
    return {
      required: row.required,
      strategy: row.backfill_strategy,
      inheritedCoverage: row.inherited_coverage && row.coverage_boundary_kind &&
          row.coverage_verification && lowerBound
        ? {
            boundaryKind: row.coverage_boundary_kind,
            lowerBound,
            verification: row.coverage_verification,
            ...(row.coverage_detail ? { detail: row.coverage_detail } : {}),
          }
        : null,
    };
  }

  async nextBackfillPhase(
    job: Extract<SyncJob, { type: "InitialBackfill" }>,
  ): Promise<BackfillPhasePlan | null> {
    if (!job.stream) return null;
    const result = await this.db.query<{
      stream: string;
      domains: string[];
      dependencies: string[];
      required: boolean;
      backfill_strategy: BackfillPhasePlan["strategy"];
      phase: BackfillPhasePlan["phase"];
      plan_mode: BackfillPhasePlan["planMode"];
      range_from: string | Date;
      range_to: string | Date;
      replay_version: number;
    }>(
      `select successor.stream,successor.domains,successor.dependencies,successor.required,
              successor.backfill_strategy,successor.phase,successor.plan_mode,
              successor.range_from,successor.range_to,successor.replay_version
         from control_plane.sync_stream_phases current_phase
         join control_plane.sync_stream_phases successor
           on successor.tenant_id=current_phase.tenant_id
          and successor.connection_id=current_phase.connection_id
          and successor.connection_generation=current_phase.connection_generation
          and successor.stream=current_phase.stream
          and successor.phase_ordinal=current_phase.phase_ordinal+1
        where current_phase.tenant_id=$1 and current_phase.connection_id=$2
          and current_phase.connection_generation=$3 and current_phase.stream=$4
          and current_phase.phase=$5`,
      [job.tenantId,job.connectionId,job.connectionGeneration,job.stream,job.phase],
    );
    const row = result.rows[0];
    return row ? {
      stream: row.stream,
      domains: row.domains,
      dependencies: row.dependencies,
      required: row.required,
      strategy: row.backfill_strategy,
      phase: row.phase,
      planMode: row.plan_mode,
      range: {
        from: new Date(row.range_from).toISOString(),
        to: new Date(row.range_to).toISOString(),
      },
      replayVersion: Number(row.replay_version),
      inheritedCoverage: null,
    } : null;
  }

  async markOptionalBackfillUnavailable(
    job: Extract<SyncJob, { type: "InitialBackfill" }>,
    error: Readonly<{ code: string; retryable: boolean }>,
  ): Promise<void> {
    if (!job.stream) throw new Error("optional_stream_requires_stream");
    await this.db.transaction(async (client) => {
      await client.query(
        `select control_plane.mark_sync_stream_phase_unavailable(
           $1,$2,$3::bigint,$4,$5,$6,$7::jsonb
         )`,
        [
          job.tenantId,
          job.connectionId,
          job.connectionGeneration,
          job.stream,
          job.phase,
          job.replayVersion,
          JSON.stringify({
            code: "capability_unavailable",
            retryable: error.retryable,
          }),
        ],
      );
      await client.query(
        `update control_plane.sync_runs set status='succeeded',error_code=$3,
                error_summary=$4,finished_at=now()
          where tenant_id=$1 and sync_run_id=$2 and status='running'`,
        [job.tenantId,job.syncRunId,"capability_unavailable","capability_unavailable"],
      );
    });
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
    coverage: SyncPage["coverage"] | null;
    mappingVersion: string;
    reconciliationTransition?: Readonly<{
      claim: ClaimedSyncJob & Readonly<{
        job: Extract<SyncJob, { type: "ReconciliationSweep" }>;
      }>;
      evidence: Readonly<Record<string, unknown>>;
    }>;
  }>): Promise<void> {
    await this.db.transaction(async (client) => {
      const generationFence = await client.query<{ connection_generation: string | number }>(
        `select connection_generation
           from control_plane.connections
          where tenant_id=$1 and connection_id=$2
            and connection_generation=$3
            and status in ('connected','degraded')
          for update`,
        [input.job.tenantId,input.job.connectionId,input.job.connectionGeneration],
      );
      if (!generationFence.rows[0]) throw new Error("connection_generation_stale");
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
             last_successful_sync_at, backfill_complete, cursor_requested_at,
             connection_generation,coverage_boundary_kind,coverage_lower_bound,
             coverage_verification,coverage_detail
           ) values (
             $1, $2, $3,
             case when $7 then $4::jsonb else null end,
             case when $7 then $5::timestamptz else null end,
             case when $7 then now() else null end,
             $6,
             case when $7 then $8::timestamptz else null end,
             $9,$10,$11::timestamptz,$12,$13
           )
           on conflict (tenant_id, connection_id, stream) do update set
             cursor_value = case
               when excluded.connection_generation > control_plane.stream_cursors.connection_generation
                    and $7 then excluded.cursor_value
               when not $7 then control_plane.stream_cursors.cursor_value
               when excluded.connection_generation < control_plane.stream_cursors.connection_generation
                    then control_plane.stream_cursors.cursor_value
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
               when excluded.connection_generation > control_plane.stream_cursors.connection_generation
                    and $7 then excluded.source_watermark
               when excluded.connection_generation < control_plane.stream_cursors.connection_generation
                    then control_plane.stream_cursors.source_watermark
               when $7 then greatest(
                 control_plane.stream_cursors.source_watermark,
                 excluded.source_watermark
               )
               else control_plane.stream_cursors.source_watermark
             end,
             last_successful_sync_at = case
               when excluded.connection_generation < control_plane.stream_cursors.connection_generation
                    then control_plane.stream_cursors.last_successful_sync_at
               when $7 then now()
               else control_plane.stream_cursors.last_successful_sync_at
             end,
             cursor_requested_at = case
               when excluded.connection_generation > control_plane.stream_cursors.connection_generation
                    and $7 then excluded.cursor_requested_at
               when not $7 then control_plane.stream_cursors.cursor_requested_at
               when excluded.connection_generation < control_plane.stream_cursors.connection_generation
                    then control_plane.stream_cursors.cursor_requested_at
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
             connection_generation = greatest(
               control_plane.stream_cursors.connection_generation,
               excluded.connection_generation
             ),
             backfill_complete = case
               when excluded.connection_generation > control_plane.stream_cursors.connection_generation
                 then excluded.backfill_complete
               when excluded.connection_generation = control_plane.stream_cursors.connection_generation
                 then control_plane.stream_cursors.backfill_complete or excluded.backfill_complete
               else control_plane.stream_cursors.backfill_complete
             end,
             coverage_boundary_kind = case
               when excluded.connection_generation > control_plane.stream_cursors.connection_generation
                    then excluded.coverage_boundary_kind
               when excluded.connection_generation = control_plane.stream_cursors.connection_generation
                    and excluded.backfill_complete then excluded.coverage_boundary_kind
               else control_plane.stream_cursors.coverage_boundary_kind end,
             coverage_lower_bound = case
               when excluded.connection_generation > control_plane.stream_cursors.connection_generation
                    then excluded.coverage_lower_bound
               when excluded.connection_generation = control_plane.stream_cursors.connection_generation
                    and excluded.backfill_complete then excluded.coverage_lower_bound
               else control_plane.stream_cursors.coverage_lower_bound end,
             coverage_verification = case
               when excluded.connection_generation > control_plane.stream_cursors.connection_generation
                    then excluded.coverage_verification
               when excluded.connection_generation = control_plane.stream_cursors.connection_generation
                    and excluded.backfill_complete then excluded.coverage_verification
               else control_plane.stream_cursors.coverage_verification end,
             coverage_detail = case
               when excluded.connection_generation > control_plane.stream_cursors.connection_generation
                    then excluded.coverage_detail
               when excluded.connection_generation = control_plane.stream_cursors.connection_generation
                    and excluded.backfill_complete then excluded.coverage_detail
               else control_plane.stream_cursors.coverage_detail end`,
          [
            input.job.tenantId,
            input.job.connectionId,
            input.job.stream,
            json(input.cursor),
            input.sourceWatermark ?? null,
            input.backfillComplete,
            advancesPrimaryCursor,
            input.job.requestedAt,
            input.job.connectionGeneration,
            input.coverage?.boundaryKind ?? null,
            input.coverage?.lowerBound ?? null,
            input.coverage?.verification ?? null,
            input.coverage?.detail ?? null,
          ],
        );
        if (input.job.type === "InitialBackfill") {
          await client.query(
            `update control_plane.sync_stream_phases
                set status=case when $7 then status else 'succeeded' end,
                    completed_at=case when $7 then completed_at else now() end,
                    coverage_boundary_kind=case when $6 then $8 else coverage_boundary_kind end,
                    coverage_lower_bound=case when $6 then $9::timestamptz else coverage_lower_bound end,
                    coverage_verification=case when $6 then $10 else coverage_verification end,
                    coverage_detail=case when $6 then $11 else coverage_detail end,
                    last_error=null
              where tenant_id=$1 and connection_id=$2 and connection_generation=$3
                and stream=$4 and phase=$5 and replay_version=$12
                and status in ('queued','running')`,
            [
              input.job.tenantId,
              input.job.connectionId,
              input.job.connectionGeneration,
              input.job.stream,
              input.job.phase,
              input.backfillComplete,
              input.hasMore,
              input.coverage?.boundaryKind ?? null,
              input.coverage?.lowerBound ?? null,
              input.coverage?.verification ?? null,
              input.coverage?.detail ?? null,
              input.job.replayVersion,
            ],
          );
        }
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
      if (input.reconciliationTransition) {
        const transition = input.reconciliationTransition;
        const reconciliationJob = transition.claim.job;
        await client.query(
          `select control_plane.complete_reconciliation_phase(
             $1,$2,$3::bigint,$4,$5,$6,$7::jsonb,$8,$9,$10::bigint,$11,$12::integer
           )`,
          [reconciliationJob.tenantId,reconciliationJob.connectionId,
            reconciliationJob.connectionGeneration,reconciliationJob.reconciliationSweepId,
            reconciliationJob.stream,reconciliationJob.phase,JSON.stringify(transition.evidence),
            reconciliationJob.jobRequestId,transition.claim.queueName,
            transition.claim.messageId,transition.claim.workerId,transition.claim.readCount],
        );
      }
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

  async markRunFailed(
    job: SyncJob,
    attemptNumber: number,
    code: string,
    terminal = false,
  ): Promise<void> {
    const safeCode = asSyncFailureCode(code);
    await this.db.transaction(async (client) => {
      await client.query(
      `update control_plane.sync_runs
          set status = $6, error_code = $4, error_summary = $5,
              finished_at=case when $6='failed' then now() else null end
        where tenant_id = $1 and sync_run_id = $2
          and attempt_number = $3 and status <> 'succeeded'`,
        [
          job.tenantId,
          job.syncRunId,
          attemptNumber,
          safeCode,
          safeCode,
          terminal ? "failed" : "retry_wait",
        ],
      );
      if (terminal && job.type === "InitialBackfill" && job.stream) {
        await client.query(
          `update control_plane.sync_stream_phases
              set status='failed',last_error=jsonb_build_object(
                    'code',$7::text,'retryable',false
                  ),available_at=now()+interval '15 minutes'
            where tenant_id=$1 and connection_id=$2 and connection_generation=$3
              and stream=$4 and phase=$5 and replay_version=$6
              and status in ('queued','running')`,
          [
            job.tenantId,
            job.connectionId,
            job.connectionGeneration,
            job.stream,
            job.phase,
            job.replayVersion,
            safeCode,
          ],
        );
      }
    });
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

  async resolveQuarantineIndex(input: Readonly<{
    claim: ClaimedSyncJob;
    permitId: string;
    stream: string;
    records: readonly Readonly<{
      sourceObjectType: string;
      sourceRecordId: string;
    }>[];
  }>): Promise<number> {
    if (input.records.length === 0) return 0;
    const result = await this.db.query<{ resolved_count: string | number }>(
      `select control_plane.resolve_quarantine_items(
         $1::text,$2::text,$3::text,$4::jsonb
       ) as resolved_count`,
      [input.permitId,input.claim.workerId,input.stream,JSON.stringify(
        input.records.map((record) => ({
          sourceObjectType:record.sourceObjectType,
          sourceRecordId:record.sourceRecordId,
        })),
      )],
    );
    const count = Number(result.rows[0]?.resolved_count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("quarantine_resolution_result_invalid");
    }
    return count;
  }
}
