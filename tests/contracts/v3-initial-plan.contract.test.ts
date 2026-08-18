import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildInitialOwnerPlan,
  canPublishPlanUpdate,
  completeOwnerPlan,
  planAfterEvidenceCount,
  shouldEmitInitialPlan,
} from "../../packages/albert-v3/src/engine/initial-plan.js";
import { createV3Tools } from "../../packages/albert-v3/src/engine/tools.js";
import type { V3ToolRoute } from "../../packages/albert-v3/src/engine/connector-routing.js";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

function intent(overrides: Partial<Parameters<typeof buildInitialOwnerPlan>[0]> = {}) {
  return {
    lane: "analytical" as const,
    resolvedQuestion: "How did sales go this month compared to last month?",
    ownerGoal: "Judge whether trading is on track.",
    answerShape: "comparison" as const,
    answerMustCover: ["This month versus last month", "What drove the change"],
    assumptions: [],
    clarificationQuestion: null,
    clarificationOptions: [],
    recipe: null,
    recipeDateRange: null,
    recipeEntity: null,
    nativeCapability: null,
    ...overrides,
  };
}

function route(): V3ToolRoute {
  return {
    cube: true,
    shopifyQL: false,
    shopifyAdmin: false,
    mode: "cube",
    activeCubeConnectors: ["lightspeed"],
    preferredCubeConnectors: ["lightspeed"],
    unavailableRequestedConnectors: [],
    reasons: [],
  };
}

test("the initial plan is owner-readable, 2-6 steps, and starts with one active step", () => {
  const steps = buildInitialOwnerPlan(intent());
  assert.ok(steps.length >= 2 && steps.length <= 6);
  assert.equal(steps.filter((step) => step.status === "active").length, 1);
  assert.equal(steps[0]?.status, "active");
  assert.ok(steps.every((step) => step.label.length >= 3 && step.label.length <= 200));
  assert.ok(steps.some((step) => /this month versus last month/iu.test(step.label)));
  assert.ok(steps.some((step) => /drove the change/iu.test(step.label)));
});

test("long must-cover points stay whole and do not get a doubled Check prefix", () => {
  const steps = buildInitialOwnerPlan(intent({
    ownerGoal: "Assess May trading performance and identify the strongest sellers",
    answerMustCover: [
      "Whether any qualifying sales occurred in May 2026 and what they totalled",
      "The best-selling category, with its sales value and share of the month",
    ],
  }));
  assert.ok(steps.some((step) => step.label === "Check whether any qualifying sales occurred in May 2026 and what they totalled"));
  assert.ok(steps.some((step) => step.label === "Check the best-selling category, with its sales value and share of the month"));
  assert.ok(steps.some((step) => step.label === "Assess May trading performance and identify the strongest sellers"));
  assert.equal(steps.some((step) => /^Check assess\b/iu.test(step.label)), false);
});

test("shape fallbacks still produce a usable plan when intent is thin", () => {
  const steps = buildInitialOwnerPlan(intent({
    ownerGoal: null,
    answerMustCover: [],
    answerShape: "diagnosis",
  }));
  assert.ok(steps.length >= 2);
  assert.equal(steps[0]?.label, "Check the headline movement");
  assert.ok(steps.some((step) => step.label === "Put the finding together"));
});

test("only investigating lanes emit an initial plan; quick lookups and explain turns stay plan-free", () => {
  assert.equal(shouldEmitInitialPlan("analytical"), true);
  assert.equal(shouldEmitInitialPlan("deep"), true);
  assert.equal(shouldEmitInitialPlan("quick"), false);
  assert.equal(shouldEmitInitialPlan("explain"), false);
  assert.equal(shouldEmitInitialPlan("clarification"), false);
  assert.equal(shouldEmitInitialPlan("off_topic"), false);
});

test("the engine publishes the intent plan before the answering lane starts, and on quick escalation", () => {
  const engine = read("packages/albert-v3/src/engine/engine.ts");
  const lanes = read("packages/albert-v3/src/engine/lanes.ts");
  const tools = read("packages/albert-v3/src/engine/tools.ts");

  assert.match(engine, /shouldEmitInitialPlan\(lane\)\) \{\s*await publishOwnerPlan\(context, buildInitialOwnerPlan\(intent\)\)/u);
  // A quick turn that escalates to the analytical lane gets its plan at that
  // point, ticked to the evidence already gathered.
  assert.match(engine, /if \(!context\.visiblePlan\) \{\s*await publishOwnerPlan\(context, planAfterEvidenceCount\(\s*buildInitialOwnerPlan\(intent\),\s*context\.executedQueries\.length,/u);
  assert.match(engine, /completeVisiblePlan\(context\)/u);
  assert.match(lanes, /Do not replace that\s+opening list/u);
  assert.match(tools, /opening_plan_exists/u);
  assert.match(tools, /syncVisiblePlanToEvidence\(context\)/u);
});

test("the opening plan cannot be replaced until a step is done or a query has run", () => {
  const opening = { publishedCount: 1, queryCount: 0 };
  assert.equal(canPublishPlanUpdate({
    ...opening,
    steps: [{ status: "active" }, { status: "pending" }],
  }), false);
  assert.equal(canPublishPlanUpdate({
    ...opening,
    steps: [{ status: "done" }, { status: "active" }],
  }), true);
  assert.equal(canPublishPlanUpdate({
    publishedCount: 1,
    queryCount: 1,
    steps: [{ status: "active" }, { status: "pending" }],
  }), true);
  assert.equal(canPublishPlanUpdate({
    publishedCount: 2,
    queryCount: 2,
    steps: [{ status: "done" }, { status: "done" }],
  }), false);
});

test("completed queries tick evidence steps one at a time and leave the last step for the answer", () => {
  const opening = buildInitialOwnerPlan(intent({
    answerMustCover: ["This month versus last month", "What drove the change"],
  }));
  assert.equal(opening[0]?.status, "active");
  const afterOne = planAfterEvidenceCount(opening, 1);
  assert.equal(afterOne[0]?.status, "done");
  assert.equal(afterOne[1]?.status, "active");
  const afterMany = planAfterEvidenceCount(opening, 8);
  assert.equal(afterMany.at(-1)?.status, "active");
  assert.ok(afterMany.slice(0, -1).every((step) => step.status === "done"));
  assert.ok(completeOwnerPlan(afterMany).every((step) => step.status === "done"));
});

test("Grok's investigation pass can tick the visible plan", () => {
  const names = createV3Tools({
    route: route(),
    lane: "analytical",
    purpose: "investigation",
  }).map((tool) => tool.name);
  assert.ok(names.includes("update_plan"));
  assert.equal(names.includes("report_progress"), false);
});
