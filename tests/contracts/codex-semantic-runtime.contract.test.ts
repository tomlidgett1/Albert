import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.ts";
import {
  formatCodexAnswerText,
  preferredCodexConnectors,
  runCodexSemanticTurn,
  validateCodexFinalAnswer,
  type CodexEvidenceResult,
} from "../../packages/albert-codex/src/semantic-runtime.ts";
import type { CodexServiceTurn } from "../../packages/albert-codex/src/contracts.ts";

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
const threadId = "thr_semantic_fixture";
let turnNumber = 0;
let turnId = "";
let evidenceResultId = "";
let hostGeneratedRankClaim = null;
const finish = (answer) => {
  const final = JSON.stringify({
    state: "Verified",
    answer,
    followUps: ["Break this down by month"],
    presentedResultIds: [evidenceResultId],
    claims: hostGeneratedRankClaim ? [hostGeneratedRankClaim] : [],
  });
  send({
    method: "item/completed",
    params: { threadId, turnId, item: { type: "agentMessage", id: "msg_" + turnNumber, text: final, phase: "final_answer", memoryCitation: null } },
  });
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed", error: null, durationMs: 12 } },
  });
};
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === "turn/start") {
    turnNumber += 1;
    turnId = "turn_" + turnNumber;
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (turnNumber > 1) return setImmediate(() => finish("Net sales were $100."));
    return setImmediate(() => {
      send({
        method: "turn/plan/updated",
        params: {
          threadId,
          turnId,
          explanation: "Check the governed sales evidence.",
          plan: [
            { step: "Find the governed sales view", status: "completed" },
            { step: "Query the supported sales measure", status: "inProgress" },
            { step: "Validate and present the answer", status: "pending" },
          ],
        },
      });
      send({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: { type: "error", id: "stream_retry", message: "stream error: response_closed; retrying after 232ms" },
        },
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "error", id: "stream_retry", message: "stream error: response_closed; retrying after 232ms" },
        },
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "sleep", id: "retry_backoff", durationMs: 232 },
        },
      });
      send({ method: "currentTime/read", id: 59, params: {} });
      send({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", id: "commentary_safe", text: "", phase: "commentary" },
        },
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "commentary_safe", delta: "I found the sales view and am " },
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "commentary_safe", delta: "checking the governed total." },
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", id: "commentary_safe", text: "I found the sales view and am checking the governed total.", phase: "commentary" },
        },
      });
      send({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", id: "commentary_json", text: "", phase: "commentary" },
        },
      });
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "commentary_json", delta: "{\\\"state\\\":\\\"Exploratory\\\",\\\"answer\\\":\\\"Never show this.\\\"}" },
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", id: "commentary_unsafe", text: "The draft total is $100.", phase: "commentary" },
        },
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { type: "agentMessage", id: "commentary_json", text: JSON.stringify({ state: "Exploratory", answer: "This structured candidate must never be shown as commentary." }), phase: "commentary" },
        },
      });
      setTimeout(() => send({
        method: "item/tool/call",
        id: 60,
        params: {
          threadId,
          turnId,
          callId: "call_query",
          namespace: "albert",
          tool: "run_semantic_query",
          arguments: {
            topic: "Category net sales",
            query: {
              measures: ["sales_analytics.net_sales"],
              dimensions: ["sales_analytics.category"],
              order: { "sales_analytics.net_sales": "desc" },
              limit: 10,
            },
          },
        },
      }), 5);
    });
  }
  if (message.id === 60 && message.result) {
    const tool = JSON.parse(message.result.contentItems[0].text);
    evidenceResultId = tool.resultId;
    hostGeneratedRankClaim = tool.hostGeneratedClaims?.find((claim) => claim.assertion === "highest") || null;
    if (!hostGeneratedRankClaim) {
      send({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "failed", error: { message: "missing host-generated rank claim" } } },
      });
      return;
    }
    send({
      method: "item/tool/call",
      id: 61,
      params: {
        threadId,
        turnId,
        callId: "call_unsupported_update",
        namespace: "albert",
        tool: "report_evidence_update",
        arguments: {
          message: "Net sales were $999.",
          evidenceResultIds: [evidenceResultId],
        },
      },
    });
    return;
  }
  if (message.id === 61 && message.result) {
    send({
      method: "item/tool/call",
      id: 62,
      params: {
        threadId,
        turnId,
        callId: "call_grounded_update",
        namespace: "albert",
        tool: "report_evidence_update",
        arguments: {
          message: "Net sales were 100.000000000000.",
          evidenceResultIds: [evidenceResultId],
        },
      },
    });
    return;
  }
  if (message.id === 62 && message.result) {
    send({
      method: "item/tool/call",
      id: 63,
      params: {
        threadId,
        turnId,
        callId: "call_duplicate_update",
        namespace: "albert",
        tool: "report_evidence_update",
        arguments: {
          message: "The governed net sales result was $100.",
          evidenceResultIds: [evidenceResultId],
        },
      },
    });
    return;
  }
  if (message.id === 63 && message.result) {
    send({
      method: "item/tool/call",
      id: 64,
      params: {
        threadId,
        turnId,
        callId: "call_chart",
        namespace: "albert",
        tool: "make_chart",
        arguments: {
          resultId: evidenceResultId,
          purpose: "ranking",
          caption: "Bikes led category net sales",
          chartType: "auto",
          xKey: "sales_analytics.category",
          yKey: "sales_analytics.net_sales",
        },
      },
    });
    return;
  }
  if (message.id === 64 && message.result) {
    // The first candidate both embeds a code-drawn chart and states an
    // ungrounded figure; the host must send it back for repair, never render it.
    finish("\\u0060\\u0060\\u0060mermaid\\nxychart-beta\\n  line [100]\\n\\u0060\\u0060\\u0060\\nNet sales were $999.");
  }
});
`;

test("isolated Codex runtime reaches the existing Cube semantic layer and returns a grounded answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "albert-codex-semantic-"));
  const binary = join(directory, "codex-fixture");
  await writeFile(binary, fakeCodexSource, "utf8");
  await chmod(binary, 0o755);

  let authorization = "";
  const cube = createServer((request, response) => {
    authorization = String(request.headers.authorization ?? "");
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
      data: [
        { "sales_analytics.category": "Bikes", "sales_analytics.net_sales": 100 },
        { "sales_analytics.category": "Parts", "sales_analytics.net_sales": 80 },
        { "sales_analytics.category": "Services", "sales_analytics.net_sales": 60 },
      ],
      annotation: {
        measures: {
          "sales_analytics.net_sales": {
            title: "Net sales", shortTitle: "Net sales", type: "number", format: "currency",
          },
        },
        dimensions: {
          "sales_analytics.category": {
            title: "Category", shortTitle: "Category", type: "string",
          },
        },
      },
    }));
  });
  cube.listen(0, "127.0.0.1");
  await once(cube, "listening");
  const address = cube.address();
  assert.ok(address && typeof address === "object");

  const tenantId = "01J00000000000000000000041";
  const conversationId = "01J00000000000000000000042";
  const albertTurnId = "01J00000000000000000000043";
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
    requestId: "01J00000000000000000000044",
    tenantId,
    actorId: "11111111-1111-4111-8111-111111111111",
    role: "owner",
    conversationId,
    turnId: albertTurnId,
    message: "Which category had the highest net sales?",
    priorConversation: [],
    priorResults: [],
    activeConnectors: ["lightspeed-r"],
    connectorFreshness: [{ connector: "lightspeed", domain: "sales", dataThrough: "2026-08-20" }],
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
      authentication: {
        mode: "api",
        apiKey: "sk-fixture",
        baseUrl: "https://au.api.openai.com/v1",
      },
      codexBinaryPath: binary,
      emit: (event) => events.push(event),
    });
    assert.equal(result.answerState, "Verified");
    assert.equal(result.queriesExecuted, 1);
    assert.equal(result.codexTurnId, "turn_2");
    assert.equal(result.durationMs, 24);
    assert.equal(authorization, token);
    assert.deepEqual(events.map((event) => event.type), [
      "progress", "plan", "narrative", "progress", "query", "table", "plan", "narrative",
      "table", "chart", "progress", "plan", "validation", "table", "answer",
    ]);
    // Clean commentary now streams through the truth gate as the owner's
    // analytical journey; leaky commentary stays suppressed below.
    assert.equal(events[2]?.text, "I found the sales view and am checking the governed total.");
    // Presented tables are re-emitted for the answer surface, which renders
    // only presentation:"answer" tables beside the reply.
    assert.equal((events.at(-2) as { presentation?: string }).presentation, "answer");
    assert.deepEqual((events[1]?.steps as Array<{ label: string; status: string }>).map((step) => step.label), [
      "Find the governed sales view",
      "Query the supported sales measure",
      "Validate and present the answer",
    ]);
    assert.deepEqual((events[1]?.steps as Array<{ status: string }>).map((step) => step.status), [
      "active", "pending", "pending",
    ]);
    assert.equal(events[7]?.text, "Net sales were $100.00.");
    assert.equal(events.filter((event) => event.type === "narrative").length, 2);
    assert.doesNotMatch(JSON.stringify(events), /mapping the question|checking their definitions/iu);
    assert.doesNotMatch(JSON.stringify(events), /draft total/u);
    assert.doesNotMatch(JSON.stringify(events), /structured candidate/u);
    assert.doesNotMatch(JSON.stringify(events), /\$999/u);
    assert.equal(events[9]?.chartType, "bar");
    assert.equal(
      (events[9]?.flint as { chart_spec?: { chartType?: string } })?.chart_spec?.chartType,
      "Bar Chart",
    );
    assert.equal(events[9]?.dataRef, events[8]?.resultId);
    assert.match(String(events[10]?.label), /repairing/u);
    const planEvents = events.filter((event) => event.type === "plan");
    assert.equal(planEvents.length, 3);
    assert.deepEqual((planEvents.at(-1)?.steps as Array<{ status: string }>).map((step) => step.status), [
      "done", "incomplete", "done",
    ]);
    const answer = events.at(-1);
    assert.equal(answer?.state, "Verified");
    assert.equal(answer?.text, "Net sales were $100.00.");
    assert.equal((answer?.presentedResultIds as unknown[])?.length, 1);
    assert.equal((answer?.claims as unknown[])?.length, 1);
    assert.equal(((answer?.claims as Array<{ refs?: unknown[] }>)?.[0]?.refs ?? []).length, 2);
  } finally {
    cube.close();
    await once(cube, "close");
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex persists past blank catalogue prices and checks observed sale-line prices before answering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "albert-codex-price-recovery-"));
  const binary = join(directory, "codex-price-recovery-fixture");
  const source = `#!/usr/bin/env node
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
const threadId = "thr_price_recovery";
let turnNumber = 0;
let turnId = "";
let resultId = "";
const finish = (value) => {
  send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "msg_" + turnNumber, text: JSON.stringify(value), phase: "final_answer" } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", durationMs: 5 } } });
};
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === "turn/start") {
    turnNumber += 1;
    turnId = "turn_price_" + turnNumber;
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (turnNumber === 1) {
      return setImmediate(() => send({
        method: "item/tool/call", id: 70,
        params: {
          threadId, turnId, callId: "price_catalogue", namespace: "albert", tool: "run_semantic_query",
          arguments: {
            topic: "Current catalogue prices",
            query: {
              dimensions: [
                "inventory_analytics.items_item_id",
                "inventory_analytics.items_name",
                "inventory_analytics.items_default_price",
                "inventory_analytics.items_msrp"
              ],
              limit: 5
            }
          }
        }
      }));
    }
    if (!String(message.params.input?.[0]?.text || "").includes("product_sales_analytics")) {
      return finish({ state: "Unavailable", answer: "The required recovery instruction was missing.", followUps: [], presentedResultIds: [], claims: [] });
    }
    return setImmediate(() => send({
      method: "item/tool/call", id: 71,
      params: {
        threadId, turnId, callId: "price_observed", namespace: "albert", tool: "run_semantic_query",
        arguments: {
          topic: "Last observed normal selling price",
          query: {
            dimensions: [
              "product_sales_analytics.items_item_id",
              "product_sales_analytics.items_name",
              "product_sales_analytics.normal_unit_price"
            ],
            limit: 5
          }
        }
      }
    }));
  }
  if (message.id === 70 && message.result) {
    const tool = JSON.parse(message.result.contentItems[0].text);
    if (!String(tool.recoveryGuidance || "").includes("product_sales_analytics")) {
      return finish({ state: "Unavailable", answer: "The price recovery guidance was missing.", followUps: [], presentedResultIds: [], claims: [] });
    }
    resultId = tool.resultId;
    return finish({
      state: "Qualified",
      answer: "Current selling prices aren’t available in the governed catalogue data.",
      followUps: [],
      presentedResultIds: [resultId],
      claims: []
    });
  }
  if (message.id === 71 && message.result) {
    const tool = JSON.parse(message.result.contentItems[0].text);
    resultId = tool.resultId;
    return finish({
      state: "Qualified",
      answer: "The last observed normal selling price was $4999.",
      followUps: [],
      presentedResultIds: [resultId],
      claims: [{
        statement: "Normal unit price was 4999.", assertion: "value",
        refs: [{ resultId, rowIndex: 0, columnKey: "product_sales_analytics.normal_unit_price" }]
      }]
    });
  }
});
`;
  await writeFile(binary, source, "utf8");
  await chmod(binary, 0o755);

  const cube = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/cubejs-api/v1/meta")) {
      response.end(JSON.stringify({ cubes: [
        {
          name: "inventory_analytics", title: "Inventory analytics", description: "Current inventory and catalogue prices.", public: true,
          measures: [],
          dimensions: [
            { name: "inventory_analytics.items_item_id", title: "Item ID", shortTitle: "Item ID", type: "number" },
            { name: "inventory_analytics.items_name", title: "Item name", shortTitle: "Item name", type: "string" },
            { name: "inventory_analytics.items_default_price", title: "Default retail price", shortTitle: "Default retail price", type: "number", format: "currency" },
            { name: "inventory_analytics.items_msrp", title: "MSRP", shortTitle: "MSRP", type: "number", format: "currency" },
          ], segments: [],
        },
        {
          name: "product_sales_analytics", title: "Product sales analytics", description: "Observed completed sale-line prices.", public: true,
          measures: [],
          dimensions: [
            { name: "product_sales_analytics.items_item_id", title: "Item ID", shortTitle: "Item ID", type: "number" },
            { name: "product_sales_analytics.items_name", title: "Item name", shortTitle: "Item name", type: "string" },
            { name: "product_sales_analytics.normal_unit_price", title: "Normal unit price", shortTitle: "Normal unit price", type: "number", format: "currency" },
          ], segments: [],
        },
      ] }));
      return;
    }
    const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("query") ?? "";
    const observed = query.includes("product_sales_analytics");
    response.end(JSON.stringify(observed ? {
        data: [{
          "product_sales_analytics.items_item_id": 101,
          "product_sales_analytics.items_name": "Fixture bicycle",
          "product_sales_analytics.normal_unit_price": 4999,
        }],
        annotation: { dimensions: {
          "product_sales_analytics.items_item_id": { title: "Item ID", shortTitle: "Item ID", type: "number" },
          "product_sales_analytics.items_name": { title: "Item name", shortTitle: "Item name", type: "string" },
          "product_sales_analytics.normal_unit_price": { title: "Normal unit price", shortTitle: "Normal unit price", type: "number", format: "currency" },
        } },
      } : {
        data: [{
          "inventory_analytics.items_item_id": 101,
          "inventory_analytics.items_name": "Fixture bicycle",
          "inventory_analytics.items_default_price": null,
          "inventory_analytics.items_msrp": null,
        }],
        annotation: { dimensions: {
          "inventory_analytics.items_item_id": { title: "Item ID", shortTitle: "Item ID", type: "number" },
          "inventory_analytics.items_name": { title: "Item name", shortTitle: "Item name", type: "string" },
          "inventory_analytics.items_default_price": { title: "Default retail price", shortTitle: "Default retail price", type: "number", format: "currency" },
          "inventory_analytics.items_msrp": { title: "MSRP", shortTitle: "MSRP", type: "number", format: "currency" },
        } },
      }));
  });
  cube.listen(0, "127.0.0.1");
  await once(cube, "listening");
  const address = cube.address();
  assert.ok(address && typeof address === "object");
  const tenantId = "01J00000000000000000000111";
  const conversationId = "01J00000000000000000000112";
  const turnId = "01J00000000000000000000113";
  const token = signCubeJwt({
    secret: "s".repeat(48), expiresInSeconds: 900,
    securityContext: {
      tenant_id: tenantId, role: "owner", specialist_agent_id: "general", specialist_agent_version: 1,
      conversation_id: conversationId, turn_id: turnId,
    },
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  try {
    const result = await runCodexSemanticTurn({
      turn: {
        protocolVersion: 1, requestId: "01J00000000000000000000114", tenantId,
        actorId: "11111111-1111-4111-8111-111111111111", role: "owner", conversationId, turnId,
        message: "What are the current selling prices for these products?", priorConversation: [], priorResults: [],
        activeConnectors: ["lightspeed-r"], connectorFreshness: [], cubeBearer: token,
        model: "gpt-5.6-luna", effort: "max", fastMode: true,
      },
      cubeApiUrl: `http://127.0.0.1:${address.port}`,
      authentication: { mode: "api", apiKey: "sk-fixture", baseUrl: "https://au.api.openai.com/v1" },
      codexBinaryPath: binary, emit: (event) => events.push(event),
    });
    assert.equal(result.answerState, "Qualified", JSON.stringify(events));
    assert.equal(result.queriesExecuted, 2);
    assert.equal(result.codexTurnId, "turn_price_2");
    assert.equal(events.filter((event) => event.type === "query").length, 2);
    assert.ok(events.some((event) => String(event.detail ?? "").includes("observed POS prices")));
    const answer = events.at(-1);
    assert.equal(answer?.type, "answer");
    assert.equal(answer?.text, "The last observed normal selling price was $4,999.00.");
  } finally {
    cube.close();
    await once(cube, "close");
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex source authority prefers operational POS sales and explicit Xero accounting", () => {
  assert.deepEqual(preferredCodexConnectors("How are sales and refunds going?"), ["lightspeed", "lightspeed-x"]);
  assert.deepEqual(preferredCodexConnectors("Show Xero P&L sales revenue"), ["xero"]);
  assert.deepEqual(preferredCodexConnectors("Who is rostered in Deputy?"), ["deputy"]);
});

test("referential period follow-ups answer immediately from the previous governed result", async () => {
  const tenantId = "01J00000000000000000000081";
  const conversationId = "01J00000000000000000000082";
  const turnId = "01J00000000000000000000083";
  const token = signCubeJwt({
    secret: "s".repeat(48),
    expiresInSeconds: 900,
    securityContext: {
      tenant_id: tenantId,
      role: "owner",
      specialist_agent_id: "general",
      specialist_agent_version: 1,
      conversation_id: conversationId,
      turn_id: turnId,
    },
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const result = await runCodexSemanticTurn({
    turn: {
      protocolVersion: 1,
      requestId: "01J00000000000000000000084",
      tenantId,
      actorId: "11111111-1111-4111-8111-111111111111",
      role: "owner",
      conversationId,
      turnId,
      message: "What tim period is that?",
      priorConversation: [
        { role: "user", text: "How are sales going?" },
        { role: "assistant", text: "Sales were slightly lower than last year." },
      ],
      priorResults: [{
        resultId: "01J00000000000000000000085",
        turnsAgo: 1,
        caption: "YTD sales comparison",
        presentation: "evidence",
        columns: [{ key: "sales.value", label: "Sales", type: "currency", currency: "AUD" }],
        rows: [{ "sales.value": 374596.41 }],
        rowCount: 1,
        view: "sales_analytics",
        connector: "lightspeed",
        sources: [{ connector: "lightspeed", label: "Lightspeed Retail R-Series sales", dataThrough: "2026-08-20" }],
        timeRange: {
          label: "1 January–20 August 2026 compared with the equivalent 2025 period",
          start: "2026-01-01",
          end: "2026-08-20",
          timezone: "Australia/Melbourne",
        },
        definitions: [],
        semanticBundleHash: "prior-ytd-sales",
        identityGraph: { version: 0, hash: "fixture" },
      }],
      activeConnectors: ["lightspeed-r"],
      connectorFreshness: [],
      cubeBearer: token,
      model: "gpt-5.6-luna",
      effort: "max",
      fastMode: true,
    },
    cubeApiUrl: "http://127.0.0.1:1",
    authentication: {
      mode: "api",
      apiKey: "not-used",
      baseUrl: "https://au.api.openai.com/v1",
    },
    codexBinaryPath: "/not-used",
    emit: (event) => events.push(event),
  });

  assert.equal(result.queriesExecuted, 0);
  assert.equal(result.codexThreadId, "conversation-fast-path");
  assert.deepEqual(events.map((event) => event.type), ["validation", "answer"]);
  assert.equal(
    events[1]?.text,
    "That result covered 1 January–20 August 2026 compared with the equivalent 2025 period.",
  );
  assert.equal(events.some((event) => event.type === "progress" || event.type === "query"), false);
});

test("Codex can answer a conversational follow-up from prior governed rows without requerying Cube", async () => {
  const priorResultId = "01J00000000000000000000091";
  const directory = await mkdtemp(join(tmpdir(), "albert-codex-prior-"));
  const binary = join(directory, "codex-prior-fixture");
  const source = `#!/usr/bin/env node
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
const threadId = "thr_prior_fixture";
const turnId = "turn_prior_1";
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method !== "turn/start") return;
  const input = message.params.input?.[0]?.text || "";
  if (!input.includes("${priorResultId}") || !input.includes("priorResults")) {
    return send({ id: message.id, error: { message: "prior result context missing" } });
  }
  send({ id: message.id, result: { turn: { id: turnId } } });
  const final = JSON.stringify({
    state: "Verified",
    answer: "The previous value was $100.",
    followUps: [],
    presentedResultIds: ["${priorResultId}"],
    claims: [{
      statement: "The previous value was $100.",
      assertion: "value",
      refs: [{ resultId: "${priorResultId}", rowIndex: 0, columnKey: "sales.value" }],
    }],
  });
  setImmediate(() => {
    send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "msg_prior", text: final, phase: "final_answer" } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", durationMs: 4 } } });
  });
});
`;
  await writeFile(binary, source, "utf8");
  await chmod(binary, 0o755);

  let cubeLoads = 0;
  const cube = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/cubejs-api/v1/meta")) {
      response.end(JSON.stringify({ cubes: [] }));
      return;
    }
    cubeLoads += 1;
    response.end(JSON.stringify({ data: [], annotation: {} }));
  });
  cube.listen(0, "127.0.0.1");
  await once(cube, "listening");
  const address = cube.address();
  assert.ok(address && typeof address === "object");

  const tenantId = "01J00000000000000000000092";
  const conversationId = "01J00000000000000000000093";
  const turnId = "01J00000000000000000000094";
  const token = signCubeJwt({
    secret: "s".repeat(48),
    expiresInSeconds: 900,
    securityContext: {
      tenant_id: tenantId,
      role: "owner",
      specialist_agent_id: "general",
      specialist_agent_version: 1,
      conversation_id: conversationId,
      turn_id: turnId,
    },
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  try {
    const result = await runCodexSemanticTurn({
      turn: {
        protocolVersion: 1,
        requestId: "01J00000000000000000000095",
        tenantId,
        actorId: "11111111-1111-4111-8111-111111111111",
        role: "owner",
        conversationId,
        turnId,
        message: "Can you remind me of that value?",
        priorConversation: [
          { role: "user", text: "Which category led?" },
          { role: "assistant", text: "Bikes led at $100." },
        ],
        priorResults: [{
          resultId: priorResultId,
          turnsAgo: 1,
          caption: "Category sales",
          presentation: "evidence",
          columns: [
            { key: "sales.category", label: "Category", type: "string" },
            { key: "sales.value", label: "Sales", type: "currency", currency: "AUD" },
          ],
          rows: [{ "sales.category": "Bikes", "sales.value": 100 }],
          rowCount: 1,
          view: "sales_analytics",
          connector: "lightspeed",
          sources: [{ connector: "lightspeed", label: "Lightspeed Retail R-Series sales", dataThrough: "2026-08-20" }],
          timeRange: {
            label: "August 2026",
            start: "2026-08-01",
            end: "2026-08-20",
            timezone: "Australia/Melbourne",
          },
          definitions: [],
          semanticBundleHash: "prior-category-sales",
          identityGraph: { version: 0, hash: "fixture" },
        }],
        activeConnectors: ["lightspeed-r"],
        connectorFreshness: [],
        cubeBearer: token,
        model: "gpt-5.6-luna",
        effort: "max",
        fastMode: true,
      },
      cubeApiUrl: `http://127.0.0.1:${address.port}`,
      authentication: {
        mode: "api",
        apiKey: "sk-fixture",
        baseUrl: "https://au.api.openai.com/v1",
      },
      codexBinaryPath: binary,
      emit: (event) => events.push(event),
    });
    assert.equal(result.queriesExecuted, 0);
    assert.equal(cubeLoads, 0);
    assert.deepEqual(events.map((event) => event.type), ["progress", "table", "validation", "table", "answer"]);
    assert.match(String(events.at(-1)?.text), /\$100\.00/u);
    assert.equal(events[1]?.resultId, priorResultId);
  } finally {
    cube.close();
    await once(cube, "close");
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex safely validates identical scalar metrics queried over two periods", () => {
  const result = (input: Readonly<{
    resultId: string;
    start: string;
    end: string;
    value: number;
  }>): CodexEvidenceResult => ({
    resultId: input.resultId,
    topic: `${input.start} to ${input.end}`,
    view: "sales_analytics",
    connector: "lightspeed",
    query: {
      measures: ["sales_analytics.gross_takings"],
      timeDimensions: [{
        dimension: "sales_analytics.completed_at",
        dateRange: [input.start, input.end],
      }],
    },
    queryYaml: `dateRange: [${input.start}, ${input.end}]`,
    columns: [{
      key: "sales_analytics.gross_takings",
      label: "Gross takings",
      type: "currency",
      currency: "AUD",
    }],
    rows: [{ "sales_analytics.gross_takings": input.value }],
    provenance: {
      sources: [{ connector: "lightspeed", label: "Lightspeed", dataThrough: "2026-07-31" }],
      timeRange: {
        label: `${input.start} to ${input.end}`,
        start: input.start,
        end: input.end,
        timezone: "Australia/Melbourne",
      },
      definitions: [{
        metric: "sales_analytics.gross_takings",
        label: "Gross takings",
        definition: "Completed, non-voided tax-inclusive sales.",
        view: "sales_analytics",
        kind: "measure",
      }],
      semanticBundleHash: `fixture-${input.start}`,
      identityGraph: { version: 0, hash: "fixture" },
    },
    executionMs: 10,
    rowCount: 1,
  });
  const currentId = "01J00000000000000000000051";
  const priorId = "01J00000000000000000000052";
  const evidence = [
    result({ resultId: currentId, start: "2025-08-01", end: "2026-07-31", value: 120 }),
    result({ resultId: priorId, start: "2024-08-01", end: "2025-07-31", value: 100 }),
  ];
  const validated = validateCodexFinalAnswer({
    state: "Verified",
    answer: "Gross takings were AUD 120, higher than AUD 100 in the prior period.",
    followUps: ["Break this down by month"],
    presentedResultIds: [currentId, priorId],
    claims: [{
      statement: "Gross takings of 120 were higher than Gross takings of 100.",
      assertion: "greater_than",
      refs: [
        { resultId: currentId, rowIndex: 0, columnKey: "sales_analytics.gross_takings" },
        { resultId: priorId, rowIndex: 0, columnKey: "sales_analytics.gross_takings" },
      ],
    }],
  }, evidence);

  assert.equal(validated.final.state, "Verified", validated.validationDetail);
  assert.equal(validated.claims.length, 1);
  assert.deepEqual(validated.claims[0]?.refs, [
    { resultId: currentId, rowIndex: 0, columnKey: "sales_analytics.gross_takings" },
    { resultId: priorId, rowIndex: 0, columnKey: "sales_analytics.gross_takings" },
  ]);

  const incompatible = evidence.map((item, index) => index === 1 ? {
    ...item,
    query: {
      ...item.query,
      filters: [{ member: "sales_analytics.shop_name", operator: "equals" as const, values: ["Other shop"] }],
    },
  } : item);
  assert.equal(validateCodexFinalAnswer({
    state: "Verified",
    answer: "Gross takings were AUD 120, higher than AUD 100 in the prior period.",
    followUps: [],
    presentedResultIds: [currentId, priorId],
    claims: [{
      statement: "Gross takings of 120 were higher than Gross takings of 100.",
      assertion: "greater_than",
      refs: [
        { resultId: currentId, rowIndex: 0, columnKey: "sales_analytics.gross_takings" },
        { resultId: priorId, rowIndex: 0, columnKey: "sales_analytics.gross_takings" },
      ],
    }],
  }, incompatible).final.state, "Unavailable");
});

test("Codex canonicalizes compareDateRange claim prose and supplies governed row labels", () => {
  const resultId = "01J00000000000000000000061";
  const evidence: CodexEvidenceResult[] = [{
    resultId,
    topic: "Current period versus prior period",
    view: "sales_analytics",
    connector: "lightspeed",
    query: {
      measures: ["sales_analytics.gross_takings"],
      timeDimensions: [{
        dimension: "sales_analytics.completed_at",
        compareDateRange: [
          ["2025-08-01", "2026-07-31"],
          ["2024-08-01", "2025-07-31"],
        ],
      }],
    },
    queryYaml: "compareDateRange: current vs prior",
    columns: [
      { key: "sales_analytics.gross_takings", label: "Gross takings (inc tax)", type: "currency", currency: "AUD" },
      { key: "compare_date_range", label: "Comparison period", type: "string" },
    ],
    rows: [
      { "sales_analytics.gross_takings": 120, compare_date_range: "2025-08-01 - 2026-07-31" },
      { "sales_analytics.gross_takings": 100, compare_date_range: "2024-08-01 - 2025-07-31" },
    ],
    provenance: {
      sources: [{ connector: "lightspeed", label: "Lightspeed", dataThrough: "2026-07-31" }],
      timeRange: {
        label: "Comparing current with prior",
        start: "unknown",
        end: "unknown",
        timezone: "Australia/Melbourne",
      },
      definitions: [{
        metric: "sales_analytics.gross_takings",
        label: "Gross takings (inc tax)",
        definition: "Completed, non-voided tax-inclusive sales.",
        view: "sales_analytics",
        kind: "measure",
      }],
      semanticBundleHash: "fixture-compare-date-range",
      identityGraph: { version: 0, hash: "fixture" },
    },
    executionMs: 10,
    rowCount: 2,
  }];
  const draft = {
    state: "Verified" as const,
    answer: "Gross takings were AUD 120 versus AUD 100 in the prior period.",
    followUps: ["Break this down by month"],
    presentedResultIds: [resultId],
    claims: [{
      statement: "Sales improved year over year.",
      assertion: "greater_than" as const,
      refs: [
        { resultId, rowIndex: 0, columnKey: "sales_analytics.gross_takings" },
        { resultId, rowIndex: 1, columnKey: "sales_analytics.gross_takings" },
      ],
    }],
  };
  const validated = validateCodexFinalAnswer(draft, evidence);

  assert.equal(validated.final.state, "Verified", validated.validationDetail);
  assert.match(validated.claims[0]?.statement ?? "", /higher than/u);
  assert.deepEqual(validated.claims[0]?.refs, [
    { resultId, rowIndex: 0, columnKey: "sales_analytics.gross_takings" },
    { resultId, rowIndex: 1, columnKey: "sales_analytics.gross_takings" },
    { resultId, rowIndex: 0, columnKey: "compare_date_range" },
    { resultId, rowIndex: 1, columnKey: "compare_date_range" },
  ]);

  const reversedEvidence = [{
    ...evidence[0]!,
    rows: [
      { "sales_analytics.gross_takings": 80, compare_date_range: "2025-08-01 - 2026-07-31" },
      { "sales_analytics.gross_takings": 100, compare_date_range: "2024-08-01 - 2025-07-31" },
    ],
  }];
  assert.equal(validateCodexFinalAnswer({
    ...draft,
    answer: "Gross takings were AUD 80 versus AUD 100 in the prior period.",
  }, reversedEvidence).final.state, "Unavailable");
});

test("Codex atomizes grouped value claims and treats category labels as data", () => {
  const customerId = "01J00000000000000000000071";
  const ageingId = "01J00000000000000000000072";
  const provenance = {
    sources: [{ connector: "lightspeed" as const, label: "Lightspeed", dataThrough: "2026-07-31" }],
    timeRange: { label: "All history", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
    definitions: [],
    semanticBundleHash: "fixture-values",
    identityGraph: { version: 0, hash: "fixture" },
  };
  const evidence: CodexEvidenceResult[] = [
    {
      resultId: customerId,
      topic: "Customer health",
      view: "customer_analytics",
      connector: "lightspeed",
      query: { measures: ["customer_analytics.customer_count", "customer_analytics.repeat_customers"] },
      queryYaml: "customer values",
      columns: [
        { key: "customer_analytics.customer_count", label: "Customer count", type: "number" },
        { key: "customer_analytics.repeat_customers", label: "Repeat customers", type: "number" },
      ],
      rows: [{
        "customer_analytics.customer_count": 9614,
        "customer_analytics.repeat_customers": 4150,
      }],
      provenance,
      executionMs: 10,
      rowCount: 1,
    },
    {
      resultId: ageingId,
      topic: "Aged inventory",
      view: "inventory_analytics",
      connector: "lightspeed",
      query: {
        measures: ["inventory_analytics.stock_value"],
        dimensions: ["inventory_analytics.stock_age_band"],
      },
      queryYaml: "aged inventory",
      columns: [
        { key: "inventory_analytics.stock_age_band", label: "Stock age band", type: "string" },
        { key: "inventory_analytics.stock_value", label: "Stock value (at cost)", type: "currency", currency: "AUD" },
      ],
      rows: [{
        "inventory_analytics.stock_age_band": "Over 365 days",
        "inventory_analytics.stock_value": 60555,
      }],
      provenance,
      executionMs: 10,
      rowCount: 1,
    },
  ];
  const validated = validateCodexFinalAnswer({
    state: "Qualified",
    answer: "Customer count was 9,614 with 4,150 repeat customers. Over 365 days stock value was AUD 60,555.",
    followUps: [],
    presentedResultIds: [customerId, ageingId],
    claims: [
      {
        statement: "The customer base has two important headline figures.",
        assertion: "value",
        refs: [
          { resultId: customerId, rowIndex: 0, columnKey: "customer_analytics.customer_count" },
          { resultId: customerId, rowIndex: 0, columnKey: "customer_analytics.repeat_customers" },
        ],
      },
      {
        statement: "Old stock is material.",
        assertion: "value",
        refs: [
          { resultId: ageingId, rowIndex: 0, columnKey: "inventory_analytics.stock_value" },
          { resultId: ageingId, rowIndex: 0, columnKey: "inventory_analytics.stock_age_band" },
        ],
      },
    ],
  }, evidence);

  assert.equal(validated.final.state, "Qualified", validated.validationDetail);
  assert.equal(validated.claims.length, 3);
  assert.match(validated.claims[2]?.statement ?? "", /Over 365 days/u);
  assert.deepEqual(validated.claims[2]?.refs, [
    { resultId: ageingId, rowIndex: 0, columnKey: "inventory_analytics.stock_value" },
    { resultId: ageingId, rowIndex: 0, columnKey: "inventory_analytics.stock_age_band" },
  ]);
});

test("Codex formats governed figures for an owner instead of exposing raw Cube precision", () => {
  const result: CodexEvidenceResult = {
    resultId: "01J00000000000000000000081",
    topic: "Operational comparison",
    view: "sales_analytics",
    connector: "lightspeed",
    query: { measures: ["sales_analytics.gross_takings"] },
    queryYaml: "fixture",
    columns: [
      { key: "gross", label: "Gross takings", type: "currency", currency: "AUD" },
      { key: "transactions", label: "Transactions", type: "number" },
      { key: "average", label: "Average sale value", type: "currency", currency: "AUD" },
      { key: "margin", label: "Gross margin", type: "percent" },
      { key: "hours", label: "Hours worked", type: "number" },
      { key: "units", label: "Units sold", type: "number" },
      { key: "labour", label: "Workshop labour hours", type: "number" },
    ],
    rows: [{
      gross: 136233.12,
      transactions: 1399,
      average: 142.80201257861635,
      margin: 58.60990480819966,
      hours: 1049.6,
      units: 511,
      labour: 0,
    }],
    provenance: {
      sources: [{ connector: "lightspeed", label: "Lightspeed", dataThrough: "2026-07-31" }],
      timeRange: { label: "Fixture", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
      definitions: [],
      semanticBundleHash: "fixture-formatting",
      identityGraph: { version: 0, hash: "fixture" },
    },
    executionMs: 10,
    rowCount: 1,
  };
  const formatted = formatCodexAnswerText(
    "Gross takings were AUD 136233.1200 across 1399 transactions. Average sale value was AUD 142.8020125786163522, gross margin was 58.6099048081996594%, hours were 1049.6, units were 511.0000, and labour was 0.00000000000000000000.",
    [result],
  );

  assert.match(formatted, /\$136,233\.12/u);
  assert.match(formatted, /1,399 transactions/u);
  assert.match(formatted, /\$142\.80/u);
  assert.match(formatted, /58\.61%/u);
  assert.match(formatted, /hours were 1,049\.6/u);
  assert.match(formatted, /units were 511/u);
  assert.match(formatted, /labour was 0\./u);
  assert.doesNotMatch(formatted, /802012|609904|0000000000/u);

  const inferredUnits = formatCodexAnswerText(
    "Gross takings were 136233.1200, average sale value was 142.8020125786163522, and gross margin was 58.6099048081996594.",
    [result],
  );
  assert.match(inferredUnits, /\$136,233\.12/u);
  assert.match(inferredUnits, /\$142\.80/u);
  assert.match(inferredUnits, /58\.61%/u);

  // Ordered-list markers number the presentation, not the business: even when
  // a currency cell happens to equal the marker, "1." must never render as
  // "$1.00." (it did, on a goal-seek recommendations list). A dangling empty
  // list item is a composition slip and is dropped.
  const withMarkerCollision: CodexEvidenceResult = {
    ...result,
    columns: [{ key: "count", label: "Shifts", type: "currency", currency: "AUD" }],
    rows: [{ count: 1 }],
  };
  const listSafe = formatCodexAnswerText(
    "**Plan.**\n\n1. **Labour:** cut overlap.\n2. **Subscriptions:** audit.\n4.\n",
    [withMarkerCollision],
  );
  assert.match(listSafe, /^1\. \*\*Labour/mu);
  assert.doesNotMatch(listSafe, /\$1\.00\./u);
  assert.doesNotMatch(listSafe, /^4\.\s*$/mu);

  // Bare integers are counts, dates and durations, not cell pastes: "12
  // months" must not become "$12.00 months" (and "31 July" not "$31.00 July")
  // just because a governed cell holds that many dollars or percent.
  const withIntegerCollision: CodexEvidenceResult = {
    ...result,
    columns: [
      { key: "amt", label: "Amount", type: "currency", currency: "AUD" },
      { key: "pct", label: "Share", type: "percent" },
    ],
    rows: [{ amt: 12, pct: 31 }],
  };
  const integerSafe = formatCodexAnswerText(
    "Across the last 12 months, ending 31 July 2026.",
    [withIntegerCollision],
  );
  assert.equal(integerSafe, "Across the last 12 months, ending 31 July 2026.");
});

test("answer provenance takes its window from this turn's evidence, not replayed prior results", async () => {
  const { answerProvenance } = await import("../../packages/albert-codex/src/semantic-runtime.ts");
  const base = {
    topic: "fixture",
    view: "sales_analytics",
    connector: "lightspeed",
    query: {},
    queryYaml: "fixture",
    columns: [{ key: "sales_analytics.gross_takings", label: "Gross takings", type: "currency" as const, currency: "AUD" }],
    rows: [{ "sales_analytics.gross_takings": 1 }],
    executionMs: 1,
    rowCount: 1,
  };
  const provenanceFor = (label: string) => ({
    sources: [{ connector: "lightspeed", label: "Cube · lightspeed", dataThrough: "2026-08-20" }],
    timeRange: { label, start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
    definitions: [],
    semanticBundleHash: "fixture",
    identityGraph: { version: 0, hash: "fixture" },
  });
  const prior: CodexEvidenceResult = {
    ...base,
    resultId: "01J00000000000000000000301",
    provenance: provenanceFor("2026-08-17 to 2026-08-24"),
    priorTurnsAgo: 1,
  };
  const current: CodexEvidenceResult = {
    ...base,
    resultId: "01J00000000000000000000302",
    provenance: provenanceFor("2026-06-15 to 2026-08-24"),
  };
  const provenance = answerProvenance([prior, current], "Australia/Melbourne");
  assert.equal(provenance.timeRange.label, "2026-06-15 to 2026-08-24");
  // With only prior evidence, its window is still better than nothing.
  assert.equal(answerProvenance([prior], "Australia/Melbourne").timeRange.label, "2026-08-17 to 2026-08-24");
});

test("the bold lead keeps the finding but loses any literal label prefix", async () => {
  const { formatCodexAnswerText } = await import("../../packages/albert-codex/src/semantic-runtime.ts");
  assert.equal(
    formatCodexAnswerText("**Bottom line: the last 10 weeks delivered strong results.**\nDetail.", []),
    "**The last 10 weeks delivered strong results.**\nDetail.",
  );
  assert.equal(
    formatCodexAnswerText("**Bottom line — takings fell.**", []),
    "**Takings fell.**",
  );
  assert.equal(
    formatCodexAnswerText("**Summary: margins held.**", []),
    "**Margins held.**",
  );
  // A lead that is already just the finding is untouched.
  assert.equal(
    formatCodexAnswerText("**Takings fell while margins held.**", []),
    "**Takings fell while margins held.**",
  );
});

test("key insight cards keep grounded figures and drop invented ones", async () => {
  const { filterCodexKeyInsights } = await import("../../packages/albert-codex/src/semantic-runtime.ts");
  const evidence: CodexEvidenceResult = {
    resultId: "01J00000000000000000000401",
    topic: "Weekly sales",
    view: "sales_analytics",
    connector: "lightspeed",
    query: {},
    queryYaml: "fixture",
    columns: [
      { key: "sales_analytics.completed_at.week", label: "Week", type: "datetime" },
      { key: "sales_analytics.gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
    ],
    rows: [
      { "sales_analytics.completed_at.week": "2026-06-22T00:00:00.000", "sales_analytics.gross_takings": 15160.36 },
      { "sales_analytics.completed_at.week": "2026-08-03T00:00:00.000", "sales_analytics.gross_takings": 5638.3 },
    ],
    provenance: {
      sources: [{ connector: "lightspeed", label: "Cube · lightspeed", dataThrough: "2026-08-20" }],
      timeRange: { label: "2026-06-15 to 2026-08-23", start: "2026-06-15", end: "2026-08-23", timezone: "Australia/Melbourne" },
      definitions: [],
      semanticBundleHash: "fixture",
      identityGraph: { version: 0, hash: "fixture" },
    },
    executionMs: 1,
    rowCount: 2,
  };
  const filtered = filterCodexKeyInsights([
    { value: "$15,160.36", label: "Peak week", detail: "w/c 22 June", sentiment: "positive" },
    { value: "$5,638.30", label: "Trough week", detail: "w/c 3 August", sentiment: "negative" },
    { value: "-62%", label: "Peak to trough", detail: "", sentiment: "negative" },
    { value: "Trending down", label: "Direction", detail: "since late July", sentiment: "negative" },
  ], [evidence]);
  // The invented -62% never appeared in a cell; the number-free state card needs none.
  assert.deepEqual(filtered.map((insight) => insight.value), ["$15,160.36", "$5,638.30", "Trending down"]);
  assert.equal(filtered[0]?.sentiment, "positive");
  assert.equal(filtered[2]?.detail, "since late July");
  // Duplicates collapse; sentiment defaults to neutral.
  const deduped = filterCodexKeyInsights([
    { value: "$5,638.30", label: "Trough week" },
    { value: "$5,638.30", label: "Trough week" },
  ], [evidence]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.sentiment, "neutral");
});

test("the commentary truth gate forwards clean narration and suppresses leaks", async () => {
  const { gatedCodexCommentary } = await import("../../packages/albert-codex/src/semantic-runtime.ts");
  const evidence: CodexEvidenceResult = {
    resultId: "01J00000000000000000000501",
    topic: "Weekly sales",
    view: "sales_analytics",
    connector: "lightspeed",
    query: {},
    queryYaml: "fixture",
    columns: [{ key: "sales_analytics.gross_takings", label: "Gross takings", type: "currency", currency: "AUD" }],
    rows: [{ "sales_analytics.gross_takings": 15160.36 }],
    provenance: {
      sources: [{ connector: "lightspeed", label: "Cube · lightspeed", dataThrough: "2026-08-20" }],
      timeRange: { label: "last 10 weeks", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
      definitions: [],
      semanticBundleHash: "fixture",
      identityGraph: { version: 0, hash: "fixture" },
    },
    executionMs: 1,
    rowCount: 1,
  };
  // Plain narration with no figures flows through.
  assert.equal(
    gatedCodexCommentary("The late-June week looks unusually strong — checking whether refunds explain it.", [evidence]),
    "The late-June week looks unusually strong — checking whether refunds explain it.",
  );
  // A figure that grounds against a retrieved cell is allowed.
  assert.equal(
    gatedCodexCommentary("Peak week takings reached $15,160.36 — comparing it with the rest.", [evidence]),
    "Peak week takings reached $15,160.36 — comparing it with the rest.",
  );
  // An invented figure, internal mechanics, and JSON all stay suppressed.
  assert.equal(gatedCodexCommentary("Sales were about $99,999 so far.", [evidence]), null);
  assert.equal(gatedCodexCommentary("The draft total needs one more claim ref.", [evidence]), null);
  assert.equal(gatedCodexCommentary('{"state":"Exploratory","answer":"nope"}', [evidence]), null);
  assert.equal(gatedCodexCommentary("ok", [evidence]), null);
});
