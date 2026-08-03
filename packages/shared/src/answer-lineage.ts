import { z } from "zod";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const answerArtifactMeteringSchema = z.object({
  rateCardId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,119}$/),
  model: z.enum(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]),
  fastMode: z.boolean(),
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsdMicros: z.number().int().nonnegative(),
  pricingCompleteness: z.enum(["request_level", "aggregate_estimate"]),
}).strict().refine(
  (value) => value.cachedInputTokens + value.cacheWriteInputTokens <= value.inputTokens,
  { message: "Cached and cache-write tokens cannot exceed total input tokens." },
);

/** Signed internal request accepted only by the semantic service. */
export const answerArtifactFinalizationInputSchema = z.object({
  tenantId: ulidSchema,
  actorUserId: z.string().uuid(),
  conversationId: ulidSchema,
  turnId: ulidSchema,
  providerResponseId: z.string().trim().min(1).max(512),
  providerUsage: z.record(z.string(), z.unknown()),
  answerState: z.enum(["verified", "qualified", "exploratory", "clarification", "unavailable"]),
  turnResultDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  metering: answerArtifactMeteringSchema,
  queryAuditIds: z.array(ulidSchema).max(20),
}).strict().superRefine((value, context) => {
  if (new Set(value.queryAuditIds).size !== value.queryAuditIds.length) {
    context.addIssue({ code: "custom", path: ["queryAuditIds"], message: "Query audit references must be unique." });
  }
  if (["verified", "qualified", "exploratory"].includes(value.answerState) && value.queryAuditIds.length === 0) {
    context.addIssue({ code: "custom", path: ["queryAuditIds"], message: "An analytical answer requires query evidence." });
  }
  if (value.answerState === "clarification" && value.queryAuditIds.length > 0) {
    context.addIssue({ code: "custom", path: ["queryAuditIds"], message: "A clarification cannot include executed query evidence." });
  }
});

export type AnswerArtifactFinalizationInput = z.infer<typeof answerArtifactFinalizationInputSchema>;

export const answerArtifactFinalizationResultSchema = z.object({
  answerArtifactId: ulidSchema,
  artifactDigest: sha256Schema,
  idempotentReplay: z.boolean(),
}).strict();

export type AnswerArtifactFinalizationResult = z.infer<typeof answerArtifactFinalizationResultSchema>;

export const modelUsageOutcomeSchema = z.enum([
  "provider_completed",
  "answer_finalized",
  "client_disconnected",
  "turn_timeout",
  "runtime_failure",
  "artifact_finalization_failed",
]);
export type ModelUsageOutcome = z.infer<typeof modelUsageOutcomeSchema>;

/** Signed internal usage checkpoint, independent of answer finalization. */
export const modelUsageCheckpointInputSchema = z.object({
  tenantId: ulidSchema,
  actorUserId: z.string().uuid(),
  conversationId: ulidSchema,
  turnId: ulidSchema,
  providerResponseId: z.string().trim().min(1).max(512).nullable(),
  providerUsage: z.record(z.string(), z.unknown()),
  metering: answerArtifactMeteringSchema,
  outcome: modelUsageOutcomeSchema,
}).strict();
export type ModelUsageCheckpointInput = z.infer<typeof modelUsageCheckpointInputSchema>;

export const modelUsageCheckpointResultSchema = z.object({
  meteringDigest: sha256Schema,
  providerUsageDigest: sha256Schema,
  stage: z.enum(["provider", "terminal"]),
  outcome: modelUsageOutcomeSchema,
  idempotentReplay: z.boolean(),
}).strict();
export type ModelUsageCheckpointResult = z.infer<typeof modelUsageCheckpointResultSchema>;
