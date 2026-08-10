import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import pg from "pg";

import {
  attestSemanticProfileReceiptV2,
  semanticProfileReceiptDigestV2,
} from "../packages/semantic-registry/src/profile-receipt-attestation.js";
import { semanticRegistryDocumentV2Schema } from "../packages/semantic-registry/src/v2.js";

if (!process.argv.includes("--execute"))
  throw new Error("Refusing to profile analytical data without --execute.");

function argument(name: string): string | undefined {
  return process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .trim();
}

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    throw new Error(`Unsafe database identifier ${value}.`);
  return `"${value}"`;
}

function qualifiedTable(value: string): string {
  const [schema, table, ...rest] = value.split(".");
  if (!schema || !table || rest.length)
    throw new Error(`Invalid qualified table ${value}.`);
  return `${identifier(schema)}.${identifier(table)}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const tenantId = argument("tenant");
if (!tenantId) throw new Error("--tenant=<tenant id> is required.");
const sampleSize = Number(argument("sample-size") ?? 10_000);
if (!Number.isInteger(sampleSize) || sampleSize < 100 || sampleSize > 100_000)
  throw new Error("--sample-size must be an integer from 100 through 100000.");

try {
  process.loadEnvFile?.(".env.local");
} catch {
  /* Explicit process environment remains authoritative. */
}
const connectionString =
  process.env.OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL?.trim() ||
  process.env.ANALYTICAL_ADMIN_DATABASE_URL?.trim();
if (!connectionString)
  throw new Error(
    "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL or ANALYTICAL_ADMIN_DATABASE_URL is required.",
  );
const profileSigningSecret =
  process.env.ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET?.trim();
if (!profileSigningSecret || profileSigningSecret.length < 32)
  throw new Error(
    "ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET must contain at least 32 characters.",
  );

const registry = semanticRegistryDocumentV2Schema.parse(
  JSON.parse(
    readFileSync(
      "packages/semantic-registry/registry/registry.v2.json",
      "utf8",
    ),
  ),
);
const publication = JSON.parse(
  readFileSync(
    "packages/semantic-registry/registry/publication.v2.json",
    "utf8",
  ),
) as { publicationHash: string };
const viewById = new Map(registry.views.map((view) => [view.id, view]));
const sourceById = new Map(
  registry.sourceObjects.map((source) => [source.id, source]),
);
const sourceByViewId = new Map(
  registry.views.flatMap((view) =>
    view.sourceObjectId
      ? [[view.id, sourceById.get(view.sourceObjectId)!] as const]
      : [],
  ),
);
const client = new pg.Client({
  connectionString,
  application_name: "albert-semantic-v2-profiler",
});

const sourceProfiles: Record<string, unknown>[] = [];
const relationshipProfiles: Record<string, unknown>[] = [];
const errors: Record<string, string>[] = [];
const profileStartedAt = Date.now();
let savepointSequence = 0;

async function withProfileSavepoint<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const savepoint = identifier(`semantic_profile_${++savepointSequence}`);
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await operation();
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

await client.connect();
try {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  await client.query("SELECT set_config('albert.tenant_id',$1,true)", [
    tenantId,
  ]);
  await client.query("SELECT set_config('statement_timeout','15000ms',true)");
  await client.query("SELECT set_config('lock_timeout','1000ms',true)");

  let completedSources = 0;
  for (const source of registry.sourceObjects) {
    const view = registry.views.find(
      ({ sourceObjectId }) => sourceObjectId === source.id,
    )!;
    const table = qualifiedTable(source.physicalTable);
    const active = view.activeRecordFilter
      ? ` AND ${identifier(view.activeRecordFilter.field)} = ${view.activeRecordFilter.value ? "true" : "false"}`
      : "";
    const mapping = ` AND ${identifier("mapping_version")} = $2`;
    try {
      const sourceProfile = await withProfileSavepoint(async () => {
        const [schemaName, tableName] = source.physicalTable.split(".") as [
          string,
          string,
        ];
        const metadata = await client.query(
          `SELECT column_name,data_type,is_nullable
           FROM information_schema.columns
          WHERE table_schema=$1 AND table_name=$2
          ORDER BY ordinal_position`,
          [schemaName, tableName],
        );
        const databaseColumns = new Map(
          metadata.rows.map((row) => [String(row.column_name), row]),
        );
        const profileFields = source.fields.filter(
          ({ disposition }) =>
            disposition !== "unsupported" && disposition !== "deprecated",
        );
        const missingColumns = profileFields
          .filter(({ physicalName }) => !databaseColumns.has(physicalName))
          .map(({ id }) => id);
        const typeMismatches = profileFields.flatMap((field) => {
          const actual = databaseColumns.get(field.physicalName);
          return actual && String(actual.data_type) !== field.dataType
            ? [
                {
                  fieldId: field.id,
                  expected: field.dataType,
                  actual: String(actual.data_type),
                },
              ]
            : [];
        });
        const fieldExpressions = profileFields.flatMap((field, index) => [
          `count(${identifier(field.physicalName)})::bigint AS ${identifier(`f${index}_nonnull`)}`,
          `count(DISTINCT ${identifier(field.physicalName)})::bigint AS ${identifier(`f${index}_distinct`)}`,
        ]);
        const stats = await client.query(
          `SELECT count(*)::bigint AS sampled_rows${fieldExpressions.length ? `,${fieldExpressions.join(",")}` : ""}
           FROM (SELECT ${profileFields.length ? profileFields.map(({ physicalName }) => identifier(physicalName)).join(",") : "1 AS profile_sentinel"}
                   FROM ${table}
                  WHERE tenant_id=$1${active}
                    ${mapping}
                  LIMIT ${sampleSize}) AS sampled`,
          [tenantId, source.mappingVersion],
        );
        const totals = await client.query(
          `SELECT count(*)::bigint AS row_count,
                count(DISTINCT connection_id)::bigint AS connection_count,
                max(source_updated_at) AS latest_source_updated_at
           FROM ${table}
          WHERE tenant_id=$1${active}
            ${mapping}`,
          [tenantId, source.mappingVersion],
        );
        const primaryKeyFields = source.primaryKey.map((name) => {
          const field = source.fields.find(
            (candidate) =>
              candidate.name === name &&
              candidate.disposition !== "unsupported",
          );
          if (!field)
            throw new Error(
              `Primary key ${source.id}.${name} is not physically materialized.`,
            );
          return field.physicalName;
        });
        const keyColumns = ["connection_id", ...primaryKeyFields].map(
          identifier,
        );
        const duplicates = await client.query(
          `SELECT count(*)::bigint AS duplicate_key_groups
           FROM (SELECT ${keyColumns.join(",")}
                   FROM ${table}
                  WHERE tenant_id=$1${active}
                    ${mapping}
                  GROUP BY ${keyColumns.join(",")}
                 HAVING count(*)>1) AS duplicate_groups`,
          [tenantId, source.mappingVersion],
        );
        const row = stats.rows[0] ?? {};
        const latestSourceUpdatedAt =
          totals.rows[0]?.latest_source_updated_at === null ||
          totals.rows[0]?.latest_source_updated_at === undefined
            ? null
            : new Date(totals.rows[0].latest_source_updated_at).toISOString();
        return {
          sourceObjectId: source.id,
          physicalTable: source.physicalTable,
          rowCount: Number(totals.rows[0]?.row_count ?? 0),
          sampledRows: Number(row.sampled_rows ?? 0),
          connectionCount: Number(totals.rows[0]?.connection_count ?? 0),
          latestSourceUpdatedAt,
          duplicateKeyGroups: Number(
            duplicates.rows[0]?.duplicate_key_groups ?? 0,
          ),
          missingColumns,
          typeMismatches,
          fields: profileFields.map((field, index) => ({
            fieldId: field.id,
            nonNullInSample: Number(row[`f${index}_nonnull`] ?? 0),
            distinctInSample: Number(row[`f${index}_distinct`] ?? 0),
            sampleValues:
              field.pii || field.disposition === "sensitive_metadata"
                ? "redacted"
                : "not_exported",
          })),
        };
      });
      sourceProfiles.push(sourceProfile);
    } catch (error) {
      errors.push({
        objectId: source.id,
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Unknown profiling failure",
      });
    }
    completedSources += 1;
    if (
      completedSources % 25 === 0 ||
      completedSources === registry.sourceObjects.length
    )
      process.stderr.write(
        `${JSON.stringify({ event: "semantic_profile_progress", stage: "sources", completed: completedSources, total: registry.sourceObjects.length, succeeded: sourceProfiles.length, errors: errors.length, elapsedMs: Date.now() - profileStartedAt })}\n`,
      );
  }

  let completedRelationships = 0;
  const reportRelationshipProgress = () => {
    if (
      completedRelationships % 25 === 0 ||
      completedRelationships === registry.relationshipCandidates.length
    )
      process.stderr.write(
        `${JSON.stringify({ event: "semantic_profile_progress", stage: "relationships", completed: completedRelationships, total: registry.relationshipCandidates.length, profiled: relationshipProfiles.length, errors: errors.length, elapsedMs: Date.now() - profileStartedAt })}\n`,
      );
  };
  for (const candidate of registry.relationshipCandidates) {
    const fromView = viewById.get(candidate.fromViewId);
    const fromSource = sourceByViewId.get(candidate.fromViewId);
    const fromField = fromSource?.fields.find(
      ({ id }) => id === candidate.fromFieldId,
    );
    if (
      !fromView ||
      !fromSource ||
      !fromField ||
      candidate.candidateViewIds.length === 0
    ) {
      relationshipProfiles.push({
        candidateId: candidate.id,
        disposition: "unresolved",
        reason: candidate.reason,
        targets: [],
      });
      completedRelationships += 1;
      reportRelationshipProgress();
      continue;
    }
    const targets: Record<string, unknown>[] = [];
    for (const candidateTarget of candidate.targets) {
      const targetViewId = candidateTarget.viewId;
      const targetView = viewById.get(targetViewId);
      const targetSource = sourceByViewId.get(targetViewId);
      const targetField = targetSource?.fields.find(
        ({ id }) => id === candidateTarget.fieldId,
      );
      if (!targetView || !targetSource || !targetField) continue;
      try {
        const targetProfile = await withProfileSavepoint(async () => {
          const fromTable = qualifiedTable(fromSource.physicalTable);
          const targetTable = qualifiedTable(targetSource.physicalTable);
          const fromActive = fromView.activeRecordFilter
            ? ` AND f.${identifier(fromView.activeRecordFilter.field)} = ${fromView.activeRecordFilter.value ? "true" : "false"}`
            : "";
          const targetActive = targetView.activeRecordFilter
            ? ` AND t.${identifier(targetView.activeRecordFilter.field)} = ${targetView.activeRecordFilter.value ? "true" : "false"}`
            : "";
          const fromMapping = ` AND f.${identifier("mapping_version")}=$2`;
          const targetMapping = ` AND t.${identifier("mapping_version")}=$3`;
          const profile = await client.query(
            `WITH source_population AS MATERIALIZED (
             SELECT count(*)::bigint AS source_rows,
                    count(${identifier(fromField.physicalName)})::bigint AS source_foreign_keys,
                    count(*) FILTER (WHERE ${identifier(fromField.physicalName)} IS NULL)::bigint AS null_foreign_keys
               FROM ${fromTable} f
              WHERE f.tenant_id=$1${fromActive}${fromMapping}
           ), sampled_from AS MATERIALIZED (
             SELECT connection_id,${identifier(fromField.physicalName)} AS source_key
               FROM ${fromTable} f
              WHERE f.tenant_id=$1${fromActive}${fromMapping} AND ${identifier(fromField.physicalName)} IS NOT NULL
              LIMIT ${sampleSize}
           ), target_multiplicity AS MATERIALIZED (
             SELECT connection_id,${identifier(targetField.physicalName)} AS target_key,count(*)::bigint AS matches
               FROM ${targetTable} t
              WHERE t.tenant_id=$1${targetActive}${targetMapping} AND ${identifier(targetField.physicalName)} IS NOT NULL
              GROUP BY connection_id,${identifier(targetField.physicalName)}
           )
           SELECT (SELECT source_rows FROM source_population) AS source_rows,
                  (SELECT source_foreign_keys FROM source_population) AS source_foreign_keys,
                  (SELECT null_foreign_keys FROM source_population) AS null_foreign_keys,
                  count(*)::bigint AS sampled_foreign_keys,
                  count(*) FILTER (WHERE target_key IS NULL)::bigint AS orphan_rows,
                  coalesce(max(matches),0)::bigint AS maximum_target_matches,
                  count(*) FILTER (WHERE matches>1)::bigint AS rows_with_ambiguous_target,
                  (SELECT count(*)::bigint FROM target_multiplicity WHERE matches>1) AS duplicate_target_key_groups
             FROM sampled_from f
             LEFT JOIN target_multiplicity t
               ON t.connection_id=f.connection_id AND t.target_key=f.source_key`,
            [tenantId, fromSource.mappingVersion, targetSource.mappingVersion],
          );
          const row = profile.rows[0] ?? {};
          const sampledForeignKeys = Number(row.sampled_foreign_keys ?? 0);
          const sourceRows = Number(row.source_rows ?? 0);
          const sourceForeignKeys = Number(row.source_foreign_keys ?? 0);
          const nullForeignKeys = Number(row.null_foreign_keys ?? 0);
          const orphanRows = Number(row.orphan_rows ?? 0);
          const ambiguousRows = Number(row.rows_with_ambiguous_target ?? 0);
          const duplicateTargetKeyGroups = Number(
            row.duplicate_target_key_groups ?? 0,
          );
          return {
            targetViewId,
            targetFieldId: targetField.id,
            matchKind: candidateTarget.matchKind,
            sourceRows,
            sourceForeignKeys,
            nullForeignKeys,
            sampledForeignKeys,
            profileCoverageComplete: sampledForeignKeys === sourceForeignKeys,
            orphanRows,
            orphanRate: sampledForeignKeys
              ? orphanRows / sampledForeignKeys
              : 0,
            maximumTargetMatches: Number(row.maximum_target_matches ?? 0),
            ambiguousRows,
            duplicateTargetKeyGroups,
            recommendedCardinality:
              sampledForeignKeys > orphanRows &&
              ambiguousRows === 0 &&
              duplicateTargetKeyGroups === 0
                ? "many_to_one"
                : "unsupported",
            recommendedDisposition:
              sampledForeignKeys > 0 &&
              sampledForeignKeys > orphanRows &&
              ambiguousRows === 0 &&
              duplicateTargetKeyGroups === 0
                ? "review_candidate"
                : "unresolved",
          };
        });
        targets.push(targetProfile);
      } catch (error) {
        errors.push({
          objectId: `${candidate.id}:${targetViewId}`,
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Unknown relationship profiling failure",
        });
      }
    }
    relationshipProfiles.push({
      candidateId: candidate.id,
      fromViewId: candidate.fromViewId,
      fromFieldId: candidate.fromFieldId,
      targets,
    });
    completedRelationships += 1;
    reportRelationshipProgress();
  }

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

const unsignedReceipt = {
  schemaVersion: 2,
  status: errors.length ? "incomplete" : "complete",
  publicationHash: publication.publicationHash,
  tenantDigest: digest(tenantId),
  sampleSize,
  createdAt: new Date().toISOString(),
  durationMs: Date.now() - profileStartedAt,
  privacy:
    "No raw sample values are exported. Sensitive and PII fields are explicitly redacted.",
  sourceProfiles,
  relationshipProfiles,
  errors,
};
const receipt = {
  ...unsignedReceipt,
  attestation: attestSemanticProfileReceiptV2(
    unsignedReceipt,
    profileSigningSecret,
  ),
};
const outputPath = resolve(
  argument("output") ??
    `.albert-agent-qa-out/semantic-profiling/${receipt.tenantDigest.slice(0, 16)}-${publication.publicationHash}.json`,
);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
  flag: "wx",
});
process.stdout.write(
  `${JSON.stringify({ outputPath, receiptHash: semanticProfileReceiptDigestV2(receipt), status: receipt.status, sourceProfiles: sourceProfiles.length, relationshipProfiles: relationshipProfiles.length, errors: errors.length }, null, 2)}\n`,
);
if (errors.length) process.exitCode = 1;
