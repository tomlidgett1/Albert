import assert from "node:assert/strict";
import test from "node:test";
import { assertOrderedSanitizedTrace, type TraceEvent } from "../../packages/shared/src/agent-runtime.ts";
import {
  applyCodexNativePlan,
  bindCodexPlanEvidence,
  createCodexFallbackPlan,
  readCodexNativePlan,
  settleCodexPlan,
  shouldCreateCodexFallbackPlan,
} from "../../packages/albert-codex/src/plan-runtime.ts";

const firstResultId = "01J00000000000000000000101";
const secondResultId = "01J00000000000000000000102";

function nativePlan(statuses: readonly ["pending" | "inProgress" | "completed", "pending" | "inProgress" | "completed", "pending" | "inProgress" | "completed"]) {
  return {
    turnId: "turn_plan_fixture",
    plan: [
      { step: "Compare 12 months of sales and AUD 1,000 thresholds", status: statuses[0] },
      { step: "Test margin, refunds, mix, stock and labour drivers", status: statuses[1] },
      { step: "Reconcile the evidence and present one supported action", status: statuses[2] },
    ],
  };
}

test("Codex native plans become stable evidence-bound task lists that tick to completion", () => {
  const opening = applyCodexNativePlan(undefined, "turn/plan/updated", nativePlan([
    "inProgress", "pending", "pending",
  ]));
  assert.ok(opening);
  assert.equal(opening.source, "native");
  assert.deepEqual(opening.steps.map((step) => step.status), ["active", "pending", "pending"]);
  assert.match(opening.steps[0]?.label ?? "", /12 months/u);
  assert.doesNotMatch(opening.steps[0]?.label ?? "", /AUD 1,000/u);

  const withFirstEvidence = bindCodexPlanEvidence(opening, firstResultId);
  assert.equal(withFirstEvidence.steps[0]?.status, "active");
  assert.deepEqual(withFirstEvidence.steps[0]?.evidenceResultIds, [firstResultId]);

  const middle = applyCodexNativePlan(withFirstEvidence, "turn/plan/updated", nativePlan([
    "completed", "inProgress", "pending",
  ]));
  assert.ok(middle);
  assert.deepEqual(middle.steps.map((step) => step.status), ["done", "active", "pending"]);

  const withSecondEvidence = bindCodexPlanEvidence(middle, secondResultId);
  const nativeComplete = applyCodexNativePlan(withSecondEvidence, "turn/plan/updated", nativePlan([
    "completed", "completed", "completed",
  ]));
  assert.ok(nativeComplete);
  assert.deepEqual(nativeComplete.steps.map((step) => step.status), ["done", "done", "active"]);
  assert.deepEqual(nativeComplete.steps.map((step) => step.id), [
    "codex_plan_step_1", "codex_plan_step_2", "codex_plan_step_3",
  ]);

  const settled = settleCodexPlan(nativeComplete, "Verified");
  assert.deepEqual(settled.steps.map((step) => step.status), ["done", "done", "done"]);
  assert.deepEqual(settled.steps[2]?.evidenceResultIds, [firstResultId, secondResultId]);
});

test("Codex plan parsing rejects unsafe snapshots and ignores repair-turn plan resets", () => {
  assert.equal(readCodexNativePlan("turn/plan/updated", {
    turnId: "turn_unsafe",
    plan: [
      { step: "Open https://example.com", status: "inProgress" },
      { step: "Return {\"state\":\"Verified\"}", status: "pending" },
    ],
  }), null);

  const opening = applyCodexNativePlan(undefined, "turn/plan/updated", nativePlan([
    "inProgress", "pending", "pending",
  ]));
  assert.ok(opening);
  const repairPlan = applyCodexNativePlan(opening, "turn/plan/updated", {
    ...nativePlan(["completed", "completed", "completed"]),
    turnId: "turn_repair_fixture",
  });
  assert.equal(repairPlan, opening);
});

test("complex questions get a bounded fallback plan while scalar lookups do not", () => {
  assert.equal(shouldCreateCodexFallbackPlan(
    "Diagnose what changed across sales, inventory, customer retention and cash, then recommend an experiment.",
  ), true);
  assert.equal(shouldCreateCodexFallbackPlan("What were net sales yesterday?"), false);

  const fallback = createCodexFallbackPlan();
  const afterFirst = bindCodexPlanEvidence(fallback, firstResultId);
  const afterSecond = bindCodexPlanEvidence(afterFirst, secondResultId);
  assert.deepEqual(afterFirst.steps.map((step) => step.status), ["done", "active", "pending"]);
  assert.deepEqual(afterSecond.steps.map((step) => step.status), ["done", "done", "active"]);
  assert.deepEqual(settleCodexPlan(afterSecond, "Verified").steps.map((step) => step.status), [
    "done", "done", "done",
  ]);
});

test("evidence-bound Codex plan snapshots satisfy the shared ordered trace contract", () => {
  const opening = applyCodexNativePlan(undefined, "turn/plan/updated", nativePlan([
    "inProgress", "pending", "pending",
  ]));
  assert.ok(opening);
  const first = bindCodexPlanEvidence(opening, firstResultId);
  const middle = applyCodexNativePlan(first, "turn/plan/updated", nativePlan([
    "completed", "inProgress", "pending",
  ]));
  assert.ok(middle);
  const second = bindCodexPlanEvidence(middle, secondResultId);
  const complete = settleCodexPlan(second, "Verified");
  const provenance = {
    sources: [{ connector: "lightspeed" as const, label: "Fixture sales", dataThrough: "2026-08-21" }],
    timeRange: { label: "Fixture period", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
    definitions: [],
    semanticBundleHash: "fixture-plan",
    identityGraph: { version: 0, hash: "fixture-plan" },
  };
  const at = (seconds: number) => `2026-08-21T00:00:${String(seconds).padStart(2, "0")}.000Z`;
  const events: TraceEvent[] = [
    { id: "plan_open", sequence: 1, occurredAt: at(1), type: "plan", status: "complete", steps: opening.steps },
    {
      id: "table_one", sequence: 2, occurredAt: at(2), type: "table", status: "complete",
      caption: "First fixture result", columns: [{ key: "value", label: "Value", type: "number" }],
      rows: [{ value: 1 }], resultId: firstResultId, provenance,
    },
    { id: "plan_middle", sequence: 3, occurredAt: at(3), type: "plan", status: "complete", steps: middle.steps },
    {
      id: "table_two", sequence: 4, occurredAt: at(4), type: "table", status: "complete",
      caption: "Second fixture result", columns: [{ key: "value", label: "Value", type: "number" }],
      rows: [{ value: 2 }], resultId: secondResultId, provenance,
    },
    { id: "plan_complete", sequence: 5, occurredAt: at(5), type: "plan", status: "complete", steps: complete.steps },
    {
      id: "answer_complete", sequence: 6, occurredAt: at(6), type: "answer", status: "complete",
      state: "Verified", text: "The fixture investigation is complete.", provenance, followUps: [],
    },
  ];
  assert.doesNotThrow(() => assertOrderedSanitizedTrace(events));
});
