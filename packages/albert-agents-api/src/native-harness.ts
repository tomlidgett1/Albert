import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import type { AgentSession, AgentSessionEvent, AgentSessionInputParam } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import type { Stream } from "openai/core/streaming";
import type { AnalyticalHarness } from "../../albert-omni/src/harness.js";
import { AgentsApiError } from "./harness.js";
import { ResultReferences } from "./references.js";
import { NativeToolInputError } from "./tools.js";
import { ManagedInvestigationBudget, MANAGED_GATHERING_TOOLS } from "./investigation-budget.js";
import { emptyManagedSessionState, MANAGED_SESSION_IDLE_MS, MANAGED_SESSION_NAMESPACE, managedSessionScopeDigest, type ManagedSessionScope, type ManagedSessionState } from "./session-state.js";

type RunInput = Parameters<AnalyticalHarness["run"]>[0];
type RunResult = Awaited<ReturnType<AnalyticalHarness["run"]>>;
type RequiredCall = AgentSession.SessionRequiredActionResourceFunctionCall;
type PersistedOptions = { scope: ManagedSessionScope; state: ManagedSessionState; saveState: (state: ManagedSessionState) => Promise<void> };
type Options = { apiKey: string; fetcher?: typeof fetch } & (PersistedOptions | { scope?: undefined; state?: undefined; saveState?: undefined });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function recentHistory(input: RunInput): string {
  const messages = input.input.flatMap((item) => {
    if (!("role" in item) || (item.role !== "user" && item.role !== "assistant")) return [];
    const text = typeof item.content === "string" ? item.content : item.content.flatMap((part) => "text" in part ? [part.text] : []).join("\n");
    return [{ role: item.role, text }];
  });
  return JSON.stringify(messages.slice(0, -1).slice(-8));
}

export class NativeManagedHarness implements AnalyticalHarness {
  readonly native = true;
  readonly references: ResultReferences;
  readonly metrics = {
    tools: 0, toolFailures: 0, answerRepairs: 0, providerTurns: 0,
    sessionReused: false, usageAvailable: false, synthesisStarted: false,
    inputTokens: null as number | null, outputTokens: null as number | null,
    cachedInputTokens: null as number | null, reasoningTokens: null as number | null,
  };
  private readonly client: OpenAI;
  private state: ManagedSessionState;
  private authorizedSession = false;
  private active = false;
  private createdWithoutCheckpoint = false;
  private activeProviderTurn: string | undefined;
  private investigationBudget: ManagedInvestigationBudget | undefined;
  private calls = new Map<string, { fingerprint: string; result: AgentSessionInputParam }>();

  constructor(private readonly options: Options) {
    this.client = new OpenAI({ apiKey: options.apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 0, timeout: 30_000, ...(options.fetcher ? { fetch: options.fetcher } : {}) });
    this.state = structuredClone(options.state ?? emptyManagedSessionState());
    this.references = new ResultReferences(this.state.references);
  }

  knownTopics(catalogueDigest: string): readonly string[] {
    return this.state.catalogueDigest === catalogueDigest && this.state.idleConfirmed ? this.state.inspectedTopics : [];
  }

  private async save(input?: RunInput): Promise<void> {
    this.state.references = this.references.snapshot();
    if (input?.native) {
      this.state.catalogueDigest = input.native.catalogueDigest;
      this.state.inspectedTopics = [...input.native.getInspectedTopics()];
    }
    try { await this.options.saveState?.(structuredClone(this.state)); }
    catch { throw new AgentsApiError("session_checkpoint_failed", "The conversation could not be saved safely. Please retry."); }
    this.createdWithoutCheckpoint = false;
  }

  private assertOwned(session: AgentSession): void {
    if (!this.options.scope) { this.authorizedSession = true; return; }
    if (session.metadata?.surface !== MANAGED_SESSION_NAMESPACE || session.metadata?.scope !== managedSessionScopeDigest(this.options.scope)) {
      throw new AgentsApiError("session_scope_mismatch", "The saved session does not belong to this conversation.");
    }
    this.authorizedSession = true;
  }

  async run(input: RunInput): Promise<RunResult> {
    if (!input.native) throw new AgentsApiError("missing_native_contract", "The managed answer contract is not configured.");
    input.signal.throwIfAborted();
    const native = input.native;
    this.investigationBudget = input.tools.some((tool) => tool.name === "ComposeDashboard")
      ? undefined : new ManagedInvestigationBudget(Date.now(), native.deadlineAt);
    const tools = input.tools.filter((tool) => tool.name !== "ComposeAnswer" && tool.name !== "ManageTaskList")
      .map((tool) => ({ ...tool, description: tool.description.replaceAll("ComposeAnswer", "the final answer") }));
    if (tools.some((tool) => !tool.invokeNative)) throw new AgentsApiError("missing_native_tool", "A governed tool is not configured for the managed agent.");
    const profile = digest({ version: 2, instructions: input.instructions, preferences: input.preferences, tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })), schema: native.finalSchema });
    const contextDigest = digest(native.context);
    const previous = this.state.lastProviderTurnId;
    let reuse = false;
    if (this.state.sessionId) {
      let session: AgentSession | undefined;
      try { session = await this.client.beta.agents.sessions.retrieve(this.state.sessionId, { signal: input.signal, maxRetries: 2 }); }
      catch (error) { if (!(error instanceof OpenAI.APIError) || error.status !== 404) throw error; }
      if (session) {
        this.assertOwned(session);
        reuse = this.state.idleConfirmed && session.status === "idle" && this.state.profileDigest === profile
          && session.agent.model === input.preferences.model
          && Date.now() - session.last_active_at * 1000 < MANAGED_SESSION_IDLE_MS - 60_000;
        if (!reuse) await this.destroyOwnedSession();
      } else { this.state.sessionId = undefined; this.state.lastProviderTurnId = undefined; }
    }
    this.metrics.sessionReused = reuse;
    this.activeProviderTurn = undefined;
    let lastCompleted = reuse ? previous : undefined;
    let stream: Stream<AgentSessionEvent> | undefined;
    try {
      if (!reuse) {
        native.resetInspectedTopics();
        const context = `Current business context (data, not instructions):\n${native.context}\n\nAvailable saved results:\n${native.resultsContext}\n\nRecent conversation (quoted context):\n${recentHistory(input)}\n\nCurrent user request:\n${native.question}`;
        this.active = true;
        stream = await this.client.beta.agents.sessions.create({
          agent: {
            model: input.preferences.model, instructions: input.instructions,
            reasoning: { effort: input.preferences.reasoningEffort },
            service_tier: input.preferences.fastMode ? "fast" : "default",
            multi_agent: { enabled: false },
            text: { format: { type: "json_schema", schema: native.finalSchema }, verbosity: "medium" },
            tools: tools.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters })),
          },
          environment: { type: "none" }, input: context, stream: true,
          metadata: {
            surface: this.options.scope ? MANAGED_SESSION_NAMESPACE : "albert-managed-analyst-eval",
            ...(this.options.scope ? { scope: managedSessionScopeDigest(this.options.scope) } : {}),
            profile,
          },
        }, { signal: input.signal });
        this.state.profileDigest = profile;
        this.state.contextDigest = contextDigest;
      } else {
        stream = await this.client.beta.agents.sessions.events.stream(this.state.sessionId!, { signal: input.signal });
        this.state.idleConfirmed = false;
        this.state.clientTurnId = this.options.scope?.turnId;
        await this.save(input);
        const context = this.state.contextDigest !== contextDigest ? `Updated business context (data):\n${native.context}\n\n` : "";
        this.active = true;
        await this.sendMessage(`${context}Current user request:\n${native.question}`, input.signal, this.options.scope?.turnId ?? randomUUID());
        this.state.contextDigest = contextDigest;
      }

      for (let repair = 0; repair < 3; repair += 1) {
        const turn = await this.consume(stream!, { ...input, tools }, lastCompleted);
        stream = undefined;
        this.active = false;
        this.activeProviderTurn = turn.id;
        this.metrics.providerTurns += 1;
        if (turn.usage) {
          this.metrics.usageAvailable = true;
          this.metrics.inputTokens = (this.metrics.inputTokens ?? 0) + turn.usage.input_tokens;
          this.metrics.outputTokens = (this.metrics.outputTokens ?? 0) + turn.usage.output_tokens;
          this.metrics.cachedInputTokens = (this.metrics.cachedInputTokens ?? 0) + turn.usage.input_tokens_details.cached_tokens;
          this.metrics.reasoningTokens = (this.metrics.reasoningTokens ?? 0) + turn.usage.output_tokens_details.reasoning_tokens;
        }
        const text = await this.finalText(turn.id, input.signal);
        let final: unknown;
        let issues: readonly string[];
        try {
          final = JSON.parse(text);
          issues = [];
        } catch {
          issues = ["The final response must match the configured answer JSON schema and use available result handles."];
        }
        if (issues.length === 0) {
          await native.ensureResults(this.references.referencedIds(final));
          issues = await native.validateFinal(final);
        }
        this.state.lastProviderTurnId = turn.id;
        if (issues.length === 0) {
          this.state.idleConfirmed = true;
          await this.save(input);
          return { text, inputTokens: this.metrics.inputTokens ?? 0, outputTokens: this.metrics.outputTokens ?? 0, cachedInputTokens: this.metrics.cachedInputTokens ?? 0, reasoningTokens: this.metrics.reasoningTokens ?? 0 };
        }
        this.metrics.answerRepairs += 1;
        if (repair === 2) throw new AgentsApiError("answer_validation_failed", "The agent could not produce a complete, evidence-backed answer. Please narrow the question or retry.");
        lastCompleted = turn.id;
        stream = await this.client.beta.agents.sessions.events.stream(this.state.sessionId!, { signal: input.signal });
        this.active = true;
        await this.sendMessage(`Your answer has not been delivered. Address this exact request: ${native.question}\n\nRepair these issues using the available evidence, then return the complete answer JSON:\n${issues.slice(0, 8).join("\n")}`, input.signal, `${this.options.scope?.turnId ?? randomUUID()}:repair:${repair}`);
      }
      throw new AgentsApiError("answer_validation_failed", "The answer could not be validated.");
    } catch (error) {
      if (this.active && this.authorizedSession && this.state.sessionId) await this.cancelActive().catch(() => undefined);
      if (input.signal.aborted && /timed out|timeout/iu.test(String(input.signal.reason?.message ?? input.signal.reason))) {
        throw new AgentsApiError("analysis_timeout", "This analysis reached its time limit. Any completed query results remain in Evidence and checks.");
      }
      throw error;
    } finally { stream?.controller.abort(); }
  }

  private async sendMessage(text: string, signal: AbortSignal, key: string): Promise<void> {
    await this.client.beta.agents.sessions.events.create(this.state.sessionId!, {
      events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text }] }] }],
      "Idempotency-Key": key,
    }, { signal, maxRetries: 2 });
  }

  private async consume(initial: Stream<AgentSessionEvent>, input: RunInput, previous?: string): Promise<Turn> {
    let stream = initial;
    for (let reconnect = 0; reconnect < 3; reconnect += 1) {
      try {
        if (reconnect > 0) {
          stream = await this.client.beta.agents.sessions.events.stream(this.state.sessionId!, { signal: input.signal });
          const session = await this.client.beta.agents.sessions.retrieve(this.state.sessionId!, { signal: input.signal, maxRetries: 2 });
          this.assertOwned(session);
          if (session.status === "failed") throw new AgentsApiError("session_failed", "The managed session failed.");
          await this.actions(input, session, previous);
          const turns = await this.client.beta.agents.sessions.turns.list(this.state.sessionId!, { order: "desc", limit: 10 }, { signal: input.signal, maxRetries: 2 });
          const latest = turns.data.find((turn) => turn.subagent_id === null);
          if (latest && latest.id !== previous && ["completed", "failed", "cancelled"].includes(latest.status)) return this.completed(latest);
        }
        for await (const event of stream) {
          if (event.type === "agent.session.created") {
            this.assertOwned(event.session);
            if (event.session.agent.model !== input.preferences.model) throw new AgentsApiError("model_mismatch", "The managed session did not use the selected model.");
            this.state.sessionId = event.session.id;
            this.createdWithoutCheckpoint = true;
            this.state.idleConfirmed = false;
            this.state.clientTurnId = this.options.scope?.turnId;
            await this.save(input);
          }
          const id = "session_id" in event ? event.session_id : "session" in event ? event.session.id : undefined;
          if (id && this.state.sessionId && id !== this.state.sessionId) throw new AgentsApiError("session_scope_mismatch", "The event belongs to another conversation.");
          if (event.type === "agent.session.turn.created" && event.turn.subagent_id === null && event.turn.id !== previous) this.activeProviderTurn = event.turn.id;
          if (event.type === "agent.session.requires_action") await this.actions(input, undefined, previous);
          if (event.type === "error" || event.type === "agent.session.failed" || event.type === "agent.session.environment.failed") throw new AgentsApiError("session_failed", "OpenAI could not finish this session. Please retry.");
          if (["agent.session.turn.completed", "agent.session.turn.failed", "agent.session.turn.cancelled"].includes(event.type) && "turn" in event && event.turn.subagent_id === null && event.turn.id !== previous) {
            return this.completed({ ...event.turn, usage: event.turn.usage ?? ("usage" in event ? event.usage : null) });
          }
        }
      } catch (error) {
        if (input.signal.aborted || error instanceof AgentsApiError || reconnect === 2 || !this.state.sessionId) throw error;
      } finally { stream.controller.abort(); }
    }
    throw new AgentsApiError("stream_incomplete", "The analysis stream ended before completion.");
  }

  private completed(turn: Turn): Turn {
    this.active = false;
    if (turn.status !== "completed") throw new AgentsApiError(`turn_${turn.status}`, turn.status === "cancelled" ? "The analysis was stopped." : "OpenAI could not finish this analysis. Please retry.");
    return turn;
  }

  private async actions(input: RunInput, snapshot?: AgentSession, previous?: string): Promise<void> {
    const session = snapshot ?? await this.client.beta.agents.sessions.retrieve(this.state.sessionId!, { signal: input.signal, maxRetries: 2 });
    this.assertOwned(session);
    for (const action of session.required_actions) {
      input.signal.throwIfAborted();
      if (action.type !== "function_call") throw new AgentsApiError("unexpected_action", "The agent requested an unavailable environment.");
      if (action.turn_id === previous) continue;
      this.activeProviderTurn = action.turn_id;
      const key = `${action.turn_id}:${action.call_id}`;
      const fingerprint = digest([action.name, action.arguments]);
      let cached = this.calls.get(key);
      if (cached && cached.fingerprint !== fingerprint) throw new AgentsApiError("changed_call", "A pending tool call changed during recovery.");
      if (!cached) {
        if (this.calls.size >= 80) throw new AgentsApiError("tool_budget", "This analysis reached its investigation limit. Please narrow the question.");
        cached = { fingerprint, result: await this.invoke(action, input) };
        this.calls.set(key, cached);
        await this.save(input);
      }
      await this.client.beta.agents.sessions.events.create(this.state.sessionId!, { events: [cached.result], "Idempotency-Key": key }, { signal: input.signal, maxRetries: 2 });
    }
  }

  private async invoke(action: RequiredCall, input: RunInput): Promise<AgentSessionInputParam> {
    const base = { type: "agent.session.input.tool_result" as const, turn_id: action.turn_id, call_id: action.call_id };
    this.metrics.tools += 1;
    try {
      const guidance = await this.executionGuidance(input);
      if (guidance && MANAGED_GATHERING_TOOLS.has(action.name)) throw new Error(guidance);
      const tool = input.tools.find((candidate) => candidate.name === action.name);
      if (!tool?.invokeNative) throw new Error("Use an available governed analytics tool.");
      await input.native!.ensureResults(this.references.referencedIds(action.arguments));
      input.signal.throwIfAborted();
      const output = await tool.invokeNative(this.references.decode(action.arguments));
      let result: unknown = output;
      if (typeof output === "string") { try { result = JSON.parse(output); } catch { /* Semantic definitions can be YAML. */ } }
      if (result && typeof result === "object" && !Array.isArray(result) && (result as { ok?: unknown }).ok === false) {
        this.metrics.toolFailures += 1;
        await input.native!.recordToolFailure(action.name, JSON.stringify(result).slice(0, 600));
        return { ...base, success: false, error: JSON.stringify(this.references.encode(result)).slice(0, 12_000) };
      }
      const finish = await this.executionGuidance(input);
      const encoded = this.references.encode(result);
      const renderedOutput = typeof encoded === "string" ? `${encoded}${finish ? `\n\nExecution guidance: ${finish}` : ""}`
        : JSON.stringify(finish && encoded && typeof encoded === "object" && !Array.isArray(encoded) ? { ...encoded, executionGuidance: finish } : encoded);
      return { ...base, success: true, output: renderedOutput };
    } catch (error) {
      input.signal.throwIfAborted();
      if (error instanceof AgentsApiError) throw error;
      this.metrics.toolFailures += 1;
      await input.native!.recordToolFailure(action.name, error instanceof Error ? error.message : "The tool could not complete.");
      return { ...base, success: false, error: error instanceof NativeToolInputError
        ? `Correct these argument fields and retry: ${error.message}`
        : error instanceof Error ? error.message.slice(0, 600) : "The tool could not complete. Check the available fields and results." };
    }
  }

  private async executionGuidance(input: RunInput): Promise<string | undefined> {
    const progress = input.native?.getProgress?.();
    const guidance = this.investigationBudget?.guidance(Date.now(), this.metrics.tools, (progress?.results ?? 0) > 0);
    if (guidance && !this.metrics.synthesisStarted) {
      this.metrics.synthesisStarted = true;
      await input.native?.onSynthesis?.();
    }
    return guidance;
  }

  private async finalText(turnId: string, signal: AbortSignal): Promise<string> {
    for await (const item of this.client.beta.agents.sessions.items.list(this.state.sessionId!, { order: "desc", limit: 100 }, { signal, maxRetries: 2 })) {
      if (item.type === "message" && item.role === "assistant" && item.phase === "final_answer" && item.turn_id === turnId) return item.content.map((part) => "text" in part ? part.text : "").join("");
    }
    throw new AgentsApiError("missing_answer", "The agent finished without a final answer.");
  }

  private async cancelActive(): Promise<void> {
    if (!this.state.sessionId || !this.authorizedSession || !this.active) return;
    await this.client.beta.agents.sessions.events.create(this.state.sessionId, { events: [{ type: "agent.session.input.cancel" }] }, { signal: AbortSignal.timeout(10_000), maxRetries: 1 });
    this.active = false;
  }

  private async destroyOwnedSession(): Promise<void> {
    if (!this.state.sessionId || !this.authorizedSession) return;
    const id = this.state.sessionId;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.client.beta.agents.sessions.delete(id, { signal: AbortSignal.timeout(10_000), maxRetries: 0 });
        this.state.sessionId = undefined; this.state.lastProviderTurnId = undefined; this.authorizedSession = false; return;
      } catch (error) {
        if (error instanceof OpenAI.APIError && error.status === 404) { this.state.sessionId = undefined; this.authorizedSession = false; return; }
        if (!(error instanceof OpenAI.APIError) || error.status !== 409) throw error;
        if (attempt === 0) await this.client.beta.agents.sessions.events.create(id, { events: [{ type: "agent.session.input.cancel" }] }, { signal: AbortSignal.timeout(10_000), maxRetries: 1 });
        await delay(250 * (attempt + 1));
      }
    }
    throw new AgentsApiError("session_cleanup_failed", "The interrupted managed session could not be closed.");
  }

  async close(): Promise<void> {
    if (!this.options.scope || this.createdWithoutCheckpoint) await this.destroyOwnedSession();
  }
}
