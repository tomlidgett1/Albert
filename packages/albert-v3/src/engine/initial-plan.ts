import {
  sanitizeTraceText,
  type AnswerState,
  type TracePlanStep,
  type TracePlanStepStatus,
} from "../../../shared/src/index.js";
import type { V3TurnContext } from "./context.js";
import type { IntentDecision, Lane } from "./orchestrator.js";

export type OwnerPlanStep = TracePlanStep;

export type OwnerPlanStepUpdate = Readonly<{
  id: string;
  label: string;
  status: TracePlanStepStatus;
  evidenceResultIds: readonly string[];
  statusDetail?: string;
}>;

/** Matches intent must-cover length so opening steps are not sliced mid-phrase. */
export const OWNER_PLAN_LABEL_MAX = 200;

const JARGON = /SQL|governed|allowlisted|Cube|schema|CTE|tenant|staging/iu;
const TERMINAL_PLAN_STATUSES = new Set<TracePlanStepStatus>(["done", "blocked", "incomplete"]);

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

/** Only genuine investigations show a checklist. */
export function shouldEmitInitialPlan(lane: Lane): boolean {
  return lane === "analytical" || lane === "deep";
}

const IMPERATIVE_START = /^(?:check|find|look|compare|break|list|show|name|review|see|pull|match|explain|put|confirm|assess|identify|determine|analyse|analyze|judge|measure|count|rank|read|verify|track|spot|use|keep|retain|preserve|label|make|present|plot|chart|draw|add|include|exclude|remove|drop|group|sort|filter|limit|split|summarise|summarize|calculate|compute|quantify|estimate|flag|note|state|report|highlight|contrast|distinguish|separate|isolate|resolve|reconcile|validate|cross-check|ensure|provide|give|return|display|restate|describe|outline|work out|figure out|call out|set out|lay out|examine|inspect|investigate|trace|locate|surface|establish|clarify|decide|choose|pick|select|apply|convert|express|weigh|gauge|extend|update|refresh|rerun|re-run|redo|repeat|recheck|re-check|double-check|prioritise|prioritize|recommend|suggest|propose|advise)\b/iu;

function ownerPlanLabel(value: string): string {
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
    const label = ownerPlanLabel(value);
    if (!label) continue;
    const key = label.toLocaleLowerCase("en-AU");
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push(label);
  }
  return steps;
}

function stepId(index: number): string {
  return `plan_step_${index + 1}`;
}

/** Owner-readable obligations from the classified intent, with a final synthesis step. */
export function buildInitialOwnerPlan(intent: IntentDecision): OwnerPlanStep[] {
  const labels = uniqueSteps([
    ...intent.answerMustCover,
    intent.ownerGoal ?? "",
  ]);

  if (labels.length < 2) labels.push(...uniqueSteps(SHAPE_STEPS[intent.answerShape]));

  const wrapUp = WRAP_UP[intent.answerShape];
  if (labels.length < 5 && !labels.some((label) => label === wrapUp)) labels.push(wrapUp);

  const clipped = labels.filter((label) => label !== wrapUp).slice(0, 5);
  while (clipped.length < 1) clipped.push(SHAPE_STEPS[intent.answerShape][0]!);
  clipped.push(wrapUp);

  return clipped.map((label, index) => ({
    id: stepId(index),
    label,
    status: index === 0 ? "active" : "pending",
    kind: index === clipped.length - 1 ? "synthesis" : "evidence",
    evidenceResultIds: [],
  }));
}

export function planStepIsTerminal(status: TracePlanStepStatus): boolean {
  return TERMINAL_PLAN_STATUSES.has(status);
}

/** Opening list stays until real evidence lands or a step reaches an honest terminal state. */
export function canPublishPlanUpdate(input: Readonly<{
  publishedCount: number;
  queryCount: number;
  steps: readonly Readonly<{ status: TracePlanStepStatus }>[];
}>): boolean {
  if (input.steps.length > 0 && input.steps.every((step) => planStepIsTerminal(step.status))) return false;
  if (input.publishedCount <= 1 && input.queryCount === 0) {
    return input.steps.some((step) => planStepIsTerminal(step.status));
  }
  return true;
}

function samePlan(left: readonly OwnerPlanStep[], right: readonly OwnerPlanStep[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((step, index) => {
    const other = right[index];
    return step.id === other?.id
      && step.label === other.label
      && step.status === other.status
      && step.kind === other.kind
      && step.statusDetail === other.statusDetail
      && step.evidenceResultIds.join("\u0000") === other.evidenceResultIds.join("\u0000");
  });
}

function uniqueEvidenceIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 24);
}

function availableEvidenceIds(context: Pick<V3TurnContext, "tableResults">): Set<string> {
  return new Set(context.tableResults.keys());
}

export type PlanUpdateValidation =
  | Readonly<{ ok: true; steps: readonly OwnerPlanStep[] }>
  | Readonly<{ ok: false; error: string }>;

/** Validates stable ids and refuses unsupported completion. */
export function validatePlanUpdate(input: Readonly<{
  current: readonly OwnerPlanStep[];
  proposed: readonly OwnerPlanStepUpdate[];
  availableResultIds: ReadonlySet<string>;
}>): PlanUpdateValidation {
  if (input.proposed.length !== input.current.length) {
    return { ok: false, error: "Plan updates must retain every existing step in the same order." };
  }
  const ids = input.proposed.map(({ id }) => id);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => id !== input.current[index]?.id)) {
    return { ok: false, error: "Plan step ids and order are immutable for this turn." };
  }

  const steps: OwnerPlanStep[] = [];
  for (let index = 0; index < input.proposed.length; index += 1) {
    const prior = input.current[index]!;
    const candidate = input.proposed[index]!;
    if (planStepIsTerminal(prior.status) && candidate.status !== prior.status) {
      return { ok: false, error: `Plan step ${prior.id} is already ${prior.status} and cannot regress.` };
    }
    const evidenceResultIds = uniqueEvidenceIds([
      ...prior.evidenceResultIds,
      ...candidate.evidenceResultIds,
    ]);
    const unknown = evidenceResultIds.filter((id) => !input.availableResultIds.has(id));
    if (unknown.length > 0) {
      return { ok: false, error: `Plan step ${prior.id} cites unknown or unsuccessful evidence: ${unknown.join(", ")}.` };
    }
    if (candidate.status === "done" && evidenceResultIds.length === 0) {
      return { ok: false, error: `Plan step ${prior.id} cannot be done without a successful governed result.` };
    }
    if (prior.kind === "synthesis" && prior.status !== "done" && candidate.status === "done") {
      return { ok: false, error: `Plan step ${prior.id} is completed only by trusted answer finalisation.` };
    }
    const statusDetail = candidate.statusDetail?.trim();
    if ((candidate.status === "blocked" || candidate.status === "incomplete") && !statusDetail) {
      return { ok: false, error: `Plan step ${prior.id} needs a reason when it is ${candidate.status}.` };
    }
    steps.push({
      id: prior.id,
      label: planStepIsTerminal(prior.status) ? prior.label : candidate.label,
      status: candidate.status,
      kind: prior.kind,
      evidenceResultIds,
      ...((candidate.status === "blocked" || candidate.status === "incomplete") && statusDetail
        ? { statusDetail }
        : {}),
    });
  }

  if (steps.filter(({ status }) => status === "active").length > 1) {
    return { ok: false, error: "A visible plan may have at most one active step." };
  }
  const hasOpenStep = steps.some(({ status }) => status === "pending" || status === "active");
  if (hasOpenStep && !steps.some(({ status }) => status === "active")) {
    return { ok: false, error: "An unfinished plan must have exactly one active step." };
  }
  return { ok: true, steps };
}

type PlanPublisher = Pick<V3TurnContext, "emit" | "tableResults"> & {
  planUpdates?: number;
  visiblePlan?: V3TurnContext["visiblePlan"];
  planStepsAwaitingSummary?: V3TurnContext["planStepsAwaitingSummary"];
  executedQueries?: Pick<V3TurnContext, "executedQueries">["executedQueries"];
};

/** Labels of steps newly completed by an evidence-bound update. */
export function newlyCompletedSteps(
  previous: readonly OwnerPlanStep[] | undefined,
  next: readonly OwnerPlanStep[],
): string[] {
  const wasDone = new Set((previous ?? []).filter(({ status }) => status === "done").map(({ id }) => id));
  return next.filter(({ status, id }) => status === "done" && !wasDone.has(id)).map(({ label }) => label);
}

export function planStepSummaryNudge(
  context: Pick<PlanPublisher, "planStepsAwaitingSummary">,
): Readonly<{ planUpdate?: string }> {
  const awaiting = context.planStepsAwaitingSummary ?? [];
  if (awaiting.length === 0) return {};
  const labels = awaiting.map((label) => `“${label}”`).join(" and ");
  return {
    planUpdate: `The evidence-backed plan step ${labels} is now complete but has no summary yet. Before your next query, call update_plan with the unchanged ids, the supporting result ids and one to three plain sentences of the key findings.`,
  };
}

export async function publishOwnerPlan(
  context: PlanPublisher,
  steps: readonly OwnerPlanStep[],
  options?: Readonly<{ countTowardAllowance?: boolean }>,
): Promise<void> {
  if (steps.length < 2) return;
  const next: OwnerPlanStep[] = steps.map((step, index) => ({
    id: /^[a-z][a-z0-9_-]{2,47}$/u.test(step.id) ? step.id : stepId(index),
    label: sanitizeTraceText(step.label, OWNER_PLAN_LABEL_MAX),
    status: step.status,
    kind: step.kind,
    evidenceResultIds: uniqueEvidenceIds(step.evidenceResultIds),
    ...(step.statusDetail ? { statusDetail: sanitizeTraceText(step.statusDetail, 240) } : {}),
  }));
  if (samePlan(context.visiblePlan ?? [], next)) return;
  if (options?.countTowardAllowance !== false) context.planUpdates = (context.planUpdates ?? 0) + 1;
  context.visiblePlan = next;
  await context.emit({
    type: "plan",
    status: next.some(({ status }) => status === "blocked" || status === "incomplete") ? "warning" : "complete",
    steps: next,
  });
}

export type PlannedEvidenceBinding = Readonly<{
  coversPlanStepIds: readonly string[];
  ok: boolean;
  resultIds: readonly string[];
}>;

function plannedStepCompletionCommentary(
  context: Pick<PlanPublisher, "tableResults">,
  step: OwnerPlanStep,
): string {
  const tables = step.evidenceResultIds.flatMap((resultId) => {
    const table = context.tableResults.get(resultId);
    return table ? [table] : [];
  });
  const totalRows = tables.reduce((total, table) => total + table.rowCount, 0);
  const finding = totalRows === 0
    ? "No matching rows were returned."
    : `${totalRows.toLocaleString("en-AU")} matching ${totalRows === 1 ? "row" : "rows"} across ${tables.length} ${tables.length === 1 ? "result" : "results"}.`;
  return sanitizeTraceText(`${step.label} is complete. ${finding}`, 320);
}

/** Every planned unit must map to at least one real evidence obligation. */
export function planCoverageError(
  plan: readonly OwnerPlanStep[] | undefined,
  coverageSets: readonly (readonly string[] | null | undefined)[],
): string | undefined {
  if (!plan?.length) return undefined;
  const evidenceIds = new Set(plan.filter(({ kind }) => kind === "evidence").map(({ id }) => id));
  for (let index = 0; index < coverageSets.length; index += 1) {
    const coverage = [...new Set(coverageSets[index] ?? [])];
    if (coverage.length === 0) return `Planned unit ${index + 1} is not mapped to a visible evidence step.`;
    const unknown = coverage.filter((id) => !evidenceIds.has(id));
    if (unknown.length > 0) return `Planned unit ${index + 1} maps to unknown or non-evidence steps: ${unknown.join(", ")}.`;
  }
  return undefined;
}

/** Applies parallel planned-query results only to the obligations they explicitly cover. */
export async function applyPlannedEvidenceBindings(
  context: PlanPublisher,
  bindings: readonly PlannedEvidenceBinding[],
  options: Readonly<{ emitCommentary?: boolean }> = {},
): Promise<void> {
  const current = context.visiblePlan;
  if (!current?.length) return;
  const available = availableEvidenceIds(context);
  const next = current.map((step): OwnerPlanStep => {
    if (planStepIsTerminal(step.status) || step.kind !== "evidence") return step;
    const relevant = bindings.filter(({ coversPlanStepIds }) => coversPlanStepIds.includes(step.id));
    if (relevant.length === 0) return step;
    const evidenceResultIds = uniqueEvidenceIds([
      ...step.evidenceResultIds,
      ...relevant.flatMap(({ ok, resultIds }) => ok ? resultIds.filter((id) => available.has(id)) : []),
    ]);
    const complete = relevant.every(({ ok, resultIds }) => (
      ok && resultIds.length > 0 && resultIds.every((id) => available.has(id))
    ));
    return {
      ...step,
      status: complete ? "done" : step.status,
      evidenceResultIds,
      ...(complete ? { statusDetail: undefined } : {}),
    };
  });
  const firstOpen = next.findIndex(({ status }) => status === "active" || status === "pending");
  const normalised = next.map((step, index): OwnerPlanStep => {
    if (planStepIsTerminal(step.status)) return step;
    return { ...step, status: index === firstOpen ? "active" : "pending" };
  });
  if (samePlan(current, normalised)) return;
  const completed = normalised.filter((step) => (
    step.status === "done" && !current.some((previous) => previous.id === step.id && previous.status === "done")
  ));
  await publishOwnerPlan(context, normalised, { countTowardAllowance: false });
  if (options.emitCommentary !== false) {
    for (const step of completed) {
      await context.emit({
        type: "narrative",
        text: plannedStepCompletionCommentary(context, step),
      });
    }
  }
}

/** Trusted final settlement: unsupported obligations never turn green. */
export async function settleVisiblePlan(
  context: PlanPublisher,
  answerState: AnswerState,
): Promise<void> {
  const current = context.visiblePlan;
  if (!current?.length) return;
  const available = availableEvidenceIds(context);
  const allEvidence = uniqueEvidenceIds(
    current.flatMap(({ evidenceResultIds }) => evidenceResultIds.filter((id) => available.has(id))),
  );
  let blockedAssigned = false;
  const next = current.map((step): OwnerPlanStep => {
    const validEvidence = step.evidenceResultIds.filter((id) => available.has(id));
    if (step.status === "done" && validEvidence.length > 0) return { ...step, evidenceResultIds: validEvidence };
    if (step.status === "blocked" || step.status === "incomplete") return { ...step, evidenceResultIds: validEvidence };
    if (step.kind === "synthesis" && answerState !== "Unavailable" && allEvidence.length > 0) {
      return { ...step, status: "done", evidenceResultIds: allEvidence };
    }
    if (answerState === "Unavailable" && !blockedAssigned && step.kind === "evidence") {
      blockedAssigned = true;
      return {
        ...step,
        status: "blocked",
        evidenceResultIds: validEvidence,
        statusDetail: "I couldn’t retrieve the data needed for this step.",
      };
    }
    return {
      ...step,
      status: "incomplete",
      evidenceResultIds: validEvidence,
      statusDetail: step.kind === "synthesis"
        ? "I couldn’t complete a supported final answer."
        : "This step wasn’t completed before the answer.",
    };
  });
  await publishOwnerPlan(context, next, { countTowardAllowance: false });
}

/** Best-effort terminal snapshot when the turn throws or is cancelled. */
export async function settleVisiblePlanAfterFailure(
  context: PlanPublisher,
  outcome: "blocked" | "cancelled",
): Promise<void> {
  const current = context.visiblePlan;
  if (!current?.length) return;
  const available = availableEvidenceIds(context);
  let blockedAssigned = false;
  const next = current.map((step): OwnerPlanStep => {
    const validEvidence = step.evidenceResultIds.filter((id) => available.has(id));
    if (step.status === "done" && validEvidence.length > 0) return { ...step, evidenceResultIds: validEvidence };
    if (step.status === "blocked" || step.status === "incomplete") return { ...step, evidenceResultIds: validEvidence };
    if (outcome === "blocked" && !blockedAssigned && step.kind === "evidence") {
      blockedAssigned = true;
      return {
        ...step,
        status: "blocked",
        evidenceResultIds: validEvidence,
        statusDetail: "I couldn’t retrieve the data needed for this step.",
      };
    }
    return {
      ...step,
      status: "incomplete",
      evidenceResultIds: validEvidence,
      statusDetail: outcome === "cancelled"
        ? "This step stopped before completion."
        : "This step wasn’t completed before the analysis stopped.",
    };
  });
  await publishOwnerPlan(context, next, { countTowardAllowance: false });
}
