import {
  sourceQuerySpecSchema as sourceQuerySchema,
  type SourceQuerySpec as SourceQuery,
} from "../../../packages/agent/src/semantic-tools.js";
import { SemanticCompilerError } from "../../../packages/compiler/src/index.js";
import type { SemanticRole } from "../../../packages/semantic-registry/src/index.js";
import {
  assertSourceFieldIsAccessible,
  parseSourceAuthorityConcept,
} from "./source-access-policy.js";
import type { SourceField } from "./types.js";
export { sourceQuerySchema };
export type { SourceQuery };

export type CompiledSourceQuery = Readonly<{
  sql: string;
  parameters: readonly unknown[];
  columns: readonly string[];
  source: string;
  connectorId: string;
  packVersion: string;
  fieldDefinitions: readonly Readonly<{ field: string; definition: string }>[];
  authorityConcept?: string;
  /** Exact source-filter window; data freshness is reported separately. */
  resolvedTime: Readonly<{
    label: string;
    start: string;
    end: string;
    field?: string;
  }>;
  budget: Readonly<{ maxRows: number; estimatedCost: number }>;
}>;

const OPEN_SOURCE_TIME_START = "0001-01-01T00:00:00.000Z";
const OPEN_SOURCE_TIME_END = "9999-12-31T23:59:59.999Z";

export function compileSourceQuery(
  raw: unknown,
  tenantId: string,
  role: SemanticRole,
  catalogue: readonly SourceField[],
  maxEstimatedCost = 100,
): CompiledSourceQuery {
  const input = sourceQuerySchema.parse(raw);
  if (!catalogue.length) throw new Error("No governed source-extension fields are allowlisted for this table.");
  const identities = new Set(catalogue.map((field) => `${field.connectionId}|${field.connectorId}|${field.sourceSchema}|${field.sourceTable}`));
  if (identities.size !== 1) throw new Error("Source exploration is restricted to exactly one connection and source table.");
  const packVersions = new Set(catalogue.map((field) => field.packVersion));
  if (packVersions.size !== 1) throw new Error("Source exploration requires one active connector-pack version.");
  const first = catalogue[0] as SourceField;
  if (first.connectionId !== input.connectionId || first.sourceTable !== input.sourceTable) throw new Error("Source catalogue context mismatch.");
  const byName = new Map(catalogue.map((field) => [field.sourceField, field]));
  const requested = new Set([
    ...input.fields,...input.groupBy,...input.filters.map((filter) => filter.field),
    ...input.aggregates.flatMap((aggregate) => aggregate.field ? [aggregate.field] : []),
  ]);
  const estimatedCost = 20 + requested.size * 3 + input.aggregates.length * 5 + input.filters.length * 2 + input.groupBy.length * 3;
  if (!Number.isFinite(maxEstimatedCost) || maxEstimatedCost < 0) {
    throw new SemanticCompilerError("INVALID_IR", "Configured source query cost budget must be a finite non-negative number.", {
      maxEstimatedCost,
    });
  }
  if (estimatedCost > maxEstimatedCost) {
    throw new SemanticCompilerError(
      "QUERY_BUDGET_EXCEEDED",
      `Estimated source query cost ${estimatedCost} exceeds the ${maxEstimatedCost} cost budget.`,
      { estimatedCost, maxEstimatedCost },
    );
  }
  for (const name of requested) {
    const field = byName.get(name);
    if (!field) {
      throw new SemanticCompilerError(
        "INVALID_IR",
        `Source field ${name} is not allowlisted by the active connector pack.`,
      );
    }
    assertSourceFieldIsAccessible(field, role);
  }
  const authorityFields = requested.size
    ? [...requested].map((name) => byName.get(name) as SourceField)
    : catalogue;
  const authorityConcepts = new Set(authorityFields.map((field) => parseSourceAuthorityConcept(field.authorityConcept)));
  if (authorityConcepts.size !== 1) {
    throw new SemanticCompilerError(
      "INVALID_IR",
      "Source exploration cannot combine fields with different authority concepts.",
      { authorityConcepts: [...authorityConcepts].sort() },
    );
  }
  const authorityConcept = [...authorityConcepts][0] as string;
  const resolvedTime = resolveSourceTime(input.filters, byName);
  const params: unknown[] = [tenantId,input.connectionId];
  const add = (value: unknown): string => { params.push(value); return `$${params.length}`; };
  const selected = input.fields.map((field) => `s.${quoteIdentifier(field)} AS ${quoteIdentifier(field)}`);
  const aggregates = input.aggregates.map((aggregate) => {
    const field = aggregate.field ? `s.${quoteIdentifier(aggregate.field)}` : "*";
    if (aggregate.op !== "count" && !aggregate.field) throw new Error(`${aggregate.op} requires an allowlisted field.`);
    const rendered = aggregate.op === "count_distinct" ? `COUNT(DISTINCT ${field})` : `${aggregate.op.toUpperCase()}(${field})`;
    return `${rendered} AS ${quoteIdentifier(aggregate.as)}`;
  });
  if (!selected.length && !aggregates.length) throw new Error("Source exploration must select a field or aggregate.");
  const filters = input.filters.map((filter) => renderFilter(`s.${quoteIdentifier(filter.field)}`,filter.op,filter.values,add));
  const limit = add(input.limit);
  if (input.aggregates.length && input.fields.some((field) => !input.groupBy.includes(field))) {
    throw new SemanticCompilerError(
      "INVALID_IR",
      "Every selected source field must be grouped when aggregates are present.",
    );
  }
  const groupBy = input.groupBy.length ? `GROUP BY ${input.groupBy.map((field) => `s.${quoteIdentifier(field)}`).join(", ")}\n` : "";
  const orderFields = input.groupBy.length
    ? input.groupBy
    : input.aggregates.length ? [] : input.fields;
  const orderBy = orderFields.length
    ? `ORDER BY ${orderFields.map((field) => `s.${quoteIdentifier(field)} ASC NULLS LAST`).join(", ")}\n`
    : "";
  return {
    sql: `SELECT ${[...selected,...aggregates].join(", ")}\nFROM ${quoteIdentifier(first.sourceSchema)}.${quoteIdentifier(first.sourceTable)} s\nWHERE s.tenant_id=$1 AND s.connection_id=$2${filters.length ? `\n  AND ${filters.join("\n  AND ")}` : ""}\n${groupBy}${orderBy}LIMIT ${limit}`,
    parameters: params,
    columns: [...input.fields,...input.aggregates.map((aggregate) => aggregate.as)],
    source: `${first.connectorId}:${first.connectionId}`,
    connectorId: first.connectorId,
    packVersion: first.packVersion,
    fieldDefinitions: [...requested].map((name) => ({ field: name, definition: (byName.get(name) as SourceField).definition })),
    authorityConcept,
    resolvedTime,
    budget: { maxRows: 500, estimatedCost },
  };
}

type SourceFilter = SourceQuery["filters"][number];
type SourceTimeBound = Readonly<{ value: string; epochMs: number; inclusive: boolean }>;

function resolveSourceTime(
  filters: readonly SourceFilter[],
  fields: ReadonlyMap<string, SourceField>,
): CompiledSourceQuery["resolvedTime"] {
  const timeFilters = filters.filter((filter) => {
    const type = fields.get(filter.field)?.fieldType;
    return type === "date" || type === "timestamp";
  });
  if (!timeFilters.length) {
    return Object.freeze({
      label: "All retained source records · no source time filter",
      start: OPEN_SOURCE_TIME_START,
      end: OPEN_SOURCE_TIME_END,
    });
  }
  const timeFields = [...new Set(timeFilters.map((filter) => filter.field))];
  if (timeFields.length !== 1) {
    throw new SemanticCompilerError(
      "INVALID_IR",
      "Source exploration time provenance requires filters on exactly one date or timestamp field.",
      { timeFields: timeFields.sort() },
    );
  }
  const fieldName = timeFields[0] as string;
  const field = fields.get(fieldName) as SourceField;
  let lower: SourceTimeBound | undefined;
  let upper: SourceTimeBound | undefined;
  const labelFilters: string[] = [];

  for (const filter of timeFilters) {
    if (!["eq", "gt", "gte", "lt", "lte"].includes(filter.op) || filter.values.length !== 1) {
      throw new SemanticCompilerError(
        "INVALID_IR",
        `Source time filter ${filter.op} cannot be represented as one contiguous provenance range.`,
        { field: fieldName, operation: filter.op },
      );
    }
    const normalized = normalizeSourceTimeValue(filter.values[0], field.fieldType, fieldName);
    labelFilters.push(`${sourceTimeOperator(filter.op)} ${normalized}`);
    const candidate: SourceTimeBound = Object.freeze({
      value: normalized,
      epochMs: Date.parse(normalized),
      inclusive: filter.op === "gte" || filter.op === "lte" || filter.op === "eq",
    });
    if (filter.op === "gt" || filter.op === "gte") lower = laterLowerBound(lower, candidate);
    if (filter.op === "lt" || filter.op === "lte") upper = earlierUpperBound(upper, candidate);
    if (filter.op === "eq") {
      lower = laterLowerBound(lower, candidate);
      const equalityUpper = field.fieldType === "date"
        ? Object.freeze({
          value: shiftUtcDays(normalized, 1),
          epochMs: Date.parse(shiftUtcDays(normalized, 1)),
          inclusive: false,
        })
        : candidate;
      upper = earlierUpperBound(upper, equalityUpper);
    }
  }

  if (lower && upper && (
    lower.epochMs > upper.epochMs
    || (lower.epochMs === upper.epochMs && !(lower.inclusive && upper.inclusive))
  )) {
    throw new SemanticCompilerError(
      "INVALID_IR",
      "Source time filters resolve to an empty or inverted range.",
      { field: fieldName },
    );
  }
  return Object.freeze({
    label: `${humanizeSourceField(fieldName)} · ${labelFilters.join(" · ")}`,
    start: lower?.value ?? OPEN_SOURCE_TIME_START,
    end: upper?.value ?? OPEN_SOURCE_TIME_END,
    field: fieldName,
  });
}

function normalizeSourceTimeValue(
  value: unknown,
  fieldType: SourceField["fieldType"],
  fieldName: string,
): string {
  if (typeof value !== "string") {
    throw new SemanticCompilerError("INVALID_IR", `Source time field ${fieldName} requires a string value.`);
  }
  if (fieldType === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      throw new SemanticCompilerError("INVALID_IR", `Source date field ${fieldName} requires YYYY-MM-DD values.`);
    }
    const normalized = `${value}T00:00:00.000Z`;
    if (!Number.isFinite(Date.parse(normalized)) || new Date(normalized).toISOString().slice(0, 10) !== value) {
      throw new SemanticCompilerError("INVALID_IR", `Source date field ${fieldName} received an invalid calendar date.`);
    }
    return normalized;
  }
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new SemanticCompilerError(
      "INVALID_IR",
      `Source timestamp field ${fieldName} requires an RFC 3339 value with an explicit offset.`,
    );
  }
  return new Date(value).toISOString();
}

function laterLowerBound(current: SourceTimeBound | undefined, candidate: SourceTimeBound): SourceTimeBound {
  if (!current || candidate.epochMs > current.epochMs) return candidate;
  if (candidate.epochMs < current.epochMs) return current;
  return Object.freeze({ ...current, inclusive: current.inclusive && candidate.inclusive });
}

function earlierUpperBound(current: SourceTimeBound | undefined, candidate: SourceTimeBound): SourceTimeBound {
  if (!current || candidate.epochMs < current.epochMs) return candidate;
  if (candidate.epochMs > current.epochMs) return current;
  return Object.freeze({ ...current, inclusive: current.inclusive && candidate.inclusive });
}

function shiftUtcDays(value: string, days: number): string {
  const shifted = new Date(value);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString();
}

function sourceTimeOperator(operation: SourceFilter["op"]): string {
  return ({ eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const)[operation as "eq" | "gt" | "gte" | "lt" | "lte"];
}

function humanizeSourceField(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function renderFilter(expression: string,op:string,values:readonly unknown[],add:(value:unknown)=>string):string {
  if (op==="is_null") return `${expression} IS NULL`;
  if (op==="is_not_null") return `${expression} IS NOT NULL`;
  if ((op==="in"||op==="not_in") && !values.length) return op==="in" ? "FALSE" : "TRUE";
  if (op==="in"||op==="not_in") return `${expression} ${op==="in"?"IN":"NOT IN"} (${values.map(add).join(", ")})`;
  if (values.length!==1) throw new Error(`Source filter ${op} requires one value.`);
  const operators:Record<string,string>={eq:"=",neq:"<>",gt:">",gte:">=",lt:"<",lte:"<="};
  const operator=operators[op]; if(!operator) throw new Error(`Unsupported source filter ${op}.`);
  return `${expression} ${operator} ${add(values[0])}`;
}

function quoteIdentifier(value:string):string {
  if(!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe source identifier ${value}.`);
  return `"${value}"`;
}
