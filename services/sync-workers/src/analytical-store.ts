import { ulid } from "ulid";
import { makeNamespacedSourceKey, type RawSourceRecord } from "../../../packages/connector-sdk/src/index.js";
import type { RawBatchManifest } from "../../../packages/storage/src/index.js";
import type { SyncJob } from "../../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "./database.js";
import { prepareTypedStaging, upsertTypedStagingRecord } from "./typed-staging.js";

export type QuarantinedProjection = Readonly<{
  sourceObjectType: string;
  sourceRecordId?: string;
  payloadHash: string;
  code: string;
  path?: string;
  message: string;
}>;

export type LandingResult = Readonly<{
  stagedRecordCount: number;
  quarantined: readonly QuarantinedProjection[];
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

  async land(
    job: SyncJob,
    manifest: RawBatchManifest,
    records: readonly RawSourceRecord[],
  ): Promise<LandingResult> {
    return this.db.transaction(async (client) => {
      await client.query("select set_config('albert.tenant_id', $1, true)", [job.tenantId]);
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
      for (const record of records) {
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
          mappingVersion: this.mappingVersion,
          values: prepared.values,
        });
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
      return { stagedRecordCount, quarantined };
    });
  }
}
