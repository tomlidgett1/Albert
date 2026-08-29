import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.js";
import { loadAgentConfig } from "../../packages/albert-v3/src/agent-config/loader.js";
import type { CodexServiceTurn } from "../../packages/albert-codex/src/contracts.js";
import { matchCodexDeterministicRecipe } from "../../packages/albert-codex/src/recipe-runtime.js";
import { runCodexSemanticTurn } from "../../packages/albert-codex/src/semantic-runtime.js";

function fixtureTurn(
  message: string,
  token = "header.payload.signature",
  priorConversation: CodexServiceTurn["priorConversation"] = [],
  activeConnectors: string[] = ["lightspeed-r", "xero", "deputy"],
): CodexServiceTurn {
  return {
    protocolVersion: 1,
    requestId: "01J00000000000000000001001",
    tenantId: "01J00000000000000000001002",
    actorId: "11111111-1111-4111-8111-111111111111",
    role: "owner",
    conversationId: "01J00000000000000000001003",
    turnId: "01J00000000000000000001004",
    message,
    priorConversation,
    priorResults: [],
    activeConnectors,
    connectorFreshness: [{ connector: "lightspeed", domain: "sales", dataThrough: "2026-08-22" }],
    cubeBearer: token,
    model: "gpt-5.6-luna",
    effort: "max",
    fastMode: false,
  };
}

test("Codex deterministic recipes match scalar periods and reject grouped, comparative, and referential asks", () => {
  const config = loadAgentConfig();
  const matched = matchCodexDeterministicRecipe(fixtureTurn("Show me sales this week"), config);
  assert.equal(matched?.recipe.name, "recipe-sales-total-for-period");
  assert.equal(matched?.dateRange, "this week");
  assert.equal(matched?.periodLabel, "this week");
  assert.equal(matchCodexDeterministicRecipe(fixtureTurn("Show me sales per day this week"), config), undefined);
  // A coordinated multi-facet ask must never be answered by a one-facet recipe.
  assert.equal(matchCodexDeterministicRecipe(fixtureTurn("Show me sales, worked hours and cash in this week"), config), undefined);
  assert.equal(matchCodexDeterministicRecipe(fixtureTurn("Show me sales and hours this week"), config), undefined);
  // One recipe that already answers both named figures stays on the fast path.
  assert.equal(
    matchCodexDeterministicRecipe(fixtureTurn("Show me sales and transactions this week"), config)?.recipe.name,
    "recipe-sales-total-for-period",
  );
  assert.equal(matchCodexDeterministicRecipe(fixtureTurn("Compare sales this week with last week"), config), undefined);
  for (const risky of [
    "Why were sales weaker in June than May?",
    "Which supplier do we owe the most?",
    "How much did we buy from Pon Bike this year?",
    "Did anyone work on Sunday 16 August 2026?",
    "What was net profit last financial year?",
    "How's the workshop going?",
    "What share of sales came from repeat customers?",
    "Give me every customer's email and private notes",
    // Production misroutes 2026-08-29: analytical questions sharing one
    // keyword with a recipe were answered by that recipe in 2-3 seconds
    // ("Explain working capital…" → "Today's roster has 1 shift.").
    "The workshop guys reckon they're carrying the shop. Are they right?",
    "Explain working capital in terms of my actual business, and tell me where mine is tied up right now.",
    "Is the workshop actually worth it?",
  ]) {
    assert.equal(matchCodexDeterministicRecipe(fixtureTurn(risky), config), undefined, risky);
  }
  assert.equal(matchCodexDeterministicRecipe(
    fixtureTurn("Now show me that sales figure again", "header.payload.signature", [
      { role: "user", text: "Show me sales this week" },
      { role: "assistant", text: "Sales were $1,234.50." },
    ]),
    config,
  ), undefined);
});

test("Codex executes a certified sales-period recipe without starting the app-server loop", async () => {
  let authorization = "";
  let executedQuery: Record<string, unknown> | undefined;
  const cube = createServer((request, response) => {
    authorization = String(request.headers.authorization ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/cubejs-api/v1/meta")) {
      response.end(JSON.stringify({ cubes: [{
        name: "sales_analytics",
        title: "Sales analytics",
        description: "Governed completed sales.",
        public: true,
        measures: [
          { name: "sales_analytics.gross_takings", title: "Gross takings", shortTitle: "Gross takings", description: "Completed takings including tax.", type: "number", format: "currency", aliasMember: "sales.gross_takings" },
          { name: "sales_analytics.transactions", title: "Transactions", shortTitle: "Transactions", description: "Completed transaction count.", type: "number", aliasMember: "sales.transactions" },
          { name: "sales_analytics.average_sale_value", title: "Average sale value", shortTitle: "Average sale value", description: "Gross takings divided by transactions.", type: "number", format: "currency", aliasMember: "sales.average_sale_value" },
        ],
        dimensions: [
          { name: "sales_analytics.completed_at", title: "Completed at", shortTitle: "Completed at", description: "Sale completion time.", type: "time", aliasMember: "sales.completed_at" },
        ],
        segments: [],
      }] }));
      return;
    }
    const encoded = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("query");
    executedQuery = encoded ? JSON.parse(encoded) as Record<string, unknown> : undefined;
    response.end(JSON.stringify({
      data: [{
        "sales_analytics.gross_takings": "1234.5000",
        "sales_analytics.transactions": "10",
        "sales_analytics.average_sale_value": "123.4500",
      }],
      annotation: {
        measures: {
          "sales_analytics.gross_takings": { title: "Gross takings", shortTitle: "Gross takings", type: "number", format: "currency" },
          "sales_analytics.transactions": { title: "Transactions", shortTitle: "Transactions", type: "number" },
          "sales_analytics.average_sale_value": { title: "Average sale value", shortTitle: "Average sale value", type: "number", format: "currency" },
        },
        dimensions: {},
      },
    }));
  });
  cube.listen(0, "127.0.0.1");
  await once(cube, "listening");
  const address = cube.address();
  assert.ok(address && typeof address === "object");

  const tenantId = "01J00000000000000000001002";
  const conversationId = "01J00000000000000000001003";
  const turnId = "01J00000000000000000001004";
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
      turn: fixtureTurn("Show me sales this week", token),
      cubeApiUrl: `http://127.0.0.1:${address.port}`,
      authentication: {
        mode: "api",
        apiKey: "sk-fixture",
        baseUrl: "https://au.api.openai.com/v1",
      },
      codexBinaryPath: "/this/path/must/not/be-started",
      emit: (event) => events.push(event),
    });
    assert.equal(result.answerState, "Verified");
    assert.equal(result.queriesExecuted, 1);
    assert.equal(result.codexThreadId, "recipe-fast-path");
    assert.equal(result.codexTurnId, "recipe-fast-path");
    assert.equal(authorization, token);
    assert.equal(
      ((executedQuery?.timeDimensions as Array<{ dateRange?: string }> | undefined)?.[0]?.dateRange),
      "this week",
    );
    assert.deepEqual(events.map(({ type }) => type), ["progress", "query", "table", "validation", "answer"]);
    const answer = events.at(-1);
    assert.equal(
      answer?.text,
      "For this week, gross takings were **$1,234.50** across **10** transactions, averaging **$123.45** per sale.",
    );
    assert.equal((answer?.claims as unknown[])?.length, 3);
    assert.equal(events.some((event) => event.type === "progress" && /view definitions|planning/iu.test(String(event.label))), false);
  } finally {
    cube.close();
    await once(cube, "close");
  }
});

test("Codex executes a certified roster list recipe without starting the app-server loop", async () => {
  const cube = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/cubejs-api/v1/meta")) {
      response.end(JSON.stringify({ cubes: [{
        name: "workforce_analytics",
        title: "Workforce analytics",
        description: "Governed roster and timesheets.",
        public: true,
        measures: [
          { name: "workforce_analytics.rostered_hours", title: "Rostered hours", shortTitle: "Hours", description: "Planned shift hours.", type: "number" },
        ],
        dimensions: [
          { name: "workforce_analytics.rostered_staff", title: "Staff", shortTitle: "Staff", description: "Rostered person.", type: "string" },
          { name: "workforce_analytics.roster_starts_at", title: "Starts", shortTitle: "Starts", description: "Shift start.", type: "time" },
          { name: "workforce_analytics.roster_ends_at", title: "Ends", shortTitle: "Ends", description: "Shift end.", type: "time" },
          { name: "workforce_analytics.rostered_area", title: "Area", shortTitle: "Area", description: "Rostered area.", type: "string" },
          { name: "workforce_analytics.rostered_date", title: "Date", shortTitle: "Date", description: "Rostered day.", type: "time" },
        ],
        segments: [],
      }] }));
      return;
    }
    response.end(JSON.stringify({
      data: [
        {
          "workforce_analytics.rostered_hours": "8",
          "workforce_analytics.rostered_staff": "Alex",
          "workforce_analytics.roster_starts_at": "2026-08-24T09:00:00.000",
          "workforce_analytics.roster_ends_at": "2026-08-24T17:00:00.000",
          "workforce_analytics.rostered_area": "Workshop",
        },
        {
          "workforce_analytics.rostered_hours": "6",
          "workforce_analytics.rostered_staff": "Sam",
          "workforce_analytics.roster_starts_at": "2026-08-24T10:00:00.000",
          "workforce_analytics.roster_ends_at": "2026-08-24T16:00:00.000",
          "workforce_analytics.rostered_area": "Shop",
        },
      ],
      annotation: {
        measures: {
          "workforce_analytics.rostered_hours": { title: "Rostered hours", shortTitle: "Hours", type: "number" },
        },
        dimensions: {
          "workforce_analytics.rostered_staff": { title: "Staff", shortTitle: "Staff", type: "string" },
          "workforce_analytics.roster_starts_at": { title: "Starts", shortTitle: "Starts", type: "time" },
          "workforce_analytics.roster_ends_at": { title: "Ends", shortTitle: "Ends", type: "time" },
          "workforce_analytics.rostered_area": { title: "Area", shortTitle: "Area", type: "string" },
        },
      },
    }));
  });
  cube.listen(0, "127.0.0.1");
  await once(cube, "listening");
  const address = cube.address();
  assert.ok(address && typeof address === "object");

  const tenantId = "01J00000000000000000001002";
  const conversationId = "01J00000000000000000001003";
  const turnId = "01J00000000000000000001004";
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
      turn: fixtureTurn("Schedule tomorrow?", token),
      cubeApiUrl: `http://127.0.0.1:${address.port}`,
      authentication: {
        mode: "api",
        apiKey: "sk-fixture",
        baseUrl: "https://au.api.openai.com/v1",
      },
      codexBinaryPath: "/this/path/must-not-be-started",
      emit: (event) => events.push(event),
    });
    assert.equal(result.answerState, "Verified");
    assert.equal(result.queriesExecuted, 1);
    assert.equal(result.codexThreadId, "recipe-fast-path");
    const answer = events.at(-1);
    assert.equal(answer?.text, "The roster for tomorrow has **2 shifts**.");
    assert.deepEqual(answer?.presentedResultIds, [
      events.find((event) => event.type === "table")?.resultId,
    ]);
    assert.equal(events.find((event) => event.type === "table")?.presentation, "answer");
    assert.equal(events.some((event) => event.type === "progress" && /view definitions|planning/iu.test(String(event.label))), false);
  } finally {
    cube.close();
    await once(cube, "close");
  }
});

test("Codex deterministic recipes cover the common Lightspeed, Xero and Deputy owner surfaces", () => {
  const config = loadAgentConfig();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["How many sales did we make today?", "recipe-sales-total-for-period"],
    ["What were yesterday's takings?", "recipe-sales-total-for-period"],
    ["How many sales did we ring up last Saturday, and what was the average sale value?", "recipe-sales-total-for-period"],
    ["What's our average sale this week?", "recipe-sales-total-for-period"],
    ["How much GST did we collect last month?", "recipe-gst-collected-for-period"],
    ["How much did we refund last month?", "recipe-refunds-for-period"],
    ["How much stock do we have?", "recipe-stock-position"],
    ["How many customers do we have?", "recipe-customer-count"],
    ["How many open workshop jobs do we have?", "recipe-open-workshop-jobs"],
    ["How much is owed to us right now?", "recipe-receivables-outstanding"],
    ["How much do we currently owe suppliers?", "recipe-payables-outstanding"],
    ["Cash in and out this month", "recipe-bank-money-for-period"],
    ["How much is in the bank right now?", "recipe-cash-at-bank"],
    ["What was our net profit last month?", "xero-net-profit"],
    ["Gross profit last month", "xero-gross-profit-margin"],
    ["How much did wages reduce profit last year?", "xero-wages-in-profit"],
    ["Hours and wages last week", "recipe-hours-and-wages-total"],
    ["What did wages cost last month?", "recipe-hours-and-wages-total"],
    ["How many staff do we have?", "recipe-staff-count"],
    ["What will next week's roster cost us in wages?", "recipe-roster-cost-for-period"],
    ["Are there any open shifts this week?", "recipe-open-shift-count-for-period"],
    ["How many timesheets need approving?", "recipe-unapproved-timesheet-count"],
    ["Schedule tomorrow?", "recipe-roster-for-period"],
    ["What's the schedule tomorrow?", "recipe-roster-for-period"],
    ["Who is working tomorrow?", "recipe-roster-for-period"],
    ["Who is on tomorrow?", "recipe-roster-for-period"],
    ["Who is on shift right now?", "recipe-on-shift-now"],
    ["Who's on leave this week?", "recipe-leave-for-period"],
    ["Which shifts still need someone this week?", "recipe-open-shifts-for-period"],
  ];
  for (const [message, name] of cases) {
    const matched = matchCodexDeterministicRecipe(fixtureTurn(message), config);
    assert.equal(matched?.recipe.name, name, message);
  }
  assert.equal(matchCodexDeterministicRecipe(fixtureTurn("How much last month?"), config), undefined);
  assert.equal(matchCodexDeterministicRecipe(fixtureTurn("Which bills are overdue?"), config), undefined);
  assert.equal(
    matchCodexDeterministicRecipe(fixtureTurn("Are there any open shifts this week?"), config)?.recipe.name,
    "recipe-open-shift-count-for-period",
  );
});
