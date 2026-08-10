import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  query,
  type SDKResultMessage,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import type { TraceAnswerEvent, TraceEvent, TraceProvenance } from "../../shared/src/index.js";
import { sanitizeAnswerText, sanitizeTraceText } from "../../shared/src/index.js";
import type { LightspeedCatalogue } from "./catalogue.js";
import {
  ANTHROPIC_FALLBACK_MODEL,
  ANTHROPIC_PRIMARY_MODEL,
  ANTHROPIC_SDK_VERSION,
  FINAL_ANSWER_JSON_SCHEMA,
  REVIEW_JSON_SCHEMA,
  reviewOutputSchema,
  type AnthropicInternalTurn,
  type AnthropicMetering,
  type FinalAnswer,
  type InternalCompletion,
} from "./contracts.js";
import { groundEvidenceFallback, groundFinalAnswer } from "./grounding.js";
import { ANTHROPIC_ANALYTICS_SYSTEM_PROMPT, buildTurnPrompt } from "./prompt.js";
import { AnthropicSemanticClient } from "./semantic-client.js";
import { ANTHROPIC_ALLOWED_TOOLS, createAnthropicAnalyticsMcp, type AnthropicToolLedger } from "./tools.js";

export type AnthropicRunConfiguration = Readonly<{
  semanticServiceUrl: string;
  semanticSigningSecret: string;
  providerEnvironment: Readonly<Record<string, string | undefined>>;
  catalogue: LightspeedCatalogue;
  sessionStore: SessionStore;
  sessionId: string;
  resumeSession?: boolean;
  model?: string;
  fallbackModel?: string;
  pathToClaudeCodeExecutable?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type AnthropicRunResult = Readonly<{
  events: readonly TraceEvent[];
  completion: InternalCompletion;
}>;

type TraceEventInput = TraceEvent extends infer Event
  ? Event extends TraceEvent
    ? Omit<Event, "id" | "sequence" | "occurredAt">
    : never
  : never;

function defaultProvenance(): TraceProvenance {
  return Object.freeze({
    sources: Object.freeze([]),
    timeRange: Object.freeze({ label: "Requested period", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" }),
    definitions: Object.freeze([]),
    semanticBundleHash: "unavailable",
    identityGraph: Object.freeze({ version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" }),
  });
}

function aggregateProvenance(ledger: AnthropicToolLedger): TraceProvenance {
  const result = ledger.results.at(-1);
  if (!result) return defaultProvenance();
  const raw = result.response.provenance;
  return Object.freeze({
    sources: Object.freeze(raw.sources.slice(0, 12).map((source) => ({
      connector: /xero/iu.test(source) ? "xero" as const : /deputy/iu.test(source) ? "deputy" as const : "lightspeed" as const,
      label: source,
      dataThrough: raw.sourceWatermarks[source] ?? "unknown",
    }))),
    timeRange: Object.freeze({
      label: typeof raw.timeRange?.label === "string" ? raw.timeRange.label : "Requested period",
      start: typeof raw.timeRange?.start === "string" ? raw.timeRange.start : "unknown",
      end: typeof raw.timeRange?.end === "string" ? raw.timeRange.end : "unknown",
      timezone: typeof raw.timeRange?.timezone === "string" ? raw.timeRange.timezone : "Australia/Melbourne",
    }),
    definitions: Object.freeze(raw.definitionsApplied.slice(0, 20).map((metric) => ({ metric, label: metric, definition: metric }))),
    semanticBundleHash: raw.bundleHash.replace(/^sha256:/u, ""),
    identityGraph: Object.freeze({ version: raw.identityGraph.version, hash: raw.identityGraph.hash }),
  });
}

function terminalTrace(answer: FinalAnswer, ledger: AnthropicToolLedger): TraceEventInput {
  if (answer.outcome === "clarification" && answer.clarification) {
    return {
      type: "clarification",
      status: "warning",
      question: sanitizeTraceText(answer.clarification.question, 300),
      options: answer.clarification.options.map((option) => ({ id: option.id, label: sanitizeTraceText(option.label, 120) })),
    };
  }
  const event: Omit<TraceAnswerEvent, "id" | "sequence" | "occurredAt"> = {
    type: "answer",
    status: answer.outcome === "unavailable" ? "warning" : "complete",
    state: answer.outcome.charAt(0).toUpperCase() + answer.outcome.slice(1) as TraceAnswerEvent["state"],
    text: sanitizeAnswerText(answer.text, 4_000),
    provenance: aggregateProvenance(ledger),
    followUps: answer.followUps.map((value) => sanitizeTraceText(value, 200)),
    presentedResultIds: answer.resultIds,
    claims: answer.claims,
  };
  return event;
}

function unavailableAnswer(reason: string): FinalAnswer {
  const safe = sanitizeTraceText(reason, 500) || "The Anthropic analytics runtime could not complete this request.";
  return Object.freeze({
    outcome: "unavailable",
    text: `I couldn't produce a grounded result for this request. ${safe}`,
    resultIds: [],
    claims: [],
    followUps: ["Try a narrower question or a shorter reporting period."],
    unavailableReason: safe,
  });
}

function usageFromResult(result: SDKResultMessage | undefined): Readonly<{ providerUsage: Record<string, unknown>; metering: AnthropicMetering }> {
  if (!result) {
    return {
      providerUsage: { sdkVersion: ANTHROPIC_SDK_VERSION, models: {}, totalCostUsd: 0, turns: 0 },
      metering: {
        rateCardId: "anthropic-claude-5-2026-07-24",
        model: ANTHROPIC_PRIMARY_MODEL,
        fastMode: false,
        requests: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        estimatedCostUsdMicros: 0,
        pricingCompleteness: "request_level",
      },
    };
  }
  const models = Object.entries(result.modelUsage);
  const inputTokens = models.reduce((sum, [, usage]) => sum + usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens, 0);
  const cachedInputTokens = models.reduce((sum, [, usage]) => sum + usage.cacheReadInputTokens, 0);
  const cacheWriteInputTokens = models.reduce((sum, [, usage]) => sum + usage.cacheCreationInputTokens, 0);
  const outputTokens = models.reduce((sum, [, usage]) => sum + usage.outputTokens, 0);
  const cost = models.reduce((sum, [, usage]) => sum + usage.costUSD, 0);
  return {
    providerUsage: {
      sdkVersion: ANTHROPIC_SDK_VERSION,
      models: result.modelUsage,
      totalCostUsd: result.total_cost_usd,
      turns: result.num_turns,
      terminalReason: result.terminal_reason ?? null,
      stopReason: result.stop_reason,
    },
    metering: {
      rateCardId: "anthropic-claude-5-2026-07-24",
      // Ledger attribution records the requested primary; providerUsage keeps
      // exact per-model totals when the infrastructure fallback was used.
      model: ANTHROPIC_PRIMARY_MODEL,
      fastMode: false,
      requests: result.num_turns,
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      estimatedCostUsdMicros: Math.max(0, Math.ceil(cost * 1_000_000)),
      pricingCompleteness: "request_level",
    },
  };
}

function combineUsage(results: readonly SDKResultMessage[]): Readonly<{ providerUsage: Record<string, unknown>; metering: AnthropicMetering }> {
  if (results.length === 0) return usageFromResult(undefined);
  const models: Record<string, { inputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; outputTokens: number; costUSD: number }> = {};
  let requests = 0;
  let totalCostUsd = 0;
  for (const result of results) {
    requests += result.num_turns;
    totalCostUsd += result.total_cost_usd;
    for (const [model, usage] of Object.entries(result.modelUsage)) {
      const current = models[model] ?? { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, costUSD: 0 };
      models[model] = {
        inputTokens: current.inputTokens + usage.inputTokens,
        cacheReadInputTokens: current.cacheReadInputTokens + usage.cacheReadInputTokens,
        cacheCreationInputTokens: current.cacheCreationInputTokens + usage.cacheCreationInputTokens,
        outputTokens: current.outputTokens + usage.outputTokens,
        costUSD: current.costUSD + usage.costUSD,
      };
    }
  }
  const totals = Object.values(models).reduce((accumulator, usage) => ({
    inputTokens: accumulator.inputTokens + usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
    cachedInputTokens: accumulator.cachedInputTokens + usage.cacheReadInputTokens,
    cacheWriteInputTokens: accumulator.cacheWriteInputTokens + usage.cacheCreationInputTokens,
    outputTokens: accumulator.outputTokens + usage.outputTokens,
  }), { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 });
  return {
    providerUsage: {
      sdkVersion: ANTHROPIC_SDK_VERSION,
      models,
      totalCostUsd,
      turns: requests,
      runs: results.map((item) => ({ id: item.uuid, subtype: item.subtype, terminalReason: item.terminal_reason ?? null, stopReason: item.stop_reason })),
    },
    metering: {
      rateCardId: "anthropic-claude-5-2026-07-24",
      model: ANTHROPIC_PRIMARY_MODEL,
      fastMode: false,
      requests,
      ...totals,
      estimatedCostUsdMicros: Math.max(0, Math.ceil(totalCostUsd * 1_000_000)),
      pricingCompleteness: "request_level",
    },
  };
}

function needsRestrictedReview(answer: FinalAnswer, ledger: AnthropicToolLedger): boolean {
  const cited = ledger.results.filter((item) => answer.resultIds.includes(item.resultId));
  return ["verified", "qualified", "exploratory"].includes(answer.outcome)
    && (cited.length > 1 || cited.some((item) => item.route === "source_exploration"));
}

function reviewerEvidence(answer: FinalAnswer, ledger: AnthropicToolLedger) {
  const references = new Map<string, Set<string>>();
  for (const claim of answer.claims) {
    for (const ref of claim.refs) {
      const key = `${ref.rowIndex}:${ref.columnKey}`;
      const cells = references.get(ref.resultId) ?? new Set<string>();
      cells.add(key);
      references.set(ref.resultId, cells);
    }
  }
  return ledger.results.map((result) => ({
    resultId: result.resultId,
    state: result.state,
    route: result.route,
    rowCount: result.rows.length,
    columns: result.columns,
    validation: {
      status: result.response.validation.status,
      warnings: result.response.validation.warnings,
    },
    citedCells: [...(references.get(result.resultId) ?? [])].map((key) => {
      const [rowIndexText, columnKey] = key.split(":", 2);
      const rowIndex = Number(rowIndexText);
      return { rowIndex, columnKey, value: result.rows[rowIndex]?.[columnKey] };
    }),
  }));
}

async function runRestrictedReviewer(input: Readonly<{
  answer: FinalAnswer;
  ledger: AnthropicToolLedger;
  providerEnvironment: Readonly<Record<string, string | undefined>>;
  cwd: string;
  model: string;
  pathToClaudeCodeExecutable?: string;
  maxBudgetUsd: number;
  signal: AbortSignal;
}>): Promise<Readonly<{ output?: ReturnType<typeof reviewOutputSchema.parse>; result?: SDKResultMessage }>> {
  if (input.maxBudgetUsd <= 0) return {};
  await mkdir(input.cwd, { recursive: true, mode: 0o700 });
  const reviewer = query({
    prompt: JSON.stringify({ candidate: input.answer, evidence: reviewerEvidence(input.answer, input.ledger) }),
    options: {
      systemPrompt: "You are Albert's restricted evidence reviewer. You cannot query data. Check only the supplied candidate and result summary for arithmetic, grain, join fan-out, staging-evidence qualification, and exact cell support. Approve when sound. Otherwise return a corrected revisedAnswer using only supplied evidence; never add a number or result ID.",
      model: input.model,
      thinking: { type: "adaptive" },
      effort: "max",
      maxTurns: 2,
      maxBudgetUsd: input.maxBudgetUsd,
      outputFormat: { type: "json_schema", schema: REVIEW_JSON_SCHEMA },
      tools: [],
      allowedTools: [],
      disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent"],
      strictMcpConfig: true,
      permissionMode: "dontAsk",
      settingSources: [],
      skills: [],
      plugins: [],
      persistSession: false,
      ...(input.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable }
        : {}),
      cwd: input.cwd,
      env: {
        ...input.providerEnvironment,
        CLAUDE_CONFIG_DIR: input.cwd,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_AGENT_SDK_CLIENT_APP: `albert-anthropic-reviewer/${ANTHROPIC_SDK_VERSION}`,
      },
    },
  });
  const abort = () => reviewer.close();
  input.signal.addEventListener("abort", abort, { once: true });
  let result: SDKResultMessage | undefined;
  try {
    for await (const message of reviewer) if (message.type === "result") result = message;
  } finally {
    input.signal.removeEventListener("abort", abort);
    reviewer.close();
  }
  if (!result || result.subtype !== "success") return { result };
  return { output: reviewOutputSchema.parse(result.structured_output), result };
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function runAnthropicAnalyticsTurn(
  turn: AnthropicInternalTurn,
  configuration: AnthropicRunConfiguration,
  onEvent?: (event: TraceEvent) => void,
): Promise<AnthropicRunResult> {
  const startedAt = Date.now();
  const events: TraceEvent[] = [];
  const emit = (raw: TraceEventInput): TraceEvent => {
    const sequence = events.length + 1;
    const event = { ...raw, id: `anthropic_${turn.turnId}_${sequence}`, sequence, occurredAt: new Date().toISOString() } as TraceEvent;
    events.push(event);
    onEvent?.(event);
    return event;
  };
  const ledger: AnthropicToolLedger = {
    results: [], checkpoints: [], queryAuditIds: [], mirrorErrors: [],
    sqlAttempts: 0, sqlSuccesses: 0, sqlFailures: 0,
  };
  emit({ type: "progress", status: "running", label: "Planning the analysis", detail: "Resolving governed definitions and Lightspeed grain", stage: "planning", progress: 0.05 });

  const temporaryDirectory = join(tmpdir(), "albert-anthropic-sessions", configuration.sessionId);
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const semanticClient = new AnthropicSemanticClient(configuration.semanticServiceUrl, configuration.semanticSigningSecret);
  const timeoutSignal = AbortSignal.timeout(configuration.timeoutMs ?? 180_000);
  const runSignal = configuration.signal
    ? AbortSignal.any([configuration.signal, timeoutSignal])
    : timeoutSignal;
  const toolContext = { ...turn, signal: runSignal };
  const mcp = createAnthropicAnalyticsMcp({ catalogue: configuration.catalogue, semanticClient, context: toolContext, ledger, emit });
  let result: SDKResultMessage | undefined;
  let reviewerResult: SDKResultMessage | undefined;
  let answer: FinalAnswer;
  let groundingRejections = 0;
  try {
    const agent = query({
      prompt: buildTurnPrompt(turn),
      options: {
        systemPrompt: ANTHROPIC_ANALYTICS_SYSTEM_PROMPT,
        model: configuration.model ?? ANTHROPIC_PRIMARY_MODEL,
        fallbackModel: configuration.fallbackModel ?? ANTHROPIC_FALLBACK_MODEL,
        thinking: { type: "adaptive" },
        effort: "max",
        maxTurns: configuration.maxTurns ?? 20,
        maxBudgetUsd: configuration.maxBudgetUsd ?? 3,
        outputFormat: { type: "json_schema", schema: FINAL_ANSWER_JSON_SCHEMA },
        tools: [],
        allowedTools: [...ANTHROPIC_ALLOWED_TOOLS],
        disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent"],
        mcpServers: { albert_analytics: mcp },
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        settingSources: [],
        skills: [],
        plugins: [],
        includePartialMessages: true,
        persistSession: true,
        ...(configuration.pathToClaudeCodeExecutable
          ? { pathToClaudeCodeExecutable: configuration.pathToClaudeCodeExecutable }
          : {}),
        sessionStore: configuration.sessionStore,
        sessionStoreFlush: "batched",
        loadTimeoutMs: 15_000,
        ...(configuration.resumeSession
          ? { resume: configuration.sessionId }
          : { sessionId: configuration.sessionId }),
        cwd: temporaryDirectory,
        env: {
          ...configuration.providerEnvironment,
          CLAUDE_CONFIG_DIR: temporaryDirectory,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_AGENT_SDK_CLIENT_APP: `albert-anthropic-analytics/${ANTHROPIC_SDK_VERSION}`,
          CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
        },
      },
    });
    const abort = () => agent.close();
    toolContext.signal.addEventListener("abort", abort, { once: true });
    try {
      for await (const message of agent) {
        if (message.type === "system" && message.subtype === "mirror_error") {
          ledger.mirrorErrors.push(message.error.slice(0, 500));
        }
        if (message.type === "result") result = message;
      }
    } finally {
      toolContext.signal.removeEventListener("abort", abort);
      agent.close();
    }
    if (!result || result.subtype !== "success") {
      const reason = result && "errors" in result ? result.errors.join(" ") : "The provider did not return a successful structured result.";
      answer = groundEvidenceFallback(ledger.results, { question: turn.message, now: new Date(startedAt) }) ?? unavailableAnswer(reason);
    } else {
      try {
        answer = groundFinalAnswer(result.structured_output, ledger.results);
      } catch (error) {
        groundingRejections += 1;
        throw error;
      }
    }
  } catch (error) {
    answer = groundEvidenceFallback(ledger.results, { question: turn.message, now: new Date(startedAt) })
      ?? unavailableAnswer(error instanceof Error ? error.message : "The Anthropic runtime failed safely.");
  }

  const reviewRequired = needsRestrictedReview(answer, ledger);
  if (reviewRequired) {
    emit({ type: "progress", status: "running", label: "Reviewing composite evidence", detail: "A restricted Opus reviewer is checking result-set consistency without data tools.", stage: "planning" });
    try {
      const spent = result?.total_cost_usd ?? 0;
      const remainingBudget = Math.max(0, (configuration.maxBudgetUsd ?? 3) - spent);
      const review = await runRestrictedReviewer({
        answer,
        ledger,
        providerEnvironment: configuration.providerEnvironment,
        cwd: join(temporaryDirectory, "reviewer"),
        model: configuration.model ?? ANTHROPIC_PRIMARY_MODEL,
        pathToClaudeCodeExecutable: configuration.pathToClaudeCodeExecutable,
        maxBudgetUsd: remainingBudget,
        signal: runSignal,
      });
      reviewerResult = review.result;
      if (!review.output) {
        answer = unavailableAnswer("The required restricted review could not complete within the turn budget.");
      } else if (!review.output.approved) {
        if (review.output.revisedAnswer) {
          try {
            answer = groundFinalAnswer(review.output.revisedAnswer, ledger.results);
          } catch (error) {
            groundingRejections += 1;
            throw error;
          }
        } else {
          answer = unavailableAnswer(`The restricted review rejected the candidate: ${review.output.issues.join(" ")}`);
        }
      }
      emit({
        type: "validation",
        status: answer.outcome === "unavailable" ? "warning" : "complete",
        name: "Restricted Opus evidence review",
        outcome: answer.outcome === "unavailable" ? "failed" : "passed",
        detail: review.output?.approved ? "Composite evidence passed independent review." : (review.output?.issues.join(" ").slice(0, 500) || "Review was unavailable."),
      });
    } catch (error) {
      answer = unavailableAnswer(`The required restricted review failed safely: ${error instanceof Error ? error.message : "unknown reviewer failure"}`);
    }
  }
  await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);

  const providerFallback = Boolean(result && Object.keys(result.modelUsage).some((model) => /sonnet/iu.test(model)));
  if (providerFallback) {
    emit({ type: "validation", status: "warning", name: "Provider fallback", outcome: "qualified", detail: `The primary model was unavailable; ${ANTHROPIC_FALLBACK_MODEL} completed the infrastructure fallback. This substitution is recorded in usage evidence.` });
  }

  if (ledger.mirrorErrors.length > 0) {
    emit({ type: "validation", status: "warning", name: "Session durability", outcome: "qualified", detail: "The analysis completed, but its Agent SDK session mirror reported a persistence error." });
  }
  const terminal = emit(terminalTrace(answer, ledger));
  const usage = combineUsage([result, reviewerResult].filter((item): item is SDKResultMessage => Boolean(item)));
  const providerResponseId = result?.uuid ?? `anthropic-runtime-${turn.turnId}`;
  const completion: InternalCompletion = Object.freeze({
    providerResponseId,
    providerUsage: usage.providerUsage,
    metering: usage.metering,
    answerState: answer.outcome,
    turnResultDigest: await digest({ answer, queryAuditIds: ledger.queryAuditIds }),
    queryAuditIds: [...ledger.queryAuditIds],
    terminalEvent: terminal as unknown as Record<string, unknown>,
    sessionId: configuration.sessionId,
    telemetry: {
      durationMs: Date.now() - startedAt,
      sqlAttempts: ledger.sqlAttempts,
      sqlSuccesses: ledger.sqlSuccesses,
      sqlFailures: ledger.sqlFailures,
      groundingRejections,
      sessionMirrorErrors: ledger.mirrorErrors.length,
      reviewRequired,
      reviewCompleted: Boolean(reviewerResult?.subtype === "success"),
      providerFallback,
    },
  });
  return Object.freeze({ events: Object.freeze(events), completion });
}
