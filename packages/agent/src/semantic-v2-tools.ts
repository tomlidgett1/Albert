import { z } from "zod";
import {
  definitionRequirementV2Schema,
  evidenceNodeV2Schema,
  hypothesisV2Schema,
  analyticalOperatorIdV2Schema,
  questionClassV2Schema,
  queryBlockV2Schema,
  workspacePatchV2Schema,
} from "../../analytics-v2/src/index.js";

export const SEMANTIC_V2_TOOL_NAMES = Object.freeze([
  "get_semantic_context_v2",
  "create_workspace_v2",
  "continue_workspace_v2",
  "apply_workspace_patch_v2",
  "validate_workspace_v2",
  "preview_workspace_v2",
  "execute_workspace_v2",
  "inspect_result_v2",
  "fork_query_block_v2",
  "create_investigation_v2",
  "get_investigation_v2",
  "update_investigation_v2",
  "run_analytical_operator_v2",
  "update_insight_v2",
] as const);
export type SemanticV2ToolName = (typeof SEMANTIC_V2_TOOL_NAMES)[number];

export const semanticV2ToolInputSchemas = Object.freeze({
  get_semantic_context_v2: z
    .object({
      question: z.string().trim().min(1).max(4_000),
      limit: z.number().int().min(1).max(12).default(6),
    })
    .strict(),
  create_workspace_v2: z
    .object({
      blocks: z.array(queryBlockV2Schema).min(1).max(16),
    })
    .strict(),
  continue_workspace_v2: z
    .object({ sourceWorkspaceId: z.string().min(1) })
    .strict(),
  apply_workspace_patch_v2: z
    .object({
      workspaceId: z.string().min(1),
      patch: workspacePatchV2Schema,
    })
    .strict(),
  validate_workspace_v2: z
    .object({
      workspaceId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  preview_workspace_v2: z
    .object({
      workspaceId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  execute_workspace_v2: z
    .object({
      workspaceId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  inspect_result_v2: z
    .object({
      executionId: z.string().min(1),
      resultId: z.string().min(1),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  fork_query_block_v2: z
    .object({
      workspaceId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      blockId: z.string().min(1),
      newBlockId: z.string().min(1),
    })
    .strict(),
  create_investigation_v2: z
    .object({
      objective: z.string().min(1).max(2_000),
      questionClass: questionClassV2Schema,
      definitionsToResolve: z.array(definitionRequirementV2Schema).default([]),
      hypotheses: z.array(hypothesisV2Schema).default([]),
      evidenceNodes: z.array(evidenceNodeV2Schema).min(1),
      dependencies: z
        .array(
          z
            .object({
              fromEvidenceNodeId: z.string().min(1),
              toEvidenceNodeId: z.string().min(1),
            })
            .strict(),
        )
        .default([]),
      stopConditions: z
        .array(
          z.enum([
            "objective_satisfied",
            "contradictory_evidence",
            "budget_exhausted",
            "semantic_unavailable",
            "all_hypotheses_resolved",
          ]),
        )
        .min(1),
    })
    .strict(),
  get_investigation_v2: z
    .object({ investigationId: z.string().min(1) })
    .strict(),
  update_investigation_v2: z
    .object({
      investigationId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      operations: z
        .array(
          z.discriminatedUnion("op", [
            z
              .object({
                op: z.literal("resolve_definition"),
                requirementId: z.string().min(1),
                selectedDefinitionId: z.string().min(1),
                defaulted: z.boolean().default(false),
              })
              .strict(),
            z
              .object({
                op: z.literal("set_hypothesis_status"),
                hypothesisId: z.string().min(1),
                status: z.enum([
                  "testing",
                  "supported",
                  "refuted",
                  "inconclusive",
                ]),
              })
              .strict(),
            z
              .object({
                op: z.literal("set_evidence_status"),
                evidenceNodeId: z.string().min(1),
                status: z.enum([
                  "ready",
                  "running",
                  "succeeded",
                  "failed",
                  "unavailable",
                ]),
                workspaceId: z.string().min(1).optional(),
                operatorArtifactId: z.string().min(1).optional(),
                resultRefs: z
                  .array(
                    z
                      .object({
                        executionId: z.string().min(1),
                        resultId: z.string().min(1),
                      })
                      .strict(),
                  )
                  .max(20)
                  .default([]),
              })
              .strict(),
            z
              .object({
                op: z.literal("set_status"),
                status: z.enum(["running", "sufficient", "inconclusive"]),
              })
              .strict(),
          ]),
        )
        .min(1)
        .max(30),
    })
    .strict(),
  run_analytical_operator_v2: z
    .object({
      operatorId: analyticalOperatorIdV2Schema,
      bindings: z
        .array(
          z
            .object({
              role: z.enum(["primary", "current", "comparison", "secondary"]),
              executionId: z.string().min(1),
              resultId: z.string().min(1),
              rowIndex: z.number().int().nonnegative().optional(),
              columns: z
                .record(
                  z.string().regex(/^[a-z][a-zA-Z0-9_]*$/),
                  z.string().min(1),
                )
                .refine(
                  (value) =>
                    Object.keys(value).length > 0 &&
                    Object.keys(value).length <= 16,
                ),
            })
            .strict(),
        )
        .min(1)
        .max(4),
      // The model chooses the operator and binds governed columns; it never
      // supplies arithmetic inputs. Audited thresholds are static and business
      // tolerances come from the immutable tenant overlay.
      parameters: z.object({}).strict().default({}),
    })
    .strict(),
  update_insight_v2: z
    .object({
      insightKey: z.string().regex(/^[a-f0-9]{64}$/),
      expectedState: z.enum([
        "active",
        "accepted",
        "rejected",
        "resolved",
        "superseded",
      ]),
      state: z.enum(["active", "accepted", "rejected", "resolved"]),
      associatedAction: z.string().trim().min(1).max(2_000).optional(),
      userNote: z.string().trim().min(1).max(2_000).optional(),
      outcome: z
        .record(
          z.string(),
          z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
        )
        .optional(),
    })
    .strict(),
});

export type SemanticV2ToolInput<Name extends SemanticV2ToolName> = z.infer<
  (typeof semanticV2ToolInputSchemas)[Name]
>;

const FORBIDDEN_MODEL_KEYS = new Set([
  "sql",
  "query",
  "join",
  "joinKey",
  "joinCondition",
  "physicalTable",
  "physicalName",
  "column",
  "columnName",
]);

/** Defense in depth: V2 tool payloads may contain only semantic identifiers. */
export function assertSemanticV2ModelPayloadSafe(
  value: unknown,
  path = "input",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSemanticV2ModelPayloadSafe(item, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_MODEL_KEYS.has(key))
      throw new Error(`V2 model payload cannot contain ${path}.${key}.`);
    assertSemanticV2ModelPayloadSafe(item, `${path}.${key}`);
  }
}

export function parseSemanticV2ToolInput<Name extends SemanticV2ToolName>(
  name: Name,
  input: unknown,
): SemanticV2ToolInput<Name> {
  assertSemanticV2ModelPayloadSafe(input);
  return semanticV2ToolInputSchemas[name].parse(
    input,
  ) as SemanticV2ToolInput<Name>;
}
