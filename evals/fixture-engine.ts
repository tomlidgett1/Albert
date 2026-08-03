import { Decimal4, sumDecimal4 } from "../packages/canonical-schema/src/index.js";
import type {
  Calculation,
  FilterContract,
  MetricContract,
  SemanticRegistry,
  TopicContract,
} from "../packages/semantic-registry/src/index.js";
import {
  parseSemanticQuery,
  type CompositeSemanticQuery,
  type SingleSemanticQuery,
} from "../packages/compiler/src/index.js";
import type { FixtureFactRow } from "./fixtures/retail.js";

type Value = string | number | boolean | null;
type Row = Readonly<Record<string, Value>>;
export type FixtureResultRow = Readonly<Record<string, string>>;

export type FixtureComparisonResult = Readonly<{
  current: readonly FixtureResultRow[];
  prior: readonly FixtureResultRow[];
}>;

export type FixtureEvaluationOptions = Readonly<{
  tenantParameters?: Readonly<Record<string, number>>;
}>;

const defaultTenantParameters = {
  active_customer_days: 90,
  lapsed_customer_days: 180,
  stock_velocity_days: 30,
} as const;

/**
 * Executes typed semantic IR against the deterministic fixture facts. This is
 * intentionally not a SQL interpreter: the production compiler is exercised
 * separately, while this evaluator independently checks the registry's metric
 * calculations and aggregate-then-align semantics using exact decimals.
 */
export function evaluateFixtureQuery(
  raw: unknown,
  registry: SemanticRegistry,
  fixture: readonly FixtureFactRow[],
  options: FixtureEvaluationOptions = {},
): readonly FixtureResultRow[] {
  const query = parseSemanticQuery(raw);
  return query.kind === "single"
    ? evaluateSingleQuery(query, registry, fixture, options)
    : evaluateCompositeQuery(query, registry, fixture, options);
}

export function evaluateFixtureComparison(
  raw: unknown,
  registry: SemanticRegistry,
  fixture: readonly FixtureFactRow[],
  options: FixtureEvaluationOptions = {},
): FixtureComparisonResult {
  const query = parseSemanticQuery(raw);
  if (query.kind !== "single" || query.time.compare === "none") {
    throw new Error("Fixture comparisons require single-fact IR with a comparison period.");
  }
  if (query.time.range.type !== "absolute") {
    throw new Error("Fixture comparison ranges must be absolute for clock-independent CI.");
  }
  const priorRange = shiftRange(query.time.range, query.time.compare);
  return {
    current: evaluateSingleQuery(
      { ...query, time: { ...query.time, compare: "none" } },
      registry,
      fixture,
      options,
    ),
    prior: evaluateSingleQuery(
      { ...query, time: { ...query.time, range: priorRange, compare: "none" } },
      registry,
      fixture,
      options,
    ),
  };
}

function evaluateSingleQuery(
  query: SingleSemanticQuery,
  registry: SemanticRegistry,
  fixture: readonly FixtureFactRow[],
  options: FixtureEvaluationOptions,
): readonly FixtureResultRow[] {
  const topic = requireTopic(query.topic, registry);
  const metrics = query.metrics.map((name) => resolveMetric(name, topic.metrics, registry));
  const facts = new Set(metrics.map((metric) => metric.baseFact));
  if (facts.size !== 1) throw new Error("Fixture single query requires exactly one fact.");
  const [fact] = facts;
  const rows = fixture
    .filter((row) => row.fact === fact)
    .map((row) => row.values)
    .filter((row) => inTime(row, query) && query.filters.every((filter) => matches(row, filter)));

  const groups = new Map<string, { dimensions: Record<string, string>; rows: Row[] }>();
  for (const row of rows) {
    const dimensions = Object.fromEntries(
      query.dimensions.map((dimension) => [dimension, dimensionValue(row, dimension)]),
    );
    const key = stableKey(dimensions);
    const group = groups.get(key) ?? { dimensions, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  if (query.dimensions.length === 0 && groups.size === 0) {
    groups.set("{}", { dimensions: {}, rows: [] });
  }

  const output = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => {
      const values: Record<string, string> = { ...group.dimensions };
      for (const metric of metrics) {
        const metricRows = applyTrustedMetricWindow(metric, group.rows, query, options);
        values[shortMetricName(metric.id)] = evaluateCalculation(
          metric.calculation,
          metric,
          metricRows,
          registry,
          new Set([metric.id]),
        ).toString();
      }
      return values;
    });
  sortRows(output, query.sort, registry, topic);
  return output.slice(0, query.limit);
}

function evaluateCompositeQuery(
  query: CompositeSemanticQuery,
  registry: SemanticRegistry,
  fixture: readonly FixtureFactRow[],
  options: FixtureEvaluationOptions,
): readonly FixtureResultRow[] {
  const topic = requireTopic(query.topic, registry);
  if (!topic.composite) throw new Error(`Topic ${topic.id} is not composite.`);

  const aligned = new Map<string, Record<string, string>>();
  for (const subquery of query.queries) {
    const rows = evaluateSingleQuery(
      { ...subquery, kind: "single", sort: [], limit: 1000 },
      registry,
      fixture,
      options,
    );
    for (const row of rows) {
      const dimensions = Object.fromEntries(
        query.alignOn.map((dimension) => [dimension, row[dimension] ?? ""]),
      );
      const key = stableKey(dimensions);
      const current = aligned.get(key) ?? { ...dimensions };
      for (const [field, value] of Object.entries(row)) {
        if (query.alignOn.includes(field)) continue;
        if (field in current) {
          throw new Error(`Composite fixture produced duplicate component metric ${field}.`);
        }
        current[field] = value;
      }
      aligned.set(key, current);
    }
  }

  const metrics = query.metrics.map((name) => resolveMetric(name, topic.metrics, registry));
  const componentAliases = query.queries.flatMap((subquery) => {
    const subtopic = requireTopic(subquery.topic, registry);
    return subquery.metrics.map((name) => shortMetricName(
      resolveMetric(name, subtopic.metrics, registry).id,
    ));
  });
  const output = [...aligned.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => {
      const mutable = { ...row };
      for (const alias of componentAliases) mutable[alias] ??= "0.0000";
      for (const metric of metrics) {
        mutable[shortMetricName(metric.id)] = evaluateCalculation(
          metric.calculation,
          metric,
          [mutable],
          registry,
          new Set([metric.id]),
        ).toString();
      }
      return mutable;
    });
  sortRows(output, query.sort, registry, topic);
  return output.slice(0, query.limit);
}

function evaluateCalculation(
  calculation: Calculation,
  metric: MetricContract,
  rows: readonly Row[],
  registry: SemanticRegistry,
  stack: Set<string>,
): Decimal4 {
  switch (calculation.op) {
    case "literal":
      return Decimal4.from(calculation.value);
    case "field":
      return Decimal4.from(String(rows[0]?.[calculation.field] ?? "0"));
    case "metric": {
      const dependency = registry.metrics.get(calculation.metric);
      if (!dependency || stack.has(dependency.id)) {
        throw new Error(`Invalid metric dependency ${calculation.metric}.`);
      }
      stack.add(dependency.id);
      const value = evaluateCalculation(dependency.calculation, dependency, rows, registry, stack);
      stack.delete(dependency.id);
      return value;
    }
    case "add":
      return evaluateCalculation(calculation.left, metric, rows, registry, stack)
        .add(evaluateCalculation(calculation.right, metric, rows, registry, stack));
    case "subtract":
      return evaluateCalculation(calculation.left, metric, rows, registry, stack)
        .subtract(evaluateCalculation(calculation.right, metric, rows, registry, stack));
    case "multiply":
      return evaluateCalculation(calculation.left, metric, rows, registry, stack)
        .multiply(evaluateCalculation(calculation.right, metric, rows, registry, stack));
    case "divide": {
      const denominator = evaluateCalculation(calculation.right, metric, rows, registry, stack);
      return denominator.equals("0")
        ? Decimal4.zero()
        : evaluateCalculation(calculation.left, metric, rows, registry, stack).divide(denominator);
    }
    case "conditional":
      return evaluateCalculation(
        rows[0] && matches(rows[0], calculation.condition)
          ? calculation.value
          : calculation.otherwise,
        metric,
        rows,
        registry,
        stack,
      );
    case "sum":
    case "avg":
    case "count":
    case "count_distinct":
    case "last_value":
    case "min":
    case "max": {
      const selected = rows.filter(
        (row) => metric.filters.every((filter) => matches(row, filter))
          && (!calculation.filter || matches(row, calculation.filter)),
      );
      if (calculation.op === "count") return Decimal4.from(BigInt(selected.length));
      if (calculation.op === "count_distinct") {
        const distinct = new Set(
          selected.map((row) => calculation.field
            ? String(row[calculation.field] ?? "")
            : stableKey(row)),
        );
        return Decimal4.from(BigInt(distinct.size));
      }
      if (calculation.op === "last_value") {
        const latestTime = selected
          .map((row) => String(row[metric.defaultTime] ?? ""))
          .sort()
          .at(-1);
        const latest = selected.filter(
          (row) => String(row[metric.defaultTime] ?? "") === latestTime,
        );
        return sumDecimal4(
          latest.map((row) => String(calculation.field ? row[calculation.field] ?? "0" : "0")),
        );
      }
      const values = selected.map(
        (row) => String(calculation.field ? row[calculation.field] ?? "0" : "0"),
      );
      if (values.length === 0) return Decimal4.zero();
      if (calculation.op === "sum") return sumDecimal4(values);
      if (calculation.op === "avg") return sumDecimal4(values).divide(BigInt(values.length));
      return values.map(Decimal4.from).reduce((best, value) => {
        if (calculation.op === "min") return value.compare(best) < 0 ? value : best;
        return value.compare(best) > 0 ? value : best;
      });
    }
  }
}

function matches(
  row: Row,
  filter: FilterContract | SingleSemanticQuery["filters"][number],
): boolean {
  const current = row[filter.field];
  const values = filter.values;
  switch (filter.op) {
    case "is_null": return current === null || current === undefined;
    case "is_not_null": return current !== null && current !== undefined;
    case "eq": return current === values[0];
    case "neq": return current !== values[0];
    case "in": return values.includes(current as never);
    case "not_in": return !values.includes(current as never);
    case "gt": return Number(current) > Number(values[0]);
    case "gte": return Number(current) >= Number(values[0]);
    case "lt": return Number(current) < Number(values[0]);
    case "lte": return Number(current) <= Number(values[0]);
  }
}

function inTime(row: Row, query: SingleSemanticQuery): boolean {
  if (query.time.range.type !== "absolute") return true;
  const value = Date.parse(String(row[query.time.field]));
  return value >= Date.parse(query.time.range.from) && value < Date.parse(query.time.range.to);
}

function applyTrustedMetricWindow(
  metric: MetricContract,
  rows: readonly Row[],
  query: SingleSemanticQuery,
  options: FixtureEvaluationOptions,
): readonly Row[] {
  if (metric.id !== "customers.active_customers" && metric.id !== "customers.lapsed_customers") {
    return rows;
  }
  if (query.time.range.type !== "absolute") {
    throw new Error(`Fixture window metric ${metric.id} requires an absolute range.`);
  }
  const parameter = metric.id === "customers.active_customers"
    ? "active_customer_days"
    : "lapsed_customer_days";
  const days = options.tenantParameters?.[parameter]
    ?? defaultTenantParameters[parameter];
  if (!Number.isInteger(days) || days < 1 || days > 3660) {
    throw new Error(`Invalid fixture tenant parameter ${parameter}.`);
  }
  const cutoff = new Date(query.time.range.to);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return rows.filter((row) => {
    const lastOrder = Date.parse(String(row.last_order_at ?? ""));
    if (!Number.isFinite(lastOrder)) return false;
    return metric.id === "customers.active_customers"
      ? lastOrder >= cutoff.getTime()
      : lastOrder < cutoff.getTime();
  });
}

function dimensionValue(row: Row, dimension: string): string {
  if (dimension !== "calendar_week") return String(row[dimension] ?? "");
  const value = new Date(`${String(row.business_date)}T00:00:00.000Z`);
  if (!Number.isFinite(value.getTime())) return "";
  const isoWeekday = value.getUTCDay() === 0 ? 7 : value.getUTCDay();
  value.setUTCDate(value.getUTCDate() - isoWeekday + 1);
  return value.toISOString().slice(0, 10);
}

function sortRows(
  rows: Record<string, string>[],
  sort: readonly Readonly<{ metric: string; dir: "asc" | "desc" }>[],
  registry: SemanticRegistry,
  topic: TopicContract,
): void {
  if (sort.length === 0) return;
  rows.sort((left, right) => {
    for (const item of sort) {
      const metric = resolveMetric(item.metric, topic.metrics, registry);
      const key = shortMetricName(metric.id);
      const comparison = Decimal4.from(left[key] ?? "0").compare(right[key] ?? "0");
      if (comparison !== 0) return comparison * (item.dir === "asc" ? 1 : -1);
    }
    return stableKey(left).localeCompare(stableKey(right));
  });
}

function resolveMetric(
  name: string,
  topicMetrics: readonly string[],
  registry: SemanticRegistry,
): MetricContract {
  const ids = name.includes(".")
    ? [name]
    : topicMetrics.filter((id) => shortMetricName(id) === name);
  if (ids.length !== 1) throw new Error(`Metric ${name} is unknown or ambiguous.`);
  const metric = registry.metrics.get(ids[0] as string);
  if (!metric) throw new Error(`Metric ${name} is missing.`);
  return metric;
}

function requireTopic(id: string, registry: SemanticRegistry): TopicContract {
  const topic = registry.topics.get(id);
  if (!topic) throw new Error(`Unknown topic ${id}.`);
  return topic;
}

function shiftRange(
  range: Extract<SingleSemanticQuery["time"]["range"], { type: "absolute" }>,
  compare: Exclude<SingleSemanticQuery["time"]["compare"], "none">,
): Extract<SingleSemanticQuery["time"]["range"], { type: "absolute" }> {
  const from = new Date(range.from);
  const to = new Date(range.to);
  const shift = (date: Date): Date => {
    const shifted = new Date(date);
    if (compare === "same_period_prior_week") shifted.setUTCDate(shifted.getUTCDate() - 7);
    if (compare === "same_period_prior_month") shifted.setUTCMonth(shifted.getUTCMonth() - 1);
    if (compare === "same_period_prior_year") shifted.setUTCFullYear(shifted.getUTCFullYear() - 1);
    return shifted;
  };
  return { type: "absolute", from: shift(from).toISOString(), to: shift(to).toISOString() };
}

function shortMetricName(id: string): string {
  return id.slice(id.indexOf(".") + 1);
}

function stableKey(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}
