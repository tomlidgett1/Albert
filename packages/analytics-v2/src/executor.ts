import { createHash } from "node:crypto";
import { ulid } from "ulid";
import {
  SOURCE_ROW_COUNT_COLUMN_V2,
  type CompiledAggregateQueryV2,
  type CompiledWorkspaceV2,
} from "../../compiler/src/v2.js";
import type { DatabaseResult, SemanticReadDatabase } from "../../../services/semantic-query/src/types.js";
import type { GroundedClaimV2, ResultEvidenceV2 } from "./evidence.js";

type Row = Readonly<Record<string, unknown>>;

export type ExecutedQueryV2 = Readonly<{
  queryId: string;
  period: "current" | "comparison";
  topicIds: readonly string[];
  dimensionIds: readonly string[];
  measureIds: readonly string[];
  resultColumns: readonly string[];
  timeRange: Readonly<{ label: string; start: string; end: string; timezone: string }>;
  rows: readonly Row[];
  durationMs: number;
  explainCost: number;
  resultDigest: string;
  evidence: ResultEvidenceV2;
}>;

export type ExecutedBlockV2 = Readonly<{
  blockId: string;
  currentRows: readonly Row[];
  comparisonRows: readonly Row[];
  dimensionIds: readonly string[];
  state: "verified" | "derived" | "exploratory" | "no_data";
}>;

export type ExecutedWorkspaceV2 = Readonly<{
  executionId: string;
  normalizedPlanHash: string;
  terminalState: "verified" | "derived" | "exploratory" | "no_data" | "unavailable";
  queries: readonly ExecutedQueryV2[];
  blocks: readonly ExecutedBlockV2[];
  claims: readonly GroundedClaimV2[];
  resultDigest: string;
  sourceWatermarks: Readonly<Record<string, string>>;
  timezone?: string;
  validation: Readonly<{
    passed: boolean;
    explainCostPassed: boolean;
    tenantIsolationPassed: boolean;
    fanoutSafetyPassed: boolean;
    evidenceComplete: boolean;
    cacheHit: boolean;
  }>;
}>;

export interface EvidenceArtifactStoreV2 {
  persistExecution(input: Readonly<{
    tenantId: string;
    workspaceId: string;
    workspaceRevision: number;
    execution: ExecutedWorkspaceV2;
    compiled: CompiledWorkspaceV2;
    cacheKey: string;
    cachedFromExecutionId?: string;
  }>): Promise<void>;
}

export type ExecuteWorkspaceContextV2 = Readonly<{
  tenantId: string;
  workspaceId: string;
  conversationId: string;
  turnId: string;
  statementTimeoutMs: number;
  maxPostgresCost: number;
  sourceWatermarks: Readonly<Record<string, string>>;
  timezone?: string;
  claims?: readonly GroundedClaimV2[];
  cacheKey: string;
}>;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stable(entry)]));
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function planCost(rows: readonly Row[]): number {
  const raw = rows[0]?.["QUERY PLAN"] ?? rows[0]?.query_plan;
  const value = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  const root = Array.isArray(value) ? value[0] : value;
  if (!root || typeof root !== "object") throw new Error("EXPLAIN did not return a PostgreSQL JSON plan.");
  const plan = (root as Record<string, unknown>).Plan;
  if (!plan || typeof plan !== "object") throw new Error("EXPLAIN JSON has no root plan.");
  const cost = Number((plan as Record<string, unknown>)["Total Cost"]);
  if (!Number.isFinite(cost) || cost < 0) throw new Error("EXPLAIN JSON has an invalid total cost.");
  return cost;
}

function stateRank(state: "verified" | "derived" | "exploratory"): number {
  return state === "verified" ? 2 : state === "derived" ? 1 : 0;
}

function weakest(states: readonly ("verified" | "derived" | "exploratory")[]): "verified" | "derived" | "exploratory" {
  return states.reduce((current, state) => stateRank(state) < stateRank(current) ? state : current, "verified");
}

function key(row: Row, dimensions: readonly string[]): string {
  return JSON.stringify(dimensions.map((dimension) => row[dimension] ?? null));
}

function align(resultSets: readonly Readonly<{ rows: readonly Row[]; query: CompiledAggregateQueryV2 }>[], dimensions: readonly string[]): readonly Row[] {
  const aligned = new Map<string, Record<string, unknown>>();
  for (const { rows, query } of resultSets) {
    const seen = new Set<string>();
    for (const row of rows) {
      const rowKey = key(row, dimensions);
      if (seen.has(rowKey)) throw new Error(`Query ${query.queryId} returned duplicate rows at its declared aggregate grain.`);
      seen.add(rowKey);
      const current = aligned.get(rowKey) ?? Object.fromEntries(dimensions.map((dimension) => [dimension, row[dimension] ?? null]));
      for (const measureId of query.normalizedPlan.measureIds) current[measureId] = row[measureId] ?? null;
      aligned.set(rowKey, current);
    }
  }
  return Object.freeze([...aligned.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, row]) => Object.freeze(row)));
}

function materializeOne(
  query: CompiledAggregateQueryV2,
  context: ExecuteWorkspaceContextV2,
  publicationHash: string,
  executionId: string,
  result: Readonly<{ rows: readonly Row[]; durationMs: number }>,
  explainCost: number,
): ExecutedQueryV2 {
  if (query.parameters[0] !== context.tenantId) throw new Error(`Query ${query.queryId} does not bind the trusted tenant as parameter one.`);
  const sourceRows = result.rows[0]?.[SOURCE_ROW_COUNT_COLUMN_V2];
  const sourceRowCount = typeof sourceRows === "number"
    ? sourceRows
    : typeof sourceRows === "string" && /^\d+$/u.test(sourceRows)
      ? Number(sourceRows)
      : undefined;
  const noSourceRows = query.normalizedPlan.dimensionIds.length === 0
    && result.rows.length === 1
    && sourceRowCount === 0;
  const rows = noSourceRows
    ? []
    : result.rows.map((row) => Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== SOURCE_ROW_COUNT_COLUMN_V2),
      ));
  const resultDigest = digest({ columns: query.resultColumns, rows });
  return Object.freeze({
    queryId: query.queryId,
    period: query.period,
    topicIds: query.normalizedPlan.topicIds,
    dimensionIds: query.normalizedPlan.dimensionIds,
    measureIds: query.normalizedPlan.measureIds,
    resultColumns: query.resultColumns,
    timeRange: Object.freeze({
      label: `${query.normalizedPlan.resolvedTime.fromBusinessDate} to ${query.normalizedPlan.resolvedTime.toBusinessDate}`,
      start: query.normalizedPlan.resolvedTime.from,
      end: query.normalizedPlan.resolvedTime.to,
      timezone: context.timezone ?? "UTC",
    }),
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
    durationMs: result.durationMs,
    explainCost,
    resultDigest,
    evidence: Object.freeze({
      executionId,
      resultId: query.queryId,
      state: rows.length === 0 ? "no_data" : query.semanticState,
      rowCount: rows.length,
      validationPassed: true,
      publicationHash,
      limitations: [],
    }),
  });
}

export async function executeCompiledWorkspaceV2(
  compiled: CompiledWorkspaceV2,
  database: SemanticReadDatabase,
  context: ExecuteWorkspaceContextV2,
  artifactStore?: EvidenceArtifactStoreV2,
): Promise<ExecutedWorkspaceV2> {
  const executionId = ulid();
  const capabilityEvidence = { conversationId: context.conversationId, turnId: context.turnId };
  const explainCosts = await Promise.all(compiled.queries.map(async (query) => {
    const explained = await database.queryAsSemanticRole({
      tenantId: context.tenantId,
      sql: `EXPLAIN (FORMAT JSON) ${query.sql}`,
      parameters: query.parameters,
      statementTimeoutMs: Math.min(context.statementTimeoutMs, 5_000),
      capabilityEvidence,
    });
    const cost = planCost(explained.rows);
    if (cost > context.maxPostgresCost) throw new Error(`Query ${query.queryId} PostgreSQL cost ${cost} exceeds ${context.maxPostgresCost}.`);
    return cost;
  }));
  let rawResults: readonly DatabaseResult[];
  if (compiled.queries.length === 1) {
    rawResults = [await database.queryAsSemanticRole({
      tenantId: context.tenantId,
      sql: compiled.queries[0]!.sql,
      parameters: compiled.queries[0]!.parameters,
      statementTimeoutMs: context.statementTimeoutMs,
      capabilityEvidence,
    })];
  } else {
    if (!database.queryBatchAsSemanticRole) throw new Error("The analytical database cannot guarantee a shared repeatable-read snapshot for this multi-query workspace.");
    rawResults = await database.queryBatchAsSemanticRole({
      tenantId: context.tenantId,
      statements: compiled.queries.map(({ sql, parameters }) => ({ sql, parameters })),
      statementTimeoutMs: context.statementTimeoutMs,
      capabilityEvidence,
    });
    if (rawResults.length !== compiled.queries.length) throw new Error("The analytical database returned an incomplete semantic query batch.");
  }
  const queries = compiled.queries.map((query, index) => materializeOne(query, context, compiled.publicationHash, executionId, rawResults[index]!, explainCosts[index]!));
  const byQuery = new Map(queries.map((result) => [result.queryId, result]));
  const blocks = compiled.alignments.map((alignment) => {
    const current = alignment.queryIds.map((id) => ({ query: compiled.queries.find(({ queryId }) => queryId === id)!, rows: byQuery.get(id)?.rows ?? [] }));
    const comparison = current.map(({ query }) => {
      const candidateId = query.queryId.replace(/\.current$/u, ".comparison");
      const candidate = compiled.queries.find(({ queryId }) => queryId === candidateId);
      return candidate ? { query: candidate, rows: byQuery.get(candidateId)?.rows ?? [] } : null;
    }).filter((value): value is NonNullable<typeof value> => value !== null);
    const currentRows = align(current, alignment.dimensionIds);
    const comparisonRows = align(comparison, alignment.dimensionIds);
    const states = current.map(({ query }) => query.semanticState);
    return Object.freeze({
      blockId: alignment.blockId,
      currentRows,
      comparisonRows,
      dimensionIds: alignment.dimensionIds,
      state: currentRows.length === 0 && comparisonRows.length === 0 ? "no_data" as const : weakest(states),
    });
  });
  const allEmpty = blocks.every(({ state }) => state === "no_data");
  const terminalState = allEmpty ? "no_data" as const : weakest(compiled.queries.map(({ semanticState }) => semanticState));
  const claims = Object.freeze([...(context.claims ?? [])]);
  const execution: ExecutedWorkspaceV2 = Object.freeze({
    executionId,
    normalizedPlanHash: compiled.normalizedPlanHash,
    terminalState,
    queries: Object.freeze(queries),
    blocks: Object.freeze(blocks),
    claims,
    resultDigest: digest({ blocks, claims }),
    sourceWatermarks: Object.freeze({ ...context.sourceWatermarks }),
    validation: Object.freeze({ passed: true, explainCostPassed: true, tenantIsolationPassed: true, fanoutSafetyPassed: true, evidenceComplete: true, cacheHit: false }),
  });
  if (artifactStore) await artifactStore.persistExecution({ tenantId: context.tenantId, workspaceId: context.workspaceId, workspaceRevision: compiled.workspaceRevision, execution, compiled, cacheKey: context.cacheKey });
  return execution;
}

export function rebindCachedExecutionV2(source: ExecutedWorkspaceV2, executionId = ulid()): ExecutedWorkspaceV2 {
  return Object.freeze({
    ...source,
    executionId,
    queries: Object.freeze(source.queries.map((query) => Object.freeze({
      ...query,
      rows: Object.freeze(query.rows.map((row) => Object.freeze({ ...row }))),
      evidence: Object.freeze({ ...query.evidence, executionId }),
    }))),
    blocks: Object.freeze(source.blocks.map((block) => Object.freeze({ ...block }))),
    claims: Object.freeze([]),
    sourceWatermarks: Object.freeze({ ...source.sourceWatermarks }),
    validation: Object.freeze({ ...source.validation, cacheHit: true }),
  });
}
