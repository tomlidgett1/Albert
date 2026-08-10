import { z } from "zod";

export const questionClassV2Schema = z.enum([
  "lookup",
  "comparison",
  "diagnosis",
  "recommendation",
  "open_exploration",
]);
export type QuestionClassV2 = z.infer<typeof questionClassV2Schema>;

export const INVESTIGATION_BUDGETS_V2 = Object.freeze({
  lookup: Object.freeze({ maxRounds: 1, maxQueries: 1, maxDurationMs: 10_000 }),
  comparison: Object.freeze({
    maxRounds: 1,
    maxQueries: 3,
    maxDurationMs: 20_000,
  }),
  diagnosis: Object.freeze({
    maxRounds: 3,
    maxQueries: 10,
    maxDurationMs: 90_000,
  }),
  recommendation: Object.freeze({
    maxRounds: 4,
    maxQueries: 14,
    maxDurationMs: 120_000,
  }),
  open_exploration: Object.freeze({
    maxRounds: 3,
    maxQueries: 12,
    maxDurationMs: 120_000,
  }),
} satisfies Readonly<
  Record<
    QuestionClassV2,
    Readonly<{ maxRounds: number; maxQueries: number; maxDurationMs: number }>
  >
>);

export const definitionRequirementV2Schema = z
  .object({
    id: z.string().min(1),
    concept: z.string().min(1),
    material: z.boolean(),
    status: z.enum(["unresolved", "resolved", "defaulted"]),
    selectedDefinitionId: z.string().min(1).optional(),
  })
  .strict();

export const hypothesisV2Schema = z
  .object({
    id: z.string().min(1),
    proposition: z.string().min(1).max(1000),
    evidenceNodeIds: z.array(z.string().min(1)).min(1),
    status: z.enum([
      "untested",
      "testing",
      "supported",
      "refuted",
      "inconclusive",
    ]),
  })
  .strict();

export const evidenceNodeV2Schema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1).max(2000),
    workspaceId: z.string().min(1).optional(),
    operatorId: z.string().min(1).optional(),
    operatorArtifactId: z.string().min(1).optional(),
    status: z.enum([
      "pending",
      "ready",
      "running",
      "succeeded",
      "failed",
      "unavailable",
    ]),
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
  .strict();

export const investigationPlanV2Schema = z
  .object({
    id: z.string().min(1),
    objective: z.string().min(1).max(2000),
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
    queryBudget: z
      .object({
        maxRounds: z.number().int().positive(),
        maxQueries: z.number().int().positive(),
        maxDurationMs: z.number().int().positive(),
      })
      .strict(),
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
    status: z.enum(["draft", "running", "sufficient", "inconclusive"]),
    roundsUsed: z.number().int().nonnegative().default(0),
    queriesUsed: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine((plan, context) => {
    const allowed = INVESTIGATION_BUDGETS_V2[plan.questionClass];
    if (
      plan.queryBudget.maxRounds > allowed.maxRounds ||
      plan.queryBudget.maxQueries > allowed.maxQueries ||
      plan.queryBudget.maxDurationMs > allowed.maxDurationMs
    ) {
      context.addIssue({
        code: "custom",
        message: `Budget exceeds the ${plan.questionClass} ceiling.`,
        path: ["queryBudget"],
      });
    }
    const nodeIds = new Set(plan.evidenceNodes.map(({ id }) => id));
    const nodesById = new Map(
      plan.evidenceNodes.map((node) => [node.id, node]),
    );
    if (nodeIds.size !== plan.evidenceNodes.length)
      context.addIssue({
        code: "custom",
        message: "Evidence node ids must be unique.",
        path: ["evidenceNodes"],
      });
    if (
      new Set(plan.hypotheses.map(({ id }) => id)).size !==
      plan.hypotheses.length
    )
      context.addIssue({
        code: "custom",
        message: "Hypothesis ids must be unique.",
        path: ["hypotheses"],
      });
    if (
      new Set(plan.definitionsToResolve.map(({ id }) => id)).size !==
      plan.definitionsToResolve.length
    )
      context.addIssue({
        code: "custom",
        message: "Definition requirement ids must be unique.",
        path: ["definitionsToResolve"],
      });
    for (const hypothesis of plan.hypotheses) {
      for (const nodeId of hypothesis.evidenceNodeIds)
        if (!nodeIds.has(nodeId))
          context.addIssue({
            code: "custom",
            message: `Hypothesis ${hypothesis.id} references unknown evidence node ${nodeId}.`,
            path: ["hypotheses"],
          });
      const referencedNodes = hypothesis.evidenceNodeIds.flatMap((nodeId) => {
        const node = nodesById.get(nodeId);
        return node ? [node] : [];
      });
      if (["supported", "refuted"].includes(hypothesis.status)) {
        if (!referencedNodes.some(({ status }) => status === "succeeded"))
          context.addIssue({
            code: "custom",
            message: `Hypothesis ${hypothesis.id} cannot be ${hypothesis.status} without successful referenced evidence.`,
            path: ["hypotheses"],
          });
        if (
          referencedNodes.some(({ status }) =>
            ["pending", "ready", "running"].includes(status),
          )
        )
          context.addIssue({
            code: "custom",
            message: `Hypothesis ${hypothesis.id} cannot be ${hypothesis.status} while referenced evidence remains unfinished.`,
            path: ["hypotheses"],
          });
      }
    }
    for (const node of plan.evidenceNodes) {
      if (
        node.status === "succeeded" &&
        node.resultRefs.length === 0 &&
        !node.operatorArtifactId
      )
        context.addIssue({
          code: "custom",
          message: `Succeeded evidence node ${node.id} requires persisted result or operator evidence.`,
          path: ["evidenceNodes"],
        });
      if (node.operatorArtifactId && !node.operatorId)
        context.addIssue({
          code: "custom",
          message: `Evidence node ${node.id} must identify the deterministic operator used by its artifact.`,
          path: ["evidenceNodes"],
        });
    }
    for (const dependency of plan.dependencies) {
      if (
        !nodeIds.has(dependency.fromEvidenceNodeId) ||
        !nodeIds.has(dependency.toEvidenceNodeId)
      )
        context.addIssue({
          code: "custom",
          message: "Evidence dependency references an unknown node.",
          path: ["dependencies"],
        });
      if (dependency.fromEvidenceNodeId === dependency.toEvidenceNodeId)
        context.addIssue({
          code: "custom",
          message: "Evidence node cannot depend on itself.",
          path: ["dependencies"],
        });
    }
    const outgoing = new Map<string, string[]>();
    for (const dependency of plan.dependencies) {
      const targets = outgoing.get(dependency.fromEvidenceNodeId) ?? [];
      targets.push(dependency.toEvidenceNodeId);
      outgoing.set(dependency.fromEvidenceNodeId, targets);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): boolean => {
      if (visiting.has(nodeId)) return true;
      if (visited.has(nodeId)) return false;
      visiting.add(nodeId);
      const cyclic = (outgoing.get(nodeId) ?? []).some(visit);
      visiting.delete(nodeId);
      visited.add(nodeId);
      return cyclic;
    };
    if ([...nodeIds].some(visit))
      context.addIssue({
        code: "custom",
        message: "Evidence dependencies must form an acyclic DAG.",
        path: ["dependencies"],
      });
    if (
      ["diagnosis", "recommendation"].includes(plan.questionClass) &&
      plan.hypotheses.length < 2
    ) {
      context.addIssue({
        code: "custom",
        message: `${plan.questionClass} investigations require at least two competing hypotheses.`,
        path: ["hypotheses"],
      });
    }
    if (
      plan.roundsUsed > plan.queryBudget.maxRounds ||
      plan.queriesUsed > plan.queryBudget.maxQueries
    ) {
      context.addIssue({
        code: "custom",
        message: "Recorded investigation usage exceeds its immutable budget.",
        path: ["queryBudget"],
      });
    }
    if (plan.status === "sufficient") {
      if (
        plan.definitionsToResolve.some(
          ({ material, status }) => material && status === "unresolved",
        )
      )
        context.addIssue({
          code: "custom",
          message:
            "Sufficient investigations cannot retain unresolved material definitions.",
          path: ["definitionsToResolve"],
        });
      if (
        plan.evidenceNodes.some(({ status }) =>
          ["pending", "ready", "running"].includes(status),
        )
      )
        context.addIssue({
          code: "custom",
          message:
            "Sufficient investigations require every evidence node to be terminal.",
          path: ["evidenceNodes"],
        });
      if (!plan.evidenceNodes.some(({ status }) => status === "succeeded"))
        context.addIssue({
          code: "custom",
          message:
            "Sufficient investigations require at least one successfully grounded evidence node.",
          path: ["evidenceNodes"],
        });
      if (
        plan.hypotheses.some(({ status }) =>
          ["untested", "testing"].includes(status),
        )
      )
        context.addIssue({
          code: "custom",
          message:
            "Sufficient investigations require every hypothesis to be resolved.",
          path: ["hypotheses"],
        });
      if (
        ["diagnosis", "recommendation"].includes(plan.questionClass) &&
        !plan.hypotheses.some(({ status }) => status === "supported")
      ) {
        context.addIssue({
          code: "custom",
          message: `${plan.questionClass} investigations require at least one supported hypothesis before they can be sufficient.`,
          path: ["hypotheses"],
        });
      }
      if (
        plan.questionClass === "recommendation" &&
        !plan.evidenceNodes.some(
          ({ status, operatorArtifactId }) =>
            status === "succeeded" && Boolean(operatorArtifactId),
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Recommendation investigations require successfully persisted deterministic operator evidence.",
          path: ["evidenceNodes"],
        });
      }
    }
  });
export type InvestigationPlanV2 = z.infer<typeof investigationPlanV2Schema>;

export function createInvestigationPlanV2(
  input: Omit<
    InvestigationPlanV2,
    "queryBudget" | "roundsUsed" | "queriesUsed"
  >,
): InvestigationPlanV2 {
  return investigationPlanV2Schema.parse({
    ...input,
    queryBudget: INVESTIGATION_BUDGETS_V2[input.questionClass],
    roundsUsed: 0,
    queriesUsed: 0,
  });
}

export function readyEvidenceNodesV2(
  plan: InvestigationPlanV2,
): readonly InvestigationPlanV2["evidenceNodes"][number][] {
  const succeeded = new Set(
    plan.evidenceNodes
      .filter(({ status }) => status === "succeeded")
      .map(({ id }) => id),
  );
  return plan.evidenceNodes.filter(
    (node) =>
      node.status === "pending" &&
      plan.dependencies
        .filter(({ toEvidenceNodeId }) => toEvidenceNodeId === node.id)
        .every(({ fromEvidenceNodeId }) => succeeded.has(fromEvidenceNodeId)),
  );
}

export function investigationMustStopV2(
  plan: InvestigationPlanV2,
  elapsedMs: number,
): boolean {
  return (
    plan.status === "sufficient" ||
    plan.status === "inconclusive" ||
    plan.roundsUsed >= plan.queryBudget.maxRounds ||
    plan.queriesUsed >= plan.queryBudget.maxQueries ||
    elapsedMs >= plan.queryBudget.maxDurationMs
  );
}
