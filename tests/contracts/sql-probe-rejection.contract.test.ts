import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { sqlProbeRejection } from "../../services/conversation/src/live.js";

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
      SELECT date_trunc('month', s.complete_time AT TIME ZONE 'Australia/Sydney') AS month,
             SUM(s.calc_total) AS sales_inc_gst
      FROM source_lightspeed.ls_sales s
      WHERE s.mapping_version = (SELECT mv FROM pack)
        AND NOT s.tombstone AND s.completed AND NOT s.voided
      GROUP BY 1 ORDER BY 1`,
    }),
    null,
  );
});

test("SQL evidence instructions ban diagnose spirals and cap turns", () => {
  assert.match(liveAgent, /Never preflight with SELECT 1/u);
  assert.match(liveAgent, /Chart questions: one aggregate query, then make_chart/u);
  assert.match(liveAgent, /last 26 calendar weeks/u);
  assert.match(liveAgent, /Do not silently LIMIT to 10 buckets/u);
  assert.match(liveAgent, /maxTurns: 12/u);
  assert.match(liveAgent, /sqlProbeRejection/u);
  assert.match(liveAgent, /isOwnerTrailValidation/u);
  assert.match(liveAgent, /const tools = \[resolveNamedEntity, runSql, askUser, remember, makeChart, openDimensionGuide\]/u);
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
  // defaults + ask_user carry the rest.
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

test("a contracted clarification is preserved for the route", async () => {
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
  assert.equal(kept.disposition, "clarification");
  assert.equal(kept.caseId, "workforce-best");
});

test("intent planning teaches layered reports, not per-question hardcodes", () => {
  const intentPlanSource = readFileSync(
    new URL("../../services/conversation/src/intent-plan.ts", import.meta.url),
    "utf8",
  );
  assert.match(intentPlanSource, /REPORTS AND ANALYSES/u);
  assert.match(intentPlanSource, /layered deliverable/u);
  // The per-question keyword overrides must not creep back in.
  assert.doesNotMatch(intentPlanSource, /\baged inventory\b/iu);
  assert.doesNotMatch(intentPlanSource, /\bactive customers\b/iu);
  assert.match(liveAgent, /REPORTS AND ANALYSES/u);
  assert.match(liveAgent, /REPORT COMPOSITION/u);
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
