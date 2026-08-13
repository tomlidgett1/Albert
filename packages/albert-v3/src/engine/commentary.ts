import { sanitizeTraceText } from "../../../shared/src/index.js";

export type V3CommentaryKind = "plan" | "finding";

/**
 * Small, per-turn gate for Codex-style owner commentary.
 *
 * The model may propose an update, but trusted runtime state decides whether it
 * is substantial enough to surface. This keeps quick turns quiet, prevents
 * duplicate plans, requires fresh evidence for finding updates, and puts a hard
 * ceiling on narration during a long investigation.
 */
export type V3CommentaryState = {
  enabled: boolean;
  readonly maxUpdates: number;
  emitted: number;
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
): V3CommentaryState {
  return {
    enabled,
    maxUpdates: Math.max(1, Math.min(6, Math.floor(maxUpdates))),
    emitted: 0,
    planEmitted: false,
    lastQueryCount: 0,
    fingerprints: new Set(),
  };
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
  if (state.emitted >= state.maxUpdates) return { accepted: false, reason: "limit" };
  if (input.kind === "plan" && state.planEmitted) {
    return { accepted: false, reason: "plan_exists" };
  }
  if (input.kind === "finding" && input.queryCount <= state.lastQueryCount) {
    return { accepted: false, reason: "no_new_evidence" };
  }

  const text = sanitizeTraceText(input.message, 420);
  const key = fingerprint(text);
  if (!key || state.fingerprints.has(key)) {
    return { accepted: false, reason: "duplicate" };
  }

  state.emitted += 1;
  state.planEmitted ||= input.kind === "plan";
  state.lastQueryCount = input.queryCount;
  state.fingerprints.add(key);
  return { accepted: true, text };
}
