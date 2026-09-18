import { randomUUID } from "node:crypto";
import { RunContext } from "@openai/agents";
import {
  AgentsApiError,
  OPENAI_AGENTS_DEFAULT_BASE_URL,
  OpenAiAgentsApiClient,
  type AgentsApiAgentParam,
  type AgentsApiEvent,
  type AgentsApiItem,
  type AgentsApiMessageItem,
  type AgentsApiRequiredAction,
  type AgentsApiUsage,
} from "./agents-api.js";
import {
  EMPTY_OMNI_TURN_USAGE,
  assembleDriverAnswer,
  isOmniFunctionTool,
  type OmniAgentDriver,
  type OmniAgentDriverFactory,
  type OmniAgentDriverInput,
  type OmniDriverContinuation,
  type OmniFunctionTool,
} from "../../albert-omni/src/driver.js";
import type { OmniTurnUsage } from "../../albert-omni/src/contracts.js";
import { ALBERT_OAI_CODEX_HARNESS } from "./contracts.js";

export type OaiCodexDriverConfig = Readonly<{
  apiKey: string;
  baseUrl?: string;
  /**
   * Keep sessions on OpenAI's side after the turn. Off by default: the
   * managed harness stores every item of a session (tool outputs included)
   * and offers no zero-data-retention mode, so Albert deletes the session
   * once its trace has been persisted on Albert's side.
   */
  retainSessions?: boolean;
  fetch?: typeof fetch;
}>;

/** Private continuation state carried in the turn checkpoint. */
export type OaiCodexDriverState = Readonly<{
  version: 1;
  harness: typeof ALBERT_OAI_CODEX_HARNESS;
  sessionId: string;
  baseUrl: string;
}>;

/** A turn the managed harness ended without an answer, with its stable failure category. */
export class OaiCodexTurnError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`OpenAI Agents API turn failed (${code})${detail ? `: ${detail}` : ""}`);
    this.name = "OaiCodexTurnError";
  }
}

type PendingCall = Readonly<{ turnId: string; callId: string; name: string; arguments: unknown }>;

type ConsumeState = {
  selectedTurn: string | undefined;
  ended: boolean;
  /** The root turn whose usage OpenAI had not attached by its terminal event. */
  usagePending: string | null;
  /** Assistant prose since the last successful tool result. */
  parts: string[];
  /** An interim message not yet narrated (narrated when a tool call follows it). */
  pending: string | null;
  finalAnswer: string;
  narrated: number;
};

const MAX_NARRATIVES = 12;
const TOOL_RESULT_RETRY_DELAYS_MS = [100, 300, 600] as const;
const CANCEL_TIMEOUT_MS = 5_000;
const LATE_USAGE_DELAYS_MS = [0, 2_000] as const;
const DELETE_TIMEOUT_MS = 10_000;

function isOaiCodexDriverState(value: unknown): value is OaiCodexDriverState {
  return typeof value === "object" && value !== null
    && (value as OaiCodexDriverState).version === 1
    && (value as OaiCodexDriverState).harness === ALBERT_OAI_CODEX_HARNESS
    && typeof (value as OaiCodexDriverState).sessionId === "string"
    && typeof (value as OaiCodexDriverState).baseUrl === "string";
}

function messageText(item: AgentsApiMessageItem): string {
  return item.content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

/** Whether a tool output reports success: JSON with ok !== false, or a plain document. */
function toolOutputSucceeded(output: string): boolean {
  if (/^An error occurred while running the tool/u.test(output)) return false;
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === false) return false;
  } catch {
    // Non-JSON tool output (a model document, a CSV) is a successful result.
  }
  return true;
}

function foldPriorConversation(
  priorConversation: OmniAgentDriverInput["priorConversation"],
  message: string,
): string {
  if (priorConversation.length === 0) return message;
  const transcript = priorConversation
    .map((entry) => `${entry.role === "user" ? "Owner" : "Albert"}: ${entry.text}`)
    .join("\n\n");
  return `Earlier in this conversation (most recent last):\n\n${transcript}\n\n---\n\nThe owner now asks:\n\n${message}`;
}

class OaiCodexSessionDriver implements OmniAgentDriver {
  private readonly client: OpenAiAgentsApiClient;
  private readonly baseUrl: string;
  private readonly functionTools: readonly OmniFunctionTool[];
  private readonly toolsByName: Map<string, OmniFunctionTool>;
  private readonly seenCalls = new Set<string>();
  private readonly totals: { -readonly [K in keyof OmniTurnUsage]: OmniTurnUsage[K] };
  private sessionId: string | null = null;
  private resumePending = false;
  private turnsRun: number;

  constructor(
    private readonly config: OaiCodexDriverConfig,
    private readonly input: OmniAgentDriverInput,
  ) {
    this.baseUrl = (config.baseUrl?.trim() || OPENAI_AGENTS_DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.client = new OpenAiAgentsApiClient({
      apiKey: config.apiKey,
      baseUrl: this.baseUrl,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
    this.functionTools = input.tools.filter(isOmniFunctionTool);
    this.toolsByName = new Map(this.functionTools.map((tool) => [tool.name, tool]));
    this.totals = { ...(input.resume?.usage ?? EMPTY_OMNI_TURN_USAGE) };
    this.turnsRun = input.resume?.modelRequests ?? 0;
    const state = input.resume?.driverState;
    if (isOaiCodexDriverState(state) && state.baseUrl === this.baseUrl) {
      this.sessionId = state.sessionId;
      this.resumePending = true;
    }
  }

  modelRequests = (): number => this.turnsRun;

  usage = (): OmniTurnUsage => Object.freeze({ ...this.totals });

  checkpointState = () => ({
    history: [],
    ...(this.sessionId ? {
      driverState: {
        version: 1 as const,
        harness: ALBERT_OAI_CODEX_HARNESS,
        sessionId: this.sessionId,
        baseUrl: this.baseUrl,
      } satisfies OaiCodexDriverState,
    } : {}),
  });

  run = async (continuation?: OmniDriverContinuation): Promise<string> => {
    this.throwIfAborted();
    if (this.resumePending) {
      this.resumePending = false;
      const resumed = await this.resumeSession();
      if (resumed !== null) return resumed;
    }
    const controller = this.runController();
    try {
      if (!this.sessionId) {
        // A conversation-only session must be created with its first input.
        // A continuation on a lost session replays the question with the
        // instruction so the new session lands where the old one stopped.
        const initial = foldPriorConversation(this.input.priorConversation, this.input.message);
        const text = continuation ? `${initial}\n\n${continuation.userText}` : initial;
        const stream = await this.client.createSessionStream({
          agent: this.agentParam(),
          environment: { type: "none" },
          input: text,
          metadata: this.metadata(),
        }, controller.signal);
        return await this.consume(stream, controller);
      }
      const stream = await this.client.streamEvents(this.sessionId, controller.signal);
      await this.client.submitEvents(this.sessionId, [{
        type: "agent.session.input.message",
        input: [{ role: "user", content: [{ type: "input_text", text: continuation?.userText ?? this.input.message }] }],
      }], { idempotencyKey: randomUUID(), signal: controller.signal });
      return await this.consume(stream, controller);
    } finally {
      controller.abort();
    }
  };

  close = async (): Promise<void> => {
    if (!this.sessionId || this.config.retainSessions) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    await this.client.deleteSession(sessionId, AbortSignal.timeout(DELETE_TIMEOUT_MS)).catch(() => undefined);
  };

  private throwIfAborted(): void {
    if (this.input.signal.aborted) throw this.input.signal.reason ?? new Error("The analysis was cancelled.");
  }

  /** One local controller per run: cancels the harness turn when Albert's turn is cancelled, and closes the stream at the end. */
  private runController(): AbortController {
    const controller = new AbortController();
    const onAbort = () => {
      const sessionId = this.sessionId;
      if (sessionId) {
        void this.client.submitEvents(sessionId, [{ type: "agent.session.input.cancel" }], {
          signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
        }).catch(() => undefined);
      }
      controller.abort(this.input.signal.reason);
    };
    if (this.input.signal.aborted) onAbort();
    else this.input.signal.addEventListener("abort", onAbort, { once: true });
    controller.signal.addEventListener("abort", () => this.input.signal.removeEventListener("abort", onAbort), { once: true });
    return controller;
  }

  private metadata(): Record<string, string> {
    return {
      albert_harness: ALBERT_OAI_CODEX_HARNESS,
      albert_tenant: this.input.identity.tenantId,
      albert_conversation: this.input.identity.conversationId,
      albert_turn: this.input.identity.turnId,
    };
  }

  private agentParam(): AgentsApiAgentParam {
    const { preferences } = this.input;
    return {
      model: preferences.model,
      instructions: this.input.instructions,
      reasoning: { effort: preferences.reasoningEffort === "none" ? "low" : preferences.reasoningEffort },
      service_tier: preferences.fastMode ? "fast" : "default",
      text: { verbosity: "medium" },
      tools: this.functionTools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Readonly<Record<string, unknown>>,
      })),
      multi_agent: { enabled: false },
    };
  }

  /**
   * Re-attaches to the session a checkpoint recorded. An idle session
   * finished its turn while Albert was away: its answer is read from the
   * items. A waiting or running session is subscribed to and its pending
   * tool calls are satisfied. A failed or missing session starts afresh.
   */
  private async resumeSession(): Promise<string | null> {
    const sessionId = this.sessionId;
    if (!sessionId) return null;
    const session = await this.client.retrieveSession(sessionId, this.input.signal).catch(() => null);
    if (!session || session.status === "failed") {
      this.sessionId = null;
      return null;
    }
    if (session.status === "idle") {
      const items = await this.client.listItems(sessionId, this.input.signal).catch(() => [] as AgentsApiItem[]);
      let parts: string[] = [];
      let final = "";
      for (const item of items) {
        if (item.type === "message") {
          const message = item as AgentsApiMessageItem;
          if (message.role === "user") {
            parts = [];
            final = "";
            continue;
          }
          const text = messageText(message);
          if (message.phase === "final_answer") final = text;
          else parts.push(text);
        } else if (item.type === "function_call_output") {
          const output = (item as { output?: unknown }).output;
          if (typeof output === "string" && toolOutputSucceeded(output)) parts = [];
        }
      }
      return assembleDriverAnswer(parts, final);
    }
    const controller = this.runController();
    try {
      const stream = await this.client.streamEvents(sessionId, controller.signal);
      return await this.consume(stream, controller, session.required_actions);
    } finally {
      controller.abort();
    }
  }

  private async consume(
    stream: AsyncGenerator<AgentsApiEvent, void, undefined>,
    controller: AbortController,
    requiredActions: readonly AgentsApiRequiredAction[] = [],
  ): Promise<string> {
    const state: ConsumeState = { selectedTurn: undefined, ended: false, usagePending: null, parts: [], pending: null, finalAnswer: "", narrated: 0 };
    const pendingTools = new Set<Promise<void>>();
    const schedule = (call: PendingCall) => {
      const key = `${call.turnId}:${call.callId}`;
      if (this.seenCalls.has(key)) return;
      this.seenCalls.add(key);
      state.selectedTurn ??= call.turnId;
      const task = this.runToolCall(call, state, controller.signal).finally(() => pendingTools.delete(task));
      pendingTools.add(task);
    };
    for (const action of requiredActions) {
      if (action.type === "function_call") {
        schedule({ turnId: action.turn_id, callId: action.call_id, name: action.name, arguments: action.arguments });
      }
    }
    try {
      for await (const event of stream) {
        this.throwIfAborted();
        switch (event.type) {
          case "agent.session.created": {
            if (event.session?.id) this.sessionId = event.session.id;
            break;
          }
          case "agent.session.turn.created": {
            if (event.turn?.subagent_id === null && !state.selectedTurn) state.selectedTurn = event.turn_id ?? event.turn.id;
            break;
          }
          case "agent.session.turn.item.added": {
            const item = event.item;
            if (item?.type === "function_call") {
              const call = item as Extract<AgentsApiItem, { type: "function_call" }>;
              await this.flushNarrative(state);
              schedule({ turnId: call.turn_id, callId: call.call_id, name: call.name, arguments: call.arguments });
            }
            break;
          }
          case "agent.session.requires_action": {
            for (const action of event.session?.required_actions ?? []) {
              if (action.type === "function_call") {
                schedule({ turnId: action.turn_id, callId: action.call_id, name: action.name, arguments: action.arguments });
              }
            }
            break;
          }
          case "agent.session.turn.item.done": {
            const item = event.item;
            if (item?.type === "message" && (item as AgentsApiMessageItem).role === "assistant") {
              const message = item as AgentsApiMessageItem;
              const text = messageText(message).trim();
              if (!text) break;
              await this.flushNarrative(state);
              if (message.phase === "final_answer") state.finalAnswer = text;
              else state.pending = text;
              state.parts.push(text);
            }
            break;
          }
          case "agent.session.turn.completed":
          case "agent.session.turn.failed":
          case "agent.session.turn.cancelled": {
            const turn = event.turn;
            const rootTurn = turn?.subagent_id === null || turn?.subagent_id === undefined;
            const mine = state.selectedTurn ? event.turn_id === state.selectedTurn : rootTurn;
            if (!mine) break;
            // Usage is attached to the turn a few seconds after its terminal
            // event; a missing figure is fetched once the session is idle,
            // never invented.
            const usage = event.usage ?? turn?.usage ?? null;
            if (usage) this.recordUsage(usage);
            else state.usagePending = event.turn_id ?? turn?.id ?? null;
            this.turnsRun += 1;
            state.ended = true;
            if (event.type === "agent.session.turn.failed") {
              throw new OaiCodexTurnError(turn?.error?.code ?? "unknown", turn?.error?.message ?? "");
            }
            if (event.type === "agent.session.turn.cancelled") {
              throw this.input.signal.reason ?? new Error("The analysis was cancelled.");
            }
            break;
          }
          case "agent.session.failed": {
            this.sessionId = null;
            throw new OaiCodexTurnError("session_failed", event.session?.error ?? "the managed session failed");
          }
          case "error": {
            throw new OaiCodexTurnError(event.error?.code ?? "stream_error", event.error?.message ?? "");
          }
          case "agent.session.idle": {
            if (!state.ended) break;
            await Promise.all([...pendingTools]);
            if (state.usagePending) this.recordUsage(await this.lateUsage(state.usagePending));
            return assembleDriverAnswer(state.parts, state.finalAnswer || state.pending || "");
          }
          default:
            break;
        }
      }
      this.throwIfAborted();
      throw new OaiCodexTurnError("stream_ended", "the event stream ended before the turn finished");
    } finally {
      controller.abort();
      await Promise.allSettled([...pendingTools]);
    }
  }

  private async flushNarrative(state: ConsumeState): Promise<void> {
    const text = state.pending;
    state.pending = null;
    if (!text || state.narrated >= MAX_NARRATIVES) return;
    state.narrated += 1;
    await this.input.onNarrative(text);
  }

  private async runToolCall(call: PendingCall, state: ConsumeState, signal: AbortSignal): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const tool = this.toolsByName.get(call.name);
    let result: Readonly<{ success: true; output: string }> | Readonly<{ success: false; error: string }>;
    if (!tool) {
      result = { success: false, error: `Unknown tool ${call.name}. Use only the tools you were given.` };
    } else {
      const argumentsText = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
      try {
        const output = await tool.invoke(new RunContext(), argumentsText);
        result = { success: true, output: typeof output === "string" ? output : JSON.stringify(output ?? null) };
      } catch (error) {
        if (this.input.signal.aborted) throw error;
        result = { success: false, error: "The tool could not be run. Try again or take another approach." };
      }
    }
    if (result.success && toolOutputSucceeded(result.output)) state.parts = [];
    await this.submitToolResult(sessionId, call, result, signal);
    await this.input.onCheckpoint();
  }

  private async submitToolResult(
    sessionId: string,
    call: PendingCall,
    result: Readonly<{ success: true; output: string }> | Readonly<{ success: false; error: string }>,
    signal: AbortSignal,
  ): Promise<void> {
    const idempotencyKey = randomUUID();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.client.submitEvents(sessionId, [{
          type: "agent.session.input.tool_result",
          turn_id: call.turnId,
          call_id: call.callId,
          success: result.success,
          ...(result.success ? { output: result.output } : { error: result.error }),
        }], { idempotencyKey, signal });
        return;
      } catch (error) {
        // The call can be announced on the stream a beat before the input
        // endpoint knows it; a short retry ladder covers that registration gap.
        const delay = TOOL_RESULT_RETRY_DELAYS_MS[attempt];
        const registrationGap = error instanceof AgentsApiError
          && error.status === 400
          && /Unknown pending tool call/iu.test(error.message);
        if (delay === undefined || !registrationGap || signal.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /** Two bounded attempts: at idle, then once more after a short pause. */
  private async lateUsage(turnId: string | null | undefined): Promise<AgentsApiUsage | null> {
    if (!turnId || !this.sessionId) return null;
    for (const delayMs of LATE_USAGE_DELAYS_MS) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (this.input.signal.aborted) return null;
      const turn = await this.client.retrieveTurn(this.sessionId, turnId, AbortSignal.timeout(CANCEL_TIMEOUT_MS)).catch(() => null);
      if (turn?.usage) return turn.usage;
    }
    return null;
  }

  private recordUsage(usage: AgentsApiUsage | null): void {
    this.totals.requests += 1;
    if (!usage) return;
    this.totals.inputTokens += usage.input_tokens ?? 0;
    this.totals.cachedInputTokens += usage.input_tokens_details?.cached_tokens ?? 0;
    this.totals.outputTokens += usage.output_tokens ?? 0;
    this.totals.reasoningTokens += usage.output_tokens_details?.reasoning_tokens ?? 0;
  }
}

/** A driver factory that runs each Omni-style turn on OpenAI's managed Codex harness. */
export function createOaiCodexDriver(config: OaiCodexDriverConfig): OmniAgentDriverFactory {
  if (!config.apiKey.trim()) throw new Error("The OAI Codex harness requires an OpenAI API key.");
  return (input) => new OaiCodexSessionDriver(config, input);
}
