import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  primarySynthesisEvidenceInput,
  recoverableSqlFailureGuidance,
  sqlProbeRejection,
} from "../../services/conversation/src/live.js";
import { ANALYSIS_EXECUTION_PROFILES } from "../../services/conversation/src/analysis-orchestration.js";

const liveAgent = readFileSync(new URL("../../services/conversation/src/live.ts", import.meta.url), "utf8");
const playbooksDir = new URL("../../connectors/lightspeed-r/playbooks/", import.meta.url);
const playbook = readdirSync(playbooksDir)
  .filter((file) => file.endsWith(".md"))
  .sort()
  .map((file) => readFileSync(new URL(file, playbooksDir), "utf8"))
  .join("\n");

test("diagnostic preflight purposes are rejected before they burn the turn", () => {
  assert.match(
    sqlProbeRejection({
      purpose: "Diagnose the read-only SQL route before querying monthly sales",
      sql: "SELECT 1 AS x",
    }) ?? "",
    /Do not run diagnostic/u,
  );
  assert.match(
    sqlProbeRejection({
      purpose: "Diagnose Lightspeed pack pinning before querying monthly sales",
      sql: `WITH pack AS (
        SELECT mapping_version AS mv FROM source_lightspeed.ls_sales
        GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
      ) SELECT mv FROM pack`,
    }) ?? "",
    /diagnostic|Pack pinning/u,
  );
  assert.match(
    sqlProbeRejection({
      purpose: "Connectivity check",
      sql: "select 1",
    }) ?? "",
    /SELECT 1/u,
  );
});

test("real monthly sales aggregates are allowed through", () => {
  assert.equal(
    sqlProbeRejection({
      purpose: "Monthly sales totals for the line chart",
      sql: `WITH pack AS (
        SELECT mapping_version AS mv FROM source_lightspeed.ls_sales
        GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
      )
      SELECT date_trunc('month', s.complete_time AT TIME ZONE sh.time_zone) AS month,
             SUM(s.calc_total) AS sales_inc_gst
      FROM source_lightspeed.ls_sales s
      JOIN source_lightspeed.ls_shops sh ON sh.shop_id = s.shop_id
        AND sh.mapping_version = (SELECT mv FROM pack) AND NOT sh.tombstone
      WHERE s.mapping_version = (SELECT mv FROM pack)
        AND NOT s.tombstone AND s.completed AND NOT s.voided
      GROUP BY 1 ORDER BY 1`,
    }),
    null,
  );
});

test("SQL failures get cause-specific one-retry guidance", () => {
  assert.match(
    recoverableSqlFailureGuidance("canceling statement due to statement timeout"),
    /filter the driving fact table[\s\S]*aggregate it before/iu,
  );
  assert.match(
    recoverableSqlFailureGuidance('column "b.as_of_date" must appear in the GROUP BY clause'),
    /GROUP BY|MIN\/MAX/u,
  );
  assert.match(
    recoverableSqlFailureGuidance("data.resultWindow.orderBy: Too big: expected array to have <=5 items"),
    /no more than three selected output aliases/u,
  );
});

test("broad-review coverage is model-owned rather than inferred from prompt or SQL regex", () => {
  assert.doesNotMatch(liveAgent, /requestedAnalysisSections|analysisSectionsForSql|BREADTH_FIRST_REQUIRED/u);
  assert.match(liveAgent, /requestedWorkstreams/u);
});

test("interrupted synthesis fallback carries every result instead of the last table", () => {
  const result = (resultId: string, value: number) => ({
    resultId,
    columns: [{ key: "value", label: "Value", type: "number" as const }],
    rows: [{ value }],
    provenance: {
      sources: [],
      timeRange: { label: "test", start: "2026-01-01", end: "2026-01-02", timezone: "Australia/Melbourne" },
      definitions: [],
      semanticBundleHash: "x",
      identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
    },
    validations: [],
  });
  const results = new Map([
    ["sql:sales", result("sql:sales", 12)],
    ["sql:inventory", result("sql:inventory", 34)],
  ]);
  const packet = JSON.parse(primarySynthesisEvidenceInput(
    "Review the business",
    results,
    new Map([["sql:sales", "Sales trend"], ["sql:inventory", "Stock risk"]]),
    ["customer query did not complete"],
    ["Cover sales", "Cover inventory", "Cover customers"],
  ));
  assert.deepEqual(packet.evidence.map((item: { resultId: string }) => item.resultId), ["sql:sales", "sql:inventory"]);
  assert.equal(packet.evidence[0].rows[0].value, 12);
  assert.equal(packet.evidence[1].rows[0].value, 34);
  assert.match(packet.unresolvedFailures[0], /customer query/u);
  assert.deepEqual(packet.requestedWorkstreams, ["Cover sales", "Cover inventory", "Cover customers"]);
});

test("primary analyst instructions ban diagnose spirals and keep a bounded revisable loop", () => {
  assert.match(liveAgent, /Never preflight with SELECT 1/u);
  assert.match(liveAgent, /chart questions are one purposeful aggregate then the chart, never row samples first/iu);
  assert.match(liveAgent, /window that honestly tells the story/u);
  assert.match(liveAgent, /not an arbitrary handful of rows/u);
  assert.match(liveAgent, /work breadth-first/u);
  assert.equal(ANALYSIS_EXECUTION_PROFILES.lookup.maxResults, 2);
  assert.equal(ANALYSIS_EXECUTION_PROFILES.standard.maxTurns, 32);
  assert.equal(ANALYSIS_EXECUTION_PROFILES.deep.maxTurns, 48);
  assert.equal(ANALYSIS_EXECUTION_PROFILES.deep.analyticalBudgetMs, 900_000);
  assert.match(liveAgent, /PRIMARY_SYNTHESIS_MAX_TURNS = 3/u);
  assert.match(liveAgent, /Call update_analysis_plan\(reason="initial"\) before any schema or data tool/u);
  assert.match(liveAgent, /reason="evidence" or "recovery"/u);
  assert.match(liveAgent, /Never ask a clarification question or return the Clarification state/u);
  assert.doesNotMatch(liveAgent, /const askUser = tool/u);
  assert.match(liveAgent, /sqlProbeRejection/u);
  assert.match(liveAgent, /isOwnerTrailValidation/u);
  assert.match(liveAgent, /updateAnalysisPlan,[\s\S]*searchSchema,[\s\S]*describeTables,[\s\S]*runSql,/u);
  assert.doesNotMatch(liveAgent, /workflowName: "albert-answer"/u);
  assert.doesNotMatch(liveAgent, /resolveIntentPlanWithAgent/u);
  assert.doesNotMatch(liveAgent, /function createAnswerAgent/u);
  assert.match(liveAgent, /createPrimaryAnalystAgent/u);
  assert.match(playbook, /Show a line graph of monthly sales/u);
  assert.match(playbook, /date_trunc\('month'/u);
});

test("owner trail validations keep failures and invented-number blocks only", async () => {
  const { isOwnerTrailValidation } = await import("../../services/conversation/src/live.js");
  assert.equal(isOwnerTrailValidation({ name: "sql_lint", outcome: "passed" }), false);
  assert.equal(isOwnerTrailValidation({ name: "evidence_tier", outcome: "qualified" }), false);
  assert.equal(isOwnerTrailValidation({ name: "answer_includes_table", outcome: "qualified" }), false);
  assert.equal(isOwnerTrailValidation({ name: "numeric_grounding", outcome: "qualified" }), true);
  assert.equal(isOwnerTrailValidation({ name: "answer_scope_guard", outcome: "failed" }), true);
});

test("an uncontracted methodology clarification never blocks the turn", async () => {
  const { applyIntentPlanDefaults } = await import("../../services/conversation/src/intent-plan.js");
  // "Aged inventory" is one example, not a special case — any methodology
  // question the server did not contract for flips to answer, and the analyst
  // chooses and discloses the best-supported operational default.
  const forced = applyIntentPlanDefaults("give me an aged inventory report", {
    disposition: "clarification",
    caseId: null,
    domain: "inventory",
    grain: "unknown",
    namedEntities: [],
    tables: [],
    planSteps: ["Confirm the ageing basis"],
    summary: "Need to know how you want inventory age measured",
    clarification: { question: "How should I measure inventory age?" },
    unavailableReason: null,
  });
  assert.equal(forced.disposition, "answer");
  assert.equal(forced.clarification, null);
  assert.equal(forced.planSteps.length > 0, true);
});

test("a legacy contracted clarification is converted to best-judgement analysis", async () => {
  const { applyIntentPlanDefaults } = await import("../../services/conversation/src/intent-plan.js");
  const kept = applyIntentPlanDefaults("who is my best employee", {
    disposition: "clarification",
    caseId: "workforce-best",
    domain: "employees",
    grain: "ticket",
    namedEntities: [],
    tables: [],
    planSteps: ["Ask which lens defines best"],
    summary: "Confirming how to measure best",
    clarification: { question: "By net sales, gross margin, or gross profit per labour hour?" },
    unavailableReason: null,
  });
  assert.equal(kept.disposition, "answer");
  assert.equal(kept.caseId, null);
  assert.equal(kept.clarification, null);
});

test("intent planning teaches layered reports, not per-question hardcodes", () => {
  const intentPlanSource = readFileSync(
    new URL("../../services/conversation/src/intent-plan.ts", import.meta.url),
    "utf8",
  );
  assert.match(intentPlanSource, /PLANNING JUDGMENT/u);
  assert.match(intentPlanSource, /layered deliverable/u);
  // The per-question keyword overrides must not creep back in.
  assert.doesNotMatch(intentPlanSource, /\baged inventory\b/iu);
  assert.doesNotMatch(intentPlanSource, /\bactive customers\b/iu);
  // Depth and formatting are the analyst's judgment, not a server template.
  assert.match(liveAgent, /WHAT GREAT EVIDENCE LOOKS LIKE \(your judgment, not a template\)/u);
  assert.match(liveAgent, /structure and formatting of the answer are yours to judge/u);
  assert.doesNotMatch(liveAgent, /REPORT COMPOSITION|PRESENTATION \(mandatory\)|exactly two short follow-up questions|you MUST follow that sentence/u);
});

test("SQL failure answers do not pretend the shop is empty", async () => {
  const { emptySqlEvidenceAnswerText } = await import("../../services/conversation/src/live.js");
  assert.match(
    emptySqlEvidenceAnswerText({ sqlFailures: ["column s.item_archived does not exist"] }),
    /couldn'?t complete that lookup/iu,
  );
  assert.doesNotMatch(
    emptySqlEvidenceAnswerText({ sqlFailures: ["column s.item_archived does not exist"] }),
    /no results for that/iu,
  );
  assert.equal(
    emptySqlEvidenceAnswerText({ sqlStatus: "empty" }),
    "Sorry, there are no results for that.",
  );
});

test("stock staging columns match the live Lightspeed tables", async () => {
  const { LIGHTSPEED_DIMENSION_DICTIONARIES } = await import("../../packages/agent/src/generated-staging-schema.js");
  const inventory = LIGHTSPEED_DIMENSION_DICTIONARIES.inventory ?? "";
  const catalogue = LIGHTSPEED_DIMENSION_DICTIONARIES.catalogue ?? "";
  assert.match(catalogue, /ls_item_shops[\s\S]*?^ {2}archived\b/mu);
  assert.doesNotMatch(catalogue, /ls_item_shops[\s\S]*?^ {2}item_archived\b/mu);
  assert.match(inventory, /ls_inventory_logs[\s\S]*?^ {2}create_time\b/mu);
  assert.doesNotMatch(inventory, /ls_inventory_logs[\s\S]*?^ {2}created_at\b/mu);
  assert.match(playbook, /`archived` \(not `item_archived`\)/u);
  assert.match(playbook, /ls_inventory_logs\.create_time/u);
  assert.match(playbook, /Give me an aged inventory report/u);
});

// The old banned-alias sweep is superseded by
// tests/contracts/lightspeed-grounding.contract.test.ts, which asserts every
// dictionary column exists in the live DDL — a strictly stronger guarantee
// that also allows legitimately-named columns (ls_processing_fees genuinely
// has update_time). Here we keep only the historical trap columns that DO NOT
// exist and must never be re-taught on their trap tables.
test("known alias traps never reappear on their tables", async () => {
  const { LIGHTSPEED_DIMENSION_DICTIONARIES, LIGHTSPEED_TABLE_INDEX } = await import("../../packages/agent/src/generated-staging-schema.js");
  const traps: readonly [string, string][] = [
    ["ls_item_shops", "item_archived"],
    ["ls_inventory_logs", "created_at"],
    ["ls_customers", "full_name"],
    ["ls_employees", "full_name"],
    ["ls_sales", "change_given"],
    ["ls_purchase_orders", "is_complete"],
    ["ls_items", "category_name"],
  ];
  for (const doc of Object.values(LIGHTSPEED_DIMENSION_DICTIONARIES)) {
    let table = "";
    for (const line of doc.split("\n")) {
      const tableMatch = /^source_lightspeed\.(\w+)/u.exec(line);
      if (tableMatch) table = tableMatch[1] ?? "";
      const columnMatch = /^ {2}([a-z0-9_]+)(?: —|$)/u.exec(line);
      if (!columnMatch) continue;
      for (const [trapTable, trapColumn] of traps) {
        assert.equal(
          table === trapTable && columnMatch[1] === trapColumn,
          false,
          `${trapTable} still lists ${trapColumn}`,
        );
      }
    }
  }
  assert.match(LIGHTSPEED_TABLE_INDEX, /starts with ls_/u);
});
