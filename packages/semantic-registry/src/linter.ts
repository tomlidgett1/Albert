import type { CompiledSemanticValidationEvidence } from "../../compiler/src/compiler.js";
import type { FactModel, MetricContract, SemanticRegistry } from "./schema.js";
import { readSqlSurface, type ColumnRef, type SelectScope } from "./sql-surface.js";

/**
 * The SQL-first linter. Given one model-authored SELECT and the claims the
 * model says it substantiates, it does two jobs:
 *
 *  1. A denylist over the shapes that are known to produce confidently wrong
 *     numbers — summing a snapshot across its time axis, summing a measure
 *     that a co-joined fact multiplies, aggregating a key as if it were a
 *     quantity. Open by default: a relation or column the registry has never
 *     heard of is permitted, it just cannot contribute to Verified.
 *
 *  2. Reconstruction of the same CompiledSemanticValidationEvidence the typed
 *     compiler produces, so the five semantic invariant checks keep working
 *     unchanged over statements no compiler emitted. Where the SQL defies
 *     static reading, the evidence says "unverified" rather than guessing,
 *     and the runtime canary gets the final word.
 */

export type SqlFirstClaim = Readonly<{
  /** Governed metric id the model asserts this output column represents. */
  metricId: string;
  /** SELECT-list alias carrying the claimed figure. */
  column: string;
}>;

export type SqlLintViolation = Readonly<{
  code:
    | "snapshot_summed_across_axis"
    | "fanout_measure_sum"
    | "non_measure_aggregated"
    | "refund_handling_unstated"
    | "unknown_claim_metric"
    | "unreadable_statement";
  severity: "block" | "warn";
  message: string;
}>;

export type FactScopeBinding = Readonly<{
  factId: string;
  table: string;
  alias: string;
  grainKey: string;
  /** Verbatim FROM/WHERE text of the scope, when extractable — the canary input. */
  fromText?: string;
  whereText?: string;
  /** True when the scope joins only relations the registry fully vouches for. */
  staticallyClean: boolean;
  /** True when the scope's FROM references a CTE or derived table, which the
   * canary cannot re-execute out of context. */
  referencesDerived: boolean;
}>;

export type SqlFirstLintResult = Readonly<{
  evidence: CompiledSemanticValidationEvidence;
  violations: readonly SqlLintViolation[];
  factScopes: readonly FactScopeBinding[];
  referencedFactIds: readonly string[];
  /** Facts whose declared fields are summed anywhere in the statement. */
  summedFactIds: readonly string[];
  /** Minimum evidence tier across every fact the statement touched. */
  minimumFactTier: number;
  /** Ordering and limit written at the statement's outermost level. */
  resultOrdering: Readonly<{
    orderBy: readonly Readonly<{ column: string; direction: "asc" | "desc" }>[];
    limit?: number;
  }>;
}>;

type FactBinding = Readonly<{ fact: FactModel; alias: string }>;

export function lintSqlFirstStatement(
  sql: string,
  claims: readonly SqlFirstClaim[],
  registry: SemanticRegistry,
): SqlFirstLintResult {
  const surface = readSqlSurface(sql);
  const violations: SqlLintViolation[] = [];
  for (const reason of surface.unparsed) {
    violations.push({
      code: "unreadable_statement",
      severity: "warn",
      message: `Part of the statement defied static reading (${reason}); its evidence is recorded as unverified.`,
    });
  }

  const factsByTable = new Map<string, FactModel>();
  for (const fact of registry.facts.values()) factsByTable.set(fact.table, fact);
  // Dimension tables each fact is contracted to join, keyed by table name.
  const dimensionTables = new Set<string>();
  for (const fact of registry.facts.values()) {
    for (const join of fact.joins) dimensionTables.add(join.table);
  }

  const factIds = new Set<string>();
  const joins = new Map<string, CompiledSemanticValidationEvidence["joins"][number]>();
  const factScopes: FactScopeBinding[] = [];
  const snapshotAggregates: { factId: string; field: string; operation: string }[] = [];
  const aggregatedColumnsByFact = new Map<string, Set<string>>();
  const summedFactIds = new Set<string>();
  const derivedScopeGroupKeys = new Map<string, readonly ColumnRef[]>();

  for (const scope of surface.scopes) {
    const bindings = bindFacts(scope, factsByTable);
    for (const binding of bindings) factIds.add(binding.fact.id);
    if (scope.name && scope.hasGroupBy) derivedScopeGroupKeys.set(scope.name, scope.groupBy);

    lintScope(scope, bindings, registry, violations, joins, snapshotAggregates, aggregatedColumnsByFact, dimensionTables);

    for (const binding of bindings) {
      for (const aggregate of scope.aggregates) {
        if (aggregate.fn !== "sum") continue;
        const byAlias = new Map(bindings.map((item) => [item.alias, item]));
        for (const column of aggregate.columns) {
          const owner = column.qualifier ? byAlias.get(column.qualifier) : (bindings.length === 1 ? binding : undefined);
          if (owner?.fact.id === binding.fact.id && binding.fact.fields.includes(column.column)) {
            summedFactIds.add(binding.fact.id);
          }
        }
      }
      factScopes.push(Object.freeze({
        factId: binding.fact.id,
        table: binding.fact.table,
        alias: binding.alias,
        grainKey: binding.fact.grainKey,
        ...(scope.fromText !== undefined ? { fromText: scope.fromText } : {}),
        ...(scope.whereText !== undefined ? { whereText: scope.whereText } : {}),
        staticallyClean: scopeIsStaticallyClean(scope, bindings, factsByTable, dimensionTables),
        referencesDerived: scope.relations.some((relation) => relation.derived),
      }));
    }
  }

  // Alignment keys for a multi-fact statement: the columns the outermost
  // scope joins its derived aggregates on. Two facts meeting rawly in one
  // scope contribute no alignment, which correctly reads as an invalid
  // aggregate-then-align plan downstream.
  const alignOn = new Set<string>();
  if (factIds.size >= 2) {
    const outer = surface.scopes.find((scope) => scope.name === "");
    for (const equality of outer?.joinEqualities ?? []) {
      const leftDerived = equality.left.qualifier !== undefined
        && derivedScopeGroupKeys.has(relationNameForAlias(outer, equality.left.qualifier) ?? "");
      const rightDerived = equality.right.qualifier !== undefined
        && derivedScopeGroupKeys.has(relationNameForAlias(outer, equality.right.qualifier) ?? "");
      if (leftDerived && rightDerived && equality.left.column === equality.right.column) {
        alignOn.add(equality.left.column);
      }
    }
  }

  const metricEvidence = claims.map((claim) => {
    const metric = registry.metrics.get(claim.metricId);
    if (!metric) {
      violations.push({
        code: "unknown_claim_metric",
        severity: "block",
        message: `Claimed concept ${claim.metricId} is not a governed metric. Declare a metric from the registry or omit the claim.`,
      });
      return undefined;
    }
    lintClaimRefundHandling(metric, claim, aggregatedColumnsByFact, sql, violations);
    return buildMetricEvidence(metric, registry, snapshotAggregates);
  }).filter((item): item is NonNullable<typeof item> => item !== undefined);

  const referencedFactIds = [...factIds].sort();
  const minimumFactTier = referencedFactIds.length === 0
    ? 0
    : Math.min(...referencedFactIds.map((factId) => registry.facts.get(factId)?.evidenceTier ?? 0));
  const outerScope = surface.scopes.find((scope) => scope.name === "");

  return Object.freeze({
    evidence: Object.freeze({
      planKind: factIds.size >= 2 ? "aggregate_then_align" as const : "single_fact" as const,
      factIds: Object.freeze(referencedFactIds),
      alignOn: Object.freeze([...alignOn].sort()),
      joins: Object.freeze([...joins.values()]),
      metrics: Object.freeze(metricEvidence),
    }),
    violations: Object.freeze(violations),
    factScopes: Object.freeze(factScopes),
    referencedFactIds: Object.freeze(referencedFactIds),
    summedFactIds: Object.freeze([...summedFactIds].sort()),
    minimumFactTier,
    resultOrdering: Object.freeze({
      orderBy: Object.freeze((outerScope?.orderBy ?? []).map((item) => Object.freeze({ ...item }))),
      ...(outerScope?.limit !== undefined ? { limit: outerScope.limit } : {}),
    }),
  });
}

function relationNameForAlias(scope: SelectScope | undefined, alias: string): string | undefined {
  return scope?.relations.find((relation) => relation.alias === alias)?.name;
}

function bindFacts(scope: SelectScope, factsByTable: ReadonlyMap<string, FactModel>): FactBinding[] {
  const bindings: FactBinding[] = [];
  for (const relation of scope.relations) {
    if (relation.derived || !relation.schema) continue;
    const fact = factsByTable.get(`${relation.schema}.${relation.name}`);
    if (fact) bindings.push({ fact, alias: relation.alias });
  }
  return bindings;
}

function scopeIsStaticallyClean(
  scope: SelectScope,
  bindings: readonly FactBinding[],
  factsByTable: ReadonlyMap<string, FactModel>,
  dimensionTables: ReadonlySet<string>,
): boolean {
  if (bindings.length !== 1) return bindings.length === 0;
  const fact = (bindings[0] as FactBinding).fact;
  for (const relation of scope.relations) {
    if (relation.derived) return false;
    if (!relation.schema) continue;
    const qualified = `${relation.schema}.${relation.name}`;
    if (qualified === fact.table) continue;
    if (factsByTable.has(qualified)) return false;
    if (!fact.joins.some((join) => join.table === qualified)) return false;
    void dimensionTables;
  }
  return true;
}

function lintScope(
  scope: SelectScope,
  bindings: readonly FactBinding[],
  registry: SemanticRegistry,
  violations: SqlLintViolation[],
  joins: Map<string, CompiledSemanticValidationEvidence["joins"][number]>,
  snapshotAggregates: { factId: string; field: string; operation: string }[],
  aggregatedColumnsByFact: Map<string, Set<string>>,
  dimensionTables: ReadonlySet<string>,
): void {
  const byAlias = new Map(bindings.map((binding) => [binding.alias, binding]));
  const soleBinding = bindings.length === 1 ? bindings[0] : undefined;

  // Join evidence for every non-fact relation each fact shares the scope with.
  for (const binding of bindings) {
    for (const relation of scope.relations) {
      if (relation.alias === binding.alias) continue;
      const qualified = relation.schema ? `${relation.schema}.${relation.name}` : relation.name;
      const otherFact = bindings.find((candidate) => candidate.alias === relation.alias);
      if (otherFact) {
        // Fact met fact in one FROM tree. Directional: only the declared
        // multiplication is recorded as unsafe.
        if (otherFact.fact.fansOut.includes(binding.fact.id)) {
          joins.set(`${binding.fact.id}:fact:${otherFact.fact.id}`, Object.freeze({
            factId: binding.fact.id,
            dimension: `fact:${otherFact.fact.id}`,
            cardinality: "one_to_many" as const,
          }));
        }
        continue;
      }
      if (relation.derived) {
        // A grouped derived table joined to a fact cannot multiply it more
        // than its group keys allow; recorded as safe-side many_to_one only
        // when the fact's scope has no other hazard, else unverified.
        joins.set(`${binding.fact.id}:derived:${relation.alias}`, Object.freeze({
          factId: binding.fact.id,
          dimension: `derived:${relation.alias}`,
          cardinality: "unverified" as const,
        }));
        continue;
      }
      const contract = binding.fact.joins.find((join) => join.table === qualified);
      if (contract) {
        joins.set(`${binding.fact.id}:${contract.dimension}`, Object.freeze({
          factId: binding.fact.id,
          dimension: contract.dimension,
          cardinality: contract.cardinality,
        }));
        continue;
      }
      const someFactOwnsIt = dimensionTables.has(qualified);
      joins.set(`${binding.fact.id}:table:${qualified}`, Object.freeze({
        factId: binding.fact.id,
        dimension: `table:${qualified}`,
        // A canonical dimension table that simply is not contracted to this
        // fact is still a many-to-one lookup by construction; anything else
        // the registry cannot vouch for.
        cardinality: someFactOwnsIt ? "many_to_one" as const : "unverified" as const,
      }));
    }
  }

  // Aggregate checks.
  for (const aggregate of scope.aggregates) {
    for (const column of aggregate.columns) {
      const binding = column.qualifier ? byAlias.get(column.qualifier) : soleBinding;
      if (!binding || !binding.fact.fields.includes(column.column)) continue;
      const fact = binding.fact;
      const recorded = aggregatedColumnsByFact.get(fact.id) ?? new Set<string>();
      recorded.add(column.column);
      aggregatedColumnsByFact.set(fact.id, recorded);

      if (fact.snapshotFields.includes(column.column)) {
        snapshotAggregates.push({ factId: fact.id, field: column.column, operation: aggregate.fn });
        if (aggregate.fn === "sum" && !snapshotAxisPinned(scope, fact)) {
          violations.push({
            code: "snapshot_summed_across_axis",
            severity: "block",
            message: `SUM(${column.column}) totals a point-in-time level of ${fact.id} across ${fact.timeFields.join("/")}. Pin one date with an equality filter, group by the date, or use last_value semantics.`,
          });
        }
        continue;
      }
      if ((aggregate.fn === "sum" || aggregate.fn === "avg") && !fact.measures.includes(column.column)) {
        violations.push({
          code: "non_measure_aggregated",
          severity: "block",
          message: `${aggregate.fn.toUpperCase()}(${column.column}) aggregates a key or attribute of ${fact.id}; its measures are ${fact.measures.join(", ")}.`,
        });
        continue;
      }
      if (aggregate.fn === "sum") {
        const multipliers = bindings.filter((other) =>
          other.fact.id !== fact.id && other.fact.fansOut.includes(fact.id));
        if (multipliers.length > 0) {
          const names = multipliers.map((other) => other.fact.id).join(", ");
          violations.push({
            code: "fanout_measure_sum",
            severity: "block",
            message: `SUM(${column.column}) is inflated: ${names} repeats each ${fact.id} row in this join tree. Aggregate each fact in its own subquery and join the aggregates, or use the aligned mart for this pairing.`,
          });
        }
      }
    }
  }
}

/**
 * Summing a snapshot level is legitimate exactly when the statement holds the
 * time axis still: one date selected by equality, or the date carried in
 * GROUP BY so each output row is a single observation day.
 */
function snapshotAxisPinned(scope: SelectScope, fact: FactModel): boolean {
  const timeFields = new Set(fact.timeFields);
  if (scope.groupBy.some((column) => timeFields.has(column.column))) return true;
  return scope.whereEqualityColumns.some((column) => timeFields.has(column.column));
}

function lintClaimRefundHandling(
  metric: MetricContract,
  claim: SqlFirstClaim,
  aggregatedColumnsByFact: ReadonlyMap<string, ReadonlySet<string>>,
  sql: string,
  violations: SqlLintViolation[],
): void {
  if (metric.refundHandling !== "subtract") return;
  const aggregated = aggregatedColumnsByFact.get(metric.baseFact);
  const usesSignedColumn = [...(aggregated ?? [])].some((column) => column.startsWith("signed_"));
  const mentionsRefunds = /refund/iu.test(sql);
  if (!usesSignedColumn && !mentionsRefunds) {
    violations.push({
      code: "refund_handling_unstated",
      severity: "warn",
      message: `${metric.id} subtracts refunds, but the statement neither aggregates a signed_* column of ${metric.baseFact} nor addresses refunds; the figure may be gross of returns.`,
    });
  }
  void claim;
}

function buildMetricEvidence(
  metric: MetricContract,
  registry: SemanticRegistry,
  snapshotAggregates: readonly { factId: string; field: string; operation: string }[],
): CompiledSemanticValidationEvidence["metrics"][number] {
  const fact = registry.facts.get(metric.baseFact);
  const observedSnapshotAccesses = snapshotAggregates
    .filter((access) => access.factId === metric.baseFact)
    .map((access) => Object.freeze({ factId: access.factId, field: access.field, operation: access.operation }));
  const requiresSnapshotEvidence = metric.tests.some((test) => test.kind === "snapshot_not_summed");
  const snapshotAccesses = observedSnapshotAccesses.length > 0
    ? observedSnapshotAccesses
    : requiresSnapshotEvidence && fact && fact.snapshotFields.length > 0
      // The statement never aggregated the snapshot level, so the level was
      // read at row grain: record that as a non-summing access.
      ? fact.snapshotFields.map((field) => Object.freeze({ factId: fact.id, field, operation: "select" }))
      : [];
  return Object.freeze({
    metricId: metric.id,
    baseFact: metric.baseFact,
    grain: metric.grain,
    aggregation: metric.aggregation,
    authority: metric.authority,
    testKinds: Object.freeze([...new Set(metric.tests.map((test) => test.kind))].sort()),
    dependencyMetricIds: Object.freeze(metricDependencyIds(metric, registry)),
    snapshotAccesses: Object.freeze(snapshotAccesses),
  });
}

function metricDependencyIds(metric: MetricContract, registry: SemanticRegistry): string[] {
  const found = new Set<string>();
  const visit = (calculation: MetricContract["calculation"], stack: Set<string>): void => {
    if (calculation.op === "metric") {
      if (stack.has(calculation.metric)) return;
      const dependency = registry.metrics.get(calculation.metric);
      if (!dependency) return;
      found.add(dependency.id);
      stack.add(dependency.id);
      visit(dependency.calculation, stack);
      stack.delete(dependency.id);
      return;
    }
    if (["add", "subtract", "multiply", "divide"].includes(calculation.op)) {
      const binary = calculation as Extract<MetricContract["calculation"], { left: unknown }>;
      visit(binary.left as MetricContract["calculation"], stack);
      visit(binary.right as MetricContract["calculation"], stack);
      return;
    }
    if (calculation.op === "conditional") {
      visit(calculation.value, stack);
      visit(calculation.otherwise, stack);
    }
  };
  visit(metric.calculation, new Set());
  return [...found].sort();
}
