import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.ts";
import {
  describeSemanticRule,
  matchSemanticRules,
  normalizeSemanticTerm,
} from "../../packages/albert-codex/src/semantic-memory.ts";
import { runCodexSemanticTurn } from "../../packages/albert-codex/src/semantic-runtime.ts";
import type { CodexServiceTurn } from "../../packages/albert-codex/src/contracts.ts";

test("semantic terms normalise to a stable matching form", () => {
  assert.equal(normalizeSemanticTerm("  General   Service! "), "general service");
  assert.equal(normalizeSemanticTerm("Café-Orders"), "cafe orders");
  assert.equal(normalizeSemanticTerm("!!!"), "");
});

test("rule matching finds terms in questions, plural-insensitively, strongest first", () => {
  const rules = [
    { ruleId: "1", term: "general service", status: "proposed", useCount: 4 },
    { ruleId: "2", term: "service", status: "confirmed", useCount: 0 },
    { ruleId: "3", term: "workshop", status: "confirmed", useCount: 9 },
    { ruleId: "4", term: "general service", status: "retired", useCount: 20 },
  ] as const;
  const matched = matchSemanticRules("Show me a list of general services data", rules);
  // Retired rules never match; the confirmed rule outranks the proposed even
  // though the proposed term is longer and more used.
  assert.deepEqual(matched.map((rule) => rule.ruleId), ["2", "1"]);
  assert.deepEqual(matchSemanticRules("How were takings yesterday?", rules), []);
  // Token-sequence matching, not substring: "servicework" must not match.
  assert.deepEqual(matchSemanticRules("servicework roster", [rules[1]]), []);
});

test("a turn rule renders as one owner-readable line", () => {
  assert.equal(
    describeSemanticRule({
      term: "general service",
      meaning: "the item \"Service - General Service\"",
      counterMeaning: "the Services category",
      binding: { view: "product_sales_analytics", dimension: "product_sales_analytics.item", value: "Service - General Service" },
      status: "confirmed",
    }),
    "\"general service\" means the item \"Service - General Service\" [product_sales_analytics.item = \"Service - General Service\"] — not the Services category",
  );
  assert.match(
    describeSemanticRule({ term: "the floor", meaning: "retail sales staff", status: "proposed" }),
    /unconfirmed — apply it/u,
  );
});

const fakeCodexSource = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.148.0\\n");
  process.exit(0);
}
if (process.argv.includes("login")) {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  return;
}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const threadId = "thr_memory_fixture";
let turnId = "";
let evidenceResultId = "";
const fail = (message) => send({
  method: "turn/completed",
  params: { threadId, turn: { id: turnId, status: "failed", error: { message }, durationMs: 5 } },
});
const finish = () => {
  send({
    method: "item/completed",
    params: { threadId, turnId, item: { type: "agentMessage", id: "msg_final", text: JSON.stringify({
      state: "Verified",
      answer: "Net sales were $100.",
      followUps: [],
      keyInsights: [
        { value: "$100.00", label: "Net sales", detail: "This turn", sentiment: "neutral" },
        { value: "$999.00", label: "Invented figure", detail: "", sentiment: "positive" },
        { value: "Trending up", label: "Sales direction", detail: "vs earlier weeks", sentiment: "positive" },
      ],
      presentedResultIds: [evidenceResultId],
      claims: [],
    }), phase: "final_answer", memoryCitation: null } },
  });
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed", error: null, durationMs: 12 } },
  });
};
const rememberCall = (id, callId, args) => send({
  method: "item/tool/call",
  id,
  params: { threadId, turnId, callId, namespace: "albert", tool: "remember_term", arguments: args },
});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === "turn/start") {
    turnId = "turn_memory";
    send({ id: message.id, result: { turn: { id: turnId } } });
    // The injected vocabulary must reach the model's turn input verbatim.
    if (!JSON.stringify(message.params).includes("general service")) {
      return setImmediate(() => fail("semantic memory missing from turn input"));
    }
    return setImmediate(() => send({
      method: "item/tool/call",
      id: 60,
      params: {
        threadId, turnId, callId: "call_query", namespace: "albert", tool: "run_semantic_query",
        arguments: { topic: "Net sales", query: { measures: ["sales_analytics.net_sales"], limit: 10 } },
      },
    }));
  }
  if (message.id === 60 && message.result) {
    evidenceResultId = JSON.parse(message.result.contentItems[0].text).resultId;
    return rememberCall(70, "call_remember_valid", {
      term: "workshop",
      meaning: "service jobs and labour, not parts",
      counterMeaning: "parts and accessory sales",
      binding: { view: "sales_analytics", dimension: "sales_analytics.category", value: "Services" },
      trigger: "correction",
    });
  }
  if (message.id === 70 && message.result) {
    const outcome = JSON.parse(message.result.contentItems[0].text);
    if (!outcome.ok || outcome.stored !== "proposed") return fail("valid correction was not stored as proposed");
    return rememberCall(71, "call_remember_unknown_view", {
      term: "margins",
      meaning: "gross profit percentage",
      binding: { view: "not_a_real_view" },
      trigger: "correction",
    });
  }
  if (message.id === 71 && message.result) {
    const outcome = JSON.parse(message.result.contentItems[0].text);
    if (outcome.ok || outcome.error !== "unknown_view") return fail("unknown binding view was accepted");
    return rememberCall(72, "call_remember_duplicate", {
      term: "Workshop!",
      meaning: "a different meaning for the same normalised term",
      trigger: "correction",
    });
  }
  if (message.id === 72 && message.result) {
    const outcome = JSON.parse(message.result.contentItems[0].text);
    if (outcome.ok || outcome.error !== "duplicate_term") return fail("duplicate term was accepted twice in one turn");
    return rememberCall(73, "call_remember_owner", {
      term: "the floor",
      meaning: "retail sales staff",
      trigger: "owner_request",
    });
  }
  if (message.id === 73 && message.result) {
    const outcome = JSON.parse(message.result.contentItems[0].text);
    if (!outcome.ok || outcome.stored !== "confirmed") return fail("owner request was not stored as confirmed");
    finish();
  }
});
`;

test("remember_term captures vocabulary proposals and injected rules reach the turn input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "albert-codex-memory-"));
  const binary = join(directory, "codex-fixture");
  await writeFile(binary, fakeCodexSource, "utf8");
  await chmod(binary, 0o755);

  const cube = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/cubejs-api/v1/meta")) {
      response.end(JSON.stringify({
        cubes: [{
          name: "sales_analytics",
          title: "Sales analytics",
          description: "Governed completed sales.",
          public: true,
          measures: [{
            name: "sales_analytics.net_sales",
            title: "Net sales",
            shortTitle: "Net sales",
            description: "Completed sales net of refunds.",
            type: "number",
            aliasMember: "sales.net_sales",
          }],
          dimensions: [{
            name: "sales_analytics.category",
            title: "Category",
            shortTitle: "Category",
            description: "Governed sales category.",
            type: "string",
          }],
          segments: [],
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      data: [{ "sales_analytics.net_sales": 100 }],
      annotation: {
        measures: {
          "sales_analytics.net_sales": { title: "Net sales", shortTitle: "Net sales", type: "number", format: "currency" },
        },
        dimensions: {},
      },
    }));
  });
  cube.listen(0, "127.0.0.1");
  await once(cube, "listening");
  const address = cube.address();
  assert.ok(address && typeof address === "object");

  const tenantId = "01J00000000000000000000051";
  const conversationId = "01J00000000000000000000052";
  const albertTurnId = "01J00000000000000000000053";
  const token = signCubeJwt({
    secret: "s".repeat(48),
    expiresInSeconds: 900,
    securityContext: {
      tenant_id: tenantId,
      role: "owner",
      specialist_agent_id: "general",
      specialist_agent_version: 1,
      conversation_id: conversationId,
      turn_id: albertTurnId,
    },
  });
  const turn: CodexServiceTurn = {
    protocolVersion: 1,
    requestId: "01J00000000000000000000054",
    tenantId,
    actorId: "11111111-1111-4111-8111-111111111111",
    role: "owner",
    conversationId,
    turnId: albertTurnId,
    message: "How is general service revenue tracking this month?",
    priorConversation: [],
    priorResults: [],
    activeConnectors: ["lightspeed-r"],
    connectorFreshness: [{ connector: "lightspeed", domain: "sales", dataThrough: "2026-08-20" }],
    semanticMemory: [{
      term: "general service",
      meaning: "the item \"Service - General Service\"",
      counterMeaning: "the Services category",
      binding: { view: "sales_analytics", dimension: "sales_analytics.category", value: "Service - General Service" },
      status: "confirmed",
    }],
    cubeBearer: token,
    model: "gpt-5.6-sol",
    effort: "high",
    fastMode: true,
  };
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  try {
    const result = await runCodexSemanticTurn({
      turn,
      cubeApiUrl: `http://127.0.0.1:${address.port}`,
      openaiApiKey: "sk-fixture",
      openaiBaseUrl: "https://au.api.openai.com/v1",
      codexBinaryPath: binary,
      emit: (event) => events.push(event),
    });
    assert.equal(result.answerState, "Verified");
    // Only the two accepted rules survive: the unknown-view binding and the
    // in-turn duplicate were both refused.
    assert.deepEqual(result.memoryProposals?.map((proposal) => [proposal.term, proposal.trigger]), [
      ["workshop", "correction"],
      ["the floor", "owner_request"],
    ]);
    assert.equal(result.memoryProposals?.[0]?.binding?.value, "Services");
    const learned = events.filter((event) => event.type === "progress" && event.label === "Albert learned a term");
    assert.equal(learned.length, 2);
    assert.match(String(learned[0]?.detail), /workshop/u);
    // Key insight cards: the grounded figure and the number-free state card
    // survive; the invented $999 card is dropped by host validation.
    const answerEvent = events.find((event) => event.type === "answer") as { keyInsights?: readonly { value: string }[] };
    assert.deepEqual(answerEvent.keyInsights?.map((insight) => insight.value), ["$100.00", "Trending up"]);
  } finally {
    cube.close();
    await rm(directory, { recursive: true, force: true });
  }
});
