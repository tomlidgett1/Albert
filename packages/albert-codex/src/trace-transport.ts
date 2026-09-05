import type { TracePlanStep } from "../../shared/src/index.js";
import type { CodexTraceEventInput } from "./semantic-runtime.js";

type PlanEventInput = Extract<CodexTraceEventInput, { type: "plan" }>;

export type CodexTraceTransportState = Readonly<{
  resultIds: readonly string[];
  latestPlan?: PlanEventInput;
}>;

export function createCodexTraceTransportState(): CodexTraceTransportState {
  return Object.freeze({ resultIds: Object.freeze([]) });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, 24);
}

function normalizePlan(
  plan: PlanEventInput,
  resultIds: readonly string[],
): PlanEventInput {
  const known = new Set(resultIds);
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      evidenceResultIds: unique(step.evidenceResultIds.filter((resultId) => known.has(resultId))),
    })),
  };
}

function isOpenPlan(plan: PlanEventInput): boolean {
  return plan.steps.some((step) => step.status === "active" || step.status === "pending");
}

/**
 * The durable trace contract is strictly monotonic: a plan step may never
 * remove published evidence, regress out of a terminal status, or finish
 * "done" with nothing behind it. The runtime is written to respect this, but
 * one violating snapshot must degrade to a clamped update — never reject the
 * whole turn after the analysis already succeeded.
 */
function clampMonotonicPlan(
  plan: PlanEventInput,
  previous: PlanEventInput | undefined,
): PlanEventInput {
  if (!previous || previous.steps.length !== plan.steps.length) return plan;
  let activeSeen = false;
  const steps = plan.steps.map((step, index): TracePlanStep => {
    const before = previous.steps[index];
    if (!before || before.id !== step.id) return step;
    const evidenceResultIds = unique([...before.evidenceResultIds, ...step.evidenceResultIds]);
    const terminalBefore = ["done", "blocked", "incomplete"].includes(before.status);
    let status = terminalBefore && step.status !== before.status ? before.status : step.status;
    let statusDetail = status === before.status ? step.statusDetail ?? before.statusDetail : step.statusDetail;
    if (status === "done" && evidenceResultIds.length === 0) {
      status = "incomplete";
      statusDetail = "This check finished without a separate governed evidence result.";
    }
    if ((status === "blocked" || status === "incomplete") && !statusDetail?.trim()) {
      statusDetail = "This check did not complete as a separate governed evidence step.";
    }
    if (status === "active") {
      if (activeSeen) status = "pending";
      else activeSeen = true;
    }
    return { ...step, status, evidenceResultIds, statusDetail };
  });
  return {
    ...plan,
    status: steps.some((step) => step.status === "blocked" || step.status === "incomplete") ? "warning" : plan.status,
    steps,
  };
}

function terminalPlan(
  plan: PlanEventInput,
  resultIds: readonly string[],
): PlanEventInput {
  const available = unique(resultIds);
  const alreadyUsed = new Set(plan.steps.flatMap((step) => step.evidenceResultIds));
  const unused = available.filter((resultId) => !alreadyUsed.has(resultId));
  const steps = plan.steps.map((step): TracePlanStep => {
    if (step.kind === "synthesis") {
      return available.length > 0
        ? { ...step, status: "done", evidenceResultIds: available, statusDetail: undefined }
        : {
            ...step,
            status: "incomplete",
            evidenceResultIds: [],
            statusDetail: "A fully supported synthesis was not available for this turn.",
          };
    }
    const evidenceResultIds = unique([
      ...step.evidenceResultIds,
      ...(step.evidenceResultIds.length === 0 && unused.length > 0 ? [unused.shift()!] : []),
    ]);
    return evidenceResultIds.length > 0
      ? { ...step, status: "done", evidenceResultIds, statusDetail: undefined }
      : {
          ...step,
          status: "incomplete",
          evidenceResultIds: [],
          statusDetail: "This check was not completed as a separate governed evidence step.",
        };
  });
  return {
    type: "plan",
    status: steps.some((step) => step.status === "incomplete") ? "warning" : "complete",
    steps,
  };
}

/**
 * Projects isolated runtime events onto the stricter durable product trace.
 * In particular, an answer can never be lost merely because a native Codex
 * plan left owner-visible steps open: the host settles those steps truthfully
 * against table evidence already emitted before forwarding the answer.
 */
export function projectCodexRuntimeEvent(
  state: CodexTraceTransportState,
  event: CodexTraceEventInput,
): Readonly<{ state: CodexTraceTransportState; events: readonly CodexTraceEventInput[] }> {
  if (event.type === "table" && event.status === "complete") {
    return Object.freeze({
      state: Object.freeze({ ...state, resultIds: Object.freeze(unique([...state.resultIds, event.resultId])) }),
      events: Object.freeze([event]),
    });
  }
  if (event.type === "plan") {
    const plan = clampMonotonicPlan(normalizePlan(event, state.resultIds), state.latestPlan);
    return Object.freeze({
      state: Object.freeze({ ...state, latestPlan: plan }),
      events: Object.freeze([plan]),
    });
  }
  if (event.type === "answer" && state.latestPlan && isOpenPlan(state.latestPlan)) {
    const plan = clampMonotonicPlan(terminalPlan(state.latestPlan, state.resultIds), state.latestPlan);
    return Object.freeze({
      state: Object.freeze({ ...state, latestPlan: plan }),
      events: Object.freeze([plan, event]),
    });
  }
  return Object.freeze({ state, events: Object.freeze([event]) });
}
