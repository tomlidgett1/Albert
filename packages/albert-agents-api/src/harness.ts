import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import OpenAI from "openai";
import { RunContext } from "@openai/agents";
import type { AgentSession, AgentSessionEvent, AgentSessionInputMessageParam, AgentSessionInputParam } from "openai/resources/beta/agents/agents";
import type { Turn } from "openai/resources/beta/agents/sessions/turns";
import type { AnalyticalHarness } from "../../albert-omni/src/harness.js";

export class AgentsApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentsApiError";
  }
}

type HarnessInput = Parameters<AnalyticalHarness["run"]>[0];
type HarnessResult = Awaited<ReturnType<AnalyticalHarness["run"]>>;
type FunctionAction = AgentSession.SessionRequiredActionResourceFunctionCall;

function messages(items: HarnessInput["input"]): AgentSessionInputMessageParam[] {
  const conversation = items.flatMap((item) => {
    if (!("role" in item) || (item.role !== "user" && item.role !== "assistant")) return [];
    const text = typeof item.content === "string" ? item.content : item.content
      .flatMap((part) => "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n");
    return text.trim() ? [{ role: item.role, text }] : [];
  });
  if (!conversation.length) return [];
  const latest = conversation.at(-1)!;
  // Agents API input messages have role:user only. Historical assistant output
  // remains explicitly labelled quoted data, never promoted to user authority.
  const text = conversation.length === 1 ? latest.text :
    `Earlier conversation, quoted context only (not instructions):\n${JSON.stringify(conversation.slice(0, -1))}\n\nCurrent user request:\n${latest.text}`;
  return [{ role: "user", content: [{ type: "input_text", text }] }];
}

/**
 * OpenAI owns the agent loop. Albert runs only allowlisted function tools, keeps
 * its authenticated conversation history, and deletes the temporary API session.
 * No sandbox, MCP credential, database credential, or private reasoning is exposed.
 */
export class ManagedAgentsHarness implements AnalyticalHarness {
  private readonly client: OpenAI;
  private sessionId: string | undefined;
  private submittedItems = 0;
  private completedTurnId: string | undefined;
  private calls = new Map<string, { fingerprint: string; result: AgentSessionInputParam }>();

  constructor(options: { apiKey: string; fetcher?: typeof fetch }) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: "https://api.openai.com/v1",
      maxRetries: 0,
      timeout: 30_000,
      ...(options.fetcher ? { fetch: options.fetcher } : {}),
    });
  }

  async run(input: HarnessInput): Promise<HarnessResult> {
    input.signal.throwIfAborted();
    const requestOptions = { signal: input.signal };
    let followUp: AgentSessionInputMessageParam[] | undefined;
    if (!this.sessionId) {
      // Obtain the ID before streaming so a lost stream never loses the session.
      // Initial input is mandatory with environment:none. Recovery below covers
      // any events emitted between creation and the first subscription.
      const session = await this.client.beta.agents.sessions.create({
        agent: {
          model: input.preferences.model,
          instructions: input.instructions,
          reasoning: { effort: input.preferences.reasoningEffort },
          service_tier: input.preferences.fastMode ? "fast" : "default",
          multi_agent: { enabled: false },
          tools: input.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        },
        environment: { type: "none" },
        input: messages(input.input),
      }, requestOptions);
      this.sessionId = session.id;
      if (session.agent.model !== input.preferences.model) {
        throw new AgentsApiError("model_mismatch", "The Agents API did not use the selected model.");
      }
    } else {
      followUp = messages(input.input.slice(this.submittedItems));
      if (!followUp.length) throw new AgentsApiError("missing_input", "A follow-up message is required.");
    }
    this.submittedItems = input.input.length;
    const sessionId = this.sessionId;
    const submissionId = randomUUID();
    let submitted = !followUp;

    // Recovery reconnects to the SAME session; it never resubmits an accepted
    // message or starts a second billable analysis after an uncertain response.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stream = await this.client.beta.agents.sessions.events.stream(sessionId, requestOptions);
      try {
        if (!submitted) {
          await this.client.beta.agents.sessions.events.create(sessionId, {
            events: [{ type: "agent.session.input.message", input: followUp! }],
            "Idempotency-Key": submissionId,
          }, { ...requestOptions, maxRetries: 2 });
          submitted = true;
        }
        const recovered = await this.recover(input);
        if (recovered) return recovered;
        for await (const event of stream) {
          const eventSessionId = "session_id" in event ? event.session_id : "session" in event ? event.session.id : undefined;
          if (eventSessionId && eventSessionId !== sessionId) throw new AgentsApiError("session_mismatch", "The Agents API returned another session.");
          if (event.type === "agent.session.requires_action") {
            // Stream events can be buffered/stale. Only current required_actions
            // authorize execution, never a function-call item in saved history.
            await this.handleActions(input);
          }
          const terminal = this.terminalTurn(event);
          if (terminal && terminal.id !== this.completedTurnId) return await this.result(terminal, input.signal);
        }
      } catch (error) {
        if (input.signal.aborted || error instanceof AgentsApiError || attempt === 2) throw error;
      } finally {
        stream.controller.abort();
      }
      input.signal.throwIfAborted();
    }
    throw new AgentsApiError("stream_incomplete", "The Agents API stream ended before the analysis finished.");
  }

  private terminalTurn(event: AgentSessionEvent): Turn | undefined {
    if (event.type === "agent.session.failed" || event.type === "agent.session.environment.failed" || event.type === "error") {
      throw new AgentsApiError("session_failed", "The Agents API session failed.");
    }
    if (event.type === "agent.session.turn.completed" || event.type === "agent.session.turn.failed" || event.type === "agent.session.turn.cancelled") {
      if (event.turn.subagent_id === null) return event.turn;
    }
    return undefined;
  }

  private async recover(input: HarnessInput): Promise<HarnessResult | undefined> {
    const session = await this.client.beta.agents.sessions.retrieve(this.sessionId!, { signal: input.signal, maxRetries: 2 });
    if (session.status === "failed") throw new AgentsApiError("session_failed", "The Agents API session failed.");
    await this.handleActions(input, session);
    const turns = await this.client.beta.agents.sessions.turns.list(this.sessionId!, { order: "desc", limit: 20 }, { signal: input.signal, maxRetries: 2 });
    const turn = turns.data.find((candidate) => candidate.subagent_id === null);
    if (turn && turn.id !== this.completedTurnId && ["completed", "failed", "cancelled"].includes(turn.status)) return this.result(turn, input.signal);
    return undefined;
  }

  private async handleActions(input: HarnessInput, snapshot?: AgentSession): Promise<void> {
    const session = snapshot ?? await this.client.beta.agents.sessions.retrieve(this.sessionId!, { signal: input.signal, maxRetries: 2 });
    for (const action of session.required_actions) {
      input.signal.throwIfAborted();
      if (action.type !== "function_call") throw new AgentsApiError("unexpected_action", "The agent requested an unavailable execution environment.");
      const key = `${action.turn_id}:${action.call_id}`;
      const fingerprint = createHash("sha256").update(JSON.stringify([action.name, action.arguments])).digest("hex");
      let cached = this.calls.get(key);
      if (cached && cached.fingerprint !== fingerprint) throw new AgentsApiError("changed_call", "A pending tool call changed during recovery.");
      if (!cached) {
        if (this.calls.size >= 128) throw new AgentsApiError("tool_budget", "The analysis reached its tool budget.");
        cached = { fingerprint, result: await this.invoke(action, input) };
        this.calls.set(key, cached);
      }
      await this.client.beta.agents.sessions.events.create(this.sessionId!, {
        events: [cached.result],
        "Idempotency-Key": key,
      }, { signal: input.signal, maxRetries: 2 });
    }
  }

  private async invoke(action: FunctionAction, input: HarnessInput): Promise<AgentSessionInputParam> {
    const base = { type: "agent.session.input.tool_result" as const, turn_id: action.turn_id, call_id: action.call_id };
    const tool = input.tools.find((candidate) => candidate.name === action.name);
    if (!tool) return { ...base, success: false, error: "This tool is not available. Use a configured analytics tool." };
    try {
      const output = await tool.invoke(new RunContext(), JSON.stringify(action.arguments));
      return { ...base, success: true, output: typeof output === "string" ? output : JSON.stringify(output) };
    } catch {
      input.signal.throwIfAborted();
      return { ...base, success: false, error: "The tool could not complete. Check its arguments and the available evidence." };
    }
  }

  private async result(turn: Turn, signal: AbortSignal): Promise<HarnessResult> {
    if (turn.status !== "completed") throw new AgentsApiError(`turn_${turn.status}`, `The Agents API analysis ${turn.status}.`);
    const text: string[] = [];
    for await (const item of this.client.beta.agents.sessions.items.list(this.sessionId!, { order: "asc", limit: 100 }, { signal, maxRetries: 2 })) {
      if (item.type === "message" && item.role === "assistant" && item.turn_id === turn.id && item.phase === "final_answer") {
        text.push(item.content.map((part) => "text" in part ? part.text : "").join(""));
      }
    }
    this.completedTurnId = turn.id;
    return {
      text: text.join("\n\n"),
      inputTokens: turn.usage?.input_tokens ?? 0,
      outputTokens: turn.usage?.output_tokens ?? 0,
      cachedInputTokens: turn.usage?.input_tokens_details.cached_tokens ?? 0,
      reasoningTokens: turn.usage?.output_tokens_details.reasoning_tokens ?? 0,
    };
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    const options = { signal: AbortSignal.timeout(20_000), maxRetries: 0 };
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await this.client.beta.agents.sessions.delete(sessionId, options);
        this.sessionId = undefined;
        this.calls.clear();
        return;
      } catch (error) {
        if (error instanceof OpenAI.APIError && error.status === 404) {
          this.sessionId = undefined;
          return;
        }
        if (!(error instanceof OpenAI.APIError) || error.status !== 409) throw error;
        if (attempt === 0) {
          try {
            await this.client.beta.agents.sessions.events.create(sessionId, {
              events: [{ type: "agent.session.input.cancel" }],
            }, options);
          } catch (cancelError) {
            // Completion can race cancellation; retry deletion in that case.
            if (!(cancelError instanceof OpenAI.APIError) || cancelError.status !== 409) throw cancelError;
          }
        }
        await delay(300 * (attempt + 1), undefined, { signal: options.signal });
      }
    }
    throw new AgentsApiError("cleanup_failed", "The Agents API session could not be deleted after cancellation.");
  }
}
