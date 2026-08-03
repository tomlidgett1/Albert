import {
  sourceQuerySpecSchema as sourceQuerySchema,
  type SourceQuerySpec as SourceQuery,
} from "../../../packages/agent/src/semantic-tools.js";
import { SemanticCompilerError } from "../../../packages/compiler/src/index.js";
import type { SemanticRole } from "../../../packages/semantic-registry/src/index.js";
import type { SourceField } from "./types.js";
export { sourceQuerySchema };
export type { SourceQuery };

export type CompiledSourceQuery = Readonly<{
  sql: string;
  parameters: readonly unknown[];
  columns: readonly string[];
  source: string;
  connectorId: string;
  fieldDefinitions: readonly Readonly<{ field: string; definition: string }>[];
  authorityConcept?: string;
  budget: Readonly<{ maxRows: number; estimatedCost: number }>;
}>;

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
    if (!field) throw new Error(`Source field ${name} is not allowlisted by the active connector pack.`);
    if (["customer_contact","payroll","sensitive_personal"].includes(field.piiClass)) throw new Error(`Source field ${name} is unavailable in exploration because of its PII classification.`);
    if (role === "bookkeeper" && field.piiClass !== "none") throw new Error(`Role ${role} cannot explore business-classified field ${name}.`);
  }
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
  const groupBy = input.groupBy.length ? `GROUP BY ${input.groupBy.map((field) => `s.${quoteIdentifier(field)}`).join(", ")}\n` : "";
  return {
    sql: `SELECT ${[...selected,...aggregates].join(", ")}\nFROM ${quoteIdentifier(first.sourceSchema)}.${quoteIdentifier(first.sourceTable)} s\nWHERE s.tenant_id=$1 AND s.connection_id=$2${filters.length ? `\n  AND ${filters.join("\n  AND ")}` : ""}\n${groupBy}LIMIT ${limit}`,
    parameters: params,
    columns: [...input.fields,...input.aggregates.map((aggregate) => aggregate.as)],
    source: `${first.connectorId}:${first.connectionId}`,
    connectorId: first.connectorId,
    fieldDefinitions: [...requested].map((name) => ({ field: name, definition: (byName.get(name) as SourceField).definition })),
    ...(input.authorityConcept ? { authorityConcept: input.authorityConcept } : {}),
    budget: { maxRows: 500, estimatedCost },
  };
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
