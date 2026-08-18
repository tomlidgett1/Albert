import { sanitizeTraceText, type TracePlanStepStatus } from "../../../shared/src/index.js";
import type { V3TurnContext } from "./context.js";
import type { IntentDecision, Lane } from "./orchestrator.js";

export type OwnerPlanStep = Readonly<{
  label: string;
  status: TracePlanStepStatus;
}>;

/** Matches intent must-cover length so opening steps are not sliced mid-phrase. */
export const OWNER_PLAN_LABEL_MAX = 200;

const JARGON = /SQL|governed|allowlisted|Cube|schema|CTE|tenant|staging/iu;

const SHAPE_STEPS: Readonly<Record<IntentDecision["answerShape"], readonly string[]>> = {
  fact: ["Look up the figure", "Confirm what it is"],
  list: ["Find the matching records", "List what came back"],
  comparison: ["Compare the sides", "Explain the difference"],
  trend: ["Check the movement over time", "Name what changed"],
  breakdown: ["Break the total down", "Show what leads"],
  diagnosis: ["Check the headline movement", "Find what is driving it"],
};

const WRAP_UP: Readonly<Record<IntentDecision["answerShape"], string>> = {
  fact: "Confirm the figure",
  list: "List what came back",
  comparison: "Explain the difference",
  trend: "Name what changed",
  breakdown: "Show what leads",
  diagnosis: "Put the finding together",
};

/**
 * Only investigations get an opening tick-off plan. A quick turn is by
 * definition one governed query ("what's the roster this week", "sales
 * yesterday"): a templated two-step card there is ceremony, not information,
 * so the single "Quick lookup" status line stands in for it. If a quick turn
 * escalates to the analytical lane, the engine publishes the plan at that
 * point instead. Explain turns rest on the previous answer and run no
 * investigation either.
 */
export function shouldEmitInitialPlan(lane: Lane): boolean {
  return lane === "analytical" || lane === "deep";
}

/**
 * A must-cover point that already reads as an instruction is left alone; only
 * noun phrases ("total sales for August") get the "Check" lead-in. Prefixing
 * an imperative produced "Check use dates on the x-axis" on screen.
 */
const IMPERATIVE_START = /^(?:check|find|look|compare|break|list|show|name|review|see|pull|match|explain|put|confirm|assess|identify|determine|analyse|analyze|judge|measure|count|rank|read|verify|track|spot|use|keep|retain|preserve|label|make|present|plot|chart|draw|add|include|exclude|remove|drop|group|sort|filter|limit|split|summarise|summarize|calculate|compute|quantify|estimate|flag|note|state|report|highlight|contrast|distinguish|separate|isolate|resolve|reconcile|validate|cross-check|ensure|provide|give|return|display|restate|describe|outline|work out|figure out|call out|set out|lay out|examine|inspect|investigate|trace|locate|surface|establish|clarify|decide|choose|pick|select|apply|convert|express|weigh|gauge|extend|update|refresh|rerun|re-run|redo|repeat|recheck|re-check|double-check|prioritise|prioritize|recommend|suggest|propose|advise)\b/iu;

function ownerPlanStep(value: string): string {
  let text = value.trim().replace(/\.+$/u, "");
  if (!text || JARGON.test(text)) return "";
  const withoutLeadingAdverb = text.replace(
    /^(?:clearly|always|also|first|then|explicitly|briefly|separately|plainly|only|still|now)\s+/iu,
    "",
  );
  if (!IMPERATIVE_START.test(withoutLeadingAdverb)) {
    text = `Check ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  }
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return sanitizeTraceText(text, OWNER_PLAN_LABEL_MAX).replace(/\.+$/u, "");
}

function uniqueSteps(values: readonly string[]): string[] {
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const label = ownerPlanStep(value);
    if (!label) continue;
    const key = label.toLocaleLowerCase("en-AU");
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push(label);
  }
  return steps;
}

/**
 * Owner-readable tick-off steps from the classified intent, so the plan card
 * can appear before the answering model has called update_plan.
 */
export function buildInitialOwnerPlan(intent: IntentDecision): OwnerPlanStep[] {
  const labels = uniqueSteps([
    ...intent.answerMustCover,
    intent.ownerGoal ?? "",
  ]);

  if (labels.length < 2) {
    labels.push(...uniqueSteps(SHAPE_STEPS[intent.answerShape]));
  }

  const wrapUp = WRAP_UP[intent.answerShape];
  if (labels.length < 5 && !labels.some((label) => label === wrapUp)) {
    labels.push(wrapUp);
  }

  const clipped = labels.slice(0, 6);
  while (clipped.length < 2) clipped.push("Put the finding together");

  return clipped.map((label, index) => ({
    label,
    status: index === 0 ? "active" : "pending",
  }));
}

/** Opening list stays until a step is done or a query has actually run. */
export function canPublishPlanUpdate(input: Readonly<{
  publishedCount: number;
  queryCount: number;
  steps: readonly Readonly<{ status: string }>[];
}>): boolean {
  if (input.steps.length > 0 && input.steps.every((step) => step.status === "done")) {
    return false;
  }
  if (input.publishedCount <= 1 && input.queryCount === 0) {
    return input.steps.some((step) => step.status === "done");
  }
  return true;
}

function samePlan(left: readonly OwnerPlanStep[], right: readonly OwnerPlanStep[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((step, index) => (
    step.label === right[index]?.label && step.status === right[index]?.status
  ));
}

/**
 * Evidence steps tick off one per completed query. The last step stays active
 * until the answer is composed, so the card never jumps to all-green mid-turn.
 */
export function planAfterEvidenceCount(
  steps: readonly OwnerPlanStep[],
  evidenceCount: number,
): OwnerPlanStep[] {
  if (steps.length < 2) return [...steps];
  const last = steps.length - 1;
  const doneCount = Math.min(Math.max(0, evidenceCount), last);
  return steps.map((step, index) => {
    if (index < doneCount) return { ...step, status: "done" };
    if (index === doneCount) return { ...step, status: "active" };
    return { ...step, status: "pending" };
  });
}

export function completeOwnerPlan(steps: readonly OwnerPlanStep[]): OwnerPlanStep[] {
  return steps.map((step) => ({ ...step, status: "done" }));
}

type PlanPublisher = Pick<V3TurnContext, "emit"> & {
  planUpdates?: number;
  visiblePlan?: V3TurnContext["visiblePlan"];
  executedQueries?: Pick<V3TurnContext, "executedQueries">["executedQueries"];
};

export async function publishOwnerPlan(
  context: PlanPublisher,
  steps: readonly OwnerPlanStep[],
  options?: Readonly<{ countTowardAllowance?: boolean }>,
): Promise<void> {
  if (steps.length < 2) return;
  const next = steps.map((step) => ({
    label: sanitizeTraceText(step.label, OWNER_PLAN_LABEL_MAX),
    status: step.status,
  }));
  if (options?.countTowardAllowance !== false) {
    context.planUpdates = (context.planUpdates ?? 0) + 1;
  }
  context.visiblePlan = next;
  await context.emit({
    type: "plan",
    status: "complete",
    steps: next,
  });
}

export async function syncVisiblePlanToEvidence(context: PlanPublisher): Promise<void> {
  const current = context.visiblePlan;
  if (!current || current.length < 2) return;
  const next = planAfterEvidenceCount(current, context.executedQueries?.length ?? 0);
  if (samePlan(current, next)) return;
  await publishOwnerPlan(context, next, { countTowardAllowance: false });
}

export async function completeVisiblePlan(context: PlanPublisher): Promise<void> {
  const current = context.visiblePlan;
  if (!current || current.length < 2) return;
  if (current.every((step) => step.status === "done")) return;
  await publishOwnerPlan(context, completeOwnerPlan(current), { countTowardAllowance: false });
}
