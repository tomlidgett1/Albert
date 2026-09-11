import assert from "node:assert/strict";
import test from "node:test";
import { tool, user } from "@openai/agents";
import { z } from "zod";
import { ManagedAgentsHarness } from "../../packages/albert-agents-api/src/harness.js";
import { DEFAULT_AGENTS_API_PREFERENCES } from "../../packages/albert-agents-api/src/config.js";
import { describeChatFailure } from "../../packages/shared/src/chat-failure.js";

function fixture(options: { events?: unknown[]; pending?: boolean; completedBeforeStream?: boolean; cancelBeforeDelete?: boolean } = {}) {
  const requests: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  let pending = options.pending ?? false;
  let cancelled = false;
  const action = { type: "function_call", name: "RecordedTotal", arguments: { period: "test" }, turn_id: "turn_test", call_id: "call_test" };
  const turn = { id: "turn_test", session_id: "sess_test", subagent_id: null, status: "completed", usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 50 }, output_tokens_details: { reasoning_tokens: 10 } } };
  const session = () => ({ id: "sess_test", agent: { model: "gpt-5.6-luna" }, status: pending ? "requires_action" : "in_progress", required_actions: pending ? [action] : [] });
  const fetcher: typeof fetch = async (raw, init) => {
    const request = new Request(raw, init);
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() as Record<string, unknown> : null;
    requests.push({ method: request.method, path, body });
    assert.equal(request.headers.get("openai-beta"), "agents=v1");
    const json = (data: unknown, status = 200) => Response.json(data, { status });
    if (path.endsWith("/sessions") && request.method === "POST") return json(session(), 201);
    if (path.endsWith("/events") && request.method === "POST") {
      const events = body?.events as { type: string }[];
      if (events[0]?.type === "agent.session.input.cancel") cancelled = true;
      else pending = false;
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/events")) {
      const events = options.events ?? [
        { type: "agent.session.idle", session: session() },
        { type: "agent.session.requires_action", session: { ...session(), required_actions: [action] } },
        { type: "agent.session.requires_action", session: { ...session(), required_actions: [action] } },
        { type: "agent.session.turn.completed", session_id: "sess_test", turn },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/turns")) return json({ data: [{ ...turn, status: options.completedBeforeStream ? "completed" : "in_progress" }], has_more: false });
    if (path.endsWith("/items")) return json({ data: [
      { type: "reasoning", id: "reasoning_private", summary: [{ text: "PRIVATE_REASONING" }] },
      { type: "message", id: "commentary", role: "assistant", phase: "commentary", turn_id: "turn_test", content: [{ type: "output_text", text: "INTERIM_DRAFT" }] },
      { type: "message", id: "final", role: "assistant", phase: "final_answer", turn_id: "turn_test", content: [{ type: "output_text", text: "Recorded total: 42." }] },
    ], has_more: false });
    if (request.method === "DELETE") {
      if (options.cancelBeforeDelete && !cancelled) return json({ error: { message: "Active turn", type: "conflict", code: "active_turn" } }, 409);
      return json({ id: "sess_test", deleted: true });
    }
    return json(session());
  };
  const harness = new ManagedAgentsHarness({ apiKey: "synthetic-test-key", fetcher });
  let executions = 0;
  const recordedTotal = tool({ name: "RecordedTotal", description: "Read synthetic evidence", parameters: z.object({ period: z.string() }).strict(), execute: async () => { executions += 1; return "42"; } });
  const input = { instructions: "Use recorded evidence.", tools: [recordedTotal], input: [user("Read the test total.")], preferences: DEFAULT_AGENTS_API_PREFERENCES, signal: AbortSignal.timeout(10_000) };
  return { harness, input, requests, executions: () => executions };
}

test("managed sessions use only configured functions, preserve the requested model, and exclude reasoning", async () => {
  const f = fixture({ pending: true });
  try {
    const result = await f.harness.run(f.input);
    assert.equal(result.text, "Recorded total: 42.");
    assert.equal(result.cachedInputTokens, 50);
    assert.equal(f.executions(), 1, "stale repeated required-action events do not execute twice");
    const create = f.requests[0]!.body!;
    assert.deepEqual(create.environment, { type: "none" });
    const agent = create.agent as Record<string, unknown>;
    assert.equal(agent.model, "gpt-5.6-luna");
    assert.deepEqual(agent.multi_agent, { enabled: false });
    assert.deepEqual((agent.tools as { name: string }[]).map((t) => t.name), ["RecordedTotal"]);
    assert.ok(!JSON.stringify(create).includes("synthetic-test-key"));
    const submitted = f.requests.find((r) => r.method === "POST" && r.path.endsWith("/events"))!.body!.events as Record<string, unknown>[];
    assert.equal(submitted[0]!.call_id, "call_test");
    assert.equal(submitted[0]!.turn_id, "turn_test");
    assert.equal(submitted[0]!.output, "42");
  } finally { await f.harness.close(); }
  assert.equal(f.requests.at(-1)?.method, "DELETE");
});

test("saved completed turns recover output emitted before subscription", async () => {
  const f = fixture({ completedBeforeStream: true, events: [] });
  try { assert.equal((await f.harness.run(f.input)).text, "Recorded total: 42."); }
  finally { await f.harness.close(); }
  assert.equal(f.requests.filter((r) => r.method === "POST" && r.path.endsWith("/sessions")).length, 1);
});

test("idle and a closed stream never masquerade as a completed turn", async () => {
  const f = fixture({ events: [{ type: "agent.session.idle", session: { id: "sess_test" } }] });
  try { await assert.rejects(f.harness.run(f.input), /before the analysis finished/u); }
  finally { await f.harness.close(); }
  assert.equal(f.requests.filter((r) => r.method === "POST" && r.path.endsWith("/sessions")).length, 1);
});

test("subagent completion cannot hide root-turn failure", async () => {
  const f = fixture({ events: [
    { type: "agent.session.turn.completed", session_id: "sess_test", turn: { id: "child", subagent_id: "child", status: "completed" } },
    { type: "agent.session.turn.failed", session_id: "sess_test", turn: { id: "turn_test", subagent_id: null, status: "failed" } },
  ] });
  try { await assert.rejects(f.harness.run(f.input), /analysis failed/u); }
  finally { await f.harness.close(); }
});

test("cleanup cancels active provider work before deleting the session", async () => {
  const f = fixture({ completedBeforeStream: true, cancelBeforeDelete: true });
  await f.harness.run(f.input);
  await f.harness.close();
  assert.equal(f.requests.filter((r) => r.method === "DELETE").length, 2);
  assert.ok(f.requests.some((r) => JSON.stringify(r.body).includes("agent.session.input.cancel")));
});

test("already-aborted work never creates a provider session", async () => {
  const f = fixture();
  await assert.rejects(f.harness.run({ ...f.input, signal: AbortSignal.abort() }));
  await f.harness.close();
  assert.equal(f.requests.length, 0);
});

test("a pending data-control approval is not reported as a provider outage", () => {
  const message = "The new Agents API is awaiting approval for US session storage. Your message has not been sent to OpenAI.";
  const result = describeChatFailure(message, { runtime: "newagent", phase: "start", httpStatus: 503 });
  assert.ok(result.startsWith(message.slice(0, -1)));
  assert.ok(!result.includes("not connected"));
});
