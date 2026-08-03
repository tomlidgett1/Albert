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
  /**
   * Trusted proof of the ordering applied by the outermost query before its
   * row limit. Consumers may use this to substantiate a global highest/lowest
   * claim; the returned row window alone is never sufficient evidence.
   */
  resultWindow: Readonly<{
    requestedLimit: number;
    orderedBeforeLimit: true;
    orderBy: readonly Readonly<{
      columnKey: string;
      direction: "asc" | "desc";
    }>[];
  }>;
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
  /**
   * Sanitised proof of the deterministic plan constraints enforced while
   * compiling this query. This is safe to persist with public validation
   * outcomes: it contains registry contract metadata, never SQL or values.
   */
  validationEvidence: CompiledSemanticValidationEvidence;
}>;

export type CompiledSemanticValidationEvidence = Readonly<{
  planKind: "single_fact" | "aggregate_then_align";
  factIds: readonly string[];
  alignOn: readonly string[];
  joins: readonly Readonly<{
    factId: string;
    dimension: string;
    cardinality: "many_to_one" | "one_to_one";
  }>[];
  metrics: readonly Readonly<{
    metricId: string;
    baseFact: string;
    grain: string;
    aggregation: MetricContract["aggregation"];
    authority: string;
    testKinds: readonly string[];
    dependencyMetricIds: readonly string[];
    snapshotAccesses: readonly Readonly<{
      factId: string;
      field: string;
      operation: string;
    }>[];
  }>[];
}>;

type CompiledSemanticQueryPlan = Omit<CompiledSemanticQuery, "validationEvidence">;

type RenderedSingle = Readonly<{
  sql: string;
  metricIds: readonly string[];
  metricAliases: ReadonlyMap<string, string>;
  dimensions: readonly string[];
  hiddenKeys: readonly string[];
  validationAliases: readonly string[];
  table: string;
  requestedTime: ResolvedTimeRange;
  resolvedTime: CompiledSemanticQuery["resolvedTime"];
}>;

type RenderedCompositePlan = Readonly<{
  sql: string;
  metricIds: readonly string[];
  metricAliases: ReadonlyMap<string, string>;
  resultMetricAliases: readonly string[];
  validationAliases: readonly string[];
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
    const compiled = enforceCostBudget(
      compileComposite(query, topic, registry, context, params, maxRows),
      context.maxEstimatedCost,
    );
    return attachValidationEvidence(compiled, query, registry);
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
    const validationSelects = renderCombinedValidationSelects(
      rendered.validationAliases,
      ["current_period", "comparison_period"],
    );
    const alignment = query.dimensions.length
      ? query.dimensions.map((dimension) =>
        `current_period.${quoteIdentifier(`__key_${dimension}`)} IS NOT DISTINCT FROM comparison_period.${quoteIdentifier(`__key_${dimension}`)}`,
      ).join(" AND ")
      : "TRUE";
    const limitParameter = params.add(query.limit);
    const sql = `WITH current_period AS (\n${indent(rendered.sql)}\n),\ncomparison_period AS (\n${indent(prior.sql)}\n)\nSELECT\n  ${[...dimensionSelects, ...metricSelects, ...validationSelects].join(",\n  ")}\nFROM current_period\nFULL OUTER JOIN comparison_period ON ${alignment}\n${renderSort(query.sort, rendered.metricAliases)}LIMIT ${limitParameter}`;
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
    return attachValidationEvidence(enforceCostBudget({
      sql,
      parameters: params.values,
      topic: topic.id,
      metricIds: rendered.metricIds,
      dimensions: rendered.dimensions,
      resultColumns: [...rendered.dimensions, ...comparisonColumns],
      resultWindow: compileResultWindow(query.sort, rendered.metricAliases, query.limit),
      sourceTables: [rendered.table],
      resolvedTime,
      warnings: timeWarnings(resolvedTime),
      budget: { maxRows, estimatedCost: estimateCost(query.metrics.length, query.dimensions.length, 2) },
    }, context.maxEstimatedCost), query, registry);
  }
  const limitParameter = params.add(query.limit);
  const sql = `${rendered.sql}\n${renderSort(query.sort, rendered.metricAliases)}LIMIT ${limitParameter}`;
  return attachValidationEvidence(enforceCostBudget({
    sql,
    parameters: params.values,
    topic: topic.id,
    metricIds: rendered.metricIds,
    dimensions: rendered.dimensions,
    resultColumns: [...rendered.dimensions, ...rendered.metricAliases.values()],
    resultWindow: compileResultWindow(query.sort, rendered.metricAliases, query.limit),
    sourceTables: [rendered.table],
    resolvedTime: rendered.resolvedTime,
    warnings: timeWarnings(rendered.resolvedTime),
    budget: { maxRows, estimatedCost: estimateCost(query.metrics.length, query.dimensions.length, 1) },
  }, context.maxEstimatedCost), query, registry);
}

function enforceCostBudget(
  compiled: CompiledSemanticQueryPlan,
  configuredMaximum: number | undefined,
): CompiledSemanticQueryPlan {
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

function attachValidationEvidence(
  compiled: CompiledSemanticQueryPlan,
  query: SemanticQuery,
  registry: SemanticRegistry,
): CompiledSemanticQuery {
  const subqueries = query.kind === "composite" ? query.queries : [query];
  const factIds = new Set<string>();
  const joins = new Map<string, CompiledSemanticValidationEvidence["joins"][number]>();

  for (const subquery of subqueries) {
    const subtopic = requireTopic(registry, subquery.topic);
    const metrics = resolveMetrics(subquery.metrics, subtopic, registry);
    const subqueryFacts = new Set(metrics.map((metric) => metric.baseFact));
    if (subqueryFacts.size !== 1) {
      throw new SemanticCompilerError(
        "CROSS_FACT_QUERY",
        "Validation evidence cannot describe a subquery with multiple fact grains.",
      );
    }
    const factId = [...subqueryFacts][0];
    const fact = factId ? registry.facts.get(factId) : undefined;
    if (!fact) throw new SemanticCompilerError("UNKNOWN_METRIC", `No fact model for ${String(factId)}.`);
    factIds.add(fact.id);

    for (const dimension of subquery.dimensions) {
      if (dimension === "business_date" || dimension === "calendar_week") continue;
      const join = fact.joins.find((candidate) =>
        candidate.dimension === dimension || Object.hasOwn(candidate.fields, dimension));
      if (!join) {
        throw new SemanticCompilerError("ILLEGAL_JOIN", `No validation evidence for ${dimension} from ${fact.id}.`);
      }
      const item = Object.freeze({
        factId: fact.id,
        dimension,
        cardinality: join.cardinality,
      });
      joins.set(`${item.factId}:${item.dimension}`, item);
    }

    // Identity resolution is also an executed join path. Include it in the
    // proof even when the visible query has no dimension grouping.
    for (const join of fact.joins.filter((candidate) => candidate.identityType)) {
      const dimension = `identity:${join.identityType}`;
      const item = Object.freeze({
        factId: fact.id,
        dimension,
        cardinality: join.cardinality,
      });
      joins.set(`${item.factId}:${dimension}:${join.factKey}`, item);
    }
  }

  const metricEvidence = [...new Set(compiled.metricIds)].map((metricId) => {
    const metric = registry.metrics.get(metricId);
    if (!metric) throw new SemanticCompilerError("UNKNOWN_METRIC", `No metric contract for ${metricId}.`);
    return Object.freeze({
      metricId: metric.id,
      baseFact: metric.baseFact,
      grain: metric.grain,
      aggregation: metric.aggregation,
      authority: metric.authority,
      testKinds: Object.freeze([...new Set(metric.tests.map((test) => test.kind))].sort()),
      dependencyMetricIds: Object.freeze(metricDependencies(metric, registry)),
      snapshotAccesses: Object.freeze(snapshotAccesses(metric, registry)),
    });
  });

  return Object.freeze({
    ...compiled,
    validationEvidence: Object.freeze({
      planKind: query.kind === "composite" ? "aggregate_then_align" : "single_fact",
      factIds: Object.freeze([...factIds]),
      alignOn: Object.freeze(query.kind === "composite" ? [...query.alignOn] : []),
      joins: Object.freeze([...joins.values()]),
      metrics: Object.freeze(metricEvidence),
    }),
  });
}

function metricDependencies(
  metric: MetricContract,
  registry: SemanticRegistry,
): string[] {
  const found = new Set<string>();
  const visit = (calculation: Calculation, stack: Set<string>): void => {
    if (calculation.op === "metric") {
      if (stack.has(calculation.metric)) {
        throw new SemanticCompilerError("INVALID_IR", `Metric dependency cycle at ${calculation.metric}.`);
      }
      const dependency = registry.metrics.get(calculation.metric);
      if (!dependency) throw new SemanticCompilerError("UNKNOWN_METRIC", `Unknown metric dependency ${calculation.metric}.`);
      found.add(dependency.id);
      stack.add(dependency.id);
      visit(dependency.calculation, stack);
      stack.delete(dependency.id);
      return;
    }
    if (["add", "subtract", "multiply", "divide"].includes(calculation.op)) {
      const binary = calculation as Extract<Calculation, { left: Calculation }>;
      visit(binary.left, stack);
      visit(binary.right, stack);
      return;
    }
    if (calculation.op === "conditional") {
      visit(calculation.value, stack);
      visit(calculation.otherwise, stack);
    }
  };
  visit(metric.calculation, new Set([metric.id]));
  return [...found].sort();
}

function snapshotAccesses(
  metric: MetricContract,
  registry: SemanticRegistry,
): CompiledSemanticValidationEvidence["metrics"][number]["snapshotAccesses"] {
  const found = new Map<string, { factId: string; field: string; operation: string }>();
  const visit = (contract: MetricContract, calculation: Calculation, stack: Set<string>): void => {
    if (calculation.op === "metric") {
      if (stack.has(calculation.metric)) {
        throw new SemanticCompilerError("INVALID_IR", `Metric dependency cycle at ${calculation.metric}.`);
      }
      const dependency = registry.metrics.get(calculation.metric);
      if (!dependency) throw new SemanticCompilerError("UNKNOWN_METRIC", `Unknown metric dependency ${calculation.metric}.`);
      stack.add(dependency.id);
      visit(dependency, dependency.calculation, stack);
      stack.delete(dependency.id);
      return;
    }
    if (["add", "subtract", "multiply", "divide"].includes(calculation.op)) {
      const binary = calculation as Extract<Calculation, { left: Calculation }>;
      visit(contract, binary.left, stack);
      visit(contract, binary.right, stack);
      return;
    }
    if (calculation.op === "conditional") {
      visit(contract, calculation.value, stack);
      visit(contract, calculation.otherwise, stack);
      return;
    }
    if (!("field" in calculation) || !calculation.field) return;
    const fact = registry.facts.get(contract.baseFact);
    if (!fact?.snapshotFields.includes(calculation.field)) return;
    const item = {
      factId: fact.id,
      field: calculation.field,
      operation: calculation.op,
    };
    found.set(`${item.factId}:${item.field}:${item.operation}`, item);
  };
  visit(metric, metric.calculation, new Set([metric.id]));
  return Object.freeze([...found.values()].sort((left, right) =>
    `${left.factId}:${left.field}:${left.operation}`.localeCompare(`${right.factId}:${right.field}:${right.operation}`)));
}

function compileComposite(
  query: CompositeSemanticQuery,
  topic: TopicContract,
  registry: SemanticRegistry,
  context: CompilerContext,
  params: ParameterBuilder,
  maxRows: number,
): CompiledSemanticQueryPlan {
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
    if (subtopic.composite) {
      const componentMetrics = resolveMetrics(subquery.metrics, subtopic, registry);
      const componentFacts = new Set(componentMetrics.map((metric) => metric.baseFact));
      if (
        componentFacts.size !== 1
        || componentMetrics.some((metric) => metric.id.startsWith("composites."))
      ) {
        throw new SemanticCompilerError(
          "INVALID_ALIGNMENT",
          "A composite Topic subquery must select non-composite component metrics from exactly one fact.",
        );
      }
    }
    checkRole(subtopic, context.role);
    checkCapabilities(subtopic.requiredCapabilities, context.capabilities, subtopic.id);
    return renderSingle({ ...subquery, kind: "single", sort: [], limit: maxRows }, subtopic, registry, context, params, false);
  });
  if (new Set(rendered.map((item) => item.table)).size !== rendered.length) {
    throw new SemanticCompilerError("INVALID_ALIGNMENT", "Each composite subquery must aggregate a distinct fact set.");
  }
  assertAlignedRequestedTimes(rendered);
  const compositeMetrics = resolveMetrics(query.metrics, topic, registry);
  for (const metric of compositeMetrics) {
    checkCapabilities(metric.requiredCapabilities, context.capabilities, metric.id);
    validateTenantParameters(metric, context.tenantParameters ?? {});
    const illegalDimensions = query.alignOn.filter((dimension) => !metric.allowedDimensions.includes(dimension));
    if (illegalDimensions.length > 0) {
      throw new SemanticCompilerError(
        "ILLEGAL_DIMENSION",
        `Dimensions ${illegalDimensions.join(", ")} are not approved for ${metric.id}.`,
        { allowed: metric.allowedDimensions },
      );
    }
  }
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
    const validationSelects = renderCombinedValidationSelects(
      currentPlan.validationAliases,
      ["current_composite", "comparison_composite"],
    );
    const alignment = query.alignOn.map((dimension) =>
      `current_composite.${quoteIdentifier(`__key_${dimension}`)} IS NOT DISTINCT FROM comparison_composite.${quoteIdentifier(`__key_${dimension}`)}`,
    ).join(" AND ");
    const limitParameter = params.add(query.limit);
    const sql = `WITH current_composite AS (\n${indent(currentPlan.sql)}\n),\ncomparison_composite AS (\n${indent(priorPlan.sql)}\n)\nSELECT\n  ${[...dimensionSelects, ...metricSelects, ...validationSelects].join(",\n  ")}\nFROM current_composite\nFULL OUTER JOIN comparison_composite ON ${alignment}\n${renderSort(query.sort, currentPlan.metricAliases)}LIMIT ${limitParameter}`;
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
      resultWindow: compileResultWindow(query.sort, currentPlan.metricAliases, query.limit),
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
    resultWindow: compileResultWindow(query.sort, currentPlan.metricAliases, query.limit),
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
  const validationSources = new Map<string, string[]>();
  rendered.forEach((item, index) => {
    for (const alias of item.validationAliases) {
      const expressions = validationSources.get(alias) ?? [];
      expressions.push(`${prefix}${index}.${quoteIdentifier(alias)}`);
      validationSources.set(alias, expressions);
    }
  });
  const validationSelects = [...validationSources.entries()].map(([alias, expressions]) =>
    `${combineValidationExpressions(alias, expressions)} AS ${quoteIdentifier(alias)}`,
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
    sql: `WITH ${ctes}\nSELECT\n  ${[...keySelects, ...componentSelects, ...compositeSelects, ...validationSelects].join(",\n  ")}\nFROM ${from}`,
    metricIds: [...metricAliases.keys()],
    metricAliases,
    resultMetricAliases: [...componentByField.keys(), ...compositeMetrics.map((metric) => shortMetricName(metric.id))],
    validationAliases: [...validationSources.keys()],
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
    return `${renderMetricCalculation(
      metric,
      fact,
      registry,
      context,
      params,
      trustedPredicates,
      { fromParameter, toParameter },
      identityJoins,
    )} AS ${quoteIdentifier(alias)}`;
  });
  const validationSelects = metrics.flatMap((metric) => renderSliceValidationSelects(
    metric,
    fact,
    registry,
    params,
    trustedMetricPredicates(metric, context, range, calendar, params),
    identityJoins,
  ));
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
  const sql = `SELECT\n  ${[...dimensionSelects, ...metricSelects, ...validationSelects.map((item) => item.sql)].join(",\n  ")}\nFROM ${quoteQualified(fact.table)} f${joinSql ? `\n${joinSql}` : ""}\nWHERE ${where.join("\n  AND ")}\n${groupBy.length ? `GROUP BY ${groupBy.join(", ")}\n` : ""}${includeSort ? "" : ""}`;
  return {
    sql,
    metricIds: metrics.map((metric) => metric.id),
    metricAliases,
    dimensions: query.dimensions,
    hiddenKeys,
    validationAliases: validationSelects.map((item) => item.alias),
    table: fact.table,
    requestedTime: requestedRange,
    resolvedTime: { ...range, compare: query.time.compare },
  };
}

type SliceValidationSelect = Readonly<{ alias: string; sql: string }>;

function renderMetricCalculation(
  metric: MetricContract,
  fact: FactModel,
  registry: SemanticRegistry,
  context: CompilerContext,
  params: ParameterBuilder,
  trustedPredicates: readonly string[],
  snapshotRange: Readonly<{ fromParameter: string; toParameter: string }>,
  identityJoins: readonly IdentityResolutionJoin[],
): string {
  if (metric.id !== "inventory.stock_cover_days") {
    return renderCalculation(
      metric.calculation,
      metric.filters,
      fact,
      registry,
      params,
      new Set([metric.id]),
      `f.${quoteIdentifier(metric.defaultTime)}`,
      trustedPredicates,
      snapshotRange,
      identityJoins,
    );
  }

  if (metric.calculation.op !== "divide") {
    throw new SemanticCompilerError("INVALID_IR", "Inventory stock cover must remain a ratio contract.");
  }
  const windowDays = tenantParameterDays(context, "stock_velocity_days");
  const windowParameter = params.add(windowDays);
  const numerator = renderCalculation(
    metric.calculation.left,
    metric.filters,
    fact,
    registry,
    params,
    new Set([metric.id]),
    `f.${quoteIdentifier(metric.defaultTime)}`,
    trustedPredicates,
    snapshotRange,
    identityJoins,
  );
  const filters = [
    ...metric.filters.map((filter) => renderContractFilter(filter, params, identityJoins)),
    ...trustedPredicates,
    `f.${quoteIdentifier("business_date")} >= (CAST(${snapshotRange.toParameter} AS date) - CAST(${windowParameter} AS integer))`,
    `f.${quoteIdentifier("business_date")} < CAST(${snapshotRange.toParameter} AS date)`,
  ];
  const dailyDemand = `(SUM(f.${quoteIdentifier("units_sold")}) FILTER (WHERE ${filters.join(" AND ")}) / CAST(${windowParameter} AS numeric))`;
  return `(${numerator} / NULLIF(${dailyDemand}, 0))`;
}

function renderSliceValidationSelects(
  metric: MetricContract,
  fact: FactModel,
  registry: SemanticRegistry,
  params: ParameterBuilder,
  trustedPredicates: readonly string[],
  identityJoins: readonly IdentityResolutionJoin[],
): readonly SliceValidationSelect[] {
  const alias = shortMetricName(metric.id);
  const basePredicates = [
    ...metric.filters.map((filter) => renderContractFilter(filter, params, identityJoins)),
    ...trustedPredicates,
  ];
  const fields = calculationFields(metric.calculation, registry, new Set([metric.id]))
    .filter((field) => fact.fields.includes(field));
  const selects: SliceValidationSelect[] = [];

  if (metricNeedsCostCoverage(metric, registry, new Set([metric.id]))) {
    const coverageFields = fields.filter(isCostCoverageField);
    if (coverageFields.length > 0) {
      const eligibility = coverageFields
        .map((field) => costEligibilityPredicate(field, fact))
        .filter((predicate): predicate is string => Boolean(predicate));
      const eligiblePredicates = [
        ...basePredicates,
        eligibility.length > 0 ? `(${eligibility.join(" OR ")})` : "TRUE",
      ];
      const observedPredicates = [
        ...eligiblePredicates,
        ...coverageFields.map((field) => `${resolvedFactField(field, identityJoins, "f")} IS NOT NULL`),
      ];
      const eligibleAlias = `__coverage_eligible__${alias}`;
      const observedAlias = `__coverage_observed__${alias}`;
      selects.push(
        {
          alias: eligibleAlias,
          sql: `COUNT(*) FILTER (WHERE ${eligiblePredicates.join(" AND ")}) AS ${quoteIdentifier(eligibleAlias)}`,
        },
        {
          alias: observedAlias,
          sql: `COUNT(*) FILTER (WHERE ${observedPredicates.join(" AND ")}) AS ${quoteIdentifier(observedAlias)}`,
        },
      );
    }
  }

  if ((metric.unit === "currency" || metric.unit === "currency_per_unit") && fact.fields.includes("currency")) {
    const contributors = fields.length > 0
      ? `(${fields.map((field) => `${resolvedFactField(field, identityJoins, "f")} IS NOT NULL`).join(" OR ")})`
      : "TRUE";
    const predicates = [...basePredicates, contributors];
    const currencyAlias = `__currency_codes__${alias}`;
    const currency = resolvedFactField("currency", identityJoins, "f");
    selects.push({
      alias: currencyAlias,
      sql: `STRING_AGG(DISTINCT ${currency}, ',' ORDER BY ${currency}) FILTER (WHERE ${predicates.join(" AND ")}) AS ${quoteIdentifier(currencyAlias)}`,
    });
  }
  if (
    fact.id === "commerce_payment"
    && metric.tests.some((test) => test.kind === "settlement_bridge_coverage")
  ) {
    const eligibleAlias = `__settlement_eligible__${alias}`;
    const linkedAlias = `__settlement_linked__${alias}`;
    const eligiblePredicates = basePredicates.length > 0 ? basePredicates : ["TRUE"];
    const linkedPredicates = [
      ...eligiblePredicates,
      `EXISTS (
        SELECT 1
        FROM core.event_link settlement_link
        WHERE settlement_link.tenant_id=f.${quoteIdentifier("tenant_id")}
          AND settlement_link.link_type='settlement_of'
          AND settlement_link.from_object_type='BankTransactions'
          AND settlement_link.to_object_type='SalePayment'
          AND settlement_link.to_connection_id=f.${quoteIdentifier("primary_connection_id")}
          AND settlement_link.to_source_record_id=f.${quoteIdentifier("primary_source_record_id")}
      )`,
    ];
    selects.push(
      {
        alias: eligibleAlias,
        sql: `COUNT(*) FILTER (WHERE ${eligiblePredicates.join(" AND ")}) AS ${quoteIdentifier(eligibleAlias)}`,
      },
      {
        alias: linkedAlias,
        sql: `COUNT(*) FILTER (WHERE ${linkedPredicates.join(" AND ")}) AS ${quoteIdentifier(linkedAlias)}`,
      },
    );
  }
  return selects;
}

function calculationFields(
  calculation: Calculation,
  registry: SemanticRegistry,
  stack: Set<string>,
): string[] {
  switch (calculation.op) {
    case "field": return [calculation.field];
    case "literal": return [];
    case "sum":
    case "avg":
    case "count":
    case "count_distinct":
    case "last_value":
    case "min":
    case "max": return calculation.field ? [calculation.field] : [];
    case "add":
    case "subtract":
    case "multiply":
    case "divide": return [
      ...calculationFields(calculation.left, registry, stack),
      ...calculationFields(calculation.right, registry, stack),
    ];
    case "conditional": return [
      ...calculationFields(calculation.value, registry, stack),
      ...calculationFields(calculation.otherwise, registry, stack),
    ];
    case "metric": {
      if (stack.has(calculation.metric)) return [];
      const dependency = registry.metrics.get(calculation.metric);
      if (!dependency) return [];
      stack.add(calculation.metric);
      const fields = calculationFields(dependency.calculation, registry, stack);
      stack.delete(calculation.metric);
      return fields;
    }
  }
}

function metricNeedsCostCoverage(
  metric: MetricContract,
  registry: SemanticRegistry,
  stack: Set<string>,
): boolean {
  if (
    metric.tests.some((test) => test.kind === "cost_coverage")
    || metric.requiredCapabilities.some((capability) => capability.endsWith(".cost"))
  ) return true;
  const dependencies = metricDependencyIds(metric.calculation);
  for (const dependencyId of dependencies) {
    if (stack.has(dependencyId)) continue;
    const dependency = registry.metrics.get(dependencyId);
    if (!dependency) continue;
    stack.add(dependencyId);
    const requiresCoverage = metricNeedsCostCoverage(dependency, registry, stack);
    stack.delete(dependencyId);
    if (requiresCoverage) return true;
  }
  return false;
}

function metricDependencyIds(calculation: Calculation): string[] {
  switch (calculation.op) {
    case "metric": return [calculation.metric];
    case "add":
    case "subtract":
    case "multiply":
    case "divide": return [...metricDependencyIds(calculation.left), ...metricDependencyIds(calculation.right)];
    case "conditional": return [
      ...metricDependencyIds(calculation.value),
      ...metricDependencyIds(calculation.otherwise),
    ];
    default: return [];
  }
}

function isCostCoverageField(field: string): boolean {
  return field.includes("cost") || field === "stock_value" || field === "labour_cost";
}

function costEligibilityPredicate(field: string, fact: FactModel): string | undefined {
  if (field === "labour_cost" && fact.fields.includes("worked_minutes")) {
    return `f.${quoteIdentifier("worked_minutes")} > 0`;
  }
  if (field === "cost_of_goods_sold" && fact.fields.includes("units_sold")) {
    return `f.${quoteIdentifier("units_sold")} <> 0`;
  }
  if (field === "stock_value" && fact.fields.includes("quantity_on_hand")) {
    return `f.${quoteIdentifier("quantity_on_hand")} IS NOT NULL`;
  }
  return "TRUE";
}

function renderCombinedValidationSelects(
  aliases: readonly string[],
  sources: readonly string[],
): string[] {
  return aliases.map((alias) => {
    const expressions = sources.map((source) => `${source}.${quoteIdentifier(alias)}`);
    return `${combineValidationExpressions(alias, expressions)} AS ${quoteIdentifier(alias)}`;
  });
}

function combineValidationExpressions(alias: string, expressions: readonly string[]): string {
  if (
    alias.startsWith("__coverage_eligible__")
    || alias.startsWith("__coverage_observed__")
    || alias.startsWith("__settlement_eligible__")
    || alias.startsWith("__settlement_linked__")
  ) {
    return expressions.map((expression) => `COALESCE(${expression}, 0)`).join(" + ");
  }
  if (alias.startsWith("__currency_codes__")) {
    return `CONCAT_WS(',', ${expressions.join(", ")})`;
  }
  throw new SemanticCompilerError("INVALID_IR", `Unknown internal validation projection ${alias}.`);
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
        const latest = `(SELECT MAX(${latestAlias}.${quoteIdentifier(timeField)}) FROM ${quoteQualified(fact.table)} ${latestAlias}${latestJoinSql ? ` ${latestJoinSql}` : ""} WHERE ${latestAlias}.${quoteIdentifier("tenant_id")} = f.${quoteIdentifier("tenant_id")} AND ${correlations.join(" AND ")} AND ${latestAlias}.${quoteIdentifier(calculation.field)} IS NOT NULL AND ${latestAlias}.${quoteIdentifier(timeField)} >= ${snapshotRange.fromParameter} AND ${latestAlias}.${quoteIdentifier(timeField)} < ${snapshotRange.toParameter})`;
        const latestPredicates = [...predicates, `${field} IS NOT NULL`, `${orderByField} = ${latest}`];
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
  const ordering = resolveResultOrdering(sort, aliases);
  if (!ordering.length) return "";
  const clauses = ordering.map((item) =>
    `${quoteIdentifier(item.columnKey)} ${item.direction.toUpperCase()}`);
  return `ORDER BY ${clauses.join(", ")}\n`;
}

function compileResultWindow(
  sort: readonly { metric: string; dir: "asc" | "desc" }[],
  aliases: ReadonlyMap<string, string>,
  requestedLimit: number,
): CompiledSemanticQuery["resultWindow"] {
  return Object.freeze({
    requestedLimit,
    orderedBeforeLimit: true as const,
    orderBy: Object.freeze(resolveResultOrdering(sort, aliases)),
  });
}

function resolveResultOrdering(
  sort: readonly { metric: string; dir: "asc" | "desc" }[],
  aliases: ReadonlyMap<string, string>,
): Readonly<{ columnKey: string; direction: "asc" | "desc" }>[] {
  return sort.map((item) => {
    const resolved = [...aliases.entries()].find(([id, alias]) => id === item.metric || alias === item.metric);
    if (!resolved) throw new SemanticCompilerError("UNKNOWN_METRIC", `Sort metric ${item.metric} is not selected.`);
    return Object.freeze({ columnKey: resolved[1], direction: item.dir });
  });
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
