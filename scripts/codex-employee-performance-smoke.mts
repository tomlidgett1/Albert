import { createServer } from "node:http";
import { once } from "node:events";
import { ulid } from "ulid";
import { signCubeJwt } from "../packages/albert-v3/src/cube/jwt.js";
import { runCodexSemanticTurn } from "../packages/albert-codex/src/semantic-runtime.js";
import { buildSharedAnalyticalBrief } from "../services/conversation/src/analytical-brief.js";

const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
if (!apiKey) throw new Error("OPENAI_API_KEY is unavailable for the synthetic employee-performance smoke test.");

const cube = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url?.startsWith("/cubejs-api/v1/meta")) {
    response.end(JSON.stringify({ cubes: [
      {
        name: "sales_analytics", title: "Sales analytics", description: "Synthetic employee-attributed completed POS sales.", public: true,
        measures: [
          { name: "sales_analytics.gross_takings", title: "Gross takings", shortTitle: "Gross takings", type: "number", format: "currency" },
          { name: "sales_analytics.transactions", title: "Transactions", shortTitle: "Transactions", type: "number" },
          { name: "sales_analytics.average_sale_value", title: "Average sale value", shortTitle: "Average sale value", type: "number", format: "currency" },
          { name: "sales_analytics.gross_profit", title: "Gross profit", shortTitle: "Gross profit", type: "number", format: "currency" },
        ],
        dimensions: [
          { name: "sales_analytics.employees_full_name", title: "Employee", shortTitle: "Employee", type: "string" },
          { name: "sales_analytics.completed_at", title: "Completed at", shortTitle: "Completed at", type: "time" },
        ],
        segments: [{ name: "sales_analytics.completed_sales", title: "Completed sales", shortTitle: "Completed sales" }],
      },
      {
        name: "workforce_analytics", title: "Workforce analytics", description: "Synthetic authoritative Deputy worked hours.", public: true,
        measures: [
          { name: "workforce_analytics.hours_worked", title: "Hours worked", shortTitle: "Hours worked", type: "number" },
          { name: "workforce_analytics.wage_cost", title: "Wage cost", shortTitle: "Wage cost", type: "number", format: "currency" },
          { name: "workforce_analytics.worked_shift_count", title: "Worked shifts", shortTitle: "Worked shifts", type: "number" },
        ],
        dimensions: [
          { name: "workforce_analytics.worked_by", title: "Employee", shortTitle: "Employee", type: "string" },
          { name: "workforce_analytics.shift_date", title: "Shift date", shortTitle: "Shift date", type: "time" },
        ],
        segments: [{ name: "workforce_analytics.worked_shifts", title: "Worked shifts", shortTitle: "Worked shifts" }],
      },
    ] }));
    return;
  }
  const queryText = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("query") ?? "{}";
  const workforce = queryText.includes("workforce_analytics");
  response.end(JSON.stringify(workforce ? {
    data: [
      { "workforce_analytics.worked_by": "Leigh Phillips", "workforce_analytics.hours_worked": 96, "workforce_analytics.wage_cost": 2330.6, "workforce_analytics.worked_shift_count": 12 },
      { "workforce_analytics.worked_by": "Jack Lidgett", "workforce_analytics.hours_worked": 69.17, "workforce_analytics.wage_cost": 1729.25, "workforce_analytics.worked_shift_count": 9 },
      { "workforce_analytics.worked_by": "Angus McKinnon", "workforce_analytics.hours_worked": 12.11, "workforce_analytics.wage_cost": 0, "workforce_analytics.worked_shift_count": 2 },
    ],
    annotation: {
      measures: {
        "workforce_analytics.hours_worked": { title: "Hours worked", shortTitle: "Hours worked", type: "number" },
        "workforce_analytics.wage_cost": { title: "Wage cost", shortTitle: "Wage cost", type: "number", format: "currency" },
        "workforce_analytics.worked_shift_count": { title: "Worked shifts", shortTitle: "Worked shifts", type: "number" },
      },
      dimensions: { "workforce_analytics.worked_by": { title: "Employee", shortTitle: "Employee", type: "string" } },
    },
  } : {
    data: [
      { "sales_analytics.employees_full_name": "Leigh Phillips", "sales_analytics.gross_takings": 8515.38, "sales_analytics.transactions": 70, "sales_analytics.average_sale_value": 121.6483, "sales_analytics.gross_profit": 5200 },
      { "sales_analytics.employees_full_name": "Jack Lidgett", "sales_analytics.gross_takings": 5404.63, "sales_analytics.transactions": 45, "sales_analytics.average_sale_value": 120.1029, "sales_analytics.gross_profit": 3500 },
      { "sales_analytics.employees_full_name": "Angus McKinnon", "sales_analytics.gross_takings": 552.93, "sales_analytics.transactions": 9, "sales_analytics.average_sale_value": 61.4367, "sales_analytics.gross_profit": 300 },
    ],
    annotation: {
      measures: {
        "sales_analytics.gross_takings": { title: "Gross takings", shortTitle: "Gross takings", type: "number", format: "currency" },
        "sales_analytics.transactions": { title: "Transactions", shortTitle: "Transactions", type: "number" },
        "sales_analytics.average_sale_value": { title: "Average sale value", shortTitle: "Average sale value", type: "number", format: "currency" },
        "sales_analytics.gross_profit": { title: "Gross profit", shortTitle: "Gross profit", type: "number", format: "currency" },
      },
      dimensions: { "sales_analytics.employees_full_name": { title: "Employee", shortTitle: "Employee", type: "string" } },
    },
  }));
});

cube.listen(0, "127.0.0.1");
await once(cube, "listening");
const address = cube.address();
if (!address || typeof address === "string") throw new Error("Synthetic Cube server did not start.");

const tenantId = ulid();
const conversationId = ulid();
const turnId = ulid();
const analysisBrief = buildSharedAnalyticalBrief({
  message: "I need an overview of which employee has performed the best this month - give me your thinking.",
  activeConnectors: ["lightspeed-r", "deputy", "xero"],
  connectorFreshness: [
    { connector: "lightspeed", dataThrough: "2026-08-20" },
    { connector: "deputy", dataThrough: "2026-08-16" },
  ],
});
if (!analysisBrief) throw new Error("Employee analytical brief was not created.");
const cubeBearer = signCubeJwt({
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
const startedAt = Date.now();
try {
  const result = await runCodexSemanticTurn({
    turn: {
      protocolVersion: 1,
      requestId: ulid(),
      tenantId,
      actorId: "11111111-1111-4111-8111-111111111111",
      role: "owner",
      conversationId,
      turnId,
      message: "I need an overview of which employee has performed the best this month - give me your thinking.",
      priorConversation: [],
      priorResults: [],
      activeConnectors: ["lightspeed-r", "deputy", "xero"],
      connectorFreshness: [
        { connector: "lightspeed", domain: "sales", dataThrough: "2026-08-20" },
        { connector: "deputy", domain: "workforce", dataThrough: "2026-08-16" },
      ],
      analysisBrief,
      cubeBearer,
      model: "gpt-5.6-luna",
      effort: "max",
      fastMode: true,
    },
    cubeApiUrl: `http://127.0.0.1:${address.port}`,
    openaiApiKey: apiKey,
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    emit: (event) => events.push(event),
  });
  const queryEvents = events.filter((event) => event.type === "query");
  const tables = events.filter((event) => event.type === "table");
  const answer = [...events].reverse().find((event) => event.type === "answer");
  const answerText = typeof answer?.text === "string" ? answer.text : "";
  const views = queryEvents.map((event) => event.view).filter(Boolean);
  const alignedSales = queryEvents.some((event) => event.view === "sales_analytics" && JSON.stringify(event.timeRange).includes("2026-08-16"));
  const alignedWorkforce = queryEvents.some((event) => event.view === "workforce_analytics" && JSON.stringify(event.timeRange).includes("2026-08-16"));
  const derived = tables.some((event) => String(event.caption ?? "").includes("Employee productivity"));
  const passed = result.answerState !== "Unavailable"
    && views.includes("sales_analytics")
    && views.includes("workforce_analytics")
    && alignedSales
    && alignedWorkforce
    && derived
    && /worked hour|productiv/iu.test(answerText)
    && /label|identity|attribution/iu.test(answerText);
  process.stdout.write(`${JSON.stringify({
    syntheticOnly: true,
    model: "gpt-5.6-luna",
    effort: "max",
    fastMode: true,
    passed,
    answerState: result.answerState,
    queryCount: queryEvents.length,
    views,
    alignedSales,
    alignedWorkforce,
    derivedProductivityTable: derived,
    answerUsesProductivity: /worked hour|productiv/iu.test(answerText),
    answerDisclosesLimitation: /label|identity|attribution/iu.test(answerText),
    durationMs: Date.now() - startedAt,
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  cube.close();
  await once(cube, "close");
}
