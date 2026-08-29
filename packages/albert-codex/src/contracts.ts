import { z } from "zod";
import type { CubeFilter, CubeQuery } from "../../albert-v3/src/cube/types.js";
import {
  ANALYTICAL_QUERY_OUTCOMES,
  ANALYTICAL_QUERY_SOURCES,
  type AnalyticalBrief,
} from "../../shared/src/index.js";

export const ALBERT_CODEX_RUNTIME = "codex-app-server" as const;
export const ALBERT_CODEX_ANALYTICAL_RUNTIME = "cube-codex-v1" as const;
export const ALBERT_CODEX_PROTOCOL_VERSION = 1 as const;
export const ALBERT_CODEX_MODEL_IDS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;
export const ALBERT_CODEX_DEFAULT_MODEL = "gpt-5.6-luna" as const;
export const ALBERT_CODEX_DEFAULT_EFFORT = "max" as const;
export const ALBERT_CODEX_DEFAULT_FAST_MODE = true as const;
export const ALBERT_CODEX_PINNED_CLI_VERSION = "0.148.0" as const;
export const ALBERT_CODEX_ANALYSIS_TIMEOUT_MS = 720_000 as const;
/** Loopback-only development boundary; production always requires a secret. */
export const ALBERT_CODEX_LOCAL_SIGNING_SECRET = "albert-local-codex-runtime-only-not-for-production" as const;

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const roleSchema = z.enum(["owner", "manager", "bookkeeper", "internal_operator"]);
const traceCellSchema = z.union([z.string().max(200), z.number().finite(), z.null()]);
const traceColumnSchema = z.object({
  key: z.string().regex(/^[a-z_][a-z0-9_.]{0,159}$/u),
  label: z.string().trim().min(1).max(160),
  type: z.enum(["string", "number", "currency", "percent", "date", "datetime"]),
  currency: z.string().regex(/^[A-Z]{3}$/u).optional(),
}).strict();

const boundedDiagnosticObjectSchema = z.record(z.string(), z.unknown()).refine(
  (value) => JSON.stringify(value).length <= 65_536,
  "The analytical query audit document is too large.",
);

export const codexQueryAuditEventSchema = z.discriminatedUnion("phase", [
  z.object({
    type: z.literal("query_audit"),
    phase: z.literal("start"),
    attempt: z.object({
      queryAttemptId: ulidSchema,
      runtime: z.literal("codex-app-server"),
      source: z.enum(ANALYTICAL_QUERY_SOURCES),
      operation: z.string().regex(/^[a-z][a-z0-9_.-]{1,79}$/u),
      topic: z.string().min(1).max(240).optional(),
      branchLabel: z.string().min(1).max(160).optional(),
      queryDocument: boundedDiagnosticObjectSchema,
    }).strict(),
  }).strict(),
  z.object({
    type: z.literal("query_audit"),
    phase: z.literal("finish"),
    outcome: z.object({
      queryAttemptId: ulidSchema,
      status: z.enum(ANALYTICAL_QUERY_OUTCOMES),
      executionMs: z.number().int().min(0).max(3_600_000).optional(),
      rowCount: z.number().int().min(0).max(2_000_000).optional(),
      failureCode: z.string().regex(/^[a-z][a-z0-9_]{1,119}$/u).optional(),
      failureMessage: z.string().min(1).max(1_000).optional(),
      resultMetadata: z.record(z.string(), z.unknown()).optional(),
    }).strict(),
  }).strict(),
]);

export type CodexQueryAuditEvent = z.infer<typeof codexQueryAuditEventSchema>;

export const codexConversationRequestSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  preferences: z.unknown().optional(),
  /** Run the optional GPT-5.6 Sol / Max planning preflight for Codex turns. */
  solPlanner: z.boolean().optional(),
  /** Enable GPT-5.6 Responses `reasoning.mode: "pro"`. */
  proMode: z.boolean().optional(),
  comparisonMode: z.boolean().optional(),
  conversationId: ulidSchema.optional(),
  replaceTurnId: ulidSchema.optional(),
}).strict();

export const codexPriorMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(8_000),
}).strict();

export const codexPriorResultSchema = z.object({
  resultId: z.string().regex(/^[A-Za-z0-9:_-]{8,160}$/u),
  turnsAgo: z.number().int().min(1).max(2),
  caption: z.string().trim().min(1).max(160),
  presentation: z.enum(["evidence", "answer"]),
  columns: z.array(traceColumnSchema).min(1).max(16),
  rows: z.array(z.record(z.string().max(160), traceCellSchema)
    .refine((row) => Object.keys(row).length <= 16, "A prior-result row has too many cells."))
    .max(20),
  rowCount: z.number().int().nonnegative(),
  view: z.string().regex(/^[a-z][a-z0-9_]*$/u).optional(),
  connector: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
  sources: z.array(z.object({
    connector: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
    label: z.string().trim().min(1).max(160),
    dataThrough: z.string().max(80),
  }).strict()).max(8),
  timeRange: z.object({
    label: z.string().trim().min(1).max(240),
    start: z.string().max(80),
    end: z.string().max(80),
    timezone: z.string().trim().min(1).max(80),
  }).strict(),
  definitions: z.array(z.object({
    metric: z.string().trim().min(1).max(160),
    label: z.string().trim().min(1).max(160),
    definition: z.string().trim().min(1).max(500),
    view: z.string().max(120).optional(),
    kind: z.enum(["measure", "dimension", "segment", "time"]).optional(),
  }).strict()).max(12),
  semanticBundleHash: z.string().trim().min(1).max(200),
  identityGraph: z.object({
    version: z.number().int().nonnegative(),
    hash: z.string().trim().min(1).max(200),
  }).strict(),
}).strict();

export type CodexPriorResult = z.infer<typeof codexPriorResultSchema>;

export const codexConnectorFreshnessSchema = z.object({
  connector: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
  domain: z.string().trim().min(1).max(80),
  dataFrom: z.string().max(80).nullable().optional(),
  dataThrough: z.string().max(80).nullable(),
}).strict();

export const codexAnalyticalBriefSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/u),
  version: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{24}$/u),
  ownerGoal: z.string().trim().min(1).max(300),
  answerMustCover: z.array(z.string().trim().min(3).max(240)).max(6),
  requiredViews: z.array(z.object({
    view: z.string().regex(/^[a-z][a-z0-9_]*$/u),
    reason: z.string().trim().min(3).max(200),
  }).strict()).max(10),
  requiredCalculations: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,79}$/u)).max(6),
  commonPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
}).strict();

export const codexSemanticBindingSchema = z.object({
  view: z.string().regex(/^[a-z][a-z0-9_]*$/u),
  dimension: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u).optional(),
  value: z.string().trim().min(1).max(240).optional(),
}).strict();

/** A learned vocabulary rule as it travels inside a turn (ADR 0115). */
export const codexSemanticMemoryRuleSchema = z.object({
  term: z.string().trim().min(2).max(80),
  meaning: z.string().trim().min(3).max(300),
  counterMeaning: z.string().trim().min(3).max(300).optional(),
  binding: codexSemanticBindingSchema.optional(),
  status: z.enum(["proposed", "confirmed"]),
}).strict();

/** A rule the runtime proposes to store after this turn (remember_term). */
export const codexMemoryProposalSchema = z.object({
  term: z.string().trim().min(2).max(80),
  meaning: z.string().trim().min(3).max(300),
  counterMeaning: z.string().trim().min(3).max(300).optional(),
  binding: codexSemanticBindingSchema.optional(),
  trigger: z.enum(["owner_request", "correction"]),
}).strict();

export type CodexMemoryProposal = z.infer<typeof codexMemoryProposalSchema>;

export const codexServiceTurnSchema = z.object({
  protocolVersion: z.literal(ALBERT_CODEX_PROTOCOL_VERSION),
  requestId: ulidSchema,
  tenantId: ulidSchema,
  actorId: z.string().uuid(),
  role: roleSchema,
  conversationId: ulidSchema,
  turnId: ulidSchema,
  message: z.string().trim().min(1).max(8_000),
  priorConversation: z.array(codexPriorMessageSchema).max(24),
  priorResults: z.array(codexPriorResultSchema).max(4),
  activeConnectors: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u)).max(24),
  connectorFreshness: z.array(codexConnectorFreshnessSchema).max(80),
  businessContext: z.string().max(20_000).optional(),
  sourceFindings: z.string().max(12_000).optional(),
  semanticMemory: z.array(codexSemanticMemoryRuleSchema).max(12).optional(),
  analysisBrief: codexAnalyticalBriefSchema.optional(),
  cubeBearer: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u).max(12_000),
  model: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/u),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  fastMode: z.boolean(),
  /** Optional Codex-only Sol/Max decomposition preflight. */
  solPlanner: z.boolean().optional(),
  /** Responses reasoning mode, independent of `effort`. */
  reasoningMode: z.enum(["standard", "pro"]).optional(),
}).strict();

export type CodexServiceTurn = Omit<z.infer<typeof codexServiceTurnSchema>, "analysisBrief"> & Readonly<{
  analysisBrief?: AnalyticalBrief;
}>;

const cubeMemberFilterSchema = z.object({
  member: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u),
  operator: z.enum([
    "equals", "notEquals", "contains", "notContains", "startsWith", "notStartsWith",
    "endsWith", "notEndsWith", "gt", "gte", "lt", "lte", "set", "notSet",
    "inDateRange", "notInDateRange", "beforeDate", "afterDate",
  ]),
  values: z.array(z.string().max(240)).max(40).optional(),
}).strict();

const cubeFilterSchema: z.ZodType<CubeFilter> = z.lazy(() => z.union([
  cubeMemberFilterSchema,
  z.object({ and: z.array(cubeFilterSchema).min(1).max(20) }).strict(),
  z.object({ or: z.array(cubeFilterSchema).min(1).max(20) }).strict(),
])) as z.ZodType<CubeFilter>;

const cubeTimeDimensionSchema = z.object({
  dimension: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u),
  granularity: z.enum(["second", "minute", "hour", "day", "week", "month", "quarter", "year"]).optional(),
  dateRange: z.union([
    z.string().trim().min(1).max(80),
    z.tuple([z.string().max(40), z.string().max(40)]),
  ]).optional(),
  compareDateRange: z.array(z.union([
    z.string().trim().min(1).max(80),
    z.tuple([z.string().max(40), z.string().max(40)]),
  ])).min(2).max(6).optional(),
}).strict();

export const codexCubeQuerySchema: z.ZodType<CubeQuery> = z.object({
  measures: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u)).max(12).optional(),
  dimensions: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u)).max(12).optional(),
  segments: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u)).max(8).optional(),
  timeDimensions: z.array(cubeTimeDimensionSchema).max(4).optional(),
  filters: z.array(cubeFilterSchema).max(20).optional(),
  order: z.record(
    z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u),
    z.enum(["asc", "desc"]),
  ).refine((value) => Object.keys(value).length <= 8, "At most eight order keys are allowed.").optional(),
  // Models regularly ask for more rows than the governed ceiling (12 rejected
  // queries in one production battery); a clamp keeps the query productive
  // where a rejection cost a full model round-trip.
  limit: z.number().int().min(1).transform((value) => Math.min(value, 500)).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
}).strict().refine((query) => (
  (query.measures?.length ?? 0) + (query.dimensions?.length ?? 0) + (query.timeDimensions?.length ?? 0) > 0
), "A semantic query must select at least one measure or dimension.") as z.ZodType<CubeQuery>;

export const codexSearchToolInputSchema = z.object({
  question: z.string().trim().min(1).max(1_000),
  limit: z.number().int().min(1).max(8).default(5),
}).strict();

export const codexViewSchemaToolInputSchema = z.object({
  views: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)).min(1).max(4),
}).strict();

export const codexQueryToolInputSchema = z.object({
  topic: z.string().trim().min(1).max(160),
  query: codexCubeQuerySchema,
}).strict();

export const codexEvidenceUpdateToolInputSchema = z.object({
  message: z.string().trim().min(12).max(420),
  evidenceResultIds: z.array(ulidSchema).min(1).max(8),
}).strict();

const deriveColumnKeySchema = z.string().regex(/^[a-z_][a-z0-9_.]{0,119}$/u);

export const codexDeriveDateBucketSchema = z.enum(["weekday", "month", "quarter", "year", "month_of_year"]);

export type CodexDeriveDateBucket = z.infer<typeof codexDeriveDateBucketSchema>;

export const codexDeriveExpressionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u),
  label: z.string().trim().min(2).max(120),
  operation: z.enum(["ratio", "difference", "sum", "percent_of", "share_of_total_pct", "scale"]),
  leftKey: deriveColumnKeySchema,
  rightKey: deriveColumnKeySchema.optional(),
  /** Owner-stated scenario rate for `scale` (a 30% clearance is factor 0.7).
   * The factor is disclosed in the derived column's formula and notes. */
  factor: z.number().finite().optional(),
}).strict().refine((value) => (value.operation === "scale") === (value.factor !== undefined), {
  message: "scale requires factor; other operations must not pass factor.",
}).refine((value) => value.factor === undefined || (value.factor !== 0 && Math.abs(value.factor) <= 1_000_000), {
  message: "factor must be non-zero and within ±1,000,000.",
});

export const codexDeriveToolInputSchema = z.object({
  caption: z.string().trim().min(3).max(160),
  resultId: ulidSchema,
  alignWith: z.object({
    resultId: ulidSchema,
    labelKey: deriveColumnKeySchema.optional(),
    sourceLabelKey: deriveColumnKeySchema.optional(),
    labelBucket: codexDeriveDateBucketSchema.optional(),
  }).strict().refine((value) => (value.labelKey === undefined) === (value.sourceLabelKey === undefined), {
    message: "Pass both labelKey and sourceLabelKey for a label join, or neither to combine two single-row results side by side.",
  }).refine((value) => value.labelBucket === undefined || value.labelKey !== undefined, {
    message: "labelBucket applies to a label join: pass labelKey and sourceLabelKey with it.",
  }).optional(),
  groupBy: z.object({
    key: deriveColumnKeySchema,
    bucket: codexDeriveDateBucketSchema.optional(),
    aggregate: z.enum(["sum", "average"]).optional(),
  }).strict().optional(),
  expressions: z.array(codexDeriveExpressionSchema).max(6).default([]),
  orderBy: z.object({
    key: deriveColumnKeySchema,
    direction: z.enum(["asc", "desc"]),
  }).strict().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  select: z.array(deriveColumnKeySchema).min(1).max(14).optional(),
  pivot: z.object({
    labelKey: deriveColumnKeySchema,
    valueKeys: z.array(deriveColumnKeySchema).min(1).max(6).optional(),
  }).strict().optional(),
}).strict().refine((value) => (
  value.expressions.length > 0 || value.groupBy !== undefined || value.orderBy !== undefined || value.limit !== undefined || value.select !== undefined || value.pivot !== undefined || value.alignWith !== undefined
), "A derivation must add at least one expression, alignment, grouping, pivot, column selection, or re-order/limit of the source result.");

export type CodexDeriveToolInput = z.infer<typeof codexDeriveToolInputSchema>;

export const codexChartToolInputSchema = z.object({
  resultId: ulidSchema,
  purpose: z.enum(["trend", "ranking", "comparison", "composition"]),
  caption: z.string().trim().min(3).max(160),
  chartType: z.enum(["auto", "bar", "line", "stacked_bar"]),
  xKey: z.string().regex(/^[a-z_][a-z0-9_.]{0,119}$/u),
  yKey: z.string().regex(/^[a-z_][a-z0-9_.]{0,119}$/u),
  seriesKey: z.string().regex(/^[a-z_][a-z0-9_.]{0,119}$/u).optional(),
  extraYKeys: z.array(z.string().regex(/^[a-z_][a-z0-9_.]{0,119}$/u)).max(3).optional(),
  limit: z.number().int().min(3).max(15).optional(),
  transform: z.enum(["cumulative"]).optional(),
}).strict();

export type CodexChartToolInput = z.infer<typeof codexChartToolInputSchema>;

export const codexClaimReferenceSchema = z.object({
  resultId: ulidSchema,
  rowIndex: z.number().int().min(0).max(499),
  columnKey: z.string().regex(/^[a-z_][a-z0-9_.]{0,119}$/u),
}).strict();

export const codexKeyInsightSchema = z.object({
  value: z.string().trim().min(1).max(24),
  label: z.string().trim().min(3).max(60),
  detail: z.string().trim().max(80),
  sentiment: z.enum(["positive", "negative", "neutral"]),
}).strict();

export type CodexKeyInsight = z.infer<typeof codexKeyInsightSchema>;

export const codexFinalAnswerSchema = z.object({
  state: z.enum(["Verified", "Qualified", "Exploratory", "Clarification", "No data", "Unavailable"]),
  answer: z.string().trim().min(1).max(8_000),
  followUps: z.array(z.string().trim().min(1).max(160)).max(3),
  keyInsights: z.array(codexKeyInsightSchema).max(4).default([]),
  presentedResultIds: z.array(ulidSchema).max(4),
  claims: z.array(z.object({
    statement: z.string().trim().min(1).max(600),
    assertion: z.enum(["value", "highest", "lowest", "greater_than", "less_than", "equal"]),
    refs: z.array(codexClaimReferenceSchema).min(1).max(12),
  }).strict()).max(20),
}).strict();

export type CodexFinalAnswer = z.infer<typeof codexFinalAnswerSchema>;

/** The bounded, tool-free checklist returned by the optional Sol preflight. */
export const codexSolPlannerOutputSchema = z.object({
  steps: z.array(z.object({
    label: z.string().trim().min(3).max(180),
  }).strict()).min(2).max(6),
}).strict();

export type CodexSolPlannerOutput = z.infer<typeof codexSolPlannerOutputSchema>;

export const CODEX_SOL_PLANNER_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label"],
        properties: {
          label: { type: "string", minLength: 3, maxLength: 180 },
        },
      },
    },
  },
});

export const codexSemanticTurnResultSchema = z.object({
  answerState: z.enum(["Verified", "Qualified", "Exploratory", "Clarification", "No data", "Unavailable"]),
  queriesExecuted: z.number().int().min(0),
  codexThreadId: z.string().trim().min(1).max(200),
  codexTurnId: z.string().trim().min(1).max(200),
  durationMs: z.number().int().min(0).nullable(),
  /** Vocabulary rules captured this turn for the host to persist (ADR 0115). */
  memoryProposals: z.array(codexMemoryProposalSchema).max(4).optional(),
}).strict();

export const CODEX_FINAL_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["state", "answer", "followUps", "keyInsights", "presentedResultIds", "claims"],
  properties: {
    state: { type: "string", enum: ["Verified", "Qualified", "Exploratory", "Clarification", "No data", "Unavailable"] },
    answer: { type: "string", minLength: 1, maxLength: 8_000 },
    followUps: { type: "array", maxItems: 3, items: { type: "string", minLength: 1, maxLength: 160 } },
    keyInsights: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value", "label", "detail", "sentiment"],
        properties: {
          value: { type: "string", minLength: 1, maxLength: 24 },
          label: { type: "string", minLength: 3, maxLength: 60 },
          detail: { type: "string", maxLength: 80 },
          sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
        },
      },
    },
    presentedResultIds: { type: "array", maxItems: 4, items: { type: "string", pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" } },
    claims: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "assertion", "refs"],
        properties: {
          statement: { type: "string", minLength: 1, maxLength: 600 },
          assertion: { type: "string", enum: ["value", "highest", "lowest", "greater_than", "less_than", "equal"] },
          refs: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["resultId", "rowIndex", "columnKey"],
              properties: {
                resultId: { type: "string", pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" },
                rowIndex: { type: "integer", minimum: 0, maximum: 499 },
                columnKey: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
              },
            },
          },
        },
      },
    },
  },
} as const);

export const CODEX_DYNAMIC_TOOL_SPECS = Object.freeze([
  {
    type: "namespace",
    name: "albert",
    description: "Read-only governed analytical tools for the connected business data.",
    tools: [
      {
        type: "function",
        name: "search_semantic_catalogue",
        description: "Find relevant governed semantic views and members when the view index and any preferred certified query do not already name the view. Skip this when the needed view is already listed.",
        deferLoading: false,
        inputSchema: {
          type: "object", additionalProperties: false, required: ["question"],
          properties: {
            question: { type: "string", minLength: 1, maxLength: 1_000 },
            limit: { type: "integer", minimum: 1, maximum: 8 },
          },
        },
      },
      {
        type: "function",
        name: "get_view_schema",
        description: "Load exact member names, types and definitions for one to four governed views.",
        deferLoading: false,
        inputSchema: {
          type: "object", additionalProperties: false, required: ["views"],
          properties: {
            views: {
              type: "array", minItems: 1, maxItems: 4,
              items: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
            },
          },
        },
      },
      {
        type: "function",
        name: "run_semantic_query",
        description: "Validate and execute one Cube semantic JSON query. No SQL, tenant selector or physical table is accepted.",
        deferLoading: false,
        inputSchema: {
          type: "object", additionalProperties: false, required: ["topic", "query"],
          properties: {
            topic: { type: "string", minLength: 1, maxLength: 160 },
            query: {
              type: "object",
              additionalProperties: false,
              properties: {
                measures: { type: "array", maxItems: 12, items: { type: "string" } },
                dimensions: { type: "array", maxItems: 12, items: { type: "string" } },
                segments: { type: "array", maxItems: 8, items: { type: "string" } },
                timeDimensions: { type: "array", maxItems: 4, items: { type: "object" } },
                filters: { type: "array", maxItems: 20, items: { type: "object" } },
                order: { type: "object", additionalProperties: { type: "string", enum: ["asc", "desc"] } },
                limit: { type: "integer", minimum: 1, maximum: 500 },
                offset: { type: "integer", minimum: 0, maximum: 10_000 },
                timezone: { type: "string", minLength: 1, maxLength: 80 },
              },
            },
          },
        },
      },
      {
        type: "function",
        name: "derive_result",
        description: "Ask trusted Albert code to compute a derived governed result from cells already returned this turn: per-row ratios, differences, sums, percent-of, share-of-total, a group-by aggregation, an exact-label alignment of two results, a transposed (pivoted) table, or a re-sorted/limited copy. Use this for every ratio, per-unit rate, share, delta, or re-aggregation the answer needs — never calculate figures yourself. The returned cells are governed evidence: cite them in claims and prose exactly like query cells. alignWith joins two results on exact matching label values (duplicates are dropped and the alignment is disclosed); expressions reference numeric column keys from the combined result. When the second result carries a column whose key the first result also has (the same measure for another period), that column is kept and renamed with an __aligned suffix — sales_analytics.gross_takings from the aligned result becomes sales_analytics.gross_takings__aligned — so expressions can compare the two periods directly. alignWith.labelBucket buckets BOTH label columns before matching (month_of_year matches January 2026 with January 2025; also weekday, month, quarter, year), which is how a per-period year-on-year table is built: one query per period at the same grain, then ONE alignment whose difference and percent_of expressions reference the __aligned prior-period columns. alignWith with NO label keys combines two single-row summary results side by side into one governed row — the way to build the one compact KPI table when requested totals live in different views (same-key columns get the same __aligned rename). groupBy re-aggregates the rows you already have: it groups by an existing column (optionally bucketing an ISO date column by weekday, month, quarter, year or month_of_year) and sums the numeric columns — or averages them with aggregate:\"average\" — so a ranking like \"busiest weekday\" comes from one query plus one derivation instead of one query per group. aggregate:\"average\" over a monthly series bucketed by year is how a per-month run-rate is computed (\"subscriptions averaged $449/month\") — the natural unit when the owner names a per-month or per-week target. select re-projects the result to just the named columns in that order — use it before presenting a wide working table so the owner sees only the columns that matter. pivot runs last and transposes the table for presentation: the values of pivot.labelKey become the columns (at most 13, in row order) and each numeric valueKey becomes one row — use it when the owner asks to see periods (months, quarters, dates) as columns across the top, and bucket or align first so the column headings read cleanly. The caption is owner-visible in the conversation: name the business meaning (for example \"Gross profit per worked hour by employee\"), never exploratory wording like \"test\" or \"check\". Give every expression a distinct, owner-readable label.",
        deferLoading: false,
        inputSchema: {
          type: "object", additionalProperties: false, required: ["caption", "resultId"],
          properties: {
            caption: { type: "string", minLength: 3, maxLength: 160 },
            resultId: { type: "string", pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" },
            alignWith: {
              type: "object", additionalProperties: false,
              required: ["resultId"],
              properties: {
                resultId: { type: "string", pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" },
                labelKey: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
                sourceLabelKey: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
                labelBucket: { type: "string", enum: ["weekday", "month", "quarter", "year", "month_of_year"] },
              },
            },
            groupBy: {
              type: "object", additionalProperties: false, required: ["key"],
              properties: {
                key: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
                bucket: { type: "string", enum: ["weekday", "month", "quarter", "year", "month_of_year"] },
                aggregate: { type: "string", enum: ["sum", "average"] },
              },
            },
            expressions: {
              type: "array", maxItems: 6,
              items: {
                type: "object", additionalProperties: false,
                required: ["name", "label", "operation", "leftKey"],
                properties: {
                  name: { type: "string", pattern: "^[a-z][a-z0-9_]{1,63}$" },
                  label: { type: "string", minLength: 2, maxLength: 120 },
                  operation: { type: "string", enum: ["ratio", "difference", "sum", "percent_of", "share_of_total_pct", "scale"] },
                  leftKey: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
                  rightKey: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
                  factor: { type: "number", description: "Required for scale, forbidden otherwise: multiply leftKey by this owner-stated scenario rate (a 30% clearance is 0.7, a 4% rise is 1.04). The factor is disclosed to the owner." },
                },
              },
            },
            orderBy: {
              type: "object", additionalProperties: false, required: ["key", "direction"],
              properties: {
                key: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
                direction: { type: "string", enum: ["asc", "desc"] },
              },
            },
            limit: { type: "integer", minimum: 1, maximum: 500 },
            select: {
              type: "array", minItems: 1, maxItems: 14,
              items: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
            },
            pivot: {
              type: "object", additionalProperties: false, required: ["labelKey"],
              properties: {
                labelKey: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
                valueKeys: {
                  type: "array", minItems: 1, maxItems: 6,
                  items: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
                },
              },
            },
          },
        },
      },
      {
        type: "function",
        name: "report_evidence_update",
        description: "Share one short owner-facing finding after a governed query succeeds. The message must state a concrete result, every figure must come from the referenced result rows, and at least one resultId must be new since the prior update. Never use this for plans or tool narration.",
        deferLoading: false,
        inputSchema: {
          type: "object", additionalProperties: false, required: ["message", "evidenceResultIds"],
          properties: {
            message: { type: "string", minLength: 12, maxLength: 420 },
            evidenceResultIds: {
              type: "array", minItems: 1, maxItems: 8,
              items: { type: "string", pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" },
            },
          },
        },
      },
      {
        type: "function",
        name: "remember_term",
        description: "Teach Albert this owner's vocabulary. Call once when the owner corrects how a term was interpreted (\"I meant the General Service item, not the Services category\") or explicitly asks Albert to remember a meaning or preference. Pass the owner's phrase, a plain-language meaning, and — when this turn's schemas or results identify it — the exact governed binding (view, dimension, value) the phrase maps to, plus the rejected reading as counterMeaning for a correction. The rule is stored as a deterministic, owner-visible vocabulary rule and applied to future questions; apply it in the current answer too. Vocabulary and preferences only: never store figures, one-off facts, or instructions.",
        deferLoading: false,
        inputSchema: {
          type: "object", additionalProperties: false, required: ["term", "meaning", "trigger"],
          properties: {
            term: { type: "string", minLength: 2, maxLength: 80 },
            meaning: { type: "string", minLength: 3, maxLength: 300 },
            counterMeaning: { type: "string", minLength: 3, maxLength: 300 },
            binding: {
              type: "object", additionalProperties: false, required: ["view"],
              properties: {
                view: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
                dimension: { type: "string", pattern: "^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$" },
                value: { type: "string", minLength: 1, maxLength: 240 },
              },
            },
            trigger: { type: "string", enum: ["owner_request", "correction"] },
          },
        },
      },
      {
        type: "function",
        name: "make_chart",
        description: "Attach at most two governed Flint charts. Use only after the analysis has identified a material trend, ranking, comparison, or composition that a chart communicates faster than prose. Never chart a scalar or one-point lookup, a two-point line, a record/list table, equal values, or data unrelated to the final answer. For a running total, pass transform:\"cumulative\" over a governed time-series result and the host accumulates the values in date order. The host validates the result shape and compiles the chart from an existing resultId; no plot data is accepted.",
        deferLoading: false,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["resultId", "purpose", "caption", "chartType", "xKey", "yKey"],
          properties: {
            resultId: { type: "string", pattern: "^[0-9A-HJKMNP-TV-Z]{26}$" },
            purpose: { type: "string", enum: ["trend", "ranking", "comparison", "composition"] },
            caption: { type: "string", minLength: 3, maxLength: 160 },
            chartType: { type: "string", enum: ["auto", "bar", "line", "stacked_bar"] },
            xKey: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
            yKey: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
            seriesKey: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
            extraYKeys: {
              type: "array", maxItems: 3,
              items: { type: "string", pattern: "^[a-z_][a-z0-9_.]{0,119}$" },
            },
            limit: { type: "integer", minimum: 3, maximum: 15 },
            transform: { type: "string", enum: ["cumulative"] },
          },
        },
      },
    ],
  },
] as const);
