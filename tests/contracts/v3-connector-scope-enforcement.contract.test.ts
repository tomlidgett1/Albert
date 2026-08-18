import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  certifiedQueryConnectors,
  loadAgentConfig,
  matchCertifiedQueries,
} from "../../packages/albert-v3/src/agent-config/loader.js";
import type { V3ToolRoute } from "../../packages/albert-v3/src/engine/connector-routing.js";
import { REVISION_DEADLINE_MS } from "../../packages/albert-v3/src/engine/engine.js";
import { retryFollowUps } from "../../packages/albert-v3/src/engine/grounding.js";
import { buildInitialOwnerPlan } from "../../packages/albert-v3/src/engine/initial-plan.js";
import { renderRequestContext } from "../../packages/albert-v3/src/engine/lanes.js";
import { guardOrphanRefinement } from "../../packages/albert-v3/src/engine/orchestrator.js";
import { viewsOutsideRoute } from "../../packages/albert-v3/src/engine/tools.js";

const config = loadAgentConfig();

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

/** Ashburton Cycles: R-Series + Xero + Deputy. */
function ashburtonRoute(): V3ToolRoute {
  return Object.freeze({
    cube: true,
    shopifyQL: false,
    shopifyAdmin: false,
    activeCubeConnectors: Object.freeze(["deputy", "lightspeed", "xero"]),
    preferredCubeConnectors: Object.freeze([]),
    unavailableRequestedConnectors: Object.freeze([]),
    mode: "cube",
    reasons: Object.freeze(["test"]),
  });
}

// The failing production message: "Try the question again" resolved into this
// and token-matched the X-Series refunds certified query on "time" + "series".
const ORPHAN_RETRY = "Retry the immediately preceding data request, presenting the results as a time series with dates on the x-axis.";

test("certified queries are never offered for a connector the tenant has not connected", () => {
  const unscoped = matchCertifiedQueries(ORPHAN_RETRY, config);
  assert.ok(
    unscoped.some((query) => query.name === "lightspeed-x-refunds"),
    "fixture assumption: the unscoped matcher still surfaces the X-Series refunds query for this wording",
  );
  const scoped = matchCertifiedQueries(ORPHAN_RETRY, config, 3, ["deputy", "lightspeed", "xero"]);
  assert.equal(scoped.some((query) => query.name.startsWith("lightspeed-x")), false);
  for (const query of scoped) {
    for (const connector of certifiedQueryConnectors(query, config)) {
      assert.ok(["deputy", "lightspeed", "xero"].includes(connector), `${query.name} leaked ${connector}`);
    }
  }
});

test("renderRequestContext scopes certified starting points to the route", () => {
  const withRoute = renderRequestContext({ config, question: ORPHAN_RETRY, route: ashburtonRoute() });
  assert.doesNotMatch(withRoute, /lightspeed_x_/u);
  const withoutRoute = renderRequestContext({ config, question: ORPHAN_RETRY });
  assert.match(withoutRoute, /lightspeed_x_refunds_analytics/u);
});

test("query, schema and entity tools refuse views outside the tenant's connectors", () => {
  const context = { config, toolRoute: ashburtonRoute() };
  assert.deepEqual(
    viewsOutsideRoute(context, ["lightspeed_x_refunds_analytics", "sales_analytics", "square_sales_analytics"]),
    ["lightspeed_x_refunds_analytics", "square_sales_analytics"],
  );
  assert.deepEqual(viewsOutsideRoute(context, ["sales_analytics", "workforce_analytics", "xero_finance_analytics"]), []);
  // Unknown views are left to Cube's own validation.
  assert.deepEqual(viewsOutsideRoute(context, ["not_a_view"]), []);

  const tools = read("packages/albert-v3/src/engine/tools.ts");
  assert.match(tools, /const outside = viewsOutsideRoute\(context, memberViews\(input\)\);\s*if \(outside\.length > 0\) return outOfScopeError/u);
  assert.match(tools, /const outside = viewsOutsideRoute\(context, input\.viewNames\);\s*if \(outside\.length > 0\) return outOfScopeError/u);
  assert.match(tools, /input\.searchIn, \.\.\.\(input\.sizeBy \? \[input\.sizeBy\] : \[\]\)/u);
});

test("a refinement with nothing to refine becomes an honest clarification, not an invented chart", () => {
  const decision = {
    lane: "analytical" as const,
    resolvedQuestion: "Present the previously requested time-based chart with dates on the x-axis, retaining the original metric, period, and comparison requested.",
    ownerGoal: null,
    answerShape: "trend" as const,
    answerMustCover: [],
    assumptions: [],
    clarificationQuestion: null,
    clarificationOptions: [],
    recipe: null,
    recipeDateRange: null,
    recipeEntity: null,
    nativeCapability: null,
  };
  const orphan = guardOrphanRefinement(decision, [{ role: "user", text: "have dates on x axis" }], "have dates on x axis");
  assert.equal(orphan.lane, "clarification");
  assert.match(orphan.clarificationQuestion ?? "", /isn't an earlier answer/u);
  assert.ok(orphan.clarificationOptions.length >= 2);

  // With the earlier owner message present (migration 0152 keeps it even for a
  // failed turn) the decision is left to the classifier.
  const anchored = guardOrphanRefinement(decision, [
    { role: "user", text: "bar chart of sales this year please" },
    { role: "assistant", text: "(No answer was produced for this message …)" },
    { role: "user", text: "have dates on x axis" },
  ], "have dates on x axis");
  assert.equal(anchored.lane, "analytical");

  // Fresh first questions that merely mention time words are untouched.
  for (const first of [
    "What was last month's sales result?",
    "What is my gross profit this month?",
    "Compare this year to last year",
  ]) {
    const fresh = guardOrphanRefinement(
      { ...decision, resolvedQuestion: first },
      [{ role: "user", text: first }],
      first,
    );
    assert.equal(fresh.lane, "analytical", first);
  }
});

test("the retry chip re-sends the owner's question, not the words 'Try the question again'", () => {
  assert.deepEqual(retryFollowUps("bar chart of sales this year please"), ["bar chart of sales this year please"]);
  assert.deepEqual(retryFollowUps("x"), ["Show sales this month"]);
  const engine = read("packages/albert-v3/src/engine/engine.ts");
  assert.doesNotMatch(engine, /\["Try the question again"\]/u);
});

test("the reviewer's revision runs under its own deadline and can never take the draft down with it", () => {
  assert.ok(REVISION_DEADLINE_MS >= 30_000 && REVISION_DEADLINE_MS <= 120_000);
  const engine = read("packages/albert-v3/src/engine/engine.ts");
  assert.match(engine, /AbortSignal\.timeout\(REVISION_DEADLINE_MS\)/u);
  // Both revision paths (planned top-up, then agentic) run inside the guarded try under the revision signal.
  assert.match(engine, /try \{[\s\S]*?runPlannedLane\(\{\s*\.\.\.laneInput,\s*signal: revisionSignal,[\s\S]*?revised = await runAnalyticalLane\(\{\s*\.\.\.laneInput,\s*signal: revisionSignal,/u);
  assert.match(engine, /if \(options\.signal\?\.aborted\) throw error;/u);
  assert.match(engine, /Kept the first answer/u);
  // The reviewer may not invent a "synced through today" concern.
  assert.match(engine, /Never ask for a check of whether the data is\s+"synced through today"/u);
  const lanes = read("packages/albert-v3/src/engine/lanes.ts");
  assert.match(lanes, /signal: input\.signal \?\? input\.context\.signal/u);
});

test("plan steps written as instructions are not prefixed into 'Check use dates…'", () => {
  const steps = buildInitialOwnerPlan({
    lane: "analytical",
    resolvedQuestion: "Present the chart with dates on the x-axis",
    ownerGoal: null,
    answerShape: "trend",
    answerMustCover: [
      "Use dates on the x-axis in chronological order",
      "Retain the previously requested metric, date range and comparison",
      "Label the date granularity clearly",
      "Total sales for August 2026",
    ],
    assumptions: [],
    clarificationQuestion: null,
    clarificationOptions: [],
    recipe: null,
    recipeDateRange: null,
    recipeEntity: null,
    nativeCapability: null,
  });
  const labels = steps.map((step) => step.label);
  assert.ok(labels.includes("Use dates on the x-axis in chronological order"), labels.join(" | "));
  assert.ok(labels.includes("Retain the previously requested metric, date range and comparison"));
  assert.ok(labels.includes("Label the date granularity clearly"));
  assert.ok(labels.includes("Check total sales for August 2026"));
  assert.equal(labels.some((label) => /^Check (?:use|retain|label|make|preserve)\b/u.test(label)), false);
});

test("model context keeps the owner's message from a turn that failed before answering", () => {
  const migration = read("infra/migrations/control-plane/0152_m8_model_context_keeps_failed_turn_messages.sql");
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.albert_model_context/u);
  assert.match(migration, /OR turn\.status = 'failed'\s*\)/u);
  assert.doesNotMatch(migration, /event\.event->>'type' IN \('answer', 'clarification'\)\s*\)\s*\)/u);
  const store = read("services/conversation/src/artifact-store.ts");
  assert.match(store, /UNANSWERED_TURN_NOTE/u);
  assert.match(store, /values\.length === 1 && turn\.status === "failed"/u);
});
