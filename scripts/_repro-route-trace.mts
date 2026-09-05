/**
 * Replays the failing turn 01M0HBYH455VA7D6MVMY3V81RZ ("graph cumulative GP
 * this year please and then forecast...") through the route-side trace
 * pipeline: projectCodexRuntimeEvent + createTraceEmitter's synchronous
 * assertOrderedSanitizedTrace, using the real plan-runtime transitions.
 */
import {
  applyCodexNativePlan,
  bindCodexPlanEvidence,
  codexPlanStepsEqual,
  settleCodexPlan,
  type CodexVisiblePlanState,
} from "../packages/albert-codex/src/plan-runtime.js";
import {
  createCodexTraceTransportState,
  projectCodexRuntimeEvent,
} from "../packages/albert-codex/src/trace-transport.js";
import type { CodexTraceEventInput } from "../packages/albert-codex/src/semantic-runtime.js";
import { createTraceEmitter } from "../services/conversation/src/trace-emitter.js";

const tableIds = [
  "01M0HBZ57RRK4N5MTF84EDR32A",
  "01M0HBZARZ268QMRG2BDTDX4DP",
  "01M0HBZKQGQQXJSV7YZG4T1AXG",
  "01M0HBZNRPRXWYQ80ZTFNEYBWS",
  "01M0HBZWJWPV7XNS8C550J79XG",
];
const chartTableId = "01M0HC015ANJ78NWM6NSDB7SYR";

const provenance = {
  sources: [{ connector: "lightspeed", label: "Cube semantic layer · lightspeed", dataThrough: "unknown" }],
  timeRange: { label: "2026-01-01 to 2026-12-31", start: "2026-01-01", end: "2026-12-31", timezone: "Australia/Melbourne" },
  definitions: [],
  semanticBundleHash: "albert-codex-cube-fixture",
  identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
} as const;

function tableEvent(resultId: string): CodexTraceEventInput {
  return {
    type: "table",
    status: "complete",
    caption: "sales_analytics",
    columns: [{ key: "sales_analytics.gross_profit", label: "Gross profit", type: "currency", currency: "AUD" }],
    rows: [{ "sales_analytics.gross_profit": 100 }],
    resultId,
    provenance,
    presentation: "evidence",
  } as CodexTraceEventInput;
}

// --- Mirror the runtime's plan lifecycle exactly -----------------------------
let planState: CodexVisiblePlanState | undefined;
let publishedSteps: CodexVisiblePlanState["steps"] | undefined;
const runtimeEvents: CodexTraceEventInput[] = [];
function publishPlan(next: CodexVisiblePlanState | undefined) {
  if (!next) return;
  planState = next;
  if (codexPlanStepsEqual(publishedSteps, next.steps)) return;
  runtimeEvents.push({
    type: "plan",
    status: next.steps.some((step) => step.status === "blocked" || step.status === "incomplete") ? "warning" : "complete",
    steps: next.steps,
  } as CodexTraceEventInput);
  publishedSteps = next.steps;
}

runtimeEvents.push({ type: "progress", status: "running", stage: "planning", label: "Codex is planning the analysis", detail: "Using Albert’s governed semantic catalogue" } as CodexTraceEventInput);
publishPlan(applyCodexNativePlan(undefined, "turn/plan/updated", {
  turnId: "turn_fixture",
  plan: [
    { step: "Find the governed gross-profit view and exact time definitions", status: "inProgress" },
    { step: "Retrieve the year-to-date gross-profit time series", status: "pending" },
    { step: "Assess coverage and produce a clearly labelled year-end projection", status: "pending" },
  ],
}));
for (const resultId of tableIds) {
  runtimeEvents.push(tableEvent(resultId));
  publishPlan(planState ? bindCodexPlanEvidence(planState, resultId) : planState);
}
// The cumulative chart: derived table + chart event (no plan bind, as in the runtime).
runtimeEvents.push({
  ...tableEvent(chartTableId),
  caption: "Cumulative Lightspeed gross profit — 2026 monthly actuals (AUD; August partial) — chart data",
} as CodexTraceEventInput);
runtimeEvents.push({
  type: "chart",
  status: "complete",
  caption: "Cumulative Lightspeed gross profit — 2026 monthly actuals (AUD; August partial)",
  chartType: "line",
  dataRef: chartTableId,
  xKey: "sales_analytics.completed_at.month",
  yKey: "sales_analytics.gross_profit",
} as CodexTraceEventInput);
// Terminal: settled plan, validation, answer — exactly as runCodexSemanticTurn emits them.
publishPlan(planState ? settleCodexPlan(planState, "Qualified") : planState);
runtimeEvents.push({
  type: "validation",
  status: "complete",
  name: "Codex evidence grounding",
  outcome: "passed",
  detail: "Every figure and structured claim is bound to governed result cells from this turn.",
} as CodexTraceEventInput);
runtimeEvents.push({
  type: "answer",
  status: "complete",
  state: "Qualified",
  text: "**Cumulative gross profit is charted.** August is partial; the projection is an estimate.",
  provenance,
  followUps: [],
  presentedResultIds: [chartTableId],
  presentedTables: [],
  claims: [],
} as CodexTraceEventInput);

// --- Route side --------------------------------------------------------------
const emit = createTraceEmitter({
  persist: async () => {},
  deliver: () => {},
});
// The route emits the acknowledgement narrative before releasing runtime events.
await emit({ type: "narrative", purpose: "acknowledgement", text: "I’ll organise the cumulative GP graph." } as CodexTraceEventInput);
let transport = createCodexTraceTransportState();
for (const [index, event] of runtimeEvents.entries()) {
  const projected = projectCodexRuntimeEvent(transport, event);
  transport = projected.state;
  for (const accepted of projected.events) {
    try {
      await emit(accepted);
    } catch (error) {
      console.error(`THROW on runtime event ${index} (${event.type}) → projected ${accepted.type}:`);
      console.error(error instanceof Error ? error.message : error);
      if (accepted.type === "plan") {
        console.error(JSON.stringify((accepted as { steps: unknown }).steps, null, 2));
      }
      process.exit(1);
    }
  }
}
console.log("replay passed with no throw");

// --- Theory check: the model marks its plan completed after all evidence
// landed on step 1; reconcileNativeStatuses donates a popped id to step 2.
{
  let state: CodexVisiblePlanState | undefined;
  let published: CodexVisiblePlanState["steps"] | undefined;
  const plans: CodexTraceEventInput[] = [];
  const push = (next: CodexVisiblePlanState | undefined) => {
    if (!next) return;
    state = next;
    if (codexPlanStepsEqual(published, next.steps)) return;
    plans.push({ type: "plan", status: "complete", steps: next.steps } as CodexTraceEventInput);
    published = next.steps;
  };
  const nativePlan = (statuses: readonly string[]) => ({
    turnId: "turn_fixture2",
    plan: [
      { step: "Find the governed gross-profit view", status: statuses[0] },
      { step: "Retrieve the year-to-date series", status: statuses[1] },
      { step: "Produce the projection", status: statuses[2] },
    ],
  });
  push(applyCodexNativePlan(undefined, "turn/plan/updated", nativePlan(["inProgress", "pending", "pending"])));
  for (const resultId of tableIds) push(state ? bindCodexPlanEvidence(state, resultId) : state);
  // The model completes every step at the end of the analysis.
  push(applyCodexNativePlan(state, "turn/plan/updated", nativePlan(["completed", "completed", "completed"])));
  push(state ? settleCodexPlan(state, "Qualified") : state);

  const emit2 = createTraceEmitter({ persist: async () => {}, deliver: () => {} });
  for (const resultId of tableIds) await emit2(tableEvent(resultId));
  for (const [index, plan] of plans.entries()) {
    try {
      await emit2(plan);
    } catch (error) {
      console.error(`THEORY CONFIRMED: plan update ${index} rejected by the route trace invariant:`);
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    }
  }
  console.log("theory replay passed with no throw");
}
