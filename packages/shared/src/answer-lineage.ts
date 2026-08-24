import { z } from "zod";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const answerArtifactMeteringSchema = z
  .object({
    rateCardId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,119}$/),
    model: z.enum([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "grok-4.6",
      "claude-haiku-4-5-20251001",
      "claude-opus-5",
      "claude-sonnet-5",
      "gemini-3.7-flash",
    ]),
    fastMode: z.boolean(),
    requests: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    estimatedCostUsdMicros: z.number().int().nonnegative(),
    pricingCompleteness: z.enum(["request_level", "aggregate_estimate"]),
  })
  .strict()
  .refine(
    (value) =>
      value.cachedInputTokens + value.cacheWriteInputTokens <=
      value.inputTokens,
    {
      message:
        "Cached and cache-write tokens cannot exceed total input tokens.",
    },
  );

/** Signed internal request accepted only by the semantic service. */
export const answerArtifactFinalizationInputSchema = z
  .object({
    tenantId: ulidSchema,
    actorUserId: z.string().uuid(),
    conversationId: ulidSchema,
    turnId: ulidSchema,
    providerResponseId: z.string().trim().min(1).max(512),
    providerUsage: z.record(z.string(), z.unknown()),
    answerState: z.enum([
      "verified",
      "qualified",
      "exploratory",
      "clarification",
      "unavailable",
    ]),
    turnResultDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    metering: answerArtifactMeteringSchema,
    queryAuditIds: z.array(ulidSchema).max(20),
    directoryEvidence: z
      .object({
        field: z.literal("worker"),
        valueCount: z.number().int().nonnegative().max(50),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.queryAuditIds).size !== value.queryAuditIds.length) {
      context.addIssue({
        code: "custom",
        path: ["queryAuditIds"],
        message: "Query audit references must be unique.",
      });
    }
    const directoryAnswer =
      value.directoryEvidence !== undefined &&
      value.answerState === "qualified" &&
      value.directoryEvidence.valueCount > 0 &&
      value.queryAuditIds.length === 0;
    if (
      ["verified", "qualified", "exploratory"].includes(value.answerState) &&
      value.queryAuditIds.length === 0 &&
      !directoryAnswer
    ) {
      context.addIssue({
        code: "custom",
        path: ["queryAuditIds"],
        message: "An analytical answer requires query evidence.",
      });
    }
    if (value.directoryEvidence && value.queryAuditIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["directoryEvidence"],
        message: "Directory answers cannot also bind query audits.",
      });
    }
    if (
      value.answerState === "clarification" &&
      value.queryAuditIds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["queryAuditIds"],
        message: "A clarification cannot include executed query evidence.",
      });
    }
  });

export type AnswerArtifactFinalizationInput = z.infer<
  typeof answerArtifactFinalizationInputSchema
>;

const semanticV2EvidenceReferenceSchema = z
  .object({
    executionId: ulidSchema,
    resultId: z.string().min(1).max(240),
    rowIndex: z.number().int().nonnegative().optional(),
    columnKey: z.string().min(1).max(240).optional(),
    operatorArtifactId: ulidSchema.optional(),
    operatorOutputPath: z
      .array(
        z.union([z.string().min(1).max(160), z.number().int().nonnegative()]),
      )
      .min(1)
      .max(12)
      .optional(),
    publicationHash: sha256Schema,
  })
  .strict()
  .superRefine((reference, context) => {
    const cell =
      reference.rowIndex !== undefined || reference.columnKey !== undefined;
    if (
      cell &&
      (reference.rowIndex === undefined || reference.columnKey === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Cell references require both rowIndex and columnKey.",
      });
    if (!cell && !reference.operatorArtifactId)
      context.addIssue({
        code: "custom",
        message: "Evidence must reference a result cell or operator artifact.",
      });
    if (reference.operatorArtifactId && cell)
      context.addIssue({
        code: "custom",
        message:
          "An evidence reference must select either one result cell or one operator output, not both.",
      });
    if (reference.operatorArtifactId && !reference.operatorOutputPath)
      context.addIssue({
        code: "custom",
        path: ["operatorOutputPath"],
        message: "Operator evidence requires an exact operatorOutputPath.",
      });
    if (!reference.operatorArtifactId && reference.operatorOutputPath)
      context.addIssue({
        code: "custom",
        path: ["operatorOutputPath"],
        message: "operatorOutputPath is valid only with an operator artifact.",
      });
  });

const semanticV2GroundedClaimSchema = z
  .object({
    id: z.string().min(1).max(160),
    text: z.string().min(1).max(2_000),
    type: z.enum([
      "numeric",
      "comparative",
      "descriptive",
      "causal",
      "recommendation",
    ]),
    evidenceRefs: z.array(semanticV2EvidenceReferenceSchema).min(1).max(40),
    semanticState: z.enum(["verified", "derived", "exploratory"]),
    limitations: z.array(z.string().min(1).max(1_000)).max(20),
    controllability: z.enum(["high", "medium", "low"]).optional(),
    competingHypothesisRefs: z.array(z.string().min(1).max(160)).max(20),
    opportunityValue: z
      .string()
      .regex(/^-?\d+(?:\.\d{1,4})?$/)
      .optional(),
  })
  .strict()
  .superRefine((claim, context) => {
    if (claim.type === "causal" && claim.competingHypothesisRefs.length === 0)
      context.addIssue({
        code: "custom",
        path: ["competingHypothesisRefs"],
        message: "Causal claims require competing-hypothesis evidence.",
      });
    if (claim.type === "recommendation") {
      if (!claim.controllability)
        context.addIssue({
          code: "custom",
          path: ["controllability"],
          message: "Recommendations require controllability.",
        });
      if (!claim.opportunityValue)
        context.addIssue({
          code: "custom",
          path: ["opportunityValue"],
          message: "Recommendations require deterministic opportunity sizing.",
        });
      else if (
        !Number.isFinite(Number(claim.opportunityValue)) ||
        Number(claim.opportunityValue) <= 0
      )
        context.addIssue({
          code: "custom",
          path: ["opportunityValue"],
          message: "Recommendation opportunity sizing must be positive.",
        });
      if (claim.limitations.length === 0)
        context.addIssue({
          code: "custom",
          path: ["limitations"],
          message: "Recommendations require at least one explicit limitation.",
        });
    }
  });

/** Signed Semantic Execution V2 finalization. It binds the public answer to
 * immutable workspace executions and claim-level cell/operator evidence. */
export const semanticV2AnswerArtifactFinalizationInputSchema = z
  .object({
    tenantId: ulidSchema,
    actorUserId: z.string().uuid(),
    conversationId: ulidSchema,
    turnId: ulidSchema,
    providerResponseId: z.string().trim().min(1).max(512),
    providerUsage: z.record(z.string(), z.unknown()),
    answerState: z.enum([
      "verified",
      "derived",
      "exploratory",
      "clarification",
      "no_data",
      "unavailable",
    ]),
    turnResultDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    metering: answerArtifactMeteringSchema,
    executionIds: z.array(ulidSchema).max(20),
    publicationHash: sha256Schema.nullable(),
    investigationId: ulidSchema.nullable(),
    claims: z.array(semanticV2GroundedClaimSchema).max(12),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.executionIds).size !== value.executionIds.length)
      context.addIssue({
        code: "custom",
        path: ["executionIds"],
        message: "Execution references must be unique.",
      });
    if (value.executionIds.length > 0 && !value.publicationHash)
      context.addIssue({
        code: "custom",
        path: ["publicationHash"],
        message: "Executed answers require a pinned publication.",
      });
    if (
      value.answerState === "clarification" &&
      (value.executionIds.length > 0 || value.claims.length > 0)
    )
      context.addIssue({
        code: "custom",
        message: "Clarification cannot bind executions or claims.",
      });
    if (
      value.answerState === "no_data" &&
      (value.executionIds.length === 0 || value.claims.length > 0)
    )
      context.addIssue({
        code: "custom",
        message:
          "No-data answers require execution evidence and no positive claims.",
      });
    if (
      ["verified", "derived", "exploratory"].includes(value.answerState) &&
      (value.executionIds.length === 0 || value.claims.length === 0)
    )
      context.addIssue({
        code: "custom",
        message:
          "Analytical answers require execution evidence and grounded claims.",
      });
  });
export type SemanticV2AnswerArtifactFinalizationInput = z.infer<
  typeof semanticV2AnswerArtifactFinalizationInputSchema
>;

/** Provider-discriminated finalization used by net-new runtimes. v1 remains unchanged. */
export const answerArtifactFinalizationV2InputSchema =
  answerArtifactFinalizationInputSchema
    .extend({
      provider: z.literal("anthropic"),
    })
    .strict();
export type AnswerArtifactFinalizationV2Input = z.infer<
  typeof answerArtifactFinalizationV2InputSchema
>;

export const answerArtifactFinalizationResultSchema = z
  .object({
    answerArtifactId: ulidSchema,
    artifactDigest: sha256Schema,
    idempotentReplay: z.boolean(),
  })
  .strict();

export type AnswerArtifactFinalizationResult = z.infer<
  typeof answerArtifactFinalizationResultSchema
>;

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
export const modelUsageCheckpointInputSchema = z
  .object({
    tenantId: ulidSchema,
    actorUserId: z.string().uuid(),
    conversationId: ulidSchema,
    turnId: ulidSchema,
    providerResponseId: z.string().trim().min(1).max(512).nullable(),
    providerUsage: z.record(z.string(), z.unknown()),
    metering: answerArtifactMeteringSchema,
    outcome: modelUsageOutcomeSchema,
  })
  .strict();
export type ModelUsageCheckpointInput = z.infer<
  typeof modelUsageCheckpointInputSchema
>;

export const modelUsageCheckpointResultSchema = z
  .object({
    meteringDigest: sha256Schema,
    providerUsageDigest: sha256Schema,
    stage: z.enum(["provider", "terminal"]),
    outcome: modelUsageOutcomeSchema,
    idempotentReplay: z.boolean(),
  })
  .strict();
export type ModelUsageCheckpointResult = z.infer<
  typeof modelUsageCheckpointResultSchema
>;
