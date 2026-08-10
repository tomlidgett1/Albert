import type { LightspeedCatalogue } from "./catalogue.js";

export class AnthropicSqlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicSqlPolicyError";
  }
}

function scanSurface(sql: string): string {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/gu, " ")
    .replace(/\$([a-z_][a-z0-9_]*)\$[\s\S]*?\$\1\$/giu, " ")
    .replace(/'(?:[^']|'')*'/gu, " ")
    .replace(/--[^\n]*/gu, " ")
    .replace(/\/\*[\s\S]*?\*\//gu, " ");
}

const SQL_KEYWORDS = new Set([
  "and", "cross", "full", "group", "having", "inner", "join", "left", "limit",
  "on", "order", "outer", "right", "union", "where", "window",
]);

function hasAliasPredicate(surface: string, alias: string | undefined, column: string, expression: RegExp): boolean {
  const qualifier = alias ? `"?${alias}"?\\s*\\.\\s*` : "";
  const qualified = new RegExp(`${qualifier}"?${column}"?\\s*${expression.source}`, "iu");
  return qualified.test(surface);
}

function hasTruthyPredicate(surface: string, column: string): boolean {
  const identifier = `(?:[a-z_][a-z0-9_]*\\s*\\.\\s*)?"?${column}"?`;
  const explicit = new RegExp(`\\b${identifier}\\s*(?:=\\s*true|is\\s+true)`, "iu");
  const shorthand = new RegExp(`(?:\\bwhere|\\band|\\bor|\\()\\s*${identifier}\\s*(?=\\band\\b|\\bor\\b|\\)|$)`, "iu");
  return explicit.test(surface) || shorthand.test(surface);
}

/** Anthropic-specific staging contract applied before the signed semantic
 * boundary. The semantic service remains the executor and final authority;
 * this second independent gate prevents Claude from omitting the Lightspeed
 * pack-generation, tombstone, and sale-state invariants. */
export function assertAnthropicSqlPolicy(input: Readonly<{
  sql: string;
  catalogue: LightspeedCatalogue;
  time?: Readonly<{ from: string; to: string }>;
}>): void {
  const surface = scanSurface(input.sql);
  if (/\bsource_(?:xero|deputy)\s*\./iu.test(surface)) {
    throw new AnthropicSqlPolicyError("New Method source exploration is restricted to the declared Lightspeed staging catalogue.");
  }
  const referencePattern = /\b(?:from|join)\s+source_lightspeed\s*\.\s*"?(ls_[a-z0-9_]+)"?(?:\s+(?:as\s+)?"?([a-z_][a-z0-9_]*)"?)?/giu;
  const references = [...surface.matchAll(referencePattern)].map((match) => {
    const candidateAlias = match[2]?.toLowerCase();
    return {
      table: match[1]!.toLowerCase(),
      alias: candidateAlias && !SQL_KEYWORDS.has(candidateAlias) ? candidateAlias : undefined,
      index: match.index,
    };
  });
  if (references.length === 0) return;

  const allowlisted = new Set(input.catalogue.tables.map((table) => table.id));
  const unknown = references.map(({ table }) => table).filter((table) => !allowlisted.has(table));
  if (unknown.length > 0) {
    throw new AnthropicSqlPolicyError(`SQL named non-allowlisted Lightspeed tables: ${[...new Set(unknown)].join(", ")}.`);
  }
  if (!/\bwith\s+pack\s+as\s*\(/iu.test(surface)
    || !/select\s+mapping_version\s+as\s+mv\s+from\s+source_lightspeed\s*\./iu.test(surface)
    || !/order\s+by\s+max\s*\(\s*ingested_at\s*\)\s+desc\s+limit\s+1/iu.test(surface)) {
    throw new AnthropicSqlPolicyError("Lightspeed staging SQL must derive the active mapping version in a pack CTE from the newest ingested generation.");
  }

  const operational = references.filter(({ index }) => {
    const prefix = surface.slice(Math.max(0, index - 90), index);
    return !/select\s+mapping_version\s+as\s+mv\s*$/iu.test(prefix);
  });
  if (operational.length === 0) {
    throw new AnthropicSqlPolicyError("Lightspeed staging SQL must query data after resolving the active pack generation.");
  }
  for (const { table, alias } of operational) {
    if (!hasAliasPredicate(surface, alias, "mapping_version", /=\s*\(\s*select\s+mv\s+from\s+pack\s*\)/u)) {
      throw new AnthropicSqlPolicyError(`${table} must be pinned to the active mapping version.`);
    }
    const qualifier = alias ? `"?${alias}"?\\s*\\.\\s*` : "";
    const tombstone = new RegExp(`(?:not\\s+${qualifier}"?tombstone"?|${qualifier}"?tombstone"?\\s*(?:=|is)\\s*false)`, "iu");
    if (!tombstone.test(surface)) throw new AnthropicSqlPolicyError(`${table} must exclude tombstones.`);
  }

  const tables = new Set(references.map(({ table }) => table));
  const readsSaleMoney = tables.has("ls_sales") || (
    tables.has("ls_sale_lines")
    && /\b(?:calc_total|calc_tax1|calc_tax2|unit_quantity|calc_fifo_cost|calc_avg_cost)\b/iu.test(surface)
  );
  if (readsSaleMoney) {
    if (!tables.has("ls_sales")) throw new AnthropicSqlPolicyError("Sale-line money must join ls_sales for completed and voided state.");
    if (!hasTruthyPredicate(surface, "completed")
      || !/(?:not\s+(?:[a-z_][a-z0-9_]*\s*\.\s*)?voided|(?:[a-z_][a-z0-9_]*\s*\.\s*)?voided\s*(?:=|is)\s*false)/iu.test(surface)) {
      throw new AnthropicSqlPolicyError("Lightspeed sale analysis requires completed sales and explicit voided=false semantics.");
    }
    if (!input.time) throw new AnthropicSqlPolicyError("Lightspeed sale analysis requires a bounded reporting period.");
    if (!/\b(?:[a-z_][a-z0-9_]*\s*\.\s*)?complete_time\b/iu.test(surface)
      || !input.sql.includes(input.time.from) || !input.sql.includes(input.time.to)) {
      throw new AnthropicSqlPolicyError("Lightspeed sale analysis must bound complete_time to the declared reporting period.");
    }
  }
}
