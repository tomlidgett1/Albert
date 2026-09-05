import type { TraceEvent } from "../../../packages/shared/src/index.js";

/**
 * Returns null for historical traces that predate explicit presentation
 * control. New traces expose only lead-selected result tables and the governed
 * tables required to render selected charts.
 */
export function responseVisibleResultIds(
  events: readonly TraceEvent[],
): ReadonlySet<string> | null {
  const answerEvents = events.filter((event) => event.type === "answer");
  const presentationControlled = answerEvents.some(
    (event) => event.presentedResultIds !== undefined,
  );
  if (!presentationControlled) return null;
  return new Set([
    ...answerEvents.flatMap((event) => event.presentedResultIds ?? []),
    ...events.flatMap((event) => event.type === "chart" ? [event.dataRef] : []),
  ]);
}
