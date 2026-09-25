import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { codexRuntimeServiceUrl } from "../../packages/albert-codex/src/service-client.js";
import {
  ALBERT_CODEX_DEFAULT_EFFORT,
  ALBERT_CODEX_ANALYSIS_TIMEOUT_MS,
  ALBERT_CODEX_DEFAULT_FAST_MODE,
  ALBERT_CODEX_DEFAULT_MODEL,
  ALBERT_CODEX_MODEL_IDS,
  codexConversationRequestSchema,
} from "../../packages/albert-codex/src/contracts.js";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("normal V3 route and engine do not depend on the isolated Codex runtime", async () => {
  const [route, engine] = await Promise.all([
    read("app/api/v3-conversation/route.ts"),
    read("packages/albert-v3/src/engine/engine.ts"),
  ]);
  assert.doesNotMatch(route, /albert-codex|codex-conversation|runCodex/u);
  assert.doesNotMatch(engine, /albert-codex|codex-conversation|runCodex/u);
});

test("Codex route and runtime reuse Cube semantics without importing the V3 agent engine", async () => {
  const [route, semanticRuntime, chartRuntime] = await Promise.all([
    read("app/api/codex-conversation/route.ts"),
    read("packages/albert-codex/src/semantic-runtime.ts"),
    read("packages/albert-codex/src/chart-runtime.ts"),
  ]);
  assert.doesNotMatch(route, /albert-v3\/src\/engine|runAlbertV3Turn/u);
  assert.doesNotMatch(semanticRuntime, /albert-v3\/src\/engine/u);
  assert.doesNotMatch(chartRuntime, /albert-v3\/src\/engine/u);
  assert.match(semanticRuntime, /albert-v3\/src\/cube/u);
  assert.match(chartRuntime, /compileGroundedFlint/u);
  assert.match(route, /signCubeJwt/u);
  assert.match(route, /normalizeAgentPreferences/u);
  assert.match(route, /ALBERT_CODEX_MODEL_IDS/u);
  assert.match(route, /loadPriorTurnResults/u);
  assert.match(route, /priorResults: \[\.\.\.priorResults\]/u);
  assert.match(route, /CODEX_PRIOR_RESULTS_MAX_BYTES = 48_000/u);
  assert.match(route, /history\.slice\(-12\)/u);
  assert.match(semanticRuntime, /Resolve referential follow-ups[\s\S]*reuse priorResults/u);
  assert.match(semanticRuntime, /conversation-fast-path/u);
  assert.match(route, /X-Albert-Model", preferences\.model/u);
});

test("the service admits only the isolated Omni job database and no analytical or Cube signing credential", async () => {
  const sources = await Promise.all([
    read("services/codex-runtime/src/config.ts"),
    read("services/codex-runtime/src/http.ts"),
    read("services/codex-runtime/src/main.ts"),
  ]);
  const joined = sources.join("\n");
  assert.doesNotMatch(joined.replaceAll("ALBERT_OMNI_JOB_DATABASE_URL", "OMNI_JOB_STORE"), /CUBEJS_API_SECRET|DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY/u);
  assert.match(joined, /dedicated runtime identity/u);
  const childEnvironment = await read("packages/albert-codex/src/app-server.ts");
  assert.doesNotMatch(childEnvironment, /ALBERT_OMNI_JOB_DATABASE_URL/u);
  assert.match(joined, /CUBE_API_URL/u);
  assert.match(joined, /codexServiceTurnSchema/u);
});

test("Codex analytical work combines the hard deadline with brief-aware query ceilings", async () => {
  const [appServer, semanticRuntime] = await Promise.all([
    read("packages/albert-codex/src/app-server.ts"),
    read("packages/albert-codex/src/semantic-runtime.ts"),
  ]);
  assert.equal(ALBERT_CODEX_ANALYSIS_TIMEOUT_MS, 720_000);
  assert.match(appServer, /ANALYSIS_TIMEOUT_MS = ALBERT_CODEX_ANALYSIS_TIMEOUT_MS/u);
  assert.doesNotMatch(appServer, /MAX_VALIDATION_REPAIRS/u);
  assert.match(semanticRuntime, /codexQueryBudgetForTurn/u);
  assert.match(semanticRuntime, /testable_opportunity_v2[\s\S]*\? 16/u);
  assert.match(semanticRuntime, /general_analysis_v1[\s\S]*\? 10/u);
  assert.match(semanticRuntime, /CODEX_PLAN_STEP_RESULT_BUDGET = 3/u);
  assert.match(semanticRuntime, /error: "plan_step_saturated"/u);
  assert.doesNotMatch(semanticRuntime, /MAX_(?:EXECUTED|CATALOGUE|SCHEMA)/u);
  assert.doesNotMatch(semanticRuntime, /schema-load budget is exhausted|catalogue-search budget is exhausted/iu);
  assert.match(semanticRuntime, /successfulQueryDigests\.has/u);
});

test("web uses short signed job polls without spawning Codex in the route", async () => {
  const [route, serviceClient] = await Promise.all([
    read("app/api/codex-conversation/route.ts"),
    read("packages/albert-codex/src/service-client.ts"),
  ]);
  assert.doesNotMatch(route, /runCodexSemanticTurn|child_process|spawn\(/u);
  assert.match(route, /transport: "signed-job-poll"/u);
  assert.match(serviceClient, /runJob/u);
  assert.match(serviceClient, /JOBS_PATH/u);
  assert.doesNotMatch(serviceClient, /node:http|runLoopbackNodeStream/u);
  assert.match(route, /X-Albert-Codex-Deadline-Ms/u);
});

test("Codex evidence-bound updates use the same live commentary surface as V3", async () => {
  const [trace, semanticRuntime, appServer, contracts] = await Promise.all([
    read("app/dash/components/InsightsStyleTrace.tsx"),
    read("packages/albert-codex/src/semantic-runtime.ts"),
    read("packages/albert-codex/src/app-server.ts"),
    read("packages/albert-codex/src/contracts.ts"),
  ]);
  assert.match(trace, /runtime === "v3" \|\| runtime === "codex"/u);
  assert.match(trace, /commentaryLive[\s\S]*LiveCommentary/u);
  assert.match(contracts, /name: "report_evidence_update"/u);
  assert.match(semanticRuntime, /no_new_evidence[\s\S]*ungrounded[\s\S]*duplicate[\s\S]*limit/u);
  assert.doesNotMatch(semanticRuntime, /method === "item\/agentMessage\/delta"/u);
  assert.match(appServer, /optOutNotificationMethods: \["item\/agentMessage\/delta"\]/u);
});

test("Codex CLI dependency is exactly pinned", async () => {
  const packageJson = JSON.parse(await read("package.json")) as { dependencies?: Record<string, string> };
  assert.equal(packageJson.dependencies?.["@openai/codex"], "0.148.0");
});

test("Codex defaults to Luna Max Fast and accepts only server-reviewed model preferences", () => {
  assert.equal(ALBERT_CODEX_DEFAULT_MODEL, "gpt-5.6-luna");
  assert.equal(ALBERT_CODEX_DEFAULT_EFFORT, "max");
  assert.equal(ALBERT_CODEX_DEFAULT_FAST_MODE, true);
  assert.deepEqual(ALBERT_CODEX_MODEL_IDS, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
  assert.deepEqual(codexConversationRequestSchema.parse({
    message: "Show customer health",
    preferences: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
  }), {
    message: "Show customer health",
    preferences: { model: "gpt-5.6-terra", reasoningEffort: "high", fastMode: false },
  });
});

test("Codex accepts a deep cross-domain brief without a six-view research ceiling", async () => {
  const contracts = await import("../../packages/albert-codex/src/contracts.ts");
  const requiredViews = [
    "sales_analytics",
    "customer_analytics",
    "product_sales_analytics",
    "inventory_analytics",
    "workshop_analytics",
    "workforce_analytics",
    "xero_finance_analytics",
  ].map((view) => ({ view, reason: `governed ${view} evidence` }));
  assert.equal(contracts.codexAnalyticalBriefSchema.parse({
    id: "testable_opportunity_v2",
    version: 2,
    digest: "a".repeat(24),
    ownerGoal: "Compare broad opportunities.",
    answerMustCover: ["Compare at least three candidates."],
    requiredViews,
    requiredCalculations: [],
    commonPeriodEnd: null,
  }).requiredViews.length, 7);
});

test("local Codex traffic cannot be captured by a configured production service URL", () => {
  assert.equal(codexRuntimeServiceUrl({
    NODE_ENV: "development",
    CODEX_RUNTIME_SERVICE_URL: "https://albert-codex-runtime.fly.dev",
  }), "http://127.0.0.1:8792");
  assert.equal(codexRuntimeServiceUrl({
    NODE_ENV: "development",
    CODEX_RUNTIME_SERVICE_URL: "http://localhost:9888/",
  }), "http://localhost:9888");
  assert.equal(codexRuntimeServiceUrl({
    NODE_ENV: "production",
    CODEX_RUNTIME_SERVICE_URL: "https://albert-codex-runtime.fly.dev/",
  }), "https://albert-codex-runtime.fly.dev");
});
