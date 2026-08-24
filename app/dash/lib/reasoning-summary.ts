import type { TraceEvent } from "@/packages/shared/src";

/** Latest public reasoning-summary snapshot; raw reasoning is never a trace event. */
export function latestReasoningSummary(events: readonly TraceEvent[]): string {
  let latest = "";
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === "narrative" && event.purpose === "reasoning_summary") {
      latest = event.text;
    }
  }
  return latest;
}
