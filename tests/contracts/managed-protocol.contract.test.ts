import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { user } from "@openai/agents";
import { z } from "zod";
import { NativeManagedHarness } from "../../packages/albert-agents-api/src/native-harness.js";
import { createGovernedToolRegistry } from "../../packages/albert-agents-api/src/tools.js";
import { emptyManagedSessionState, MANAGED_SESSION_NAMESPACE } from "../../packages/albert-agents-api/src/session-state.js";
import { cleanupManagedSessions } from "../../packages/albert-agents-api/src/retention.js";
import type { AnalyticalHarness } from "../../packages/albert-omni/src/harness.js";

type RequestLog = { method: string; path: string; body: Record<string, unknown> | null };
function fixture(options: { invalidArguments?: boolean; failedTool?: boolean; disconnect?: boolean; incomplete?: boolean; rootFailed?: boolean; foreign?: boolean; deleteConflict?: boolean; checkpointFails?: boolean; toolName?: string } = {}) {
  const requests: RequestLog[] = [];
  let state = emptyManagedSessionState(), sessionNumber = 0, turnNumber = 0, executions = 0, cancellations = 0;
  let pending = true;
  let metadata: Record<string, string> = {};
  const toolName = options.toolName ?? "RecordedTotal";
  const scope = { tenantId: "01KZN20VTX2EWW1TQ2AA3MCPW6", actorId: "00000000-0000-4000-8000-000000000001", conversationId: "01M28X81ESKPQG2ZGQ1ABZTZM6", turnId: "01M28Y0BFHK4SBTVXG4FAZ94Z3" };
  const sessionId = () => `sess_${sessionNumber}`;
  const turn = (number = turnNumber) => ({ id: `turn_${number}`, session_id: sessionId(), subagent_id: null, status: options.incomplete ? "in_progress" : options.rootFailed ? "failed" : "completed", usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 50 }, output_tokens_details: { reasoning_tokens: 10 } } });
  const session = () => ({ id: sessionId(), agent: { model: "gpt-5.6-sol" }, last_active_at: Date.now() / 1000, metadata: options.foreign ? { surface: "foreign" } : metadata, status: pending ? "requires_action" : "idle", required_actions: pending ? [{ type: "function_call", name: toolName, arguments: { period: options.invalidArguments ? 7 : "August" }, turn_id: `turn_${turnNumber}`, call_id: "call_total" }] : [] });
  const events = (created: boolean, number = turnNumber) => [
    ...(created ? [{ type: "agent.session.created", session: session() }] : []),
    { type: "agent.session.turn.created", session_id: sessionId(), turn: { ...turn(number), status: "in_progress" } },
    ...(created ? [{ type: "agent.session.requires_action", session_id: sessionId() }, { type: "agent.session.requires_action", session_id: sessionId() }] : []),
    { type: "agent.session.idle", session: session() },
    { type: "agent.session.turn.completed", session_id: sessionId(), turn: { ...turn(number), subagent_id: "child", id: "child_turn", status: "completed" } },
    ...(!options.incomplete && !(created && options.disconnect) ? [{ type: options.rootFailed ? "agent.session.turn.failed" : "agent.session.turn.completed", session_id: sessionId(), turn: turn(number) }] : []),
  ];
  const sse = (data: unknown[]) => new Response(data.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const fetcher: typeof fetch = async (raw, init) => {
    const request = new Request(raw, init), path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() as Record<string, unknown> : null;
    requests.push({ method: request.method, path, body });
    assert.equal(request.headers.get("openai-beta"), "agents=v1");
    if (path.endsWith("/sessions") && request.method === "POST") {
      sessionNumber += 1; turnNumber += 1; pending = true; metadata = body!.metadata as Record<string, string>;
      return sse(events(true));
    }
    if (path.endsWith("/events") && request.method === "POST") {
      const input = (body!.events as { type: string }[])[0]!;
      if (input.type === "agent.session.input.cancel") { cancellations += 1; pending = false; }
      else if (input.type === "agent.session.input.message") { turnNumber += 1; pending = false; }
      else pending = false;
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/events")) return sse(options.disconnect || options.incomplete ? [] : events(false, turnNumber + 1));
    if (path.endsWith("/turns")) return Response.json({ data: [turn()], has_more: false });
    if (path.endsWith("/items")) return Response.json({ data: [
      { type: "reasoning", id: "private", summary: [{ text: "PRIVATE_REASONING" }] },
      { type: "message", id: "draft", role: "assistant", phase: "commentary", turn_id: `turn_${turnNumber}`, content: [{ type: "output_text", text: "DRAFT" }] },
      { type: "message", id: "final", role: "assistant", phase: "final_answer", turn_id: `turn_${turnNumber}`, content: [{ type: "output_text", text: JSON.stringify({ answer: "Recorded evidence" }) }] },
    ], has_more: false });
    if (request.method === "DELETE") {
      if (options.deleteConflict && !cancellations) return Response.json({ error: { message: "Active turn", type: "conflict" } }, { status: 409 });
      return Response.json({ id: sessionId(), deleted: true });
    }
    return Response.json(session());
  };
  const registry = createGovernedToolRegistry();
  registry.define({ name: toolName, description: "Read recorded evidence", parameters: z.object({ period: z.string() }).strict(), strict: true,
    execute: async () => { executions += 1; return JSON.stringify(options.failedTool ? { ok: false, error: "The source is temporarily unavailable." } : { value: 42 }); } });
  const failures: string[] = [];
  const input: Parameters<AnalyticalHarness["run"]>[0] = { instructions: "Use recorded evidence.", tools: registry.get([toolName]), input: [user("Read the total.")], preferences: { model: "gpt-5.6-sol", reasoningEffort: "medium", fastMode: false }, signal: AbortSignal.timeout(10_000),
    native: { question: "Read the total.", context: "Fixture", resultsContext: "", catalogueDigest: "catalogue", getInspectedTopics: () => ["sales"], resetInspectedTopics: () => {}, ensureResults: async () => {}, finalSchema: { type: "object" }, validateFinal: async (value) => (value as { answer?: string }).answer === "Recorded evidence" ? [] : ["Wrong answer"], recordToolFailure: async (_name, message) => { failures.push(message); } },
  };
  const make = () => new NativeManagedHarness({ apiKey: "synthetic-not-a-credential", scope, state, fetcher, saveState: async (next) => { if (options.checkpointFails) throw new Error("Store offline"); state = next; } });
  return { make, input, requests, failures, scope, state: () => state, dirty: () => { state.idleConfirmed = false; }, executions: () => executions };
}

test("native sessions persist across HTTP harness instances and filter private output", async () => {
  const f = fixture(), first = f.make();
  assert.equal((await first.run(f.input)).text, '{"answer":"Recorded evidence"}');
  assert.equal(first.metrics.cachedInputTokens, 50);
  assert.equal(f.executions(), 1);
  assert.equal(f.state().idleConfirmed, true);
  await first.close();
  assert.equal(f.requests.filter((r) => r.method === "DELETE").length, 0);
  const second = f.make();
  await second.run(f.input);
  assert.equal(second.metrics.sessionReused, true);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/sessions") && r.method === "POST").length, 1);
  const create = f.requests[0]!.body!, agent = create.agent as Record<string, unknown>;
  assert.deepEqual(create.environment, { type: "none" });
  assert.equal(create.stream, true);
  assert.deepEqual(agent.multi_agent, { enabled: false });
  assert.deepEqual(agent.text, { format: { type: "json_schema", schema: { type: "object" } }, verbosity: "medium" });
  assert.ok(!JSON.stringify(f.requests).includes("synthetic-not-a-credential"));
});

test("native validation failures return success:false and precise field feedback", async () => {
  const f = fixture({ invalidArguments: true });
  await f.make().run(f.input);
  assert.equal(f.executions(), 0);
  const result = f.requests.flatMap((r) => r.body?.events as Record<string, unknown>[] ?? []).find((event) => event.type === "agent.session.input.tool_result")!;
  assert.equal(result.success, false);
  assert.match(String(result.error), /period/u);
  assert.equal(result.output, undefined);
  assert.equal(f.failures.length, 1);
});

test("source failures remain failures at the provider protocol boundary", async () => {
  const f = fixture({ failedTool: true });
  const harness = f.make(); await harness.run(f.input);
  const result = f.requests.flatMap((r) => r.body?.events as Record<string, unknown>[] ?? []).find((event) => event.type === "agent.session.input.tool_result")!;
  assert.equal(result.success, false); assert.match(String(result.error), /temporarily unavailable/u);
  assert.equal(harness.metrics.toolFailures, 1);
});

test("lost completion events recover from persisted root turns without repeating tools", async () => {
  const f = fixture({ disconnect: true });
  await f.make().run(f.input);
  assert.equal(f.executions(), 1);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/sessions") && r.method === "POST").length, 1);
  assert.ok(f.requests.some((r) => r.path.endsWith("/turns")));
});

test("idle and child completion cannot turn unfinished or failed root work into success", async () => {
  for (const options of [{ incomplete: true }, { rootFailed: true }]) {
    const f = fixture(options);
    await assert.rejects(f.make().run(f.input), /before completion|could not finish/u);
    assert.equal(f.state().idleConfirmed, false);
    assert.equal(f.requests.filter((r) => r.path.endsWith("/items")).length, 0);
  }
});

test("foreign session metadata forbids result access, cancellation and deletion", async () => {
  const f = fixture({ foreign: true }), harness = f.make();
  await assert.rejects(harness.run(f.input), /does not belong/u);
  await harness.close();
  assert.equal(f.requests.length, 1);
});

test("dirty sessions rotate with cancellation retry before new work starts", async () => {
  const f = fixture({ deleteConflict: true });
  await f.make().run(f.input); f.dirty();
  const harness = f.make(); await harness.run(f.input);
  assert.equal(harness.metrics.sessionReused, false);
  assert.equal(f.requests.filter((r) => r.method === "DELETE").length, 2);
  const posts = f.requests.filter((r) => r.path.endsWith("/sessions") && r.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(f.state().sessionId, "sess_2");
});

test("failed checkpoints cancel and delete newly created unowned state", async () => {
  const f = fixture({ checkpointFails: true }), harness = f.make();
  await assert.rejects(harness.run(f.input), /could not be saved safely/u);
  await harness.close();
  assert.ok(f.requests.some((r) => JSON.stringify(r.body).includes("input.cancel")));
  assert.equal(f.requests.at(-1)?.method, "DELETE");
  assert.equal(f.executions(), 0);
});

test("already-aborted native work never reaches the provider", async () => {
  const f = fixture();
  await assert.rejects(f.make().run({ ...f.input, signal: AbortSignal.abort() }));
  assert.equal(f.requests.length, 0);
});

test("synthesis prevents a new data read while preserving a validated answer from saved evidence", async () => {
  const f = fixture({ toolName: "GenerateSemanticQuery" }), harness = f.make();
  let notifications = 0;
  const result = await harness.run({ ...f.input, native: { ...f.input.native!, deadlineAt: Date.now() - 1,
    getProgress: () => ({ results: 1, queries: 1 }), onSynthesis: async () => { notifications++; },
  } });
  assert.equal(f.executions(), 0);
  assert.equal(notifications, 1);
  assert.equal(harness.metrics.synthesisStarted, true);
  assert.equal(result.text, '{"answer":"Recorded evidence"}');
  const submitted = f.requests.flatMap((r) => r.body?.events as Record<string, unknown>[] ?? []).find((e) => e.type === "agent.session.input.tool_result")!;
  assert.equal(submitted.success, false);
  assert.match(String(submitted.error), /No further source queries/u);
});

test("synthesis still allows an exact calculation and tells the model to finish", async () => {
  const f = fixture({ toolName: "CalculateValues" }), harness = f.make();
  await harness.run({ ...f.input, native: { ...f.input.native!, deadlineAt: Date.now() - 1, getProgress: () => ({ results: 1, queries: 1 }) } });
  assert.equal(f.executions(), 1);
  const submitted = f.requests.flatMap((r) => r.body?.events as Record<string, unknown>[] ?? []).find((e) => e.type === "agent.session.input.tool_result")!;
  const output = JSON.parse(String(submitted.output));
  assert.equal(output.value, 42);
  assert.match(output.executionGuidance, /Finish this response now/u);
});

test("dashboard construction retains its own investigation lifecycle", async () => {
  const f = fixture({ toolName: "ComposeDashboard" }), harness = f.make();
  await harness.run({ ...f.input, native: { ...f.input.native!, deadlineAt: Date.now() - 1, getProgress: () => ({ results: 1, queries: 1 }) } });
  assert.equal(f.executions(), 1);
  assert.equal(harness.metrics.synthesisStarted, false);
});

test("a deadline abort is classified explicitly and cannot start another data operation", async () => {
  const f = fixture(), harness = f.make(), controller = new AbortController();
  await assert.rejects(harness.run({ ...f.input, signal: controller.signal, native: { ...f.input.native!, ensureResults: async () => { controller.abort(new Error("The analysis timed out before finishing.")); } } }), (error: unknown) => {
    assert.equal((error as { code: string }).code, "analysis_timeout");
    assert.match((error as Error).message, /Evidence and checks/u);
    return true;
  });
  assert.equal(f.executions(), 0);
  assert.equal(f.state().idleConfirmed, false);
  assert.ok(f.requests.some((r) => JSON.stringify(r.body).includes("input.cancel")));
});

test("retention rechecks activity, prefetches cursors and retries async cancellation", async () => {
  const now = Date.now(), requests: string[] = [];
  const expired = { id: "expired", metadata: { surface: MANAGED_SESSION_NAMESPACE, scope: "a".repeat(64) }, last_active_at: (now - 90_000_000) / 1000, status: "in_progress" };
  let deleted = 0;
  const fetcher: typeof fetch = async (raw, init) => {
    const request = new Request(raw, init), url = new URL(request.url); requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method === "DELETE") { if (deleted++ === 0) return Response.json({ error: { message: "Cancelling", type: "conflict" } }, { status: 409 }); return Response.json({ deleted: true }); }
    if (request.method === "POST") return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/expired")) return Response.json(expired);
    if (url.pathname.endsWith("/revived")) return Response.json({ ...expired, id: "revived", last_active_at: now / 1000 });
    return Response.json(url.searchParams.has("after") ? { data: [], has_more: false } : { data: [expired, { ...expired, id: "revived" }], has_more: true, first_id: "expired", last_id: "revived" });
  };
  const result = await cleanupManagedSessions(new OpenAI({ apiKey: "synthetic", fetch: fetcher, maxRetries: 0 }), { now, signal: AbortSignal.timeout(10_000) });
  assert.deepEqual(result, { scanned: 2, deleted: 1, failed: 0 });
  assert.ok(requests.findIndex((r) => r.includes("after=")) < requests.findIndex((r) => r.startsWith("DELETE")));
  assert.equal(requests.filter((r) => r.startsWith("DELETE")).length, 2);
  assert.ok(!requests.some((r) => r.startsWith("DELETE") && r.includes("revived")));
});
