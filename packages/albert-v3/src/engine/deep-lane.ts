import { Agent, system, user, type AgentInputItem } from "@openai/agents";
import { z } from "zod";
import { isXaiModel, sanitizeTraceText } from "../../../shared/src/index.js";
import {
  ANSWER_CONTRACT,
  buildKnowledgeBlock,
  finalAnswerSchema,
  GROK_INVESTIGATION_ADDENDUM,
  laneConversationInput,
  laneModelSettings,
  renderAlwaysRulesForRoute,
  renderRequestContext,
  v3PromptCacheKey,
  withV3PromptCacheBoundary,
  type FinalAnswer,
  type LaneRunInput,
} from "./lanes.js";
import { MISSING_QUERY_RETRY_MESSAGE } from "./grounding.js";
import { createComposeTableTool, createV3Tools } from "./tools.js";
import { runVisualiser } from "./visualise-lane.js";
import type { V3TurnContext } from "./context.js";
import {
  clipToSentence,
  createV3CommentaryState,
  looksLikeFinding,
  prepareV3CommentaryUpdate,
  STEP_SUMMARY_MAX_CHARS,
  type V3CommentaryKind,
} from "./commentary.js";
import { resolveV3ToolRoute, type V3ToolRoute } from "./connector-routing.js";
import { applyPlannedEvidenceBindings, planCoverageError } from "./initial-plan.js";

export const branchPlanSchema = z.object({
  branches: z.array(z.object({
    title: z.string().min(3).max(80),
    question: z.string().min(10).max(400),
    rationale: z.string().max(300),
    coversPlanStepIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{2,47}$/u)).max(4),
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

function endSentence(value: string): string {
  const text = value.trim();
  if (!text) return "";
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

/**
 * A glanceable owner-facing summary for a finished branch: the headline, plus
 * the size of the effect when it is short and adds a figure the headline
 * lacks. Supporting detail stays in the answer — the wait-screen paragraph
 * must read in a couple of seconds.
 */
export function branchStepSummary(title: string, findings: BranchFindings): string {
  const headline = endSentence(clipToSentence(sanitizeTraceText(findings.headline, 240), 200));
  const materiality = endSentence(sanitizeTraceText(findings.materiality, 160));
  const materialityFits = materiality.length > 0
    && materiality.length <= 110
    && !/^(?:not|unknown|n\/a|none|unclear|cannot|insufficient)/iu.test(materiality)
    && !headline.toLocaleLowerCase("en-AU").includes(materiality.toLocaleLowerCase("en-AU").replace(/\.$/u, ""));
  const body = materialityFits ? `${headline} ${materiality}` : headline;
  // A branch that produced no concrete figure has nothing worth interrupting
  // the owner with; the commentary gate drops it and the answer carries it.
  if (!looksLikeFinding(body)) return "";
  return clipToSentence(sanitizeTraceText(`${title}: ${body}`, STEP_SUMMARY_MAX_CHARS), STEP_SUMMARY_MAX_CHARS);
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

/** Queries a deep-lane branch ran itself; branches share one turn-wide list. */
function branchQueries(context: V3TurnContext, branchTitle: string) {
  return context.executedQueries.filter((query) => query.branchLabel === branchTitle);
}

/**
 * Grok 4.6 fills a structured outputType on its first Responses turn and skips
 * tools (see runGrokInvestigation in lanes.ts). A deep-lane branch therefore
 * investigates with required tool choice and no output schema, retries once if
 * it still ran nothing, then composes its findings from the queries it ran.
 * Returns undefined when the branch never retrieved evidence, so it is reported
 * as failed rather than shipping an invented headline.
 */
async function runGrokBranch(args: Readonly<{
  input: LaneRunInput;
  branchContext: V3TurnContext;
  branchTitle: string;
  instructions: string;
  tools: ReturnType<typeof createV3Tools>;
  conversation: AgentInputItem[];
  effort: Parameters<typeof laneModelSettings>[1];
}>): Promise<BranchFindings | undefined> {
  const { input, branchContext, branchTitle } = args;
  const investigator = new Agent<V3TurnContext>({
    name: `Albert v3 branch: ${branchTitle}`,
    instructions: `${args.instructions}\n${GROK_INVESTIGATION_ADDENDUM}`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, args.effort, { toolChoice: "required" }),
    tools: [...args.tools],
  });
  const runOptions = { context: branchContext, maxTurns: 16, signal: input.context.signal };
  await input.runner.run(investigator, args.conversation, runOptions);
  if (branchQueries(branchContext, branchTitle).length === 0) {
    await input.runner.run(
      investigator,
      [...args.conversation, user(MISSING_QUERY_RETRY_MESSAGE)],
      runOptions,
    );
  }
  const queries = branchQueries(branchContext, branchTitle);
  if (queries.length === 0) return undefined;

  const topics = new Set(queries.map((query) => query.topic));
  const evidence = [...branchContext.tableResults.values()]
    .filter((table) => table.presentation === "evidence" && topics.has(table.caption))
    .slice(0, 12)
    .map((table) => ({
      resultId: table.resultId,
      caption: table.caption,
      columns: table.columns,
      rows: table.rows,
    }));
  const composer = new Agent<V3TurnContext, typeof branchFindingsSchema>({
    name: `Albert v3 branch findings: ${branchTitle}`,
    instructions: `You are one investigation branch of a deeper analysis. The queries for
your branch have already run; their results are below. Report your findings from those
numbers only. Do not run new queries. Ground every finding in retrieved numbers and
quantify materiality in dollars where possible. If the data shows nothing noteworthy,
say so plainly; a null finding is a valid finding.

# Queries executed by this branch
${queries.map((query) => `- [${query.view}] ${query.topic} (${query.rowCount} rows, ${query.timeRangeLabel})`).join("\n")}

# Result cells
${JSON.stringify(evidence)}`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", { maxEffort: "medium" }),
    outputType: branchFindingsSchema,
  });
  const run = await input.runner.run(composer, args.conversation, {
    context: branchContext,
    maxTurns: 2,
    signal: input.context.signal,
  });
  return run.finalOutput;
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
    businessContext: input.context.businessContext?.rendered,
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
	When a visible plan is supplied, every branch must list the exact stable plan-step ids it
	supports in coversPlanStepIds. Use [] only when no visible plan exists. A plan step completes
	only after all branches mapped to it return reviewed findings backed by successful results.
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
  const invalidCoverage = planCoverageError(
    input.context.visiblePlan,
    plan.branches.map(({ coversPlanStepIds }) => coversPlanStepIds),
  );
  if (invalidCoverage) {
    if (process.env.ALBERT_V3_DEBUG_PLAN) console.error(`[deep-lane] ${invalidCoverage}`);
    return undefined;
  }

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
      businessContext: input.context.businessContext?.rendered,
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
    const branchInstructions = `You are one investigation branch of a deeper analysis. Investigate exactly
this question with governed typed queries and report findings; other branches cover the
other angles, so stay in your lane.

${branchKnowledge}

Run at most ${perBranchQueries} queries. Ground every finding in retrieved numbers and
quantify materiality in dollars where possible. If the data shows nothing noteworthy,
say so plainly; a null finding is a valid finding.`;
    // Branches gather evidence; they never present it. Charts are chosen once,
    // against the finished answer, by the visualiser (visualise-lane.ts).
    const branchTools = [...createV3Tools({
      route: branchRoute,
      lane: "deep",
      purpose: "investigation",
      chartable: false,
    })];
    const branchConversation = withV3PromptCacheBoundary(
      input.preferences.model,
      [
        system(`${renderRequestContext({
          config: input.config,
          question: branch.question,
          route: input.context.toolRoute,
        })}\n\n# Branch assignment\nBranch: ${branch.title}\nWhy it matters: ${branch.rationale}`),
        user(branch.question),
      ],
    );
    try {
      let findings: BranchFindings | undefined;
      if (isXaiModel(input.preferences.model)) {
        // Grok 4.6 fills a structured outputType on its first Responses turn
        // and never calls a tool, so the branch would "finish" with a headline
        // like "Need sales schema" and zero queries. Investigate without an
        // output schema first, then compose the findings from what actually ran.
        findings = await runGrokBranch({
          input,
          branchContext,
          branchTitle: branch.title,
          instructions: branchInstructions,
          tools: branchTools,
          conversation: branchConversation,
          effort: budget.reasoningEffort,
        });
      } else {
        const agent = new Agent<V3TurnContext, typeof branchFindingsSchema>({
          name: `Albert v3 branch: ${branch.title}`,
          instructions: branchInstructions,
          model: input.preferences.model,
          modelSettings: laneModelSettings(input.preferences, budget.reasoningEffort, {
            toolChoice: "required",
            promptCacheKey: v3PromptCacheKey({
              partition: input.context.promptCachePartition,
              profile: "deep-branch",
              route: branchRoute,
            }),
          }),
          tools: branchTools,
          outputType: branchFindingsSchema,
        });
        const run = await input.runner.run(agent, branchConversation, {
          context: branchContext,
          maxTurns: 16,
          signal: input.context.signal,
        });
        findings = run.finalOutput;
      }
      await input.context.emit({
        type: "progress",
        status: "complete",
        stage: "query",
        label: sanitizeTraceText(`${branch.title}: ${findings?.headline ?? "no conclusive finding"}`, 160),
      });
      // Each finished branch is a completed step: tell the owner what it found
      // in a sentence or three, so the wait is never silent. Commentary is
      // cosmetic — a failure here must never discard the branch's findings.
      const stepSummary = findings ? branchStepSummary(branch.title, findings) : "";
      if (stepSummary) {
        try {
          await emitDeepCommentary(input.context, "step", stepSummary);
        } catch (error) {
          if (process.env.ALBERT_V3_DEBUG_PLAN) console.error("[deep-lane] step summary failed", error);
        }
      }
      return {
        branch,
        findings,
        resultIds: branchQueries(branchContext, branch.title)
          .flatMap((query) => query.resultId ? [query.resultId] : []),
      };
    } catch (error) {
      await input.context.emit({
        type: "progress",
        status: "warning",
        stage: "query",
        label: sanitizeTraceText(`${branch.title} could not finish`, 160),
        detail: sanitizeTraceText(error instanceof Error ? error.message : "branch failed", 200),
      });
      return { branch, findings: undefined, resultIds: [] as string[] };
    }
  }));

  await applyPlannedEvidenceBindings(input.context, branchResults.map(({ branch, findings, resultIds }) => ({
    coversPlanStepIds: branch.coversPlanStepIds ?? [],
    ok: Boolean(findings) && resultIds.length > 0,
    resultIds,
  })), { emitCommentary: false });

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
  const answer = synthesis.finalOutput;
  if (answer) await runVisualiser({ lane: input, answer });
  return answer;
}
