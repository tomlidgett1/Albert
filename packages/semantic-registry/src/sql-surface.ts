/**
 * A purpose-built reading of one SELECT statement, extracting exactly what the
 * SQL-first linter needs: which relations each scope reads, how they are
 * joined, what is aggregated, and what is grouped. It is not a general SQL
 * parser and must never be treated as a security boundary — execution safety
 * comes from the read-only semantic_ro transaction and row level security.
 * When this reader cannot understand a statement it says so, and the caller
 * treats the statement as unverifiable rather than unsafe.
 */

export type SqlToken = Readonly<{
  kind: "identifier" | "quoted" | "number" | "string" | "punct";
  value: string;
  upper: string;
  start: number;
}>;

export type RelationRef = Readonly<{
  /** Lower-cased schema qualifier, if written. */
  schema?: string;
  /** Lower-cased relation name. */
  name: string;
  /** Lower-cased alias binding this relation in its scope. */
  alias: string;
  /** True when the name resolves to a WITH clause or derived subquery. */
  derived: boolean;
}>;

export type ColumnRef = Readonly<{ qualifier?: string; column: string }>;

export type AggregateCall = Readonly<{
  fn: "sum" | "avg" | "count" | "min" | "max";
  distinct: boolean;
  columns: readonly ColumnRef[];
  /** SELECT-list alias this aggregate contributes to, when discernible. */
  outputAlias?: string;
}>;

export type SelectScope = Readonly<{
  /** "" for the outermost scope, else the CTE or derived-table alias. */
  name: string;
  relations: readonly RelationRef[];
  joinEqualities: readonly Readonly<{ left: ColumnRef; right: ColumnRef }>[];
  aggregates: readonly AggregateCall[];
  groupBy: readonly ColumnRef[];
  /** Columns compared for equality against a literal in WHERE. */
  whereEqualityColumns: readonly ColumnRef[];
  hasGroupBy: boolean;
  /** Verbatim text from FROM up to GROUP BY/HAVING/ORDER/LIMIT, for the canary. */
  fromText?: string;
  /** Verbatim WHERE clause text (without the keyword), for the canary. */
  whereText?: string;
  /** Top-level ORDER BY items, backing the result-window ordering proof. */
  orderBy: readonly Readonly<{ column: string; direction: "asc" | "desc" }>[];
  /** Top-level LIMIT, when written as a plain integer. */
  limit?: number;
}>;

export type SqlSurface = Readonly<{
  scopes: readonly SelectScope[];
  /** Human-readable reasons parts of the statement defied this reader. */
  unparsed: readonly string[];
}>;

const KEYWORDS_ENDING_FROM = new Set(["GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "WINDOW", "UNION", "INTERSECT", "EXCEPT", "FETCH", "FOR"]);
const AGGREGATE_FNS = new Set(["SUM", "AVG", "COUNT", "MIN", "MAX"]);
const JOIN_INTRO = new Set(["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "LATERAL"]);
const NON_ALIAS_AFTER_RELATION = new Set([
  "ON", "USING", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "LATERAL",
  "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "UNION", "INTERSECT", "EXCEPT", "AS",
]);

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const ch = sql[index] as string;
    if (/\s/.test(ch)) { index += 1; continue; }
    if (ch === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'") {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === "'" && sql[end + 1] === "'") { end += 2; continue; }
        if (sql[end] === "'") break;
        end += 1;
      }
      tokens.push({ kind: "string", value: sql.slice(index, end + 1), upper: "'…'", start: index });
      index = end + 1;
      continue;
    }
    if (ch === '"') {
      const end = sql.indexOf('"', index + 1);
      const body = end === -1 ? sql.slice(index + 1) : sql.slice(index + 1, end);
      tokens.push({ kind: "quoted", value: body.toLowerCase(), upper: body.toUpperCase(), start: index });
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let end = index + 1;
      while (end < sql.length && /[a-zA-Z0-9_$]/.test(sql[end] as string)) end += 1;
      const value = sql.slice(index, end);
      tokens.push({ kind: "identifier", value: value.toLowerCase(), upper: value.toUpperCase(), start: index });
      index = end;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = index + 1;
      while (end < sql.length && /[0-9._eE]/.test(sql[end] as string)) end += 1;
      tokens.push({ kind: "number", value: sql.slice(index, end), upper: sql.slice(index, end), start: index });
      index = end;
      continue;
    }
    tokens.push({ kind: "punct", value: ch, upper: ch, start: index });
    index += 1;
  }
  return tokens;
}

function matchingParen(tokens: readonly SqlToken[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index] as SqlToken;
    if (token.kind === "punct" && token.value === "(") depth += 1;
    if (token.kind === "punct" && token.value === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Reads a statement into flat SELECT scopes: one per CTE, one per derived
 * FROM-subquery, one for the outermost query. Scalar subqueries inside the
 * SELECT list or WHERE are folded into their parent scope's aggregate and
 * relation reading rather than becoming scopes of their own.
 */
export function readSqlSurface(sql: string): SqlSurface {
  const tokens = tokenizeSql(sql);
  const scopes: SelectScope[] = [];
  const unparsed: string[] = [];
  const cteNames = new Set<string>();

  let at = 0;
  if (tokens[at]?.upper === "WITH") {
    at += 1;
    if (tokens[at]?.upper === "RECURSIVE") at += 1;
    for (;;) {
      const name = tokens[at];
      if (!name || (name.kind !== "identifier" && name.kind !== "quoted")) {
        unparsed.push("A WITH clause did not name its query.");
        break;
      }
      let cursor = at + 1;
      // Optional column list: name (a, b) AS (...)
      if (tokens[cursor]?.value === "(") {
        const close = matchingParen(tokens, cursor);
        if (close === -1) { unparsed.push(`CTE ${name.value} column list never closes.`); break; }
        cursor = close + 1;
      }
      if (tokens[cursor]?.upper !== "AS" || tokens[cursor + 1]?.value !== "(") {
        unparsed.push(`CTE ${name.value} is not of the form AS (…).`);
        break;
      }
      const open = cursor + 1;
      const close = matchingParen(tokens, open);
      if (close === -1) { unparsed.push(`CTE ${name.value} body never closes.`); break; }
      readSelectScope(sql, tokens.slice(open + 1, close), name.value, cteNames, scopes, unparsed);
      cteNames.add(name.value);
      at = close + 1;
      if (tokens[at]?.value === ",") { at += 1; continue; }
      break;
    }
  }
  readSelectScope(sql, tokens.slice(at), "", cteNames, scopes, unparsed);
  return Object.freeze({ scopes: Object.freeze(scopes), unparsed: Object.freeze(unparsed) });
}

function readSelectScope(
  sql: string,
  tokens: readonly SqlToken[],
  name: string,
  cteNames: ReadonlySet<string>,
  scopes: SelectScope[],
  unparsed: string[],
): void {
  const relations: RelationRef[] = [];
  const joinEqualities: { left: ColumnRef; right: ColumnRef }[] = [];
  const aggregates: AggregateCall[] = [];
  const groupBy: ColumnRef[] = [];
  const whereEqualityColumns: ColumnRef[] = [];
  const orderBy: { column: string; direction: "asc" | "desc" }[] = [];
  let hasGroupBy = false;
  let fromText: string | undefined;
  let whereText: string | undefined;
  let limit: number | undefined;

  // UNION branches are read as one combined scope: relations and aggregates
  // from every branch accumulate, which is conservative in the right
  // direction for fan-out reasoning.
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as SqlToken;

    if (token.kind === "punct" && token.value === "(") {
      // A derived table directly in FROM: ( SELECT … ) alias — recurse.
      const close = matchingParen(tokens, index);
      if (close === -1) { unparsed.push("A parenthesis never closes."); return; }
      const inner = tokens.slice(index + 1, close);
      const isSelect = inner[0]?.upper === "SELECT" || inner[0]?.upper === "WITH";
      const preceding = tokens[index - 1];
      const inFromPosition = preceding !== undefined
        && (preceding.upper === "FROM" || preceding.value === "," || JOIN_INTRO.has(preceding.upper));
      if (isSelect && inFromPosition) {
        const aliasToken = tokens[close + 1]?.upper === "AS" ? tokens[close + 2] : tokens[close + 1];
        const alias = aliasToken && (aliasToken.kind === "identifier" || aliasToken.kind === "quoted")
          && !NON_ALIAS_AFTER_RELATION.has(aliasToken.upper)
          ? aliasToken.value
          : `derived_${scopes.length}`;
        readSelectScope(sql, inner, alias, cteNames, scopes, unparsed);
        relations.push({ name: alias, alias, derived: true });
        index = close;
        // Skip the alias tokens so they are not read as relations.
        if (aliasToken && alias === aliasToken.value) {
          index = tokens[close + 1]?.upper === "AS" ? close + 2 : close + 1;
        }
        continue;
      }
      if (isSelect) {
        // Scalar or IN-subquery: fold its reading into this scope.
        readSelectScope(sql, inner, `${name || "outer"}#scalar`, cteNames, scopes, unparsed);
        index = close;
        continue;
      }
      continue;
    }

    if (token.upper === "FROM" && fromText === undefined) {
      const clauseEnd = findClauseEnd(tokens, index + 1);
      fromText = sliceSql(sql, tokens, index + 1, clauseEnd);
      readFromClause(tokens.slice(index + 1, clauseEnd), cteNames, relations, joinEqualities, unparsed);
      // WHERE belongs to the same reading window.
      const whereAt = findTopLevel(tokens, index + 1, clauseEnd, "WHERE");
      if (whereAt !== -1) {
        const whereEnd = findClauseEnd(tokens, whereAt + 1);
        whereText = sliceSql(sql, tokens, whereAt + 1, whereEnd);
        fromText = sliceSql(sql, tokens, index + 1, whereAt);
        readWhereEqualities(tokens.slice(whereAt + 1, whereEnd), whereEqualityColumns);
      }
      continue;
    }

    if (token.upper === "GROUP" && tokens[index + 1]?.upper === "BY") {
      hasGroupBy = true;
      let cursor = index + 2;
      while (cursor < tokens.length) {
        const item = tokens[cursor] as SqlToken;
        if (item.kind === "punct" && item.value === "(") { cursor = matchingParen(tokens, cursor) + 1 || tokens.length; continue; }
        if (item.kind === "identifier" || item.kind === "quoted") {
          if (KEYWORDS_ENDING_FROM.has(item.upper) || item.upper === "HAVING") break;
          const column = readColumnRef(tokens, cursor);
          if (column) { groupBy.push(column.ref); cursor = column.next; }
          else cursor += 1;
          continue;
        }
        if (item.kind === "punct" && item.value === ",") { cursor += 1; continue; }
        if (item.kind === "number") { cursor += 1; continue; }
        break;
      }
      continue;
    }

    if (token.upper === "ORDER" && tokens[index + 1]?.upper === "BY") {
      let cursor = index + 2;
      while (cursor < tokens.length) {
        const item = tokens[cursor] as SqlToken;
        if (item.kind === "punct" && item.value === "(") { cursor = matchingParen(tokens, cursor) + 1 || tokens.length; continue; }
        if (item.upper === "LIMIT" || item.upper === "OFFSET" || item.upper === "FETCH") break;
        if (item.kind === "identifier" || item.kind === "quoted") {
          const column = readColumnRef(tokens, cursor);
          if (column) {
            let direction: "asc" | "desc" = "asc";
            let next = column.next;
            if (tokens[next]?.upper === "ASC" || tokens[next]?.upper === "DESC") {
              direction = tokens[next]!.upper === "DESC" ? "desc" : "asc";
              next += 1;
            }
            if (tokens[next]?.upper === "NULLS") next += 2;
            orderBy.push({ column: column.ref.column, direction });
            cursor = next;
            continue;
          }
        }
        cursor += 1;
      }
      index = cursor - 1;
      continue;
    }

    if (token.upper === "LIMIT") {
      const value = tokens[index + 1];
      if (value?.kind === "number" && /^\d+$/.test(value.value)) limit = Number(value.value);
      continue;
    }

    if (token.kind === "identifier" && AGGREGATE_FNS.has(token.upper) && tokens[index + 1]?.value === "(") {
      const close = matchingParen(tokens, index + 1);
      if (close === -1) { unparsed.push(`${token.upper}( never closes.`); return; }
      const body = tokens.slice(index + 2, close);
      const distinct = body[0]?.upper === "DISTINCT";
      const columns: ColumnRef[] = [];
      for (let cursor = 0; cursor < body.length; cursor += 1) {
        const item = body[cursor] as SqlToken;
        if (item.kind !== "identifier" && item.kind !== "quoted") continue;
        if (AGGREGATE_FNS.has(item.upper) || item.upper === "DISTINCT" || item.upper === "CASE"
          || item.upper === "WHEN" || item.upper === "THEN" || item.upper === "ELSE" || item.upper === "END"
          || item.upper === "AND" || item.upper === "OR" || item.upper === "NOT" || item.upper === "NULL"
          || item.upper === "IS" || item.upper === "IN" || item.upper === "FILTER" || item.upper === "WHERE"
          || item.upper === "AS" || item.upper === "COALESCE" || item.upper === "NULLIF"
          || item.upper === "TRUE" || item.upper === "FALSE" || item.upper === "INTERVAL"
          || item.upper === "CAST" || item.upper === "EXTRACT" || item.upper === "ABS" || item.upper === "ROUND") continue;
        if (body[cursor + 1]?.value === "(") continue; // an inner function name
        const column = readColumnRef(body, cursor);
        if (column) { columns.push(column.ref); cursor = column.next - 1; }
      }
      const outputAlias = readOutputAlias(tokens, close);
      aggregates.push({
        fn: token.upper.toLowerCase() as AggregateCall["fn"],
        distinct,
        columns: Object.freeze(columns),
        ...(outputAlias ? { outputAlias } : {}),
      });
      index = close;
      continue;
    }
  }

  scopes.push(Object.freeze({
    name,
    relations: Object.freeze(relations),
    joinEqualities: Object.freeze(joinEqualities),
    aggregates: Object.freeze(aggregates),
    groupBy: Object.freeze(groupBy),
    whereEqualityColumns: Object.freeze(whereEqualityColumns),
    hasGroupBy,
    ...(fromText !== undefined ? { fromText } : {}),
    ...(whereText !== undefined ? { whereText } : {}),
    orderBy: Object.freeze(orderBy),
    ...(limit !== undefined ? { limit } : {}),
  }));
}

/** SELECT-list alias reached by `AS alias` after an aggregate's close paren. */
function readOutputAlias(tokens: readonly SqlToken[], closeParen: number): string | undefined {
  let cursor = closeParen + 1;
  // Skip over arithmetic continuation to find the terminal AS of this item.
  let depth = 0;
  while (cursor < tokens.length) {
    const token = tokens[cursor] as SqlToken;
    if (token.kind === "punct" && token.value === "(") depth += 1;
    if (token.kind === "punct" && token.value === ")") {
      if (depth === 0) return undefined;
      depth -= 1;
    }
    if (depth === 0) {
      if (token.kind === "punct" && token.value === ",") return undefined;
      if (token.upper === "FROM") return undefined;
      if (token.upper === "AS") {
        const alias = tokens[cursor + 1];
        return alias && (alias.kind === "identifier" || alias.kind === "quoted") ? alias.value : undefined;
      }
    }
    cursor += 1;
  }
  return undefined;
}

function findClauseEnd(tokens: readonly SqlToken[], start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index] as SqlToken;
    if (token.kind === "punct" && token.value === "(") depth += 1;
    if (token.kind === "punct" && token.value === ")") depth -= 1;
    if (depth === 0 && token.kind === "identifier" && KEYWORDS_ENDING_FROM.has(token.upper)) return index;
  }
  return tokens.length;
}

function findTopLevel(tokens: readonly SqlToken[], start: number, end: number, keyword: string): number {
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const token = tokens[index] as SqlToken;
    if (token.kind === "punct" && token.value === "(") depth += 1;
    if (token.kind === "punct" && token.value === ")") depth -= 1;
    if (depth === 0 && token.upper === keyword) return index;
  }
  return -1;
}

function sliceSql(sql: string, tokens: readonly SqlToken[], startToken: number, endToken: number): string {
  const start = tokens[startToken]?.start;
  if (start === undefined) return "";
  const endTokenValue = tokens[endToken];
  const end = endTokenValue ? endTokenValue.start : sql.length;
  return sql.slice(start, end).trim();
}

function readFromClause(
  tokens: readonly SqlToken[],
  cteNames: ReadonlySet<string>,
  relations: RelationRef[],
  joinEqualities: { left: ColumnRef; right: ColumnRef }[],
  unparsed: string[],
): void {
  let expectRelation = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as SqlToken;
    if (token.kind === "punct" && token.value === "(") {
      const close = matchingParen(tokens, index);
      if (close === -1) return;
      index = close; // derived tables were handled by the scope reader
      expectRelation = false;
      continue;
    }
    if (token.kind === "punct" && token.value === ",") { expectRelation = true; continue; }
    if (token.kind !== "identifier" && token.kind !== "quoted") continue;
    if (JOIN_INTRO.has(token.upper) || token.upper === "NATURAL" || token.upper === "OUTER") {
      expectRelation = true;
      continue;
    }
    if (token.upper === "ON") {
      const conditionEnd = nextJoinBoundary(tokens, index + 1);
      readOnEqualities(tokens.slice(index + 1, conditionEnd), joinEqualities);
      index = conditionEnd - 1;
      expectRelation = false;
      continue;
    }
    if (token.upper === "USING") {
      if (tokens[index + 1]?.value === "(") {
        const close = matchingParen(tokens, index + 1);
        for (let cursor = index + 2; cursor < close; cursor += 1) {
          const column = tokens[cursor] as SqlToken;
          if (column.kind === "identifier" || column.kind === "quoted") {
            joinEqualities.push({ left: { column: column.value }, right: { column: column.value } });
          }
        }
        index = close;
      }
      expectRelation = false;
      continue;
    }
    if (!expectRelation) continue;

    // schema.table or table or cte-name, optionally followed by an alias.
    let schema: string | undefined;
    let relationName = token.value;
    let cursor = index + 1;
    if (tokens[cursor]?.value === "." && tokens[cursor + 1]
      && ((tokens[cursor + 1] as SqlToken).kind === "identifier" || (tokens[cursor + 1] as SqlToken).kind === "quoted")) {
      schema = relationName;
      relationName = (tokens[cursor + 1] as SqlToken).value;
      cursor += 2;
    }
    let alias = relationName;
    const maybeAlias = tokens[cursor];
    if (maybeAlias?.upper === "AS") {
      const aliasToken = tokens[cursor + 1];
      if (aliasToken && (aliasToken.kind === "identifier" || aliasToken.kind === "quoted")) {
        alias = aliasToken.value;
        cursor += 2;
      }
    } else if (maybeAlias && (maybeAlias.kind === "identifier" || maybeAlias.kind === "quoted")
      && !NON_ALIAS_AFTER_RELATION.has(maybeAlias.upper)) {
      alias = maybeAlias.value;
      cursor += 1;
    }
    if (relationName === "generate_series" || tokens[cursor]?.value === "(") {
      // A set-returning function reference; not a relation this reader models.
      unparsed.push(`Function relation ${relationName} was not modelled.`);
      index = cursor;
      expectRelation = false;
      continue;
    }
    relations.push({
      ...(schema !== undefined ? { schema } : {}),
      name: relationName,
      alias,
      derived: schema === undefined && cteNames.has(relationName),
    });
    index = cursor - 1;
    expectRelation = false;
  }
}

function nextJoinBoundary(tokens: readonly SqlToken[], start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index] as SqlToken;
    if (token.kind === "punct" && token.value === "(") depth += 1;
    if (token.kind === "punct" && token.value === ")") depth -= 1;
    if (depth === 0 && token.kind === "identifier"
      && (JOIN_INTRO.has(token.upper) || token.upper === "WHERE" || token.value === ",")) return index;
    if (depth === 0 && token.kind === "punct" && token.value === ",") return index;
  }
  return tokens.length;
}

function readOnEqualities(tokens: readonly SqlToken[], joinEqualities: { left: ColumnRef; right: ColumnRef }[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as SqlToken;
    if (token.kind !== "punct" || token.value !== "=") continue;
    const left = readColumnRefBackwards(tokens, index - 1);
    const right = readColumnRef(tokens, index + 1);
    if (left && right) joinEqualities.push({ left, right: right.ref });
  }
}

function readWhereEqualities(tokens: readonly SqlToken[], columns: ColumnRef[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as SqlToken;
    if (token.kind !== "punct" || token.value !== "=") continue;
    const left = readColumnRefBackwards(tokens, index - 1);
    const right = tokens[index + 1];
    if (left && right && (right.kind === "string" || right.kind === "number")) columns.push(left);
  }
}

function readColumnRef(tokens: readonly SqlToken[], start: number): { ref: ColumnRef; next: number } | undefined {
  const first = tokens[start];
  if (!first || (first.kind !== "identifier" && first.kind !== "quoted")) return undefined;
  if (tokens[start + 1]?.value === "." ) {
    const second = tokens[start + 2];
    if (second && (second.kind === "identifier" || second.kind === "quoted")) {
      return { ref: { qualifier: first.value, column: second.value }, next: start + 3 };
    }
  }
  return { ref: { column: first.value }, next: start + 1 };
}

function readColumnRefBackwards(tokens: readonly SqlToken[], end: number): ColumnRef | undefined {
  const last = tokens[end];
  if (!last || (last.kind !== "identifier" && last.kind !== "quoted")) return undefined;
  if (tokens[end - 1]?.value === "." && tokens[end - 2]
    && ((tokens[end - 2] as SqlToken).kind === "identifier" || (tokens[end - 2] as SqlToken).kind === "quoted")) {
    return { qualifier: (tokens[end - 2] as SqlToken).value, column: last.value };
  }
  return { column: last.value };
}
