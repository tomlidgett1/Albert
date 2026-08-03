import type {
  Calculation,
  FactModel,
  FilterContract,
  MetricContract,
  SemanticRegistry,
  SemanticRole,
  TopicContract,
} from "../../semantic-registry/src/index.js";
import { SemanticCompilerError } from "./errors.js";
import {
  normalizeTenantCalendar,
  resolveComparisonTimeRange,
  resolveTenantTimeRange,
  shiftRangeStartByDays,
  type ResolvedTimeRange,
  type TenantCalendarConfig,
} from "./calendar.js";
import {
  parseSemanticQuery,
  type CompositeSemanticQuery,
  type SingleSemanticQuery,
  type SemanticQuery,
} from "./ir.js";

export type CompilerContext = Readonly<{
  tenantId: string;
  role: SemanticRole;
  capabilities: ReadonlySet<string>;
  now: string;
  timezone: string;
  tradingDayCutoff?: string;
  fiscalYearStartMonth?: number;
  fiscalYearStartDay?: number;
  weekStartsOn?: number;
  tenantParameters?: Readonly<Record<string, string | number | boolean>>;
  maxRows?: number;
  maxEstimatedCost?: number;
}>;

export type CompiledSemanticQuery = Readonly<{
  sql: string;
  parameters: readonly unknown[];
  topic: string;
  metricIds: readonly string[];
  dimensions: readonly string[];
  resultColumns: readonly string[];
  sourceTables: readonly string[];
  resolvedTime: Readonly<{
    from: string;
    to: string;
    fromBusinessDate: string;
    toBusinessDate: string;
    compare: string;
    comparisonFrom?: string;
    comparisonTo?: string;
    comparisonFromBusinessDate?: string;
    comparisonToBusinessDate?: string;
  }>;
  warnings: readonly string[];
  budget: Readonly<{ maxRows: number; estimatedCost: number }>;
}>;

type RenderedSingle = Readonly<{
  sql: string;
  metricIds: readonly string[];
  metricAliases: ReadonlyMap<string, string>;
  dimensions: readonly string[];
  hiddenKeys: readonly string[];
  table: string;
  requestedTime: ResolvedTimeRange;
  resolvedTime: CompiledSemanticQuery["resolvedTime"];
}>;

type RenderedCompositePlan = Readonly<{
  sql: string;
  metricIds: readonly string[];
  metricAliases: ReadonlyMap<string, string>;
  resultMetricAliases: readonly string[];
}>;

type IdentityResolutionJoin = Readonly<{
  factKey: string;
  identityType: NonNullable<FactModel["joins"][number]["identityType"]>;
  alias: string;
}>;

class ParameterBuilder {
  readonly values: unknown[];
  constructor(tenantId: string) {
    this.values = [tenantId];
  }
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export function compileSemanticQuery(
  rawInput: unknown,
  registry: SemanticRegistry,
  context: CompilerContext,
): CompiledSemanticQuery {
  let query: SemanticQuery;
  try {
    query = parseSemanticQuery(rawInput);
  } catch (error) {
    throw new SemanticCompilerError("INVALID_IR", "Semantic query IR is invalid.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!context.tenantId) throw new SemanticCompilerError("INVALID_IR", "Trusted tenant context is required.");
  const topic = requireTopic(registry, query.topic);
  checkRole(topic, context.role);
  checkCapabilities(topic.requiredCapabilities, context.capabilities, topic.id);

  const maxRows = Math.min(context.maxRows ?? 1000, 1000);
  if (query.limit > maxRows) {
    throw new SemanticCompilerError("QUERY_BUDGET_EXCEEDED", `Requested ${query.limit} rows exceeds the ${maxRows} row budget.`, { requestedRows: query.limit, maxRows });
  }

  const params = new ParameterBuilder(context.tenantId);
  if (query.kind === "composite") {
    return enforceCostBudget(compileComposite(query, topic, registry, context, params, maxRows), context.maxEstimatedCost);
  }
  if (topic.composite) {
    throw new SemanticCompilerError("COMPOSITE_REQUIRED", `Topic ${topic.id} requires aggregate-then-align composite IR.`);
  }
  const rendered = renderSingle(query, topic, registry, context, params, true);
  if (query.time.compare !== "none") {
    const calendar = calendarForContext(context);
    const priorRange = resolveComparisonTimeRange(rendered.requestedTime, query.time.compare, calendar);
    const priorQuery: SingleSemanticQuery = {
      ...query,
      time: {
        field: query.time.field,
        range: { type: "absolute", from: priorRange.from, to: priorRange.to },
        compare: "none",
      },
    };
    const prior = renderSingle(priorQuery, topic, registry, context, params, false);
    const dimensionSelects = query.dimensions.map((dimension) =>
      `COALESCE(current_period.${quoteIdentifier(dimension)}, comparison_period.${quoteIdentifier(dimension)}) AS ${quoteIdentifier(dimension)}`,
    );
    const metricSelects = [...rendered.metricAliases.values()].flatMap((alias) => {
      const current = `COALESCE(current_period.${quoteIdentifier(alias)}, 0)`;
      const comparison = `COALESCE(comparison_period.${quoteIdentifier(alias)}, 0)`;
      return [
        `${current} AS ${quoteIdentifier(alias)}`,
        `${comparison} AS ${quoteIdentifier(`${alias}__comparison`)}`,
        `(${current} - ${comparison}) AS ${quoteIdentifier(`${alias}__change`)}`,
        `CASE WHEN ${comparison} = 0 THEN NULL ELSE ((${current} - ${comparison}) * 100 / ${comparison}) END AS ${quoteIdentifier(`${alias}__change_pct`)}`,
      ];
    });
    const alignment = query.dimensions.length
      ? query.dimensions.map((dimension) =>
        `current_period.${quoteIdentifier(`__key_${dimension}`)} IS NOT DISTINCT FROM comparison_period.${quoteIdentifier(`__key_${dimension}`)}`,
      ).join(" AND ")
      : "TRUE";
    const limitParameter = params.add(query.limit);
    const sql = `WITH current_period AS (\n${indent(rendered.sql)}\n),\ncomparison_period AS (\n${indent(prior.sql)}\n)\nSELECT\n  ${[...dimensionSelects, ...metricSelects].join(",\n  ")}\nFROM current_period\nFULL OUTER JOIN comparison_period ON ${alignment}\n${renderSort(query.sort, rendered.metricAliases)}LIMIT ${limitParameter}`;
    const comparisonColumns = [...rendered.metricAliases.values()].flatMap((alias) => [
      alias, `${alias}__comparison`, `${alias}__change`, `${alias}__change_pct`,
    ]);
    const resolvedTime = {
      ...rendered.resolvedTime,
      compare: query.time.compare,
      comparisonFrom: prior.resolvedTime.from,
      comparisonTo: prior.resolvedTime.to,
      comparisonFromBusinessDate: prior.resolvedTime.fromBusinessDate,
      comparisonToBusinessDate: prior.resolvedTime.toBusinessDate,
    };
    return enforceCostBudget({
      sql,
      parameters: params.values,
      topic: topic.id,
      metricIds: rendered.metricIds,
      dimensions: rendered.dimensions,
      resultColumns: [...rendered.dimensions, ...comparisonColumns],
      sourceTables: [rendered.table],
      resolvedTime,
      warnings: timeWarnings(resolvedTime),
      budget: { maxRows, estimatedCost: estimateCost(query.metrics.length, query.dimensions.length, 2) },
    }, context.maxEstimatedCost);
  }
  const limitParameter = params.add(query.limit);
  const sql = `${rendered.sql}\n${renderSort(query.sort, rendered.metricAliases)}LIMIT ${limitParameter}`;
  return enforceCostBudget({
    sql,
    parameters: params.values,
    topic: topic.id,
    metricIds: rendered.metricIds,
    dimensions: rendered.dimensions,
    resultColumns: [...rendered.dimensions, ...rendered.metricAliases.values()],
    sourceTables: [rendered.table],
    resolvedTime: rendered.resolvedTime,
    warnings: timeWarnings(rendered.resolvedTime),
    budget: { maxRows, estimatedCost: estimateCost(query.metrics.length, query.dimensions.length, 1) },
  }, context.maxEstimatedCost);
}

function enforceCostBudget(
  compiled: CompiledSemanticQuery,
  configuredMaximum: number | undefined,
): CompiledSemanticQuery {
  if (configuredMaximum === undefined) return compiled;
  if (!Number.isFinite(configuredMaximum) || configuredMaximum < 0) {
    throw new SemanticCompilerError("INVALID_IR", "Configured semantic query cost budget must be a finite non-negative number.", {
      maxEstimatedCost: configuredMaximum,
    });
  }
  if (compiled.budget.estimatedCost > configuredMaximum) {
    throw new SemanticCompilerError(
      "QUERY_BUDGET_EXCEEDED",
      `Estimated query cost ${compiled.budget.estimatedCost} exceeds the ${configuredMaximum} cost budget.`,
      { estimatedCost: compiled.budget.estimatedCost, maxEstimatedCost: configuredMaximum },
    );
  }
  return compiled;
}

function compileComposite(
  query: CompositeSemanticQuery,
  topic: TopicContract,
  registry: SemanticRegistry,
  context: CompilerContext,
  params: ParameterBuilder,
  maxRows: number,
): CompiledSemanticQuery {
  if (!topic.composite) {
    throw new SemanticCompilerError("INVALID_IR", `Topic ${topic.id} is not a composite topic.`);
  }
  if (!sameSet(query.alignOn, topic.alignOn.filter((dimension) => query.alignOn.includes(dimension)))) {
    const illegal = query.alignOn.filter((dimension) => !topic.alignOn.includes(dimension));
    if (illegal.length > 0) throw new SemanticCompilerError("INVALID_ALIGNMENT", `Unsupported alignment dimensions: ${illegal.join(", ")}.`, { allowed: topic.alignOn });
  }

  if (new Set(query.alignOn).size !== query.alignOn.length) {
    throw new SemanticCompilerError("INVALID_ALIGNMENT", "Composite alignment dimensions must be unique.");
  }
  const compareModes = new Set(query.queries.map((subquery) => subquery.time.compare));
  if (compareModes.size !== 1) {
    throw new SemanticCompilerError("INVALID_ALIGNMENT", "Every composite subquery must use the same prior-period comparison mode.", {
      compareModes: [...compareModes],
    });
  }
  const compareMode = query.queries[0]?.time.compare ?? "none";

  const rendered = query.queries.map((subquery, index) => {
    if (!sameSet(subquery.dimensions, query.alignOn) || new Set(subquery.dimensions).size !== subquery.dimensions.length) {
      throw new SemanticCompilerError("INVALID_ALIGNMENT", `Subquery ${index + 1} dimensions must exactly match the unique alignment dimensions.`, {
        expected: query.alignOn,
        received: subquery.dimensions,
      });
    }
    const subtopic = requireTopic(registry, subquery.topic);
    if (subtopic.composite) throw new SemanticCompilerError("INVALID_ALIGNMENT", "Composite subqueries must be single-fact Topics.");
    checkRole(subtopic, context.role);
    checkCapabilities(subtopic.requiredCapabilities, context.capabilities, subtopic.id);
    return renderSingle({ ...subquery, kind: "single", sort: [], limit: maxRows }, subtopic, registry, context, params, false);
  });
  if (new Set(rendered.map((item) => item.table)).size !== rendered.length) {
    throw new SemanticCompilerError("INVALID_ALIGNMENT", "Each composite subquery must aggregate a distinct fact set.");
  }
  assertAlignedRequestedTimes(rendered);
  const compositeMetrics = resolveMetrics(query.metrics, topic, registry);
  const currentPlan = renderCompositePlan(rendered, query.alignOn, compositeMetrics, registry, "q");
  const resolvedTime = rendered[0]?.resolvedTime ?? {
    from: context.now,
    to: context.now,
    fromBusinessDate: context.now.slice(0,10),
    toBusinessDate: context.now.slice(0,10),
    compare: "none",
  };

  if (compareMode !== "none") {
    const calendar = calendarForContext(context);
    const priorRendered = query.queries.map((subquery, index) => {
      const current = rendered[index];
      if (!current) throw new SemanticCompilerError("INVALID_ALIGNMENT", `Missing current composite subquery ${index + 1}.`);
      const priorRange = resolveComparisonTimeRange(current.requestedTime, compareMode, calendar);
      const priorQuery: SingleSemanticQuery = {
        ...subquery,
        kind: "single",
        sort: [],
        limit: maxRows,
        time: {
          field: subquery.time.field,
          range: { type: "absolute", from: priorRange.from, to: priorRange.to },
          compare: "none",
        },
      };
      const subtopic = requireTopic(registry, subquery.topic);
      return renderSingle(priorQuery, subtopic, registry, context, params, false);
    });
    assertAlignedRequestedTimes(priorRendered);
    const priorPlan = renderCompositePlan(priorRendered, query.alignOn, compositeMetrics, registry, "p");
    const dimensionSelects = query.alignOn.map((dimension) =>
      `COALESCE(current_composite.${quoteIdentifier(dimension)}, comparison_composite.${quoteIdentifier(dimension)}) AS ${quoteIdentifier(dimension)}`,
    );
    const metricSelects = [...currentPlan.metricAliases.entries()].flatMap(([, alias]) => {
      const current = `COALESCE(current_composite.${quoteIdentifier(alias)}, 0)`;
      const comparison = `COALESCE(comparison_composite.${quoteIdentifier(alias)}, 0)`;
      return [
        `${current} AS ${quoteIdentifier(alias)}`,
        `${comparison} AS ${quoteIdentifier(`${alias}__comparison`)}`,
        `(${current} - ${comparison}) AS ${quoteIdentifier(`${alias}__change`)}`,
        `CASE WHEN ${comparison} = 0 THEN NULL ELSE ((${current} - ${comparison}) * 100 / ${comparison}) END AS ${quoteIdentifier(`${alias}__change_pct`)}`,
      ];
    });
    const alignment = query.alignOn.map((dimension) =>
      `current_composite.${quoteIdentifier(`__key_${dimension}`)} IS NOT DISTINCT FROM comparison_composite.${quoteIdentifier(`__key_${dimension}`)}`,
    ).join(" AND ");
    const limitParameter = params.add(query.limit);
    const sql = `WITH current_composite AS (\n${indent(currentPlan.sql)}\n),\ncomparison_composite AS (\n${indent(priorPlan.sql)}\n)\nSELECT\n  ${[...dimensionSelects, ...metricSelects].join(",\n  ")}\nFROM current_composite\nFULL OUTER JOIN comparison_composite ON ${alignment}\n${renderSort(query.sort, currentPlan.metricAliases)}LIMIT ${limitParameter}`;
    const comparisonColumns = currentPlan.resultMetricAliases.flatMap((alias) => [
      alias, `${alias}__comparison`, `${alias}__change`, `${alias}__change_pct`,
    ]);
    const priorTime = priorRendered[0]?.resolvedTime;
    const comparedTime = {
      ...resolvedTime,
      compare: compareMode,
      comparisonFrom: priorTime?.from,
      comparisonTo: priorTime?.to,
      comparisonFromBusinessDate: priorTime?.fromBusinessDate,
      comparisonToBusinessDate: priorTime?.toBusinessDate,
    };
    return {
      sql,
      parameters: params.values,
      topic: topic.id,
      metricIds: currentPlan.metricIds,
      dimensions: query.alignOn,
      resultColumns: [...query.alignOn, ...comparisonColumns],
      sourceTables: rendered.map((item) => item.table),
      resolvedTime: comparedTime,
      warnings: [...new Set([...rendered, ...priorRendered].flatMap((item) => timeWarnings(item.resolvedTime)))],
      budget: { maxRows, estimatedCost: estimateCost(query.metrics.length + currentPlan.metricIds.length, query.alignOn.length, rendered.length * 2) },
    };
  }

  const limitParameter = params.add(query.limit);
  const sql = `${currentPlan.sql}\n${renderSort(query.sort, currentPlan.metricAliases)}LIMIT ${limitParameter}`;
  return {
    sql,
    parameters: params.values,
    topic: topic.id,
    metricIds: currentPlan.metricIds,
    dimensions: query.alignOn,
    resultColumns: [...query.alignOn, ...currentPlan.resultMetricAliases],
    sourceTables: rendered.map((item) => item.table),
    resolvedTime,
    warnings: [...new Set(rendered.flatMap((item) => timeWarnings(item.resolvedTime)))],
    budget: { maxRows, estimatedCost: estimateCost(query.metrics.length + currentPlan.metricIds.length, query.alignOn.length, rendered.length) },
  };
}

function renderCompositePlan(
  rendered: readonly RenderedSingle[],
  alignOn: readonly string[],
  compositeMetrics: readonly MetricContract[],
  registry: SemanticRegistry,
  prefix: string,
): RenderedCompositePlan {
  const metricAliases = new Map<string, string>();
  const usedAliases = new Set<string>();
  const componentByField = new Map<string, string>();
  rendered.forEach((item, index) => {
    for (const [id, alias] of item.metricAliases) {
      if (metricAliases.has(id) || usedAliases.has(alias)) {
        throw new SemanticCompilerError("INVALID_ALIGNMENT", `Composite subqueries expose duplicate component metric ${alias}.`);
      }
      metricAliases.set(id, alias);
      usedAliases.add(alias);
      componentByField.set(alias, `${prefix}${index}.${quoteIdentifier(alias)}`);
    }
  });

  const compositeSelects = compositeMetrics.map((metric) => {
    const alias = shortMetricName(metric.id);
    if (metricAliases.has(metric.id) || usedAliases.has(alias)) {
      throw new SemanticCompilerError("INVALID_ALIGNMENT", `Composite metric alias ${alias} collides with a component metric.`);
    }
    metricAliases.set(metric.id, alias);
    usedAliases.add(alias);
    return `${renderAlignedCalculation(metric.calculation, componentByField, registry, new Set([metric.id]))} AS ${quoteIdentifier(alias)}`;
  });
  const keySelects = alignOn.flatMap((dimension) => {
    const hidden = rendered.map((_, index) => `${prefix}${index}.${quoteIdentifier(`__key_${dimension}`)}`);
    const visible = rendered.map((_, index) => `${prefix}${index}.${quoteIdentifier(dimension)}`);
    return [
      `COALESCE(${hidden.join(", ")}) AS ${quoteIdentifier(`__key_${dimension}`)}`,
      `COALESCE(${visible.join(", ")}) AS ${quoteIdentifier(dimension)}`,
    ];
  });
  const componentSelects = [...componentByField.entries()].map(([alias, expression]) =>
    `${expression} AS ${quoteIdentifier(alias)}`,
  );
  const ctes = rendered.map((item, index) => `${prefix}${index} AS (\n${indent(item.sql)}\n)`).join(",\n");
  let from = `${prefix}0`;
  for (let index = 1; index < rendered.length; index += 1) {
    const joins = alignOn.map((dimension) => {
      const previous = Array.from({ length: index }, (_, prior) =>
        `${prefix}${prior}.${quoteIdentifier(`__key_${dimension}`)}`,
      );
      return `${prefix}${index}.${quoteIdentifier(`__key_${dimension}`)} IS NOT DISTINCT FROM COALESCE(${previous.join(", ")})`;
    });
    from += `\nFULL OUTER JOIN ${prefix}${index} ON ${joins.join(" AND ")}`;
  }
  return {
    sql: `WITH ${ctes}\nSELECT\n  ${[...keySelects, ...componentSelects, ...compositeSelects].join(",\n  ")}\nFROM ${from}`,
    metricIds: [...metricAliases.keys()],
    metricAliases,
    resultMetricAliases: [...componentByField.keys(), ...compositeMetrics.map((metric) => shortMetricName(metric.id))],
  };
}

function assertAlignedRequestedTimes(rendered: readonly RenderedSingle[]): void {
  const first = rendered[0]?.requestedTime;
  if (!first) throw new SemanticCompilerError("INVALID_ALIGNMENT", "A composite query requires at least one rendered subquery.");
  for (const item of rendered.slice(1)) {
    if (
      item.requestedTime.from !== first.from || item.requestedTime.to !== first.to ||
      item.requestedTime.fromBusinessDate !== first.fromBusinessDate ||
      item.requestedTime.toBusinessDate !== first.toBusinessDate
    ) {
      throw new SemanticCompilerError("INVALID_ALIGNMENT", "Composite subqueries must resolve to the same tenant business period.", {
        expected: first,
        received: item.requestedTime,
      });
    }
  }
}

function renderSingle(
  query: SingleSemanticQuery,
  topic: TopicContract,
  registry: SemanticRegistry,
  context: CompilerContext,
  params: ParameterBuilder,
  includeSort: boolean,
): RenderedSingle {
  const metrics = resolveMetrics(query.metrics, topic, registry);
  const factIds = new Set(metrics.map((metric) => metric.baseFact));
  if (factIds.size !== 1) {
    throw new SemanticCompilerError("CROSS_FACT_QUERY", "A single query cannot select metrics from multiple facts; use aggregate-then-align composite IR.", { facts: [...factIds] });
  }
  const factId = [...factIds][0];
  const fact = factId ? registry.facts.get(factId) : undefined;
  if (!fact) throw new SemanticCompilerError("UNKNOWN_METRIC", `No fact model for ${String(factId)}.`);
  const reservedParameters = new Set(metrics.flatMap((metric) => metric.tenantParameters));
  for (const key of Object.keys(query.parameters)) {
    if (reservedParameters.has(key)) {
      throw new SemanticCompilerError("INVALID_PARAMETER", `Model input cannot override trusted tenant parameter ${key}.`);
    }
  }
  for (const metric of metrics) {
    checkCapabilities(metric.requiredCapabilities, context.capabilities, metric.id);
    validateTenantParameters(metric, context.tenantParameters ?? {});
  }
  validateDimensions(query.dimensions, topic, metrics, fact);
  if (!fact.timeFields.includes(query.time.field)) {
    throw new SemanticCompilerError("INVALID_TIME_FIELD", `${query.time.field} is not a time role on ${fact.id}.`, { allowed: fact.timeFields });
  }
  assertNoSnapshotSums(metrics, fact);

  const calendar = calendarForContext(context);
  const requestedRange = resolveTenantTimeRange(query.time.range, context.now, calendar);
  const range = applyTenantMetricWindow(requestedRange, metrics, context, calendar);
  const hasLapsedAsOfMetric = metrics.some((metric) => metric.id === "customers.lapsed_customers");
  const needsLowerTimeBound = !hasLapsedAsOfMetric || metrics.some((metric) => metric.id !== "customers.lapsed_customers");
  const timeValues = timeParameterValues(query.time.field, range);
  const lowerTimeParameter = needsLowerTimeBound ? params.add(timeValues.from) : undefined;
  const toParameter = params.add(timeValues.to);
  // Snapshot calculations never share a fact with the lapse metric, so the
  // upper-bound parameter is only a type-safe placeholder in the lapsed-only
  // path and is never used as a snapshot lower bound.
  const fromParameter = lowerTimeParameter ?? toParameter;
  const identityJoins = resolveIdentityResolutionJoins(fact, "identity");

  const joins = query.dimensions
    .filter((dimension) => dimension !== "business_date" && dimension !== "calendar_week")
    .map((dimension, index) => resolveJoin(dimension, fact, index));
  const dimensionSelects: string[] = [];
  const groupBy: string[] = [];
  const hiddenKeys: string[] = [];
  for (const item of joins) {
    const keyAlias = `__key_${item.dimension}`;
    const keyExpression = resolvedFactField(item.join.factKey, identityJoins, "f");
    dimensionSelects.push(`${keyExpression} AS ${quoteIdentifier(keyAlias)}`);
    dimensionSelects.push(`${item.alias}.${quoteIdentifier(item.displayField)} AS ${quoteIdentifier(item.dimension)}`);
    groupBy.push(keyExpression, `${item.alias}.${quoteIdentifier(item.displayField)}`);
    hiddenKeys.push(keyAlias);
  }
  if (query.dimensions.includes("business_date") && !joins.some((item) => item.dimension === "business_date")) {
    dimensionSelects.push(`f.${quoteIdentifier("business_date")} AS ${quoteIdentifier("business_date")}`);
    groupBy.push(`f.${quoteIdentifier("business_date")}`);
    hiddenKeys.push("__key_business_date");
    dimensionSelects.push(`f.${quoteIdentifier("business_date")} AS ${quoteIdentifier("__key_business_date")}`);
  }
  if (query.dimensions.includes("calendar_week")) {
    const expression = calendarWeekExpression("f");
    dimensionSelects.push(`${expression} AS ${quoteIdentifier("calendar_week")}`);
    dimensionSelects.push(`${expression} AS ${quoteIdentifier("__key_calendar_week")}`);
    groupBy.push(expression);
    hiddenKeys.push("__key_calendar_week");
  }

  const metricAliases = new Map<string, string>();
  const metricSelects = metrics.map((metric) => {
    const alias = shortMetricName(metric.id);
    metricAliases.set(metric.id, alias);
    const metricTimePredicates = hasLapsedAsOfMetric && metric.id !== "customers.lapsed_customers"
      ? [
        `f.${quoteIdentifier(query.time.field)} >= ${fromParameter}`,
        `f.${quoteIdentifier(query.time.field)} < ${toParameter}`,
      ]
      : [];
    const trustedPredicates = [
      ...trustedMetricPredicates(metric, context, range, calendar, params),
      ...metricTimePredicates,
    ];
    return `${renderCalculation(
      metric.calculation,
      metric.filters,
      fact,
      registry,
      params,
      new Set([metric.id]),
      `f.${quoteIdentifier(metric.defaultTime)}`,
      trustedPredicates,
      { fromParameter, toParameter },
      identityJoins,
    )} AS ${quoteIdentifier(alias)}`;
  });
  const where = [
    `f.${quoteIdentifier("tenant_id")} = $1`,
    // Lapse is an as-of population: eligible customers necessarily precede
    // the cutoff, so a reporting-period lower bound would make the metric
    // impossible. Other selected metrics retain that lower bound locally.
    ...(hasLapsedAsOfMetric ? [] : [`f.${quoteIdentifier(query.time.field)} >= ${fromParameter}`]),
    `f.${quoteIdentifier(query.time.field)} < ${toParameter}`,
    ...query.filters.map((filter) => renderUserFilter(filter, topic, fact, params, identityJoins)),
  ];
  const identityJoinSql = renderIdentityResolutionJoins(identityJoins, "f");
  const dimensionJoinSql = joins.map((item) => `LEFT JOIN ${quoteQualified(item.join.table)} ${item.alias} ON ${item.alias}.${quoteIdentifier("tenant_id")} = f.${quoteIdentifier("tenant_id")} AND ${item.alias}.${quoteIdentifier(item.join.dimensionKey)} = ${resolvedFactField(item.join.factKey, identityJoins, "f")}`).join("\n");
  const joinSql = [identityJoinSql, dimensionJoinSql].filter(Boolean).join("\n");
  const sql = `SELECT\n  ${[...dimensionSelects, ...metricSelects].join(",\n  ")}\nFROM ${quoteQualified(fact.table)} f${joinSql ? `\n${joinSql}` : ""}\nWHERE ${where.join("\n  AND ")}\n${groupBy.length ? `GROUP BY ${groupBy.join(", ")}\n` : ""}${includeSort ? "" : ""}`;
  return {
    sql,
    metricIds: metrics.map((metric) => metric.id),
    metricAliases,
    dimensions: query.dimensions,
    hiddenKeys,
    table: fact.table,
    requestedTime: requestedRange,
    resolvedTime: { ...range, compare: query.time.compare },
  };
}

function renderCalculation(
  calculation: Calculation,
  metricFilters: readonly FilterContract[],
  fact: FactModel,
  registry: SemanticRegistry,
  params: ParameterBuilder,
  stack: Set<string>,
  orderByField: string,
  trustedPredicates: readonly string[],
  snapshotRange: Readonly<{ fromParameter: string; toParameter: string }>,
  identityJoins: readonly IdentityResolutionJoin[],
): string {
  switch (calculation.op) {
    case "field": return resolvedFactField(calculation.field, identityJoins, "f");
    case "literal": {
      if (!/^-?\d+(?:\.\d{1,4})?$/.test(calculation.value)) throw new SemanticCompilerError("INVALID_PARAMETER", "Registry literal is not an exact decimal.");
      return `CAST(${params.add(calculation.value)} AS numeric)`;
    }
    case "metric": {
      const dependency = registry.metrics.get(calculation.metric);
      if (!dependency || dependency.baseFact !== fact.id) throw new SemanticCompilerError("CROSS_FACT_QUERY", `Metric dependency ${calculation.metric} crosses facts.`);
      if (stack.has(dependency.id)) throw new SemanticCompilerError("INVALID_IR", `Metric dependency cycle at ${dependency.id}.`);
      stack.add(dependency.id);
      const rendered = renderCalculation(dependency.calculation, dependency.filters, fact, registry, params, stack, `f.${quoteIdentifier(dependency.defaultTime)}`, trustedPredicates, snapshotRange, identityJoins);
      stack.delete(dependency.id);
      return rendered;
    }
    case "add": return `(${renderCalculation(calculation.left, metricFilters, fact, registry, params, stack, orderByField, trustedPredicates, snapshotRange, identityJoins)} + ${renderCalculation(calculation.right, metricFilters, fact, registry, params, stack, orderByField, trustedPredicates, snapshotRange, identityJoins)})`;
    case "subtract": return `(${renderCalculation(calculation.left, metricFilters, fact, registry, params, stack, orderByField, trustedPredicates, snapshotRange, identityJoins)} - ${renderCalculation(calculation.right, metricFilters, fact, registry, params, stack, orderByField, trustedPredicates, snapshotRange, identityJoins)})`;
    case "multiply": return `(${renderCalculation(calculation.left, metricFilters, fact, registry, params, stack, orderByField, trustedPredicates, snapshotRange, identityJoins)} * ${renderCalculation(calculation.right, metricFilters, fact, registry, params, stack, orderByField, trustedPredicates, snapshotRange, identityJoins)})`;
    case "divide": return `(${renderCalculation(calculation.left, metricFilters, fact, registry, params, stack, orderByField, trustedPredicates, snapshotRange, identityJoins)} / NULLIF(${renderCalculation(calculation.right, metricFilters, fact, registry, params, stack, orderByField, trustedPredicates, snapshotRange, identityJoins)}, 0))`;
    case "conditional": return `(CASE WHEN ${renderContractFilter(calculation.condition, params, identityJoins)} THEN ${renderCalculation(calculation.value, metricFilters, fact, registry, params, stack, orderByField, trustedPredicates, snapshotRange, identityJoins)} ELSE ${renderCalculation(calculation.otherwise, metricFilters, fact, registry, params, stack, orderByField, trustedPredicates, snapshotRange, identityJoins)} END)`;
    case "sum":
    case "avg":
    case "count":
    case "count_distinct":
    case "last_value":
    case "min":
    case "max": {
      const filters = [...metricFilters, ...(calculation.filter ? [calculation.filter] : [])];
      const predicates = [...filters.map((filter) => renderContractFilter(filter, params, identityJoins)), ...trustedPredicates];
      const filterSql = predicates.length ? ` FILTER (WHERE ${predicates.join(" AND ")})` : "";
      const field = calculation.field ? resolvedFactField(calculation.field, identityJoins, "f") : "*";
      if (calculation.op === "last_value") {
        if (!calculation.field || fact.snapshotEntityKeys.length === 0) {
          throw new SemanticCompilerError("SNAPSHOT_SUM_FORBIDDEN", `last_value on ${fact.id} requires declared snapshot entity keys.`);
        }
        const latestAlias = "snapshot_latest";
        const timeFieldMatch = /^f\."([a-z_][a-z0-9_]*)"$/.exec(orderByField);
        if (!timeFieldMatch) throw new SemanticCompilerError("INVALID_TIME_FIELD", `Invalid snapshot time field ${orderByField}.`);
        const timeField = timeFieldMatch[1] as string;
        const latestIdentityJoins = resolveIdentityResolutionJoins(fact, "snapshot_identity");
        const correlations = fact.snapshotEntityKeys.map((key) =>
          `${resolvedFactField(key, latestIdentityJoins, latestAlias)} IS NOT DISTINCT FROM ${resolvedFactField(key, identityJoins, "f")}`,
        );
        const latestJoinSql = renderIdentityResolutionJoins(latestIdentityJoins, latestAlias);
        const latest = `(SELECT MAX(${latestAlias}.${quoteIdentifier(timeField)}) FROM ${quoteQualified(fact.table)} ${latestAlias}${latestJoinSql ? ` ${latestJoinSql}` : ""} WHERE ${latestAlias}.${quoteIdentifier("tenant_id")} = f.${quoteIdentifier("tenant_id")} AND ${correlations.join(" AND ")} AND ${latestAlias}.${quoteIdentifier(timeField)} >= ${snapshotRange.fromParameter} AND ${latestAlias}.${quoteIdentifier(timeField)} < ${snapshotRange.toParameter})`;
        const latestPredicates = [...predicates, `${orderByField} = ${latest}`];
        return `SUM(${field}) FILTER (WHERE ${latestPredicates.join(" AND ")})`;
      }
      if (calculation.op === "count_distinct") return `COUNT(DISTINCT ${field})${filterSql}`;
      const operator = calculation.op.toUpperCase();
      return `${operator}(${calculation.distinct ? "DISTINCT " : ""}${field})${filterSql}`;
    }
  }
}

function renderAlignedCalculation(
  calculation: Calculation,
  fields: ReadonlyMap<string, string>,
  registry: SemanticRegistry,
  stack: Set<string>,
): string {
  switch (calculation.op) {
    case "field": {
      const expression = fields.get(calculation.field);
      if (!expression) throw new SemanticCompilerError("INVALID_ALIGNMENT", `Composite calculation requires missing component ${calculation.field}.`);
      return `COALESCE(${expression}, 0)`;
    }
    case "literal": return `CAST('${calculation.value}' AS numeric)`;
    case "sum":
    case "avg":
    case "min":
    case "max":
    case "last_value":
    case "count":
    case "count_distinct": {
      if (!calculation.field) throw new SemanticCompilerError("INVALID_ALIGNMENT", "Composite aggregate requires a field.");
      const expression = fields.get(calculation.field);
      if (!expression) throw new SemanticCompilerError("INVALID_ALIGNMENT", `Composite calculation requires missing component ${calculation.field}.`);
      return `COALESCE(${expression}, 0)`;
    }
    case "metric": {
      const dependency = registry.metrics.get(calculation.metric);
      if (!dependency || stack.has(dependency.id)) throw new SemanticCompilerError("INVALID_ALIGNMENT", `Invalid composite dependency ${calculation.metric}.`);
      stack.add(dependency.id);
      const result = renderAlignedCalculation(dependency.calculation, fields, registry, stack);
      stack.delete(dependency.id);
      return result;
    }
    case "add": return `(${renderAlignedCalculation(calculation.left, fields, registry, stack)} + ${renderAlignedCalculation(calculation.right, fields, registry, stack)})`;
    case "subtract": return `(${renderAlignedCalculation(calculation.left, fields, registry, stack)} - ${renderAlignedCalculation(calculation.right, fields, registry, stack)})`;
    case "multiply": return `(${renderAlignedCalculation(calculation.left, fields, registry, stack)} * ${renderAlignedCalculation(calculation.right, fields, registry, stack)})`;
    case "divide": return `(${renderAlignedCalculation(calculation.left, fields, registry, stack)} / NULLIF(${renderAlignedCalculation(calculation.right, fields, registry, stack)}, 0))`;
    case "conditional": throw new SemanticCompilerError("INVALID_ALIGNMENT", "Conditional composite calculations are not supported.");
  }
}

function renderContractFilter(
  filter: FilterContract,
  params: ParameterBuilder,
  identityJoins: readonly IdentityResolutionJoin[],
): string {
  return renderFilterExpression(resolvedFactField(filter.field, identityJoins, "f"), filter.op, filter.values, params);
}

function renderUserFilter(
  filter: SingleSemanticQuery["filters"][number],
  topic: TopicContract,
  fact: FactModel,
  params: ParameterBuilder,
  identityJoins: readonly IdentityResolutionJoin[],
): string {
  if (!topic.approvedDimensions.includes(filter.field)) throw new SemanticCompilerError("ILLEGAL_DIMENSION", `Filter field ${filter.field} is not approved for ${topic.id}.`);
  if (filter.field === "business_date") return renderFilterExpression(`f.${quoteIdentifier("business_date")}`, filter.op, filter.values, params);
  if (filter.field === "calendar_week") return renderFilterExpression(calendarWeekExpression("f"), filter.op, filter.values, params);
  const join = fact.joins.find((candidate) => candidate.dimension === filter.field || Object.hasOwn(candidate.fields, filter.field));
  if (!join || join.cardinality !== "many_to_one") throw new SemanticCompilerError("ILLEGAL_JOIN", `No many-to-one filter path for ${filter.field}.`);
  return renderFilterExpression(resolvedFactField(join.factKey, identityJoins, "f"), filter.op, filter.values, params);
}

function renderFilterExpression(expression: string, op: string, values: readonly unknown[], params: ParameterBuilder): string {
  if (op === "is_null") return `${expression} IS NULL`;
  if (op === "is_not_null") return `${expression} IS NOT NULL`;
  if ((op === "in" || op === "not_in") && values.length === 0) return op === "in" ? "FALSE" : "TRUE";
  if (op === "in" || op === "not_in") {
    const placeholders = values.map((value) => params.add(value));
    return `${expression} ${op === "in" ? "IN" : "NOT IN"} (${placeholders.join(", ")})`;
  }
  if (values.length !== 1) throw new SemanticCompilerError("INVALID_IR", `Filter ${op} requires exactly one value.`);
  const operators: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
  const operator = operators[op];
  if (!operator) throw new SemanticCompilerError("INVALID_IR", `Unsupported filter operator ${op}.`);
  return `${expression} ${operator} ${params.add(values[0])}`;
}

function resolveMetrics(ids: readonly string[], topic: TopicContract, registry: SemanticRegistry): readonly MetricContract[] {
  return ids.map((input) => {
    const candidates = input.includes(".")
      ? [input]
      : topic.metrics.filter((id) => shortMetricName(id) === input);
    if (candidates.length !== 1) throw new SemanticCompilerError("UNKNOWN_METRIC", `Metric ${input} is unknown or ambiguous in ${topic.id}.`);
    const id = candidates[0] as string;
    if (!topic.metrics.includes(id)) throw new SemanticCompilerError("METRIC_NOT_IN_TOPIC", `Metric ${id} is not available in ${topic.id}.`);
    const metric = registry.metrics.get(id);
    if (!metric) throw new SemanticCompilerError("UNKNOWN_METRIC", `Metric ${id} is not registered.`);
    return metric;
  });
}

function validateDimensions(dimensions: readonly string[], topic: TopicContract, metrics: readonly MetricContract[], fact: FactModel): void {
  for (const dimension of dimensions) {
    if (!topic.approvedDimensions.includes(dimension)) throw new SemanticCompilerError("ILLEGAL_DIMENSION", `${dimension} is not approved for ${topic.id}.`);
    for (const metric of metrics) if (!metric.allowedDimensions.includes(dimension)) throw new SemanticCompilerError("ILLEGAL_DIMENSION", `${dimension} is not allowed for ${metric.id}.`);
    if (dimension === "business_date") continue;
    if (dimension === "calendar_week") {
      if (!fact.fields.includes("business_date")) throw new SemanticCompilerError("ILLEGAL_DIMENSION", `${fact.id} cannot derive calendar_week without business_date.`);
      continue;
    }
    const join = fact.joins.find((candidate) => candidate.dimension === dimension || Object.hasOwn(candidate.fields, dimension));
    if (!join || join.cardinality !== "many_to_one") throw new SemanticCompilerError("ILLEGAL_JOIN", `No legal many-to-one join for ${dimension} from ${fact.id}.`);
  }
}

function resolveJoin(dimension: string, fact: FactModel, index: number): Readonly<{ dimension: string; join: FactModel["joins"][number]; alias: string; displayField: string }> {
  if (dimension === "business_date" || dimension === "calendar_week") throw new Error(`${dimension} is a source-neutral derived dimension, not a dimension join.`);
  const join = fact.joins.find((candidate) => candidate.dimension === dimension || Object.hasOwn(candidate.fields, dimension));
  if (!join || join.cardinality !== "many_to_one") throw new SemanticCompilerError("ILLEGAL_JOIN", `No legal many-to-one join for ${dimension}.`);
  const displayField = join.fields[dimension];
  if (!displayField) throw new SemanticCompilerError("ILLEGAL_JOIN", `Join ${join.dimension} does not expose ${dimension}.`);
  return { dimension, join, alias: `d${index}`, displayField };
}

function resolveIdentityResolutionJoins(
  fact: FactModel,
  aliasPrefix: string,
): readonly IdentityResolutionJoin[] {
  const byFactKey = new Map<string, IdentityResolutionJoin>();
  for (const join of fact.joins) {
    if (!join.identityType || byFactKey.has(join.factKey)) continue;
    byFactKey.set(join.factKey, Object.freeze({
      factKey: join.factKey,
      identityType: join.identityType,
      alias: `${aliasPrefix}${byFactKey.size}`,
    }));
  }
  return Object.freeze([...byFactKey.values()]);
}

function resolvedFactField(
  field: string,
  identityJoins: readonly IdentityResolutionJoin[],
  factAlias: string,
): string {
  const direct = `${factAlias}.${quoteIdentifier(field)}`;
  const resolution = identityJoins.find((join) => join.factKey === field);
  return resolution
    ? `COALESCE(${resolution.alias}.${quoteIdentifier("resolved_entity_id")}, ${direct})`
    : direct;
}

function renderIdentityResolutionJoins(
  identityJoins: readonly IdentityResolutionJoin[],
  factAlias: string,
): string {
  return identityJoins.map((join) =>
    `LEFT JOIN ${quoteQualified("core.entity_resolution")} ${join.alias} ON ${join.alias}.${quoteIdentifier("tenant_id")} = ${factAlias}.${quoteIdentifier("tenant_id")} AND ${join.alias}.${quoteIdentifier("entity_type")} = '${join.identityType}' AND ${join.alias}.${quoteIdentifier("member_entity_id")} = ${factAlias}.${quoteIdentifier(join.factKey)}`
  ).join("\n");
}

function assertNoSnapshotSums(metrics: readonly MetricContract[], fact: FactModel): void {
  const visit = (calculation: Calculation, metric: MetricContract): void => {
    if (calculation.op === "sum" && calculation.field && fact.snapshotFields.includes(calculation.field)) {
      throw new SemanticCompilerError("SNAPSHOT_SUM_FORBIDDEN", `${metric.id} attempts to ${calculation.op} snapshot field ${calculation.field} across time.`);
    }
    if (["add", "subtract", "multiply", "divide"].includes(calculation.op)) {
      const binary = calculation as Extract<Calculation, { left: Calculation }>;
      visit(binary.left, metric); visit(binary.right, metric);
    }
  };
  for (const metric of metrics) visit(metric.calculation, metric);
}

function validateTenantParameters(metric: MetricContract, parameters: Readonly<Record<string, unknown>>): void {
  for (const required of metric.tenantParameters) {
    if (!(required in parameters)) {
      throw new SemanticCompilerError("INVALID_PARAMETER", `Metric ${metric.id} requires trusted tenant parameter ${required}.`, { parameter: required });
    }
    const value = parameters[required];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3660) {
      throw new SemanticCompilerError("INVALID_PARAMETER", `Trusted tenant parameter ${required} must be an integer between 1 and 3660.`, { parameter: required });
    }
  }
}

function requireTopic(registry: SemanticRegistry, id: string): TopicContract {
  const topic = registry.topics.get(id);
  if (!topic) throw new SemanticCompilerError("UNKNOWN_TOPIC", `Unknown semantic Topic: ${id}.`);
  return topic;
}

function checkRole(topic: TopicContract, role: SemanticRole): void {
  if (!topic.roles.includes(role)) throw new SemanticCompilerError("FORBIDDEN_ROLE", `Role ${role} cannot access Topic ${topic.id}.`);
}

function checkCapabilities(required: readonly string[], available: ReadonlySet<string>, subject: string): void {
  const missing = required.filter((capability) => !available.has(capability));
  if (missing.length) throw new SemanticCompilerError("MISSING_CAPABILITY", `${subject} is unavailable because required capabilities are missing.`, { missing, subject });
}

function calendarForContext(context: CompilerContext): TenantCalendarConfig {
  return normalizeTenantCalendar({
    timezone: context.timezone,
    tradingDayCutoff: context.tradingDayCutoff,
    fiscalYearStartMonth: context.fiscalYearStartMonth,
    fiscalYearStartDay: context.fiscalYearStartDay,
    weekStartsOn: context.weekStartsOn,
  });
}

function applyTenantMetricWindow(
  requested: ResolvedTimeRange,
  metrics: readonly MetricContract[],
  context: CompilerContext,
  calendar: TenantCalendarConfig,
): ResolvedTimeRange {
  const windows = metrics.flatMap((metric) => {
    if (metric.id === "customers.active_customers") return [tenantParameterDays(context, "active_customer_days")];
    if (metric.id === "inventory.stock_cover_days") return [tenantParameterDays(context, "stock_velocity_days")];
    return [];
  });
  if (!windows.length) return requested;
  // A single fact scan can safely cover the largest trusted window. Individual
  // metric predicates still constrain customer windows; stock velocity uses all
  // daily rows in the expanded scan.
  return shiftRangeStartByDays(requested, Math.max(...windows), calendar);
}

function trustedMetricPredicates(
  metric: MetricContract,
  context: CompilerContext,
  range: ResolvedTimeRange,
  calendar: TenantCalendarConfig,
  params: ParameterBuilder,
): readonly string[] {
  if (metric.id === "customers.active_customers") {
    const window = shiftRangeStartByDays(range, tenantParameterDays(context, "active_customer_days"), calendar);
    return [`f.${quoteIdentifier("last_order_at")} >= ${params.add(window.from)}`];
  }
  if (metric.id === "customers.lapsed_customers") {
    const window = shiftRangeStartByDays(range, tenantParameterDays(context, "lapsed_customer_days"), calendar);
    return [`f.${quoteIdentifier("last_order_at")} < ${params.add(window.from)}`];
  }
  return [];
}

function tenantParameterDays(context: CompilerContext, key: string): number {
  const value = context.tenantParameters?.[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3660) {
    throw new SemanticCompilerError("INVALID_PARAMETER", `Trusted tenant parameter ${key} must be an integer between 1 and 3660.`, { parameter: key });
  }
  return value;
}

function timeParameterValues(field: string, range: ResolvedTimeRange): Readonly<{ from: string; to: string }> {
  return field === "business_date" || field === "snapshot_date" || field.endsWith("_date")
    ? { from: range.fromBusinessDate, to: range.toBusinessDate }
    : { from: range.from, to: range.to };
}

function renderSort(sort: readonly { metric: string; dir: "asc" | "desc" }[], aliases: ReadonlyMap<string, string>): string {
  if (!sort.length) return "";
  const clauses = sort.map((item) => {
    const resolved = [...aliases.entries()].find(([id, alias]) => id === item.metric || alias === item.metric);
    if (!resolved) throw new SemanticCompilerError("UNKNOWN_METRIC", `Sort metric ${item.metric} is not selected.`);
    return `${quoteIdentifier(resolved[1])} ${item.dir.toUpperCase()}`;
  });
  return `ORDER BY ${clauses.join(", ")}\n`;
}

function timeWarnings(range: CompiledSemanticQuery["resolvedTime"]): readonly string[] {
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000;
  return days < 7 ? ["The selected time window is shorter than seven days."] : [];
}

function estimateCost(metrics: number, dimensions: number, facts: number): number {
  return metrics * 5 + dimensions * 3 + facts * 20;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_.]*$/.test(value)) throw new SemanticCompilerError("INVALID_IR", `Unsafe identifier ${value}.`);
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteQualified(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 2) throw new SemanticCompilerError("INVALID_IR", `Unsafe qualified identifier ${value}.`);
  return parts.map(quoteIdentifier).join(".");
}

function shortMetricName(id: string): string { return id.slice(id.indexOf(".") + 1); }
function calendarWeekExpression(alias: string): string { return `date_trunc('week', ${alias}.${quoteIdentifier("business_date")})::date`; }
function indent(value: string): string { return value.split("\n").map((line) => `  ${line}`).join("\n"); }
function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((item) => right.includes(item)); }
