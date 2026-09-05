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
