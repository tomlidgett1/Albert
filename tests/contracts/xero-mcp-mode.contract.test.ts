import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { XERO_DEFAULT_SCOPES, XERO_REPORT_SCOPES } from "../../connectors/xero/manifest";
import {
  australianFinancialYearStart,
  normaliseProfitAndLossArgs,
  xeroToolTextFailed,
} from "../../packages/xero-mcp/src/reports";

test("dash exposes a XERO MCP mode that talks to the official Xero MCP route", async () => {
  const page = await readFile(new URL("../../app/dash/page.tsx", import.meta.url), "utf8");
  const route = await readFile(new URL("../../app/api/xero-mcp-conversation/route.ts", import.meta.url), "utf8");
  const v3Route = await readFile(new URL("../../app/api/v3-conversation/route.ts", import.meta.url), "utf8");
  const session = await readFile(new URL("../../packages/xero-mcp/src/session.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../../services/sync-workers/src/main.ts", import.meta.url), "utf8");

  assert.doesNotMatch(page, /Live test: ask the official Xero MCP/u);
  assert.match(page, /resetChat\("xero_mcp", "general"\)/);
  assert.match(page, /\/api\/xero-mcp-conversation/);
  assert.match(page, /Ask Xero anything/);
  assert.match(route, /runXeroMcpTurn/);
  assert.match(route, /X-Albert-Runtime/);
  assert.match(v3Route, /xeroMcpServiceUrl\(\)/u);
  assert.match(session, /@xeroapi\/xero-mcp-server@0\.0\.17/);
  assert.match(session, /XERO_CLIENT_BEARER_TOKEN/);
  assert.match(worker, /\/v1\/xero-mcp\//);
});

test("Xero AUTH requests every official MCP report scope", () => {
  for (const scope of XERO_REPORT_SCOPES) {
    assert.equal(XERO_DEFAULT_SCOPES.includes(scope), true, scope);
  }
  assert.equal(XERO_DEFAULT_SCOPES.includes("accounting.invoices"), true);
  assert.equal(XERO_DEFAULT_SCOPES.includes("accounting.settings"), true);
  assert.equal(XERO_DEFAULT_SCOPES.includes("payroll.employees"), true);
});

test("P&L windows longer than a year are clamped to the current Australian FY", () => {
  const now = new Date("2026-08-17T00:00:00.000Z");
  const normalised = normaliseProfitAndLossArgs({
    fromDate: "2025-01-01",
    standardLayout: true,
  }, now);
  assert.equal(normalised.adjusted, true);
  assert.equal(normalised.arguments.fromDate, "2026-07-01");
  assert.equal(normalised.arguments.toDate, "2026-08-17");
  assert.equal(australianFinancialYearStart("2026-06-30"), "2025-07-01");
  assert.equal(xeroToolTextFailed("Error listing profit and loss report: An unexpected error occurred while communicating with Xero."), true);
});

test("P&L normalisation keeps presentation options while clamping the window", () => {
  const now = new Date("2026-08-17T00:00:00.000Z");
  const normalised = normaliseProfitAndLossArgs({
    fromDate: "2026-07-01",
    toDate: "2026-07-31",
    periods: 3,
    timeframe: "MONTH",
    paymentsOnly: true,
    trackingCategoryID: "ignored",
  }, now);
  assert.equal(normalised.adjusted, false);
  assert.deepEqual(normalised.arguments, {
    periods: 3,
    timeframe: "MONTH",
    paymentsOnly: true,
    fromDate: "2026-07-01",
    toDate: "2026-07-31",
  });
});

test("Xero MCP service URL resolves the same way on localhost and Vercel", async () => {
  const { xeroMcpServiceUrl } = await import("../../packages/xero-mcp/src/client");
  const saved = {
    XERO_MCP_SERVICE_URL: process.env.XERO_MCP_SERVICE_URL,
    SYNC_WORKER_INTERNAL_URL: process.env.SYNC_WORKER_INTERNAL_URL,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
  try {
    delete process.env.XERO_MCP_SERVICE_URL;
    delete process.env.VERCEL_ENV;
    process.env.SYNC_WORKER_INTERNAL_URL = "https://albert-sync-worker.example.fly.dev/";
    // localhost with the worker configured → the worker, not the sidecar.
    assert.equal(xeroMcpServiceUrl(), "https://albert-sync-worker.example.fly.dev");
    process.env.VERCEL_ENV = "production";
    assert.equal(xeroMcpServiceUrl(), "https://albert-sync-worker.example.fly.dev");
    // Explicit override always wins (local sidecar while working on the MCP layer).
    process.env.XERO_MCP_SERVICE_URL = "http://127.0.0.1:8791/";
    assert.equal(xeroMcpServiceUrl(), "http://127.0.0.1:8791");
    // Nothing configured → the local sidecar as a last resort.
    delete process.env.XERO_MCP_SERVICE_URL;
    delete process.env.SYNC_WORKER_INTERNAL_URL;
    delete process.env.VERCEL_ENV;
    assert.equal(xeroMcpServiceUrl(), "http://127.0.0.1:8791");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("v3 routes P&L figures to Cube while retaining the native Xero statement tool", async () => {
  const tools = await readFile(new URL("../../packages/albert-v3/src/engine/tools.ts", import.meta.url), "utf8");
  const lanes = await readFile(new URL("../../packages/albert-v3/src/engine/lanes.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../../app/api/v3-conversation/route.ts", import.meta.url), "utf8");
  for (const [tool, mcp] of [
    ["xero_balance_sheet", "list-report-balance-sheet"],
    ["xero_trial_balance", "list-trial-balance"],
    ["xero_aged_receivables", "list-aged-receivables-by-contact"],
    ["xero_aged_payables", "list-aged-payables-by-contact"],
    ["xero_find_contact", "list-contacts"],
    ["xero_organisation_details", "list-organisation-details"],
  ]) {
    assert.match(tools, new RegExp(`name: "${tool}"`), tool);
    assert.match(tools, new RegExp(`mcpTool: "${mcp}"`), mcp);
    assert.match(lanes, new RegExp(tool!), `${tool} in lane guidance`);
  }
  assert.match(tools, /name: "xero_profit_and_loss"/u);
  assert.match(tools, /mcpTool: "list-profit-and-loss"/u);
  assert.match(lanes, /xero_profit_and_loss_analytics/u);
  assert.match(lanes, /never call xero_profit_and_loss/u);
  // The web route resolves the service URL through the shared resolver so
  // localhost and Vercel behave identically.
  assert.match(route, /xeroMcpServiceUrl\(\)/);
});

test("statement requests are detected deterministically and guarded", async () => {
  const { detectXeroStatementRequest } = await import("../../packages/albert-v3/src/engine/statement-lane");
  assert.equal(detectXeroStatementRequest("Give me our P&L YTD"), "profit_and_loss");
  assert.equal(detectXeroStatementRequest("give me our P&L ytd calendar year"), "profit_and_loss");
  assert.equal(detectXeroStatementRequest("profit and loss for July"), "profit_and_loss");
  assert.equal(detectXeroStatementRequest("show me our balance sheet as at 30 June 2026"), "balance_sheet");
  assert.equal(detectXeroStatementRequest("trial balance please"), "trial_balance");
  // Beyond a statement → general path keeps the report tools but also Cube.
  assert.equal(detectXeroStatementRequest("P&L by product category for July"), undefined);
  assert.equal(detectXeroStatementRequest("compare our P&L to Lightspeed sales"), undefined);
  assert.equal(detectXeroStatementRequest("who owes us money"), undefined);
});

test("Xero report JSON parses into a flat statement table", async () => {
  const { parseXeroReportTable } = await import("../../packages/xero-mcp/src/report-table");
  const text = `Profit and Loss Report: Profit and Loss
Date Range: 18 August 2026
${JSON.stringify([
    { rowType: "Header", cells: [{ value: "" }, { value: "31 Jul 26" }, { value: "30 Jun 26" }] },
    { rowType: "Section", title: "Income", rows: [
      { rowType: "Row", cells: [{ value: "Sales" }, { value: "100.50" }, { value: "90" }] },
      { rowType: "SummaryRow", cells: [{ value: "Total Income" }, { value: "100.50" }, { value: "90" }] },
    ] },
    { rowType: "Section", title: "", rows: [
      { rowType: "Row", cells: [{ value: "Net Profit" }, { value: "10" }, { value: "-5" }] },
    ] },
  ])}`;
  const table = parseXeroReportTable(text, "fallback");
  assert.ok(table);
  assert.equal(table.title, "Profit and Loss");
  assert.deepEqual([...table.periods], ["31 Jul 26", "30 Jun 26"]);
  assert.deepEqual(table.columns.map((column) => column.key), ["section", "line", "period_1", "period_2"]);
  assert.deepEqual(table.rows[0], { section: "Income", line: "Sales", period_1: 100.5, period_2: 90 });
  assert.deepEqual(table.rows[2], { section: "", line: "Net Profit", period_1: 10, period_2: -5 });
  assert.equal(parseXeroReportTable("Error listing profit and loss report: boom", "x"), undefined);
});

test("view guidance no longer sends statements to the ledger views", async () => {
  const config = await readFile(new URL("../../cube-playground/agents/config.yml", import.meta.url), "utf8");
  assert.doesNotMatch(config, /questions MUST\s+use the pnl_\* members/u);
  assert.match(config, /AUTHORITATIVE Xero accrual Profit and Loss/u);
  assert.match(config, /xero_profit_and_loss_analytics/u);
  assert.doesNotMatch(config, /FINANCIAL STATEMENTS come from Xero itself/u);
  assert.doesNotMatch(config, /live bank balances, balance\s+sheet/u);
});
