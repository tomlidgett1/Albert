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
    const plan = normalizePlan(event, state.resultIds);
    return Object.freeze({
      state: Object.freeze({ ...state, latestPlan: plan }),
      events: Object.freeze([plan]),
    });
  }
  if (event.type === "answer" && state.latestPlan && isOpenPlan(state.latestPlan)) {
    const plan = terminalPlan(state.latestPlan, state.resultIds);
    return Object.freeze({
      state: Object.freeze({ ...state, latestPlan: plan }),
      events: Object.freeze([plan, event]),
    });
  }
  return Object.freeze({ state, events: Object.freeze([event]) });
}
