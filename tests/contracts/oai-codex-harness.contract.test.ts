import assert from "node:assert/strict";
import test from "node:test";
import { tool } from "@openai/agents";
import { z } from "zod";
import {
  AgentsApiError,
  OpenAiAgentsApiClient,
  parseServerSentEvents,
} from "../../packages/albert-oai-codex/src/agents-api";
import { createOaiCodexDriver, OaiCodexTurnError } from "../../packages/albert-oai-codex/src/driver";
import type { OmniAgentDriverInput } from "../../packages/albert-omni/src/driver";

// ---- Fake Agents API ------------------------------------------------------

type Recorded = { method: string; path: string; headers: Headers; body: unknown };

/**
 * A scripted managed-agent backend: session creation streams one turn, a
 * function call waits for its tool result, follow-up input opens a new turn
 * on the subscribed stream.
 */
class FakeAgentsApi {
  readonly requests: Recorded[] = [];
  readonly sessions = new Map<string, { status: string; deleted: boolean }>();
  private sessionCounter = 0;
  private turnCounter = 0;
  private waiters = new Map<string, (event: string) => void>();
  private pendingTurn = new Map<string, string>();
  private scriptedFailure: { code: string; message: string } | null = null;
  private idempotencyKeys: string[] = [];

  failNextTurn(code: string, message: string): void {
    this.scriptedFailure = { code, message };
  }

  get toolResultKeys(): readonly string[] {
    return this.idempotencyKeys;
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: url.pathname, headers, body });
    assert.equal(headers.get("openai-beta"), "agents=v1");
    assert.equal(headers.get("authorization"), "Bearer sk-fixture");

    if (method === "POST" && url.pathname === "/v1/agents/sessions") {
      const sessionId = `sess_fixture_${++this.sessionCounter}`;
      this.sessions.set(sessionId, { status: "in_progress", deleted: false });
      assert.equal(body.environment.type, "none");
      assert.equal(body.stream, true);
      return this.streamTurn(sessionId, body.input, init?.signal ?? undefined, true);
    }
    const sessionMatch = /^\/v1\/agents\/sessions\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname);
    if (!sessionMatch) return new Response("not found", { status: 404 });
    const sessionId = sessionMatch[1]!;
    const rest = sessionMatch[2] ?? "";
    const session = this.sessions.get(sessionId);
    if (!session || session.deleted) {
      return Response.json({ error: { code: "not_found_error", message: "No managed agent resource found" } }, { status: 404 });
    }
    if (method === "DELETE" && rest === "") {
      session.deleted = true;
      return Response.json({ id: sessionId, object: "agent.session.deleted", deleted: true });
    }
    if (method === "GET" && rest === "") {
      return Response.json({ id: sessionId, object: "agent.session", status: session.status, error: null, required_actions: [], usage: null });
    }
    if (method === "GET" && rest === "events") {
      // A subscription waits for the next input message to open a turn.
      return new Response(new ReadableStream<Uint8Array>({
        start: (controller) => {
          const encoder = new TextEncoder();
          this.waiters.set(sessionId, (event) => controller.enqueue(encoder.encode(event)));
          init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* closed */ } }, { once: true });
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (method === "POST" && rest === "events") {
      const events = body.events as Array<Record<string, unknown>>;
      for (const event of events) {
        if (event.type === "agent.session.input.tool_result") {
          this.idempotencyKeys.push(headers.get("idempotency-key") ?? "");
          const pending = this.pendingTurn.get(sessionId);
          assert.equal(event.turn_id, pending, "tool result names the pending turn");
          assert.equal(event.call_id, "call_fixture_1");
          const push = this.waiters.get(sessionId)!;
          const output = String(event.output);
          push(frame("agent.session.turn.item.done", { session_id: sessionId, turn_id: pending, output_index: 1, item: { type: "function_call_output", call_id: "call_fixture_1", output, status: "completed" } }));
          push(frame("agent.session.turn.item.done", { session_id: sessionId, turn_id: pending, output_index: 2, item: { type: "message", id: "msg_final", turn_id: pending, role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: `Done: ${JSON.parse(output).echo}` }] } }));
          push(frame("agent.session.turn.completed", { session_id: sessionId, turn_id: pending, usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 150 }, turn: { id: pending, status: "completed", subagent_id: null, error: null, usage: null } }));
          session.status = "idle";
          push(frame("agent.session.idle", { session: { id: sessionId, status: "idle", error: null, required_actions: [], usage: null } }));
          this.pendingTurn.delete(sessionId);
        } else if (event.type === "agent.session.input.message") {
          const text = (event.input as Array<{ content: Array<{ text: string }> }>)[0]!.content[0]!.text;
          const push = this.waiters.get(sessionId);
          assert.ok(push, "input arrives on a subscribed session");
          session.status = "in_progress";
          this.runTurn(sessionId, text, push);
        } else if (event.type === "agent.session.input.cancel") {
          const pending = this.pendingTurn.get(sessionId);
          const push = this.waiters.get(sessionId);
          if (pending && push) {
            push(frame("agent.session.turn.cancelled", { session_id: sessionId, turn_id: pending, usage: null, turn: { id: pending, status: "cancelled", subagent_id: null, error: null, usage: null } }));
            push(frame("agent.session.idle", { session: { id: sessionId, status: "idle", error: null, required_actions: [], usage: null } }));
          }
        }
      }
      return new Response(null, { status: 202 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  private streamTurn(sessionId: string, input: string, signal: AbortSignal | undefined, created: boolean): Response {
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const encoder = new TextEncoder();
        const push = (event: string) => controller.enqueue(encoder.encode(event));
        this.waiters.set(sessionId, push);
        signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* closed */ } }, { once: true });
        if (created) push(frame("agent.session.created", { session: { id: sessionId, status: "in_progress", error: null, required_actions: [], usage: null } }));
        this.runTurn(sessionId, input, push);
      },
    });
    return new Response(stream, { status: 201, headers: { "content-type": "text/event-stream" } });
  }

  private runTurn(sessionId: string, input: string, push: (event: string) => void): void {
    const turnId = `turn_fixture_${++this.turnCounter}`;
    this.pendingTurn.set(sessionId, turnId);
    push(frame("agent.session.turn.created", { session_id: sessionId, turn_id: turnId, turn: { id: turnId, status: "queued", subagent_id: null, error: null, usage: null } }));
    if (this.scriptedFailure) {
      const failure = this.scriptedFailure;
      this.scriptedFailure = null;
      push(frame("agent.session.turn.failed", { session_id: sessionId, turn_id: turnId, usage: null, turn: { id: turnId, status: "failed", subagent_id: null, error: failure, usage: null } }));
      this.sessions.get(sessionId)!.status = "idle";
      push(frame("agent.session.idle", { session: { id: sessionId, status: "idle", error: null, required_actions: [], usage: null } }));
      this.pendingTurn.delete(sessionId);
      return;
    }
    if (/^nudge/u.test(input)) {
      // A continuation answers straight away with a commentary then the final.
      push(frame("agent.session.turn.item.done", { session_id: sessionId, turn_id: turnId, output_index: 0, item: { type: "message", id: "msg_c", turn_id: turnId, role: "assistant", phase: "commentary", status: "completed", content: [{ type: "output_text", text: "Working on it:" }] } }));
      push(frame("agent.session.turn.item.done", { session_id: sessionId, turn_id: turnId, output_index: 1, item: { type: "message", id: "msg_f", turn_id: turnId, role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: `Continued after: ${input}` }] } }));
      push(frame("agent.session.turn.completed", { session_id: sessionId, turn_id: turnId, usage: null, turn: { id: turnId, status: "completed", subagent_id: null, error: null, usage: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }));
      this.sessions.get(sessionId)!.status = "idle";
      push(frame("agent.session.idle", { session: { id: sessionId, status: "idle", error: null, required_actions: [], usage: null } }));
      this.pendingTurn.delete(sessionId);
      return;
    }
    // Interim commentary, then a function call the client must answer.
    push(frame("agent.session.turn.item.done", { session_id: sessionId, turn_id: turnId, output_index: 0, item: { type: "message", id: "msg_1", turn_id: turnId, role: "assistant", phase: "commentary", status: "completed", content: [{ type: "output_text", text: "Let me check the data." }] } }));
    push(frame("agent.session.turn.item.added", { session_id: sessionId, turn_id: turnId, output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_fixture_1", turn_id: turnId, name: "Echo", arguments: { text: input }, status: "in_progress" } }));
    push(frame("agent.session.requires_action", { session: { id: sessionId, status: "requires_action", error: null, required_actions: [{ type: "function_call", call_id: "call_fixture_1", turn_id: turnId, name: "Echo", arguments: { text: input } }], usage: null } }));
  }
}

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, event_id: `evt_${Math.random().toString(36).slice(2)}`, ...payload })}\n\n`;
}

const echoTool = tool({
  name: "Echo",
  description: "Echoes text.",
  parameters: z.object({ text: z.string() }).strict(),
  strict: true,
  execute: async (input: { text: string }) => JSON.stringify({ ok: true, echo: input.text.toUpperCase() }),
});

function driverInput(overrides: Partial<OmniAgentDriverInput> = {}): OmniAgentDriverInput & { narratives: string[]; checkpoints: number } {
  const narratives: string[] = [];
  const counters = { checkpoints: 0 };
  const controller = new AbortController();
  return {
    name: "Albert Omni analyst",
    instructions: "Be brief.",
    tools: [echoTool],
    preferences: { model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: true },
    identity: { tenantId: "01J00000000000000000000001", actorId: "00000000-0000-4000-8000-000000000001", conversationId: "01J00000000000000000000002", turnId: "01J00000000000000000000003" },
    priorConversation: [],
    message: "hello world",
    signal: controller.signal,
    onNarrative: async (text) => { narratives.push(text); },
    onCheckpoint: async () => { counters.checkpoints += 1; },
    ...overrides,
    narratives,
    get checkpoints() { return counters.checkpoints; },
  };
}

// ---- SSE parser -----------------------------------------------------------

test("the SSE reader joins data lines, drops comments, normalises CRLF and flushes a trailing block", async () => {
  const chunks = ["event: a\r\ndata: {\"x\":1}\r\n\r\n: keepalive\n\ndata: {\"y\"", ":2}\ndata: {\"z\":3}\n\nevent: last\ndata: tail"];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of parseServerSentEvents(body)) frames.push(frame);
  assert.deepEqual(frames, [
    { event: "a", data: "{\"x\":1}" },
    { data: "{\"y\":2}\n{\"z\":3}" },
    { event: "last", data: "tail" },
  ]);
});

// ---- Client ---------------------------------------------------------------

test("the client sends the beta header on every call and surfaces API errors with their code", async () => {
  const api = new FakeAgentsApi();
  const client = new OpenAiAgentsApiClient({ apiKey: "sk-fixture", baseUrl: "https://api.example.test/v1/", fetch: api.fetch });
  await assert.rejects(client.retrieveSession("sess_missing"), (error: unknown) => {
    assert.ok(error instanceof AgentsApiError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "not_found_error");
    return true;
  });
  assert.equal(api.requests[0]?.path, "/v1/agents/sessions/sess_missing");
});

// ---- Driver ---------------------------------------------------------------

test("the OAI Codex driver runs a turn on the managed harness: create with input, answer the function call, return the final answer", async () => {
  const api = new FakeAgentsApi();
  const input = driverInput();
  const driver = createOaiCodexDriver({ apiKey: "sk-fixture", baseUrl: "https://api.example.test/v1", fetch: api.fetch })(input);

  const answer = await driver.run();
  assert.equal(answer, "Done: HELLO WORLD");
  // The interim commentary was narrated when the tool call followed it.
  assert.deepEqual(input.narratives, ["Let me check the data."]);
  assert.equal(input.checkpoints, 1);
  assert.equal(driver.modelRequests(), 1);
  assert.deepEqual(driver.usage(), { requests: 1, inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningTokens: 5 });

  const create = api.requests.find((request) => request.method === "POST" && request.path === "/v1/agents/sessions")!;
  assert.equal(create.body.agent.model, "gpt-5.6-luna");
  assert.equal(create.body.agent.reasoning.effort, "max");
  assert.equal(create.body.agent.service_tier, "fast");
  assert.equal(create.body.agent.instructions, "Be brief.");
  assert.deepEqual(create.body.agent.tools.map((entry: { name: string; type: string }) => [entry.type, entry.name]), [["function", "Echo"]]);
  assert.equal(create.body.agent.tools[0].parameters.additionalProperties, false);
  assert.equal(create.body.input, "hello world");
  assert.equal(create.body.metadata.albert_harness, "oai-codex");
  assert.equal(create.body.metadata.albert_turn, "01J00000000000000000000003");

  const toolResult = api.requests.find((request) => request.method === "POST" && request.path === "/v1/agents/sessions/sess_fixture_1/events")!;
  assert.equal(toolResult.body.events[0].type, "agent.session.input.tool_result");
  assert.equal(toolResult.body.events[0].success, true);
  assert.equal(JSON.parse(toolResult.body.events[0].output).echo, "HELLO WORLD");
  assert.match(api.toolResultKeys[0] ?? "", /^[0-9a-f-]{36}$/u);

  // A continuation subscribes before it posts, and runs on the same session.
  const continued = await driver.run({ assistantText: answer, userText: "nudge: compose the answer" });
  assert.equal(continued, "Continued after: nudge: compose the answer");
  assert.deepEqual(input.narratives, ["Let me check the data.", "Working on it:"]);
  const order = api.requests.filter((request) => request.path === "/v1/agents/sessions/sess_fixture_1/events").map((request) => request.method);
  assert.deepEqual(order, ["POST", "GET", "POST"]);
  assert.equal(driver.modelRequests(), 2);
  assert.deepEqual(driver.checkpointState(), { history: [], driverState: { version: 1, harness: "oai-codex", sessionId: "sess_fixture_1", baseUrl: "https://api.example.test/v1" } });

  await driver.close();
  assert.equal(api.sessions.get("sess_fixture_1")?.deleted, true);
});

test("prior conversation is folded into the first input and the session is kept when retention is on", async () => {
  const api = new FakeAgentsApi();
  const input = driverInput({
    priorConversation: [{ role: "user", text: "How were sales?" }, { role: "assistant", text: "Up 3%." }],
    message: "And margin?",
  });
  const driver = createOaiCodexDriver({ apiKey: "sk-fixture", baseUrl: "https://api.example.test/v1", fetch: api.fetch, retainSessions: true })(input);
  await driver.run();
  const create = api.requests.find((request) => request.method === "POST" && request.path === "/v1/agents/sessions")!;
  assert.match(create.body.input, /^Earlier in this conversation/u);
  assert.match(create.body.input, /Owner: How were sales\?\n\nAlbert: Up 3%\./u);
  assert.match(create.body.input, /The owner now asks:\n\nAnd margin\?$/u);
  await driver.close();
  assert.equal(api.sessions.get("sess_fixture_1")?.deleted, false);
});

test("a failed managed turn surfaces its stable failure category for the retry ladder", async () => {
  const api = new FakeAgentsApi();
  api.failNextTurn("server_overloaded", "The model service is temporarily overloaded.");
  const driver = createOaiCodexDriver({ apiKey: "sk-fixture", baseUrl: "https://api.example.test/v1", fetch: api.fetch })(driverInput());
  await assert.rejects(driver.run(), (error: unknown) => {
    assert.ok(error instanceof OaiCodexTurnError);
    assert.equal(error.code, "server_overloaded");
    assert.match(error.message, /server_overloaded/u);
    return true;
  });
  // The session survives a failed turn: the retry re-sends the question on it.
  const answer = await driver.run();
  assert.equal(answer, "Done: HELLO WORLD");
  assert.equal(api.sessions.size, 1);
});

test("cancelling Albert's turn cancels the managed turn and rejects with the cancellation reason", async () => {
  const api = new FakeAgentsApi();
  const controller = new AbortController();
  const slowTool = tool({
    name: "Echo",
    description: "Echoes text slowly.",
    parameters: z.object({ text: z.string() }).strict(),
    strict: true,
    execute: async () => {
      controller.abort(new Error("owner stopped"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return JSON.stringify({ ok: true, echo: "late" });
    },
  });
  const driver = createOaiCodexDriver({ apiKey: "sk-fixture", baseUrl: "https://api.example.test/v1", fetch: api.fetch })(driverInput({ tools: [slowTool], signal: controller.signal }));
  await assert.rejects(driver.run(), /owner stopped/u);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const cancel = api.requests.find((request) => request.method === "POST" && request.body?.events?.[0]?.type === "agent.session.input.cancel");
  assert.ok(cancel, "the managed turn was asked to cancel");
});

test("the driver refuses to start without a key and ignores non-function tools", () => {
  assert.throws(() => createOaiCodexDriver({ apiKey: " " }), /requires an OpenAI API key/u);
});
