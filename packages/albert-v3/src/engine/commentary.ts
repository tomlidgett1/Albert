import { sanitizeTraceText } from "../../../shared/src/index.js";

export type V3CommentaryKind = "plan" | "finding" | "step";

/**
 * Small, per-turn gate for Codex-style owner commentary.
 *
 * The model may propose an update, but trusted runtime state decides whether it
 * is substantial enough to surface. This keeps quick turns quiet, prevents
 * duplicate plans, requires fresh evidence for finding updates, and puts a hard
 * ceiling on narration during a long investigation.
 *
 * `step` updates are the short "what this step found" paragraphs emitted as
 * each visible plan step completes. They sit outside the general ceiling
 * (a five-step plan needs five of them) but carry their own cap and share the
 * duplicate filter, so a repeated summary is still dropped.
 */
export type V3CommentaryState = {
  enabled: boolean;
  readonly maxUpdates: number;
  readonly maxStepSummaries: number;
  emitted: number;
  stepSummaries: number;
  planEmitted: boolean;
  lastQueryCount: number;
  readonly fingerprints: Set<string>;
};

export type V3CommentaryDecision =
  | Readonly<{ accepted: true; text: string }>
  | Readonly<{ accepted: false; reason: "disabled" | "duplicate" | "limit" | "no_new_evidence" | "plan_exists" }>;

export function createV3CommentaryState(
  enabled: boolean,
  maxUpdates = 4,
  maxStepSummaries = 8,
): V3CommentaryState {
  return {
    enabled,
    maxUpdates: Math.max(1, Math.min(6, Math.floor(maxUpdates))),
    maxStepSummaries: Math.max(1, Math.min(12, Math.floor(maxStepSummaries))),
    emitted: 0,
    stepSummaries: 0,
    planEmitted: false,
    lastQueryCount: 0,
    fingerprints: new Set(),
  };
}

/** Owner-facing step summaries stay short: a glance, not a report. */
export const STEP_SUMMARY_MAX_CHARS = 320;

/**
 * Clip to `max` characters at a sentence boundary, so a long summary ends on a
 * full stop instead of mid-word ("...$61,846.35 in Lightspeed gross pr").
 * Falls back to a word boundary with an ellipsis when no sentence fits.
 */
export function clipToSentence(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastStop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (lastStop >= Math.floor(max * 0.4)) return head.slice(0, lastStop + 1).trim();
  const lastSpace = head.lastIndexOf(" ");
  const cut = head.slice(0, lastSpace > 0 ? lastSpace : max).replace(/[,;:\s]+$/u, "");
  return /[.!?]$/u.test(cut) ? cut : `${cut}…`;
}

function fingerprint(text: string): string {
  return text
    .toLocaleLowerCase("en-AU")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function prepareV3CommentaryUpdate(input: Readonly<{
  state: V3CommentaryState;
  kind: V3CommentaryKind;
  message: string;
  queryCount: number;
}>): V3CommentaryDecision {
  const { state } = input;
  if (!state.enabled) return { accepted: false, reason: "disabled" };
  if (input.kind === "step") {
    if (state.stepSummaries >= state.maxStepSummaries) return { accepted: false, reason: "limit" };
  } else if (state.emitted >= state.maxUpdates) {
    return { accepted: false, reason: "limit" };
  }
  if (input.kind === "plan" && state.planEmitted) {
    return { accepted: false, reason: "plan_exists" };
  }
  if (input.kind === "finding" && input.queryCount <= state.lastQueryCount) {
    return { accepted: false, reason: "no_new_evidence" };
  }

  const text = input.kind === "step"
    ? sanitizeTraceText(clipToSentence(input.message, STEP_SUMMARY_MAX_CHARS), STEP_SUMMARY_MAX_CHARS)
    : sanitizeTraceText(input.message, 420);
  const key = fingerprint(text);
  if (!key || state.fingerprints.has(key)) {
    return { accepted: false, reason: "duplicate" };
  }

  if (input.kind === "step") {
    state.stepSummaries += 1;
  } else {
    state.emitted += 1;
  }
  state.planEmitted ||= input.kind === "plan";
  state.lastQueryCount = Math.max(state.lastQueryCount, input.queryCount);
  state.fingerprints.add(key);
  return { accepted: true, text };
}
