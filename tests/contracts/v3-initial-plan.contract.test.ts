import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyPlannedEvidenceBindings,
  buildInitialOwnerPlan,
  canPublishPlanUpdate,
  planCoverageError,
  settleVisiblePlan,
  settleVisiblePlanAfterFailure,
  shouldEmitInitialPlan,
  validatePlanUpdate,
  type OwnerPlanStep,
} from "../../packages/albert-v3/src/engine/initial-plan.js";
import { createV3Tools } from "../../packages/albert-v3/src/engine/tools.js";
import type { V3TurnContext } from "../../packages/albert-v3/src/engine/context.js";
import type { V3ToolRoute } from "../../packages/albert-v3/src/engine/connector-routing.js";
import { resolveTableResult } from "../../packages/albert-v3/src/engine/prior-results.js";
import { laneModelSettings } from "../../packages/albert-v3/src/engine/lanes.js";
import {
  runWithPlannerDeadline,
  validatePlannedFilterValues,
  type PlannedStep,
} from "../../packages/albert-v3/src/engine/planned-lane.js";

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

function updateFrom(steps: readonly OwnerPlanStep[], changes: Readonly<Record<string, Partial<OwnerPlanStep>>> = {}) {
  return steps.map((step) => ({
    id: step.id,
    label: step.label,
    status: step.status,
    evidenceResultIds: step.evidenceResultIds,
    ...changes[step.id],
  }));
}

function planContext(steps: readonly OwnerPlanStep[], resultIds: readonly string[] = []) {
  const emitted: Array<Record<string, unknown>> = [];
  const tableResults = new Map(resultIds.map((resultId) => [resultId, {
    resultId,
    rowCount: 0,
  }]));
  const context = {
    visiblePlan: steps,
    config: { timezone: "Australia/Melbourne" },
    tableResults,
    priorResults: new Map(),
    executedQueries: [],
    emit: async (event: Record<string, unknown>) => {
      emitted.push(event);
      return event;
    },
  } as unknown as V3TurnContext;
  return { context, emitted };
}

test("the initial plan has stable ids, evidence obligations, and one synthesis step", () => {
  const steps = buildInitialOwnerPlan(intent());
  assert.ok(steps.length >= 2 && steps.length <= 6);
  assert.equal(new Set(steps.map(({ id }) => id)).size, steps.length);
  assert.equal(steps.filter((step) => step.status === "active").length, 1);
  assert.ok(steps.slice(0, -1).every((step) => step.kind === "evidence"));
  assert.equal(steps.at(-1)?.kind, "synthesis");
  assert.ok(steps.every((step) => step.evidenceResultIds.length === 0));
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

test("only investigating lanes emit a checklist", () => {
  assert.equal(shouldEmitInitialPlan("analytical"), true);
  assert.equal(shouldEmitInitialPlan("deep"), true);
  for (const lane of ["quick", "explain", "conceptual", "meta", "clarification", "off_topic"] as const) {
    assert.equal(shouldEmitInitialPlan(lane), false);
  }
});

test("the engine settles plans truthfully and no query-count auto-ticker remains", () => {
  const engine = read("packages/albert-v3/src/engine/engine.ts");
  const tools = read("packages/albert-v3/src/engine/tools.ts");
  const planned = read("packages/albert-v3/src/engine/planned-lane.ts");
  assert.match(engine, /publishOwnerPlan\(context, buildInitialOwnerPlan\(intent\)\)/u);
  assert.match(engine, /settleVisiblePlan\(context, state\)/u);
  assert.match(engine, /settleVisiblePlanAfterFailure/u);
  assert.doesNotMatch(engine, /planAfterEvidenceCount|completeVisiblePlan/u);
  assert.doesNotMatch(tools, /syncVisiblePlanToEvidence/u);
  assert.match(tools, /validatePlanUpdate/u);
  assert.match(planned, /coversPlanStepIds/u);
  assert.match(planned, /PLANNER_DEADLINE_MS = 60_000/u);
  assert.match(planned, /Switching to an adaptive investigation/u);
  assert.match(planned, /const explicitlyCrossConnector/u);
});

test("the one-shot planner preserves the user's selected reasoning effort", () => {
  const settings = laneModelSettings(
    { model: "gpt-5.6-sol", reasoningEffort: "max", fastMode: false },
    "medium",
  );
  assert.equal(settings.reasoning.effort, "max");
  const grokSettings = laneModelSettings(
    { model: "grok-4.6", reasoningEffort: "max", fastMode: false },
    "medium",
  );
  assert.equal(grokSettings.reasoning.effort, "xhigh");
});

test("the planner deadline aborts a delayed provider call without changing effort", async () => {
  const started = Date.now();
  const attempt = await runWithPlannerDeadline(
    (signal) => new Promise<string>((resolve, reject) => {
      const keepAlive = setTimeout(() => resolve("late"), 1_000);
      if (signal.aborted) {
        clearTimeout(keepAlive);
        return reject(signal.reason);
      }
      signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      }, { once: true });
    }),
    undefined,
    10,
  );
  assert.equal(attempt.timedOut, true);
  assert.ok(Date.now() - started < 500, "test deadline should not wait for the production interval");
});

test("research validates model-proposed filters against exact stored values", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const context = {
    cube: {
      loadQuery: async (query: Record<string, unknown>) => {
        calls.push(query);
        const operator = (query.filters as Array<{ operator: string }>)[0]?.operator;
        return {
          validated: {},
          result: {
            ok: true as const,
            rows: operator === "equals" ? [] : [{ "product_sales_analytics.items_name": "General Service" }],
            annotation: {},
            executionMs: 1,
            cached: false,
          },
        };
      },
    },
  } as unknown as V3TurnContext;
  const steps: PlannedStep[] = [{
    topic: "General service sales",
    measures: ["product_sales_analytics.line_revenue"],
    dimensions: ["product_sales_analytics.items_name"],
    filters: [{
      member: "product_sales_analytics.items_name",
      operator: "contains",
      values: ["Gneral Service"],
    }],
    bind: null,
    coversPlanStepIds: ["plan_step_1"],
  }];
  const validation = await validatePlannedFilterValues({
    context,
    catalogue: {
      fetchedAt: "2026-08-19T00:00:00.000Z",
      views: [{
        name: "product_sales_analytics",
        title: "Product sales",
        members: [{
          name: "product_sales_analytics.items_name",
          kind: "dimension",
          title: "Item",
          shortTitle: "Item",
          type: "string",
        }],
      }],
    },
    steps,
  });
  assert.equal(validation.ok, true);
  assert.equal(calls.length, 2, "research tries exact equality before a fuzzy stored-value lookup");
  assert.deepEqual(validation.steps[0]?.filters, [{
    member: "product_sales_analytics.items_name",
    operator: "equals",
    values: ["General Service"],
  }]);
  assert.equal(validation.findings[0], "Validated 1 stored items name value.");
});

test("the opening plan cannot be replaced before evidence or an honest terminal state", () => {
  assert.equal(canPublishPlanUpdate({
    publishedCount: 1,
    queryCount: 0,
    steps: [{ status: "active" }, { status: "pending" }],
  }), false);
  assert.equal(canPublishPlanUpdate({
    publishedCount: 1,
    queryCount: 0,
    steps: [{ status: "blocked" }, { status: "incomplete" }],
  }), false, "an already-terminal plan cannot be rewritten");
  assert.equal(canPublishPlanUpdate({
    publishedCount: 1,
    queryCount: 1,
    steps: [{ status: "done" }, { status: "active" }],
  }), true);
});

test("done requires an exact successful result and stable step identity", () => {
  const opening = buildInitialOwnerPlan(intent());
  const resultId = "01PLANRESULT0000000000000000";
  const nextId = opening[1]!.id;
  const valid = validatePlanUpdate({
    current: opening,
    proposed: updateFrom(opening, {
      [opening[0]!.id]: { status: "done", evidenceResultIds: [resultId] },
      [nextId]: { status: "active" },
    }),
    availableResultIds: new Set([resultId]),
  });
  assert.equal(valid.ok, true);

  const unknown = validatePlanUpdate({
    current: opening,
    proposed: updateFrom(opening, {
      [opening[0]!.id]: { status: "done", evidenceResultIds: ["01MISSINGRESULT0000000000000"] },
      [nextId]: { status: "active" },
    }),
    availableResultIds: new Set([resultId]),
  });
  assert.equal(unknown.ok, false);

  const reordered = validatePlanUpdate({
    current: opening,
    proposed: updateFrom(opening).reverse(),
    availableResultIds: new Set([resultId]),
  });
  assert.equal(reordered.ok, false);
});

test("planned queries complete only the explicit steps they cover, independent of row count", async () => {
  const opening = buildInitialOwnerPlan(intent());
  const resultId = "01EMPTYRESULT000000000000000";
  const { context, emitted } = planContext(opening, [resultId]);
  await applyPlannedEvidenceBindings(context, [{
    coversPlanStepIds: [opening[0]!.id],
    ok: true,
    resultIds: [resultId],
  }]);
  assert.equal(context.visiblePlan?.[0]?.status, "done");
  assert.deepEqual(context.visiblePlan?.[0]?.evidenceResultIds, [resultId]);
  assert.equal(context.visiblePlan?.[0]?.statusDetail, undefined, "completion commentary belongs in the main activity stream");
  assert.equal(context.visiblePlan?.[1]?.status, "active");
  assert.equal(context.visiblePlan?.[2]?.status, "pending");
  assert.equal(emitted.at(-1)?.type, "narrative");
  assert.match(String(emitted.at(-1)?.text ?? ""), /is complete[\s\S]*No matching rows/u);

  const combined = planContext(opening, [resultId]);
  await applyPlannedEvidenceBindings(combined.context, [
    { coversPlanStepIds: [opening[0]!.id], ok: true, resultIds: [resultId] },
    { coversPlanStepIds: [opening[0]!.id], ok: false, resultIds: [] },
  ]);
  assert.equal(combined.context.visiblePlan?.[0]?.status, "active", "reused success cannot hide a failed new dependency");
});

test("planned queries and branches must map every unit to a real evidence step", () => {
  const opening = buildInitialOwnerPlan(intent());
  assert.equal(planCoverageError(opening, [[opening[0]!.id], [opening[1]!.id]]), undefined);
  assert.match(planCoverageError(opening, [[opening[0]!.id], []]) ?? "", /not mapped/u);
  assert.match(planCoverageError(opening, [[opening.at(-1)!.id]]) ?? "", /non-evidence/u);
  assert.match(planCoverageError(opening, [["unknown_step"]]) ?? "", /unknown/u);
  assert.equal(planCoverageError(undefined, [[]]), undefined, "quick planned turns have no visible checklist");
});

test("a declared prior result is re-emitted before it can complete a plan step", async () => {
  const opening = buildInitialOwnerPlan(intent());
  const resultId = "01PRIORRESULT000000000000000";
  const fixture = planContext(opening);
  fixture.context.priorResults.set(resultId, {
    resultId,
    turnsAgo: 1,
    caption: "Earlier margin",
    presentation: "evidence",
    columns: [{ key: "margin", label: "Margin", type: "percent" }],
    rows: [{ margin: 42 }],
    rowCount: 1,
  });
  const table = await resolveTableResult(fixture.context, resultId);
  assert.ok(table);
  await applyPlannedEvidenceBindings(fixture.context, [{
    coversPlanStepIds: [opening[0]!.id],
    ok: true,
    resultIds: [resultId],
  }]);
  assert.equal(fixture.context.visiblePlan?.[0]?.status, "done");
  assert.equal(fixture.emitted[0]?.type, "table", "current trace receives the evidence before the plan tick");
  assert.equal(fixture.emitted[1]?.type, "plan");
});

test("final settlement preserves supported work and exposes blocked or incomplete work", async () => {
  const opening = buildInitialOwnerPlan(intent());
  const resultId = "01SUPPORTEDRESULT000000000000";
  const supported = {
    ...opening[0]!,
    status: "done" as const,
    evidenceResultIds: [resultId],
  };
  const { context } = planContext([supported, ...opening.slice(1)], [resultId]);
  await settleVisiblePlan(context, "Verified");
  assert.equal(context.visiblePlan?.[0]?.status, "done");
  assert.ok(context.visiblePlan?.slice(1, -1).every(({ status }) => status === "incomplete"));
  assert.equal(context.visiblePlan?.at(-1)?.status, "done");

  const unavailable = planContext(opening);
  await settleVisiblePlan(unavailable.context, "Unavailable");
  assert.equal(unavailable.context.visiblePlan?.[0]?.status, "blocked");
  assert.ok(unavailable.context.visiblePlan?.slice(1).every(({ status }) => status === "incomplete"));
  assert.ok(unavailable.context.visiblePlan?.every(({ statusDetail, status }) => (
    status === "done" || Boolean(statusDetail)
  )));
});

test("thrown and cancelled turns terminalise open plan steps", async () => {
  const opening = buildInitialOwnerPlan(intent());
  const failed = planContext(opening);
  await settleVisiblePlanAfterFailure(failed.context, "blocked");
  assert.equal(failed.context.visiblePlan?.[0]?.status, "blocked");
  assert.ok(failed.context.visiblePlan?.slice(1).every(({ status }) => status === "incomplete"));

  const cancelled = planContext(opening);
  await settleVisiblePlanAfterFailure(cancelled.context, "cancelled");
  assert.ok(cancelled.context.visiblePlan?.every(({ status }) => status === "incomplete"));
  assert.ok(cancelled.context.visiblePlan?.every(({ statusDetail }) => /stopped before completion/u.test(statusDetail ?? "")));
});

test("the analytical tool surface retains evidence-bound update_plan", () => {
  const names = createV3Tools({
    route: route(),
    lane: "analytical",
    purpose: "investigation",
  }).map((tool) => tool.name);
  assert.ok(names.includes("update_plan"));
  assert.equal(names.includes("report_progress"), false);
});
