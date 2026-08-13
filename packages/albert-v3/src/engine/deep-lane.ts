import { Agent, system, user } from "@openai/agents";
import { z } from "zod";
import { sanitizeTraceText } from "../../../shared/src/index.js";
import {
  ANSWER_CONTRACT,
  buildKnowledgeBlock,
  finalAnswerSchema,
  laneConversationInput,
  laneModelSettings,
  renderAlwaysRulesForRoute,
  renderRequestContext,
  v3PromptCacheKey,
  withV3PromptCacheBoundary,
  type FinalAnswer,
  type LaneRunInput,
} from "./lanes.js";
import { createComposeTableTool, createV3Tools } from "./tools.js";
import type { V3TurnContext } from "./context.js";
import {
  createV3CommentaryState,
  prepareV3CommentaryUpdate,
  type V3CommentaryKind,
} from "./commentary.js";
import { resolveV3ToolRoute, type V3ToolRoute } from "./connector-routing.js";

export const branchPlanSchema = z.object({
  branches: z.array(z.object({
    title: z.string().min(3).max(80),
    question: z.string().min(10).max(400),
    rationale: z.string().max(300),
  })).min(2).max(5),
});

export const branchFindingsSchema = z.object({
  headline: z.string().min(3).max(240),
  findings: z.array(z.string().min(10).max(500)).min(1).max(6),
  /** Dollar or percentage size of the opportunity/problem when quantifiable. */
  materiality: z.string().max(200),
  confidence: z.enum(["high", "medium", "low"]),
});

type BranchFindings = z.infer<typeof branchFindingsSchema>;

function naturalList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "the available evidence";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

async function emitDeepCommentary(
  context: V3TurnContext,
  kind: V3CommentaryKind,
  message: string,
): Promise<void> {
  const update = prepareV3CommentaryUpdate({
    state: context.commentary,
    kind,
    message,
    queryCount: context.executedQueries.length,
  });
  if (update.accepted) {
    await context.emit({ type: "narrative", text: update.text });
  }
}

/**
 * The deep lane: decompose an open-ended question into parallel investigation
 * branches (independent chains of thought over governed queries), then
 * cross-examine and synthesise the findings into ranked recommendations.
 */
export async function runDeepLane(input: LaneRunInput): Promise<FinalAnswer | undefined> {
  const budget = input.config.lanes.deep;
  // Generic health checks must still let the planner consider governed
  // Shopify-native reporting when Shopify is connected. Branches are routed
  // independently below, so unrelated branches never inherit those tools.
  const planningRoute: V3ToolRoute = !input.context.toolRoute.shopifyQL
      && Boolean(input.context.shopifyQL)
      && input.context.toolRoute.activeCubeConnectors.includes("shopify")
    ? Object.freeze({
        ...input.context.toolRoute,
        shopifyQL: true,
        mode: input.context.toolRoute.cube ? "mixed" : "shopifyql",
        reasons: Object.freeze([
          ...input.context.toolRoute.reasons,
          "deep planner connected-source coverage",
        ]),
      })
    : input.context.toolRoute;
  const knowledge = buildKnowledgeBlock({
    config: input.config,
    catalogue: input.catalogue,
    route: planningRoute,
  });

  await input.context.emit({
    type: "progress",
    status: "running",
    stage: "planning",
    label: "Planning a deep investigation",
    detail: sanitizeTraceText(input.intent.resolvedQuestion, 300),
    progress: 0.1,
  });

  const decomposer = new Agent({
    name: "Albert v3 investigation planner",
    instructions: `You decompose an open-ended business question about a small business
into 2-${budget.maxBranches ?? 5} independent investigation branches. Each branch
must be answerable from the governed tools listed below (sales, accounting, payroll,
workforce, customers and official live Shopify reports),
target a distinct angle (for example: margin structure, discount leakage, refund drag,
product mix, retention, cost of acceptance), and carry a precise investigable question.
Do not create branches the data cannot support.

${knowledge}`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", {
      promptCacheKey: v3PromptCacheKey({
        partition: input.context.promptCachePartition,
        profile: "deep-planner",
        route: planningRoute,
      }),
    }),
    outputType: branchPlanSchema,
  });
  const planRun = await input.runner.run(decomposer, laneConversationInput(input), {
    maxTurns: 2,
    signal: input.context.signal,
  });
  const plan = planRun.finalOutput;
  if (!plan) return undefined;

  await emitDeepCommentary(
    input.context,
    "plan",
    `I’ll examine ${naturalList(plan.branches.map((branch) => branch.title))} in parallel, then cross-check the strongest findings before recommending what to do next.`,
  );

  await input.context.emit({
    type: "progress",
    status: "complete",
    stage: "planning",
    label: `Investigating ${plan.branches.length} angles in parallel`,
    detail: sanitizeTraceText(plan.branches.map((branch) => branch.title).join(" · "), 300),
    progress: 0.2,
  });

  const perBranchQueries = Math.max(
    3,
    Math.floor(budget.maxQueries / plan.branches.length),
  );
  const branchResults = await Promise.all(plan.branches.map(async (branch) => {
    const branchRoute = resolveV3ToolRoute({
      question: branch.question,
      resolvedQuestion: branch.question,
      lane: "deep",
      conversation: [],
      config: input.config,
      activeConnectors: input.context.toolRoute.activeCubeConnectors,
      cubeAvailable: input.catalogue.views.length > 0,
      shopifyQLAvailable: Boolean(input.context.shopifyQL),
      shopifyAdminAvailable: Boolean(input.context.shopifyAdmin),
    });
    const branchKnowledge = buildKnowledgeBlock({
      config: input.config,
      catalogue: input.catalogue,
      route: branchRoute,
    });
    // Branches share the turn budget, provenance and result registry, but
    // carry their own label so parallel progress stays legible.
    const branchContext: V3TurnContext = {
      ...input.context,
      toolRoute: branchRoute,
      branchLabel: branch.title,
      // Branches report evidence to the lead analyst; they do not each narrate
      // their own activity to the owner.
      commentary: createV3CommentaryState(false),
    };
    const agent = new Agent<V3TurnContext, typeof branchFindingsSchema>({
      name: `Albert v3 branch: ${branch.title}`,
      instructions: `You are one investigation branch of a deeper analysis. Investigate exactly
this question with governed typed queries and report findings; other branches cover the
other angles, so stay in your lane.

${branchKnowledge}

Run at most ${perBranchQueries} queries. Ground every finding in retrieved numbers and
quantify materiality in dollars where possible. If the data shows nothing noteworthy,
say so plainly; a null finding is a valid finding.`,
      model: input.preferences.model,
      modelSettings: laneModelSettings(input.preferences, budget.reasoningEffort, {
        toolChoice: "required",
        promptCacheKey: v3PromptCacheKey({
          partition: input.context.promptCachePartition,
          profile: "deep-branch",
          route: branchRoute,
        }),
      }),
      tools: [...createV3Tools({
        route: branchRoute,
        lane: "deep",
        purpose: "investigation",
      })],
      outputType: branchFindingsSchema,
    });
    try {
      const run = await input.runner.run(agent, withV3PromptCacheBoundary(
        input.preferences.model,
        [
          system(`${renderRequestContext({
            config: input.config,
            question: branch.question,
          })}\n\n# Branch assignment\nBranch: ${branch.title}\nWhy it matters: ${branch.rationale}`),
          user(branch.question),
        ],
      ), {
        context: branchContext,
        maxTurns: 16,
        signal: input.context.signal,
      });
      const findings: BranchFindings | undefined = run.finalOutput;
      await input.context.emit({
        type: "progress",
        status: "complete",
        stage: "query",
        label: sanitizeTraceText(`${branch.title}: ${findings?.headline ?? "no conclusive finding"}`, 160),
      });
      return { branch, findings };
    } catch (error) {
      await input.context.emit({
        type: "progress",
        status: "warning",
        stage: "query",
        label: sanitizeTraceText(`${branch.title} could not finish`, 160),
        detail: sanitizeTraceText(error instanceof Error ? error.message : "branch failed", 200),
      });
      return { branch, findings: undefined };
    }
  }));

  const completed = branchResults.filter((result) => result.findings);
  if (completed.length === 0) return undefined;

  const notable = completed.find((result) => result.findings?.confidence === "high")
    ?? completed.find((result) => result.findings?.confidence === "medium")
    ?? completed[0];
  if (notable?.findings) {
    const headline = sanitizeTraceText(notable.findings.headline, 220).replace(/[.!?]+$/u, "");
    const message = notable.findings.confidence === "low"
      ? `The evidence is still mixed, but one lead is emerging: ${headline}. I’m checking it against the other areas before drawing a conclusion.`
      : `One material signal is standing out: ${headline}. I’m cross-checking it against the other areas before finalising the recommendation.`;
    await emitDeepCommentary(input.context, "finding", message);
  }

  await input.context.emit({
    type: "progress",
    status: "running",
    stage: "planning",
    label: "Cross-examining findings and composing recommendations",
    progress: 0.85,
  });

  const evidenceSummary = input.context.executedQueries
    .map((query) => `- [${query.view}] ${query.topic} (${query.rowCount} rows, ${query.timeRangeLabel})`)
    .join("\n");
  const tableSources = [...input.context.tableResults.values()]
    .filter((table) => table.presentation === "evidence")
    .slice(0, 12)
    .map((table) => ({
      resultId: table.resultId,
      caption: table.caption,
      columns: table.columns,
      rows: table.rows,
    }));
  const findingsBlock = branchResults.map(({ branch, findings }) => {
    if (!findings) return `## ${branch.title}\n(branch failed; no findings)`;
    return `## ${branch.title} (confidence: ${findings.confidence})
Headline: ${findings.headline}
Materiality: ${findings.materiality}
${findings.findings.map((finding) => `- ${finding}`).join("\n")}`;
  }).join("\n\n");

  const synthesiser = new Agent({
    name: "Albert v3 synthesiser",
    instructions: `You are Albert's lead analyst. Independent investigation branches have
reported back. Cross-examine them: discard weak or low-confidence claims that conflict
with stronger evidence, rank the remaining insights by dollar materiality, and compose
the final answer with concrete recommendations grounded ONLY in the branch findings
below. Do not introduce numbers that are not in the findings. Profit figures are gross
profit (before operating costs); say so once, briefly, only where it matters. End with
the two or three highest-impact actions.

${ANSWER_CONTRACT}

# Business rules
${renderAlwaysRulesForRoute(input.config, input.context.toolRoute)}`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "high", {
      promptCacheKey: v3PromptCacheKey({
        partition: input.context.promptCachePartition,
        profile: "deep-synthesiser",
        route: input.context.toolRoute,
      }),
    }),
    tools: [createComposeTableTool()],
    outputType: finalAnswerSchema,
  });
  const synthesis = await input.runner.run(
    synthesiser,
    withV3PromptCacheBoundary(input.preferences.model, [
      system(`# Branch findings\n${findingsBlock}\n\n# Queries executed this turn\n${evidenceSummary}\n\n# Governed result cells available to compose_table\n${JSON.stringify(tableSources)}`),
      user(input.intent.resolvedQuestion),
    ]),
    { context: input.context, maxTurns: 6, signal: input.context.signal },
  );
  return synthesis.finalOutput;
}
