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
      "ES2022,DOM,DOM.Iterable",
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
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
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
    "Qualified",
    "Exploratory",
    "Clarification",
    "Unavailable",
  ]);

  const normalized = shared.normalizeAgentPreferences({
    model: "not-a-model",
    reasoningEffort: "unbounded",
    fastMode: "yes",
    service_tier: "fast",
  });

  assert.deepEqual(normalized, shared.DEFAULT_AGENT_PREFERENCES);
  assert.equal(Object.isFrozen(normalized), true);
});

test("Fast mode is independent from model and reasoning effort", () => {
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
  assert.deepEqual(standard.modelSettings.providerData, {});
  assert.deepEqual(fast.modelSettings.providerData, { service_tier: "fast" });
});

test("optional Agents SDK factory rejects every non-semantic tool", async () => {
  class FakeAgent {
    constructor(definition) {
      this.definition = definition;
    }
  }

  const calls = [];
  const sdk = {
    Agent: FakeAgent,
    async run(runtimeAgent, input, options) {
      calls.push({ runtimeAgent, input, options });
      return { finalOutput: "fixture" };
    },
  };

  const runtime = agent.createOpenAIAgentRuntime({
    sdk,
    instructions: "Use governed semantic tools and cite provenance.",
    preferences: {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      fastMode: true,
    },
    tools: [{ name: "run_semantic_query" }, { name: "make_chart" }],
  });

  assert.deepEqual(runtime.agent.definition.modelSettings.providerData, {
    service_tier: "fast",
  });
  await runtime.run("Show category performance", { stream: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "Show category performance");

  assert.throws(
    () =>
      agent.createOpenAIAgentRuntime({
        sdk,
        instructions: "Unsafe fixture",
        tools: [{ name: "execute_sql" }],
      }),
    /tool boundary rejected: execute_sql/i,
  );
});

test("direct OpenAI Agents SDK adapter instantiates the selected current model", () => {
  const runtime = agent.createAlbertOpenAIAgent({
    instructions: "Use governed semantic tools and return provenance.",
    preferences: {
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      fastMode: true,
    },
    tools: [],
  });

  assert.equal(runtime.agent.model, "gpt-5.6-luna");
  assert.equal(runtime.agent.modelSettings.reasoning.effort, "low");
  assert.equal(runtime.agent.modelSettings.reasoning.context, "current_turn");
  assert.deepEqual(runtime.agent.modelSettings.providerData, {
    service_tier: "fast",
  });
});

test("live agent uses local bounded conversation state and disables provider storage", () => {
  const preferences = {
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    fastMode: false,
  };
  const runtimeAgent = conversation.createLiveAlbertAgent(preferences, "privacy-safe-user-id");
  assert.equal(runtimeAgent.modelSettings.store, false);
  assert.equal(runtimeAgent.modelSettings.providerData.safety_identifier, "privacy-safe-user-id");
  const input = conversation.buildBoundedModelInput([
    { role: "user", text: "How were sales?" },
    { role: "assistant", text: "Sales were supported by the governed result." },
    { role: "user", text: "Break that down by location." },
  ], "Break that down by location.");
  assert.deepEqual(input.map(({ role }) => role), ["user", "assistant", "user"]);
  assert.throws(
    () => conversation.buildBoundedModelInput([{ role: "assistant", text: "stale" }], "new"),
    /does not end with the current user message/,
  );
});

test("completed model history receives the trusted current user message exactly once", () => {
  const completed = [
    { role: "user", text: "How were sales?" },
    { role: "assistant", text: "Sales were supported by the governed result." },
  ];
  const context = conversation.appendCurrentUserMessage(completed, "Break that down by location.");
  assert.deepEqual(context, [
    ...completed,
    { role: "user", text: "Break that down by location." },
  ]);
  assert.doesNotThrow(() => conversation.buildBoundedModelInput(context, "Break that down by location."));
  assert.equal(completed.length, 2);
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
