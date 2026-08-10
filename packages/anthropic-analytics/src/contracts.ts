import { z } from "zod";

export const ANTHROPIC_RUNTIME = "anthropic-agent-sdk" as const;
export const ANTHROPIC_PRIMARY_MODEL = "claude-opus-5" as const;
export const ANTHROPIC_FALLBACK_MODEL = "claude-sonnet-5" as const;
export const ANTHROPIC_SDK_VERSION = "0.3.226" as const;

export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const answerOutcomeSchema = z.enum([
  "verified",
  "qualified",
  "exploratory",
  "clarification",
  "unavailable",
]);
export type AnswerOutcome = z.infer<typeof answerOutcomeSchema>;

export const anthropicConversationRequestSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  conversationId: ulidSchema.optional(),
  confirmedOption: z.object({
    offeredTurnId: ulidSchema,
    optionId: z.string().trim().min(1).max(80),
  }).strict().optional(),
}).strict();

export const anthropicInternalTurnSchema = z.object({
  tenantId: ulidSchema,
  actorUserId: z.string().uuid(),
  role: z.enum(["owner", "manager", "bookkeeper", "internal_operator"]),
  conversationId: ulidSchema,
  turnId: ulidSchema,
  message: z.string().trim().min(1).max(8_000),
  confirmedPreference: z.string().trim().min(1).max(120).optional(),
  confirmedValue: z.string().trim().min(1).max(300).optional(),
}).strict();
export type AnthropicInternalTurn = z.infer<typeof anthropicInternalTurnSchema>;

export const cellReferenceSchema = z.object({
  resultId: z.string().trim().min(1).max(200),
  rowIndex: z.number().int().nonnegative(),
  columnKey: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
}).strict();

export const finalAnswerSchema = z.object({
  outcome: answerOutcomeSchema,
  text: z.string().trim().min(1).max(4_000),
  resultIds: z.array(z.string().trim().min(1).max(200)).max(20),
  claims: z.array(z.object({
    statement: z.string().trim().min(1).max(500),
    assertion: z.enum(["value", "highest", "lowest", "greater_than", "less_than", "equal"]),
    refs: z.array(cellReferenceSchema).min(1).max(12),
  }).strict()).max(24),
  followUps: z.array(z.string().trim().min(1).max(200)).max(4),
  clarification: z.object({
    question: z.string().trim().min(1).max(300),
    options: z.array(z.object({
      id: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
      label: z.string().trim().min(1).max(120),
    }).strict()).min(2).max(3),
  }).strict().optional(),
  unavailableReason: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.outcome === "clarification" && !value.clarification) {
    context.addIssue({ code: "custom", path: ["clarification"], message: "Clarification output requires a question and options." });
  }
  if (value.outcome === "unavailable" && !value.unavailableReason) {
    context.addIssue({ code: "custom", path: ["unavailableReason"], message: "Unavailable output requires an exact reason." });
  }
  if (["verified", "qualified", "exploratory"].includes(value.outcome) && value.resultIds.length === 0) {
    context.addIssue({ code: "custom", path: ["resultIds"], message: "An analytical output requires executed result evidence." });
  }
});
export type FinalAnswer = z.infer<typeof finalAnswerSchema>;

/** JSON Schema supplied directly to Claude Agent SDK structured output. */
export const FINAL_ANSWER_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["outcome", "text", "resultIds", "claims", "followUps"],
  properties: {
    outcome: { type: "string", enum: answerOutcomeSchema.options },
    text: { type: "string", minLength: 1, maxLength: 4_000 },
    resultIds: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 200 } },
    claims: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "assertion", "refs"],
        properties: {
          statement: { type: "string", minLength: 1, maxLength: 500 },
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
                resultId: { type: "string", minLength: 1, maxLength: 200 },
                rowIndex: { type: "integer", minimum: 0 },
                columnKey: { type: "string", pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$" },
              },
            },
          },
        },
      },
    },
    followUps: { type: "array", maxItems: 4, items: { type: "string", minLength: 1, maxLength: 200 } },
    clarification: {
      type: "object",
      additionalProperties: false,
      required: ["question", "options"],
      properties: {
        question: { type: "string", minLength: 1, maxLength: 300 },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "label"],
            properties: {
              id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,79}$" },
              label: { type: "string", minLength: 1, maxLength: 120 },
            },
          },
        },
      },
    },
    unavailableReason: { type: "string", minLength: 1, maxLength: 500 },
  },
} as const);

/** Restricted review output. The reviewer has no tools and may only approve or
 * repair the structured candidate from the bounded evidence summary it sees. */
export const REVIEW_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["approved", "issues"],
  properties: {
    approved: { type: "boolean" },
    issues: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 300 } },
    revisedAnswer: FINAL_ANSWER_JSON_SCHEMA,
  },
} as const);

export const reviewOutputSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.string().trim().min(1).max(300)).max(8),
  revisedAnswer: finalAnswerSchema.optional(),
}).strict();
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

const semanticProvenanceSchema = z.object({
  bundleHash: z.string().min(1),
  registryVersion: z.string().min(1),
  identityGraph: z.object({ version: z.number().int().nonnegative(), hash: z.string() }).passthrough(),
  sources: z.array(z.string()),
  sourceWatermarks: z.record(z.string(), z.string()),
  sourceDetails: z.array(z.record(z.string(), z.unknown())).default([]),
  definitionsApplied: z.array(z.string()),
  definitionDetails: z.array(z.record(z.string(), z.unknown())).default([]),
  timeRange: z.record(z.string(), z.unknown()).optional(),
  authorityWarning: z.string().optional(),
}).passthrough();

export const semanticResponseSchema = z.object({
  state: answerOutcomeSchema,
  resultId: z.string().min(1).max(200).optional(),
  data: z.object({
    columns: z.array(z.string().min(1)),
    rows: z.array(z.record(z.string(), z.unknown())).max(500),
    filterRefs: z.array(z.record(z.string(), z.string())).optional(),
    resultWindow: z.unknown().optional(),
  }).strict().optional(),
  queryAudit: z.object({
    queryAuditId: ulidSchema,
    route: z.enum(["semantic", "source_exploration", "sql_first"]),
    bundleHash: z.string().min(1),
    registryVersion: z.string().min(1),
    resultDigest: z.string().min(1),
    compilerOutputHash: z.string().min(1),
  }).strict().optional(),
  provenance: semanticProvenanceSchema,
  validation: z.object({
    status: z.enum(["passed", "warning", "failed", "blocked"]),
    checks: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()),
  }).strict(),
  performance: z.object({
    cacheHit: z.boolean(),
    durationMs: z.number().nonnegative(),
    rowCount: z.number().int().nonnegative(),
  }).strict(),
}).passthrough();
export type SemanticResponse = z.infer<typeof semanticResponseSchema>;

export const anthropicMeteringSchema = z.object({
  rateCardId: z.literal("anthropic-claude-5-2026-07-24"),
  model: z.enum([ANTHROPIC_PRIMARY_MODEL, ANTHROPIC_FALLBACK_MODEL]),
  fastMode: z.literal(false),
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsdMicros: z.number().int().nonnegative(),
  pricingCompleteness: z.literal("request_level"),
}).strict();
export type AnthropicMetering = z.infer<typeof anthropicMeteringSchema>;

export const internalCompletionSchema = z.object({
  providerResponseId: z.string().trim().min(1).max(512),
  providerUsage: z.record(z.string(), z.unknown()),
  metering: anthropicMeteringSchema,
  answerState: answerOutcomeSchema,
  turnResultDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  queryAuditIds: z.array(ulidSchema).max(20),
  terminalEvent: z.record(z.string(), z.unknown()),
  sessionId: z.string().uuid(),
  telemetry: z.object({
    durationMs: z.number().int().nonnegative(),
    sqlAttempts: z.number().int().nonnegative(),
    sqlSuccesses: z.number().int().nonnegative(),
    sqlFailures: z.number().int().nonnegative(),
    groundingRejections: z.number().int().nonnegative(),
    sessionMirrorErrors: z.number().int().nonnegative(),
    reviewRequired: z.boolean(),
    reviewCompleted: z.boolean(),
    providerFallback: z.boolean(),
  }).strict(),
}).strict();
export type InternalCompletion = z.infer<typeof internalCompletionSchema>;
