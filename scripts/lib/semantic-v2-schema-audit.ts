import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { SemanticRegistryDocumentV2 } from "../../packages/semantic-registry/src/v2.js";
import {
  parseStagingContractsFromMigrations,
  resolvePhysicalStagingColumn,
  STAGING_PLATFORM_COLUMNS,
  type StagingColumnContract,
} from "./staging-schema-contract.js";

export type LiveStagingColumn = Readonly<{
  schema: string;
  table: string;
  name: string;
  dataType: string;
  nullable: boolean;
}>;

export type SemanticV2SchemaAuditIssue = Readonly<{
  code: string;
  objectId: string;
  message: string;
}>;

export type SemanticV2SchemaAudit = Readonly<{
  status: "passed" | "failed";
  sourceObjectCount: number;
  fieldCount: number;
  semanticViewCount: number;
  semanticViewFieldCount: number;
  materializedFieldCount: number;
  unsupportedFieldCount: number;
  aliasedFieldCount: number;
  liveVerified: boolean;
  issues: readonly SemanticV2SchemaAuditIssue[];
}>;

const REQUIRED_ENVELOPE_COLUMNS = [
  "tenant_id",
  "connection_id",
  "tombstone",
  "source_updated_at",
] as const;

function declaredPhysicalRelations(migrationsDirectory: string): Set<string> {
  const relations = new Set<string>();
  const declaration =
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\."?([a-z_][a-z0-9_]*)"?/giu;
  for (const file of readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort()) {
    const sql = readFileSync(resolve(migrationsDirectory, file), "utf8");
    for (const match of sql.matchAll(declaration))
      relations.add(`${match[1]}.${match[2]}`);
  }
  return relations;
}

function issue(
  issues: SemanticV2SchemaAuditIssue[],
  code: string,
  objectId: string,
  message: string,
): void {
  issues.push({ code, objectId, message });
}

function auditColumns(
  registry: SemanticRegistryDocumentV2,
  migrationsDirectory: string,
  liveColumns?: readonly LiveStagingColumn[],
): SemanticV2SchemaAudit {
  const issues: SemanticV2SchemaAuditIssue[] = [];
  const contracts = parseStagingContractsFromMigrations(migrationsDirectory);
  const declaredRelations = declaredPhysicalRelations(migrationsDirectory);
  const liveByTable = new Map<string, Map<string, LiveStagingColumn>>();
  for (const column of liveColumns ?? []) {
    const key = `${column.schema}.${column.table}`;
    const table = liveByTable.get(key) ?? new Map<string, LiveStagingColumn>();
    table.set(column.name, column);
    liveByTable.set(key, table);
  }
  let materializedFieldCount = 0;
  let unsupportedFieldCount = 0;
  let aliasedFieldCount = 0;

  for (const source of registry.sourceObjects) {
    const expected = contracts.get(source.physicalTable);
    const live = liveColumns ? liveByTable.get(source.physicalTable) : undefined;
    if (!expected) {
      issue(
        issues,
        "MISSING_MIGRATION_TABLE",
        source.id,
        `${source.physicalTable} is not declared in analytical migrations.`,
      );
      continue;
    }
    if (liveColumns && !live) {
      issue(
        issues,
        "MISSING_LIVE_TABLE",
        source.id,
        `${source.physicalTable} is absent from the configured analytical database.`,
      );
    }
    for (const envelope of REQUIRED_ENVELOPE_COLUMNS) {
      if (!expected.columns.has(envelope))
        issue(
          issues,
          "MISSING_ENVELOPE_COLUMN",
          source.id,
          `${source.physicalTable}.${envelope} is absent from migrations.`,
        );
      if (liveColumns && !live?.has(envelope))
        issue(
          issues,
          "MISSING_LIVE_ENVELOPE_COLUMN",
          source.id,
          `${source.physicalTable}.${envelope} is absent from the analytical database.`,
        );
    }

    const physicalOwners = new Map<string, string>();
    for (const field of source.fields) {
      if (field.disposition === "unsupported") {
        unsupportedFieldCount += 1;
        const newlyMaterialized = resolvePhysicalStagingColumn({
          connector: source.connector,
          table: expected.table,
          semanticName: field.name,
          columns: expected.columns,
        });
        if (newlyMaterialized)
          issue(
            issues,
            "STALE_UNSUPPORTED_FIELD",
            field.id,
            `${field.id} is Unsupported but resolves to ${source.physicalTable}.${newlyMaterialized.name}. Regenerate the inventory.`,
          );
        continue;
      }
      if (field.disposition === "deprecated") continue;
      materializedFieldCount += 1;
      if (field.name !== field.physicalName) aliasedFieldCount += 1;
      const owner = physicalOwners.get(field.physicalName);
      if (owner)
        issue(
          issues,
          "DUPLICATE_PHYSICAL_FIELD",
          field.id,
          `${field.id} and ${owner} both expose ${source.physicalTable}.${field.physicalName}.`,
        );
      else physicalOwners.set(field.physicalName, field.id);

      const migrationColumn = expected.columns.get(field.physicalName);
      if (!migrationColumn) {
        issue(
          issues,
          "MISSING_MIGRATION_COLUMN",
          field.id,
          `${source.physicalTable}.${field.physicalName} is absent from analytical migrations.`,
        );
      } else {
        compareField(field, migrationColumn, "MIGRATION", issues);
      }
      if (liveColumns) {
        const liveColumn = live?.get(field.physicalName);
        if (!liveColumn)
          issue(
            issues,
            "MISSING_LIVE_COLUMN",
            field.id,
            `${source.physicalTable}.${field.physicalName} is absent from the analytical database.`,
          );
        else compareField(field, liveColumn, "LIVE", issues);
      }
    }

    for (const keyName of source.primaryKey) {
      const keyField = source.fields.find(({ name }) => name === keyName);
      if (
        !keyField ||
        keyField.disposition === "unsupported" ||
        !expected.columns.has(keyField.physicalName)
      )
        issue(
          issues,
          "UNMATERIALIZED_PRIMARY_KEY",
          source.id,
          `Primary key ${keyName} is not a materialized source field.`,
        );
    }
  }

  for (const view of registry.views) {
    if (!declaredRelations.has(view.physicalTable))
      issue(
        issues,
        "MISSING_MIGRATION_VIEW",
        view.id,
        `${view.physicalTable} is not declared as a table or view in analytical migrations.`,
      );
    const live = liveColumns ? liveByTable.get(view.physicalTable) : undefined;
    if (liveColumns && !live)
      issue(
        issues,
        "MISSING_LIVE_VIEW",
        view.id,
        `${view.physicalTable} is absent from the configured analytical database.`,
      );
    if (!liveColumns) continue;
    for (const field of view.physicalFields) {
      const liveField = live?.get(field.physicalName);
      if (!liveField) {
        issue(
          issues,
          "MISSING_LIVE_VIEW_FIELD",
          `${view.id}.${field.id}`,
          `${view.physicalTable}.${field.physicalName} is absent from the analytical database.`,
        );
        continue;
      }
      if (
        field.dataType !== "unknown" &&
        field.dataType !== liveField.dataType
      )
        issue(
          issues,
          "LIVE_VIEW_TYPE_MISMATCH",
          `${view.id}.${field.id}`,
          `Expected ${field.dataType}, found ${liveField.dataType}.`,
        );
    }
  }

  return {
    status: issues.length === 0 ? "passed" : "failed",
    sourceObjectCount: registry.sourceObjects.length,
    fieldCount: registry.sourceObjects.reduce(
      (total, source) => total + source.fields.length,
      0,
    ),
    semanticViewCount: registry.views.length,
    semanticViewFieldCount: registry.views.reduce(
      (total, view) => total + view.physicalFields.length,
      0,
    ),
    materializedFieldCount,
    unsupportedFieldCount,
    aliasedFieldCount,
    liveVerified: Boolean(liveColumns),
    issues,
  };
}

function compareField(
  field: SemanticRegistryDocumentV2["sourceObjects"][number]["fields"][number],
  physical: Pick<StagingColumnContract, "dataType" | "nullable">,
  source: "MIGRATION" | "LIVE",
  issues: SemanticV2SchemaAuditIssue[],
): void {
  if (field.dataType !== physical.dataType)
    issue(
      issues,
      `${source}_TYPE_MISMATCH`,
      field.id,
      `Expected ${field.dataType}, found ${physical.dataType}.`,
    );
  if (field.nullable !== physical.nullable)
    issue(
      issues,
      `${source}_NULLABILITY_MISMATCH`,
      field.id,
      `Expected nullable=${field.nullable}, found nullable=${physical.nullable}.`,
    );
}

export function auditSemanticV2Schema(args: Readonly<{
  registry: SemanticRegistryDocumentV2;
  migrationsDirectory: string;
  liveColumns?: readonly LiveStagingColumn[];
}>): SemanticV2SchemaAudit {
  return auditColumns(args.registry, args.migrationsDirectory, args.liveColumns);
}

export function isPlatformStagingColumn(name: string): boolean {
  return STAGING_PLATFORM_COLUMNS.has(name);
}
