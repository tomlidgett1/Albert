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
const ALLOWED_SCHEMAS = Object.freeze(["mart", "core", "quality", "semantic_internal"]);

/** Any `schema.` qualifier the statement names, lower-cased. */
const SCHEMA_QUALIFIER = /(?<![\w."])([a-z_][a-z0-9_]*)\s*\.\s*[a-z_"]/giu;

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

  const schemas = new Set<string>();
  for (const [, schema] of surface.matchAll(SCHEMA_QUALIFIER)) {
    if (schema) schemas.add(schema.toLowerCase());
  }
  // A bare alias like `line.tenant_id` also matches, so only reject names that
  // look like a schema the role cannot read — an unknown qualifier is far more
  // likely to be a table alias than an attempt to reach another schema, and RLS
  // plus the semantic_ro grants are what actually stop the latter.
  const forbidden = [...schemas].filter((schema) =>
    /^(?:pg_|information_schema$|control_plane$|auth$|storage$|vault$|net$|extensions$)/u.test(schema));
  if (forbidden.length > 0) {
    reject(`Exploratory SQL cannot read ${forbidden.join(", ")}. Readable schemas are ${ALLOWED_SCHEMAS.join(", ")}.`);
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
