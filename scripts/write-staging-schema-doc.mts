/**
 * Build the staging schema knowledge injected into the Albert agent prompt.
 *
 * The connector catalogue generator emits five artifacts from the reviewed
 * connector contracts and the Lightspeed DDL reconciliation:
 * `connectors/lightspeed-r/tables.json` (semantic dictionary: meanings, grains,
 * primary keys) against the live typed-staging DDL (column truth):
 *
 *   1. LIGHTSPEED_TABLE_INDEX — every ls_* table on one line: dimension, grain,
 *      primary key, and join edges. Injected into every SQL turn so the agent
 *      always knows the full queryable surface.
 *   2. LIGHTSPEED_DIMENSION_DICTIONARIES — per-dimension full column
 *      dictionaries (every live column with its meaning). Retained for deep
 *      dimension guides and compatibility; the whole thing never rides in one
 *      prompt.
 *   3. LIGHTSPEED_TABLE_DICTIONARIES — the same grounded documentation split
 *      by table for on-demand describe_tables calls.
 *   4. XERO_SCHEMA_DOC — the Xero catalogue, injected only for finance.
 *   5. DEPUTY_SCHEMA_DOC — Deputy's reviewed workforce projection, injected
 *      only for workforce questions.
 *
 * Column truth comes from EVERY analytical migration that shapes
 * `source_lightspeed.ls_*` (CREATE TABLE and ALTER TABLE ADD COLUMN), not one
 * pinned file — missing an ALTER is how the agent ends up told that
 * `ls_sale_lines.sale_id` does not exist.
 *
 * Run: npm run generate:staging-schema      (writes the file)
 *      npm run generate:staging-schema -- --check   (CI freshness gate)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { deputyManifest } from "../connectors/deputy/manifest.js";
import { stagingColumnName } from "../packages/connector-sdk/src/index.js";
import {
  lightspeedPhysicalCandidates,
  parseStagingContractsFromMigrations,
  STAGING_PLATFORM_COLUMNS,
} from "./lib/staging-schema-contract.js";

type SpecColumn = Readonly<{
  name: string;
  type?: string;
  description?: string;
  key?: boolean;
  loadBearing?: boolean;
  deprecated?: boolean;
  enums?: readonly string[] | null;
}>;

type PackTable = Readonly<{
  id: string;
  domain?: string;
  grain?: string;
  description?: string;
  primaryKey?: readonly string[];
  columns?: readonly SpecColumn[];
}>;

/**
 * Meaning overrides for live columns whose spec description is missing or
 * stale. Keyed `table.column`. These win over tables.json.
 */
const DESCRIPTION_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  "ls_sale_lines.sale_id": "The sale this line sits on. Join ls_sales through this key for completed/voided state and complete_time.",
  "ls_sale_lines.completed": "Parent-projected and not authoritative. Filter state via join to ls_sales instead.",
  "ls_sale_lines.voided": "Parent-projected and not authoritative. Filter state via join to ls_sales instead.",
  "ls_sale_lines.complete_time": "Parent-projected and not authoritative. Date-filter on ls_sales.complete_time via the sale_id join instead.",
  "ls_sale_payments.completed": "Parent-projected and potentially sparse. Filter state via join to ls_sales instead.",
  "ls_sale_payments.voided": "Parent-projected and potentially sparse. Filter state via join to ls_sales instead.",
  "ls_sale_payments.complete_time": "Parent-projected; unreliable. Use ls_sales.complete_time via the sale_id join.",
  "ls_sale_payments.shop_id": "Parent-projected shop; unreliable coverage. Prefer ls_sales.shop_id via the sale_id join.",
  "ls_purchase_order_lines.vendor_id": "Parent-projected and potentially unpopulated. Join ls_purchase_orders for the vendor.",
  "ls_purchase_order_lines.shop_id": "Parent-projected and potentially unpopulated. Join ls_purchase_orders for the shop.",
  "ls_purchase_order_lines.complete": "Parent-projected and potentially unpopulated. Join ls_purchase_orders for order state.",
  "ls_purchase_order_lines.ordered_date": "Parent-projected and potentially unpopulated. Join ls_purchase_orders for dates.",
  "ls_purchase_order_lines.received_date": "Parent-projected and potentially unpopulated. Join ls_purchase_orders for dates.",
  "ls_purchase_order_lines.archived": "Parent-projected and potentially unpopulated. Join ls_purchase_orders for state.",
  "ls_purchase_order_lines.vendor_currency_code": "Parent-projected and potentially unpopulated. Join ls_purchase_orders.",
});

const MIGRATIONS_DIR = "infra/migrations/analytical";

function mapToLive(
  tableId: string,
  name: string,
  live: Set<string>,
): string | null {
  if (live.has(name)) return name;
  for (const candidate of lightspeedPhysicalCandidates(tableId, name)) {
    if (live.has(candidate)) return candidate;
  }
  return null;
}

function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const sentence = flat.split(/(?<=\.)\s(?<!\be\.g\.\s)(?<!\bi\.e\.\s)(?<!\bvs\.\s)(?<!\betc\.\s)/u)[0] ?? flat;
  const clipped = sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
  return clipped.replace(/\.$/u, "");
}

type LiveTable = Readonly<{
  id: string;
  domain: string;
  grain: string;
  description: string;
  primaryKey: readonly string[];
  /** live column name → description (may be empty when the spec has none) */
  columns: ReadonlyMap<string, Readonly<{ description: string; type: string; enums: readonly string[] | null; deprecated: boolean }>>;
}>;

function reconcile(specPath: string, ddl: Map<string, Set<string>>): LiveTable[] {
  const raw = JSON.parse(readFileSync(specPath, "utf8")) as { tables: PackTable[] };
  const tables: LiveTable[] = [];
  for (const table of raw.tables) {
    const live = ddl.get(table.id);
    if (!live) continue;
    const columns = new Map<string, { description: string; type: string; enums: readonly string[] | null; deprecated: boolean }>();
    for (const column of table.columns ?? []) {
      const mapped = mapToLive(table.id, column.name, live);
      if (!mapped || STAGING_PLATFORM_COLUMNS.has(mapped)) continue;
      if (columns.has(mapped)) continue;
      const override = DESCRIPTION_OVERRIDES[`${table.id}.${mapped}`];
      columns.set(mapped, {
        description: override ?? column.description ?? "",
        type: column.type ?? "",
        enums: column.enums && column.enums.length > 0 && column.enums.length <= 8 ? column.enums : null,
        deprecated: column.deprecated === true,
      });
    }
    // Live columns the spec never documented still exist and must be listed —
    // an invisible column is an invented-column error waiting to happen.
    for (const col of [...live].sort()) {
      if (STAGING_PLATFORM_COLUMNS.has(col) || columns.has(col)) continue;
      const override = DESCRIPTION_OVERRIDES[`${table.id}.${col}`];
      columns.set(col, { description: override ?? "", type: "", enums: null, deprecated: false });
    }
    const pk = (table.primaryKey ?? [])
      .map((key) => mapToLive(table.id, key, live))
      .filter((key): key is string => key !== null);
    tables.push({
      id: table.id,
      domain: table.domain ?? "other",
      grain: table.grain ?? "row",
      description: table.description ?? "",
      primaryKey: pk,
      columns,
    });
  }
  return tables;
}

/** column name that is some table's primary key → that table (join targets). */
function joinTargets(tables: readonly LiveTable[]): Map<string, string> {
  const targets = new Map<string, string>();
  for (const table of tables) {
    if (table.primaryKey.length === 1) {
      const pk = table.primaryKey[0]!;
      // First table to claim a pk column wins; ls_* ids are globally unique names.
      if (!targets.has(pk)) targets.set(pk, table.id);
    }
  }
  return targets;
}

function buildIndex(tables: readonly LiveTable[], targets: Map<string, string>): string {
  const byDomain = new Map<string, LiveTable[]>();
  for (const table of tables) {
    const group = byDomain.get(table.domain) ?? [];
    group.push(table);
    byDomain.set(table.domain, group);
  }
  const lines: string[] = [
    "Every queryable Lightspeed table lives in source_lightspeed and starts with ls_. There are no other queryable tables in that schema (older unprefixed names are retired and empty).",
    "Format: table — grain. pk: primary key. joins: fk_column→target_table.",
    "",
  ];
  for (const [domain, group] of [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`[${domain}]`);
    for (const table of group.sort((a, b) => a.id.localeCompare(b.id))) {
      const joins = [...table.columns.keys()]
        .filter((col) => col.endsWith("_id") && targets.has(col) && targets.get(col) !== table.id)
        .map((col) => `${col}→${targets.get(col)}`)
        .slice(0, 8);
      const parts = [`${table.id} — ${firstSentence(table.grain, 110)}`];
      if (table.primaryKey.length > 0) parts.push(`pk: ${table.primaryKey.join(", ")}`);
      if (joins.length > 0) parts.push(`joins: ${joins.join(", ")}`);
      lines.push(parts.join(". "));
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function buildDimensionDictionary(tables: readonly LiveTable[], targets: Map<string, string>): string {
  const lines: string[] = [];
  for (const table of [...tables].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`source_lightspeed.${table.id} — ${firstSentence(table.grain, 180)}.`);
    if (table.description) lines.push(`  ${firstSentence(table.description, 220)}.`);
    if (table.primaryKey.length > 0) lines.push(`  primary key: ${table.primaryKey.join(", ")}`);
    for (const [name, meta] of table.columns) {
      const bits: string[] = [];
      if (meta.description) bits.push(firstSentence(meta.description, 150));
      if (meta.enums) bits.push(`values: ${meta.enums.join("|")}`);
      if (meta.deprecated) bits.push("deprecated");
      const target = name.endsWith("_id") && targets.get(name) !== table.id ? targets.get(name) : undefined;
      if (target) bits.push(`joins ${target}`);
      lines.push(bits.length > 0 ? `  ${name} — ${bits.join(". ")}` : `  ${name}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function packCatalog(path: string, schema: string): string {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { tables: PackTable[] };
  const lines: string[] = [];
  for (const table of raw.tables) {
    const grain = (table.grain ?? "row").replace(/\s+/gu, " ").slice(0, 140);
    const desc = (table.description ?? "").replace(/\s+/gu, " ").split(". ")[0]?.slice(0, 160) ?? "";
    const preferred = (table.columns ?? [])
      .filter((column) => column.key || column.loadBearing)
      .map((column) => column.name);
    const fallback = (table.columns ?? []).slice(0, 12).map((column) => column.name);
    const columns = (preferred.length > 0 ? preferred : fallback).slice(0, 16).join(", ");
    lines.push(`${schema}.${table.id} — ${grain}`);
    if (desc) lines.push(`  ${desc}.`);
    if (columns) lines.push(`  columns: ${columns}`);
  }
  return lines.join("\n");
}

function deputyCatalog(): string {
  const lines = [
    "Every Deputy table lives in source_deputy and carries tenant-scoped platform envelope fields including tombstone, mapping_version and ingested_at.",
    "Raw Deputy is a fallback for workforce detail; prefer the canonical workforce marts when they cover the question because those marts preserve reviewed employee identity and planned-versus-actual semantics.",
    "",
  ];
  for (const stream of deputyManifest.streams) {
    const fields = deputyManifest.fieldCoverage
      .filter((field) => field.stream === stream.id && field.disposition !== "unsupported")
      .map((field) => {
        const column = stagingColumnName(field.field);
        const typedColumn = `${column}(${field.stagingType})`;
        return field.target ? `${typedColumn}→${field.target}` : typedColumn;
      });
    lines.push(`source_deputy.${stream.id} — one Deputy ${stream.resource} record per source id; authority: ${stream.authorityConcept}.`);
    lines.push(`  columns: ${[...new Set(fields)].join(", ")}`);
  }
  return lines.join("\n");
}

const stagingContracts = parseStagingContractsFromMigrations(
  resolve(MIGRATIONS_DIR),
);
const ddl = new Map(
  [...stagingContracts.values()]
    .filter(({ schema }) => schema === "source_lightspeed")
    .map(({ table, columns }) => [table, new Set(columns.keys())]),
);
const lightspeedTables = reconcile(resolve("connectors/lightspeed-r/tables.json"), ddl);
const lsOnly = lightspeedTables.filter((t) => t.id.startsWith("ls_"));
const targets = joinTargets(lsOnly);

const index = buildIndex(lsOnly, targets);
const dimensions = [...new Set(lsOnly.map((t) => t.domain))].sort();
const dictionaries: Record<string, string> = {};
for (const dimension of dimensions) {
  dictionaries[dimension] = buildDimensionDictionary(lsOnly.filter((t) => t.domain === dimension), targets);
}
const tableDictionaries = Object.fromEntries(
  lsOnly
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((table) => [table.id, buildDimensionDictionary([table], targets)]),
);

const xero = packCatalog(resolve("connectors/xero/tables.json"), "source_xero");
const deputy = deputyCatalog();

const platformNote = [
  "Every source_lightspeed table also carries the platform envelope columns:",
  "tenant_id, connection_id, source_record_id, tombstone (soft delete — always filter false),",
  "mapping_version (pack generation — always pin via the pack CTE), ingested_at, first_ingested_at,",
  "source_updated_at, source_version, namespaced_source_key, external_account_reference, payload_hash, payload_batch_id, sync_run_id.",
].join(" ");

const header = "// Generated by scripts/write-staging-schema-doc.mts from connector tables.json + every source_lightspeed migration. Do not hand-edit.\n"
  + "// Regenerate: npm run generate:staging-schema. CI freshness: npm run generate:staging-schema -- --check.\n\n";

const body = header
  + `/** One line per queryable ls_* table: dimension, grain, pk, join edges. Inject on every SQL turn. */\n`
  + `export const LIGHTSPEED_TABLE_INDEX = ${JSON.stringify(`${platformNote}\n\n${index}`)};\n\n`
  + `/** Dictionary dimensions available for selective injection. */\n`
  + `export const LIGHTSPEED_DIMENSIONS = ${JSON.stringify(dimensions)} as const;\n\n`
  + `/** Full per-dimension column dictionaries (live typed-staging DDL names with meanings). */\n`
  + `export const LIGHTSPEED_DIMENSION_DICTIONARIES: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(dictionaries, null, 2)});\n\n`
  + `/** Full per-table dictionaries for progressive agent discovery. */\n`
  + `export const LIGHTSPEED_TABLE_DICTIONARIES: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(tableDictionaries, null, 2)});\n\n`
  + `/** Xero raw staging catalogue (financial truth). Inject only for finance questions. */\n`
  + `export const XERO_SCHEMA_DOC = ${JSON.stringify(xero)};\n\n`
  + `/** Deputy raw staging catalogue (planned and actual workforce truth). Inject only for workforce questions. */\n`
  + `export const DEPUTY_SCHEMA_DOC = ${JSON.stringify(deputy)};\n\n`
  + `/** @deprecated Composed compatibility view of the Lightspeed surface (index + all dictionaries). */\n`
  + `export const STAGING_SCHEMA_DOC = [\n`
  + `  "LIGHTSPEED POS raw staging (operational truth: tickets, units, stock, customers, workshop):",\n`
  + `  LIGHTSPEED_TABLE_INDEX,\n`
  + `  "",\n`
  + `  "XERO accounting raw staging (financial truth: invoices, journals, bank, GST, contacts):",\n`
  + `  XERO_SCHEMA_DOC,\n`
  + `  "",\n`
  + `  "DEPUTY workforce raw staging (planned rosters and actual timesheets):",\n`
  + `  DEPUTY_SCHEMA_DOC,\n`
  + `].join("\\n");\n`;

const outPath = resolve("packages/agent/src/generated-staging-schema.ts");
const check = process.argv.includes("--check");
if (check) {
  const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (current !== body) {
    console.error("generated-staging-schema.ts is stale. Run: npm run generate:staging-schema");
    process.exit(1);
  }
  console.log("generated-staging-schema.ts is fresh.");
} else {
  writeFileSync(outPath, body);
  const dictChars = Object.values(dictionaries).reduce((sum, d) => sum + d.length, 0);
  console.log(`wrote ${outPath} (index ${index.length} chars, ${dimensions.length} dictionaries totalling ${dictChars} chars, xero ${xero.length} chars, deputy ${deputy.length} chars)`);
}
