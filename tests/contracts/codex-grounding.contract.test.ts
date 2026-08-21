import assert from "node:assert/strict";
import test from "node:test";
import type { CodexFinalAnswer } from "../../packages/albert-codex/src/contracts.ts";
import {
  buildCodexEvidenceRecoveryAnswer,
  codexClaimCandidates,
  codexFinalSufficiencyGap,
  codexQueryRecoveryGuidance,
  validateCodexFinalAnswer,
  type CodexEvidenceResult,
} from "../../packages/albert-codex/src/semantic-runtime.ts";

const provenance = {
  sources: [{ connector: "lightspeed" as const, label: "Cube", dataThrough: "2026-08-20" }],
  timeRange: { label: "This month", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
  definitions: [],
  semanticBundleHash: "fixture",
  identityGraph: { version: 0, hash: "fixture" },
};

const evidence: CodexEvidenceResult = {
  resultId: "01J00000000000000000000011",
  topic: "Net sales",
  view: "sales_analytics",
  connector: "lightspeed",
  query: { measures: ["sales_analytics.net_sales"], limit: 1 },
  queryYaml: "measures:\n  - sales_analytics.net_sales",
  columns: [{ key: "sales_analytics.net_sales", label: "Net sales", type: "currency", currency: "AUD" }],
  rows: [{ "sales_analytics.net_sales": 100 }],
  provenance,
  executionMs: 10,
  rowCount: 1,
};

function draft(answer: string): CodexFinalAnswer {
  return {
    state: "Verified",
    answer,
    followUps: [],
    presentedResultIds: [evidence.resultId],
    claims: [],
  };
}

test("Codex verified prose may restate only figures returned by governed cells", () => {
  const valid = validateCodexFinalAnswer(draft("Net sales were $100."), [evidence]);
  assert.equal(valid.final.state, "Verified");

  const invented = validateCodexFinalAnswer(draft("Net sales were $101."), [evidence]);
  assert.equal(invented.final.state, "Unavailable");
  assert.equal(invented.final.presentedResultIds.length, 0);
});

test("Codex comparisons and result references fail closed without proof", () => {
  const comparison = validateCodexFinalAnswer(draft("Net sales were highest at $100."), [evidence]);
  assert.equal(comparison.final.state, "Unavailable");

  const unknown = validateCodexFinalAnswer({
    ...draft("Net sales were $100."),
    presentedResultIds: ["01J00000000000000000000012"],
  }, [evidence]);
  assert.equal(unknown.final.state, "Unavailable");

  const noEvidence = validateCodexFinalAnswer(draft("Sales look stable."), []);
  assert.equal(noEvidence.final.state, "Unavailable");

  const definitionOnly = validateCodexFinalAnswer({
    state: "Exploratory",
    answer: "Net sales is a lower-level governed measure than gross takings.",
    followUps: [],
    presentedResultIds: [],
    claims: [],
  }, [], { definitionEvidenceCount: 1 });
  assert.equal(definitionOnly.final.state, "Exploratory");
});

test("Codex can recover a qualified answer from governed cells after a late harness failure", () => {
  const workshop: CodexEvidenceResult = {
    ...evidence,
    resultId: "01J00000000000000000000016",
    topic: "Recent monthly workshop intake",
    view: "workshop_analytics",
    query: {
      measures: ["workshop_analytics.workorder_count"],
      timeDimensions: [{
        dimension: "workshop_analytics.checked_in_at",
        granularity: "month",
        dateRange: ["2026-02-01", "2026-07-31"],
      }],
      order: { "workshop_analytics.checked_in_at": "asc" },
      limit: 12,
    },
    columns: [
      { key: "workshop_analytics.checked_in_at.month", label: "Checked in at", type: "datetime" },
      { key: "workshop_analytics.workorder_count", label: "Workorders", type: "number" },
    ],
    rows: [
      { "workshop_analytics.checked_in_at.month": "2026-02-01T00:00:00.000", "workshop_analytics.workorder_count": 196 },
      { "workshop_analytics.checked_in_at.month": "2026-07-01T00:00:00.000", "workshop_analytics.workorder_count": 127 },
    ],
    rowCount: 2,
  };
  const customers: CodexEvidenceResult = {
    ...evidence,
    resultId: "01J00000000000000000000017",
    topic: "Lapsed repeat customers",
    view: "customer_analytics",
    query: { measures: ["customer_analytics.customer_count"], limit: 1 },
    columns: [{ key: "customer_analytics.customer_count", label: "Customer count", type: "number" }],
    rows: [{ "customer_analytics.customer_count": 420 }],
    rowCount: 1,
  };

  const recovered = buildCodexEvidenceRecoveryAnswer({
    question: "Find one high-confidence opportunity I could test this month",
    evidence: [workshop, customers],
    findings: ["Workshop intake fell from 196 workorders in February to 127 in July."],
  });

  assert.ok(recovered);
  assert.equal(recovered.final.state, "Qualified");
  assert.match(recovered.final.answer, /workshop-demand reactivation test/iu);
  assert.match(recovered.final.answer, /196 workorders/iu);
  assert.match(recovered.final.answer, /contactability and consent/iu);
  assert.ok(recovered.claims.some((claim) => claim.assertion === "greater_than"));
  assert.deepEqual(new Set(recovered.final.presentedResultIds), new Set([workshop.resultId, customers.resultId]));

  const recoveredAfterRejectedCommentary = buildCodexEvidenceRecoveryAnswer({
    question: "Find one high-confidence opportunity I could test this month",
    evidence: [workshop, customers],
    findings: [
      "In the 12-month completed-sales series, workshop intake was 196 workorders before reaching 127 workorders, making the recent baseline materially softer than the stronger months.",
    ],
  });
  assert.ok(recoveredAfterRejectedCommentary);
  assert.equal(recoveredAfterRejectedCommentary.final.state, "Qualified");
  assert.notEqual(recoveredAfterRejectedCommentary.final.answer, "The Codex analysis could not be completed safely.");
});

test("Codex host-generates ranked claims and removes accidental extra numeric refs", () => {
  const rankedEvidence: CodexEvidenceResult = {
    ...evidence,
    resultId: "01J00000000000000000000013",
    topic: "Category ranking",
    query: {
      measures: ["sales_analytics.net_sales", "sales_analytics.transactions"],
      dimensions: ["sales_analytics.category"],
      order: { "sales_analytics.net_sales": "desc" },
      limit: 10,
    },
    columns: [
      { key: "sales_analytics.category", label: "Category", type: "string" },
      { key: "sales_analytics.net_sales", label: "Net sales", type: "currency", currency: "AUD" },
      { key: "sales_analytics.transactions", label: "Transactions", type: "number" },
    ],
    rows: [
      {
        "sales_analytics.category": "Bikes",
        "sales_analytics.net_sales": 100,
        "sales_analytics.transactions": 10,
      },
      {
        "sales_analytics.category": "Parts",
        "sales_analytics.net_sales": 80,
        "sales_analytics.transactions": 8,
      },
    ],
    rowCount: 2,
  };

  const candidates = codexClaimCandidates([rankedEvidence]);
  const rank = candidates.find((candidate) => candidate.assertion === "highest");
  assert.ok(rank);
  assert.deepEqual(rank.refs, [
    { resultId: rankedEvidence.resultId, rowIndex: 0, columnKey: "sales_analytics.net_sales" },
    { resultId: rankedEvidence.resultId, rowIndex: 0, columnKey: "sales_analytics.category" },
  ]);

  const validated = validateCodexFinalAnswer({
    state: "Verified",
    answer: "Bikes had the highest Net sales at $100.",
    followUps: [],
    presentedResultIds: [rankedEvidence.resultId],
    claims: [{
      statement: "Bikes led the ranking.",
      assertion: "highest",
      refs: [
        { resultId: rankedEvidence.resultId, rowIndex: 0, columnKey: "sales_analytics.net_sales" },
        { resultId: rankedEvidence.resultId, rowIndex: 0, columnKey: "sales_analytics.transactions" },
        { resultId: rankedEvidence.resultId, rowIndex: 0, columnKey: "sales_analytics.category" },
      ],
    }],
  }, [rankedEvidence]);

  assert.equal(validated.final.state, "Verified", validated.validationDetail);
  assert.deepEqual(validated.claims[0]?.refs, rank.refs);

  const unorderedCandidates = codexClaimCandidates([{
    ...rankedEvidence,
    query: {
      measures: ["sales_analytics.net_sales", "sales_analytics.transactions"],
      dimensions: ["sales_analytics.category"],
    },
  }]);
  assert.equal(unorderedCandidates.some((candidate) => candidate.assertion === "highest"), false);
});

test("Codex cannot treat blank R-Series catalogue prices as exhaustive evidence", () => {
  const inventoryResult: CodexEvidenceResult = {
    ...evidence,
    resultId: "01J00000000000000000000014",
    topic: "Current product prices",
    view: "inventory_analytics",
    query: {
      dimensions: [
        "inventory_analytics.items_item_id",
        "inventory_analytics.items_name",
        "inventory_analytics.items_default_price",
        "inventory_analytics.items_msrp",
      ],
    },
    columns: [
      { key: "inventory_analytics.items_item_id", label: "Item ID", type: "number" },
      { key: "inventory_analytics.items_name", label: "Item name", type: "string" },
      { key: "inventory_analytics.items_default_price", label: "Default retail price", type: "currency", currency: "AUD" },
      { key: "inventory_analytics.items_msrp", label: "MSRP", type: "currency", currency: "AUD" },
    ],
    rows: [{
      "inventory_analytics.items_item_id": 101,
      "inventory_analytics.items_name": "Fixture bicycle",
      "inventory_analytics.items_default_price": null,
      "inventory_analytics.items_msrp": null,
    }],
    rowCount: 1,
  };
  const priceDraft: CodexFinalAnswer = {
    state: "Qualified",
    answer: "Current selling prices aren’t available in the governed catalogue data.",
    followUps: [],
    presentedResultIds: [inventoryResult.resultId],
    claims: [],
  };
  const question = "What are the current selling prices for these products?";

  const gap = codexFinalSufficiencyGap(question, priceDraft, [inventoryResult]);
  assert.equal(gap?.code, "selling_price_recovery_required");
  assert.match(gap?.repairInstruction ?? "", /product_sales_analytics/u);
  assert.match(
    codexQueryRecoveryGuidance(question, inventoryResult, []) ?? "",
    /normal_unit_price/u,
  );

  const observedResult: CodexEvidenceResult = {
    ...evidence,
    resultId: "01J00000000000000000000015",
    topic: "Last observed selling price",
    view: "product_sales_analytics",
    query: { dimensions: ["product_sales_analytics.normal_unit_price"] },
    columns: [{
      key: "product_sales_analytics.normal_unit_price",
      label: "Normal unit price",
      type: "currency",
      currency: "AUD",
    }],
    rows: [],
    rowCount: 0,
  };
  assert.equal(codexFinalSufficiencyGap(question, priceDraft, [inventoryResult, observedResult]), null);

  const populatedCatalogue = {
    ...inventoryResult,
    rows: [{
      ...inventoryResult.rows[0],
      "inventory_analytics.items_default_price": 4999,
    }],
  };
  assert.equal(codexFinalSufficiencyGap(question, priceDraft, [populatedCatalogue]), null);
});
