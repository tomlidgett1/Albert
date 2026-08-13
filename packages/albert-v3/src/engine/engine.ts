import { createHash } from "node:crypto";
import { Agent, Runner, user } from "@openai/agents";
import { z } from "zod";
import {
  resolveAlbertModelTransport,
  describeChatFailure,
  isXaiModel,
  sanitizeAnswerText,
  sanitizeTraceText,
  type AgentRunPreferences,
  type AnswerState,
} from "../../../shared/src/index.js";
import type { ProviderRunUsage } from "../../../usage-metering/src/index.js";
import { CubeClient } from "../cube/client.js";
import { ShopifyQLClient } from "../shopifyql/client.js";
import { ShopifyAdminClient } from "../shopify-admin/client.js";
import { loadAgentConfig } from "../agent-config/loader.js";
import type { ConnectorDomainFreshness, EmitV3Trace, TenantSourceFinding, V3TurnContext } from "./context.js";
import {
  buildConversationInput,
  classifyIntent,
  type ConversationMessage,
} from "./orchestrator.js";
import {
  composeFromGatheredEvidence,
  normalizeOwnerFollowUps,
  finalAnswerSchema,
  laneModelSettings,
  runAnalyticalLane,
  runQuickLane,
  v3PromptCacheKey,
  withV3PromptCacheBoundary,
  type FinalAnswer,
  type LaneRunInput,
} from "./lanes.js";
import { runDeepLane } from "./deep-lane.js";
import { createV3CommentaryState } from "./commentary.js";
import { createComposeTableTool } from "./tools.js";
import { trackRunnerUsage } from "./usage-accounting.js";
import { createAlbertResponsesProvider } from "../../../agent/src/responses-provider.js";
import {
  buildTurnProvenance,
  emptyTurnProvenance,
  groundedAnswerState,
  laneRequiresQueryEvidence,
  ownerFacingAnswerText,
} from "./grounding.js";
import {
  looksLikeShopifyAdminQuestion,
  looksLikeShopifyQLQuestion,
  resolveV3ToolRoute,
} from "./connector-routing.js";

export const ALBERT_V3_RUNTIME = "albert-v3" as const;

export type AlbertV3TurnOptions = Readonly<{
  message: string;
  conversation: readonly ConversationMessage[];
  preferences: AgentRunPreferences;
  tenantId: string;
  actorId?: string;
  role?: "owner" | "manager" | "bookkeeper" | "internal_operator";
  /** Authenticated control-plane connector keys; never accepted from a client request. */
  activeConnectors?: readonly string[];
  /** Per connector+domain sync watermarks from control-plane readiness. */
  connectorFreshness?: readonly ConnectorDomainFreshness[];
  /** Durable source-topology facts for this tenant. */
  sourceFindings?: readonly TenantSourceFinding[];
  /** Persists a source finding the agent verified this turn. */
  recordSourceFinding?: (concept: string, finding: string) => Promise<void>;
  conversationId: string;
  turnId: string;
  cubeApiUrl: string;
  cubeApiSecret: string;
  shopifyQLServiceUrl?: string;
  shopifyQLSigningSecret?: string;
  shopifyAdminServiceUrl?: string;
  shopifyAdminSigningSecret?: string;
  openaiApiKey: string;
  openaiBaseUrl?: string;
  xaiApiKey?: string;
  xaiBaseUrl?: string;
  openaiTracingEnabled?: boolean;
  signal?: AbortSignal;
  emit: EmitV3Trace;
  onProviderUsage?: (
    usage: ProviderRunUsage,
    providerResponseId: string | null,
  ) => Promise<void>;
}>;

export type AlbertV3TurnResult = Readonly<{
  answerState: AnswerState;
  answerText: string;
  resultDigest: string;
  queriesExecuted: number;
}>;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hasMarkdownTable(text: string): boolean {
  const lines = text.split("\n");
  return lines.some((line, index) => {
    const next = lines[index + 1] ?? "";
    return line.includes("|")
      && /^\s*\|?\s*:?-{3,}/u.test(next)
      && next.includes("|");
  });
}

function stripMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const divider = lines[index + 1] ?? "";
    if (line.includes("|") && divider.includes("|") && /^\s*\|?\s*:?-{3,}/u.test(divider)) {
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) index += 1;
      index -= 1;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

export function looksLikeLiveShopifyQuestion(value: string): boolean {
  return /\bshopify\b/iu.test(value)
    || looksLikeShopifyQLQuestion(value)
    || looksLikeShopifyAdminQuestion(value);
}

async function repairMarkdownAnswerTable(input: Readonly<{
  runner: Runner;
  preferences: AgentRunPreferences;
  context: V3TurnContext;
  draft: FinalAnswer;
}>): Promise<FinalAnswer> {
  const sources = [...input.context.tableResults.values()]
    .filter((table) => table.presentation === "evidence")
    .slice(0, 12)
    .map((table) => ({
      resultId: table.resultId,
      caption: table.caption,
      columns: table.columns,
      rows: table.rows,
    }));
  if (sources.length === 0) {
    return { ...input.draft, answer: stripMarkdownTables(input.draft.answer) || "The requested table is unavailable." };
  }
  const repairAgent = new Agent<V3TurnContext, typeof finalAnswerSchema>({
    name: "Albert v3 structured table repair",
    instructions: `A draft answer incorrectly contains one or more Markdown pipe tables.
Recreate every such table by calling compose_table with exact source-cell references from
the governed results supplied below. Preserve its orientation, labels, order and unavailable
states. Use labelSource for any date-based pivot heading. Then return the same answer as
clean Markdown with no Markdown table and no new figures. Preserve the draft's headings,
short paragraphs, bullets and numbered-list hierarchy, as well as its state, follow-ups
and disclosed assumptions. Do not run new queries.`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({
        partition: input.context.promptCachePartition,
        profile: "structured-table-repair",
        route: input.context.toolRoute,
      }),
    }),
    tools: [createComposeTableTool()],
    outputType: finalAnswerSchema,
  });
  try {
    const run = await input.runner.run(repairAgent, withV3PromptCacheBoundary(
      input.preferences.model,
      [user(JSON.stringify({
        draft: input.draft,
        governedSourceResults: sources,
      }))],
    ), {
      context: input.context,
      maxTurns: 6,
      signal: input.context.signal,
    });
    const repaired = run.finalOutput;
    if (repaired) {
      return {
        ...repaired,
        answer: stripMarkdownTables(repaired.answer) || stripMarkdownTables(input.draft.answer),
      };
    }
  } catch {
    // The invariant is fail-closed: never render an unstructured table. The
    // governed source results remain visible and pinnable if repair fails.
  }
  return { ...input.draft, answer: stripMarkdownTables(input.draft.answer) || "The governed results are shown above." };
}

const evidenceReviewSchema = z.object({
  verdict: z.enum(["ship", "investigate"]),
  /** Concrete missing checks phrased as data questions; empty when shipping. */
  missing: z.array(z.string().min(8).max(200)).max(3),
});

/**
 * The generate→review gate: before an answer ships, a cheap reviewer asks
 * whether the gathered evidence would genuinely satisfy the owner's goal. A
 * literally-true but unexplanatory answer (an unexplained zero, an uncovered
 * facet, a claim reaching past a sync watermark) fails review and re-enters
 * the analytical lane once with a refilled budget. Best effort: any reviewer
 * failure ships the original answer.
 */
async function reviewEvidenceSufficiency(input: Readonly<{
  runner: Runner;
  preferences: AgentRunPreferences;
  context: V3TurnContext;
  intent: Readonly<{
    resolvedQuestion: string;
    ownerGoal: string | null;
    answerMustCover: readonly string[];
  }>;
  draft: FinalAnswer;
}>): Promise<z.infer<typeof evidenceReviewSchema> | undefined> {
  const evidence = input.context.executedQueries.map((query) => ({
    topic: query.topic,
    view: query.view,
    rowCount: query.rowCount,
    timeRange: query.timeRangeLabel,
  }));
  const critic = new Agent<unknown, typeof evidenceReviewSchema>({
    name: "Albert v3 evidence reviewer",
    instructions: `You review whether the evidence gathered this turn genuinely answers the
owner's question before the answer ships. You never write the answer; you only
judge sufficiency.

Fail the review (verdict=investigate) when:
- A zero, empty or missing figure is reported without evidence explaining it
  (where the data actually falls, what the planned/counterpart figures show, or
  a data-freshness limit). An unexplained zero is not an answer.
- The question or the useful-answer points have a facet no query addressed. A
  question about actuals usually needs the matching plan or schedule for the
  same period when actuals come back empty; a question about a period needs
  anything already outstanding from earlier periods when money is involved.
- A claim depends on a window that reaches past the connector's synced-through
  watermark without saying so.
Otherwise return verdict=ship. When investigating, name at most 3 concrete
missing checks phrased as plain data questions (no tool or schema jargon).
Never fail a review for style, formatting or depth beyond the question.`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({
        partition: input.context.promptCachePartition,
        profile: "evidence-reviewer",
        route: input.context.toolRoute,
      }),
    }),
    outputType: evidenceReviewSchema,
  });
  try {
    const run = await input.runner.run(critic, withV3PromptCacheBoundary(
      input.preferences.model,
      [user(JSON.stringify({
        resolvedQuestion: input.intent.resolvedQuestion,
        ownerGoal: input.intent.ownerGoal,
        answerMustCover: input.intent.answerMustCover,
        evidence,
        connectorFreshness: input.context.connectorFreshness,
        draftAnswer: input.draft.answer,
        draftState: input.draft.state,
      }))],
    ), {
      maxTurns: 2,
      signal: input.context.signal,
    });
    return run.finalOutput;
  } catch {
    return undefined;
  }
}

/**
 * Runs one Albert v3 turn: intent orchestration, lane execution over the Cube
 * semantic layer, and a terminal answer/clarification event. All trace output
 * flows through `options.emit`; the caller owns transport and persistence.
 */
export async function runAlbertV3Turn(options: AlbertV3TurnOptions): Promise<AlbertV3TurnResult> {
  const config = loadAgentConfig();
  const emit = options.emit;

  await emit({
    type: "progress",
    status: "running",
    stage: "planning",
    label: "Reading the question",
    detail: "Albert v3 · Cube semantic layer",
    progress: 0.05,
  });

  const cube = new CubeClient({
    apiUrl: options.cubeApiUrl,
    apiSecret: options.cubeApiSecret,
    securityContext: {
      tenant_id: options.tenantId,
      conversation_id: options.conversationId,
      turn_id: options.turnId,
    },
  });
  // Live Shopify reports contain Level-2 protected customer data. Until a
  // field-level entitlement policy exists, no signed client is installed for
  // bookkeepers/internal operators. The worker independently rechecks the
  // active owner/manager membership on every catalogue/query invocation.
  const shopifyQL = (options.role === "owner" || options.role === "manager")
      && options.actorId && options.shopifyQLServiceUrl && options.shopifyQLSigningSecret
    ? new ShopifyQLClient(
        options.shopifyQLServiceUrl,
        options.shopifyQLSigningSecret,
        {
          tenantId: options.tenantId,
          actorId: options.actorId,
          role: options.role,
          conversationId: options.conversationId,
          turnId: options.turnId,
        },
      )
    : undefined;
  const shopifyAdmin = (options.role === "owner" || options.role === "manager")
      && options.actorId && options.shopifyAdminServiceUrl && options.shopifyAdminSigningSecret
    ? new ShopifyAdminClient(
        options.shopifyAdminServiceUrl,
        options.shopifyAdminSigningSecret,
        {
          tenantId: options.tenantId,
          actorId: options.actorId,
          role: options.role,
          conversationId: options.conversationId,
          turnId: options.turnId,
        },
      )
    : undefined;

  const provider = createAlbertResponsesProvider(resolveAlbertModelTransport({
    model: options.preferences.model,
    openaiApiKey: options.openaiApiKey,
    openaiBaseUrl: options.openaiBaseUrl,
    xaiApiKey: options.xaiApiKey,
    xaiBaseUrl: options.xaiBaseUrl,
  }));
  const accounting = trackRunnerUsage(new Runner({
    modelProvider: provider,
    tracingDisabled: !options.openaiTracingEnabled,
    traceIncludeSensitiveData: false,
    workflowName: "albert-v3-engine",
    groupId: options.conversationId,
  }));
  const runner = accounting.runner;
  const promptCachePartition = digest(options.tenantId).slice(0, 12);

  try {
  // The catalogue fetch and the intent classification are independent.
  const [catalogueResult, intent] = await Promise.all([
    cube.fetchCatalogue(options.signal).then(
      (catalogue) => ({ ok: true as const, catalogue }),
      (error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : "Cubecore is down. The Cube API could not be reached.",
      }),
    ),
    classifyIntent({
      runner,
      preferences: options.preferences,
      config,
      cachePartition: promptCachePartition,
      conversation: options.conversation,
      message: options.message,
      sourceFindings: options.sourceFindings ?? [],
      signal: options.signal,
    }),
  ]);

  if (intent.lane === "off_topic") {
    const text = sanitizeAnswerText(
      "I can only answer questions about the business data connected to Albert: "
      + "sales, products and customers, accounting (invoices, bills, profit, GST, bank activity), "
      + "payroll and staffing. Ask me anything in that territory.",
    );
    await emit({
      type: "answer",
      status: "complete",
      state: "Unavailable",
      text,
      provenance: emptyTurnProvenance(config.timezone),
      followUps: [
        "How did sales go this month compared to last month?",
        "Which categories make the most gross profit?",
        "Who are my top customers this year?",
      ],
      presentedResultIds: [],
      claims: [],
    });
    return {
      answerState: "Unavailable",
      answerText: text,
      resultDigest: digest(text),
      queriesExecuted: 0,
    };
  }

  if (intent.lane === "clarification") {
    const question = sanitizeTraceText(
      intent.clarificationQuestion ?? "Could you clarify what you would like me to analyse?",
      240,
    );
    await emit({
      type: "clarification",
      status: "complete",
      question,
      options: intent.clarificationOptions.slice(0, 4).map((label, index) => ({
        id: `option_${index + 1}`,
        label: sanitizeTraceText(label, 80),
      })),
    });
    return {
      answerState: "Clarification",
      answerText: question,
      resultDigest: digest(question),
      queriesExecuted: 0,
    };
  }

  const toolRoute = resolveV3ToolRoute({
    question: options.message,
    resolvedQuestion: intent.resolvedQuestion,
    lane: intent.lane,
    conversation: options.conversation,
    config,
    activeConnectors: options.activeConnectors,
    cubeAvailable: catalogueResult.ok,
    shopifyQLAvailable: Boolean(shopifyQL),
    shopifyAdminAvailable: Boolean(shopifyAdmin),
  });

  if (!catalogueResult.ok && !(toolRoute.shopifyQL || toolRoute.shopifyAdmin)) {
    const text = sanitizeAnswerText(
      describeChatFailure(new Error(catalogueResult.error), { runtime: "v3" }),
    );
    await emit({
      type: "answer",
      status: "warning",
      state: "Unavailable",
      text,
      provenance: emptyTurnProvenance(config.timezone),
      followUps: ["Try the question again"],
      presentedResultIds: [],
      claims: [],
    });
    return {
      answerState: "Unavailable",
      answerText: text,
      resultDigest: digest(text),
      queriesExecuted: 0,
    };
  }

  const lane = intent.lane;
  const catalogue = catalogueResult.ok
    ? catalogueResult.catalogue
    : { views: [], fetchedAt: new Date().toISOString() };
  const budget = config.lanes[
    lane === "quick" || lane === "explain" ? "quick" : lane === "deep" ? "deep" : "analytical"
  ];
  const context: V3TurnContext = {
    cube,
    ...(shopifyQL ? { shopifyQL } : {}),
    ...(shopifyAdmin ? { shopifyAdmin } : {}),
    config,
    promptCachePartition,
    toolRoute,
    emit,
    signal: options.signal,
    budget: { maxQueries: budget.maxQueries, executed: 0 },
    connectorFreshness: options.connectorFreshness ?? [],
    sourceFindings: options.sourceFindings ?? [],
    ...(options.recordSourceFinding ? { recordSourceFinding: options.recordSourceFinding } : {}),
    commentary: createV3CommentaryState(lane === "analytical" || lane === "deep"),
    executedQueries: [],
    tableResults: new Map(),
    chartedResultIds: new Set(),
  };

  await emit({
    type: "progress",
    status: "complete",
    stage: "planning",
    label: lane === "quick"
      ? "Quick lookup"
      : lane === "explain"
        ? "Explaining the previous answer"
        : lane === "deep"
          ? "Deep investigation"
          : "Analytical investigation",
    detail: sanitizeTraceText(intent.resolvedQuestion, 300),
    progress: 0.12,
  });

  const laneInput: LaneRunInput = {
    runner,
    preferences: options.preferences,
    config,
    catalogue,
    context,
    conversation: buildConversationInput(options.conversation, options.message),
    intent,
  };

  let finalAnswer: FinalAnswer | undefined;
  if (lane === "quick" || lane === "explain") {
    finalAnswer = await runQuickLane(laneInput);
    // A quick question that turned out to need more work falls through to the
    // analytical lane rather than returning a half answer. That covers three
    // shapes: no terminal answer at all, an answer produced without any query,
    // and an explicit state=Escalate (the quick lane found evidence it could
    // not reconcile within its budget). Grok already retried the investigation
    // pass when it skipped tools, so do not pay for a third xAI round on the
    // same empty evidence.
    const grokAlreadyRetriedInvestigation = isXaiModel(options.preferences.model) && lane !== "explain";
    const ranNoQueries = lane === "quick"
      && context.executedQueries.length === 0
      && !grokAlreadyRetriedInvestigation;
    const askedToEscalate = lane === "quick" && finalAnswer?.state === "Escalate";
    if (!finalAnswer || ranNoQueries || askedToEscalate) {
      // A surprise refills the budget: escalation must never stop one query
      // short of the answer because the first pass spent its allowance.
      context.budget.maxQueries = Math.max(
        context.budget.maxQueries,
        context.budget.executed + config.lanes.analytical.maxQueries,
      );
      await emit({
        type: "progress",
        status: "running",
        stage: "query",
        label: askedToEscalate ? "Digging deeper" : "Looking up the figures",
        detail: askedToEscalate
          ? "The first pass found evidence it could not reconcile."
          : "The first pass did not run a data query.",
        progress: 0.2,
      });
      finalAnswer = await runAnalyticalLane(laneInput);
    }
  } else if (lane === "deep") {
    finalAnswer = await runDeepLane(laneInput);
    if (!finalAnswer) finalAnswer = await runAnalyticalLane(laneInput);
  } else {
    finalAnswer = await runAnalyticalLane(laneInput);
  }

  if (!finalAnswer && context.executedQueries.length > 0) {
    // Every lane pass ran out of turns or budget with evidence in hand:
    // compose from what was gathered rather than failing the turn.
    finalAnswer = await composeFromGatheredEvidence(laneInput);
  }
  if (!finalAnswer) {
    throw new Error("The Albert v3 engine did not produce a terminal answer.");
  }

  // Generate → review → revise: a cheap sufficiency review gates the answer.
  // One revision pass at most; explain rests on prior turns and deep already
  // synthesises across branches, so only the data lanes are gated.
  if (
    (lane === "quick" || lane === "analytical")
    && finalAnswer.state !== "Escalate"
    && finalAnswer.state !== "Unavailable"
    && context.executedQueries.length > 0
  ) {
    const review = await reviewEvidenceSufficiency({
      runner,
      preferences: options.preferences,
      context,
      intent: {
        resolvedQuestion: intent.resolvedQuestion,
        ownerGoal: intent.ownerGoal,
        answerMustCover: intent.answerMustCover,
      },
      draft: finalAnswer,
    });
    if (review?.verdict === "investigate" && review.missing.length > 0) {
      // Targeted top-up, not a fresh investigation: the reviewer named the
      // gaps, so the revision runs only those checks and updates the draft.
      // The 75-question battery showed full re-investigation here doubled
      // latency and caused timeouts.
      context.budget.maxQueries = Math.max(
        context.budget.maxQueries,
        context.budget.executed + Math.min(4, config.lanes.analytical.maxQueries),
      );
      await emit({
        type: "progress",
        status: "running",
        stage: "query",
        label: "Reviewed the evidence — digging further",
        detail: sanitizeTraceText(review.missing.join(" · "), 300),
        progress: 0.7,
      });
      const revised = await runAnalyticalLane({
        ...laneInput,
        conversation: [
          ...laneInput.conversation,
          user(
            "An internal reviewer judged the draft below insufficient on specific points. "
            + `Run ONLY the queries needed to close these gaps (do not repeat work already done): ${review.missing.join("; ")}. `
            + `Then return the corrected full answer, keeping everything from the draft that remains true.\n\nDraft:\n${finalAnswer.answer}`,
          ),
        ],
      });
      if (revised && revised.state !== "Escalate") finalAnswer = revised;
    }
  }

  if (hasMarkdownTable(finalAnswer.answer)) {
    finalAnswer = await repairMarkdownAnswerTable({
      runner,
      preferences: options.preferences,
      context,
      draft: finalAnswer,
    });
  }

  const rowsSeen = context.executedQueries.reduce((total, query) => total + query.rowCount, 0);
  // Escalate is an engine-internal handoff, not a terminal state. If a lane
  // with no deeper pass left still returns it, ship the evidence gathered as
  // exploratory rather than a dead end.
  const state = groundedAnswerState({
    lane,
    requested: finalAnswer.state === "Escalate" ? "Exploratory" : finalAnswer.state,
    queriesExecuted: context.executedQueries.length,
    rowsSeen,
    freshnessQualified: context.freshnessQualified,
  });
  const text = sanitizeAnswerText(ownerFacingAnswerText({
    lane,
    draft: finalAnswer.answer,
    queriesExecuted: context.executedQueries.length,
  }), 8_000);

  const tableResults = [...context.tableResults.values()];
  const answerTableResultIds = tableResults
    .filter((table) => table.presentation === "answer")
    .map((table) => table.resultId)
    .slice(-3);
  const presentedResultIds = answerTableResultIds.length > 0
    ? answerTableResultIds
    : tableResults.filter((table) => table.presentation === "evidence")
      .map((table) => table.resultId)
      .slice(-3);
  const followUps = laneRequiresQueryEvidence(lane) && context.executedQueries.length === 0
    ? ["Try the question again"]
    : normalizeOwnerFollowUps(finalAnswer.followUps)
      .map((followUp) => sanitizeTraceText(followUp, 160))
      .filter(Boolean);
  await emit({
    type: "answer",
    status: "complete",
    state,
    text,
    provenance: buildTurnProvenance(context),
    followUps,
    resolvedSubject: {
      label: sanitizeTraceText(intent.resolvedQuestion, 160),
      kind: lane,
      resolvedQuestion: sanitizeTraceText(intent.resolvedQuestion, 2_000),
    },
    presentedResultIds,
    claims: [],
  });

  return {
    answerState: state,
    answerText: text,
    resultDigest: digest(text),
    queriesExecuted: context.executedQueries.length,
  };
  } finally {
    const usage = accounting.snapshot();
    if (usage.requests > 0 && options.onProviderUsage) {
      await options.onProviderUsage(usage, accounting.lastResponseId());
    }
  }
}
