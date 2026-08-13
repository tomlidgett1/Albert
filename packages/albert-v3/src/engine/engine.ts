import { createHash } from "node:crypto";
import { Agent, Runner, user } from "@openai/agents";
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
import type { EmitV3Trace, V3TurnContext } from "./context.js";
import {
  buildConversationInput,
  classifyIntent,
  type ConversationMessage,
} from "./orchestrator.js";
import {
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
    // analytical lane rather than returning a half answer. Grok already retried
    // the investigation pass when it skipped tools, so do not pay for a third
    // xAI round on the same empty evidence.
    const grokAlreadyRetriedInvestigation = isXaiModel(options.preferences.model) && lane !== "explain";
    if (!finalAnswer) {
      finalAnswer = await runAnalyticalLane(laneInput);
    } else if (
      lane === "quick"
      && context.executedQueries.length === 0
      && !grokAlreadyRetriedInvestigation
    ) {
      context.budget.maxQueries = Math.max(
        context.budget.maxQueries,
        config.lanes.analytical.maxQueries,
      );
      await emit({
        type: "progress",
        status: "running",
        stage: "query",
        label: "Looking up the figures",
        detail: "The first pass did not run a data query.",
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

  if (!finalAnswer) {
    throw new Error("The Albert v3 engine did not produce a terminal answer.");
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
  const state = groundedAnswerState({
    lane,
    requested: finalAnswer.state,
    queriesExecuted: context.executedQueries.length,
    rowsSeen,
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
