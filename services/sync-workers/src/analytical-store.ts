import { ulid } from "ulid";
import {
  assertCapabilityIds,
  makeNamespacedSourceKey,
  type ConnectorStream,
  type ConnectorCapability,
  type RawSourceRecord,
} from "../../../packages/connector-sdk/src/index.js";
import type { RawBatchManifest } from "../../../packages/storage/src/index.js";
import type { PostgresQueryClient, SyncJob } from "../../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "./database.js";
import { prepareTypedStaging, upsertTypedStagingRecord } from "./typed-staging.js";
import type { ConnectorQualityResult } from "./connector-quality.js";

export type QuarantinedProjection = Readonly<{
  sourceObjectType: string;
  sourceRecordId?: string;
  payloadHash: string;
  code: string;
  path?: string;
  message: string;
}>;

export type ResolvedQuarantineProjection = Readonly<{
  sourceObjectType: string;
  sourceRecordId: string;
}>;

export type LandingResult = Readonly<{
  stagedRecordCount: number;
  quarantined: readonly QuarantinedProjection[];
  resolved: readonly ResolvedQuarantineProjection[];
}>;

export type ReconciliationSnapshotResult = Readonly<{
  status: "running" | "complete" | "failed";
  uniqueCount: number;
  duplicateCount?: number;
  membershipDeltaCount?: number;
  sourceTotal?: number | null;
  idempotentReplay?: boolean;
}>;

export type ReconciliationTombstoneCandidate = Readonly<{
  namespacedSourceKey: string;
  sourceObjectType: string;
  sourceRecordId: string;
  normalized: NonNullable<RawSourceRecord["normalized"]>;
  expectedPayloadHash: string;
  expectedSourceUpdatedAt: string | null;
  expectedIngestedAt: string;
  firstSnapshotBatchId: string;
  verificationSnapshotBatchId: string;
}>;

export class AnalyticalLandingStore {
  constructor(
    private readonly db: TransactionalPostgres,
    private readonly mappingVersion: string,
  ) {
    if (!mappingVersion.trim()) throw new Error("A mapping version is required.");
  }

  get version(): string {
    return this.mappingVersion;
  }

  async registerConnectorStreams(input: Readonly<{
    job: SyncJob;
    streams: readonly ConnectorStream[];
  }>, capability?: string): Promise<number> {
    const declarations = input.streams.map((stream) => ({
      stream: stream.id,
      required: stream.availability === "required",
      lateEditStrategy: stream.lateEditStrategy,
      deletionStrategy: stream.deletionStrategy,
      sourceTotalStrategy: stream.sourceTotalStrategy,
    }));
    return this.db.transaction(async (client) => {
      await establishIngestScope(client,input.job.tenantId,capability);
      const result = await client.query<{ published: number | string }>(
        `select quality.register_connector_streams($1,$2,$3::bigint,$4,$5::jsonb) as published`,
        [input.job.tenantId,input.job.connectionId,input.job.connectionGeneration,
          input.job.connectorId,JSON.stringify(declarations)],
      );
      return Number(result.rows[0]?.published ?? 0);
    });
  }

  async recordConnectorStreamPage(input: Readonly<{
    job: SyncJob;
    stream: string;
    records: readonly RawSourceRecord[];
    landing: LandingResult;
    hasMore: boolean;
    nextCursorPresent: boolean;
    backfillComplete: boolean;
    coverage: import("../../../packages/connector-sdk/src/index.js").SyncPage["coverage"] | null;
    sourceTotal?: number;
  }>, capability?: string): Promise<void> {
    let schemaDriftCount = 0;
    let enumDriftCount = 0;
    let tombstoneCount = 0;
    for (const record of input.records) {
      if (record.normalized?.tombstone) tombstoneCount += 1;
      for (const issue of record.validationIssues ?? []) {
        if (issue.code === "schema_drift") schemaDriftCount += 1;
        if (issue.code === "schema_invalid" || issue.code === "normalization_invalid") enumDriftCount += 1;
      }
    }
    const evidence = {
      recordCount: input.records.length,
      quarantineCount: input.landing.quarantined.length,
      schemaDriftCount,
      enumDriftCount,
      tombstoneCount,
      cursorLinkValid: !input.hasMore || input.nextCursorPresent,
      cursorComplete: !input.hasMore,
      backfillComplete: input.backfillComplete,
      ...(input.coverage === null ? {} : { coverage: input.coverage }),
      ...(input.sourceTotal === undefined ? {} : { sourceTotal: input.sourceTotal }),
      jobType: input.job.type,
      ...(input.job.type === "ReconciliationSweep" ? { reconciliationPhase: input.job.phase } : {}),
    };
    await this.db.transaction(async (client) => {
      await establishIngestScope(client,input.job.tenantId,capability);
      await client.query(
        `select quality.record_connector_stream_page($1,$2,$3::bigint,$4,$5,$6::jsonb)`,
        [input.job.tenantId,input.job.connectionId,input.job.connectionGeneration,
          input.stream,input.job.batchId,JSON.stringify(evidence)],
      );
    });
  }

  async refreshConnectorQualityRollup(job: SyncJob, capability?: string): Promise<void> {
    await this.db.transaction(async (client) => {
      await establishIngestScope(client,job.tenantId,capability);
      await client.query("select quality.refresh_connector_quality_rollup($1,$2)", [
        job.tenantId,job.syncRunId,
      ]);
    });
  }

  async recordReconciliationSnapshotPage(input: Readonly<{
    job: Extract<SyncJob, { type: "ReconciliationSweep" }>;
    stream: ConnectorStream;
    records: readonly RawSourceRecord[];
    landing: LandingResult;
    hasMore: boolean;
    sourceTotal?: number;
  }>, capability?: string): Promise<ReconciliationSnapshotResult> {
    if (input.job.phase !== "identity_snapshot" && input.job.phase !== "verify_snapshot") {
      throw new Error("reconciliation_snapshot_phase_invalid");
    }
    const structurallyValidIdentity = (record: RawSourceRecord) =>
      record.sourceRecordId.length > 0 && record.sourceRecordId.length <= 300 &&
      !/[\u0000-\u001f\u007f]/u.test(record.sourceRecordId) &&
      record.sourceObjectType.length > 0 && record.sourceObjectType.length <= 200 &&
      /^[0-9a-f]{64}$/u.test(record.payloadHash);
    // A record can fail typed normalization while still carrying a valid
    // vendor-owned identity. Persist that identity, count the invalid payload,
    // and fail the snapshot closed; never mistake quarantine for source absence.
    const identities = input.records.filter(structurallyValidIdentity).map((record) => ({
      sourceObjectType: record.sourceObjectType,
      sourceRecordId: record.sourceRecordId,
      ...(record.sourceUpdatedAt ? { sourceUpdatedAt: record.sourceUpdatedAt } : {}),
      payloadHash: record.payloadHash,
    }));
    const invalidCount = input.records.filter((record) =>
      !structurallyValidIdentity(record) || !record.normalized || Boolean(record.validationIssues?.length)
    ).length;
    return this.db.transaction(async (client) => {
      await establishIngestScope(client,input.job.tenantId,capability);
      const result = await client.query<{ summary: ReconciliationSnapshotResult }>(
        `select quality.record_reconciliation_snapshot_page(
           $1,$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::bigint,$13::bigint,$14,$15::bigint
         ) as summary`,
        [input.job.tenantId,input.job.connectionId,input.job.connectionGeneration,
          input.job.reconciliationSweepId,input.job.connectorId,input.stream.id,
          input.job.phase === "identity_snapshot" ? 1 : 2,input.stream.deletionStrategy,
          input.stream.sourceTotalStrategy,input.job.batchId,JSON.stringify(identities),
          invalidCount,input.landing.quarantined.length,input.hasMore,input.sourceTotal ?? null],
      );
      const summary = result.rows[0]?.summary;
      if (!summary || !["running","complete","failed"].includes(summary.status)) {
        throw new Error("reconciliation_snapshot_result_invalid");
      }
      return summary;
    });
  }

  async reconciliationTombstoneCandidates(input: Readonly<{
    job: Extract<SyncJob, { type: "ReconciliationSweep" }>;
    afterKey?: string;
    limit?: number;
  }>, capability?: string): Promise<readonly ReconciliationTombstoneCandidate[]> {
    if (!input.job.stream) throw new Error("reconciliation_candidate_stream_missing");
    return this.db.transaction(async (client) => {
      await establishIngestScope(client,input.job.tenantId,capability);
      const result = await client.query<{
        namespaced_source_key: string;
        source_object_type: string;
        source_record_id: string;
        normalized_payload: NonNullable<RawSourceRecord["normalized"]>;
        expected_payload_hash: string;
        expected_source_updated_at: Date | string | null;
        expected_ingested_at: Date | string;
        first_snapshot_batch_id: string;
        verification_snapshot_batch_id: string;
      }>(
        `select * from quality.reconciliation_tombstone_candidates(
           $1,$2,$3::bigint,$4,$5,$6,$7
         )`,
        [input.job.tenantId,input.job.connectionId,input.job.connectionGeneration,
          input.job.reconciliationSweepId,input.job.stream,input.afterKey ?? null,input.limit ?? 500],
      );
      return result.rows.map((row) => ({
        namespacedSourceKey: row.namespaced_source_key,
        sourceObjectType: row.source_object_type,
        sourceRecordId: row.source_record_id,
        normalized: row.normalized_payload,
        expectedPayloadHash: row.expected_payload_hash,
        expectedSourceUpdatedAt: row.expected_source_updated_at === null
          ? null
          : new Date(row.expected_source_updated_at).toISOString(),
        expectedIngestedAt: new Date(row.expected_ingested_at).toISOString(),
        firstSnapshotBatchId: row.first_snapshot_batch_id,
        verificationSnapshotBatchId: row.verification_snapshot_batch_id,
      }));
    });
  }

  async recordReconciliationTombstoneApplications(input: Readonly<{
    job: Extract<SyncJob, { type: "ReconciliationSweep" }>;
    candidates: readonly ReconciliationTombstoneCandidate[];
  }>, capability?: string): Promise<number> {
    if (!input.job.stream) throw new Error("reconciliation_application_stream_missing");
    const applications = input.candidates.map((candidate) => ({
      namespacedSourceKey: candidate.namespacedSourceKey,
      sourceObjectType: candidate.sourceObjectType,
      sourceRecordId: candidate.sourceRecordId,
      firstSnapshotBatchId: candidate.firstSnapshotBatchId,
      verificationSnapshotBatchId: candidate.verificationSnapshotBatchId,
    }));
    return this.db.transaction(async (client) => {
      await establishIngestScope(client,input.job.tenantId,capability);
      const result = await client.query<{ published: number | string }>(
        `select quality.record_reconciliation_tombstone_applications(
           $1,$2,$3::bigint,$4,$5,$6,$7::jsonb
         ) as published`,
        [input.job.tenantId,input.job.connectionId,input.job.connectionGeneration,
          input.job.reconciliationSweepId,input.job.stream,input.job.batchId,
          JSON.stringify(applications)],
      );
      return Number(result.rows[0]?.published ?? 0);
    });
  }

  async completeConnectorReconciliation(
    job: Extract<SyncJob, { type: "ReconciliationSweep" }>,
    capability?: string,
  ): Promise<number> {
    if (!job.stream) throw new Error("reconciliation_completion_stream_missing");
    return this.db.transaction(async (client) => {
      await establishIngestScope(client,job.tenantId,capability);
      const result = await client.query<{ completed: string | number }>(
        `select quality.complete_connector_reconciliation($1,$2,$3::bigint,$4,$5) as completed`,
        [job.tenantId,job.connectionId,job.connectionGeneration,
          job.reconciliationSweepId,job.stream],
      );
      return Number(result.rows[0]?.completed ?? 0);
    });
  }

  async publishCapabilityObservations(input: Readonly<{
    job: SyncJob;
    packVersion: string;
    stream: string;
    sourceWatermark: string;
    recordCount: number;
    observations: readonly ConnectorCapability[];
  }>, capability?: string): Promise<number> {
    assertCapabilityIds(input.observations.map((observation) => observation.id), `${input.job.connectorId} live capability probe`);
    if (!input.packVersion.trim() || !/^[a-z][a-z0-9_]*$/.test(input.stream)) {
      throw new Error("connector_capability_publication_metadata_invalid");
    }
    if (!Number.isInteger(input.recordCount) || input.recordCount < 0 || input.observations.length > 64) {
      throw new Error("connector_capability_publication_size_invalid");
    }
    const observations = input.observations.map((observation) => {
      if (!/^[a-z][a-z0-9_]{0,119}$/.test(observation.reasonCode)) {
        throw new Error(`connector_capability_reason_invalid:${observation.id}`);
      }
      const requiredScopes = [...new Set(observation.requiredScopes ?? [])].sort();
      if (requiredScopes.length > 64 || requiredScopes.some((scope) => !scope.trim() || scope.length > 200)) {
        throw new Error(`connector_capability_scopes_invalid:${observation.id}`);
      }
      return {
        id: observation.id,
        support: observation.support,
        reasonCode: observation.reasonCode,
        ...(observation.notes ? { notes: observation.notes.slice(0, 500) } : {}),
        requiredScopes,
        coverage: {
          ...(observation.coverage ?? {}),
          stream: input.stream,
          observedRecords: input.recordCount,
        },
      };
    });
    return this.db.transaction(async (client) => {
      await establishIngestScope(client,input.job.tenantId,capability);
      const result = await client.query<{ published: number | string }>(
        `select semantic_internal.publish_connector_capability_observations(
           $1::text,$2::text,$3::text,$4::text,$5::text,$6::timestamptz,$7::jsonb
         ) as published`,
        [
          input.job.tenantId,
          input.job.connectionId,
          input.job.connectorId,
          input.packVersion,
          input.stream,
          input.sourceWatermark,
          JSON.stringify(observations),
        ],
      );
      const published = Number(result.rows[0]?.published ?? 0);
      if (!Number.isSafeInteger(published) || published < 0) {
        throw new Error("connector_capability_publication_result_invalid");
      }
      return published;
    });
  }

  async publishConnectorQualityResults(input:Readonly<{
    job:SyncJob;
    stream:string;
    results:readonly ConnectorQualityResult[];
  }>, capability?:string):Promise<number>{
    if(!/^[a-z][a-z0-9_]*$/.test(input.stream)||input.results.length!==7){
      throw new Error("connector_quality_publication_invalid");
    }
    return this.db.transaction(async(client)=>{
      await establishIngestScope(client,input.job.tenantId,capability);
      const published=await client.query<{published:number|string}>(
        `select quality.publish_connector_quality_results(
           $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::jsonb
         ) as published`,
        [input.job.tenantId,input.job.syncRunId,input.job.batchId,input.job.connectionId,input.job.connectorId,input.stream,JSON.stringify(input.results)],
      );
      const count=Number(published.rows[0]?.published??0);
      if(!Number.isSafeInteger(count)||count<0)throw new Error("connector_quality_publication_result_invalid");
      return count;
    });
  }

  async land(
    job: SyncJob,
    manifest: RawBatchManifest,
    records: readonly RawSourceRecord[],
    capability?: string,
  ): Promise<LandingResult> {
    return this.db.transaction(async (client) => {
      await establishIngestScope(client,job.tenantId,capability);
      const committed = await client.query<{ staged_record_count: string | number; quarantine_count: string | number }>(
        `select staged_record_count, quarantine_count
           from ingestion.landing_commits
          where tenant_id = $1 and batch_id = $2 and mapping_version = $3`,
        [job.tenantId, job.batchId, this.mappingVersion],
      );
      if (committed.rows[0]) {
        const existingQuarantine = await client.query<{
          source_object_type: string;
          source_record_id: string | null;
          payload_hash: string;
          error_code: string;
          error_path: string | null;
          error_summary: string;
        }>(
          `select source_object_type, source_record_id, payload_hash,
                  error_code, error_path, error_summary
             from ingestion.quarantine_records
            where tenant_id = $1 and payload_batch_id = $2
              and mapping_version = $3
            order by quarantine_id`,
          [job.tenantId, job.batchId, this.mappingVersion],
        );
        const existingResolutions = await client.query<{
          source_object_type: string;
          source_record_id: string;
        }>(
          `select distinct source_object_type,source_record_id
             from ingestion.quarantine_records
            where tenant_id=$1 and connection_id=$2 and stream=$3
              and replayed_in_sync_run_id=$4 and resolution_reason='validated_replay'
              and status='resolved' and source_record_id is not null
            order by source_object_type,source_record_id`,
          [job.tenantId,job.connectionId,manifest.stream,job.syncRunId],
        );
        return {
          stagedRecordCount: Number(committed.rows[0].staged_record_count),
          quarantined: existingQuarantine.rows.map((row) => ({
            sourceObjectType: row.source_object_type,
            ...(row.source_record_id ? { sourceRecordId: row.source_record_id } : {}),
            payloadHash: row.payload_hash,
            code: row.error_code,
            ...(row.error_path ? { path: row.error_path } : {}),
            message: row.error_summary,
          })),
          resolved: existingResolutions.rows.map((row) => ({
            sourceObjectType:row.source_object_type,
            sourceRecordId:row.source_record_id,
          })),
        };
      }

      await client.query(
        `insert into ingestion.batch_manifests (
           tenant_id, batch_id, connection_id, sync_run_id, connector_key,
           connector_version, api_version, stream, external_account_reference,
           extracted_at, cursor_start, cursor_end, content_hash,
           schema_fingerprint, record_count, compressed_bytes, object_keys
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
           $13, $14, $15, $16, $17::text[]
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
          manifest.externalAccountReference,
          manifest.extractedAt,
          JSON.stringify(manifest.cursorStart),
          JSON.stringify(manifest.cursorEnd),
          manifest.contentHash,
          manifest.schemaFingerprint,
          manifest.recordCount,
          manifest.compressedBytes,
          [...manifest.objectKeys],
        ],
      );

      let stagedRecordCount = 0;
      const quarantined: QuarantinedProjection[] = [];
      const resolvedByIdentity = new Map<string,ResolvedQuarantineProjection>();
      const preparedRecords = records.map((record) => {
        const prepared = record.normalized
          ? prepareTypedStaging(job.connectorId, manifest.stream, record.normalized)
          : null;
        const issueList = [
          ...(record.validationIssues ?? []),
          ...(prepared?.issues ?? []),
          ...(!record.normalized
            ? [{
                code: "normalization_invalid" as const,
                path: "$",
                message: "No typed staging projection was produced.",
              }]
            : []),
        ];
        const issues = [...new Map(
          issueList.map((issue) => [`${issue.code}:${issue.path}`, issue]),
        ).values()];
        return {record,prepared,issues};
      });
      const invalidIdentities = new Set(preparedRecords
        .filter(({record,prepared,issues}) => !record.normalized || !prepared || issues.length > 0)
        .map(({record}) => `${record.sourceObjectType}\u001f${record.sourceRecordId}`));
      for (const {record,prepared,issues} of preparedRecords) {
        if (!record.normalized || !prepared || issues.length > 0) {
          for (const issue of issues) {
            const projection = {
              sourceObjectType: record.sourceObjectType,
              sourceRecordId: record.sourceRecordId || undefined,
              payloadHash: record.payloadHash,
              code: issue.code,
              path: issue.path,
              message: issue.message,
            } satisfies QuarantinedProjection;
            quarantined.push(projection);
            await client.query(
              `insert into ingestion.quarantine_records (
                 tenant_id, quarantine_id, connection_id, sync_run_id,
                 payload_batch_id, stream, source_object_type, source_record_id,
                 payload_hash, raw_object_key, error_code, error_path,
                 error_summary, mapping_version, status
               ) values (
                 $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'open'
               ) on conflict (
                 tenant_id, payload_batch_id, source_object_type, source_record_id,
                 error_code, error_path
               ) do nothing`,
              [
                job.tenantId,
                ulid(),
                job.connectionId,
                job.syncRunId,
                job.batchId,
                manifest.stream,
                record.sourceObjectType,
                record.sourceRecordId || null,
                record.payloadHash,
                manifest.objectKeys[0],
                issue.code,
                issue.path,
                issue.message.slice(0, 500),
                this.mappingVersion,
              ],
            );
          }
          continue;
        }

        const namespacedKey = makeNamespacedSourceKey(
          job.connectorId,
          job.externalAccountReference,
          record.sourceObjectType,
          record.sourceRecordId,
        );
        if (record.deletionSignal?.kind === "reconciliation_tombstone") {
          const signal = record.deletionSignal;
          if (
            !signal.expectedPayloadHash || !signal.expectedIngestedAt ||
            !/^[0-9a-f]{64}$/u.test(signal.expectedPayloadHash)
          ) {
            throw new Error("reconciliation_source_version_fence_missing");
          }
          const current = await client.query(
            `select 1 from ingestion.source_records source
              where source.tenant_id=$1 and source.namespaced_source_key=$2
                and source.payload_hash=$3
                and source.source_updated_at is not distinct from $4::timestamptz
                and source.ingested_at=$5::timestamptz
              for update`,
            [job.tenantId,namespacedKey,signal.expectedPayloadHash,
              signal.expectedSourceUpdatedAt ?? null,signal.expectedIngestedAt],
          );
          if (current.rows.length !== 1) {
            throw new Error("reconciliation_source_version_changed");
          }
        }
        await client.query(
          `insert into ingestion.source_records (
             tenant_id, namespaced_source_key, connection_id,
             external_account_reference, connector_key, stream,
             source_object_type, source_record_id, source_version,
             source_updated_at, payload_hash, normalized_schema_version,
             normalized_payload, tombstone, payload_batch_id, sync_run_id
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
             $14, $15, $16
           ) on conflict (tenant_id, namespaced_source_key) do update set
             source_version = excluded.source_version,
             source_updated_at = excluded.source_updated_at,
             payload_hash = excluded.payload_hash,
             normalized_schema_version = excluded.normalized_schema_version,
             normalized_payload = excluded.normalized_payload,
             tombstone = excluded.tombstone,
             payload_batch_id = excluded.payload_batch_id,
             sync_run_id = excluded.sync_run_id,
             ingested_at = now()
           where (
             (
               excluded.source_updated_at is not null
               and (
                 ingestion.source_records.source_updated_at is null
                 or excluded.source_updated_at >= ingestion.source_records.source_updated_at
               )
             )
             or (
               excluded.source_updated_at is null
               and ingestion.source_records.source_updated_at is null
               and (
                 select candidate.extracted_at
                 from ingestion.batch_manifests as candidate
                 where candidate.tenant_id = excluded.tenant_id
                   and candidate.batch_id = excluded.payload_batch_id
               ) >= (
                 select current_batch.extracted_at
                 from ingestion.batch_manifests as current_batch
                 where current_batch.tenant_id = ingestion.source_records.tenant_id
                   and current_batch.batch_id = ingestion.source_records.payload_batch_id
               )
             )
           )
           and (
             ingestion.source_records.payload_hash <> excluded.payload_hash
             or ingestion.source_records.source_version is distinct from excluded.source_version
           )`,
          [
            job.tenantId,
            namespacedKey,
            job.connectionId,
            job.externalAccountReference,
            job.connectorId,
            manifest.stream,
            record.sourceObjectType,
            record.sourceRecordId,
            record.sourceUpdatedAt ?? record.payloadHash,
            record.sourceUpdatedAt ?? null,
            record.payloadHash,
            record.normalized.schemaVersion,
            JSON.stringify(record.normalized),
            record.normalized.tombstone ?? false,
            job.batchId,
            job.syncRunId,
          ],
        );
        await upsertTypedStagingRecord(client, {
          contract: prepared.contract,
          tenantId: job.tenantId,
          namespacedSourceKey: namespacedKey,
          connectionId: job.connectionId,
          externalAccountReference: job.externalAccountReference,
          sourceRecordId: record.sourceRecordId,
          sourceVersion: record.sourceUpdatedAt ?? record.payloadHash,
          sourceUpdatedAt: record.sourceUpdatedAt ?? null,
          payloadHash: record.payloadHash,
          payloadBatchId: job.batchId,
          syncRunId: job.syncRunId,
          tombstone: record.normalized.tombstone ?? false,
          preserveExistingFields: record.deletionSignal?.kind === "verified_webhook_tombstone" ||
            record.deletionSignal?.kind === "reconciliation_tombstone",
          mappingVersion: this.mappingVersion,
          values: prepared.values,
        });
        const resolutionIdentity = `${record.sourceObjectType}\u001f${record.sourceRecordId}`;
        if (!invalidIdentities.has(resolutionIdentity)) {
          const resolution = await client.query<{source_object_type:string;source_record_id:string}>(
            `update ingestion.quarantine_records
                set status='resolved',replayed_in_sync_run_id=$5,
                    resolution_reason='validated_replay',resolved_at=now()
              where tenant_id=$1 and connection_id=$2 and stream=$3
                and source_object_type=$4 and source_record_id=$6 and status='open'
                and error_code not like 'canonical.%'
              returning source_object_type,source_record_id`,
            [job.tenantId,job.connectionId,manifest.stream,record.sourceObjectType,
              job.syncRunId,record.sourceRecordId],
          );
          if (resolution.rows.length > 0) {
            resolvedByIdentity.set(resolutionIdentity,{
              sourceObjectType:record.sourceObjectType,
              sourceRecordId:record.sourceRecordId,
            });
          }
        }
        stagedRecordCount += 1;
      }

      await client.query(
        `insert into ingestion.landing_commits (
           tenant_id, landing_commit_id, batch_id, sync_run_id, status,
           staged_record_count, quarantine_count, mapping_version
         ) values ($1, $2, $3, $4, 'committed', $5, $6, $7)`,
        [
          job.tenantId,
          ulid(),
          job.batchId,
          job.syncRunId,
          stagedRecordCount,
          quarantined.length,
          this.mappingVersion,
        ],
      );
      return { stagedRecordCount, quarantined, resolved:[...resolvedByIdentity.values()] };
    });
  }
}

async function establishIngestScope(
  client:PostgresQueryClient,
  tenantId:string,
  capability:string|undefined,
):Promise<void>{
  if(capability){
    if(capability.length<100||capability.length>4096)throw new Error("ingest_analytical_capability_invalid");
    await client.query("select set_config('albert.tenant_capability',$1,true)",[capability]);
  }else{
    // Admin fixture/migration sessions retain an explicit tenant context. The
    // exact production ingest login is token-only in analytical migration 0083.
    await client.query("select set_config('albert.tenant_id',$1,true)",[tenantId]);
  }
  // Capabilities are deliberately short lived, but a token issued immediately
  // before deletion must still be unable to commit afterwards. Analytical
  // deletion takes this tenant's matching exclusive transaction lock.
  await client.query(
    "select pg_advisory_xact_lock_shared(hashtextextended('deletion:'||$1,0))",
    [tenantId],
  );
}
