import {
  sourceQuerySchema,
  type SourceQuery,
} from "../services/semantic-query/src/index.js";

type SourceFixtureRow = Readonly<Record<string, string | number | boolean | null>>;

export function evaluateSourceFixtureQuery(
  raw: unknown,
  fixture: readonly SourceFixtureRow[],
): readonly Readonly<Record<string, string>>[] {
  const query = sourceQuerySchema.parse(raw);
  const selected = fixture.filter(
    (row) => row.connection_id === query.connectionId
      && query.filters.every((filter) => matches(row, filter)),
  );
  if (query.groupBy.length > 0) {
    throw new Error("The v1 source fixture evaluator supports ungrouped golden aggregates only.");
  }
  const result: Record<string, string> = {};
  for (const field of query.fields) result[field] = String(selected[0]?.[field] ?? "");
  for (const aggregate of query.aggregates) {
    result[aggregate.as] = evaluateAggregate(aggregate, selected);
  }
  return [result];
}

function evaluateAggregate(
  aggregate: SourceQuery["aggregates"][number],
  rows: readonly SourceFixtureRow[],
): string {
  if (aggregate.op === "count") return String(rows.length);
  if (!aggregate.field) throw new Error(`${aggregate.op} requires a field.`);
  if (aggregate.op === "count_distinct") {
    return String(new Set(rows.map((row) => row[aggregate.field as string])).size);
  }
  const numbers = rows.map((row) => Number(row[aggregate.field as string] ?? 0));
  if (numbers.some((value) => !Number.isFinite(value))) {
    throw new Error(`Fixture field ${aggregate.field} is not numeric.`);
  }
  if (numbers.length === 0) return "0";
  if (aggregate.op === "sum") return String(numbers.reduce((sum, value) => sum + value, 0));
  if (aggregate.op === "avg") {
    return String(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
  }
  return String(aggregate.op === "min" ? Math.min(...numbers) : Math.max(...numbers));
}

function matches(
  row: SourceFixtureRow,
  filter: SourceQuery["filters"][number],
): boolean {
  const current = row[filter.field];
  const expected = filter.values[0];
  if (filter.op === "is_null") return current === null || current === undefined;
  if (filter.op === "is_not_null") return current !== null && current !== undefined;
  if (filter.op === "eq") return current === expected;
  if (filter.op === "neq") return current !== expected;
  if (filter.op === "in") return filter.values.includes(current as never);
  if (filter.op === "not_in") return !filter.values.includes(current as never);
  if (filter.op === "gt") return Number(current) > Number(expected);
  if (filter.op === "gte") return Number(current) >= Number(expected);
  if (filter.op === "lt") return Number(current) < Number(expected);
  return Number(current) <= Number(expected);
}
