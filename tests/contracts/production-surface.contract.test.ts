import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  formatTraceCell,
  isExplainableTraceCell,
  traceCellNumber,
} from "../../app/dash/components/analytical-values.js";
import { parseSafeAnswerLineage } from "../../app/dash/components/answer-lineage.js";
import { semanticToolResponseSchema } from "../../packages/agent/src/semantic-tools.js";
import { adaptGovernedResult } from "../../services/conversation/src/semantic-adapter.js";
import { toConnectionsWorkspace } from "../../services/control-plane/src/connections-workspace.js";

const dashPage = readFileSync(resolve("app/dash/page.tsx"), "utf8");
const connectionsSurface = readFileSync(
  resolve("app/dash/components/ConnectionsWorkspace.tsx"),
  "utf8",
);
const conversationRoute = readFileSync(resolve("app/api/conversation/route.ts"), "utf8");
const labRoute = readFileSync(resolve("app/lab/page.tsx"), "utf8");
const analyticalTrace = readFileSync(resolve("app/dash/components/AnalyticalTrace.tsx"), "utf8");
const traceTransport = readFileSync(resolve("services/conversation/src/sse.ts"), "utf8");
const dashStyles = readFileSync(resolve("app/dash/dash.module.css"), "utf8");
const loginStyles = readFileSync(resolve("app/login/login.module.css"), "utf8");
const nextConfig = readFileSync(resolve("next.config.ts"), "utf8");
const viteConfig = readFileSync(resolve("vite.config.ts"), "utf8");
const supabaseBrowserClient = readFileSync(
  resolve("utils/supabase/client.ts"),
  "utf8",
);

function workspaceFor(connectors: readonly ("lightspeed-r" | "xero" | "deputy")[]) {
  return toConnectionsWorkspace({
    tenant_id: "01J00000000000000000000001",
    tenant_name: "Albert Bikes",
    connections: connectors.map((connector, index) => ({
      connection_id: `01J0000000000000000000001${index}`,
      connector_key: connector,
      display_name: connector,
      status: "connected",
      auth_health: "healthy",
      readiness: [],
    })),
    dossier: null,
    identity_review_tasks: [],
    blocking_answers: {},
    oauth_sessions: [],
  }, "Australia/Melbourne");
}

test("the authenticated client contains only implemented V1 workspaces", () => {
  assert.doesNotMatch(dashPage, /exampleAgents|starterDashboards|createBlankDashboard/u);
  assert.doesNotMatch(dashPage, /Ten example agents|GRIDDED CANVAS|Create Agent/u);
  assert.doesNotMatch(dashPage, /activeItem === ["'](?:Dashboard|Agents)["']/u);
  assert.doesNotMatch(connectionsSurface, /albertConnectionsFixture|configured in this preview/u);
  assert.match(dashPage, /activeItem === "Chat"/u);
  assert.match(dashPage, /activeItem === "Connections"/u);
  assert.match(dashPage, /activeItem === "Admin" && isInternalOperator/u);
  assert.match(dashPage, /activeItem === "Organization"/u);
  assert.match(labRoute, /redirect\("\/dash"\)/u);
});

test("fixture analytics fail closed in production and are not a public route", () => {
  assert.match(conversationRoute, /ALBERT_CONVERSATION_RUNTIME \?\? "live"/u);
  assert.match(conversationRoute, /process\.env\.NODE_ENV === "production"[\s\S]*inspectRuntimeEnvironment\("web"\)[\s\S]*!readiness\.ready/u);
  assert.match(
    conversationRoute,
    /process\.env\.NODE_ENV === "production" \|\| process\.env\.ALBERT_ALLOW_FIXTURE_RUNTIME !== "true"/u,
  );
  assert.match(conversationRoute, /Fixture analytics are disabled outside explicit local development/u);
  assert.doesNotMatch(labRoute, /fixture|demo|sample/iu);
});

test("the browser receives only public Supabase configuration and CSP permits its exact origin", () => {
  assert.match(viteConfig, /envPrefix:\s*\["VITE_",\s*"NEXT_PUBLIC_"\]/u);
  assert.match(supabaseBrowserClient, /import\.meta[\s\S]*NEXT_PUBLIC_SUPABASE_URL/u);
  assert.match(supabaseBrowserClient, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/u);
  assert.match(nextConfig, /supabaseConnectSources\(publicSupabaseUrl\)/u);
  assert.match(nextConfig, /url\.protocol === "https:" \? "wss:" : "ws:"/u);
  assert.doesNotMatch(
    `${viteConfig}\n${supabaseBrowserClient}`,
    /SERVICE_ROLE|SECRET_KEY|DATABASE_URL/u,
  );
});

test("expanded composer popovers are not clipped by the collapse animation container", () => {
  assert.match(
    dashPage,
    /overflow:\s*"visible"/u,
  );
  assert.match(dashPage, /chatComposerHero\s*\?\s*styles\.chatComposerStackEmpty/u);
  assert.match(
    dashStyles,
    /\.chatComposerStackEmpty\s+\.modelControlsPopover[\s\S]{0,120}max-height:\s*min\(330px,\s*calc\(50vh - 64px\)\)/u,
  );
});

test("onboarding questions appear only when their source evidence can exist", () => {
  assert.deepEqual(workspaceFor([]).blockingQuestions, []);
  assert.deepEqual(
    workspaceFor(["lightspeed-r"]).blockingQuestions.map(({ id }) => id),
    ["sales-lens", "trading-day"],
  );
  assert.deepEqual(
    workspaceFor(["lightspeed-r", "deputy"]).blockingQuestions.map(({ id }) => id),
    ["sales-lens", "trading-day", "employee-performance"],
  );
  assert.deepEqual(
    workspaceFor(["lightspeed-r", "xero", "deputy"]).blockingQuestions.map(({ id }) => id),
    ["sales-lens", "trading-day", "employee-performance", "pos-posting-topology"],
  );
});

test("connection mutations are role gated and never report optimistic success", () => {
  assert.match(dashPage, /canManageConnections/u);
  assert.match(connectionsSurface, /const mutationsEnabled = canManage && status\.kind === "ready"/u);
  assert.match(connectionsSurface, /Owner or manager access is required/u);
  assert.match(connectionsSurface, /response\.ok && payload\.accepted && payload\.syncRunId/u);
  assert.match(connectionsSurface, /setSyncState\(\{ status: "declined"/u);
  assert.doesNotMatch(connectionsSurface, /setSyncState\(\{ status: "accepted"[^}]*\}\);[\s\S]{0,100}await fetch/u);
});

test("OAuth return states are translated into truthful first-party notices", () => {
  for (const state of [
    "connected",
    "selection_required",
    "cancelled",
    "rate_limited",
    "invalid_callback",
    "tenant_missing",
    "unknown_provider",
  ]) {
    assert.match(dashPage, new RegExp(`case ["']${state}["']`));
  }
  assert.match(dashPage, /window\.history\.replaceState/u);
  assert.match(dashPage, /recent-first sync has started/u);
});

test("live decimal strings remain exact in tables and chartable without assuming AUD", () => {
  const currencyColumn = { key: "net_sales", label: "Net sales", type: "currency" as const, currency: "NZD" };
  const formatted = formatTraceCell("9007199254740993.1234", currencyColumn);
  assert.match(formatted, /NZD/u);
  assert.match(formatted, /9,007,199,254,740,993\.1234/u);
  assert.equal(traceCellNumber("-22.5000"), -22.5);
  assert.equal(isExplainableTraceCell("-22.5000", currencyColumn), true);
  assert.doesNotMatch(
    formatTraceCell("22.5000", { key: "net_sales", label: "Net sales", type: "currency" }),
    /AUD|\$/u,
  );
  assert.match(analyticalTrace, /<ResponsiveBar/u);
  assert.match(analyticalTrace, /valueScale=\{\{ type: "linear" \}\}/u);
  assert.match(analyticalTrace, /formatTraceCell\(value, item\.column\)/u);
  assert.match(analyticalTrace, /traceCellNumber\(/u);
});

test("validated single-currency evidence reaches presentation metadata", () => {
  const response = semanticToolResponseSchema.parse({
    state: "verified",
    resultId: `semantic:${"a".repeat(64)}`,
    data: { columns: ["net_sales"], rows: [{ net_sales: "210.0000" }] },
    provenance: {
      bundleHash: "a".repeat(64),
      registryVersion: "2026.08.03",
      identityGraph: { version: 1, hash: "b".repeat(32) },
      sources: ["commerce_sales_event"],
      sourceWatermarks: { lightspeed: "2026-08-03T01:00:00.000Z" },
      sourceDetails: [{
        connectorId: "lightspeed-r",
        connectionId: "01J00000000000000000000011",
        label: "Lightspeed",
        dataThrough: "2026-08-03T01:00:00.000Z",
      }],
      definitionsApplied: ["commerce.net_sales"],
      definitionDetails: [{ id: "commerce.net_sales", label: "Net sales", definition: "Governed net sales." }],
      timeRange: {
        label: "Today",
        start: "2026-08-03T00:00:00.000Z",
        end: "2026-08-04T00:00:00.000Z",
        timezone: "Australia/Melbourne",
      },
    },
    validation: {
      status: "passed",
      checks: [{ checkId: "slice_single_currency:net_sales", status: "passed", currencies: ["nzd"] }],
      warnings: [],
    },
    performance: { cacheHit: false, durationMs: 2, rowCount: 1 },
  });
  const result = adaptGovernedResult(response);
  assert.equal(result.columns[0]?.currency, "NZD");
});

test("immutable lineage is retained for live and restored turns and rendered through a bounded receipt", () => {
  assert.match(traceTransport, /"X-Albert-Turn-Id": options\.turnId/u);
  assert.match(conversationRoute, /turnId,/u);
  assert.match(dashPage, /response\.headers\.get\("X-Albert-Turn-Id"\)/u);
  assert.match(dashPage, /turnId: turn\.turn_id/u);
  assert.match(dashPage, /lineageReference=/u);
  assert.match(analyticalTrace, /Immutable answer record/u);

  const conversationId = "01J00000000000000000000001";
  const turnId = "01J00000000000000000000002";
  const raw = {
    answerArtifactId: "01J00000000000000000000003",
    conversationId,
    turnId,
    turnNumber: 1,
    answerState: "verified",
    question: "A user-authored question that must not enter the rendered receipt.",
    interpretedPlan: { normalizedIr: { secret: true } },
    semanticBundleHash: "a".repeat(64),
    traceDigest: "b".repeat(64),
    artifactDigest: "c".repeat(64),
    finalizedAt: "2026-08-03T01:02:03.000Z",
    queries: [{
      queryAuditId: "01J00000000000000000000004",
      route: "semantic",
      topic: "sales_performance",
      bundleHash: "a".repeat(64),
      registryVersion: "2026.08.03",
      compilerOutputHash: "d".repeat(64),
      resultDigest: "e".repeat(64),
      answerState: "verified",
      compiledSql: "SELECT secret",
    }],
  };
  const parsed = parseSafeAnswerLineage(raw, { conversationId, turnId });
  assert.ok(parsed);
  assert.equal("question" in parsed, false);
  assert.equal("interpretedPlan" in parsed, false);
  assert.equal("compiledSql" in parsed.queries[0], false);
  assert.equal(parseSafeAnswerLineage(raw, { conversationId, turnId: "01J00000000000000000000009" }), null);
  assert.equal(parseSafeAnswerLineage({ ...raw, queries: Array(21).fill(raw.queries[0]) }, { conversationId, turnId }), null);
});

test("authentication and trace surfaces retain light, dark, green, system, mobile, focus and reduced-motion behavior", () => {
  for (const styles of [dashStyles, loginStyles]) {
    assert.match(styles, /light-dark\(/u);
    assert.match(styles, /\[data-theme="dark"\][\s\S]{0,100}color-scheme:\s*dark/u);
    assert.match(styles, /\[data-theme="green"\][\s\S]{0,100}color-scheme:\s*dark/u);
    assert.match(styles, /\[data-theme="system"\][\s\S]{0,100}color-scheme:\s*light dark/u);
    assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
    assert.match(styles, /:focus-visible/u);
  }
  assert.match(dashStyles, /@media \(max-width: 700px\)[\s\S]*\.traceHeader/u);
  assert.match(dashStyles, /\.traceChartScroll[\s\S]{0,120}overflow-x:\s*auto/u);
  assert.match(dashStyles, /\.traceChartTooltip,[\s\S]{0,120}animation:\s*none/u);
  assert.match(loginStyles, /@media \(max-width: 480px\)/u);
});
