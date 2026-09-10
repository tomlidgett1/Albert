import { z } from "zod";
import {
  CLAUDE_HAIKU_4_5_MODEL_ID,
  CLAUDE_SONNET_5_MODEL_ID,
} from "../../shared/src/agent-runtime.js";
import type { CubeFilter, CubeQuery } from "../../albert-v3/src/cube/types.js";
import { codexPriorResultSchema } from "../../albert-codex/src/contracts.js";
import { resultSemanticsSchema } from "../../shared/src/result-semantics.js";

export const ALBERT_OMNI_RUNTIME = "omni-agent" as const;
export const ALBERT_OMNI_ANALYTICAL_RUNTIME = "cube-omni-v1" as const;
export const ALBERT_OMNI_PROTOCOL_VERSION = 1 as const;
export const ALBERT_OMNI_MODEL_IDS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  CLAUDE_SONNET_5_MODEL_ID,
  CLAUDE_HAIKU_4_5_MODEL_ID,
] as const;
export const ALBERT_OMNI_DEFAULT_MODEL = CLAUDE_HAIKU_4_5_MODEL_ID;
export const ALBERT_OMNI_DEFAULT_EFFORT = "max" as const;
export const ALBERT_OMNI_DEFAULT_FAST_MODE = false as const;
export const ALBERT_OMNI_ANALYSIS_TIMEOUT_MS = 720_000 as const;
/**
 * The Omni harness deliberately carries no small caps: the owner's question
 * and the final answer are bounded only by transport safety, never by a
 * product limit that truncates an analysis mid-sentence.
 */
export const ALBERT_OMNI_MESSAGE_MAX_CHARS = 32_000 as const;
export const ALBERT_OMNI_ANSWER_MAX_CHARS = 120_000 as const;
export const ALBERT_OMNI_REQUEST_MAX_BYTES = 180 * 1024;
export const ALBERT_OMNI_CONTEXT_MAX_BYTES = 160 * 1024;

export const omniPriorResultSchema = codexPriorResultSchema.extend({
  semantics: resultSemanticsSchema.optional(),
  rowFormats: z.array(z.object({ type: z.enum(["number", "currency", "percent"]), currency: z.string().regex(/^[A-Z]{3}$/u).optional(), percentScale: z.enum(["ratio", "percent"]).optional() }).strict().nullable()).max(20).optional(),
});

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const roleSchema = z.enum(["owner", "manager", "bookkeeper", "internal_operator"]);

export const omniConversationRequestSchema = z.object({
  message: z.string().trim().min(1).max(ALBERT_OMNI_MESSAGE_MAX_CHARS),
  preferences: z.unknown().optional(),
  conversationId: ulidSchema.optional(),
  replaceTurnId: ulidSchema.optional(),
  /** Runs the turn in dashboard-architect mode (ADR 0129). */
  dashboardBuild: z.boolean().optional(),
  /** With dashboardBuild: the lean one-element edit mode (ADR 0134). */
  dashboardEdit: z.boolean().optional(),
  /** The edited element's topic (Cube view), inlined so no model search is needed. */
  dashboardEditTopic: z.string().regex(/^[a-z][a-z0-9_]{0,159}$/u).optional(),
}).strict();

export const omniPriorMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(ALBERT_OMNI_MESSAGE_MAX_CHARS),
}).strict();

export const omniConnectorFreshnessSchema = z.object({
  connector: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u),
  domain: z.string().trim().min(1).max(80),
  dataFrom: z.string().max(80).nullable().optional(),
  dataThrough: z.string().max(80).nullable(),
}).strict();

export const omniServiceTurnSchema = z.object({
  protocolVersion: z.literal(ALBERT_OMNI_PROTOCOL_VERSION),
  requestId: ulidSchema,
  tenantId: ulidSchema,
  actorId: z.string().uuid(),
  role: roleSchema,
  conversationId: ulidSchema,
  turnId: ulidSchema,
  message: z.string().trim().min(1).max(ALBERT_OMNI_MESSAGE_MAX_CHARS),
  priorConversation: z.array(omniPriorMessageSchema).max(24),
  priorResults: z.array(omniPriorResultSchema).max(8).optional(),
  activeConnectors: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u)).max(24),
  connectorFreshness: z.array(omniConnectorFreshnessSchema).max(80),
  businessContext: z.string().max(20_000).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
  ownerName: z.string().trim().min(1).max(120).optional(),
  organisationName: z.string().trim().min(1).max(160).optional(),
  cubeBearer: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u).max(12_000),
  model: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/u)
    .refine((value) => (ALBERT_OMNI_MODEL_IDS as readonly string[]).includes(value), "Unsupported Omni model."),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  fastMode: z.boolean(),
  /**
   * Dashboard-architect mode (ADR 0129): swaps the answer-formatting
   * instructions for the dashboard design system, replaces the chat chart
   * tool with ComposeDashboard, and requires a composed `dashboard_plan`
   * before the final summary. Optional so existing callers are unaffected;
   * the runtime must deploy before any caller sends it.
   */
  dashboardBuild: z.boolean().optional(),
  /**
   * Element edit (ADR 0134): with dashboardBuild, the architect edits ONE
   * existing element — no task list, no design pass, the element's topic
   * definitions inlined, one query and one single-tile compose. Optional so
   * existing callers are unaffected; the runtime must deploy before any
   * caller sends it.
   */
  dashboardEdit: z.boolean().optional(),
  dashboardEditTopic: z.string().regex(/^[a-z][a-z0-9_]{0,159}$/u).optional(),
  /**
   * Delivery channel. "imessage" appends a text-message answer contract to
   * the analyst instructions (no tables/headings/links — short bold-accented
   * bubbles) for turns whose reply is delivered as iMessage bubbles rather
   * than rendered in the Albert app. Optional so existing callers are
   * unaffected; the runtime must deploy before any caller sends it.
   */
  channel: z.enum(["imessage"]).optional(),
}).strict();

export type OmniServiceTurn = z.infer<typeof omniServiceTurnSchema>;

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

export const omniCubeQuerySchema: z.ZodType<CubeQuery> = z.object({
  measures: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u)).max(12).optional(),
  dimensions: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u)).max(12).optional(),
  segments: z.array(z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u)).max(8).optional(),
  timeDimensions: z.array(cubeTimeDimensionSchema).max(4).optional(),
  filters: z.array(cubeFilterSchema).max(20).optional(),
  order: z.record(
    z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u),
    z.enum(["asc", "desc"]),
  ).refine((value) => Object.keys(value).length <= 8, "At most eight order keys are allowed.").optional(),
  limit: z.number().int().min(1).transform((value) => Math.min(value, 500)).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
}).strict().refine((query) => (
  (query.measures?.length ?? 0) + (query.dimensions?.length ?? 0) + (query.timeDimensions?.length ?? 0) > 0
), "A semantic query must select at least one measure or dimension.") as z.ZodType<CubeQuery>;

/** ManageTaskList: the agent's whole visible checklist, replacing the prior one. */
export const omniTaskListInputSchema = z.object({
  tasks: z.array(z.object({
    label: z.string().trim().min(3).max(200),
    completed: z.boolean(),
  }).strict()).min(1).max(12),
}).strict();

/** SearchSemanticModel: whole-topic lookup or a field search across topics. */
export const omniSearchModelInputSchema = z.object({
  topicName: z.string().trim().min(1).max(160).optional(),
  searchPattern: z.string().trim().min(1).max(200).optional(),
}).strict().refine((value) => value.topicName !== undefined || value.searchPattern !== undefined, {
  message: "Pass topicName to load a topic, searchPattern to search fields, or both to scope a search.",
});

/** FetchFieldValues: distinct stored values of one dimension for filter validation. */
export const omniFieldValuesInputSchema = z.object({
  field: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u),
  matching: z.string().trim().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

/** GenerateSemanticQuery: a named, governed Cube JSON query. */
export const omniGenerateQueryInputSchema = z.object({
  name: z.string().trim().min(3).max(160),
  topic: z.string().trim().min(1).max(160),
  query: omniCubeQuerySchema,
}).strict();

export const omniSummarizeInputSchema = z.object({
  resultId: ulidSchema,
}).strict();

export const omniVisualizeInputSchema = z.object({
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

/**
 * ComposeDashboard: the dashboard-architect turn's composed plan. Every
 * resultId must reference a query the same turn executed; the executor
 * enforces that and bounces violations back to the model for repair.
 * Strict-schema constraints apply: nullables instead of optionals, no
 * records or tuples.
 */
export const omniComposeDashboardInputSchema = z.object({
  dashboardTitle: z.string().trim().min(3).max(80),
  timeframe: z.string().trim().min(3).max(120),
  tiles: z.array(z.object({
    resultId: ulidSchema,
    kind: z.enum(["kpi", "chart", "table"]),
    title: z.string().trim().min(3).max(120),
    note: z.string().max(160).nullable(),
    width: z.enum(["quarter", "third", "half", "twoThirds", "full"]),
    valueKey: z.string().max(160).nullable(),
    chartType: z.enum(["bar", "line"]).nullable(),
    xKey: z.string().max(160).nullable(),
    yKey: z.string().max(160).nullable(),
    series: z.array(z.object({
      key: z.string().min(1).max(160),
      label: z.string().min(1).max(160),
    }).strict()).max(6).nullable(),
    stacked: z.boolean().nullable(),
    orientation: z.enum(["vertical", "horizontal"]).nullable(),
  // A whole build composes several tiles; an element edit (ADR 0134)
  // composes exactly the one replacement, so the floor is one.
  }).strict()).min(1).max(12),
}).strict();

export type OmniComposeDashboardInput = z.infer<typeof omniComposeDashboardInputSchema>;

/**
 * Provider token usage summed over every model request of the turn (retried
 * attempts included). cached/cacheWrite are subsets of inputTokens; the
 * cache hit rate is cachedInputTokens / inputTokens. Optional so a web tier
 * deployed ahead of the runtime keeps accepting results without it.
 */
export const omniTurnUsageSchema = z.object({
  requests: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  cacheWriteInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  reasoningTokens: z.number().int().min(0),
}).strict();

export type OmniTurnUsage = z.infer<typeof omniTurnUsageSchema>;

export const omniSemanticTurnResultSchema = z.object({
  answerState: z.enum(["Verified", "Qualified", "Exploratory", "Clarification", "No data", "Unavailable"]),
  queriesExecuted: z.number().int().min(0),
  modelRequests: z.number().int().min(0),
  durationMs: z.number().int().min(0).nullable(),
  usage: omniTurnUsageSchema.optional(),
  buildHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  semanticModelDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
// Result metadata is additive across independently deployed callers. Keep
// validating known fields, and strip future metadata rather than failing a
// completed analysis (ADR 0137). Request/tool schemas remain strict.
}).strip();

export type OmniSemanticTurnResult = z.infer<typeof omniSemanticTurnResultSchema>;
