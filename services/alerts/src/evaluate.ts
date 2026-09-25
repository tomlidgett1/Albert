/**
 * Runs the enabled triggers over one query loader and reports each one's
 * reading as it completes. The loader is the only side effect: the bridge
 * gives it a Cube client under an owner turn lease, tests give it fixture
 * rows. A trigger that throws is recorded as an error and never blocks the
 * others.
 */
import { createHash } from "node:crypto";
import type { AlertResultSummary, AlertTriggerKey } from "./contracts.js";
import type { AlertContext, AlertFreshness, AlertQueryLoader, AlertTrigger, TriggerEvaluation } from "./triggers.js";

export type AlertEvaluationReport = Readonly<{
  results: Readonly<Partial<Record<AlertTriggerKey, TriggerEvaluation>>>;
  queries: number;
  failedQueries: number;
  fired: number;
  errors: number;
  durationMs: number;
}>;

export function errorEvaluation(error: unknown): TriggerEvaluation {
  const message = error instanceof Error ? error.message : String(error);
  const result: AlertResultSummary = Object.freeze({
    status: "error",
    line: "This check could not run; it will try again next time.",
    error: message.slice(0, 400),
  });
  return Object.freeze({ result, events: Object.freeze([]) });
}

/** Stable digest of what every connector's data reaches, to skip re-evaluating unchanged data. */
export function freshnessDigest(freshness: readonly AlertFreshness[]): string {
  const canonical = [...freshness]
    .map((entry) => `${entry.connector}:${entry.domain}:${entry.dataThrough ?? ""}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export async function evaluateAlerts(input: Readonly<{
  triggers: readonly AlertTrigger[];
  context: AlertContext;
  load: AlertQueryLoader;
  /** Called after each trigger, in order, so a slow trigger's predecessors are already recorded. */
  onTrigger?: (key: AlertTriggerKey, evaluation: TriggerEvaluation) => Promise<void>;
  signal?: AbortSignal;
}>): Promise<AlertEvaluationReport> {
  const started = Date.now();
  const results: Partial<Record<AlertTriggerKey, TriggerEvaluation>> = {};
  let queries = 0;
  let failedQueries = 0;
  let fired = 0;
  let errors = 0;
  const load: AlertQueryLoader = async (label, query) => {
    queries += 1;
    try {
      return await input.load(label, query);
    } catch (error) {
      failedQueries += 1;
      throw error;
    }
  };
  for (const trigger of input.triggers) {
    if (input.signal?.aborted) {
      results[trigger.key] = errorEvaluation(new Error("The evaluation was cancelled."));
      errors += 1;
      continue;
    }
    let evaluation: TriggerEvaluation;
    try {
      evaluation = await trigger.run(input.context, load);
    } catch (error) {
      evaluation = errorEvaluation(error);
    }
    if (evaluation.result.status === "error") errors += 1;
    fired += evaluation.events.length;
    results[trigger.key] = evaluation;
    if (input.onTrigger) {
      try {
        await input.onTrigger(trigger.key, evaluation);
      } catch {
        // The caller logs its own persistence failures; the evaluation continues.
      }
    }
  }
  return Object.freeze({
    results: Object.freeze(results),
    queries,
    failedQueries,
    fired,
    errors,
    durationMs: Date.now() - started,
  });
}
