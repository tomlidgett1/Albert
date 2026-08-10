import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  sourceObjectV2Schema,
  type FieldDispositionV2,
  type SemanticObjectStateV2,
  type SourceObjectV2,
} from "../packages/semantic-registry/src/v2.js";
import { lightspeedRManifest } from "../connectors/lightspeed-r/manifest.js";
import { xeroManifest } from "../connectors/xero/manifest.js";
import {
  parseStagingContractsFromMigrations,
  resolvePhysicalStagingColumn,
} from "./lib/staging-schema-contract.js";

type SourceColumn = Readonly<{
  name: string;
  type: string;
  api: string;
  description: string;
  key: boolean;
  pii: boolean;
  loadBearing: boolean;
  deprecated: boolean;
  enums: string | null;
}>;

type SourceTable = Readonly<{
  id: string;
  domain: string;
  grain: string;
  description: string;
  additivity: string;
  additivityAxis: string | null;
  primaryKey: readonly string[];
  columns: readonly SourceColumn[];
}>;

type SourceManifest = Readonly<{
  generatedFrom: string;
  tableCount: number;
  tables: readonly SourceTable[];
}>;

const projectRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(projectRoot, "packages/semantic-registry/registry/source-inventory.v2.json");
const stagingContracts = parseStagingContractsFromMigrations(
  resolve(projectRoot, "infra/migrations/analytical"),
);

function load(path: string): SourceManifest {
  return JSON.parse(readFileSync(resolve(projectRoot, path), "utf8")) as SourceManifest;
}

function disposition(column: SourceColumn): FieldDispositionV2 {
  const name = column.name.toLowerCase();
  if (column.deprecated) return "deprecated";
  if (column.key) return "key";
  if (column.pii) return "sensitive_metadata";
  if (/^(tenant_id|connection_id|sync_run_id|payload_|mapping_version|ingested_at)/u.test(name)) return "technical_lineage";
  if (column.type.includes("timestamp") || column.type === "date" || /(^|_)(date|time|timestamp|at)$/u.test(name)) return "time_role";
  if (column.enums || column.type === "boolean" || /(^|_)(status|state|type|archived|voided|completed|active)$/u.test(name)) return "status_filter";
  if (name.endsWith("_id")) return "dimension";
  if (column.loadBearing && /numeric|integer|bigint|decimal|double|real/u.test(column.type)) return "measure_input";
  if (/text|char|string|uuid/u.test(column.type)) return "dimension";
  return "descriptive_metadata";
}

function state(column: SourceColumn, fieldDisposition: FieldDispositionV2): SemanticObjectStateV2 {
  if (fieldDisposition === "deprecated") return "deprecated";
  if (fieldDisposition === "unsupported") return "unsupported";
  if (column.loadBearing) return "derived";
  return "exploratory";
}

function additivity(value: string): SourceObjectV2["additivity"] {
  if (value === "additive") return "additive";
  if (value === "last_value_over_time") return "semi_additive";
  if (value === "non_additive") return "non_additive";
  return "not_applicable";
}

function objects(
  connector: "lightspeed" | "xero",
  manifest: SourceManifest,
  mappingVersion: string,
): readonly SourceObjectV2[] {
  const schema = connector === "lightspeed" ? "source_lightspeed" : "source_xero";
  return manifest.tables.map((table) => {
    const physicalTable = `${schema}.${table.id}`;
    const staging = stagingContracts.get(physicalTable);
    const fields = table.columns.map((column) => {
      const declaredDisposition = disposition(column);
      const physical = staging
        ? resolvePhysicalStagingColumn({
            connector,
            table: table.id,
            semanticName: column.name,
            columns: staging.columns,
          })
        : null;
      const isAbsent = !physical && declaredDisposition !== "deprecated";
      const fieldDisposition: FieldDispositionV2 = isAbsent
        ? "unsupported"
        : declaredDisposition;
      const semanticState = isAbsent
        ? "unsupported"
        : state(column, fieldDisposition);
      return {
        id: `${connector}.${table.id}.${column.name}`,
        name: column.name,
        // Unsupported fields remain in the exhaustive semantic inventory, but
        // are excluded from queryable views. Keeping their semantic name here
        // makes the missing physical projection explicit and diffable.
        physicalName: physical?.name ?? column.name,
        dataType: physical?.dataType ?? column.type,
        description: column.description,
        disposition: fieldDisposition,
        semanticState,
        nullable: physical?.nullable ?? true,
        primaryKey: table.primaryKey.includes(column.name),
        pii: column.pii,
        evidence: [
          `${connector} source contract ${manifest.generatedFrom}`,
          `API field ${column.api}`,
          ...(physical
            ? [
                `Physical staging column ${physicalTable}.${physical.name} (${physical.dataType}) declared by ${physical.sourceMigration}.`,
              ]
            : []),
          ...(column.loadBearing
            ? ["Connector contract marks this field load-bearing."]
            : []),
        ],
        ...(isAbsent
          ? {
              unsupportedReason: staging
                ? `Documented source field is not materialized by the repository's typed staging migrations for ${physicalTable}.`
                : `Source table ${physicalTable} is not declared by the repository's analytical migrations.`,
            }
          : {}),
      };
    });
    return sourceObjectV2Schema.parse({
      id: `${connector}.${table.id}`,
      connector,
      domain: table.domain,
      physicalTable,
      mappingVersion,
      label: table.id.replace(/^(ls|xero)_/u, "").replaceAll("_", " "),
      description: table.description,
      grain: table.grain,
      primaryKey: table.primaryKey,
      additivity: additivity(table.additivity),
      additivityAxis: table.additivityAxis,
      semanticState: table.columns.some(
        (column) =>
          column.loadBearing &&
          fields.some(
            (field) =>
              field.name === column.name &&
              field.semanticState !== "unsupported",
          ),
      )
        ? "derived"
        : "exploratory",
      fields,
    });
  });
}

const lightspeed = load("connectors/lightspeed-r/tables.json");
const xero = load("connectors/xero/tables.json");
const sourceObjects = [
  ...objects("lightspeed", lightspeed, lightspeedRManifest.packVersion),
  ...objects("xero", xero, xeroManifest.packVersion),
];
const fieldCount = sourceObjects.reduce((total, source) => total + source.fields.length, 0);
const dispositionCounts = Object.fromEntries(
  [...new Set(sourceObjects.flatMap(({ fields }) => fields.map(({ disposition: value }) => value)))]
    .sort()
    .map((value) => [value, sourceObjects.flatMap(({ fields }) => fields).filter(({ disposition }) => disposition === value).length]),
);

const artifact = {
  schemaVersion: 2,
  generatedAt: new Date(0).toISOString(),
  generatedFrom: {
    lightspeed: lightspeed.generatedFrom,
    xero: xero.generatedFrom,
  },
  summary: {
    sourceObjectCount: sourceObjects.length,
    fieldCount,
    connectorCounts: {
      lightspeed: { sourceObjects: lightspeed.tables.length, fields: lightspeed.tables.reduce((total, table) => total + table.columns.length, 0) },
      xero: { sourceObjects: xero.tables.length, fields: xero.tables.reduce((total, table) => total + table.columns.length, 0) },
    },
    dispositionCounts,
  },
  sourceObjects,
};

const output = `${JSON.stringify(artifact, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(outputPath, "utf8") !== output)
    throw new Error(
      "Semantic V2 source inventory is stale. Run npm run registry:v2:generate.",
    );
  process.stdout.write(
    `Semantic V2 source inventory is fresh (${sourceObjects.length} objects, ${fieldCount} fields).\n`,
  );
} else {
  writeFileSync(outputPath, output);
  process.stdout.write(`Wrote ${sourceObjects.length} source objects and ${fieldCount} fields to ${outputPath}\n`);
}
