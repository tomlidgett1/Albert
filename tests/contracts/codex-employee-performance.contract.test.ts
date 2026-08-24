import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSharedAnalyticalBrief } from "../../services/conversation/src/analytical-brief.ts";
import {
  codexFinalSufficiencyGap,
  deriveEmployeeProductivity,
  type CodexEvidenceResult,
} from "../../packages/albert-codex/src/semantic-runtime.ts";
import type { CodexFinalAnswer } from "../../packages/albert-codex/src/contracts.ts";
import { reviewCodexEvidenceSufficiency } from "../../packages/albert-codex/src/sufficiency-review.ts";

const provenance = {
  sources: [{ connector: "lightspeed" as const, label: "Fixture POS", dataThrough: "2026-08-20" }],
  timeRange: { label: "1–16 August 2026", start: "2026-08-01", end: "2026-08-16", timezone: "Australia/Melbourne" },
  definitions: [],
  semanticBundleHash: "fixture-employee",
  identityGraph: { version: 0, hash: "fixture" },
};

function result(input: Readonly<{
  id: string;
  view: string;
  connector: string;
  end: string;
  columns: CodexEvidenceResult["columns"];
  rows: CodexEvidenceResult["rows"];
}>): CodexEvidenceResult {
  return {
    resultId: input.id,
    topic: input.view,
    view: input.view,
    connector: input.connector,
    query: {
      timeDimensions: [{ dimension: `${input.view}.period`, dateRange: ["2026-08-01", input.end] }],
    },
    queryYaml: "fixture",
    columns: input.columns,
    rows: input.rows,
    provenance: {
      ...provenance,
      sources: [{
        connector: input.connector as "lightspeed" | "deputy",
        label: input.connector === "deputy" ? "Fixture Deputy" : "Fixture POS",
        dataThrough: input.connector === "deputy" ? "2026-08-16" : "2026-08-20",
      }],
      timeRange: { ...provenance.timeRange, end: input.end },
    },
    executionMs: 10,
    rowCount: input.rows.length,
  };
}

const sales = result({
  id: "01J00000000000000000000201",
  view: "sales_analytics",
  connector: "lightspeed",
  end: "2026-08-16",
  columns: [
    { key: "sales_analytics.employees_full_name", label: "Employee", type: "string" },
    { key: "sales_analytics.gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
    { key: "sales_analytics.gross_profit", label: "Gross profit", type: "currency", currency: "AUD" },
    { key: "sales_analytics.transactions", label: "Transactions", type: "number" },
  ],
  rows: [
    { "sales_analytics.employees_full_name": "Leigh Phillips", "sales_analytics.gross_takings": 8515.38, "sales_analytics.gross_profit": 5200, "sales_analytics.transactions": 70 },
    { "sales_analytics.employees_full_name": "Jack Lidgett", "sales_analytics.gross_takings": 5404.63, "sales_analytics.gross_profit": 3500, "sales_analytics.transactions": 45 },
  ],
});

const workforce = result({
  id: "01J00000000000000000000202",
  view: "workforce_analytics",
  connector: "deputy",
  end: "2026-08-16",
  columns: [
    { key: "workforce_analytics.worked_by", label: "Employee", type: "string" },
    { key: "workforce_analytics.hours_worked", label: "Hours worked", type: "number" },
    { key: "workforce_analytics.wage_cost", label: "Wage cost", type: "currency", currency: "AUD" },
  ],
  rows: [
    { "workforce_analytics.worked_by": "Leigh Phillips", "workforce_analytics.hours_worked": 96, "workforce_analytics.wage_cost": 2330.6 },
    { "workforce_analytics.worked_by": "Jack Lidgett", "workforce_analytics.hours_worked": 69.17, "workforce_analytics.wage_cost": 1729.25 },
  ],
});

const draft = (answer: string): CodexFinalAnswer => ({
  state: "Qualified",
  answer,
  followUps: [],
  presentedResultIds: [],
  claims: [],
});

test("Compare builds one deterministic employee-performance brief for both runtimes", () => {
  const brief = buildSharedAnalyticalBrief({
    message: "Which employee has performed the best this month?",
    activeConnectors: ["lightspeed-r", "deputy", "xero"],
    connectorFreshness: [
      { connector: "lightspeed", dataThrough: "2026-08-20" },
      { connector: "deputy", dataThrough: "2026-08-16" },
    ],
  });
  assert.ok(brief);
  assert.equal(brief.id, "employee_performance_v1");
  assert.equal(brief.commonPeriodEnd, "2026-08-16");
  assert.deepEqual(brief.requiredViews.map((entry) => entry.view), ["sales_analytics", "workforce_analytics"]);
  assert.deepEqual(brief.requiredCalculations, ["takings_per_worked_hour", "gross_profit_per_worked_hour"]);
  assert.match(brief.digest, /^[a-f0-9]{24}$/u);
});

test("Codex turns broad opportunity prompts into a decision-complete analytical brief", () => {
  const brief = buildSharedAnalyticalBrief({
    message: "Find one high-confidence opportunity I could test this month",
    activeConnectors: ["lightspeed-r", "deputy", "xero"],
    connectorFreshness: [{ connector: "lightspeed", dataThrough: "2026-08-20" }],
  });
  assert.ok(brief);
  assert.equal(brief.id, "testable_opportunity_v2");
  assert.deepEqual(brief.requiredViews.map((entry) => entry.view), [
    "sales_analytics",
    "customer_analytics",
    "product_sales_analytics",
    "inventory_analytics",
    "workshop_analytics",
    "workforce_analytics",
    "xero_finance_analytics",
  ]);
  assert.match(brief.answerMustCover.join(" "), /at least three/iu);
  assert.match(brief.answerMustCover.join(" "), /primary outcome/iu);
  assert.match(brief.answerMustCover.join(" "), /guardrail/iu);
  assert.match(brief.digest, /^[a-f0-9]{24}$/u);
});

test("Compare sends and verifies the same server-derived analytical brief on both lanes", async () => {
  const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const [workspace, v3Route, codexRoute] = await Promise.all([
    read("app/dash/components/runtime-comparison-workspace.tsx"),
    read("app/api/v3-conversation/route.ts"),
    read("app/api/codex-conversation/route.ts"),
  ]);
  assert.match(workspace, /comparisonMode:\s*true/u);
  assert.match(workspace, /X-Albert-Analysis-Brief/u);
  assert.match(workspace, /comparison_brief_mismatch/u);
  assert.match(v3Route, /buildSharedAnalyticalBrief[\s\S]*X-Albert-Analysis-Brief/u);
  assert.match(codexRoute, /buildSharedAnalyticalBrief[\s\S]*X-Albert-Analysis-Brief/u);
});

test("Codex employee-performance sufficiency requires Deputy, a common period, and productivity use", () => {
  const brief = buildSharedAnalyticalBrief({
    message: "Which employee has performed the best this month?",
    activeConnectors: ["lightspeed-r", "deputy"],
    connectorFreshness: [
      { connector: "lightspeed", dataThrough: "2026-08-20" },
      { connector: "deputy", dataThrough: "2026-08-16" },
    ],
  });
  assert.ok(brief);
  assert.equal(
    codexFinalSufficiencyGap("Which employee performed best?", draft("Leigh led POS sales."), [sales], { analysisBrief: brief })?.code,
    "required_view_missing",
  );
  const unalignedWorkforce: CodexEvidenceResult = {
    ...workforce,
    query: {
      timeDimensions: [{
        dimension: "workforce_analytics.period",
        dateRange: ["2026-08-01", "2026-08-21"] as const,
      }],
    },
  };
  assert.equal(
    codexFinalSufficiencyGap("Which employee performed best?", draft("Leigh led sales and hours were reviewed."), [sales, unalignedWorkforce], { analysisBrief: brief })?.code,
    "common_period_alignment_required",
  );
  assert.equal(
    codexFinalSufficiencyGap("Which employee performed best?", draft("Leigh led POS sales."), [sales, workforce], { analysisBrief: brief })?.code,
    "employee_productivity_explanation_required",
  );
});

test("trusted employee productivity aligns exact unique labels and calculates governed ratios", () => {
  const brief = buildSharedAnalyticalBrief({
    message: "Which employee has performed the best this month?",
    activeConnectors: ["lightspeed-r", "deputy"],
    connectorFreshness: [
      { connector: "lightspeed", dataThrough: "2026-08-20" },
      { connector: "deputy", dataThrough: "2026-08-16" },
    ],
  });
  assert.ok(brief);
  const derived = deriveEmployeeProductivity(brief, [sales, workforce]);
  assert.ok(derived);
  assert.equal(derived.view, "employee_productivity_derived");
  assert.equal(derived.rows.length, 2);
  assert.equal(derived.rows[0]?.employee, "Leigh Phillips");
  assert.equal(derived.rows[0]?.takings_per_worked_hour, 88.7019);
  assert.equal(derived.rows[1]?.takings_per_worked_hour, 78.1355);
  assert.deepEqual(derived.provenance.sources.map((source) => source.connector).sort(), ["deputy", "lightspeed"]);
  assert.equal(
    codexFinalSufficiencyGap(
      "Which employee performed best?",
      draft("Leigh led total contribution and remained strongest on takings per worked hour; exact-name alignment is a limitation."),
      [sales, workforce, derived],
      { analysisBrief: brief },
    ),
    null,
  );
});

test("Codex uses an independent structured reviewer against the frozen brief", async () => {
  const brief = buildSharedAnalyticalBrief({
    message: "Which employee has performed the best this month?",
    activeConnectors: ["lightspeed-r", "deputy"],
    connectorFreshness: [
      { connector: "lightspeed", dataThrough: "2026-08-20" },
      { connector: "deputy", dataThrough: "2026-08-16" },
    ],
  });
  assert.ok(brief);
  const calls: unknown[] = [];
  const review = await reviewCodexEvidenceSufficiency({
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    model: "gpt-5.6-luna",
    fastMode: true,
    safetyIdentifier: "fixture-user",
    question: "Which employee has performed the best this month?",
    brief,
    draft: draft("Leigh led POS sales."),
    evidence: [{
      view: "sales_analytics",
      topic: "Employee sales",
      rowCount: 5,
      timeRange: "1–20 August",
      columns: ["Employee", "Takings"],
    }],
    client: {
      responses: {
        async create(body: unknown) {
          calls.push(body);
          return {
            output_text: JSON.stringify({
              verdict: "investigate",
              missing: ["Deputy worked hours and common-period productivity"],
            }),
          };
        },
      },
    } as never,
  });
  assert.deepEqual(review, {
    verdict: "investigate",
    missing: ["Deputy worked hours and common-period productivity"],
    excess: [],
  });
  const body = calls[0] as {
    model: string;
    store: boolean;
    reasoning: { effort: string };
    service_tier: string;
    text: { format: { type: string } };
  };
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, "low");
  assert.equal(body.service_tier, "fast");
  assert.equal(body.text.format.type, "json_schema");
});

// A goal-seek ask names its own numeric yardstick. Both halves of the trigger
// must hold — an amount AND a goal verb — so lookups with numbers and vague
// money questions keep their own briefs.
test("a named numeric target builds the goal-seek brief; lookalikes do not", () => {
  const brief = buildSharedAnalyticalBrief({
    message: "can we save 1k per month somehow?",
    activeConnectors: ["lightspeed-r", "deputy", "xero"],
    connectorFreshness: [],
    includeGeneric: true,
  });
  assert.ok(brief);
  assert.equal(brief.id, "target_goal_v1");
  assert.match(brief.answerMustCover.join(" "), /yardstick/iu);
  assert.match(brief.answerMustCover.join(" "), /reach, approach or fall short/iu);
  assert.match(brief.digest, /^[a-f0-9]{24}$/u);

  for (const [message, expected] of [
    ["How could I make an extra $500 a week?", "target_goal_v1"],
    ["We need to cut costs by 10%. Where should that come from?", "target_goal_v1"],
    ["I want to get my wage bill under $10k a month.", "target_goal_v1"],
    ["What were my top 10 products by revenue last month?", "general_analysis_v1"],
    ["How do I save money?", "general_analysis_v1"],
    ["What was my net profit in July?", "general_analysis_v1"],
  ] as const) {
    const built = buildSharedAnalyticalBrief({
      message,
      activeConnectors: ["lightspeed-r", "deputy", "xero"],
      connectorFreshness: [],
      includeGeneric: true,
    });
    assert.equal(built?.id, expected, message);
  }
});
