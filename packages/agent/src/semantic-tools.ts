import { z } from "zod";
import {
  compositeSemanticQuerySchema,
  queryFilterSchema,
  singleSemanticQuerySchema,
  type SemanticQuery,
} from "../../compiler/src/index.js";
import type {
  TraceCell,
  TraceProvenance,
  TraceTableColumn,
} from "../../shared/src/index.js";

/** Tools that cross the signed semantic-service boundary. */
export const REMOTE_SEMANTIC_AGENT_TOOL_NAMES = [
  "search_catalogue",
  "get_definition",
  "get_capabilities",
  "list_field_values",
  "run_semantic_query",
  "run_source_query",
  "get_data_health",
  "remember",
] as const;
export type RemoteSemanticAgentToolName = (typeof REMOTE_SEMANTIC_AGENT_TOOL_NAMES)[number];

/** Local presentation/interaction tools are never sent to the query service. */
export const LOCAL_SEMANTIC_AGENT_TOOL_NAMES = ["ask_user", "make_chart"] as const;

export const SEMANTIC_AGENT_TOOL_NAMES = [
  ...REMOTE_SEMANTIC_AGENT_TOOL_NAMES,
  ...LOCAL_SEMANTIC_AGENT_TOOL_NAMES,
] as const;
export type SemanticAgentToolName = (typeof SEMANTIC_AGENT_TOOL_NAMES)[number];

const sourceFilterSchema = z.object({
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "is_null", "is_not_null"]),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).max(100).default([]),
}).strict();
const sourceAggregateSchema = z.object({
  op: z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]),
  field: z.string().min(1).optional(),
  as: z.string().regex(/^[a-z_][a-z0-9_]*$/),
}).strict();

/** Canonical source-exploration input consumed by both the agent and service. */
export const sourceQuerySpecSchema = z.object({
  connectionId: z.string().min(1),
  sourceTable: z.string().min(1),
  fields: z.array(z.string().min(1)).max(20).default([]),
  aggregates: z.array(sourceAggregateSchema).max(10).default([]),
  groupBy: z.array(z.string().min(1)).max(8).default([]),
  filters: z.array(sourceFilterSchema).max(20).default([]),
  limit: z.number().int().min(1).max(500).default(100),
  authorityConcept: z.string().optional(),
  requestedMetricConcept: z.string().optional(),
}).strict();
export type SourceQuerySpec = z.infer<typeof sourceQuerySpecSchema>;

/** A union (rather than a discriminated union) permits the single-query kind default. */
export const semanticQueryIrSchema = z.union([
  singleSemanticQuerySchema,
  compositeSemanticQuerySchema,
]);
export const semanticQueryToolInputSchema = z.object({
  kind: z.enum(["single", "composite"]).default("single"),
  topic: singleSemanticQuerySchema.shape.topic,
  metrics: singleSemanticQuerySchema.shape.metrics,
  dimensions: z.array(z.string().min(1)).max(8).optional(),
  filters: z.array(queryFilterSchema).max(20).optional(),
  time: singleSemanticQuerySchema.shape.time.optional(),
  queries: compositeSemanticQuerySchema.shape.queries.optional(),
  alignOn: compositeSemanticQuerySchema.shape.alignOn.optional(),
  sort: singleSemanticQuerySchema.shape.sort.optional(),
  limit: singleSemanticQuerySchema.shape.limit.optional(),
  parameters: singleSemanticQuerySchema.shape.parameters.optional(),
}).strict();
export type SemanticQueryIr = SemanticQuery;
/** Acronym-preserving alias for consumers that mirror the specification. */
export type SemanticQueryIR = SemanticQueryIr;

export const semanticToolInputSchemas = Object.freeze({
  search_catalogue: z.object({ question: z.string().trim().min(1).max(2_000) }).strict(),
  get_definition: z.object({ name: z.string().trim().min(1).max(200) }).strict(),
  get_capabilities: z.object({ topic: z.string().trim().min(1).max(200) }).strict(),
  list_field_values: z.object({
    field: z.string().trim().min(1).max(300),
    query: z.string().trim().max(200).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }).strict(),
  run_semantic_query: semanticQueryToolInputSchema,
  run_source_query: sourceQuerySpecSchema,
  get_data_health: z.object({ domain: z.string().trim().min(1).max(100) }).strict(),
  remember: z.object({
    preference: z.string().trim().regex(/^[a-z][a-z0-9_.]{0,119}$/),
    value: z.union([z.string().max(300), z.number(), z.boolean()]),
    explicitlyConfirmed: z.literal(true),
  }).strict(),
  ask_user: z.object({
    question: z.string().trim().min(1).max(300),
    options: z.array(z.object({
      id: z.string().trim().min(1).max(80),
      label: z.string().trim().min(1).max(120),
      value: z.string().trim().min(1).max(200),
    }).strict()).min(2).max(3),
  }).strict(),
  make_chart: z.object({
    dataRef: z.string().min(1),
    chartType: z.enum(["bar", "line"]),
    xKey: z.string().min(1),
    yKey: z.string().min(1),
    series: z.array(z.object({ key: z.string().min(1), label: z.string().min(1) }).strict()).optional(),
  }).strict(),
} satisfies Record<SemanticAgentToolName, z.ZodType>);

const wireTimeRangeSchema = z.object({
  label: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  timezone: z.string().min(1),
}).strict();
const sourceDetailSchema = z.object({
  connectorId: z.string().min(1),
  connectionId: z.string().min(1),
  label: z.string().min(1),
  dataThrough: z.string().min(1),
}).strict();
const definitionDetailSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  definition: z.string().min(1),
}).strict();

/**
 * One signed wire response for every remote semantic tool. Tool-specific
 * payloads are optional, while provenance, validation, and performance are
 * mandatory and therefore cannot be lost between service and UI adapters.
 */
export const semanticToolResponseSchema = z.object({
  state: z.enum(["verified", "qualified", "exploratory", "clarification", "unavailable"]),
  resultId: z.string().min(1).optional(),
  data: z.object({
    columns: z.array(z.string().min(1)),
    rows: z.array(z.record(z.string(), z.unknown())),
  }).strict().optional(),
  definition: z.unknown().optional(),
  capabilities: z.object({
    topic: z.string().min(1),
    answerable: z.boolean(),
    required: z.array(z.string()),
    available: z.array(z.string()),
    missing: z.array(z.string()),
  }).strict().optional(),
  catalogue: z.object({
    topics: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), answerable: z.boolean() }).strict()),
    metrics: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), unit: z.string() }).strict()),
    dimensions: z.array(z.object({ id: z.string(), label: z.string(), topics: z.array(z.string()) }).strict()),
    fields: z.array(z.object({ id: z.string(), connectorId: z.string(), connectionId: z.string(), sourceTable: z.string(), field: z.string(), definition: z.string(), fieldType: z.string() }).strict()),
    tenantContext: z.object({
      defaults: z.record(z.string(), z.union([z.string().max(160), z.number(), z.boolean()])),
      dossier: z.record(z.string(), z.union([
        z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(50),
      ])),
    }).strict(),
  }).strict().optional(),
  fieldValues: z.array(z.object({ value: z.string(), count: z.number().int().nonnegative().optional() }).strict()).optional(),
  dataHealth: z.object({
    domain: z.string(),
    status: z.enum(["passed", "warning", "failed", "blocked"]),
    dataThrough: z.string().optional(),
    checks: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()),
  }).strict().optional(),
  rememberedPreference: z.object({ preference: z.string(), overlayVersion: z.number().int().positive() }).strict().optional(),
  promotionCandidateId: z.string().min(1).optional(),
  provenance: z.object({
    bundleHash: z.string().min(1),
    registryVersion: z.string().min(1),
    identityGraph: z.object({
      version: z.number().int().nonnegative(),
      hash: z.string().regex(/^[a-f0-9]{32}$/),
    }).strict(),
    sources: z.array(z.string()),
    sourceWatermarks: z.record(z.string(), z.string()),
    sourceDetails: z.array(sourceDetailSchema).default([]),
    definitionsApplied: z.array(z.string()),
    definitionDetails: z.array(definitionDetailSchema).default([]),
    timeRange: wireTimeRangeSchema.optional(),
    authorityWarning: z.string().optional(),
  }).strict(),
  validation: z.object({
    status: z.enum(["passed", "warning", "failed", "blocked"]),
    checks: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()),
  }).strict(),
  performance: z.object({ cacheHit: z.boolean(), durationMs: z.number().nonnegative(), rowCount: z.number().int().nonnegative() }).strict(),
}).strict();
export type SemanticToolResponse = z.infer<typeof semanticToolResponseSchema>;

export type GovernedResult = Readonly<{
  resultId: string;
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  provenance: TraceProvenance;
  validations: readonly Readonly<{
    name: string;
    outcome: "passed" | "qualified" | "failed";
    detail: string;
  }>[];
}>;

export type AgentToolContext = Readonly<{
  /** Injected by trusted backend code; never accepted from model tool input. */
  tenantId: string;
  conversationId: string;
  turnId: string;
  role: "owner" | "manager" | "bookkeeper" | "internal_operator";
  /** Signed server-side confirmation context; never accepted from model input. */
  confirmedValue?: string;
  abortSignal?: AbortSignal;
}>;

export type SemanticToolInputMap = {
  [Name in SemanticAgentToolName]: z.infer<(typeof semanticToolInputSchemas)[Name]>;
};

export type SemanticToolOutputMap = {
  search_catalogue: NonNullable<SemanticToolResponse["catalogue"]>;
  get_definition: Readonly<{ definition: unknown }>;
  get_capabilities: NonNullable<SemanticToolResponse["capabilities"]>;
  list_field_values: NonNullable<SemanticToolResponse["fieldValues"]>;
  run_semantic_query: GovernedResult;
  run_source_query: GovernedResult & Readonly<{
    state: "Exploratory";
    authorityWarning?: string;
    promotionCandidateId: string;
  }>;
  get_data_health: NonNullable<SemanticToolResponse["dataHealth"]>;
  ask_user: Readonly<{ status: "awaiting_user" }>;
  remember: NonNullable<SemanticToolResponse["rememberedPreference"]>;
  make_chart: Readonly<{
    dataRef: string;
    chartType: "bar" | "line";
    xKey: string;
    yKey: string;
  }>;
};

export type SemanticAgentTool<Name extends SemanticAgentToolName = SemanticAgentToolName> =
  Readonly<{
    name: Name;
    description: string;
    execute: (
      input: SemanticToolInputMap[Name],
      context: AgentToolContext,
    ) => Promise<SemanticToolOutputMap[Name]>;
  }>;

const semanticToolNames = new Set<string>(SEMANTIC_AGENT_TOOL_NAMES);

export function isSemanticAgentToolName(value: unknown): value is SemanticAgentToolName {
  return typeof value === "string" && semanticToolNames.has(value);
}

/** Runtime guard rejecting raw database, SQL, or any unapproved tool. */
export function assertSemanticOnlyToolNames(
  names: readonly string[],
): asserts names is readonly SemanticAgentToolName[] {
  const unknown = names.filter((name) => !isSemanticAgentToolName(name));
  if (unknown.length > 0) {
    throw new Error(`Agent tool boundary rejected: ${unknown.join(", ")}.`);
  }
}

export function assertSemanticOnlyToolset(
  tools: readonly SemanticAgentTool[],
): readonly SemanticAgentTool[] {
  const names = tools.map(({ name }) => name);
  assertSemanticOnlyToolNames(names);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate semantic tools: ${[...new Set(duplicates)].join(", ")}.`);
  }
  return Object.freeze([...tools]);
}
