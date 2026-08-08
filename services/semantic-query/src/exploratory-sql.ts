import { SemanticCompilerError } from "../../../packages/compiler/src/index.js";

/**
 * Model-authored SQL, executed read-only against the tenant's own analytical
 * data when no governed metric expresses the question.
 *
 * This is deliberately an escape hatch, and what makes it defensible is that the
 * guarantees do not rest on reading the SQL. Every statement runs through
 * `queryAsSemanticRole`, which opens `BEGIN TRANSACTION ... READ ONLY` as the
 * `semantic_ro` role under a verified tenant capability token:
 *
 *  - Writes and DDL cannot succeed: the transaction is READ ONLY.
 *  - Rows from another tenant cannot be returned: the `core` facts force row
 *    level security, and the `mart` views are `security_invoker` so the policy
 *    `tenant_id = core.current_tenant_id()` is evaluated as the querying role.
 *    Omitting a tenant predicate narrows nothing.
 *  - Credentials cannot be read: `semantic_ro` holds no grant on control_plane.
 *  - A runaway query cannot hold the pool: statement_timeout is set per call.
 *  - A second statement cannot be smuggled in: the query is parameterised, so
 *    it goes over the extended protocol, which carries exactly one statement.
 *
 * The checks below are therefore defence in depth and a source of good error
 * messages, not the security boundary. They are written to fail closed anyway.
 */

/** Statement kinds that may open model-authored SQL. Everything else is out. */
const ALLOWED_OPENERS = /^\s*(?:with|select)\b/iu;

/**
 * Verbs that must never appear as a statement, even though READ ONLY would
 * already reject them. Matched on word boundaries so column names such as
 * `updated_at` or `deleted` are untouched.
 */
const FORBIDDEN_VERBS =
  /\b(?:insert|update|delete|truncate|drop|alter|create|grant|revoke|comment|copy|vacuum|analyze|reindex|cluster|refresh|call|do|execute|prepare|listen|notify|lock|set|reset|discard|begin|commit|rollback|savepoint|security\s+label)\b/iu;

/** Postgres server-side functions that read outside the analytical data set. */
const FORBIDDEN_FUNCTIONS =
  /\b(?:pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|dblink|pg_sleep|current_setting|set_config|pg_terminate_backend|pg_cancel_backend)\s*\(/iu;

/** Schemas an exploratory statement may read. Mirrors the semantic_ro grants. */
export const ALLOWED_SCHEMAS = Object.freeze([
  "mart",
  "core",
  "quality",
  "semantic_internal",
  "source_lightspeed",
  "source_xero",
  "source_deputy",
] as const);

/** Typed staging schemas that hold raw connector projections. */
export const SOURCE_STAGING_SCHEMAS = Object.freeze([
  "source_lightspeed",
  "source_xero",
  "source_deputy",
] as const);

const SOURCE_STAGING_SCHEMA_SET = new Set<string>(SOURCE_STAGING_SCHEMAS);
const ALLOWED_SCHEMA_SET = new Set<string>(ALLOWED_SCHEMAS);

/**
 * Retired unprefixed Lightspeed staging tables from the pre-pack pipeline.
 * They still exist in the schema, RLS lets the role read them, and they are
 * all EMPTY — a statement that touches one returns zero rows and produces a
 * confidently wrong "the shop has none" answer. Reject with the ls_ mapping.
 */
const RETIRED_LIGHTSPEED_TABLES: Readonly<Record<string, string>> = Object.freeze({
  categories: "ls_categories",
  customers: "ls_customers",
  employees: "ls_employees",
  inventory_logs: "ls_inventory_logs",
  item_shops: "ls_item_shops",
  items: "ls_items",
  order_lines: "ls_sale_lines",
  orders: "ls_sales",
  payment_types: "ls_payment_types",
  sales: "ls_sales",
  shops: "ls_shops",
  tax_categories: "ls_tax_categories",
  vendors: "ls_vendors",
});

/** Any `source_lightspeed.<table>` reference, quoted or bare, lower-cased. */
const LIGHTSPEED_TABLE_REF = /\bsource_lightspeed\s*\.\s*"?([a-z_][a-z0-9_]*)"?/giu;

/** Lightspeed staging tables the statement names. */
export function sqlLightspeedTables(sql: string): readonly string[] {
  const tables = new Set<string>();
  for (const [, table] of sqlScanSurface(sql).matchAll(LIGHTSPEED_TABLE_REF)) {
    if (table) tables.add(table.toLowerCase());
  }
  return Object.freeze([...tables]);
}

/** Any `schema.` qualifier the statement names, lower-cased. */
const SCHEMA_QUALIFIER = /(?<![\w."])([a-z_][a-z0-9_]*)\s*\.\s*[a-z_"]/giu;

/** Schema qualifiers named in a statement (aliases may appear; callers filter). */
export function sqlSchemaQualifiers(sql: string): readonly string[] {
  const schemas = new Set<string>();
  for (const [, schema] of sqlScanSurface(sql).matchAll(SCHEMA_QUALIFIER)) {
    if (schema) schemas.add(schema.toLowerCase());
  }
  return Object.freeze([...schemas]);
}

/** True when the statement names at least one raw staging schema. */
export function sqlTouchesSourceStaging(sql: string): boolean {
  return sqlSchemaQualifiers(sql).some((schema) => SOURCE_STAGING_SCHEMA_SET.has(schema));
}

export const EXPLORATORY_SQL_MAX_ROWS = 500;
export const EXPLORATORY_SQL_TIMEOUT_MS = 15_000;

/** Strips string literals, dollar-quoted bodies and comments before scanning,
 * so a product name containing the word "update" cannot trip a verb check and,
 * more importantly, a comment cannot hide one. */
export function sqlScanSurface(sql: string): string {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/gu, " ")
    .replace(/\$([a-z_][a-z0-9_]*)\$[\s\S]*?\$\1\$/giu, " ")
    .replace(/'(?:[^']|'')*'/gu, " ")
    .replace(/--[^\n]*/gu, " ")
    .replace(/\/\*[\s\S]*?\*\//gu, " ");
}

function reject(message: string): never {
  throw new SemanticCompilerError("ILLEGAL_SQL", message);
}

/**
 * Accepts one read-only statement over the allowlisted analytical schemas, or
 * explains precisely what has to change. Returns the statement wrapped so it is
 * bounded and so the tenant parameter is bound — `queryAsSemanticRole` requires
 * `$1` to be the trusted tenant id, and the wrapper is what guarantees the
 * placeholder is present whether or not the author referenced it.
 */
export function compileExploratorySql(
  rawSql: string,
  maxRows = EXPLORATORY_SQL_MAX_ROWS,
): Readonly<{ sql: string; parameterCount: number }> {
  const sql = rawSql.trim().replace(/;\s*$/u, "").trim();
  if (!sql) reject("Exploratory SQL was empty.");
  if (sql.length > 8_000) reject("Exploratory SQL must be under 8,000 characters.");

  const surface = sqlScanSurface(sql);

  if (surface.includes(";")) {
    reject("Exploratory SQL must be a single statement. Remove the ';' and everything after it.");
  }
  if (!ALLOWED_OPENERS.test(surface)) {
    reject("Exploratory SQL must be a single SELECT, optionally opening with WITH.");
  }
  const verb = FORBIDDEN_VERBS.exec(surface);
  if (verb) {
    reject(`Exploratory SQL is read-only, so it cannot contain ${verb[0].toUpperCase()}. Express the question as a SELECT.`);
  }
  const fn = FORBIDDEN_FUNCTIONS.exec(surface);
  if (fn) {
    reject(`Exploratory SQL cannot call ${fn[0].replace(/\s*\($/u, "")}. Read only the analytical tables.`);
  }
  if (/\$\d/u.test(surface)) {
    reject("Exploratory SQL cannot use bind parameters. Write literal values; the tenant is applied automatically.");
  }

  const schemas = sqlSchemaQualifiers(sql);
  // A bare alias like `line.tenant_id` also matches, so only reject names that
  // look like a schema the role cannot read — an unknown qualifier is far more
  // likely to be a table alias than an attempt to reach another schema, and RLS
  // plus the semantic_ro grants are what actually stop the latter.
  const forbidden = schemas.filter((schema) =>
    /^(?:pg_|information_schema$|control_plane$|auth$|storage$|vault$|net$|extensions$)/u.test(schema)
    || (schema.startsWith("source_") && !SOURCE_STAGING_SCHEMA_SET.has(schema)));
  if (forbidden.length > 0) {
    reject(`Exploratory SQL cannot read ${forbidden.join(", ")}. Readable schemas are ${ALLOWED_SCHEMAS.join(", ")}.`);
  }
  // Explicit schema refs must be on the allowlist when they look like real schemas
  // (source_*, mart, core, quality, semantic_internal). Plain aliases stay free.
  const disallowed = schemas.filter((schema) =>
    (ALLOWED_SCHEMA_SET.has(schema) === false)
    && /^(?:mart|core|quality|semantic_internal|source_)/u.test(schema));
  if (disallowed.length > 0) {
    reject(`Exploratory SQL cannot read ${disallowed.join(", ")}. Readable schemas are ${ALLOWED_SCHEMAS.join(", ")}.`);
  }

  // Lightspeed staging is ls_-prefixed only. The unprefixed names are retired,
  // empty shells whose zero rows read as "the shop has none" — fail loudly with
  // the correct table instead of executing a query that can only mislead.
  const nonLs = sqlLightspeedTables(sql).filter((table) => !table.startsWith("ls_"));
  if (nonLs.length > 0) {
    const corrections = nonLs.map((table) => {
      const replacement = RETIRED_LIGHTSPEED_TABLES[table];
      return replacement
        ? `source_lightspeed.${table} is a retired empty table — use source_lightspeed.${replacement}`
        : `source_lightspeed.${table} does not exist — every Lightspeed staging table starts with ls_`;
    });
    reject(`${corrections.join("; ")}. Rewrite the statement against the ls_ tables and run it again.`);
  }

  const bounded = Math.max(1, Math.min(maxRows, EXPLORATORY_SQL_MAX_ROWS));
  // The unused scope CTE is what binds $1. queryAsSemanticRole asserts the
  // first parameter is the trusted tenant id, and row level security is what
  // actually scopes the rows; this only guarantees the placeholder exists.
  return Object.freeze({
    sql: `WITH albert_tenant_scope AS (SELECT $1::text AS tenant_id)\nSELECT * FROM (\n${sql}\n) AS albert_exploratory\nLIMIT ${bounded}`,
    parameterCount: 1,
  });
}
