import { ulid } from "ulid";

export const ANALYTICAL_QUERY_RUNTIMES = [
  "albert-v3",
  "codex-app-server",
] as const;

export const ANALYTICAL_QUERY_SOURCES = [
  "cube",
  "shopifyql",
  "shopify_admin",
  "xero_mcp",
] as const;

export const ANALYTICAL_QUERY_OUTCOMES = [
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
] as const;

export type AnalyticalQueryRuntime = (typeof ANALYTICAL_QUERY_RUNTIMES)[number];
export type AnalyticalQuerySource = (typeof ANALYTICAL_QUERY_SOURCES)[number];
export type AnalyticalQueryOutcomeStatus = (typeof ANALYTICAL_QUERY_OUTCOMES)[number];

export type AnalyticalQueryAttemptStart = Readonly<{
  queryAttemptId: string;
  runtime: AnalyticalQueryRuntime;
  source: AnalyticalQuerySource;
  operation: string;
  topic?: string;
  branchLabel?: string;
  queryDocument: Readonly<Record<string, unknown>>;
}>;

export type AnalyticalQueryAttemptOutcome = Readonly<{
  queryAttemptId: string;
  status: AnalyticalQueryOutcomeStatus;
  executionMs?: number;
  rowCount?: number;
  failureCode?: string;
  failureMessage?: string;
  resultMetadata?: Readonly<Record<string, unknown>>;
}>;

/**
 * The engine owns query semantics; its host owns durable persistence. Keeping
 * this as two awaited callbacks lets in-process runtimes fail closed before a
 * query and lets isolated runtimes transport the same append-only events.
 */
export type AnalyticalQueryRecorder = Readonly<{
  start: (attempt: AnalyticalQueryAttemptStart) => Promise<void>;
  finish: (outcome: AnalyticalQueryAttemptOutcome) => Promise<void>;
}>;

export type BegunAnalyticalQueryAttempt = Readonly<{
  queryAttemptId: string;
  startedAtMs: number;
}>;

/** Bounded, credential-scrubbed failure copy safe for the operator ledger. */
export function sanitizeQueryFailureMessage(value: unknown, fallback = "The governed query failed."): string {
  const raw = value instanceof Error
    ? value.message
    : typeof value === "string"
      ? value
      : fallback;
  const cleaned = raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[redacted-key]")
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu, "[redacted-token]")
    .replace(/\b(password|secret|token|authorization|api[_-]?key)\s*[=:]\s*[^\s,;]+/giu, "$1=[redacted]")
    .replace(/https?:\/\/[^\s?#]+\?[^\s]+/giu, "[redacted-url]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_000);
  return cleaned || fallback;
}

export function normalizeQueryFailureCode(value: string, fallback = "query_failed"): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 120);
  if (/^[a-z][a-z0-9_]{1,119}$/u.test(normalized)) return normalized;
  return fallback;
}

export async function beginAnalyticalQueryAttempt(
  recorder: AnalyticalQueryRecorder | undefined,
  attempt: Omit<AnalyticalQueryAttemptStart, "queryAttemptId">,
): Promise<BegunAnalyticalQueryAttempt> {
  const begun = Object.freeze({ queryAttemptId: ulid(), startedAtMs: Date.now() });
  await recorder?.start(Object.freeze({ ...attempt, queryAttemptId: begun.queryAttemptId }));
  return begun;
}

export async function finishAnalyticalQueryAttempt(
  recorder: AnalyticalQueryRecorder | undefined,
  begun: BegunAnalyticalQueryAttempt,
  outcome: Omit<AnalyticalQueryAttemptOutcome, "queryAttemptId" | "executionMs"> & Readonly<{
    executionMs?: number;
  }>,
): Promise<void> {
  const measured = Math.max(0, Math.min(3_600_000, Math.round(
    outcome.executionMs ?? (Date.now() - begun.startedAtMs),
  )));
  await recorder?.finish(Object.freeze({
    ...outcome,
    queryAttemptId: begun.queryAttemptId,
    executionMs: measured,
  }));
}

export async function recordRejectedAnalyticalQuery(
  recorder: AnalyticalQueryRecorder | undefined,
  attempt: Omit<AnalyticalQueryAttemptStart, "queryAttemptId">,
  failure: Readonly<{ code: string; message: unknown; resultMetadata?: Readonly<Record<string, unknown>> }>,
): Promise<void> {
  const begun = await beginAnalyticalQueryAttempt(recorder, attempt);
  await finishAnalyticalQueryAttempt(recorder, begun, {
    status: "rejected",
    failureCode: normalizeQueryFailureCode(failure.code, "query_rejected"),
    failureMessage: sanitizeQueryFailureMessage(failure.message, "The governed query was rejected."),
    ...(failure.resultMetadata ? { resultMetadata: failure.resultMetadata } : {}),
  });
}
