import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  codexAppServerArguments,
  codexChildEnvironment,
  runCodexAppServerTurn,
} from "../../packages/albert-codex/src/app-server.ts";

const fakeServerSource = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.148.0\\n");
  process.exit(0);
}
if (process.argv.includes("login")) {
  if (process.argv.includes("status")) {
    process.stdout.write("Logged in using ChatGPT\\n");
    process.exit(0);
  }
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  return;
}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const threadId = "thr_fixture";
const turnId = "0198f6bd-3e23-7000-8000-000000000001";
const toolResponses = new Set();
let rawCommentaryOptedOut = false;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    rawCommentaryOptedOut = message.params.capabilities?.optOutNotificationMethods?.includes("item/agentMessage/delta") === true;
    send({ id: message.id, result: { userAgent: "fake-codex" } });
    return;
  }
  if (message.method === "thread/start") {
    const safe = Array.isArray(message.params.environments)
      && message.params.environments.length === 0
      && Array.isArray(message.params.runtimeWorkspaceRoots)
      && message.params.runtimeWorkspaceRoots.length === 0
      && message.params.ephemeral === true
      && message.params.approvalPolicy === "never"
      && message.params.dynamicTools?.[0]?.name === "albert"
      && message.params.dynamicTools?.[0]?.tools?.some((tool) => tool.name === "report_evidence_update")
      && message.params.dynamicTools?.[0]?.tools?.some((tool) => tool.name === "make_chart")
      && rawCommentaryOptedOut
      && (process.env.CODEX_HOME?.includes("/albert-codex-turn-")
        || process.env.CODEX_HOME?.includes("/albert-codex-subscription-"))
      && !process.env.CUBEJS_API_SECRET
      && !process.env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET
      && !process.env.CONTROL_PLANE_DATABASE_URL;
    if (!safe) send({ id: message.id, error: { message: "unsafe thread configuration" } });
    else send({
      id: message.id,
      result: {
        thread: { id: threadId },
        instructionSources: message.params.baseInstructions === "external"
          ? ["/host/AGENTS.md"]
          : [],
        runtimeWorkspaceRoots: [],
      },
    });
    return;
  }
  if (message.method === "turn/start") {
    const safe = Array.isArray(message.params.environments)
      && message.params.environments.length === 0
      && message.params.sandboxPolicy?.type === "readOnly"
      && message.params.sandboxPolicy?.networkAccess === false
      && message.params.outputSchema?.properties?.claims;
    if (!safe) {
      send({ id: message.id, error: { message: "unsafe turn configuration" } });
      return;
    }
    send({ id: message.id, result: { turn: { id: turnId } } });
    setImmediate(() => {
      for (const id of [60, 61]) send({
        method: "item/tool/call",
        id,
        params: {
          threadId,
          turnId,
          callId: "call_fixture",
          namespace: "albert",
          tool: "search_semantic_catalogue",
          arguments: { question: "sales" },
        },
      });
    });
    return;
  }
  if ((message.id === 60 || message.id === 61) && message.result) {
    toolResponses.add(message.id);
    if (toolResponses.size < 2) return;
    const final = JSON.stringify({
      state: "Unavailable",
      answer: "No query was required for this protocol test.",
      followUps: [],
      presentedResultIds: [],
      claims: [],
    });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { type: "agentMessage", id: "msg_fixture", text: final, phase: "final_answer", memoryCitation: null },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: turnId, status: "completed", error: null, durationMs: 7 },
      },
    });
  }
});
`;

const repairServerSource = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.148.0\\n");
  process.exit(0);
}
if (process.argv.includes("login")) {
  if (process.argv.includes("status")) {
    process.stdout.write("Logged in using ChatGPT\\n");
    process.exit(0);
  }
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  return;
}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const threadId = "thr_repair_fixture";
let turnNumber = 0;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method !== "turn/start") return;
  turnNumber += 1;
  const turnId = "turn_" + turnNumber;
  send({ id: message.id, result: { turn: { id: turnId } } });
  const final = JSON.stringify({
    state: "Verified",
    answer: turnNumber === 1 ? "First candidate." : "Corrected candidate.",
    followUps: [],
    presentedResultIds: [],
    claims: [],
  });
  setImmediate(() => {
    send({
      method: "item/completed",
      params: { threadId, turnId, item: { type: "agentMessage", id: "msg_" + turnNumber, text: final, phase: "final_answer" } },
    });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", durationMs: 5 } } });
  });
});
`;

const transientServerSource = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.148.0\\n");
  process.exit(0);
}
if (process.argv.includes("login")) {
  if (process.argv.includes("status")) {
    process.stdout.write("Logged in using ChatGPT\\n");
    process.exit(0);
  }
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  return;
}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const threadId = "thr_transient_fixture";
let turnNumber = 0;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method !== "turn/start") return;
  turnNumber += 1;
  const turnId = "turn_transient_" + turnNumber;
  send({ id: message.id, result: { turn: { id: turnId } } });
  if (turnNumber === 1) {
    return setImmediate(() => send({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "failed", error: { message: "response_closed" }, durationMs: 9 } },
    }));
  }
  if (!String(message.params.input?.[0]?.text || "").includes("previous model response stream closed")) {
    return setImmediate(() => send({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "failed", error: { message: "missing continuation instruction" } } },
    }));
  }
  const final = JSON.stringify({
    state: "Qualified",
    answer: "The resumed thread completed.",
    followUps: [],
    presentedResultIds: [],
    claims: [],
  });
  setImmediate(() => {
    send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "msg_resumed", text: final, phase: "final_answer" } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", durationMs: 11 } } });
  });
});
`;

test("Codex child environment contains no API key and uses an isolated Codex home", () => {
  const environment = codexChildEnvironment({
    baseUrl: "https://au.api.openai.com/v1",
    codexHome: "/tmp/albert-codex-turn-fixture/codex-home",
  });
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.OPENAI_BASE_URL, "https://au.api.openai.com/v1");
  assert.equal(environment.CODEX_HOME, "/tmp/albert-codex-turn-fixture/codex-home");
  for (const forbidden of [
    "CUBEJS_API_SECRET",
    "CONTROL_PLANE_DATABASE_URL",
    "ANALYTICAL_DATABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ALBERT_CODEX_RUNTIME_SIGNING_SECRET",
  ]) {
    assert.equal(environment[forbidden], undefined, `${forbidden} must not reach Codex`);
  }
});

test("ChatGPT child environment contains no API endpoint or API credential", () => {
  const environment = codexChildEnvironment({
    codexHome: "/tmp/albert-codex-subscription-fixture",
  });
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.OPENAI_BASE_URL, undefined);
  assert.equal(environment.CODEX_HOME, "/tmp/albert-codex-subscription-fixture");
});

test("Codex app-server is pinned, environmentless, and handles one namespaced host tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "albert-codex-fake-"));
  const binary = join(directory, "codex-fixture");
  await writeFile(binary, fakeServerSource, "utf8");
  await chmod(binary, 0o755);
  const previous = {
    cube: process.env.CUBEJS_API_SECRET,
    signing: process.env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET,
    database: process.env.CONTROL_PLANE_DATABASE_URL,
  };
  process.env.CUBEJS_API_SECRET = "must-not-leak";
  process.env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET = "must-not-leak";
  process.env.CONTROL_PLANE_DATABASE_URL = "must-not-leak";
  try {
    let calls = 0;
    const result = await runCodexAppServerTurn({
      authentication: {
        mode: "api",
        apiKey: "sk-test",
        baseUrl: "https://au.api.openai.com/v1",
      },
      model: "gpt-5.6-sol",
      effort: "high",
      fastMode: true,
      input: "fixture",
      baseInstructions: "fixture",
      developerInstructions: "fixture",
      binaryPath: binary,
      async onToolCall(call) {
        calls += 1;
        assert.equal(call.namespace, "albert");
        assert.equal(call.tool, "search_semantic_catalogue");
        return { success: true, text: JSON.stringify({ ok: true }) };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.threadId, "thr_fixture");
    assert.equal(result.durationMs, 7);
    assert.match(result.finalMessage, /protocol test/u);
    await assert.rejects(() => runCodexAppServerTurn({
      authentication: {
        mode: "api",
        apiKey: "sk-test",
        baseUrl: "https://au.api.openai.com/v1",
      },
      model: "gpt-5.6-sol",
      effort: "high",
      fastMode: true,
      input: "fixture",
      baseInstructions: "external",
      developerInstructions: "fixture",
      binaryPath: binary,
      onToolCall: async () => ({ success: true, text: "{}" }),
    }), /external instruction source/u);
  } finally {
    if (previous.cube === undefined) delete process.env.CUBEJS_API_SECRET;
    else process.env.CUBEJS_API_SECRET = previous.cube;
    if (previous.signing === undefined) delete process.env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET;
    else process.env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET = previous.signing;
    if (previous.database === undefined) delete process.env.CONTROL_PLANE_DATABASE_URL;
    else process.env.CONTROL_PLANE_DATABASE_URL = previous.database;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex app-server can use an existing ChatGPT subscription login without an API key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "albert-codex-subscription-"));
  const binary = join(directory, "codex-fixture");
  await writeFile(binary, fakeServerSource, "utf8");
  await chmod(binary, 0o755);
  try {
    const result = await runCodexAppServerTurn({
      authentication: { mode: "chatgpt", codexHome: directory },
      model: "gpt-5.6-luna",
      effort: "max",
      fastMode: true,
      input: "fixture",
      baseInstructions: "fixture",
      developerInstructions: "fixture",
      binaryPath: binary,
      onToolCall: async () => ({ success: true, text: JSON.stringify({ ok: true }) }),
    });
    assert.equal(result.threadId, "thr_fixture");
    assert.match(result.finalMessage, /protocol test/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex startup disables coding, browser, plugin and multi-agent capabilities", () => {
  const argumentsList = codexAppServerArguments({
    mode: "api",
    apiKey: "not-rendered",
    baseUrl: "https://au.api.openai.com/v1",
  }).join(" ");
  for (const feature of [
    "shell_tool", "unified_exec", "multi_agent", "apps", "plugins", "browser_use",
    "computer_use", "image_generation", "goals", "hooks", "workspace_dependencies", "code_mode",
  ]) {
    assert.match(argumentsList, new RegExp(`--disable ${feature}`, "u"));
  }
  assert.match(argumentsList, /history\.persistence="none"/u);
  assert.match(argumentsList, /approval_policy="never"/u);
  assert.match(argumentsList, /sandbox_mode="read-only"/u);
  assert.match(argumentsList, /tools\.update_plan\.enabled=true/u);
  assert.match(argumentsList, /mcp_servers\.openaiDeveloperDocs\.enabled=false/u);
  assert.match(argumentsList, /mcp_servers\.node_repl\.enabled=false/u);
  assert.doesNotMatch(argumentsList, /not-rendered/u);
  const subscriptionFast = codexAppServerArguments({
    mode: "chatgpt",
    codexHome: "/tmp/albert-codex-subscription-fixture",
  }, true, "/tmp/albert-codex-turn-fixture/runtime-state").join(" ");
  assert.match(subscriptionFast, /forced_login_method="chatgpt"/u);
  assert.match(subscriptionFast, /features\.fast_mode=true/u);
  assert.match(subscriptionFast, /service_tier="fast"/u);
  assert.match(subscriptionFast, /sqlite_home="\/tmp\/albert-codex-turn-fixture\/runtime-state"/u);
  assert.match(subscriptionFast, /log_dir="\/tmp\/albert-codex-turn-fixture\/runtime-state\/logs"/u);
  assert.doesNotMatch(subscriptionFast, /OPENAI_BASE_URL|api\.openai/u);
});

test("Codex keeps the same ephemeral thread alive to repair a rejected final candidate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "albert-codex-repair-"));
  const binary = join(directory, "codex-repair-fixture");
  await writeFile(binary, repairServerSource, "utf8");
  await chmod(binary, 0o755);
  const candidates: string[] = [];
  try {
    const result = await runCodexAppServerTurn({
      authentication: {
        mode: "api",
        apiKey: "sk-test",
        baseUrl: "https://au.api.openai.com/v1",
      },
      model: "gpt-5.6-sol",
      effort: "high",
      fastMode: true,
      input: "fixture",
      baseInstructions: "fixture",
      developerInstructions: "fixture",
      binaryPath: binary,
      onToolCall: async () => ({ success: false, text: "No tool expected." }),
      validateFinalCandidate(finalMessage, repairAttempt) {
        candidates.push(finalMessage);
        return repairAttempt === 0 ? "claim_0 referenced an unknown result cell" : null;
      },
    });
    assert.equal(result.threadId, "thr_repair_fixture");
    assert.equal(result.turnId, "turn_2");
    assert.equal(result.durationMs, 10);
    assert.equal(candidates.length, 2);
    assert.match(candidates[0]!, /First candidate/u);
    assert.match(result.finalMessage, /Corrected candidate/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex resumes the same thread after a transient model response closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "albert-codex-transient-"));
  const binary = join(directory, "codex-transient-fixture");
  await writeFile(binary, transientServerSource, "utf8");
  await chmod(binary, 0o755);
  try {
    const result = await runCodexAppServerTurn({
      authentication: {
        mode: "api",
        apiKey: "sk-test",
        baseUrl: "https://au.api.openai.com/v1",
      },
      model: "gpt-5.6-luna",
      effort: "max",
      fastMode: true,
      input: "fixture",
      baseInstructions: "fixture",
      developerInstructions: "fixture",
      binaryPath: binary,
      onToolCall: async () => ({ success: false, text: "No tool expected." }),
    });
    assert.equal(result.threadId, "thr_transient_fixture");
    assert.equal(result.turnId, "turn_transient_2");
    assert.equal(result.durationMs, 20);
    assert.match(result.finalMessage, /resumed thread completed/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
