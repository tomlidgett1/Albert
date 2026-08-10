import { createHash } from "node:crypto";
import { ulid } from "ulid";

import {
  createInvestigationPlanV2,
  executeCompiledWorkspaceV2,
  investigationPlanV2Schema,
  rebindCachedExecutionV2,
  runAnalyticalOperatorV2,
  validateWorkspaceAgainstRegistryV2,
  type AnalyticalOperatorInputV2,
  type InvestigationPlanV2,
  type QueryBlockV2,
} from "../../../packages/analytics-v2/src/index.js";
import {
  parseSemanticV2ToolInput,
  type SemanticV2ToolInput,
  type SemanticV2ToolName,
} from "../../../packages/agent/src/semantic-v2-tools.js";
import {
  compileQueryWorkspaceV2,
  semanticResultCacheKeyV2,
  type CompiledWorkspaceV2,
} from "../../../packages/compiler/src/v2.js";
import type { SemanticRegistryDocumentV2 } from "../../../packages/semantic-registry/src/v2.js";
import type { PgPoolLike } from "./database.js";
import type {
  SemanticReadDatabase,
  TenantSemanticContext,
  TenantSemanticContextProvider,
  TrustedToolContext,
} from "./types.js";
import {
  beginSemanticV2Tenant,
  loadActiveSemanticRegistryV2,
  loadSemanticRegistryV2,
  PostgresEvidenceArtifactStoreV2,
  PostgresQueryWorkspaceStoreV2,
} from "./v2-runtime.js";

export type SemanticV2ToolResult = Readonly<Record<string, unknown>>;

export interface SemanticV2ToolExecutor {
  execute(
    name: SemanticV2ToolName,
    input: unknown,
    context: TrustedToolContext,
  ): Promise<SemanticV2ToolResult>;
}

export class SemanticV2ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SemanticV2ServiceError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertExpectedRevision(actual: number, expected: number): void {
  if (actual !== expected)
    throw new SemanticV2ServiceError(
      "WORKSPACE_REVISION_CONFLICT",
      `Workspace revision conflict: expected ${expected}, current revision is ${actual}.`,
      409,
      { actualRevision: actual, expectedRevision: expected },
    );
}

export type SemanticOverlaySnapshotV2 = Readonly<{
  overlayHash: string;
  timezone: string;
  tradingDayCutoff: string;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  weekStartsOn: number;
  defaults: Readonly<Record<string, string | number | boolean>>;
  dossier: Readonly<
    Record<string, string | number | boolean | readonly string[]>
  >;
  authorityByConcept: Readonly<Record<string, string>>;
  businessContextValues: readonly Readonly<Record<string, unknown>>[];
}>;

function compilerContext(
  tenantId: string,
  tenant: Pick<
    SemanticOverlaySnapshotV2,
    | "timezone"
    | "tradingDayCutoff"
    | "fiscalYearStartMonth"
    | "fiscalYearStartDay"
    | "weekStartsOn"
  >,
  connectionSet: readonly string[],
) {
  return {
    tenantId,
    now: new Date().toISOString(),
    timezone: tenant.timezone,
    tradingDayCutoff: tenant.tradingDayCutoff,
    fiscalYearStartMonth: tenant.fiscalYearStartMonth,
    fiscalYearStartDay: tenant.fiscalYearStartDay,
    weekStartsOn: tenant.weekStartsOn,
    maxEstimatedCost: 250,
    maxRows: 1_000,
    connectionSet,
  };
}

function safePreview(compiled: CompiledWorkspaceV2): SemanticV2ToolResult {
  return Object.freeze({
    normalizedPlanHash: compiled.normalizedPlanHash,
    publicationHash: compiled.publicationHash,
    workspaceRevision: compiled.workspaceRevision,
    budget: compiled.budget,
    queries: compiled.queries.map((query) => ({
      queryId: query.queryId,
      blockId: query.blockId,
      period: query.period,
      topicIds: query.normalizedPlan.topicIds,
      factViewId: query.normalizedPlan.factViewId,
      dimensionIds: query.normalizedPlan.dimensionIds,
      measureIds: query.normalizedPlan.measureIds,
      relationshipIds: query.normalizedPlan.joins.map(
        ({ relationshipId }) => relationshipId,
      ),
      semanticState: query.semanticState,
      snapshotMode: query.validationEvidence.snapshotMode,
      timeRange: query.normalizedPlan.resolvedTime,
    })),
    alignments: compiled.alignments,
  });
}

function contextTokens(value: string): ReadonlySet<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/gu) ?? []);
}

function lexicalScore(
  question: ReadonlySet<string>,
  values: readonly string[],
): number {
  const candidate = contextTokens(values.join(" "));
  let matches = 0;
  for (const token of question)
    if (candidate.has(token))
      matches += token.length > 5 ? 3 : token.length > 3 ? 2 : 1;
  return matches;
}

/**
 * Compile the smallest useful, physical-identifier-free semantic context for a
 * question. Exact semantic ids are returned because they are the only ids the
 * model may submit to workspace tools; tables, columns, joins and expressions
 * remain exclusively inside the trusted publication and compiler.
 */
function compileSemanticContext(
  registry: SemanticRegistryDocumentV2,
  question: string,
  limit: number,
  tenant: TenantSemanticContext,
  publicationHash: string,
  overlay: SemanticOverlaySnapshotV2,
): SemanticV2ToolResult {
  const tokens = contextTokens(question);
  const topics = registry.topics
    .map((topic, index) => ({
      topic,
      index,
      score: lexicalScore(tokens, [
        topic.label,
        topic.description,
        topic.aiContext,
        ...topic.sampleQuestions,
        ...topic.ambiguityNotes,
      ]),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ topic, score }) => {
      const allowedMeasures = new Set(topic.measureIds);
      const allowedDimensions = new Set(topic.dimensionIds);
      const measures = registry.measures
        .filter(({ id }) => allowedMeasures.has(id))
        .map((measure, index) => ({
          measure,
          index,
          score: lexicalScore(tokens, [
            measure.label,
            measure.description,
            ...measure.synonyms,
          ]),
        }))
        .sort(
          (left, right) => right.score - left.score || left.index - right.index,
        )
        .slice(0, 36)
        .map(({ measure }) => ({
          id: measure.id,
          label: measure.label,
          description: measure.description,
          unit: measure.unit,
          aggregation: measure.aggregation,
          semanticState: measure.semanticState,
          authority: measure.authority,
        }));
      const dimensions = registry.dimensions
        .filter(({ id }) => allowedDimensions.has(id))
        .map((dimension, index) => ({
          dimension,
          index,
          score: lexicalScore(tokens, [
            dimension.label,
            dimension.description,
            ...dimension.synonyms,
          ]),
        }))
        .sort(
          (left, right) => right.score - left.score || left.index - right.index,
        )
        .slice(0, 48)
        .map(({ dimension }) => ({
          id: dimension.id,
          label: dimension.label,
          description: dimension.description,
          dataType: dimension.dataType,
          timeRole: dimension.timeRole,
          semanticState: dimension.semanticState,
        }));
      return {
        id: topic.id,
        layer: topic.layer,
        label: topic.label,
        description: topic.description,
        aiContext: topic.aiContext,
        defaultRootViewId: topic.defaultRootViewId,
        freshnessMinutes: topic.freshnessMinutes,
        semanticState: topic.semanticState,
        score,
        measures,
        dimensions,
        sampleQuestions: topic.sampleQuestions.slice(0, 5),
        ambiguityNotes: topic.ambiguityNotes,
        unsupportedQuestions: topic.unsupportedQuestions,
      };
    });

  const capabilitySummary = (tenant.capabilityDetails ?? []).map(
    ({ id, connectorId, support, reasonCode, reason }) => ({
      id,
      connectorId,
      support,
      ...(reasonCode ? { reasonCode } : {}),
      ...(reason ? { reason } : {}),
    }),
  );
  return Object.freeze({
    publicationHash,
    overlayVersion: overlay.overlayHash,
    question,
    topics,
    topicDirectory: registry.topics.map(
      ({ id, layer, label, description, semanticState }) => ({
        id,
        layer,
        label,
        description,
        semanticState,
      }),
    ),
    businessContextDefinitions: registry.businessContext.map(
      ({ id, label, description, valueType, source, semanticState }) => ({
        id,
        label,
        description,
        valueType,
        source,
        semanticState,
      }),
    ),
    tenantContext: {
      timezone: overlay.timezone,
      tradingDayCutoff: overlay.tradingDayCutoff,
      fiscalYearStartMonth: overlay.fiscalYearStartMonth,
      fiscalYearStartDay: overlay.fiscalYearStartDay,
      weekStartsOn: overlay.weekStartsOn,
      defaults: overlay.defaults,
      dossier: overlay.dossier,
      authorityByConcept: overlay.authorityByConcept,
      businessContextValues: overlay.businessContextValues,
      identityGraph: {
        version: tenant.identityGraphVersion,
        hash: tenant.identityGraphHash,
      },
      capabilities: capabilitySummary,
      sourceFreshness: (tenant.sourceDetails ?? []).map(
        ({ connectorId, label, dataThrough, connectionStatus }) => ({
          connectorId,
          label,
          dataThrough,
          connectionStatus,
        }),
      ),
    },
    guidance:
      "Use only the exact semantic ids returned here. Call this tool again with a narrower question if the required object is absent. Never invent an id.",
  });
}

export type OperatorBindingInput = Readonly<{
  role: "primary" | "current" | "comparison" | "secondary";
  executionId: string;
  resultId: string;
  rowIndex?: number;
  columns: Readonly<Record<string, string>>;
}>;

export type ResolvedOperatorBinding = OperatorBindingInput &
  Readonly<{
    rows: readonly Readonly<Record<string, unknown>>[];
    publicationHash: string;
  }>;

function operatorBinding(
  bindings: readonly ResolvedOperatorBinding[],
  role: OperatorBindingInput["role"],
  required = true,
): ResolvedOperatorBinding | undefined {
  const matches = bindings.filter((binding) => binding.role === role);
  if (matches.length > 1)
    throw new SemanticV2ServiceError(
      "INVALID_OPERATOR_BINDING",
      `Operator role ${role} may be bound at most once.`,
      422,
    );
  if (required && matches.length === 0)
    throw new SemanticV2ServiceError(
      "INVALID_OPERATOR_BINDING",
      `Operator role ${role} is required.`,
      422,
    );
  return matches[0];
}

function bindingRows(
  binding: ResolvedOperatorBinding,
): readonly Readonly<Record<string, unknown>>[] {
  if (binding.rowIndex === undefined) return binding.rows;
  const row = binding.rows[binding.rowIndex];
  if (!row)
    throw new SemanticV2ServiceError(
      "INVALID_OPERATOR_BINDING",
      `Result ${binding.resultId} has no row ${binding.rowIndex}.`,
      422,
    );
  return [row];
}

function boundValue(
  binding: ResolvedOperatorBinding,
  logicalName: string,
  row: Readonly<Record<string, unknown>>,
): unknown {
  const column = binding.columns[logicalName];
  if (!column)
    throw new SemanticV2ServiceError(
      "INVALID_OPERATOR_BINDING",
      `Binding ${binding.role} must map ${logicalName}.`,
      422,
    );
  if (!Object.prototype.hasOwnProperty.call(row, column))
    throw new SemanticV2ServiceError(
      "INVALID_OPERATOR_BINDING",
      `Result ${binding.resultId} has no governed output column ${column}.`,
      422,
    );
  return row[column];
}

function decimalValue(
  binding: ResolvedOperatorBinding,
  logicalName: string,
  row: Readonly<Record<string, unknown>>,
): string | number {
  const value = boundValue(binding, logicalName, row);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value))
    return value;
  throw new SemanticV2ServiceError(
    "INVALID_OPERATOR_VALUE",
    `${binding.resultId}.${binding.columns[logicalName]} is not a finite governed decimal.`,
    422,
  );
}

function textValue(
  binding: ResolvedOperatorBinding,
  logicalName: string,
  row: Readonly<Record<string, unknown>>,
): string {
  const value = boundValue(binding, logicalName, row);
  if (typeof value !== "string" && typeof value !== "number")
    throw new SemanticV2ServiceError(
      "INVALID_OPERATOR_VALUE",
      `${binding.resultId}.${binding.columns[logicalName]} is not a governed label.`,
      422,
    );
  return String(value);
}

function optionalDecimal(
  binding: ResolvedOperatorBinding,
  logicalName: string,
  row: Readonly<Record<string, unknown>>,
): string | number | undefined {
  if (!binding.columns[logicalName]) return undefined;
  return decimalValue(binding, logicalName, row);
}

function scalarRow(
  binding: ResolvedOperatorBinding,
): Readonly<Record<string, unknown>> {
  const rows = bindingRows(binding);
  if (rows.length !== 1)
    throw new SemanticV2ServiceError(
      "INVALID_OPERATOR_GRAIN",
      `Binding ${binding.role} must select exactly one row; supply rowIndex when the result has multiple rows.`,
      422,
    );
  return rows[0]!;
}

function governedContextDecimal(
  overlay: SemanticOverlaySnapshotV2,
  key: string,
): string | number | undefined {
  const entry = overlay.businessContextValues.find(
    (candidate) => candidate.key === key,
  );
  const value = entry?.value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value)) return value;
  return undefined;
}

export function compileOperatorInput(
  operatorId: AnalyticalOperatorInputV2["operatorId"],
  bindings: readonly ResolvedOperatorBinding[],
  overlay: SemanticOverlaySnapshotV2,
): AnalyticalOperatorInputV2 {
  const primary = () => operatorBinding(bindings, "primary")!;
  const current = () => operatorBinding(bindings, "current")!;
  const comparison = (required = true) =>
    operatorBinding(bindings, "comparison", required);
  const labelled = (binding: ResolvedOperatorBinding) =>
    bindingRows(binding).map((row) => ({
      key: textValue(binding, "key", row),
      label: binding.columns.label
        ? textValue(binding, "label", row)
        : textValue(binding, "key", row),
      value: decimalValue(binding, "value", row),
    }));

  if (operatorId === "period_contribution")
    return {
      operatorId,
      current: labelled(current()),
      comparison: labelled(comparison()!),
    };
  if (operatorId === "dimension_contribution")
    return {
      operatorId,
      current: labelled(current()),
      comparison: comparison(false) ? labelled(comparison(false)!) : [],
    };
  if (operatorId === "gross_margin_bridge") {
    const currentBinding = current();
    const comparisonBinding = comparison()!;
    const currentRow = scalarRow(currentBinding);
    const comparisonRow = scalarRow(comparisonBinding);
    return {
      operatorId,
      currentRevenue: decimalValue(currentBinding, "revenue", currentRow),
      currentCost: decimalValue(currentBinding, "cost", currentRow),
      comparisonRevenue: decimalValue(
        comparisonBinding,
        "revenue",
        comparisonRow,
      ),
      comparisonCost: decimalValue(comparisonBinding, "cost", comparisonRow),
    };
  }
  if (operatorId === "price_volume_mix") {
    const currentBinding = current();
    const comparisonBinding = comparison()!;
    const currentRows = bindingRows(currentBinding);
    const comparisonRows = bindingRows(comparisonBinding);
    const present = new Map(
      currentRows.map((row) => [textValue(currentBinding, "key", row), row]),
    );
    const previous = new Map(
      comparisonRows.map((row) => [
        textValue(comparisonBinding, "key", row),
        row,
      ]),
    );
    if (
      present.size !== currentRows.length ||
      previous.size !== comparisonRows.length
    )
      throw new SemanticV2ServiceError(
        "INVALID_OPERATOR_GRAIN",
        "Price-volume-mix bindings must contain one row per governed item key in each period.",
        422,
      );
    const keys = [...new Set([...present.keys(), ...previous.keys()])].sort();
    return {
      operatorId,
      items: keys.map((key) => {
        const row = present.get(key);
        const prior = previous.get(key);
        const currentPrice = row
          ? decimalValue(currentBinding, "price", row)
          : decimalValue(comparisonBinding, "price", prior!);
        const comparisonPrice = prior
          ? decimalValue(comparisonBinding, "price", prior)
          : decimalValue(currentBinding, "price", row!);
        return {
          key,
          currentPrice,
          currentVolume: row
            ? decimalValue(currentBinding, "volume", row)
            : "0",
          comparisonPrice,
          comparisonVolume: prior
            ? decimalValue(comparisonBinding, "volume", prior)
            : "0",
          population:
            row && prior
              ? ("continuing" as const)
              : row
                ? ("new" as const)
                : ("discontinued" as const),
        };
      }),
    };
  }
  if (operatorId === "pareto_concentration")
    return { operatorId, items: labelled(primary()), targetShare: 0.8 };
  if (operatorId === "trend_anomaly") {
    const binding = primary();
    return {
      operatorId,
      points: bindingRows(binding)
        .map((row) => ({
          period: textValue(binding, "period", row),
          value: decimalValue(binding, "value", row),
        }))
        .sort((left, right) => left.period.localeCompare(right.period)),
      zThreshold: 2.5,
    };
  }
  if (operatorId === "discount_leakage") {
    const binding = primary();
    const row = scalarRow(binding);
    const comparisonBinding = comparison(false);
    const comparisonRow = comparisonBinding
      ? scalarRow(comparisonBinding)
      : undefined;
    return {
      operatorId,
      grossSales: decimalValue(binding, "grossSales", row),
      discounts: decimalValue(binding, "discounts", row),
      approvedDiscounts: optionalDecimal(binding, "approvedDiscounts", row),
      comparisonDiscounts:
        comparisonBinding && comparisonRow
          ? decimalValue(comparisonBinding, "discounts", comparisonRow)
          : undefined,
    };
  }
  if (operatorId === "return_rate") {
    const binding = primary();
    const row = scalarRow(binding);
    return {
      operatorId,
      grossSales: decimalValue(binding, "grossSales", row),
      returnValue: decimalValue(binding, "returnValue", row),
      soldUnits: optionalDecimal(binding, "soldUnits", row),
      returnedUnits: optionalDecimal(binding, "returnedUnits", row),
    };
  }
  if (operatorId === "customer_retention") {
    const binding = primary();
    return {
      operatorId,
      cohorts: bindingRows(binding).map((row) => ({
        cohort: textValue(binding, "cohort", row),
        acquired: decimalValue(binding, "acquired", row),
        retained: decimalValue(binding, "retained", row),
      })),
    };
  }
  if (operatorId === "stockout_opportunity") {
    const binding = primary();
    return {
      operatorId,
      items: bindingRows(binding).map((row) => ({
        key: textValue(binding, "key", row),
        unavailableDays: decimalValue(binding, "unavailableDays", row),
        averageDailyUnits: decimalValue(binding, "averageDailyUnits", row),
        unitMargin: decimalValue(binding, "unitMargin", row),
        availabilityFactor: optionalDecimal(binding, "availabilityFactor", row),
      })),
    };
  }
  if (operatorId === "supplier_performance") {
    const binding = primary();
    return {
      operatorId,
      suppliers: bindingRows(binding).map((row) => ({
        key: textValue(binding, "key", row),
        orderedUnits: decimalValue(binding, "orderedUnits", row),
        receivedUnits: decimalValue(binding, "receivedUnits", row),
        leadTimeDays: optionalDecimal(binding, "leadTimeDays", row),
        targetLeadTimeDays: optionalDecimal(binding, "targetLeadTimeDays", row),
      })),
    };
  }
  if (operatorId === "pos_xero_reconciliation") {
    const binding = primary();
    const row = scalarRow(binding);
    const tolerance = governedContextDecimal(
      overlay,
      "reconciliation.pos_xero_tolerance",
    );
    if (tolerance === undefined)
      throw new SemanticV2ServiceError(
        "MISSING_BUSINESS_CONTEXT",
        "POS/Xero reconciliation requires reconciliation.pos_xero_tolerance in the pinned business context.",
        422,
      );
    return {
      operatorId,
      posRevenue: decimalValue(binding, "posRevenue", row),
      xeroRevenue: decimalValue(binding, "xeroRevenue", row),
      tolerance,
      unmatchedPos: optionalDecimal(binding, "unmatchedPos", row),
      unmatchedXero: optionalDecimal(binding, "unmatchedXero", row),
    };
  }
  if (operatorId === "sales_bank_reconciliation") {
    const binding = primary();
    const row = scalarRow(binding);
    const tolerance = governedContextDecimal(
      overlay,
      "reconciliation.sales_bank_tolerance",
    );
    if (tolerance === undefined)
      throw new SemanticV2ServiceError(
        "MISSING_BUSINESS_CONTEXT",
        "Sales/bank reconciliation requires reconciliation.sales_bank_tolerance in the pinned business context.",
        422,
      );
    return {
      operatorId,
      sales: decimalValue(binding, "sales", row),
      bankSettlements: decimalValue(binding, "bankSettlements", row),
      tolerance,
      timingDifference: decimalValue(binding, "timingDifference", row),
      fees: decimalValue(binding, "fees", row),
    };
  }
  if (operatorId === "profitability_bridge") {
    const binding = primary();
    const row = scalarRow(binding);
    const prior = comparison(false);
    const priorRow = prior ? scalarRow(prior) : undefined;
    return {
      operatorId,
      revenue: decimalValue(binding, "revenue", row),
      cogs: decimalValue(binding, "cogs", row),
      operatingExpenses: decimalValue(binding, "operatingExpenses", row),
      priorRevenue:
        prior && priorRow
          ? decimalValue(prior, "revenue", priorRow)
          : undefined,
      priorCogs:
        prior && priorRow ? decimalValue(prior, "cogs", priorRow) : undefined,
      priorOperatingExpenses:
        prior && priorRow
          ? decimalValue(prior, "operatingExpenses", priorRow)
          : undefined,
    };
  }
  if (operatorId === "opportunity_sizing") {
    const binding = primary();
    return {
      operatorId,
      opportunities: bindingRows(binding).map((row) => ({
        key: textValue(binding, "key", row),
        baseline: decimalValue(binding, "baseline", row),
        attainableImprovementRate: decimalValue(
          binding,
          "attainableImprovementRate",
          row,
        ),
        confidence: decimalValue(binding, "confidence", row),
        implementationCost:
          optionalDecimal(binding, "implementationCost", row) ?? "0",
      })),
    };
  }
  const binding = primary();
  return {
    operatorId: "constraint_controllability",
    opportunities: bindingRows(binding).map((row) => {
      const controllability = textValue(binding, "controllability", row);
      if (
        !(["high", "medium", "low"] as const).includes(
          controllability as "high" | "medium" | "low",
        )
      )
        throw new SemanticV2ServiceError(
          "INVALID_OPERATOR_VALUE",
          `Invalid controllability ${controllability}.`,
          422,
        );
      const constrainedValue = boundValue(binding, "constrained", row);
      if (typeof constrainedValue !== "boolean")
        throw new SemanticV2ServiceError(
          "INVALID_OPERATOR_VALUE",
          "Constrained must be a governed boolean.",
          422,
        );
      return {
        key: textValue(binding, "key", row),
        value: decimalValue(binding, "value", row),
        controllability: controllability as "high" | "medium" | "low",
        constrained: constrainedValue,
        constraint: binding.columns.constraint
          ? textValue(binding, "constraint", row)
          : undefined,
      };
    }),
  };
}

export class DefaultSemanticV2ToolExecutor implements SemanticV2ToolExecutor {
  private readonly workspaces: PostgresQueryWorkspaceStoreV2;
  private readonly evidence: PostgresEvidenceArtifactStoreV2;

  constructor(
    private readonly dependencies: Readonly<{
      controlPlanePool: PgPoolLike;
      database: SemanticReadDatabase;
      contextProvider: TenantSemanticContextProvider;
      publicationHashOverride?: string;
      statementTimeoutMs?: number;
      maxPostgresCost?: number;
    }>,
  ) {
    this.workspaces = new PostgresQueryWorkspaceStoreV2(
      dependencies.controlPlanePool,
    );
    this.evidence = new PostgresEvidenceArtifactStoreV2(
      dependencies.controlPlanePool,
    );
  }

  private assertCurrentTurnWorkspace(
    workspace: Readonly<{ id: string; questionId: string }>,
    context: TrustedToolContext,
  ): void {
    if (workspace.questionId !== context.turnId) {
      throw new SemanticV2ServiceError(
        "WORKSPACE_TURN_MISMATCH",
        `Workspace ${workspace.id} does not belong to the current conversation turn.`,
        403,
      );
    }
  }

  private async loadOrCreateSemanticOverlay(
    tenantId: string,
    tenant: TenantSemanticContext,
  ): Promise<SemanticOverlaySnapshotV2> {
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, tenantId);
      const current = await client.query(
        `SELECT context_key,version,value,source,evidence,valid_from
           FROM control_plane.business_context_v2
          WHERE tenant_id=$1 AND valid_to IS NULL
          ORDER BY context_key`,
        [tenantId],
      );
      const snapshot = {
        timezone: tenant.timezone,
        tradingDayCutoff: tenant.tradingDayCutoff,
        fiscalYearStartMonth: tenant.fiscalYearStartMonth,
        fiscalYearStartDay: tenant.fiscalYearStartDay,
        weekStartsOn: tenant.weekStartsOn,
        defaults: tenant.defaults,
        dossier: tenant.dossier,
        authorityByConcept: tenant.authorityByConcept,
        businessContextValues: current.rows.map((row) => ({
          key: row.context_key,
          version: Number(row.version),
          value: row.value,
          source: row.source,
          evidence: row.evidence,
          validFrom: new Date(String(row.valid_from)).toISOString(),
        })),
      };
      const overlayHash = digest({
        providerOverlayVersion: tenant.overlayVersion,
        ...snapshot,
      });
      await client.query(
        `INSERT INTO control_plane.business_context_snapshots_v2(tenant_id,overlay_hash,context_snapshot)
         VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (tenant_id,overlay_hash) DO NOTHING`,
        [tenantId, overlayHash, JSON.stringify(snapshot)],
      );
      await client.query("COMMIT");
      return Object.freeze({ overlayHash, ...snapshot });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadSemanticOverlay(
    tenantId: string,
    overlayHash: string,
  ): Promise<SemanticOverlaySnapshotV2> {
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, tenantId, true);
      const result = await client.query(
        `SELECT context_snapshot FROM control_plane.business_context_snapshots_v2
          WHERE tenant_id=$1 AND overlay_hash=$2`,
        [tenantId, overlayHash],
      );
      await client.query("COMMIT");
      const snapshot = result.rows[0]?.context_snapshot as
        Omit<SemanticOverlaySnapshotV2, "overlayHash"> | undefined;
      if (!snapshot)
        throw new SemanticV2ServiceError(
          "SEMANTIC_OVERLAY_NOT_FOUND",
          `Business-context snapshot ${overlayHash} was not found.`,
          409,
        );
      return Object.freeze({ overlayHash, ...snapshot });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadInsightLedger(
    tenantId: string,
  ): Promise<readonly Readonly<Record<string, unknown>>[]> {
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, tenantId, true);
      const result = await client.query(
        `SELECT insight_key,objective,state,magnitude,unit,novelty,occurrences,evidence_digest,
                first_observed_at,last_observed_at,disposition_at,
                associated_action,user_note,outcome
           FROM control_plane.insight_ledger_v2
          WHERE tenant_id=$1 AND state IN ('active','accepted')
          ORDER BY last_observed_at DESC
          LIMIT 30`,
        [tenantId],
      );
      await client.query("COMMIT");
      return Object.freeze(
        result.rows.map((row) =>
          Object.freeze({
            insightKey: row.insight_key,
            objective: row.objective,
            state: row.state,
            magnitude: row.magnitude,
            unit: row.unit,
            novelty: Number(row.novelty),
            occurrences: Number(row.occurrences),
            evidenceDigest: row.evidence_digest,
            firstObservedAt: new Date(
              String(row.first_observed_at),
            ).toISOString(),
            lastObservedAt: new Date(
              String(row.last_observed_at),
            ).toISOString(),
            dispositionAt: row.disposition_at
              ? new Date(String(row.disposition_at)).toISOString()
              : null,
            associatedAction: row.associated_action,
            userNote: row.user_note,
            outcome: row.outcome,
          }),
        ),
      );
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordRuntimeEvent(
    input: Readonly<{
      tenantId: string;
      turnId: string;
      publicationHash?: string;
      eventKind:
        | "routing_miss"
        | "clarification"
        | "unavailable"
        | "compilation_failure"
        | "execution_failure";
      reasonCode: string;
      questionDigest: string;
      topicIds?: readonly string[];
      objectIds?: readonly string[];
      detail?: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<void> {
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, input.tenantId);
      await client.query(
        `INSERT INTO control_plane.semantic_runtime_events_v2(
           tenant_id,event_id,turn_id,publication_hash,event_kind,reason_code,
           question_digest,topic_ids,object_ids,detail
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)`,
        [
          input.tenantId,
          ulid(),
          input.turnId,
          input.publicationHash ?? null,
          input.eventKind,
          input.reasonCode,
          input.questionDigest,
          JSON.stringify(input.topicIds ?? []),
          JSON.stringify(input.objectIds ?? []),
          JSON.stringify(input.detail ?? {}),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort telemetry */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async execute(
    name: SemanticV2ToolName,
    rawInput: unknown,
    context: TrustedToolContext,
  ): Promise<SemanticV2ToolResult> {
    if (name === "get_semantic_context_v2") {
      const input = parseSemanticV2ToolInput(
        "get_semantic_context_v2",
        rawInput,
      );
      const [{ publicationHash, registry }, tenant] = await Promise.all([
        this.dependencies.publicationHashOverride
          ? loadSemanticRegistryV2(
              this.dependencies.controlPlanePool,
              this.dependencies.publicationHashOverride,
            )
          : loadActiveSemanticRegistryV2(this.dependencies.controlPlanePool),
        this.dependencies.contextProvider.load(context),
      ]);
      const [previousWorkspace, overlay, priorInsights] = await Promise.all([
        this.loadPreviousConversationWorkspace(context),
        this.loadOrCreateSemanticOverlay(context.tenantId, tenant),
        this.loadInsightLedger(context.tenantId),
      ]);
      const semanticContext = compileSemanticContext(
        registry,
        input.question,
        input.limit,
        tenant,
        publicationHash,
        overlay,
      );
      const topics = Array.isArray(semanticContext.topics)
        ? (semanticContext.topics as readonly Readonly<
            Record<string, unknown>
          >[])
        : [];
      if (
        topics.length === 0 ||
        topics.every((topic) => Number(topic.score ?? 0) === 0)
      ) {
        await this.recordRuntimeEvent({
          tenantId: context.tenantId,
          turnId: context.turnId,
          publicationHash,
          eventKind: "routing_miss",
          reasonCode: "NO_LEXICAL_TOPIC_MATCH",
          questionDigest: digest(input.question.trim().toLowerCase()),
          topicIds: topics.flatMap((topic) =>
            typeof topic.id === "string" ? [topic.id] : [],
          ),
          detail: { candidateCount: topics.length },
        }).catch(() => undefined);
      }
      return { ...semanticContext, previousWorkspace, priorInsights };
    }
    if (name === "continue_workspace_v2") {
      const input = parseSemanticV2ToolInput("continue_workspace_v2", rawInput);
      return this.continueWorkspace(input.sourceWorkspaceId, context);
    }
    if (name === "create_workspace_v2") {
      const input = parseSemanticV2ToolInput("create_workspace_v2", rawInput);
      const [{ publicationHash, registry }, tenant] = await Promise.all([
        this.dependencies.publicationHashOverride
          ? loadSemanticRegistryV2(
              this.dependencies.controlPlanePool,
              this.dependencies.publicationHashOverride,
            )
          : loadActiveSemanticRegistryV2(this.dependencies.controlPlanePool),
        this.dependencies.contextProvider.load(context),
      ]);
      const overlay = await this.loadOrCreateSemanticOverlay(
        context.tenantId,
        tenant,
      );
      const issues = this.validateBlocks(
        input.blocks,
        context.tenantId,
        publicationHash,
        overlay.overlayHash,
        registry,
        context.turnId,
      );
      if (issues.length)
        throw new SemanticV2ServiceError(
          "INVALID_WORKSPACE",
          "The proposed workspace is not valid for the active semantic publication.",
          422,
          { issues },
        );
      const workspace = await this.workspaces.create({
        tenantId: context.tenantId,
        questionId: context.turnId,
        publicationHash,
        overlayVersion: overlay.overlayHash,
        blocks: input.blocks,
      });
      return { workspace };
    }

    if (name === "create_investigation_v2")
      return this.createInvestigation(
        parseSemanticV2ToolInput("create_investigation_v2", rawInput),
        context,
      );
    if (name === "get_investigation_v2")
      return this.getInvestigation(
        parseSemanticV2ToolInput("get_investigation_v2", rawInput)
          .investigationId,
        context,
      );
    if (name === "update_investigation_v2")
      return this.updateInvestigation(
        parseSemanticV2ToolInput("update_investigation_v2", rawInput),
        context,
      );
    if (name === "run_analytical_operator_v2")
      return this.runOperator(
        parseSemanticV2ToolInput("run_analytical_operator_v2", rawInput),
        context,
      );
    if (name === "update_insight_v2")
      return this.updateInsight(
        parseSemanticV2ToolInput("update_insight_v2", rawInput),
        context,
      );
    if (name === "inspect_result_v2") {
      const input = parseSemanticV2ToolInput("inspect_result_v2", rawInput);
      return this.inspectResult(
        context.tenantId,
        context.conversationId,
        input.executionId,
        input.resultId,
        input.offset,
        input.limit,
      );
    }
    if (name === "apply_workspace_patch_v2") {
      const input = parseSemanticV2ToolInput(
        "apply_workspace_patch_v2",
        rawInput,
      );
      const workspace = await this.workspaces.load(
        context.tenantId,
        input.workspaceId,
      );
      this.assertCurrentTurnWorkspace(workspace, context);
      assertExpectedRevision(workspace.revision, input.patch.expectedRevision);
      return {
        workspace: await this.workspaces.applyPatch(
          context.tenantId,
          workspace.id,
          input.patch,
        ),
      };
    }

    const request =
      name === "validate_workspace_v2"
        ? {
            name,
            input: parseSemanticV2ToolInput("validate_workspace_v2", rawInput),
          }
        : name === "preview_workspace_v2"
          ? {
              name,
              input: parseSemanticV2ToolInput("preview_workspace_v2", rawInput),
            }
          : name === "execute_workspace_v2"
            ? {
                name,
                input: parseSemanticV2ToolInput(
                  "execute_workspace_v2",
                  rawInput,
                ),
              }
            : name === "fork_query_block_v2"
              ? {
                  name,
                  input: parseSemanticV2ToolInput(
                    "fork_query_block_v2",
                    rawInput,
                  ),
                }
              : null;
    if (!request)
      throw new SemanticV2ServiceError(
        "UNKNOWN_TOOL",
        `Unknown V2 semantic tool ${String(name)}.`,
        404,
      );
    const workspace = await this.workspaces.load(
      context.tenantId,
      request.input.workspaceId,
    );
    this.assertCurrentTurnWorkspace(workspace, context);
    assertExpectedRevision(workspace.revision, request.input.expectedRevision);

    const [{ registry }, tenant, overlay] = await Promise.all([
      loadSemanticRegistryV2(
        this.dependencies.controlPlanePool,
        workspace.publicationHash,
      ),
      this.dependencies.contextProvider.load(context),
      this.loadSemanticOverlay(context.tenantId, workspace.overlayVersion),
    ]);
    const connectionSet = [
      ...new Set(
        (tenant.sourceDetails ?? []).map(({ connectionId }) => connectionId),
      ),
    ].sort();
    if (request.name === "validate_workspace_v2") {
      const issues = validateWorkspaceAgainstRegistryV2(workspace, registry);
      if (issues.length) return { valid: false, issues, workspace };
      const compiled = compileQueryWorkspaceV2(
        workspace,
        registry,
        compilerContext(context.tenantId, overlay, connectionSet),
      );
      const validated = await this.workspaces.setStatus(
        context.tenantId,
        workspace.id,
        workspace.revision,
        "validated",
      );
      return {
        valid: true,
        issues: [],
        workspace: validated,
        preview: safePreview(compiled),
      };
    }
    if (request.name === "preview_workspace_v2") {
      const compiled = compileQueryWorkspaceV2(
        workspace,
        registry,
        compilerContext(context.tenantId, overlay, connectionSet),
      );
      return { workspace, preview: safePreview(compiled) };
    }
    if (request.name === "execute_workspace_v2")
      return this.executeWorkspace(
        workspace,
        registry,
        tenant,
        overlay,
        context,
      );
    return this.forkBlock(
      workspace,
      request.input.blockId,
      request.input.newBlockId,
      context,
    );
  }

  private validateBlocks(
    blocks: readonly QueryBlockV2[],
    tenantId: string,
    publicationHash: string,
    overlayVersion: string,
    registry: SemanticRegistryDocumentV2,
    questionId: string,
  ): readonly string[] {
    const timestamp = new Date().toISOString();
    return validateWorkspaceAgainstRegistryV2(
      {
        id: "candidate",
        tenantId,
        publicationHash,
        overlayVersion,
        revision: 1,
        questionId,
        blocks: [...blocks],
        status: "draft",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      registry,
    );
  }

  private async loadPreviousConversationWorkspace(
    context: TrustedToolContext,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, context.tenantId, true);
      const result = await client.query(
        `SELECT control_plane.load_previous_semantic_workspace_v2($1,$2,$3)
                  AS workspace`,
        [context.tenantId, context.conversationId, context.turnId],
      );
      await client.query("COMMIT");
      const workspace = result.rows[0]?.workspace;
      return workspace && typeof workspace === "object" && !Array.isArray(workspace)
        ? Object.freeze(workspace as Record<string, unknown>)
        : null;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async continueWorkspace(
    sourceWorkspaceId: string,
    context: TrustedToolContext,
  ): Promise<SemanticV2ToolResult> {
    const source = await this.workspaces.load(
      context.tenantId,
      sourceWorkspaceId,
    );
    if (source.status !== "executed")
      throw new SemanticV2ServiceError(
        "WORKSPACE_NOT_EXECUTED",
        "Only an executed workspace can seed a follow-up.",
        422,
      );
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, context.tenantId, true);
      const ownership = await client.query(
        `SELECT 1 FROM control_plane.conversation_turns
          WHERE tenant_id=$1 AND turn_id=$2 AND conversation_id=$3`,
        [context.tenantId, source.questionId, context.conversationId],
      );
      await client.query("COMMIT");
      if (!ownership.rows[0])
        throw new SemanticV2ServiceError(
          "WORKSPACE_CONVERSATION_MISMATCH",
          "The prior workspace does not belong to this conversation.",
          403,
        );
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
    const workspace = await this.workspaces.create({
      tenantId: context.tenantId,
      questionId: context.turnId,
      publicationHash: source.publicationHash,
      overlayVersion: source.overlayVersion,
      blocks: source.blocks,
      derivedFrom: { workspaceId: source.id, revision: source.revision },
    });
    return {
      workspace,
      derivedFromWorkspaceId: source.id,
      derivedFromRevision: source.revision,
    };
  }

  private async executeWorkspace(
    workspace: Awaited<ReturnType<PostgresQueryWorkspaceStoreV2["load"]>>,
    registry: SemanticRegistryDocumentV2,
    tenant: TenantSemanticContext,
    overlay: SemanticOverlaySnapshotV2,
    context: TrustedToolContext,
  ): Promise<SemanticV2ToolResult> {
    if (workspace.status === "executed")
      throw new SemanticV2ServiceError(
        "IMMUTABLE_EXECUTION",
        "This workspace revision has already executed. Create a follow-up workspace instead.",
        409,
      );
    const connectionSet = [
      ...new Set(
        (tenant.sourceDetails ?? []).map(({ connectionId }) => connectionId),
      ),
    ].sort();
    let compiled: CompiledWorkspaceV2;
    try {
      compiled = compileQueryWorkspaceV2(
        workspace,
        registry,
        compilerContext(context.tenantId, overlay, connectionSet),
      );
    } catch (error) {
      await this.recordRuntimeEvent({
        tenantId: context.tenantId,
        turnId: context.turnId,
        publicationHash: workspace.publicationHash,
        eventKind: "compilation_failure",
        reasonCode:
          error instanceof SemanticV2ServiceError
            ? error.code
            : "SEMANTIC_COMPILATION_FAILED",
        questionDigest: digest(context.turnId),
        topicIds: workspace.blocks.flatMap(({ topicIds }) => topicIds),
        objectIds: workspace.blocks.flatMap(({ dimensionIds, measureIds }) => [
          ...dimensionIds,
          ...measureIds,
        ]),
      }).catch(() => undefined);
      throw error;
    }
    // Budgets count logical semantic query blocks, not the independently
    // aggregated physical statements required to keep a composite block safe.
    const investigation = await this.reserveInvestigationRound(
      context,
      compiled.alignments.length,
    );
    const cacheKey = semanticResultCacheKeyV2({
      normalizedPlanHash: compiled.normalizedPlanHash,
      tenantId: context.tenantId,
      connectionSet,
      publicationHash: workspace.publicationHash,
      overlayVersion: workspace.overlayVersion,
      sourceWatermarks: tenant.sourceWatermarks,
    });
    await this.workspaces.setStatus(
      context.tenantId,
      workspace.id,
      workspace.revision,
      "validated",
    );
    try {
      const cached = await this.evidence.loadCachedExecution(
        context.tenantId,
        cacheKey,
      );
      if (cached) {
        const execution = rebindCachedExecutionV2(cached.execution);
        await this.evidence.persistExecution({
          tenantId: context.tenantId,
          workspaceId: workspace.id,
          workspaceRevision: workspace.revision,
          execution,
          compiled,
          cacheKey,
          cachedFromExecutionId: cached.originExecutionId,
        });
        const executedWorkspace = await this.workspaces.setStatus(
          context.tenantId,
          workspace.id,
          workspace.revision,
          "executed",
        );
        return {
          workspace: executedWorkspace,
          execution,
          investigation,
          cache: {
            hit: true,
            key: cacheKey,
            originExecutionId: cached.originExecutionId,
          },
        };
      }
      const execution = await executeCompiledWorkspaceV2(
        compiled,
        this.dependencies.database,
        {
          tenantId: context.tenantId,
          workspaceId: workspace.id,
          conversationId: context.conversationId,
          turnId: context.turnId,
          statementTimeoutMs: this.dependencies.statementTimeoutMs ?? 30_000,
          maxPostgresCost: this.dependencies.maxPostgresCost ?? 50_000,
          sourceWatermarks: tenant.sourceWatermarks,
          timezone: overlay.timezone,
          cacheKey,
        },
        this.evidence,
      );
      await this.evidence.persistCache({
        tenantId: context.tenantId,
        cacheKey,
        publicationHash: workspace.publicationHash,
        overlayVersion: workspace.overlayVersion,
        normalizedPlanHash: compiled.normalizedPlanHash,
        connectionSet,
        sourceWatermarks: tenant.sourceWatermarks,
        execution,
      });
      const executedWorkspace = await this.workspaces.setStatus(
        context.tenantId,
        workspace.id,
        workspace.revision,
        "executed",
      );
      return {
        workspace: executedWorkspace,
        execution,
        investigation,
        cache: { hit: false, key: cacheKey },
      };
    } catch (error) {
      await this.workspaces
        .setStatus(context.tenantId, workspace.id, workspace.revision, "failed")
        .catch(() => undefined);
      await this.recordRuntimeEvent({
        tenantId: context.tenantId,
        turnId: context.turnId,
        publicationHash: workspace.publicationHash,
        eventKind: "execution_failure",
        reasonCode: "SEMANTIC_EXECUTION_FAILED",
        questionDigest: digest(context.turnId),
        topicIds: workspace.blocks.flatMap(({ topicIds }) => topicIds),
        detail: {
          errorClass:
            error instanceof Error ? error.name.slice(0, 120) : "unknown",
        },
      }).catch(() => undefined);
      throw error;
    }
  }

  private async reserveInvestigationRound(
    context: TrustedToolContext,
    queryCount: number,
  ): Promise<Readonly<Record<string, unknown>>> {
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, context.tenantId);
      const result = await client.query(
        `SELECT investigation_id,revision,status,plan,created_at
         FROM control_plane.investigation_plans_v2
         WHERE tenant_id=$1 AND turn_id=$2
         FOR UPDATE`,
        [context.tenantId, context.turnId],
      );
      const row = result.rows[0] as
        | {
            investigation_id: string;
            revision: number;
            status: string;
            plan: InvestigationPlanV2;
            created_at: string;
          }
        | undefined;
      if (!row)
        throw new SemanticV2ServiceError(
          "INVESTIGATION_REQUIRED",
          "Create one InvestigationPlanV2 before executing a workspace.",
          422,
        );
      const plan = row.plan;
      const elapsedMs = Date.now() - new Date(row.created_at).getTime();
      const nextRounds = plan.roundsUsed + 1;
      const nextQueries = plan.queriesUsed + queryCount;
      if (row.status === "sufficient" || row.status === "inconclusive")
        throw new SemanticV2ServiceError(
          "INVESTIGATION_FINISHED",
          "This investigation has already reached a terminal analytical state.",
          409,
        );
      if (
        nextRounds > plan.queryBudget.maxRounds ||
        nextQueries > plan.queryBudget.maxQueries ||
        elapsedMs > plan.queryBudget.maxDurationMs
      ) {
        throw new SemanticV2ServiceError(
          "INVESTIGATION_BUDGET_EXHAUSTED",
          "The server-owned investigation budget does not permit this execution.",
          422,
          {
            roundsUsed: plan.roundsUsed,
            queriesUsed: plan.queriesUsed,
            requestedQueries: queryCount,
            elapsedMs,
            budget: plan.queryBudget,
          },
        );
      }
      const updated = {
        ...plan,
        status: "running" as const,
        roundsUsed: nextRounds,
        queriesUsed: nextQueries,
      };
      const revision = row.revision + 1;
      await client.query(
        `UPDATE control_plane.investigation_plans_v2
         SET revision=$3,status='running',plan=$4::jsonb,updated_at=now()
         WHERE tenant_id=$1 AND investigation_id=$2`,
        [
          context.tenantId,
          row.investigation_id,
          revision,
          JSON.stringify(updated),
        ],
      );
      await client.query(
        `INSERT INTO control_plane.investigation_plan_revisions_v2(
           tenant_id,investigation_id,revision,status,plan,plan_digest
         ) VALUES ($1,$2,$3,'running',$4::jsonb,$5)`,
        [
          context.tenantId,
          row.investigation_id,
          revision,
          JSON.stringify(updated),
          digest(updated),
        ],
      );
      await client.query("COMMIT");
      return Object.freeze({
        investigationId: row.investigation_id,
        revision,
        status: updated.status,
        roundsUsed: updated.roundsUsed,
        queriesUsed: updated.queriesUsed,
        budget: updated.queryBudget,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async forkBlock(
    workspace: Awaited<ReturnType<PostgresQueryWorkspaceStoreV2["load"]>>,
    blockId: string,
    newBlockId: string,
    context: TrustedToolContext,
  ): Promise<SemanticV2ToolResult> {
    const source = workspace.blocks.find(({ id }) => id === blockId);
    if (!source)
      throw new SemanticV2ServiceError(
        "UNKNOWN_QUERY_BLOCK",
        `Query block ${blockId} does not exist.`,
        404,
      );
    const block = { ...structuredClone(source), id: newBlockId };
    if (workspace.status === "executed") {
      const followUp = await this.workspaces.create({
        tenantId: context.tenantId,
        questionId: context.turnId,
        publicationHash: workspace.publicationHash,
        overlayVersion: workspace.overlayVersion,
        blocks: [...workspace.blocks, block],
        derivedFrom: {
          workspaceId: workspace.id,
          revision: workspace.revision,
        },
      });
      return { workspace: followUp, derivedFromWorkspaceId: workspace.id };
    }
    return {
      workspace: await this.workspaces.applyPatch(
        context.tenantId,
        workspace.id,
        {
          expectedRevision: workspace.revision,
          operations: [{ op: "add_block", block }],
        },
      ),
    };
  }

  private async inspectResult(
    tenantId: string,
    conversationId: string,
    executionId: string,
    resultId: string,
    offset: number,
    limit: number,
  ): Promise<SemanticV2ToolResult> {
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, tenantId, true);
      const result = await client.query(
        `SELECT e.artifact FROM control_plane.evidence_artifacts_v2 e
         JOIN control_plane.query_execution_snapshots_v2 s USING (tenant_id,execution_id)
         JOIN control_plane.query_workspaces_v2 w USING (tenant_id,workspace_id)
         JOIN control_plane.conversation_turns t
           ON t.tenant_id=w.tenant_id AND t.turn_id=w.question_id
         WHERE e.tenant_id=$1 AND e.execution_id=$2 AND e.evidence_type='result'
           AND e.artifact->>'queryId'=$3 AND t.conversation_id=$4
         ORDER BY e.created_at LIMIT 1`,
        [tenantId, executionId, resultId, conversationId],
      );
      await client.query("COMMIT");
      const artifact = result.rows[0]?.artifact as
        Record<string, unknown> | undefined;
      if (!artifact)
        throw new SemanticV2ServiceError(
          "RESULT_NOT_FOUND",
          `Result ${resultId} was not found in execution ${executionId}.`,
          404,
        );
      const rows = Array.isArray(artifact.rows) ? artifact.rows : [];
      return {
        resultId,
        executionId,
        offset,
        limit,
        totalRows: rows.length,
        rows: rows.slice(offset, offset + limit),
        evidence: artifact.evidence ?? null,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async createInvestigation(
    input: SemanticV2ToolInput<"create_investigation_v2">,
    context: TrustedToolContext,
  ): Promise<SemanticV2ToolResult> {
    const plan = createInvestigationPlanV2({
      ...input,
      id: ulid(),
      status: "draft",
    }) as InvestigationPlanV2;
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, context.tenantId);
      const planDigest = digest(plan);
      await client.query(
        `INSERT INTO control_plane.investigation_plans_v2(
           tenant_id,investigation_id,conversation_id,turn_id,objective,question_class,revision,status,plan
         ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8::jsonb)`,
        [
          context.tenantId,
          plan.id,
          context.conversationId,
          context.turnId,
          plan.objective,
          plan.questionClass,
          plan.status,
          JSON.stringify(plan),
        ],
      );
      await client.query(
        `INSERT INTO control_plane.investigation_plan_revisions_v2(
           tenant_id,investigation_id,revision,status,plan,plan_digest
         ) VALUES ($1,$2,1,$3,$4::jsonb,$5)`,
        [
          context.tenantId,
          plan.id,
          plan.status,
          JSON.stringify(plan),
          planDigest,
        ],
      );
      await client.query("COMMIT");
      return { investigation: plan, planDigest };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async getInvestigation(
    investigationId: string,
    context: TrustedToolContext,
  ): Promise<SemanticV2ToolResult> {
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, context.tenantId, true);
      const result = await client.query(
        `SELECT revision,status,plan,created_at,updated_at
         FROM control_plane.investigation_plans_v2
         WHERE tenant_id=$1 AND investigation_id=$2 AND turn_id=$3`,
        [context.tenantId, investigationId, context.turnId],
      );
      await client.query("COMMIT");
      const row = result.rows[0] as
        | {
            revision: number;
            status: string;
            plan: InvestigationPlanV2;
            created_at: string;
            updated_at: string;
          }
        | undefined;
      if (!row)
        throw new SemanticV2ServiceError(
          "INVESTIGATION_NOT_FOUND",
          `Investigation ${investigationId} was not found for this turn.`,
          404,
        );
      return {
        investigation: row.plan,
        revision: row.revision,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async updateInvestigation(
    input: SemanticV2ToolInput<"update_investigation_v2">,
    context: TrustedToolContext,
  ): Promise<SemanticV2ToolResult> {
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, context.tenantId);
      const result = await client.query(
        `SELECT revision,status,plan
         FROM control_plane.investigation_plans_v2
         WHERE tenant_id=$1 AND investigation_id=$2 AND turn_id=$3
         FOR UPDATE`,
        [context.tenantId, input.investigationId, context.turnId],
      );
      const row = result.rows[0] as
        | {
            revision: number;
            status: InvestigationPlanV2["status"];
            plan: InvestigationPlanV2;
          }
        | undefined;
      if (!row)
        throw new SemanticV2ServiceError(
          "INVESTIGATION_NOT_FOUND",
          `Investigation ${input.investigationId} was not found.`,
          404,
        );
      assertExpectedRevision(row.revision, input.expectedRevision);
      if (row.status === "sufficient" || row.status === "inconclusive")
        throw new SemanticV2ServiceError(
          "INVESTIGATION_FINISHED",
          "A completed investigation is immutable.",
          409,
        );
      const plan = structuredClone(row.plan) as InvestigationPlanV2;
      for (const operation of input.operations) {
        if (operation.op === "resolve_definition") {
          const requirement = plan.definitionsToResolve.find(
            ({ id }) => id === operation.requirementId,
          );
          if (!requirement)
            throw new SemanticV2ServiceError(
              "UNKNOWN_DEFINITION_REQUIREMENT",
              `Unknown definition requirement ${operation.requirementId}.`,
              422,
            );
          requirement.status = operation.defaulted ? "defaulted" : "resolved";
          requirement.selectedDefinitionId = operation.selectedDefinitionId;
        } else if (operation.op === "set_hypothesis_status") {
          const hypothesis = plan.hypotheses.find(
            ({ id }) => id === operation.hypothesisId,
          );
          if (!hypothesis)
            throw new SemanticV2ServiceError(
              "UNKNOWN_HYPOTHESIS",
              `Unknown hypothesis ${operation.hypothesisId}.`,
              422,
            );
          hypothesis.status = operation.status;
        } else if (operation.op === "set_evidence_status") {
          const node = plan.evidenceNodes.find(
            ({ id }) => id === operation.evidenceNodeId,
          );
          if (!node)
            throw new SemanticV2ServiceError(
              "UNKNOWN_EVIDENCE_NODE",
              `Unknown evidence node ${operation.evidenceNodeId}.`,
              422,
            );
          if (operation.workspaceId) {
            const workspace = await client.query(
              `SELECT 1 FROM control_plane.query_workspaces_v2 WHERE tenant_id=$1 AND workspace_id=$2 AND question_id=$3`,
              [context.tenantId, operation.workspaceId, context.turnId],
            );
            if (!workspace.rows[0])
              throw new SemanticV2ServiceError(
                "WORKSPACE_NOT_FOUND",
                `Workspace ${operation.workspaceId} is not part of this turn.`,
                422,
              );
          }
          if (operation.resultRefs.length) {
            const requested = operation.resultRefs.map(
              ({ executionId, resultId }) => `${executionId}:${resultId}`,
            );
            const evidence = await client.query(
              `SELECT DISTINCT e.execution_id,e.artifact->>'queryId' AS result_id
               FROM control_plane.evidence_artifacts_v2 e
               JOIN control_plane.query_execution_snapshots_v2 s USING (tenant_id,execution_id)
               JOIN control_plane.query_workspaces_v2 w USING (tenant_id,workspace_id)
               WHERE e.tenant_id=$1 AND w.question_id=$2 AND e.evidence_type='result'
                 AND (e.execution_id||':'||(e.artifact->>'queryId'))=ANY($3::text[])`,
              [context.tenantId, context.turnId, requested],
            );
            const found = new Set(
              evidence.rows.map(
                (item) =>
                  `${String(item.execution_id)}:${String(item.result_id)}`,
              ),
            );
            const missing = requested.filter((id: string) => !found.has(id));
            if (missing.length)
              throw new SemanticV2ServiceError(
                "EVIDENCE_NOT_FOUND",
                "Investigation nodes may reference only persisted results from this turn.",
                422,
                { missing },
              );
          }
          if (operation.operatorArtifactId) {
            const operator = await client.query(
              `SELECT e.artifact->>'operatorId' AS operator_id
                 FROM control_plane.evidence_artifacts_v2 e
                 JOIN control_plane.query_execution_snapshots_v2 s USING (tenant_id,execution_id)
                 JOIN control_plane.query_workspaces_v2 w USING (tenant_id,workspace_id)
                WHERE e.tenant_id=$1 AND e.evidence_id=$2 AND e.evidence_type='operator'
                  AND w.question_id=$3`,
              [context.tenantId, operation.operatorArtifactId, context.turnId],
            );
            if (!operator.rows[0])
              throw new SemanticV2ServiceError(
                "OPERATOR_EVIDENCE_NOT_FOUND",
                "Investigation nodes may reference only persisted operator evidence from this turn.",
                422,
              );
            if (
              !node.operatorId ||
              String(operator.rows[0].operator_id) !== node.operatorId
            )
              throw new SemanticV2ServiceError(
                "OPERATOR_EVIDENCE_MISMATCH",
                "The persisted operator artifact does not match the evidence node's declared analytical operator.",
                422,
              );
          }
          if (
            operation.status === "succeeded" &&
            operation.resultRefs.length === 0 &&
            !operation.operatorArtifactId
          ) {
            throw new SemanticV2ServiceError(
              "EVIDENCE_REQUIRED",
              "A succeeded investigation node requires persisted result or operator evidence.",
              422,
            );
          }
          node.status = operation.status;
          if (operation.workspaceId) node.workspaceId = operation.workspaceId;
          if (operation.operatorArtifactId)
            node.operatorArtifactId = operation.operatorArtifactId;
          node.resultRefs = operation.resultRefs.map((reference) => ({
            ...reference,
          }));
        } else if (operation.op === "set_status") {
          if (operation.status === "sufficient") {
            const unresolvedMaterial = plan.definitionsToResolve.some(
              ({ material, status }) => material && status === "unresolved",
            );
            const pendingEvidence = plan.evidenceNodes.some(({ status }) =>
              ["pending", "ready", "running"].includes(status),
            );
            if (unresolvedMaterial || pendingEvidence)
              throw new SemanticV2ServiceError(
                "INVESTIGATION_INCOMPLETE",
                "A sufficient investigation cannot retain unresolved material definitions or unfinished evidence nodes.",
                422,
              );
          }
          plan.status = operation.status;
        }
      }
      const revision = row.revision + 1;
      const updated = investigationPlanV2Schema.parse(plan);
      const planDigest = digest(updated);
      await client.query(
        `UPDATE control_plane.investigation_plans_v2
         SET revision=$3,status=$4,plan=$5::jsonb,updated_at=now()
         WHERE tenant_id=$1 AND investigation_id=$2`,
        [
          context.tenantId,
          input.investigationId,
          revision,
          updated.status,
          JSON.stringify(updated),
        ],
      );
      await client.query(
        `INSERT INTO control_plane.investigation_plan_revisions_v2(
           tenant_id,investigation_id,revision,status,plan,plan_digest
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [
          context.tenantId,
          input.investigationId,
          revision,
          updated.status,
          JSON.stringify(updated),
          planDigest,
        ],
      );
      await client.query("COMMIT");
      return { investigation: updated, revision, planDigest };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async runOperator(
    input: SemanticV2ToolInput<"run_analytical_operator_v2">,
    context: TrustedToolContext,
  ): Promise<SemanticV2ToolResult> {
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, context.tenantId, true);
      const requested = input.bindings.map(
        (binding: OperatorBindingInput) =>
          `${binding.executionId}:${binding.resultId}`,
      );
      const evidence = await client.query(
        `SELECT e.execution_id,e.artifact->>'queryId' AS result_id,e.artifact,
                s.publication_hash,w.overlay_version
         FROM control_plane.evidence_artifacts_v2 e
         JOIN control_plane.query_execution_snapshots_v2 s
           ON s.tenant_id=e.tenant_id AND s.execution_id=e.execution_id
         JOIN control_plane.query_workspaces_v2 w
           ON w.tenant_id=s.tenant_id AND w.workspace_id=s.workspace_id
         WHERE e.tenant_id=$1 AND e.evidence_type='result'
           AND (e.execution_id||':'||(e.artifact->>'queryId'))=ANY($2::text[])
           AND w.question_id=$3`,
        [context.tenantId, requested, context.turnId],
      );
      await client.query("COMMIT");
      const found = new Map(
        evidence.rows.map((row) => [
          `${String(row.execution_id)}:${String(row.result_id)}`,
          row,
        ]),
      );
      const missing = requested.filter((id: string) => !found.has(id));
      if (missing.length)
        throw new SemanticV2ServiceError(
          "EVIDENCE_NOT_FOUND",
          "An analytical operator may only use persisted governed results.",
          422,
          { missing },
        );
      const publications = new Set(
        evidence.rows.map((row) => String(row.publication_hash)),
      );
      if (publications.size !== 1)
        throw new SemanticV2ServiceError(
          "CROSS_PUBLICATION_OPERATOR",
          "Operator inputs must belong to one immutable semantic publication.",
          422,
        );
      const overlayVersions = new Set(
        evidence.rows.map((row) => String(row.overlay_version)),
      );
      if (overlayVersions.size !== 1)
        throw new SemanticV2ServiceError(
          "CROSS_OVERLAY_OPERATOR",
          "Operator inputs must belong to one immutable business-context overlay.",
          422,
        );
      const bindings = input.bindings.map(
        (binding: OperatorBindingInput): ResolvedOperatorBinding => {
          const row = found.get(`${binding.executionId}:${binding.resultId}`)!;
          const artifact = row.artifact as Record<string, unknown>;
          if (!Array.isArray(artifact.rows))
            throw new SemanticV2ServiceError(
              "INVALID_RESULT_ARTIFACT",
              `Result ${binding.resultId} has no immutable row set.`,
              500,
            );
          return {
            ...binding,
            rows: artifact.rows as readonly Readonly<Record<string, unknown>>[],
            publicationHash: String(row.publication_hash),
          };
        },
      );
      const overlay = await this.loadSemanticOverlay(
        context.tenantId,
        [...overlayVersions][0]!,
      );
      const operatorInput = compileOperatorInput(
        input.operatorId,
        bindings,
        overlay,
      );
      const sourceReferences = [
        ...new Set(
          bindings.map(
            (binding: ResolvedOperatorBinding) =>
              `${binding.executionId}:${binding.resultId}`,
          ),
        ),
      ];
      const artifact = runAnalyticalOperatorV2(operatorInput, sourceReferences);
      const anchorExecutionId = bindings[0]!.executionId;
      const operatorArtifactId = ulid();
      const storedArtifact = {
        ...artifact,
        operatorArtifactId,
        sourceReferences,
        publicationHash: [...publications][0],
      };
      const evidenceDigest = digest(storedArtifact);
      const write = await this.dependencies.controlPlanePool.connect();
      try {
        await beginSemanticV2Tenant(write, context.tenantId);
        await write.query(
          `INSERT INTO control_plane.evidence_artifacts_v2(
             tenant_id,evidence_id,execution_id,evidence_type,artifact,artifact_digest
           ) VALUES ($1,$2,$3,'operator',$4::jsonb,$5)`,
          [
            context.tenantId,
            operatorArtifactId,
            anchorExecutionId,
            JSON.stringify(storedArtifact),
            evidenceDigest,
          ],
        );
        await write.query("COMMIT");
      } catch (error) {
        try {
          await write.query("ROLLBACK");
        } catch {
          /* preserve original error */
        }
        throw error;
      } finally {
        write.release();
      }
      return { artifact: { ...storedArtifact, evidenceDigest } };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async updateInsight(
    input: SemanticV2ToolInput<"update_insight_v2">,
    context: TrustedToolContext,
  ): Promise<SemanticV2ToolResult> {
    const client = await this.dependencies.controlPlanePool.connect();
    try {
      await beginSemanticV2Tenant(client, context.tenantId);
      const result = await client.query(
        `UPDATE control_plane.insight_ledger_v2
            SET state=$4,
                disposition_at=now(),
                associated_action=COALESCE($5,associated_action),
                user_note=COALESCE($6,user_note),
                outcome=COALESCE($7::jsonb,outcome)
          WHERE tenant_id=$1 AND insight_key=$2 AND state=$3
          RETURNING insight_key,state,disposition_at,associated_action,user_note,outcome`,
        [
          context.tenantId,
          input.insightKey,
          input.expectedState,
          input.state,
          input.associatedAction ?? null,
          input.userNote ?? null,
          input.outcome ? JSON.stringify(input.outcome) : null,
        ],
      );
      if (!result.rows[0])
        throw new SemanticV2ServiceError(
          "INSIGHT_STATE_CONFLICT",
          "The insight was not found or its state changed; refresh semantic context before updating it.",
          409,
        );
      await client.query("COMMIT");
      const row = result.rows[0];
      return Object.freeze({
        insightKey: row.insight_key,
        state: row.state,
        dispositionAt: new Date(String(row.disposition_at)).toISOString(),
        associatedAction: row.associated_action,
        userNote: row.user_note,
        outcome: row.outcome,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
