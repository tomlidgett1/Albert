import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

let outputRoot;
let shared;
let agent;
let connectorSdk;
let conversation;

before(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), "albert-runtime-contracts-"));
  await symlink(
    join(repositoryRoot, "node_modules"),
    join(outputRoot, "node_modules"),
    "dir",
  );
  const tsc = join(repositoryRoot, "node_modules", ".bin", "tsc");

  await execFileAsync(
    tsc,
    [
      "--outDir",
      outputRoot,
      "--rootDir",
      ".",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--skipLibCheck",
      "--lib",
      "ES2024,DOM,DOM.Iterable",
      "packages/shared/src/index.ts",
      "packages/agent/src/index.ts",
      "packages/connector-sdk/src/index.ts",
      "services/conversation/src/index.ts",
    ],
    { cwd: repositoryRoot },
  );

  const load = (path) => import(`${pathToFileURL(join(outputRoot, path)).href}?test=1`);
  [shared, agent, connectorSdk, conversation] = await Promise.all([
    load("packages/shared/src/index.js"),
    load("packages/agent/src/index.js"),
    load("packages/connector-sdk/src/index.js"),
    load("services/conversation/src/index.js"),
  ]);
});

after(async () => {
  if (outputRoot) await rm(outputRoot, { recursive: true, force: true });
});

test("server model policy normalizes untrusted preferences to the allowlist", () => {
  assert.deepEqual(
    shared.ALBERT_MODELS.map(({ id }) => id),
    [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "grok-4.6",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ],
  );
  assert.deepEqual(shared.REASONING_EFFORTS, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(shared.ANSWER_STATES, [
    "Verified",
    "Derived",
    "Qualified",
    "Exploratory",
    "Clarification",
    "No data",
    "Unavailable",
  ]);
  // Dash default is Luna + Max + Fast.
  assert.deepEqual(shared.DEFAULT_AGENT_PREFERENCES, {
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    fastMode: true,
  });

  const normalized = shared.normalizeAgentPreferences({
    model: "not-a-model",
    reasoningEffort: "unbounded",
    fastMode: "yes",
    service_tier: "fast",
  });

  assert.deepEqual(normalized, shared.DEFAULT_AGENT_PREFERENCES);
  assert.equal(Object.isFrozen(normalized), true);

  assert.deepEqual(
    shared.normalizeAgentPreferences({
      model: "grok-4.6",
      reasoningEffort: "max",
      fastMode: true,
    }),
    { model: "grok-4.6", reasoningEffort: "xhigh", fastMode: true },
  );
  assert.deepEqual(
    shared.normalizeAgentPreferences({
      model: "grok-4.6",
      reasoningEffort: "none",
      fastMode: false,
    }),
    { model: "grok-4.6", reasoningEffort: "low", fastMode: false },
  );
  assert.deepEqual(shared.GROK_REASONING_EFFORTS, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(
    shared.normalizeAgentPreferences({
      model: "claude-haiku-4-5-20251001",
      reasoningEffort: "high",
      fastMode: true,
    }),
    {
      model: "claude-haiku-4-5-20251001",
      reasoningEffort: "high",
      fastMode: false,
    },
  );
  assert.equal(shared.providerForModel("grok-4.6"), "xai");
  assert.equal(shared.providerForModel("claude-haiku-4-5-20251001"), "anthropic");
  assert.equal(shared.providerForModel("gpt-5.6-sol"), "openai");
  assert.deepEqual(
    shared.normalizeAgentPreferences({
      model: "gemini-3.7-flash",
      reasoningEffort: "max",
      fastMode: true,
    }),
    shared.DEFAULT_AGENT_PREFERENCES,
  );
  assert.deepEqual(
    shared.resolveAlbertModelTransport({
      model: "grok-4.6",
      xaiApiKey: "xai-test",
    }),
    {
      provider: "xai",
      model: "grok-4.6",
      apiKey: "xai-test",
      baseUrl: "https://api.x.ai/v1",
    },
  );
  assert.throws(
    () => shared.resolveAlbertModelTransport({ model: "grok-4.6" }),
    /Grok 4\.6 is not configured/i,
  );
  assert.deepEqual(
    shared.resolveAlbertModelTransport({
      model: "claude-haiku-4-5-20251001",
      anthropicApiKey: "anthropic-test",
    }),
    {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      apiKey: "anthropic-test",
      baseUrl: "https://api.anthropic.com",
    },
  );
});

test("Fast mode remains independent where the selected provider supports it", () => {
  const standard = agent.buildOpenAIAgentRunConfig({
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    fastMode: false,
  });
  const fast = agent.buildOpenAIAgentRunConfig({
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    fastMode: true,
  });

  assert.equal(standard.model, fast.model);
  assert.deepEqual(standard.modelSettings.reasoning, fast.modelSettings.reasoning);
  assert.equal(fast.modelSettings.reasoning.context, "current_turn");
  assert.equal(fast.modelSettings.reasoning.mode, "standard");
  assert.deepEqual(standard.modelSettings.providerData, {
    service_tier: "default",
  });
  assert.deepEqual(fast.modelSettings.providerData, { service_tier: "fast" });
  assert.equal(standard.modelSettings.store, false);

  const grok = agent.buildOpenAIAgentRunConfig({
    model: "grok-4.6",
    reasoningEffort: "xhigh",
    fastMode: true,
  });
  assert.equal(grok.model, "grok-4.6");
  assert.deepEqual(grok.modelSettings, {
    store: false,
    reasoning: { effort: "xhigh" },
    providerData: {
      include: ["reasoning.encrypted_content"],
      service_tier: "priority",
    },
  });
  const grokLive = agent.buildLiveAgentModelSettings(grok, {
    reasoning: { effort: "low", context: "current_turn" },
    verbosity: "medium",
    parallelToolCalls: true,
    safetyIdentifier: "must-not-be-sent",
  });
  assert.deepEqual(grokLive.reasoning, { effort: "low" });
  assert.equal(grokLive.text, undefined);
  assert.equal(grokLive.parallelToolCalls, true);
  assert.deepEqual(grokLive.providerData, {
    include: ["reasoning.encrypted_content"],
    service_tier: "priority",
  });
  assert.equal("safety_identifier" in grokLive.providerData, false);
  const grokStandard = agent.buildOpenAIAgentRunConfig({
    model: "grok-4.6",
    reasoningEffort: "high",
    fastMode: false,
  });
  assert.equal(grokStandard.modelSettings.providerData.service_tier, "default");
});

test("deterministic fixture emits ordered governed table, chart, and provenance", () => {
  const first = conversation.createDeterministicFixtureTrace();
  const second = conversation.createDeterministicFixtureTrace();

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map(({ sequence }) => sequence),
    first.map((_, index) => index + 1),
  );
  shared.assertOrderedSanitizedTrace(first);

  const table = first.find(({ type }) => type === "table");
  const chart = first.find(({ type }) => type === "chart");
  const answer = first.find(({ type }) => type === "answer");

  assert.ok(table);
  assert.ok(chart);
  assert.ok(answer);
  assert.equal(table.resultId, conversation.FIXTURE_RESULT_ID);
  assert.equal(chart.dataRef, table.resultId);
  assert.equal(answer.state, "Verified");
  assert.equal(answer.provenance.semanticBundleHash, table.provenance.semanticBundleHash);
  assert.equal(table.rows[0].netSales, 84240);

  const serialized = JSON.stringify(first).toLowerCase();
  assert.doesNotMatch(
    serialized,
    /"(sql|compiledsql|prompt|reasoning|chainofthought|rawtooloutput)"\s*:/,
  );
});

test("trace validation rejects missing sequences and forbidden payload fields", () => {
  const trace = conversation.createDeterministicFixtureTrace();
  assert.throws(
    () => shared.assertOrderedSanitizedTrace([trace[1]]),
    /out of order/i,
  );

  const unsafe = [{ ...trace[0], sql: "select * from tenant_data" }];
  assert.throws(
    () => shared.assertOrderedSanitizedTrace(unsafe),
    /unsafe trace field/i,
  );
});

test("trace validation enforces evidence-bound terminal plan states", () => {
  const fixture = conversation.createDeterministicFixtureTrace();
  const sourceTable = fixture.find(({ type }) => type === "table");
  const sourceAnswer = fixture.find(({ type }) => type === "answer");
  assert.ok(sourceTable && sourceAnswer);
  const at = "2026-08-19T00:00:00.000Z";
  const opening = {
    id: "01PLANOPEN00000000000000000",
    sequence: 1,
    occurredAt: at,
    type: "plan",
    status: "complete",
    steps: [
      { id: "plan_step_1", label: "Check the figure", kind: "evidence", status: "active", evidenceResultIds: [] },
      { id: "plan_step_2", label: "Confirm the answer", kind: "synthesis", status: "pending", evidenceResultIds: [] },
    ],
  };
  const table = { ...sourceTable, id: "01PLANTABLE0000000000000000", sequence: 2, occurredAt: at };
  const terminal = {
    ...opening,
    id: "01PLANDONE00000000000000000",
    sequence: 3,
    steps: opening.steps.map((step) => ({
      ...step,
      status: "done",
      evidenceResultIds: [table.resultId],
    })),
  };
  const answer = { ...sourceAnswer, id: "01PLANANSWER000000000000000", sequence: 4, occurredAt: at };
  assert.doesNotThrow(() => shared.assertOrderedSanitizedTrace([opening, table, terminal, answer]));

  const unsupported = {
    ...terminal,
    steps: terminal.steps.map((step) => ({ ...step, evidenceResultIds: ["01UNKNOWNRESULT00000000000000"] })),
  };
  assert.throws(
    () => shared.assertOrderedSanitizedTrace([opening, table, unsupported]),
    /not emitted successfully first/i,
  );
  const premature = { ...answer, sequence: 2 };
  assert.throws(
    () => shared.assertOrderedSanitizedTrace([opening, premature]),
    /before the visible plan reached truthful terminal states/i,
  );

  const blocked = {
    ...opening,
    id: "01PLANBLOCKED000000000000000",
    sequence: 2,
    status: "warning",
    steps: [
      { ...opening.steps[0], status: "blocked", statusDetail: "The required source was unavailable." },
      { ...opening.steps[1], status: "incomplete", statusDetail: "A supported answer could not be completed." },
    ],
  };
  const unavailableAnswer = { ...sourceAnswer, id: "01PLANUNAVAILABLE00000000000", sequence: 3, occurredAt: at, state: "Unavailable" };
  assert.doesNotThrow(() => shared.assertOrderedSanitizedTrace([opening, blocked, unavailableAnswer]));
});

test("fixture SSE stream preserves event IDs, ordering, and safe event payloads", async () => {
  const response = conversation.createFixtureConversationSseResponse({ intervalMs: 0 });
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/i);
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");

  const frames = (await response.text()).trim().split("\n\n");
  const events = frames.map((frame) => {
    const lines = frame.split("\n");
    assert.equal(lines[1], "event: trace");
    const event = JSON.parse(lines[2].slice("data: ".length));
    assert.equal(lines[0], `id: ${event.sequence}`);
    return event;
  });

  assert.equal(events.length, conversation.createDeterministicFixtureTrace().length);
  assert.deepEqual(
    events.map(({ sequence }) => sequence),
    events.map((_, index) => index + 1),
  );
});

test("connector source keys are deterministic and namespaced", () => {
  assert.equal(
    connectorSdk.makeNamespacedSourceKey("lightspeed-r", "store 1", "Sale", "a/b"),
    "lightspeed-r:store%201:Sale:a%2Fb",
  );
  assert.throws(
    () => connectorSdk.makeNamespacedSourceKey("xero", "", "Invoice", "1"),
    /empty component/i,
  );
});
