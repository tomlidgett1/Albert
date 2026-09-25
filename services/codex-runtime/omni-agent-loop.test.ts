import assert from "node:assert/strict";
import test from "node:test";
import { Agent, Runner, RunContext } from "@openai/agents";
import { ulid } from "ulid";
import { runOmniSemanticTurn } from "../../packages/albert-omni/src/runtime.js";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.js";
import { FIXTURE_SIGNING_SECRET, startFrozenCube } from "../../scripts/albert-eval/omni-frozen-fixture.js";
import type { OmniServiceTurn } from "../../packages/albert-omni/src/contracts.js";
import type { OmniTraceEventInput } from "../../packages/albert-omni/src/runtime.js";
import { CubeBearerClient } from "../../packages/albert-codex/src/cube-bearer-client.js";

async function invoke(agent: Agent, name: string, args: unknown) {
  const candidate = agent.tools.find((tool) => tool.name === name);
  assert.ok(candidate && candidate.type === "function");
  return candidate.invoke(new RunContext(), JSON.stringify(args));
}

async function fixture(run: (turn: OmniServiceTurn, url: string) => Promise<void>) {
  const cube = await startFrozenCube();
  const tenantId = ulid(), conversationId = ulid(), turnId = ulid();
  cube.register(turnId, tenantId);
  const turn: OmniServiceTurn = { protocolVersion: 1, requestId: ulid(), tenantId, actorId: "00000000-0000-4000-8000-000000000001", role: "owner", conversationId, turnId, message: "What were gross takings in August 2026?", priorConversation: [], activeConnectors: ["lightspeed-r"], connectorFreshness: [], model: "gpt-5.6-luna", effort: "max", fastMode: false, cubeBearer: signCubeJwt({ secret: FIXTURE_SIGNING_SECRET, expiresInSeconds: 900, securityContext: { tenant_id: tenantId, conversation_id: conversationId, turn_id: turnId, role: "owner", specialist_agent_id: "general", specialist_agent_version: 1 } }) };
  try { await run(turn, cube.url); } finally { await cube.close(); }
}

test("an accepted composition is delivered when the model has no redundant final postscript", async (context) => {
  context.mock.method(Runner.prototype, "run", async (agent: Agent) => {
    await invoke(agent, "SearchSemanticModel", { topicName: "sales_analytics", searchPattern: null });
    const queried = JSON.parse(String(await invoke(agent, "GenerateSemanticQuery", { name: "August sales", topic: "sales_analytics", query: { measures: ["sales_analytics.gross_takings"], dimensions: null, segments: null, timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: null, dateRange: "2026-08-01 to 2026-08-31", compareDateRange: null }], filters: null, order: null, limit: null } })));
    assert.equal(queried.ok, true);
    const composed = JSON.parse(String(await invoke(agent, "ComposeAnswer", { outcome: "answer", markdown: "Gross takings were {{sales}}.", values: [{ id: "sales", resultId: queried.resultId, rowIndex: 0, columnKey: "sales_analytics_gross_takings", format: "auto", decimals: null }], tables: [], citedResultIds: [queried.resultId], limitations: [], followUps: [] })));
    assert.equal(composed.ok, true);
    return { async *[Symbol.asyncIterator]() {}, completed: Promise.resolve(), rawResponses: [], history: [], finalOutput: "" };
  });
  await fixture(async (turn, url) => {
    const events: OmniTraceEventInput[] = [];
    const result = await runOmniSemanticTurn({ turn, cubeApiUrl: url, openai: { apiKey: "synthetic-fixture", baseUrl: "https://provider.example.test" }, emit: (event) => { events.push(event); } });
    assert.equal(result.answerState, "Verified");
    const answer = events.find((event) => event.type === "answer");
    assert.equal(answer?.text, "Gross takings were $600.00.");
    assert.equal(answer?.claims?.length, 1);
  });
});

test("an accepted composition ends the run without another model request", async (context) => {
  // The hand-over the model writes after an accepted ComposeAnswer is never
  // shown, yet it cost one full model request (with its thinking) per turn.
  context.mock.method(Runner.prototype, "run", async (agent: Agent) => {
    const behaviour = agent.toolUseBehavior;
    assert.equal(typeof behaviour, "function");
    const finalises = async (name: string, output: string) => {
      const candidate = agent.tools.find((tool) => tool.name === name);
      const outcome = await (behaviour as (context: RunContext, results: unknown[]) => Promise<{ isFinalOutput: boolean }> | { isFinalOutput: boolean })(new RunContext(), [{ type: "function_output", tool: candidate, output }]);
      return outcome.isFinalOutput;
    };
    await invoke(agent, "SearchSemanticModel", { topicName: "sales_analytics", searchPattern: null });
    const queried = JSON.parse(String(await invoke(agent, "GenerateSemanticQuery", { name: "August sales", topic: "sales_analytics", query: { measures: ["sales_analytics.gross_takings"], dimensions: null, segments: null, timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: null, dateRange: "2026-08-01 to 2026-08-31", compareDateRange: null }], filters: null, order: null, limit: null } })));
    const rejected = String(await invoke(agent, "ComposeAnswer", { outcome: "answer", markdown: "Gross takings were $5,000.", values: [], tables: [], citedResultIds: [queried.resultId], limitations: [], followUps: [] }));
    assert.equal(JSON.parse(rejected).ok, false);
    assert.equal(await finalises("ComposeAnswer", rejected), false);
    const accepted = String(await invoke(agent, "ComposeAnswer", { outcome: "answer", markdown: "Gross takings were {{sales}}.", values: [{ id: "sales", resultId: queried.resultId, rowIndex: 0, columnKey: "sales_analytics_gross_takings", format: "auto", decimals: null }], tables: [], citedResultIds: [queried.resultId], limitations: [], followUps: [] }));
    assert.equal(JSON.parse(accepted).ok, true);
    assert.equal(await finalises("GenerateSemanticQuery", accepted), false);
    assert.equal(await finalises("ComposeAnswer", accepted), true);
    return { async *[Symbol.asyncIterator]() {}, completed: Promise.resolve(), rawResponses: [], history: [], finalOutput: "" };
  });
  await fixture(async (turn, url) => {
    const events: OmniTraceEventInput[] = [];
    const result = await runOmniSemanticTurn({ turn, cubeApiUrl: url, openai: { apiKey: "synthetic-fixture", baseUrl: "https://provider.example.test" }, emit: (event) => { events.push(event); } });
    assert.equal(result.answerState, "Verified");
    assert.equal(events.find((event) => event.type === "answer")?.text, "Gross takings were $600.00.");
  });
});

test("a turn out of exploration time composes from the evidence it gathered instead of discarding it", async (context) => {
  // Turns that ran twenty queries used to hit the hard deadline mid-step and
  // throw everything away. Exploration now stops before the deadline and the
  // answer nudge composes from the results already held.
  const runs: { maxTurns?: number; userText: string; effort?: string }[] = [];
  let queried: { resultId: string } | undefined;
  context.mock.method(Runner.prototype, "run", async (agent: Agent, input: unknown, runOptions: { signal?: AbortSignal; maxTurns?: number }) => {
    const items = input as { role?: string; content?: unknown }[];
    const last = items.at(-1);
    runs.push({ maxTurns: runOptions.maxTurns, userText: typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? ""), effort: (agent.modelSettings.reasoning as { effort?: string } | undefined)?.effort });
    if (runs.length === 1) {
      await invoke(agent, "SearchSemanticModel", { topicName: "sales_analytics", searchPattern: null });
      queried = JSON.parse(String(await invoke(agent, "GenerateSemanticQuery", { name: "August sales", topic: "sales_analytics", query: { measures: ["sales_analytics.gross_takings"], dimensions: null, segments: null, timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: null, dateRange: "2026-08-01 to 2026-08-31", compareDateRange: null }], filters: null, order: null, limit: null } })));
      // Still exploring when the time runs out.
      await new Promise((resolve) => runOptions.signal?.addEventListener("abort", resolve, { once: true }));
      const late = JSON.parse(String(await invoke(agent, "GenerateSemanticQuery", { name: "July sales", topic: "sales_analytics", query: { measures: ["sales_analytics.gross_takings"], dimensions: null, segments: null, timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: null, dateRange: "2026-07-01 to 2026-07-31", compareDateRange: null }], filters: null, order: null, limit: null } })));
      assert.equal(late.error, "time_up");
      throw Object.assign(new Error("Request was aborted."), { name: "Error" });
    }
    const composed = JSON.parse(String(await invoke(agent, "ComposeAnswer", { outcome: "answer", markdown: "Gross takings were {{sales}}.", values: [{ id: "sales", resultId: queried!.resultId, rowIndex: 0, columnKey: "sales_analytics_gross_takings", format: "auto", decimals: null }], tables: [], citedResultIds: [queried!.resultId], limitations: ["July was not checked in time."], followUps: [] })));
    assert.equal(composed.ok, true);
    return { async *[Symbol.asyncIterator]() {}, completed: Promise.resolve(), rawResponses: [], history: [], finalOutput: "" };
  });
  await fixture(async (turn, url) => {
    const events: OmniTraceEventInput[] = [];
    const result = await runOmniSemanticTurn({ turn, cubeApiUrl: url, deadlineAt: Date.now() + 4_000, openai: { apiKey: "synthetic-fixture", baseUrl: "https://provider.example.test" }, emit: (event) => { events.push(event); } });
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.maxTurns, 45, "the exploring run leaves requests for the answer");
    assert.match(runs[1]!.userText, /no new queries can run/u);
    assert.deepEqual(runs.map((run) => run.effort), ["max", "low"], "the answer against the clock is written at low effort");
    assert.ok(events.some((event) => event.type === "progress" && event.label === "Writing the answer from the checks completed so far"));
    assert.equal(result.answerState, "Qualified");
    assert.match(events.find((event) => event.type === "answer")?.text ?? "", /^Gross takings were \$600\.00\./u);
    // A query cut short by the end of exploration is not reported as a failed query.
    assert.equal(events.some((event) => event.type === "progress" && /^Query failed/u.test(event.label ?? "")), false);
  });
});

test("a write-up still unfinished near the deadline delivers the checked results, never a timeout", async (context) => {
  // Production 2026-09-24: GPT 6 Luna at Max gathered 35 results, the answer
  // nudge ran at Max with no time of its own, and the hard deadline threw all
  // of it away ("The analysis ran out of time before finishing."). The SDK
  // ends an aborted streamed run quietly, so each run here returns empty.
  const efforts: (string | undefined)[] = [];
  context.mock.method(Runner.prototype, "run", async (agent: Agent, _input: unknown, runOptions: { signal?: AbortSignal }) => {
    efforts.push((agent.modelSettings.reasoning as { effort?: string } | undefined)?.effort);
    if (efforts.length === 1) {
      await invoke(agent, "SearchSemanticModel", { topicName: "sales_analytics", searchPattern: null });
      const queried = JSON.parse(String(await invoke(agent, "GenerateSemanticQuery", { name: "August sales by product", topic: "sales_analytics", query: { measures: ["sales_analytics.gross_takings", "sales_analytics.gross_profit"], dimensions: ["sales_analytics.product_name"], segments: null, timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: null, dateRange: "2026-08-01 to 2026-08-31", compareDateRange: null }], filters: null, order: null, limit: null } })));
      assert.equal(queried.ok, true);
    }
    // Still thinking when its time runs out.
    await new Promise((resolve) => runOptions.signal?.addEventListener("abort", resolve, { once: true }));
    return { async *[Symbol.asyncIterator]() {}, completed: Promise.resolve(), rawResponses: [], history: [], finalOutput: "" };
  });
  await fixture(async (turn, url) => {
    const events: OmniTraceEventInput[] = [];
    const deadlineAt = Date.now() + 6_000;
    const result = await runOmniSemanticTurn({ turn, cubeApiUrl: url, deadlineAt, openai: { apiKey: "synthetic-fixture", baseUrl: "https://provider.example.test" }, emit: (event) => { events.push(event); } });
    assert.ok(Date.now() < deadlineAt, "the answer lands before the hard deadline");
    assert.deepEqual(efforts, ["max", "low"], "the write-up under time pressure runs at low effort");
    assert.ok(events.some((event) => event.type === "progress" && event.label === "Writing the answer from the checks completed so far"));
    const answer = events.find((event) => event.type === "answer");
    assert.match(answer?.text ?? "", /^I ran out of time before finishing this analysis/u);
    assert.match(answer?.text ?? "", /\| Workshop Service \| \$300\.00 \| \$90\.00 \|/u);
    assert.ok((answer?.followUps ?? []).length > 0, "the owner can ask to finish it");
    assert.equal(result.answerState, "Qualified");
    assert.equal(events.some((event) => event.type === "error"), false);
  });
});

test("a turn the owner cancels stays cancelled rather than delivering checked results", async (context) => {
  const controller = new AbortController();
  context.mock.method(Runner.prototype, "run", async (agent: Agent, _input: unknown, runOptions: { signal?: AbortSignal }) => {
    await invoke(agent, "SearchSemanticModel", { topicName: "sales_analytics", searchPattern: null });
    await invoke(agent, "GenerateSemanticQuery", { name: "August sales", topic: "sales_analytics", query: { measures: ["sales_analytics.gross_takings"], dimensions: null, segments: null, timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: null, dateRange: "2026-08-01 to 2026-08-31", compareDateRange: null }], filters: null, order: null, limit: null } });
    controller.abort(new Error("The analysis was cancelled."));
    await new Promise((resolve) => runOptions.signal?.aborted ? resolve(undefined) : runOptions.signal?.addEventListener("abort", resolve, { once: true }));
    return { async *[Symbol.asyncIterator]() {}, completed: Promise.resolve(), rawResponses: [], history: [], finalOutput: "" };
  });
  await fixture(async (turn, url) => {
    const events: OmniTraceEventInput[] = [];
    await assert.rejects(runOmniSemanticTurn({ turn, cubeApiUrl: url, signal: controller.signal, openai: { apiKey: "synthetic-fixture", baseUrl: "https://provider.example.test" }, emit: (event) => { events.push(event); } }), /cancelled/u);
    assert.equal(events.some((event) => event.type === "answer"), false);
  });
});

test("the model receives each result compactly: columns once, rows as arrays, lean semantics", async (context) => {
  // Every model step re-sends every earlier result. Keyed rows repeated each
  // column key on every row, and the semantics block carried digests and
  // serialized windows the model never uses.
  let payload: Record<string, unknown> | undefined;
  context.mock.method(Runner.prototype, "run", async (agent: Agent) => {
    await invoke(agent, "SearchSemanticModel", { topicName: "sales_analytics", searchPattern: null });
    payload = JSON.parse(String(await invoke(agent, "GenerateSemanticQuery", { name: "August sales", topic: "sales_analytics", query: { measures: ["sales_analytics.gross_takings"], dimensions: null, segments: null, timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: null, dateRange: "2026-08-01 to 2026-08-31", compareDateRange: null }], filters: null, order: null, limit: null } })));
    const composed = JSON.parse(String(await invoke(agent, "ComposeAnswer", { outcome: "answer", markdown: "Gross takings were {{sales}}.", values: [{ id: "sales", resultId: payload!.resultId, rowIndex: 0, columnKey: "sales_analytics_gross_takings", format: "auto", decimals: null }], tables: [], citedResultIds: [payload!.resultId], limitations: [], followUps: [] })));
    assert.equal(composed.ok, true);
    return { async *[Symbol.asyncIterator]() {}, completed: Promise.resolve(), rawResponses: [], history: [], finalOutput: "" };
  });
  await fixture(async (turn, url) => {
    const events: OmniTraceEventInput[] = [];
    await runOmniSemanticTurn({ turn, cubeApiUrl: url, openai: { apiKey: "synthetic-fixture", baseUrl: "https://provider.example.test" }, emit: (event) => { events.push(event); } });
    const columns = payload!.columns as { key: string }[];
    const rows = payload!.rows as unknown[][];
    assert.ok(Array.isArray(rows[0]), "a row is an array in column order");
    assert.equal(rows[0]!.length, columns.length);
    assert.match(String(payload!.rowFormat), /zero-based position/u);
    assert.deepEqual(Object.keys(payload!.semantics as object).sort(), ["completeness", "rowLimit"]);
    // The trace and the answer still carry the full governed rows.
    assert.equal(events.find((event) => event.type === "answer")?.text, "Gross takings were $600.00.");
  });
});

test("a task that only says to write the answer is settled by the answer, and an open check adds no sentence", async (context) => {
  // The model cannot tick "Compose the answer" before composing and rarely
  // comes back to tick it after; that alone used to cost a Verified answer its
  // state and append "Some planned checks remain unfinished." to the reply.
  for (const [openTask, expectedState, settled] of [["Compose the answer", "Verified", true], ["Check August refunds", "Qualified", false]] as const) {
    context.mock.method(Runner.prototype, "run", async (agent: Agent) => {
      await invoke(agent, "ManageTaskList", { tasks: [{ label: "Query August takings", completed: false }, { label: openTask, completed: false }] });
      await invoke(agent, "SearchSemanticModel", { topicName: "sales_analytics", searchPattern: null });
      const queried = JSON.parse(String(await invoke(agent, "GenerateSemanticQuery", { name: "August sales", topic: "sales_analytics", query: { measures: ["sales_analytics.gross_takings"], dimensions: null, segments: null, timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: null, dateRange: "2026-08-01 to 2026-08-31", compareDateRange: null }], filters: null, order: null, limit: null } })));
      await invoke(agent, "ManageTaskList", { tasks: [{ label: "Query August takings", completed: true }, { label: openTask, completed: false }] });
      const composed = JSON.parse(String(await invoke(agent, "ComposeAnswer", { outcome: "answer", markdown: "Gross takings were {{sales}}.", values: [{ id: "sales", resultId: queried.resultId, rowIndex: 0, columnKey: "sales_analytics_gross_takings", format: "auto", decimals: null }], tables: [], citedResultIds: [queried.resultId], limitations: [], followUps: [] })));
      assert.equal(composed.ok, true, JSON.stringify(composed));
      return { async *[Symbol.asyncIterator]() {}, completed: Promise.resolve(), rawResponses: [], history: [], finalOutput: "" };
    });
    await fixture(async (turn, url) => {
      const events: OmniTraceEventInput[] = [];
      const result = await runOmniSemanticTurn({ turn, cubeApiUrl: url, openai: { apiKey: "synthetic-fixture", baseUrl: "https://provider.example.test" }, emit: (event) => { events.push(event); } });
      assert.equal(result.answerState, expectedState, openTask);
      const answer = events.find((event) => event.type === "answer");
      assert.equal(answer?.text, "Gross takings were $600.00.", openTask);
      const checklist = events.filter((event) => event.type === "tasks").at(-1);
      assert.equal(checklist?.type === "tasks" && checklist.items.every((item) => item.completed), settled, openTask);
    });
  }
});

test("free-form model assertions never become a verified analytical answer", async (context) => {
  context.mock.method(Runner.prototype, "run", async () => ({ async *[Symbol.asyncIterator]() {}, completed: Promise.resolve(), rawResponses: [], history: [], finalOutput: "Sales were $999,999." }));
  await fixture(async (turn, url) => {
    const events: OmniTraceEventInput[] = [];
    await assert.rejects(runOmniSemanticTurn({ turn, cubeApiUrl: url, openai: { apiKey: "synthetic-fixture", baseUrl: "https://provider.example.test" }, emit: (event) => { events.push(event); } }), /without a validated final answer/u);
    assert.equal(events.some((event) => event.type === "answer"), false);
  });
});

test("expired queued turns and already-cancelled work never start a model run", async (context) => {
  const run = context.mock.method(Runner.prototype, "run", async () => { throw new Error("The model must not run."); });
  await fixture(async (turn, url) => {
    const options = { turn, cubeApiUrl: url, emit: () => {} };
    await assert.rejects(runOmniSemanticTurn({ ...options, deadlineAt: Date.now() - 1 }), /timed out/u);
    await assert.rejects(runOmniSemanticTurn({ ...options, signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/u);
    assert.equal(run.mock.callCount(), 0);
  });
});

test("field-value lookup cannot bypass the hidden-member boundary", async (context) => {
  const fetchCatalogue = CubeBearerClient.prototype.fetchCatalogue;
  context.mock.method(CubeBearerClient.prototype, "fetchCatalogue", async function (this: CubeBearerClient, signal?: AbortSignal) {
    const catalogue = await fetchCatalogue.call(this, signal);
    return { ...catalogue, views: catalogue.views.map((view) => view.name === "sales_analytics" ? { ...view, members: [...view.members, { name: "sales_analytics.hidden_probe", kind: "dimension", type: "string", title: "Hidden", shortTitle: "Hidden", aiHidden: true }] } : view) };
  });
  const load = context.mock.method(CubeBearerClient.prototype, "loadQuery", async () => { throw new Error("Hidden data must not be requested."); });
  context.mock.method(Runner.prototype, "run", async (agent: Agent) => {
    const result = JSON.parse(String(await invoke(agent, "FetchFieldValues", { field: "sales_analytics.hidden_probe", matching: null, limit: null })));
    assert.equal(result.ok, false);
    throw new Error("Hidden-field probe completed.");
  });
  await fixture(async (turn, url) => {
    await assert.rejects(runOmniSemanticTurn({ turn, cubeApiUrl: url, openai: { apiKey: "synthetic-fixture", baseUrl: "https://provider.example.test" }, emit: () => {} }), /Hidden-field probe completed/u);
    assert.equal(load.mock.callCount(), 0);
  });
});

test("a cut-short value list tells the model to filter a product family with contains", async (context) => {
  // "trace" listed 25 Trace 10s alphabetically; the turn filtered to Trace 10
  // and missed the Trace 20 that was the last Trace sold.
  const fetchCatalogue = CubeBearerClient.prototype.fetchCatalogue;
  context.mock.method(CubeBearerClient.prototype, "fetchCatalogue", async function (this: CubeBearerClient, signal?: AbortSignal) {
    const catalogue = await fetchCatalogue.call(this, signal);
    return { ...catalogue, views: catalogue.views.map((view) => view.name === "sales_analytics" ? { ...view, members: [...view.members, { name: "sales_analytics.item_probe", kind: "dimension", type: "string", title: "Item", shortTitle: "Item" }] } : view) };
  });
  let listed = 25;
  context.mock.method(CubeBearerClient.prototype, "loadQuery", async () => ({ result: { ok: true, rows: Array.from({ length: listed }, (_, index) => ({ "sales_analytics.item_probe": `22 - Trace 10 variant ${index}` })), executionMs: 1 } }));
  const lookups: Array<{ ok: boolean; truncated: boolean; guidance?: string }> = [];
  context.mock.method(Runner.prototype, "run", async (agent: Agent) => {
    lookups.push(JSON.parse(String(await invoke(agent, "FetchFieldValues", { field: "sales_analytics.item_probe", matching: "trace", limit: null }))));
    listed = 3;
    lookups.push(JSON.parse(String(await invoke(agent, "FetchFieldValues", { field: "sales_analytics.item_probe", matching: "trace", limit: null }))));
    throw new Error("Value lookups completed.");
  });
  await fixture(async (turn, url) => {
    await assert.rejects(runOmniSemanticTurn({ turn, cubeApiUrl: url, openai: { apiKey: "synthetic-fixture", baseUrl: "https://provider.example.test" }, emit: () => {} }), /Value lookups completed/u);
  });
  const [cut, whole] = lookups;
  assert.equal(cut?.truncated, true);
  assert.match(cut?.guidance ?? "", /filter with contains "trace" rather than equals on these values/u);
  assert.equal(whole?.truncated, false);
  assert.equal(whole?.guidance, undefined);
});

test("an injected driver receives the governed tools, is nudged to compose, and stamps its harness on the result", async (context) => {
  const run = context.mock.method(Runner.prototype, "run", async () => { throw new Error("The in-process runner must not run when a driver is injected."); });
  const seen: { instructions: string[]; toolNames: string[]; continuations: string[]; narrated: string[] } = { instructions: [], toolNames: [], continuations: [], narrated: [] };
  const driver = (input: import("../../packages/albert-omni/src/driver.js").OmniAgentDriverInput) => {
    seen.instructions.push(input.instructions);
    seen.toolNames = input.tools.map((tool) => tool.name);
    let runs = 0;
    const call = async (name: string, args: unknown) => {
      const candidate = input.tools.find((tool) => tool.name === name);
      assert.ok(candidate && candidate.type === "function");
      return String(await candidate.invoke(new RunContext(), JSON.stringify(args)));
    };
    return {
      run: async (continuation?: { assistantText: string; userText: string }) => {
        runs += 1;
        if (continuation) seen.continuations.push(continuation.userText);
        if (runs === 1) {
          await input.onNarrative("Looking at sales first:");
          return "Sales were fine.";
        }
        await call("SearchSemanticModel", { topicName: "sales_analytics", searchPattern: null });
        const queried = JSON.parse(await call("GenerateSemanticQuery", { name: "August sales", topic: "sales_analytics", query: { measures: ["sales_analytics.gross_takings"], dimensions: null, segments: null, timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: null, dateRange: "2026-08-01 to 2026-08-31", compareDateRange: null }], filters: null, order: null, limit: null } }));
        assert.equal(queried.ok, true);
        await input.onCheckpoint();
        const composed = JSON.parse(await call("ComposeAnswer", { outcome: "answer", markdown: "Gross takings were {{sales}}.", values: [{ id: "sales", resultId: queried.resultId, rowIndex: 0, columnKey: "sales_analytics_gross_takings", format: "auto", decimals: null }], tables: [], citedResultIds: [queried.resultId], limitations: [], followUps: [] }));
        assert.equal(composed.ok, true);
        return "";
      },
      modelRequests: () => runs,
      usage: () => ({ requests: runs, inputTokens: 10 * runs, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: runs, reasoningTokens: 0 }),
      checkpointState: () => ({ history: [], driverState: { version: 1, harness: "oai-codex", sessionId: "sess_fixture", baseUrl: "https://api.example.test/v1" } }),
      close: async () => { seen.narrated.push("closed"); },
    };
  };
  await fixture(async (turn, url) => {
    const events: OmniTraceEventInput[] = [];
    const checkpoints: Array<{ driverState?: unknown; modelRequests: number }> = [];
    const result = await runOmniSemanticTurn({
      turn: { ...turn, harness: "oai-codex" },
      cubeApiUrl: url,
      openai: { apiKey: "synthetic-fixture", baseUrl: "https://provider.example.test" },
      driver,
      checkpoint: async (state) => { checkpoints.push({ driverState: state.driverState, modelRequests: state.modelRequests }); },
      emit: (event) => { events.push(event); },
    });
    assert.equal(run.mock.callCount(), 0);
    assert.equal(result.answerState, "Verified");
    assert.equal(result.harness, "oai-codex");
    assert.equal(result.modelRequests, 2);
    assert.equal(result.usage?.inputTokens, 20);
    assert.match(seen.instructions[0] ?? "", /Core Identity & Purpose/u);
    assert.deepEqual(seen.toolNames, ["ManageTaskList", "SearchSemanticModel", "FetchFieldValues", "GenerateSemanticQuery", "SummarizeFullResults", "ComposePivotTable", "DeriveResult", "CalculateValues", "VisualizeQueryResults", "ComposeAnswer", "GetCurrentTime"]);
    assert.equal(seen.continuations.length, 1);
    assert.match(seen.continuations[0]!, /Call ComposeAnswer now/u);
    assert.deepEqual(seen.narrated, ["closed"]);
    const narrative = events.find((event) => event.type === "narrative");
    assert.equal(narrative?.text, "Looking at sales first:");
    const answer = events.find((event) => event.type === "answer");
    assert.equal(answer?.text, "Gross takings were $600.00.");
    assert.ok(checkpoints.length >= 1);
    assert.deepEqual(checkpoints.at(-1)?.driverState, { version: 1, harness: "oai-codex", sessionId: "sess_fixture", baseUrl: "https://api.example.test/v1" });
  });
});
