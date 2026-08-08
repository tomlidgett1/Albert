import { connectorManifests } from "../../../connectors/registry.js";
import {
  buildStagingContracts,
  projectStagingFields,
  type ConnectorId,
  type SourceRecordProjection,
  type StagingProjectionIssue,
  type StagingStreamContract,
} from "../../../packages/connector-sdk/src/index.js";
import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";

const contracts = buildStagingContracts(connectorManifests);

const contractsByStream = new Map(
  contracts.map((contract) => [contractKey(contract.connectorId, contract.stream), contract]),
);

export type PreparedTypedStaging = Readonly<{
  contract: StagingStreamContract;
  values: Readonly<Record<string, unknown>>;
  issues: readonly StagingProjectionIssue[];
}>;

export type TypedStagingRecord = Readonly<{
  contract: StagingStreamContract;
  tenantId: string;
  namespacedSourceKey: string;
  connectionId: string;
  externalAccountReference: string;
  sourceRecordId: string;
  sourceVersion: string;
  sourceUpdatedAt: string | null;
  payloadHash: string;
  payloadBatchId: string;
  syncRunId: string;
  tombstone: boolean;
  preserveExistingFields?: boolean;
  mappingVersion: string;
  values: Readonly<Record<string, unknown>>;
}>;

export function prepareTypedStaging(
  connectorId: ConnectorId,
  stream: string,
  projection: SourceRecordProjection,
): PreparedTypedStaging {
  const contract = contractsByStream.get(contractKey(connectorId, stream));
  if (!contract) {
    throw new Error(`No typed staging contract exists for ${connectorId}.${stream}.`);
  }
  const result = projectStagingFields(contract, projection);
  return { contract, ...result };
}

const COMMON_STAGING_COLUMNS = [
  "tenant_id",
  "namespaced_source_key",
  "connection_id",
  "external_account_reference",
  "source_record_id",
  "source_version",
  "source_updated_at",
  "payload_hash",
  "payload_batch_id",
  "sync_run_id",
  "tombstone",
  "mapping_version",
] as const;

/** Postgres practical bind limit; keep well under 65535. */
const MAX_BATCH_PARAMETERS = 32_000;

export async function upsertTypedStagingRecord(
  client: PostgresQueryClient,
  record: TypedStagingRecord,
): Promise<void> {
  await upsertTypedStagingRecords(client, [record]);
}

export type UpsertTypedStagingOptions = Readonly<{
  /**
   * Conflict predicate for bulk backfills:
   * - true / "fresh": skip batch_manifests subqueries; still require newer/equal
   *   source_updated_at (or both null) plus a changed hash/version
   * - "overwrite": always replace on conflict (fastest dedicated re-ingest path)
   */
  fastConflict?: boolean | "fresh" | "overwrite";
}>;

/**
 * Multi-row upsert for bulk ingest. Same conflict semantics as the single-row
 * path (unless `fastConflict`), but one round trip per chunk instead of one
 * per record.
 */
export async function upsertTypedStagingRecords(
  client: PostgresQueryClient,
  records: readonly TypedStagingRecord[],
  options: UpsertTypedStagingOptions = {},
): Promise<void> {
  if (records.length === 0) return;
  const contract = records[0]!.contract;
  for (const record of records) {
    if (
      record.contract.connectorId !== contract.connectorId ||
      record.contract.stream !== contract.stream
    ) {
      throw new Error("upsertTypedStagingRecords requires a homogeneous stream batch.");
    }
    assertProjectionColumns(record.contract, record.values);
  }

  const columns = [
    ...COMMON_STAGING_COLUMNS,
    ...contract.fields.map((field) => field.column),
  ];
  const casts = [
    ...COMMON_STAGING_COLUMNS.map((column) => commonColumnCast(column)),
    ...contract.fields.map((field) => field.type),
  ];
  const width = columns.length;
  const rowsPerChunk = Math.max(1, Math.floor(MAX_BATCH_PARAMETERS / width));
  const table = `${quoteIdentifier(contract.schema)}.${quoteIdentifier(contract.table)}`;
  const sourceFieldColumns = new Set(contract.fields.map((field) => field.column));
  const preserveExisting = records.some((record) => record.preserveExistingFields);
  const assignments = columns
    .filter((column) => column !== "tenant_id" && column !== "namespaced_source_key")
    .map((column) => {
      const quoted = quoteIdentifier(column);
      return preserveExisting && sourceFieldColumns.has(column)
        ? `${quoted} = coalesce(${table}.${quoted}, excluded.${quoted})`
        : `${quoted} = excluded.${quoted}`;
    });
  assignments.push("ingested_at = now()");
  const reprocessClause = contract.reprocessIdenticalPayloadOnNewBatch
    ? `or ${table}.payload_batch_id <> excluded.payload_batch_id`
    : "";

  const conflictMode =
    options.fastConflict === true || options.fastConflict === "fresh"
      ? "fresh"
      : options.fastConflict === "overwrite"
        ? "overwrite"
        : "full";

  const freshnessPredicate =
    conflictMode === "fresh"
      ? `(
         excluded.source_updated_at is not null
         and (
           ${table}.source_updated_at is null
           or excluded.source_updated_at >= ${table}.source_updated_at
         )
       )
       or (
         excluded.source_updated_at is null
         and ${table}.source_updated_at is null
       )`
      : `(
         excluded.source_updated_at is not null
         and (
           ${table}.source_updated_at is null
           or excluded.source_updated_at >= ${table}.source_updated_at
         )
       )
       or (
         excluded.source_updated_at is null
         and ${table}.source_updated_at is null
         and (
           select candidate.extracted_at
           from ingestion.batch_manifests as candidate
           where candidate.tenant_id = excluded.tenant_id
             and candidate.batch_id = excluded.payload_batch_id
         ) >= (
           select current_batch.extracted_at
           from ingestion.batch_manifests as current_batch
           where current_batch.tenant_id = ${table}.tenant_id
             and current_batch.batch_id = ${table}.payload_batch_id
         )
       )`;

  const conflictSql =
    conflictMode === "overwrite"
      ? `on conflict (tenant_id, namespaced_source_key) do update set
         ${assignments.join(",\n         ")}`
      : `on conflict (tenant_id, namespaced_source_key) do update set
         ${assignments.join(",\n         ")}
       where (
         ${freshnessPredicate}
       )
       and (
         ${table}.payload_hash <> excluded.payload_hash
         or ${table}.source_version is distinct from excluded.source_version
         or ${table}.mapping_version <> excluded.mapping_version
         ${reprocessClause}
       )`;

  for (let offset = 0; offset < records.length; offset += rowsPerChunk) {
    const chunk = records.slice(offset, offset + rowsPerChunk);
    const values: unknown[] = [];
    const rowPlaceholders: string[] = [];
    for (const [rowIndex, record] of chunk.entries()) {
      const base = rowIndex * width;
      rowPlaceholders.push(
        `(${casts.map((cast, colIndex) => `$${base + colIndex + 1}${sqlCast(cast)}`).join(", ")})`,
      );
      values.push(
        record.tenantId,
        record.namespacedSourceKey,
        record.connectionId,
        record.externalAccountReference,
        record.sourceRecordId,
        record.sourceVersion,
        record.sourceUpdatedAt,
        record.payloadHash,
        record.payloadBatchId,
        record.syncRunId,
        record.tombstone,
        record.mappingVersion,
        ...record.contract.fields.map((field) => {
          const value = record.values[field.column];
          return field.type === "jsonb" && value !== null ? JSON.stringify(value) : value;
        }),
      );
    }

    await client.query(
      `insert into ${table} (${columns.map(quoteIdentifier).join(", ")})
       values ${rowPlaceholders.join(",\n       ")}
       ${conflictSql}`,
      values,
    );
  }
}

function contractKey(connectorId: ConnectorId, stream: string): string {
  return `${connectorId}:${stream}`;
}

function assertProjectionColumns(
  contract: StagingStreamContract,
  values: Readonly<Record<string, unknown>>,
): void {
  const expected = new Set(contract.fields.map((field) => field.column));
  const received = Object.keys(values);
  if (received.length !== expected.size || received.some((column) => !expected.has(column))) {
    throw new Error(`Typed staging values do not match ${contract.connectorId}.${contract.stream}.`);
  }
}

function commonColumnCast(column: string): string {
  if (column === "source_updated_at") return "timestamptz";
  if (column === "tombstone") return "boolean";
  return "text";
}

function sqlCast(type: string): string {
  if (type === "numeric") return "::numeric(19,4)";
  if (type === "timestamptz") return "::timestamptz";
  if (type === "boolean") return "::boolean";
  if (type === "date") return "::date";
  if (type === "jsonb") return "::jsonb";
  return "::text";
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error(`Unsafe SQL identifier ${value}.`);
  return `"${value}"`;
}
