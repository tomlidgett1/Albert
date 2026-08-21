import { z } from "zod";
import type { CubeFilter, CubeQuery } from "../../albert-v3/src/cube/types.js";
import type { AnalyticalBrief } from "../../shared/src/index.js";

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

export const codexConversationRequestSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  preferences: z.unknown().optional(),
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
  analysisBrief: codexAnalyticalBriefSchema.optional(),
  cubeBearer: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u).max(12_000),
  model: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/u),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  fastMode: z.boolean(),
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
  limit: z.number().int().min(1).max(500).optional(),
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
}).strict();

export type CodexChartToolInput = z.infer<typeof codexChartToolInputSchema>;

export const codexClaimReferenceSchema = z.object({
  resultId: ulidSchema,
  rowIndex: z.number().int().min(0).max(499),
  columnKey: z.string().regex(/^[a-z_][a-z0-9_.]{0,119}$/u),
}).strict();

export const codexFinalAnswerSchema = z.object({
  state: z.enum(["Verified", "Qualified", "Exploratory", "Clarification", "No data", "Unavailable"]),
  answer: z.string().trim().min(1).max(4_000),
  followUps: z.array(z.string().trim().min(1).max(160)).max(3),
  presentedResultIds: z.array(ulidSchema).max(4),
  claims: z.array(z.object({
    statement: z.string().trim().min(1).max(600),
    assertion: z.enum(["value", "highest", "lowest", "greater_than", "less_than", "equal"]),
    refs: z.array(codexClaimReferenceSchema).min(1).max(12),
  }).strict()).max(20),
}).strict();

export type CodexFinalAnswer = z.infer<typeof codexFinalAnswerSchema>;

export const codexSemanticTurnResultSchema = z.object({
  answerState: z.enum(["Verified", "Qualified", "Exploratory", "Clarification", "No data", "Unavailable"]),
  queriesExecuted: z.number().int().min(0),
  codexThreadId: z.string().trim().min(1).max(200),
  codexTurnId: z.string().trim().min(1).max(200),
  durationMs: z.number().int().min(0).nullable(),
}).strict();

export const CODEX_FINAL_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["state", "answer", "followUps", "presentedResultIds", "claims"],
  properties: {
    state: { type: "string", enum: ["Verified", "Qualified", "Exploratory", "Clarification", "No data", "Unavailable"] },
    answer: { type: "string", minLength: 1, maxLength: 4_000 },
    followUps: { type: "array", maxItems: 3, items: { type: "string", minLength: 1, maxLength: 160 } },
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
        description: "Find relevant governed semantic views and members for a business question.",
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
        name: "make_chart",
        description: "Attach at most two governed Flint charts. Use only after the analysis has identified a material trend, ranking, comparison, or composition that a chart communicates faster than prose. Never chart a scalar or one-point lookup, a two-point line, a record/list table, equal values, or data unrelated to the final answer. The host validates the result shape and compiles the chart from an existing resultId; no plot data is accepted.",
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
          },
        },
      },
    ],
  },
] as const);
