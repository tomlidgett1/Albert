import type { QueryScopeReceipt } from "../../../packages/agent/src/semantic-tools.js";
import {
  readSqlSurface,
  tokenizeSql,
  type SqlToken,
} from "../../../packages/semantic-registry/src/sql-surface.js";

const MAX_PREDICATES = 40;
const MAX_VALUES_PER_FIELD = 20;
const MAX_RECEIPT_TEXT = 240;

const PREDICATE_BOUNDARIES = new Set([
  "AND", "OR", "WHERE", "ON", "HAVING", "WHEN", "THEN", "ELSE",
]);
const CLAUSE_BOUNDARIES = new Set([
  "GROUP", "ORDER", "LIMIT", "OFFSET", "WINDOW", "UNION", "INTERSECT", "EXCEPT", "FETCH", "FOR",
]);

type ScopePredicate = QueryScopeReceipt["predicates"][number];
type ScopeOperator = ScopePredicate["operator"];

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, MAX_RECEIPT_TEXT);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function literalText(token: SqlToken): string | undefined {
  if (token.kind === "string") {
    return token.value.slice(1, -1).replace(/''/gu, "'").slice(0, MAX_RECEIPT_TEXT);
  }
  if (token.kind === "number") return token.value.slice(0, MAX_RECEIPT_TEXT);
  if (token.kind === "identifier" && (token.upper === "TRUE" || token.upper === "FALSE" || token.upper === "NULL")) {
    return token.upper.toLowerCase();
  }
  return undefined;
}

function tokenDepths(tokens: readonly SqlToken[]): readonly number[] {
  const depths: number[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "punct" && token.value === ")") depth = Math.max(0, depth - 1);
    depths.push(depth);
    if (token.kind === "punct" && token.value === "(") depth += 1;
  }
  return depths;
}

function predicateStart(tokens: readonly SqlToken[], depths: readonly number[], operatorAt: number): number {
  const baseDepth = depths[operatorAt] ?? 0;
  for (let index = operatorAt - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    const depth = depths[index] ?? 0;
    if (depth < baseDepth) return index + 1;
    if (depth === baseDepth && PREDICATE_BOUNDARIES.has(token.upper)) return index + 1;
    if (depth === baseDepth && token.kind === "punct" && (token.value === "," || token.value === ";")) return index + 1;
  }
  return 0;
}

function predicateEnd(tokens: readonly SqlToken[], depths: readonly number[], operatorAt: number): number {
  const baseDepth = depths[operatorAt] ?? 0;
  for (let index = operatorAt + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const depth = depths[index] ?? 0;
    if (depth < baseDepth) return index;
    if (depth === baseDepth && (PREDICATE_BOUNDARIES.has(token.upper) || CLAUSE_BOUNDARIES.has(token.upper))) return index;
    if (depth === baseDepth && token.kind === "punct" && (token.value === "," || token.value === ";")) return index;
  }
  return tokens.length;
}

function normalizedExpression(tokens: readonly SqlToken[]): string {
  let text = "";
  for (const token of tokens) {
    const value = token.kind === "string" || token.kind === "number" ? "?" : token.value;
    if (!value) continue;
    const punctuation = token.kind === "punct" && [".", ")", "]", ","].includes(value);
    const open = token.kind === "punct" && ["(", "["].includes(value);
    if (!text || punctuation) text += value;
    else if (open || text.endsWith("(") || text.endsWith(".")) text += value;
    else text += ` ${value}`;
  }
  return text.trim().slice(0, MAX_RECEIPT_TEXT);
}

function operatorAt(tokens: readonly SqlToken[], index: number): Readonly<{ operator: ScopeOperator; width: number }> | undefined {
  const token = tokens[index]!;
  const next = tokens[index + 1];
  const previous = tokens[index - 1];
  if (token.value === "=") return { operator: "eq", width: 1 };
  if ((token.value === "!" && next?.value === "=") || (token.value === "<" && next?.value === ">")) {
    return { operator: "neq", width: 2 };
  }
  if (token.value === ">" && next?.value === "=") return { operator: "gte", width: 2 };
  if (token.value === "<" && next?.value === "=") return { operator: "lte", width: 2 };
  if (token.value === ">") return { operator: "gt", width: 1 };
  if (token.value === "<") return { operator: "lt", width: 1 };
  if (token.upper === "LIKE") return { operator: previous?.upper === "NOT" ? "not_like" : "like", width: 1 };
  if (token.upper === "ILIKE") return { operator: previous?.upper === "NOT" ? "not_ilike" : "ilike", width: 1 };
  if (token.upper === "IN") return { operator: previous?.upper === "NOT" ? "not_in" : "in", width: 1 };
  if (token.upper === "IS" && next?.upper === "NULL") return { operator: "is_null", width: 2 };
  if (token.upper === "IS" && next?.upper === "NOT" && tokens[index + 2]?.upper === "NULL") {
    return { operator: "is_not_null", width: 3 };
  }
  return undefined;
}

/**
 * Reads literal restrictions from the statement itself. This is deliberately
 * an evidence reader, not a SQL security parser: malformed/unrecognised shapes
 * simply produce fewer predicates, while execution safety remains the read-only
 * role, RLS and the existing SQL compiler boundary.
 */
export function sqlScopePredicates(sql: string): readonly ScopePredicate[] {
  const tokens = tokenizeSql(sql);
  const depths = tokenDepths(tokens);
  const predicates: ScopePredicate[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < tokens.length && predicates.length < MAX_PREDICATES; index += 1) {
    const found = operatorAt(tokens, index);
    if (!found) continue;
    const start = predicateStart(tokens, depths, index);
    const end = predicateEnd(tokens, depths, index);
    let left = tokens.slice(start, index);
    if (left.at(-1)?.upper === "NOT") left = left.slice(0, -1);
    const expression = normalizedExpression(left);
    if (!expression) continue;
    const values = [...new Set(tokens
      .slice(index + found.width, end)
      .map(literalText)
      .filter((value): value is string => value !== undefined))]
      .slice(0, MAX_VALUES_PER_FIELD);
    if (values.length === 0 && found.operator !== "is_null" && found.operator !== "is_not_null") continue;
    const predicate: ScopePredicate = { expression, operator: found.operator, values };
    const key = JSON.stringify(predicate);
    if (seen.has(key)) continue;
    seen.add(key);
    predicates.push(predicate);
    index += found.width - 1;
  }
  return Object.freeze(predicates);
}

function resultScopeValues(
  columns: readonly string[],
  rows: readonly Readonly<Record<string, unknown>>[],
): QueryScopeReceipt["resultValues"] {
  const result: QueryScopeReceipt["resultValues"][number][] = [];
  for (const column of columns.slice(0, 32)) {
    const values = new Set<string>();
    let overflow = false;
    for (const row of rows) {
      const value = scalarText(row[column]);
      if (value === undefined) continue;
      values.add(value);
      if (values.size > MAX_VALUES_PER_FIELD) {
        overflow = true;
        break;
      }
    }
    if (!overflow && values.size > 0) {
      result.push({ column, values: [...values] });
    }
  }
  return result;
}

/** Creates the bounded, server-owned scope receipt for one executed SQL result. */
export function deriveSqlScopeReceipt(
  sql: string,
  columns: readonly string[],
  rows: readonly Readonly<Record<string, unknown>>[],
): QueryScopeReceipt {
  const surface = readSqlSurface(sql);
  const relationKeys = new Set<string>();
  const relations: QueryScopeReceipt["relations"][number][] = [];
  for (const scope of surface.scopes) {
    for (const relation of scope.relations) {
      if (relation.derived) continue;
      const key = `${relation.schema ?? ""}.${relation.name}`;
      if (relationKeys.has(key)) continue;
      relationKeys.add(key);
      relations.push({
        ...(relation.schema ? { schema: relation.schema } : {}),
        relation: relation.name,
      });
      if (relations.length >= 32) break;
    }
    if (relations.length >= 32) break;
  }
  return {
    kind: "sql",
    relations,
    predicates: [...sqlScopePredicates(sql)],
    resultValues: resultScopeValues(columns, rows),
  };
}
