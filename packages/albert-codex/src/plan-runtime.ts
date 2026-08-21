import {
  sanitizeTraceText,
  type AnswerState,
  type TracePlanStep,
} from "../../shared/src/index.js";

export type CodexNativePlanStatus = "pending" | "inProgress" | "completed";

type CodexNativePlanSnapshot = Readonly<{
  turnId: string;
  steps: readonly Readonly<{ label: string; status: CodexNativePlanStatus }>[];
}>;

export type CodexVisiblePlanState = Readonly<{
  source: "native" | "fallback";
  sourceTurnId?: string;
  steps: readonly TracePlanStep[];
  nativeStatuses: readonly CodexNativePlanStatus[];
  availableResultIds: readonly string[];
}>;

const UNSAFE_PLAN_TEXT = /(?:https?:\/\/|www\.|["'](?:state|answer|claims)["']\s*:|\b(?:resultId|rowIndex|columnKey|password|secret|token|credential|prompt|instruction)\b)/iu;
const MONEY_TOKEN = /(?:(?:AUD|USD|NZD|GBP|EUR)\s+|[$£€¥])[-+]?\d[\d,.]*/giu;
const DATE_TOKEN = /\b\d{4}-\d{2}-\d{2}\b/gu;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePlanLabel(value: string): string | null {
  if (UNSAFE_PLAN_TEXT.test(value)) return null;
  const label = sanitizeTraceText(value, 180)
    .replace(MONEY_TOKEN, "the requested amount")
    .replace(DATE_TOKEN, "the requested date")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.;:]+$/gu, "");
  return label ? label : null;
}

export function readCodexNativePlan(method: string, params: unknown): CodexNativePlanSnapshot | null {
  if (method !== "turn/plan/updated" || !isObject(params) || !Array.isArray(params.plan)) return null;
  const turnId = typeof params.turnId === "string" ? params.turnId.trim() : "";
  if (!turnId) return null;
  const seen = new Set<string>();
  const steps: Array<{ label: string; status: CodexNativePlanStatus }> = [];
  for (const entry of params.plan.slice(0, 6)) {
    if (!isObject(entry) || typeof entry.step !== "string") continue;
    const status = entry.status;
    if (status !== "pending" && status !== "inProgress" && status !== "completed") continue;
    const label = safePlanLabel(entry.step);
    if (!label) continue;
    const fingerprint = label.toLocaleLowerCase("en-AU");
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    steps.push({ label, status });
  }
  return steps.length >= 2 ? Object.freeze({ turnId, steps: Object.freeze(steps) }) : null;
}

function stepId(index: number): string {
  return `codex_plan_step_${index + 1}`;
}

function uniqueResultIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 24);
}

function freezeSteps(steps: readonly TracePlanStep[]): readonly TracePlanStep[] {
  return Object.freeze(steps.map((step) => Object.freeze({
    ...step,
    evidenceResultIds: Object.freeze([...step.evidenceResultIds]),
  })));
}

function firstOpenIndex(steps: readonly TracePlanStep[], preferred?: number): number {
  if (preferred !== undefined && preferred >= 0 && !["done", "blocked", "incomplete"].includes(steps[preferred]?.status ?? "")) {
    return preferred;
  }
  return steps.findIndex((step) => step.status === "active" || step.status === "pending");
}

function normalizeOpenStep(steps: readonly TracePlanStep[], preferred?: number): readonly TracePlanStep[] {
  const active = firstOpenIndex(steps, preferred);
  return freezeSteps(steps.map((step, index) => {
    if (["done", "blocked", "incomplete"].includes(step.status)) return step;
    return { ...step, status: index === active ? "active" : "pending" };
  }));
}

function initialSteps(labels: readonly string[]): readonly TracePlanStep[] {
  return freezeSteps(labels.map((label, index) => ({
    id: stepId(index),
    label,
    status: index === 0 ? "active" : "pending",
    kind: index === labels.length - 1 ? "synthesis" : "evidence",
    evidenceResultIds: [],
  })));
}

export function createCodexFallbackPlan(): CodexVisiblePlanState {
  return Object.freeze({
    source: "fallback",
    steps: initialSteps([
      "Check the headline evidence",
      "Test the strongest drivers and limitations",
      "Reconcile the findings and present the supported answer",
    ]),
    nativeStatuses: Object.freeze(["inProgress", "pending", "pending"] as const),
    availableResultIds: Object.freeze([]),
  });
}

function reconcileNativeStatuses(state: CodexVisiblePlanState): CodexVisiblePlanState {
  const available = uniqueResultIds(state.availableResultIds);
  const used = new Set(state.steps.flatMap((step) => step.evidenceResultIds));
  const unassigned = available.filter((resultId) => !used.has(resultId));
  let steps = state.steps.map((step) => ({ ...step, evidenceResultIds: [...step.evidenceResultIds] }));

  // A native completed state is visible as done only after a successful table
  // exists. When several checks complete in one native snapshot, distribute
  // already-emitted results so each completed evidence task has real support.
  for (let index = 0; index < steps.length - 1; index += 1) {
    const step = steps[index]!;
    if (state.nativeStatuses[index] !== "completed" || step.evidenceResultIds.length > 0) continue;
    const resultId = unassigned.shift();
    if (resultId) step.evidenceResultIds.push(resultId);
  }
  for (let index = 0; index < steps.length - 1; index += 1) {
    const step = steps[index]!;
    if (state.nativeStatuses[index] !== "completed" || step.evidenceResultIds.length > 0) continue;
    const donor = steps.slice(0, -1).find((candidate) => candidate.evidenceResultIds.length > 1);
    const resultId = donor?.evidenceResultIds.pop();
    if (resultId) step.evidenceResultIds.push(resultId);
  }

  steps = steps.map((step, index) => {
    if (["done", "blocked", "incomplete"].includes(step.status)) return step;
    if (step.kind === "evidence" && state.nativeStatuses[index] === "completed" && step.evidenceResultIds.length > 0) {
      return { ...step, status: "done" as const };
    }
    return { ...step, status: "pending" as const };
  });
  const nativeActive = state.nativeStatuses.findIndex((status, index) => (
    status === "inProgress" && !["done", "blocked", "incomplete"].includes(steps[index]?.status ?? "")
  ));
  const unresolvedCompleted = state.nativeStatuses.findIndex((status, index) => (
    status === "completed" && !["done", "blocked", "incomplete"].includes(steps[index]?.status ?? "")
  ));
  const preferred = unresolvedCompleted >= 0 ? unresolvedCompleted : nativeActive >= 0 ? nativeActive : undefined;
  return Object.freeze({
    ...state,
    steps: normalizeOpenStep(steps, preferred),
    availableResultIds: Object.freeze(available),
  });
}

export function applyCodexNativePlan(
  current: CodexVisiblePlanState | undefined,
  method: string,
  params: unknown,
): CodexVisiblePlanState | undefined {
  const snapshot = readCodexNativePlan(method, params);
  if (!snapshot) return current;
  if (!current) {
    return reconcileNativeStatuses(Object.freeze({
      source: "native",
      sourceTurnId: snapshot.turnId,
      steps: initialSteps(snapshot.steps.map((step) => step.label)),
      nativeStatuses: Object.freeze(snapshot.steps.map((step) => step.status)),
      availableResultIds: Object.freeze([]),
    }));
  }
  if (current.source !== "native" || current.sourceTurnId !== snapshot.turnId) return current;
  if (snapshot.steps.length !== current.steps.length) return current;
  return reconcileNativeStatuses(Object.freeze({
    ...current,
    nativeStatuses: Object.freeze(snapshot.steps.map((step) => step.status)),
  }));
}

export function bindCodexPlanEvidence(
  state: CodexVisiblePlanState,
  resultId: string,
): CodexVisiblePlanState {
  const availableResultIds = uniqueResultIds([...state.availableResultIds, resultId]);
  const steps = state.steps.map((step) => ({ ...step, evidenceResultIds: [...step.evidenceResultIds] }));
  let target = steps.findIndex((step) => step.kind === "evidence" && step.status === "active");
  if (target < 0) target = steps.findIndex((step) => step.kind === "evidence" && step.status === "pending");
  if (target < 0) {
    for (let index = steps.length - 2; index >= 0; index -= 1) {
      if (steps[index]?.kind === "evidence") {
        target = index;
        break;
      }
    }
  }
  if (target >= 0) {
    const step = steps[target]!;
    step.evidenceResultIds = uniqueResultIds([...step.evidenceResultIds, resultId]);
    if (state.source === "fallback") step.status = "done";
  }
  const next = Object.freeze({
    ...state,
    steps: freezeSteps(steps),
    availableResultIds: Object.freeze(availableResultIds),
  });
  if (state.source === "native") return reconcileNativeStatuses(next);
  const nextOpen = next.steps.findIndex((step) => step.status === "active" || step.status === "pending");
  return Object.freeze({ ...next, steps: normalizeOpenStep(next.steps, nextOpen) });
}

export function settleCodexPlan(
  state: CodexVisiblePlanState,
  answerState: AnswerState,
): CodexVisiblePlanState {
  const available = uniqueResultIds(state.availableResultIds);
  const unused = available.filter((resultId) => !state.steps.some((step) => step.evidenceResultIds.includes(resultId)));
  const evidenceSteps = state.steps.filter((step) => step.kind === "evidence");
  const steps = state.steps.map((step): TracePlanStep => {
    if (step.kind === "synthesis") {
      if (answerState !== "Unavailable" && available.length > 0) {
        return { ...step, status: "done", evidenceResultIds: available };
      }
      return {
        ...step,
        status: "incomplete",
        evidenceResultIds: [],
        statusDetail: "A fully supported synthesis was not available for this turn.",
      };
    }
    const evidenceResultIds = uniqueResultIds([
      ...step.evidenceResultIds,
      ...(step.evidenceResultIds.length === 0 && unused.length > 0 ? [unused.shift()!] : []),
    ]);
    if (evidenceResultIds.length > 0) return { ...step, status: "done", evidenceResultIds };
    return {
      ...step,
      status: answerState === "Unavailable" && step === evidenceSteps.find((candidate) => candidate.status !== "done")
        ? "blocked"
        : "incomplete",
      evidenceResultIds: [],
      statusDetail: answerState === "Unavailable"
        ? "The governed evidence needed for this check was unavailable."
        : "This check was not completed as a separate governed evidence step.",
    };
  });
  return Object.freeze({ ...state, steps: freezeSteps(steps), availableResultIds: Object.freeze(available) });
}

export function codexPlanStepsEqual(
  left: readonly TracePlanStep[] | undefined,
  right: readonly TracePlanStep[],
): boolean {
  return Boolean(left) && left!.length === right.length && left!.every((step, index) => {
    const other = right[index];
    return step.id === other?.id
      && step.label === other.label
      && step.status === other.status
      && step.kind === other.kind
      && step.statusDetail === other.statusDetail
      && step.evidenceResultIds.join("\u0000") === other.evidenceResultIds.join("\u0000");
  });
}

export function shouldCreateCodexFallbackPlan(question: string): boolean {
  const text = question.trim();
  if (text.split(/\s+/u).length < 10) return false;
  const complexIntent = /\b(?:diagnos(?:e|is)|health check|drivers?|explain why|root cause|recommend|opportunit(?:y|ies)|strategy|reconcile|trade-?offs?|what changed|challenge|investigate|across)\b/iu.test(text);
  const domains = [
    /\b(?:sales?|revenue|takings?|transactions?|margin|discounts?|refunds?)\b/iu,
    /\b(?:customers?|retention|repeat|lapsed|cohort)\b/iu,
    /\b(?:inventory|stock|products?|categories|supplier)\b/iu,
    /\b(?:cash|xero|receivables?|payables?|invoices?|profit and loss|p\s*&\s*l)\b/iu,
    /\b(?:labour|labor|wages?|roster|shifts?|workshop|workorders?)\b/iu,
  ].filter((pattern) => pattern.test(text)).length;
  return complexIntent || domains >= 2;
}
