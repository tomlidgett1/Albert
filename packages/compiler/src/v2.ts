import { createHash } from "node:crypto";
import { Pool } from "pg";
import {
  Kysely,
  PostgresDialect,
  sql,
  type AliasedRawBuilder,
  type RawBuilder,
} from "kysely";
import {
  semanticRegistryV2Digest,
  type MeasureExpressionV2,
  type MeasureV2,
  type RelationshipV2,
  type SemanticRegistryDocumentV2,
  type SemanticViewV2,
  type SourceFieldV2,
  type TopicV2,
} from "../../semantic-registry/src/v2.js";
import {
  queryWorkspaceV2Schema,
  validateWorkspaceAgainstRegistryV2,
  type QueryBlockV2,
  type QueryWorkspaceV2,
  type SemanticFilterV2,
  type SemanticTimeSelectionV2,
} from "../../analytics-v2/src/workspace.js";
import {
  normalizeTenantCalendar,
  resolveComparisonTimeRange,
  resolvePreviousPeriodTimeRange,
  resolveTenantTimeRange,
  type ResolvedTimeRange,
  type TenantCalendarConfig,
} from "./calendar.js";

type DynamicDatabase = Record<string, Record<string, unknown>>;
// Publication validation resolves every dynamic table, field, and join before
// this Kysely boundary. Kysely cannot retain a useful static builder type while
// a governed runtime graph adds CTEs, tables, joins, and selections in stages.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ValidatedDynamicKyselyBuilder = any;
const compileDatabase = new Kysely<DynamicDatabase>({
  dialect: new PostgresDialect({ pool: new Pool({ max: 1 }) }),
});

export type SemanticCompilerV2ErrorCode =
  | "INVALID_WORKSPACE"
  | "UNKNOWN_SEMANTIC_OBJECT"
  | "AMBIGUOUS_JOIN_PATH"
  | "UNSUPPORTED_JOIN_PATH"
  | "UNSAFE_FANOUT"
  | "CROSS_GRAIN_EXPRESSION"
  | "INVALID_MEASURE_EXPRESSION"
  | "INVALID_TIME_SEMANTICS"
  | "UNSAFE_CURRENCY_AGGREGATION"
  | "UNSUPPORTED_SNAPSHOT"
  | "QUERY_BUDGET_EXCEEDED"
  | "ILLEGAL_COMPILER_OUTPUT";

export class SemanticCompilerV2Error extends Error {
  constructor(
    readonly code: SemanticCompilerV2ErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SemanticCompilerV2Error";
  }
}

export type NormalizedJoinV2 = Readonly<{
  relationshipId: string;
  fromViewId: string;
  toViewId: string;
  fromField: string;
  toField: string;
  cardinality: "many_to_one" | "one_to_one";
  optional: boolean;
  fromConnectionField?: string;
  toConnectionField?: string;
  toMappingVersion?: string;
  toActiveRecordFilter?: Readonly<{ field: string; value: boolean }>;
}>;

export type NormalizedAggregatePlanV2 = Readonly<{
  queryId: string;
  blockId: string;
  period: "current" | "comparison";
  topicIds: readonly string[];
  factViewId: string;
  sourceTable: string;
  tenantField: string;
  connectionField?: string;
  connectionSet: readonly string[];
  mappingVersion?: string;
  activeRecordFilter?: Readonly<{ field: string; value: boolean }>;
  dimensionIds: readonly string[];
  dimensionBindings: readonly Readonly<{
    outputDimensionId: string;
    dimensionId: string;
  }>[];
  measureIds: readonly string[];
  joins: readonly NormalizedJoinV2[];
  filters: readonly SemanticFilterV2[];
  timeMode: "bounded" | "current_snapshot";
  timeDimensionId?: string;
  resolvedTime: ResolvedTimeRange;
  snapshot?: Readonly<{
    timeField: string;
    entityFields: readonly string[];
    tieBreakerFields: readonly string[];
    partitionFields: readonly string[];
    lastValueFields: readonly Readonly<{
      fieldId: string;
      field: string;
      rankColumn: string;
    }>[];
  }>;
  limit: number;
  sort: readonly QueryBlockV2["sort"][number][];
}>;

export type CompiledAggregateQueryV2 = Readonly<{
  queryId: string;
  blockId: string;
  period: "current" | "comparison";
  normalizedPlan: NormalizedAggregatePlanV2;
  normalizedPlanHash: string;
  sql: string;
  parameters: readonly unknown[];
  resultColumns: readonly string[];
  sourceTables: readonly string[];
  semanticState: "verified" | "derived" | "exploratory";
  validationEvidence: Readonly<{
    tenantInjected: true;
    independentlyAggregated: true;
    joinPathUnique: true;
    fanoutSafe: true;
    parameterized: true;
    snapshotMode: "none" | "latest_per_entity" | "current_only";
  }>;
}>;

/** Internal execution evidence; stripped before any governed result is exposed. */
export const SOURCE_ROW_COUNT_COLUMN_V2 = "__albert_source_row_count";
export const SEMANTIC_COMPILER_CONTRACT_VERSION_V2 = 2;

export type CompiledWorkspaceV2 = Readonly<{
  publicationHash: string;
  overlayVersion: string;
  workspaceRevision: number;
  normalizedPlanHash: string;
  queries: readonly CompiledAggregateQueryV2[];
  alignments: readonly Readonly<{
    blockId: string;
    queryIds: readonly string[];
    dimensionIds: readonly string[];
    mode: "single_fact" | "aggregate_then_align";
  }>[];
  budget: Readonly<{
    estimatedCost: number;
    maximumCost: number;
    maximumRows: number;
  }>;
}>;

export type SemanticCompilerContextV2 = Readonly<{
  tenantId: string;
  now: string;
  timezone: string;
  tradingDayCutoff?: string;
  fiscalYearStartMonth?: number;
  fiscalYearStartDay?: number;
  weekStartsOn?: number;
  maxEstimatedCost?: number;
  maxRows?: number;
  connectionSet?: readonly string[];
}>;

type JoinStep = Readonly<{
  relationship: RelationshipV2;
  fromViewId: string;
  toViewId: string;
  direction: "from_to" | "to_from";
}>;
type QueryBuild = Readonly<{
  plan: NormalizedAggregatePlanV2;
  measureIds: readonly string[];
  state: "verified" | "derived" | "exploratory";
}>;

function lastValueFieldIds(
  contract: MeasureExpressionV2,
  measures: ReadonlyMap<string, MeasureV2>,
  stack = new Set<string>(),
): readonly string[] {
  if (contract.op === "aggregate")
    return contract.fn === "last_value" && contract.fieldId
      ? [contract.fieldId]
      : [];
  if (contract.op === "metric") {
    if (stack.has(contract.measureId))
      throw new SemanticCompilerV2Error(
        "INVALID_MEASURE_EXPRESSION",
        `Measure dependency cycle at ${contract.measureId}.`,
      );
    const dependency = requireObject(measures, contract.measureId, "measure");
    return lastValueFieldIds(
      dependency.expression,
      measures,
      new Set([...stack, contract.measureId]),
    );
  }
  if (contract.op === "binary")
    return [
      ...lastValueFieldIds(contract.left, measures, stack),
      ...lastValueFieldIds(contract.right, measures, stack),
    ];
  if (contract.op === "coalesce")
    return contract.values.flatMap((value) =>
      lastValueFieldIds(value, measures, stack),
    );
  if (contract.op === "conditional")
    return [
      ...lastValueFieldIds(contract.then, measures, stack),
      ...lastValueFieldIds(contract.otherwise, measures, stack),
    ];
  return [];
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function requireObject<T>(
  map: ReadonlyMap<string, T>,
  id: string,
  kind: string,
): T {
  const value = map.get(id);
  if (!value)
    throw new SemanticCompilerV2Error(
      "UNKNOWN_SEMANTIC_OBJECT",
      `Unknown ${kind} ${id}.`,
      { id, kind },
    );
  return value;
}

function stateFloor(
  states: readonly string[],
): "verified" | "derived" | "exploratory" {
  if (states.includes("exploratory")) return "exploratory";
  if (states.includes("derived")) return "derived";
  return "verified";
}

function calendar(context: SemanticCompilerContextV2): TenantCalendarConfig {
  return normalizeTenantCalendar({
    timezone: context.timezone,
    tradingDayCutoff: context.tradingDayCutoff,
    fiscalYearStartMonth: context.fiscalYearStartMonth,
    fiscalYearStartDay: context.fiscalYearStartDay,
    weekStartsOn: context.weekStartsOn,
  });
}

function legacyRange(
  range: SemanticTimeSelectionV2["range"],
): Parameters<typeof resolveTenantTimeRange>[0] {
  if (range.type === "current_snapshot")
    throw new SemanticCompilerV2Error(
      "INVALID_TIME_SEMANTICS",
      "A current-state view does not expose a historical time range.",
    );
  if (range.type === "last_n_complete_days")
    return { type: range.type, days: range.count };
  if (range.type === "last_n_complete_weeks")
    return { type: range.type, weeks: range.count };
  if (range.type === "last_n_complete_months")
    return { type: range.type, months: range.count };
  return range;
}

function resolveComparison(
  block: QueryBlockV2,
  current: ResolvedTimeRange,
  context: SemanticCompilerContextV2,
): ResolvedTimeRange | undefined {
  if (!block.comparison) return undefined;
  if (block.time.range.type === "current_snapshot")
    throw new SemanticCompilerV2Error(
      "INVALID_TIME_SEMANTICS",
      "Current-state views cannot be compared across historical periods.",
    );
  const tenantCalendar = calendar(context);
  if (block.comparison.kind === "custom") {
    if (!block.comparison.customRange)
      throw new SemanticCompilerV2Error(
        "INVALID_TIME_SEMANTICS",
        "Custom comparisons require a custom range.",
      );
    return resolveTenantTimeRange(
      legacyRange(block.comparison.customRange),
      context.now,
      tenantCalendar,
    );
  }
  if (block.comparison.kind === "prior_period")
    return resolvePreviousPeriodTimeRange(current, tenantCalendar);
  return resolveComparisonTimeRange(
    current,
    block.comparison.kind === "prior_week"
      ? "same_period_prior_week"
      : block.comparison.kind === "prior_month"
        ? "same_period_prior_month"
        : "same_period_prior_year",
    tenantCalendar,
  );
}

function currentSnapshotRange(nowValue: string): ResolvedTimeRange {
  const now = new Date(nowValue);
  if (!Number.isFinite(now.getTime()))
    throw new SemanticCompilerV2Error(
      "INVALID_TIME_SEMANTICS",
      `Invalid trusted clock value ${nowValue}.`,
    );
  const instant = now.toISOString();
  const businessDate = instant.slice(0, 10);
  return {
    from: instant,
    to: instant,
    fromBusinessDate: businessDate,
    toBusinessDate: businessDate,
  };
}

function availableSteps(
  topic: TopicV2,
  registry: SemanticRegistryDocumentV2,
  viewId: string,
): readonly JoinStep[] {
  const relationships = new Map(
    registry.relationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  );
  const steps: JoinStep[] = [];
  for (const relationshipId of topic.relationshipIds) {
    const relationship = requireObject(
      relationships,
      relationshipId,
      "relationship",
    );
    if (["unsupported", "deprecated"].includes(relationship.semanticState))
      continue;
    if (
      relationship.fromViewId === viewId &&
      relationship.supportedDirections.includes("from_to")
    )
      steps.push({
        relationship,
        fromViewId: viewId,
        toViewId: relationship.toViewId,
        direction: "from_to",
      });
    if (
      relationship.toViewId === viewId &&
      relationship.supportedDirections.includes("to_from")
    )
      steps.push({
        relationship,
        fromViewId: viewId,
        toViewId: relationship.fromViewId,
        direction: "to_from",
      });
  }
  return steps.sort((left, right) =>
    left.relationship.id.localeCompare(right.relationship.id),
  );
}

function findUniquePath(
  topic: TopicV2,
  registry: SemanticRegistryDocumentV2,
  fromViewId: string,
  toViewId: string,
): readonly JoinStep[] {
  if (fromViewId === toViewId) return [];
  const paths: JoinStep[][] = [];
  const walk = (
    current: string,
    path: JoinStep[],
    visited: Set<string>,
  ): void => {
    if (paths.length > 1) return;
    for (const step of availableSteps(topic, registry, current)) {
      if (visited.has(step.toViewId)) continue;
      const next = [...path, step];
      if (step.toViewId === toViewId) paths.push(next);
      else walk(step.toViewId, next, new Set([...visited, step.toViewId]));
    }
  };
  walk(fromViewId, [], new Set([fromViewId]));
  if (paths.length === 0)
    throw new SemanticCompilerV2Error(
      "UNSUPPORTED_JOIN_PATH",
      `No supported path from ${fromViewId} to ${toViewId} in Topic ${topic.id}.`,
    );
  if (paths.length > 1)
    throw new SemanticCompilerV2Error(
      "AMBIGUOUS_JOIN_PATH",
      `More than one supported path exists from ${fromViewId} to ${toViewId} in Topic ${topic.id}.`,
    );
  return paths[0]!;
}

function safeCardinality(step: JoinStep): "many_to_one" | "one_to_one" {
  if (step.relationship.cardinality === "one_to_one") return "one_to_one";
  const safe =
    step.direction === "from_to"
      ? step.relationship.cardinality === "many_to_one"
      : step.relationship.cardinality === "one_to_many";
  if (!safe)
    throw new SemanticCompilerV2Error(
      "UNSAFE_FANOUT",
      `Relationship ${step.relationship.id} would multiply the current fact grain.`,
      { cardinality: step.relationship.cardinality, direction: step.direction },
    );
  return "many_to_one";
}

function viewField(
  view: SemanticViewV2,
  fieldId: string,
  sourceObjects: ReadonlyMap<
    string,
    SemanticRegistryDocumentV2["sourceObjects"][number]
  >,
): Pick<SourceFieldV2, "physicalName" | "semanticState"> {
  const sourceField = view.sourceObjectId
    ? requireObject(
        sourceObjects,
        view.sourceObjectId,
        "source object",
      ).fields.find(
        (candidate) =>
          candidate.id === fieldId ||
          candidate.name === fieldId ||
          candidate.physicalName === fieldId,
      )
    : undefined;
  const declaredField = view.physicalFields.find(
    (candidate) =>
      candidate.id === fieldId || candidate.physicalName === fieldId,
  );
  const field = sourceField ?? declaredField;
  if (!field)
    throw new SemanticCompilerV2Error(
      "UNKNOWN_SEMANTIC_OBJECT",
      `Field ${fieldId} is not defined on view ${view.id}.`,
    );
  if (["unsupported", "deprecated"].includes(field.semanticState))
    throw new SemanticCompilerV2Error(
      "UNKNOWN_SEMANTIC_OBJECT",
      `Field ${fieldId} is ${field.semanticState}.`,
    );
  return field;
}

function normalizeJoins(
  factViewId: string,
  targetViewIds: readonly string[],
  topic: TopicV2,
  registry: SemanticRegistryDocumentV2,
  views: ReadonlyMap<string, SemanticViewV2>,
  sourceObjects: ReadonlyMap<
    string,
    SemanticRegistryDocumentV2["sourceObjects"][number]
  >,
): readonly NormalizedJoinV2[] {
  const joinedByView = new Map<string, NormalizedJoinV2>();
  for (const target of [...new Set(targetViewIds)].sort()) {
    for (const step of findUniquePath(topic, registry, factViewId, target)) {
      const from = requireObject(views, step.fromViewId, "view");
      const to = requireObject(views, step.toViewId, "view");
      if (Boolean(from.connectionField) !== Boolean(to.connectionField)) {
        throw new SemanticCompilerV2Error(
          "UNSUPPORTED_JOIN_PATH",
          `Relationship ${step.relationship.id} crosses connection-scoped and unscoped views without an explicit cross-source alignment.`,
        );
      }
      const relationship = step.relationship;
      if (
        ["effective_dated", "as_of"].includes(relationship.temporalBehavior)
      ) {
        throw new SemanticCompilerV2Error(
          "UNSUPPORTED_JOIN_PATH",
          `Relationship ${relationship.id} requires temporal join semantics that are not represented by an audited compiler contract.`,
        );
      }
      const fromFieldId =
        step.direction === "from_to"
          ? relationship.fromFieldId
          : relationship.toFieldId;
      const toFieldId =
        step.direction === "from_to"
          ? relationship.toFieldId
          : relationship.fromFieldId;
      const normalized: NormalizedJoinV2 = {
        relationshipId: relationship.id,
        fromViewId: step.fromViewId,
        toViewId: step.toViewId,
        fromField: viewField(from, fromFieldId, sourceObjects).physicalName,
        toField: viewField(to, toFieldId, sourceObjects).physicalName,
        cardinality: safeCardinality(step),
        optional: relationship.optional,
        ...(from.connectionField && to.connectionField
          ? {
              fromConnectionField: from.connectionField,
              toConnectionField: to.connectionField,
            }
          : {}),
        ...(to.activeRecordFilter
          ? { toActiveRecordFilter: to.activeRecordFilter }
          : {}),
        ...(to.mappingVersion
          ? { toMappingVersion: to.mappingVersion }
          : {}),
      };
      const existing = joinedByView.get(normalized.toViewId);
      if (existing && existing.relationshipId !== normalized.relationshipId)
        throw new SemanticCompilerV2Error(
          "AMBIGUOUS_JOIN_PATH",
          `View ${normalized.toViewId} would be joined through conflicting relationships.`,
        );
      joinedByView.set(normalized.toViewId, normalized);
    }
  }
  return [...joinedByView.values()];
}

function buildPlans(
  workspace: QueryWorkspaceV2,
  registry: SemanticRegistryDocumentV2,
  context: SemanticCompilerContextV2,
): QueryBuild[] {
  const topics = new Map(registry.topics.map((topic) => [topic.id, topic]));
  const views = new Map(registry.views.map((view) => [view.id, view]));
  const dimensions = new Map(
    registry.dimensions.map((dimension) => [dimension.id, dimension]),
  );
  const measures = new Map(
    registry.measures.map((measure) => [measure.id, measure]),
  );
  const sourceObjects = new Map(
    registry.sourceObjects.map((source) => [source.id, source]),
  );
  const connectionSet = [...new Set(context.connectionSet ?? [])].sort();
  const builds: QueryBuild[] = [];
  for (const block of workspace.blocks) {
    const selectedTopics = block.topicIds.map((id) =>
      requireObject(topics, id, "Topic"),
    );
    const primaryTopic = selectedTopics[0]!;
    const currentSnapshot = block.time.range.type === "current_snapshot";
    const current = currentSnapshot
      ? currentSnapshotRange(context.now)
      : resolveTenantTimeRange(
          legacyRange(block.time.range),
          context.now,
          calendar(context),
        );
    const comparison = resolveComparison(block, current, context);
    const groupedMeasures = new Map<string, MeasureV2[]>();
    for (const measureId of [...block.measureIds].sort()) {
      const measure = requireObject(measures, measureId, "measure");
      const bucket = groupedMeasures.get(measure.viewId) ?? [];
      bucket.push(measure);
      groupedMeasures.set(measure.viewId, bucket);
    }
    if (
      groupedMeasures.size > 1 &&
      !selectedTopics.some(({ layer }) => layer === "composite")
    )
      throw new SemanticCompilerV2Error(
        "CROSS_GRAIN_EXPRESSION",
        `Block ${block.id} selects multiple fact grains outside a composite Topic.`,
      );
    for (const [factViewId, factMeasures] of [
      ...groupedMeasures.entries(),
    ].sort(([left], [right]) => left.localeCompare(right))) {
      const factView = requireObject(views, factViewId, "view");
      if (factView.connectionField && connectionSet.length === 0) {
        throw new SemanticCompilerV2Error(
          "INVALID_WORKSPACE",
          `View ${factView.id} requires at least one trusted connection scope.`,
        );
      }
      if (
        factView.temporalAvailability === "current_only" &&
        !currentSnapshot
      ) {
        throw new SemanticCompilerV2Error(
          "INVALID_TIME_SEMANTICS",
          `View ${factView.id} contains current state only; use current_snapshot and do not request a historical period.`,
        );
      }
      if (factView.temporalAvailability !== "current_only" && currentSnapshot) {
        throw new SemanticCompilerV2Error(
          "INVALID_TIME_SEMANTICS",
          `View ${factView.id} is historically queryable and requires an explicit governed time range.`,
        );
      }
      const mapDimensionToFact = (dimensionId: string, kind: string) => {
        const requested = requireObject(dimensions, dimensionId, kind);
        if (requested.viewId === factViewId) return requested;
        if (primaryTopic.layer !== "composite" || !requested.conformedKey)
          return requested;
        const candidates = primaryTopic.alignOnDimensionIds
          .map((id) => requireObject(dimensions, id, "alignment dimension"))
          .filter(
            (candidate) =>
              candidate.viewId === factViewId &&
              candidate.conformedKey === requested.conformedKey,
          );
        if (candidates.length !== 1)
          throw new SemanticCompilerV2Error(
            "CROSS_GRAIN_EXPRESSION",
            `Dimension ${dimensionId} cannot be uniquely conformed to ${factViewId}.`,
            { candidates: candidates.map(({ id }) => id) },
          );
        return candidates[0]!;
      };
      const requestedDimensions = [...block.dimensionIds]
        .sort()
        .map((id) => requireObject(dimensions, id, "dimension"));
      const selectedDimensions = requestedDimensions.map((dimension) =>
        mapDimensionToFact(dimension.id, "dimension"),
      );
      const effectiveFilters = [
        ...selectedTopics.flatMap(({ defaultFilters }) => defaultFilters),
        ...block.filters,
      ].filter(
        (filter, index, filters) =>
          filters.findIndex(
            (candidate) => JSON.stringify(candidate) === JSON.stringify(filter),
          ) === index,
      );
      const filterBindings = effectiveFilters.map((filter) => ({
        filter,
        dimension: mapDimensionToFact(filter.fieldId, "filter dimension"),
      }));
      const filterDimensions = filterBindings.map(({ dimension }) => dimension);
      for (const measure of factMeasures.filter(({ currencyFieldId }) =>
        Boolean(currencyFieldId),
      )) {
        const currencyDimensions = registry.dimensions.filter(
          (dimension) =>
            dimension.viewId === measure.viewId &&
            dimension.fieldId === measure.currencyFieldId,
        );
        if (currencyDimensions.length !== 1) {
          throw new SemanticCompilerV2Error(
            "UNSAFE_CURRENCY_AGGREGATION",
            `Currency measure ${measure.id} does not have one unambiguous governed currency dimension.`,
          );
        }
        const currencyDimension = currencyDimensions[0]!;
        const groupedByCurrency = selectedDimensions.some(
          ({ id }) => id === currencyDimension.id,
        );
        const constrainedToOneCurrency = filterBindings.some(
          ({ filter, dimension }) =>
            dimension.id === currencyDimension.id &&
            ((filter.op === "eq" && filter.values.length === 1) ||
              (filter.op === "in" &&
                new Set(filter.values.map(String)).size === 1)),
        );
        if (!groupedByCurrency && !constrainedToOneCurrency) {
          throw new SemanticCompilerV2Error(
            "UNSAFE_CURRENCY_AGGREGATION",
            `Currency measure ${measure.id} must be grouped by ${currencyDimension.id} or filtered to one currency; implicit conversion is prohibited.`,
          );
        }
      }
      let timeDimension: ReturnType<typeof mapDimensionToFact> | undefined;
      if (!currentSnapshot) {
        if (!("dimensionId" in block.time))
          throw new SemanticCompilerV2Error(
            "INVALID_TIME_SEMANTICS",
            "A bounded time range requires a time dimension.",
          );
        timeDimension = mapDimensionToFact(
          block.time.dimensionId,
          "time dimension",
        );
      }
      if (timeDimension && timeDimension.timeRole === "none")
        throw new SemanticCompilerV2Error(
          "INVALID_TIME_SEMANTICS",
          `${timeDimension.id} is not a time role.`,
        );
      if (
        timeDimension &&
        timeDimension.viewId !== factViewId &&
        factMeasures.some(
          ({ expression: contract }) =>
            lastValueFieldIds(contract, measures).length > 0,
        )
      ) {
        throw new SemanticCompilerV2Error(
          "INVALID_TIME_SEMANTICS",
          `Snapshot measures on ${factViewId} require a time role on the same fact view.`,
        );
      }
      const joins = normalizeJoins(
        factViewId,
        [
          ...selectedDimensions,
          ...filterDimensions,
          ...(timeDimension ? [timeDimension] : []),
        ].map(({ viewId }) => viewId),
        primaryTopic,
        registry,
        views,
        sourceObjects,
      );
      const lastValueIds = [
        ...new Set(
          factMeasures.flatMap(({ expression: contract }) =>
            lastValueFieldIds(contract, measures),
          ),
        ),
      ].sort();
      const snapshot = lastValueIds.length
        ? (() => {
            if (!factView.snapshotPolicy)
              throw new SemanticCompilerV2Error(
                "UNSUPPORTED_SNAPSHOT",
                `View ${factView.id} has last-value measures but no audited snapshot policy.`,
              );
            const partitionFields = selectedDimensions
              .filter(({ viewId }) => viewId === factViewId)
              .map(
                ({ fieldId }) =>
                  viewField(factView, fieldId, sourceObjects).physicalName,
              );
            return {
              timeField: viewField(
                factView,
                factView.snapshotPolicy.timeFieldId,
                sourceObjects,
              ).physicalName,
              entityFields: factView.snapshotPolicy.entityFieldIds.map(
                (fieldId) =>
                  viewField(factView, fieldId, sourceObjects).physicalName,
              ),
              tieBreakerFields: factView.snapshotPolicy.tieBreakerFieldIds.map(
                (fieldId) =>
                  viewField(factView, fieldId, sourceObjects).physicalName,
              ),
              partitionFields: [...new Set(partitionFields)].sort(),
              lastValueFields: lastValueIds.map((fieldId, index) => ({
                fieldId,
                field: viewField(factView, fieldId, sourceObjects).physicalName,
                rankColumn: `__snapshot_rank_${index + 1}`,
              })),
            };
          })()
        : undefined;
      const states = [
        factView.semanticState,
        ...factMeasures.map(({ semanticState }) => semanticState),
        ...selectedDimensions.map(({ semanticState }) => semanticState),
        ...joins.map(
          (join) =>
            requireObject(
              new Map(
                registry.relationships.map((relationship) => [
                  relationship.id,
                  relationship,
                ]),
              ),
              join.relationshipId,
              "relationship",
            ).semanticState,
        ),
      ];
      const periods: Array<
        Readonly<{
          period: "current" | "comparison";
          resolvedTime: ResolvedTimeRange;
        }>
      > = [{ period: "current", resolvedTime: current }];
      if (comparison)
        periods.push({ period: "comparison", resolvedTime: comparison });
      for (const { period, resolvedTime } of periods) {
        const queryId = `${block.id}.${factViewId}.${period}`;
        builds.push({
          measureIds: factMeasures.map(({ id }) => id).sort(),
          state: stateFloor(states),
          plan: {
            queryId,
            blockId: block.id,
            period,
            topicIds: [...block.topicIds].sort(),
            factViewId,
            sourceTable: factView.physicalTable,
            tenantField: factView.tenantField,
            ...(factView.connectionField
              ? { connectionField: factView.connectionField }
              : {}),
            connectionSet,
            ...(factView.mappingVersion
              ? { mappingVersion: factView.mappingVersion }
              : {}),
            ...(factView.activeRecordFilter
              ? { activeRecordFilter: factView.activeRecordFilter }
              : {}),
            dimensionIds: requestedDimensions.map(({ id }) => id),
            dimensionBindings: requestedDimensions.map((dimension, index) => ({
              outputDimensionId: dimension.id,
              dimensionId: selectedDimensions[index]!.id,
            })),
            measureIds: factMeasures.map(({ id }) => id).sort(),
            joins,
            filters: filterBindings
              .map(({ filter, dimension }) => ({
                ...filter,
                fieldId: dimension.id,
              }))
              .sort((left, right) =>
                `${left.fieldId}:${left.op}:${JSON.stringify(left.values)}`.localeCompare(
                  `${right.fieldId}:${right.op}:${JSON.stringify(right.values)}`,
                ),
              ),
            timeMode: currentSnapshot ? "current_snapshot" : "bounded",
            ...(timeDimension ? { timeDimensionId: timeDimension.id } : {}),
            resolvedTime,
            ...(snapshot ? { snapshot } : {}),
            limit: Math.min(block.limit, context.maxRows ?? 1000, 1000),
            sort: [...block.sort],
          },
        });
      }
    }
  }
  return builds;
}

function expression(
  contract: MeasureExpressionV2,
  measure: MeasureV2,
  aliases: ReadonlyMap<string, string>,
  registry: SemanticRegistryDocumentV2,
  stack: Set<string>,
  snapshotRanks: ReadonlyMap<string, string> = new Map(),
): RawBuilder<unknown> {
  const views = new Map(registry.views.map((view) => [view.id, view]));
  const sourceObjects = new Map(
    registry.sourceObjects.map((source) => [source.id, source]),
  );
  const physicalRef = (fieldId: string): RawBuilder<unknown> => {
    const view = requireObject(views, measure.viewId, "view");
    const field = viewField(view, fieldId, sourceObjects);
    return sql.ref(
      `${requireObject(aliases, measure.viewId, "query alias")}.${field.physicalName}`,
    );
  };
  const predicate = (
    fieldId: string,
    comparator:
      | "eq"
      | "neq"
      | "in"
      | "not_in"
      | "gt"
      | "gte"
      | "lt"
      | "lte"
      | "is_null"
      | "is_not_null",
    values: readonly (string | number | boolean | null)[],
  ): RawBuilder<unknown> => {
    const field = physicalRef(fieldId);
    if (comparator === "is_null") return sql`${field} is null`;
    if (comparator === "is_not_null") return sql`${field} is not null`;
    if (comparator === "in" || comparator === "not_in") {
      if (values.length === 0)
        throw new SemanticCompilerV2Error(
          "INVALID_MEASURE_EXPRESSION",
          `${comparator} requires at least one value in ${measure.id}.`,
        );
      return comparator === "in"
        ? sql`${field} in (${sql.join(values)})`
        : sql`${field} not in (${sql.join(values)})`;
    }
    if (values.length !== 1)
      throw new SemanticCompilerV2Error(
        "INVALID_MEASURE_EXPRESSION",
        `${comparator} requires exactly one value in ${measure.id}.`,
      );
    if (comparator === "eq") return sql`${field} = ${values[0]}`;
    if (comparator === "neq") return sql`${field} <> ${values[0]}`;
    if (comparator === "gt") return sql`${field} > ${values[0]}`;
    if (comparator === "gte") return sql`${field} >= ${values[0]}`;
    if (comparator === "lt") return sql`${field} < ${values[0]}`;
    return sql`${field} <= ${values[0]}`;
  };
  switch (contract.op) {
    case "field":
      return physicalRef(contract.fieldId);
    case "literal": {
      if (!/^-?\d+(?:\.\d+)?$/u.test(contract.value))
        throw new SemanticCompilerV2Error(
          "INVALID_MEASURE_EXPRESSION",
          `Measure ${measure.id} contains a non-numeric literal.`,
        );
      return sql`${contract.value}::numeric`;
    }
    case "metric": {
      if (stack.has(contract.measureId))
        throw new SemanticCompilerV2Error(
          "INVALID_MEASURE_EXPRESSION",
          `Measure dependency cycle at ${contract.measureId}.`,
        );
      const dependency = requireObject(
        new Map(registry.measures.map((item) => [item.id, item])),
        contract.measureId,
        "measure",
      );
      if (dependency.viewId !== measure.viewId)
        throw new SemanticCompilerV2Error(
          "CROSS_GRAIN_EXPRESSION",
          `Measure ${measure.id} depends on ${dependency.id} across fact grains.`,
        );
      stack.add(dependency.id);
      const result = expression(
        dependency.expression,
        dependency,
        aliases,
        registry,
        stack,
        snapshotRanks,
      );
      stack.delete(dependency.id);
      return result;
    }
    case "aggregate": {
      if (contract.fn === "count" && !contract.fieldId) {
        const aggregate = sql`count(*)`;
        return contract.filter
          ? sql`${aggregate} filter (where ${predicate(contract.filter.fieldId, contract.filter.comparator, contract.filter.values)})`
          : aggregate;
      }
      if (!contract.fieldId)
        throw new SemanticCompilerV2Error(
          "INVALID_MEASURE_EXPRESSION",
          `${contract.fn} requires a field in measure ${measure.id}.`,
        );
      const field = physicalRef(contract.fieldId);
      let aggregate: RawBuilder<unknown>;
      if (contract.fn === "count_distinct")
        aggregate = sql`count(distinct ${field})`;
      if (contract.fn === "percentile") {
        if (contract.percentile === undefined)
          throw new SemanticCompilerV2Error(
            "INVALID_MEASURE_EXPRESSION",
            `Percentile measure ${measure.id} requires a percentile.`,
          );
        aggregate = sql`percentile_cont(${contract.percentile}) within group (order by ${field})`;
      } else if (contract.fn === "last_value") {
        const rankColumn = snapshotRanks.get(contract.fieldId);
        if (!rankColumn)
          throw new SemanticCompilerV2Error(
            "UNSUPPORTED_SNAPSHOT",
            `Measure ${measure.id} requires an audited latest-per-entity rank.`,
          );
        aggregate = sql`sum(${field}) filter (where ${sql.ref(`${requireObject(aliases, measure.viewId, "query alias")}.${rankColumn}`)} = 1)`;
      } else if (contract.fn === "sum") aggregate = sql`sum(${field})`;
      else if (contract.fn === "avg") aggregate = sql`avg(${field})`;
      else if (contract.fn === "min") aggregate = sql`min(${field})`;
      else if (contract.fn === "max") aggregate = sql`max(${field})`;
      else if (contract.fn === "count") aggregate = sql`count(${field})`;
      if (contract.filter && contract.fn === "last_value") {
        throw new SemanticCompilerV2Error(
          "INVALID_MEASURE_EXPRESSION",
          `Filtered last-value measure ${measure.id} requires a separately reviewed static template.`,
        );
      }
      return contract.filter
        ? sql`${aggregate!} filter (where ${predicate(contract.filter.fieldId, contract.filter.comparator, contract.filter.values)})`
        : aggregate!;
    }
    case "binary": {
      const left = expression(
        contract.left,
        measure,
        aliases,
        registry,
        stack,
        snapshotRanks,
      );
      const right = expression(
        contract.right,
        measure,
        aliases,
        registry,
        stack,
        snapshotRanks,
      );
      if (contract.fn === "add") return sql`(${left} + ${right})`;
      if (contract.fn === "subtract") return sql`(${left} - ${right})`;
      if (contract.fn === "multiply") return sql`(${left} * ${right})`;
      return sql`(case when ${right} = 0 then null else ${left} / ${right} end)`;
    }
    case "coalesce":
      return sql`coalesce(${sql.join(contract.values.map((value) => expression(value, measure, aliases, registry, stack, snapshotRanks)))})`;
    case "conditional": {
      const condition = predicate(
        contract.fieldId,
        contract.comparator,
        contract.values ?? [],
      );
      return sql`case when ${condition} then ${expression(contract.then, measure, aliases, registry, stack, snapshotRanks)} else ${expression(contract.otherwise, measure, aliases, registry, stack, snapshotRanks)} end`;
    }
    case "weighted_average": {
      const value = physicalRef(contract.valueFieldId);
      const weight = physicalRef(contract.weightFieldId);
      return sql`sum(${value} * ${weight}) / nullif(sum(${weight}), 0)`;
    }
  }
}

function applyFilter(
  query: ValidatedDynamicKyselyBuilder,
  reference: RawBuilder<unknown>,
  filter: SemanticFilterV2,
): ValidatedDynamicKyselyBuilder {
  if (filter.op === "is_null") return query.where(reference, "is", null);
  if (filter.op === "is_not_null")
    return query.where(reference, "is not", null);
  if (filter.op === "contains") {
    const escaped = String(filter.values[0]).replace(
      /[\\%_]/gu,
      (character) => `\\${character}`,
    );
    return query.where(sql`${reference} ilike ${`%${escaped}%`} escape '\\'`);
  }
  if (filter.op === "in" || filter.op === "not_in")
    return query.where(
      reference,
      filter.op === "in" ? "in" : "not in",
      filter.values,
    );
  if (filter.values.length !== 1)
    throw new SemanticCompilerV2Error(
      "INVALID_WORKSPACE",
      `${filter.op} requires exactly one value.`,
    );
  const operator = {
    eq: "=",
    neq: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  }[filter.op];
  return query.where(reference, operator, filter.values[0]);
}

function lower(
  build: QueryBuild,
  registry: SemanticRegistryDocumentV2,
  tenantId: string,
): CompiledAggregateQueryV2 {
  const plan = build.plan;
  const views = new Map(registry.views.map((view) => [view.id, view]));
  const dimensions = new Map(
    registry.dimensions.map((dimension) => [dimension.id, dimension]),
  );
  const measures = new Map(
    registry.measures.map((measure) => [measure.id, measure]),
  );
  const sourceObjects = new Map(
    registry.sourceObjects.map((source) => [source.id, source]),
  );
  const aliases = new Map<string, string>([[plan.factViewId, "v0"]]);
  plan.joins.forEach((join, index) =>
    aliases.set(join.toViewId, `v${index + 1}`),
  );
  let root: ValidatedDynamicKyselyBuilder = compileDatabase.with(
    "tenant_scope",
    (builder) => builder.selectNoFrom(sql`${tenantId}::text`.as("tenant_id")),
  );
  if (plan.snapshot) {
    const factView = requireObject(views, plan.factViewId, "view");
    if (!plan.timeDimensionId)
      throw new SemanticCompilerV2Error(
        "INVALID_TIME_SEMANTICS",
        `Snapshot plan ${plan.queryId} is missing its time dimension.`,
      );
    const selectedTime = requireObject(
      dimensions,
      plan.timeDimensionId,
      "time dimension",
    );
    const selectedTimeField = viewField(
      factView,
      selectedTime.fieldId,
      sourceObjects,
    ).physicalName;
    root = root.with(
      "snapshot_rows",
      (builder: ValidatedDynamicKyselyBuilder) => {
        let snapshotQuery: ValidatedDynamicKyselyBuilder = builder
          .selectFrom(
            compileDatabase.dynamic
              .table(plan.sourceTable)
              .as("snapshot_source"),
          )
          .innerJoin("tenant_scope", (join: ValidatedDynamicKyselyBuilder) =>
            join.on(
              sql.ref(`snapshot_source.${plan.tenantField}`),
              "=",
              sql.ref("tenant_scope.tenant_id"),
            ),
          )
          .selectAll("snapshot_source")
          .where(
            sql.ref(`snapshot_source.${selectedTimeField}`),
            ">=",
            plan.resolvedTime.from,
          )
          .where(
            sql.ref(`snapshot_source.${selectedTimeField}`),
            "<",
            plan.resolvedTime.to,
          );
        if (plan.connectionField)
          snapshotQuery = snapshotQuery.where(
            sql.ref(`snapshot_source.${plan.connectionField}`),
            "in",
            plan.connectionSet,
          );
        if (plan.activeRecordFilter)
          snapshotQuery = snapshotQuery.where(
            sql.ref(`snapshot_source.${plan.activeRecordFilter.field}`),
            "=",
            plan.activeRecordFilter.value,
          );
        if (plan.mappingVersion)
          snapshotQuery = snapshotQuery.where(
            sql.ref("snapshot_source.mapping_version"),
            "=",
            plan.mappingVersion,
          );
        const partitionFields = [
          ...new Set([
            plan.tenantField,
            ...(plan.connectionField ? [plan.connectionField] : []),
            ...plan.snapshot!.entityFields,
            ...plan.snapshot!.partitionFields,
          ]),
        ];
        const partition = sql.join(
          partitionFields.map((field) => sql.ref(`snapshot_source.${field}`)),
        );
        const tieBreakers = plan.snapshot!.tieBreakerFields.map(
          (field) => sql`${sql.ref(`snapshot_source.${field}`)} desc`,
        );
        for (const latest of plan.snapshot!.lastValueFields) {
          const ordering = sql.join([
            sql`(${sql.ref(`snapshot_source.${latest.field}`)} is null) asc`,
            sql`${sql.ref(`snapshot_source.${plan.snapshot!.timeField}`)} desc`,
            ...tieBreakers,
          ]);
          snapshotQuery = snapshotQuery.select(
            sql<number>`row_number() over (partition by ${partition} order by ${ordering})`.as(
              latest.rankColumn,
            ),
          );
        }
        return snapshotQuery;
      },
    );
  }
  let query: ValidatedDynamicKyselyBuilder = root
    .selectFrom(
      compileDatabase.dynamic
        .table(plan.snapshot ? "snapshot_rows" : plan.sourceTable)
        .as("v0"),
    )
    .innerJoin("tenant_scope", (join: ValidatedDynamicKyselyBuilder) =>
      join.on(
        sql.ref(`v0.${plan.tenantField}`),
        "=",
        sql.ref("tenant_scope.tenant_id"),
      ),
    );
  if (plan.connectionField)
    query = query.where(
      sql.ref(`v0.${plan.connectionField}`),
      "in",
      plan.connectionSet,
    );
  if (plan.activeRecordFilter)
    query = query.where(
      sql.ref(`v0.${plan.activeRecordFilter.field}`),
      "=",
      plan.activeRecordFilter.value,
    );
  if (plan.mappingVersion)
    query = query.where(
      sql.ref("v0.mapping_version"),
      "=",
      plan.mappingVersion,
    );
  for (const join of plan.joins) {
    const toView = requireObject(views, join.toViewId, "view");
    const fromAlias = requireObject(aliases, join.fromViewId, "query alias");
    const toAlias = requireObject(aliases, join.toViewId, "query alias");
    const table = compileDatabase.dynamic
      .table(toView.physicalTable)
      .as(toAlias);
    const joinCallback = (builder: ValidatedDynamicKyselyBuilder) => {
      let predicate = builder.on(
        sql.ref(`${fromAlias}.${join.fromField}`),
        "=",
        sql.ref(`${toAlias}.${join.toField}`),
      );
      predicate = predicate.on(
        sql.ref(`${toAlias}.${toView.tenantField}`),
        "=",
        sql.ref("tenant_scope.tenant_id"),
      );
      if (join.fromConnectionField && join.toConnectionField) {
        predicate = predicate.on(
          sql.ref(`${fromAlias}.${join.fromConnectionField}`),
          "=",
          sql.ref(`${toAlias}.${join.toConnectionField}`),
        );
      }
      if (toView.connectionField)
        predicate = predicate.on(
          sql.ref(`${toAlias}.${toView.connectionField}`),
          "in",
          plan.connectionSet,
        );
      if (join.toActiveRecordFilter)
        predicate = predicate.on(
          sql.ref(`${toAlias}.${join.toActiveRecordFilter.field}`),
          "=",
          join.toActiveRecordFilter.value,
        );
      if (join.toMappingVersion)
        predicate = predicate.on(
          sql.ref(`${toAlias}.mapping_version`),
          "=",
          join.toMappingVersion,
        );
      return predicate;
    };
    query = join.optional
      ? query.leftJoin(table, joinCallback)
      : query.innerJoin(table, joinCallback);
  }
  const selections: AliasedRawBuilder<unknown, string>[] = [];
  const groupBy: RawBuilder<unknown>[] = [];
  for (const binding of plan.dimensionBindings) {
    const dimension = requireObject(
      dimensions,
      binding.dimensionId,
      "dimension",
    );
    const view = requireObject(views, dimension.viewId, "view");
    const reference = sql.ref(
      `${requireObject(aliases, view.id, "query alias")}.${viewField(view, dimension.fieldId, sourceObjects).physicalName}`,
    );
    selections.push(reference.as(binding.outputDimensionId));
    groupBy.push(reference);
  }
  for (const measureId of plan.measureIds) {
    const measure = requireObject(measures, measureId, "measure");
    const snapshotRanks = new Map(
      plan.snapshot?.lastValueFields.map(({ fieldId, rankColumn }) => [
        fieldId,
        rankColumn,
      ]) ?? [],
    );
    selections.push(
      expression(
        measure.expression,
        measure,
        aliases,
        registry,
        new Set([measure.id]),
        snapshotRanks,
      ).as(measure.id),
    );
  }
  selections.push(
    sql<string>`count(*)::bigint`.as(SOURCE_ROW_COUNT_COLUMN_V2),
  );
  query = query.select(selections);
  if (groupBy.length) query = query.groupBy(groupBy);
  for (const filter of plan.filters) {
    const dimension = requireObject(
      dimensions,
      filter.fieldId,
      "filter dimension",
    );
    const view = requireObject(views, dimension.viewId, "view");
    const reference = sql.ref(
      `${requireObject(aliases, view.id, "query alias")}.${viewField(view, dimension.fieldId, sourceObjects).physicalName}`,
    );
    query = applyFilter(query, reference, filter);
  }
  if (!plan.snapshot && plan.timeMode === "bounded") {
    if (!plan.timeDimensionId)
      throw new SemanticCompilerV2Error(
        "INVALID_TIME_SEMANTICS",
        `Bounded plan ${plan.queryId} is missing its time dimension.`,
      );
    const timeDimension = requireObject(
      dimensions,
      plan.timeDimensionId,
      "time dimension",
    );
    const timeView = requireObject(views, timeDimension.viewId, "view");
    const timeReference = sql.ref(
      `${requireObject(aliases, timeView.id, "query alias")}.${viewField(timeView, timeDimension.fieldId, sourceObjects).physicalName}`,
    );
    query = query
      .where(timeReference, ">=", plan.resolvedTime.from)
      .where(timeReference, "<", plan.resolvedTime.to);
  }
  for (const sort of plan.sort) {
    if (![...plan.measureIds, ...plan.dimensionIds].includes(sort.fieldId))
      throw new SemanticCompilerV2Error(
        "INVALID_WORKSPACE",
        `Sort ${sort.fieldId} is not selected.`,
      );
    query = query.orderBy(
      sql.ref(sort.fieldId),
      `${sort.direction} ${sort.nulls === "first" ? "nulls first" : "nulls last"}`,
    );
  }
  query = query.limit(plan.limit);
  const compiled = query.compile();
  assertSafeCompilerOutput(compiled.sql, registry);
  const normalizedPlanHash = digest({
    compilerContractVersion: SEMANTIC_COMPILER_CONTRACT_VERSION_V2,
    plan,
  });
  return Object.freeze({
    queryId: plan.queryId,
    blockId: plan.blockId,
    period: plan.period,
    normalizedPlan: plan,
    normalizedPlanHash,
    sql: compiled.sql,
    parameters: Object.freeze([...compiled.parameters]),
    resultColumns: Object.freeze([...plan.dimensionIds, ...plan.measureIds]),
    sourceTables: Object.freeze([
      plan.sourceTable,
      ...plan.joins.map(
        (join) => requireObject(views, join.toViewId, "view").physicalTable,
      ),
    ]),
    semanticState: build.state,
    validationEvidence: Object.freeze({
      tenantInjected: true,
      independentlyAggregated: true,
      joinPathUnique: true,
      fanoutSafe: true,
      parameterized: true,
      snapshotMode: plan.snapshot
        ? "latest_per_entity"
        : plan.timeMode === "current_snapshot"
          ? "current_only"
          : "none",
    }),
  });
}

function assertSafeCompilerOutput(
  statement: string,
  registry: SemanticRegistryDocumentV2,
): void {
  const normalized = statement.trim().toLowerCase();
  if (
    (!normalized.startsWith("select ") && !normalized.startsWith("with ")) ||
    /;|--|\/\*/u.test(statement)
  )
    throw new SemanticCompilerV2Error(
      "ILLEGAL_COMPILER_OUTPUT",
      "Compiler output is not a single read-only SELECT.",
    );
  const allowedTables = new Set(
    registry.views.map(({ physicalTable }) => physicalTable.toLowerCase()),
  );
  for (const match of statement.matchAll(
    /(?:from|join)\s+"([a-z_]+)"\."([a-z0-9_]+)"/giu,
  )) {
    if (!allowedTables.has(`${match[1]}.${match[2]}`.toLowerCase()))
      throw new SemanticCompilerV2Error(
        "ILLEGAL_COMPILER_OUTPUT",
        `Compiler emitted unregistered table ${match[1]}.${match[2]}.`,
      );
  }
}

export function compileQueryWorkspaceV2(
  workspaceInput: QueryWorkspaceV2,
  registry: SemanticRegistryDocumentV2,
  context: SemanticCompilerContextV2,
): CompiledWorkspaceV2 {
  const workspace = queryWorkspaceV2Schema.parse(workspaceInput);
  if (!context.tenantId || context.tenantId !== workspace.tenantId)
    throw new SemanticCompilerV2Error(
      "INVALID_WORKSPACE",
      "Trusted tenant does not match the workspace tenant.",
    );
  if (workspace.publicationHash.length !== 64)
    throw new SemanticCompilerV2Error(
      "INVALID_WORKSPACE",
      "Workspace is not pinned to a valid publication.",
    );
  if (semanticRegistryV2Digest(registry) !== workspace.publicationHash)
    throw new SemanticCompilerV2Error(
      "INVALID_WORKSPACE",
      "Workspace publication hash does not match the supplied immutable registry artifact.",
    );
  const issues = validateWorkspaceAgainstRegistryV2(workspace, registry);
  if (issues.length)
    throw new SemanticCompilerV2Error(
      "INVALID_WORKSPACE",
      "Workspace failed semantic validation.",
      { issues },
    );
  const builds = buildPlans(workspace, registry, context);
  const estimatedCost = builds.reduce(
    (total, build) =>
      total +
      5 +
      build.plan.joins.length * 8 +
      build.plan.measureIds.length * 2 +
      build.plan.dimensionIds.length,
    0,
  );
  const maximumCost = context.maxEstimatedCost ?? 250;
  if (estimatedCost > maximumCost)
    throw new SemanticCompilerV2Error(
      "QUERY_BUDGET_EXCEEDED",
      `Estimated cost ${estimatedCost} exceeds ${maximumCost}.`,
      { estimatedCost, maximumCost },
    );
  const queries = builds.map((build) =>
    lower(build, registry, context.tenantId),
  );
  const alignments = workspace.blocks.map((block) => {
    const queryIds = queries
      .filter(
        ({ blockId, period }) => blockId === block.id && period === "current",
      )
      .map(({ queryId }) => queryId);
    return Object.freeze({
      blockId: block.id,
      queryIds: Object.freeze(queryIds),
      dimensionIds: Object.freeze([...block.dimensionIds].sort()),
      mode:
        queryIds.length > 1
          ? ("aggregate_then_align" as const)
          : ("single_fact" as const),
    });
  });
  const reusablePlan = {
    compilerContractVersion: SEMANTIC_COMPILER_CONTRACT_VERSION_V2,
    publicationHash: workspace.publicationHash,
    overlayVersion: workspace.overlayVersion,
    queries: queries.map(({ normalizedPlan }) => normalizedPlan),
    alignments,
  };
  return Object.freeze({
    publicationHash: workspace.publicationHash,
    overlayVersion: workspace.overlayVersion,
    workspaceRevision: workspace.revision,
    normalizedPlanHash: digest(reusablePlan),
    queries: Object.freeze(queries),
    alignments: Object.freeze(alignments),
    budget: Object.freeze({
      estimatedCost,
      maximumCost,
      maximumRows: context.maxRows ?? 1000,
    }),
  });
}

export function semanticResultCacheKeyV2(
  input: Readonly<{
    normalizedPlanHash: string;
    tenantId: string;
    connectionSet: readonly string[];
    publicationHash: string;
    overlayVersion: string;
    sourceWatermarks: Readonly<Record<string, string>>;
  }>,
): string {
  return digest({
    ...input,
    connectionSet: [...input.connectionSet].sort(),
    sourceWatermarks: stable(input.sourceWatermarks),
  });
}
