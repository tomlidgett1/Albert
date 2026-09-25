/**
 * Server-side recovery of a Swarm child's answer (ADR 0120 update).
 *
 * A child turn persists its answer on its own conversation before the
 * browser relays a distilled copy to /api/swarm/agent. When that relay never
 * lands (tab closed, POST failed, run reconciled first), the persisted
 * transcript is still the truth: synthesis re-reads it by the child's stored
 * conversation and turn ids instead of trusting the relay alone.
 */

export type SwarmChildAnswer = Readonly<{
  text: string;
  answerState: string | null;
  followUps: readonly string[];
}>;

/**
 * The persisted status of one turn from an `albert_conversation_history`
 * payload, or null when the turn is missing. A child whose stream broke in
 * the browser can still be "running" here: the server keeps executing after
 * a client disconnect, so a missing answer is not yet a dead child.
 */
export function swarmChildTurnStatusFromHistory(
  history: unknown,
  turnId: string,
): string | null {
  if (!history || typeof history !== "object" || Array.isArray(history)) return null;
  const turns = (history as { turns?: unknown }).turns;
  if (!Array.isArray(turns)) return null;
  for (const turn of turns) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) continue;
    const row = turn as Record<string, unknown>;
    if (row.turn_id !== turnId) continue;
    return typeof row.status === "string" ? row.status : null;
  }
  return null;
}

/**
 * Extract the terminal answer of one turn from an
 * `albert_conversation_history` payload. Returns null when the turn is
 * missing or never persisted an answer event — a child that died mid-stream
 * has nothing to recover.
 */
export function swarmChildAnswerFromHistory(
  history: unknown,
  turnId: string,
): SwarmChildAnswer | null {
  if (!history || typeof history !== "object" || Array.isArray(history)) return null;
  const turns = (history as { turns?: unknown }).turns;
  if (!Array.isArray(turns)) return null;
  for (const turn of turns) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) continue;
    const row = turn as Record<string, unknown>;
    if (row.turn_id !== turnId) continue;
    const events = Array.isArray(row.events) ? row.events : [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const payload = event as Record<string, unknown>;
      if (payload.type !== "answer") continue;
      if (typeof payload.text !== "string" || payload.text.trim().length === 0) continue;
      return Object.freeze({
        text: payload.text,
        answerState: typeof payload.state === "string" ? payload.state : null,
        followUps: Object.freeze(Array.isArray(payload.followUps)
          ? payload.followUps
            .filter((item): item is string => typeof item === "string")
            .slice(0, 6)
          : []),
      });
    }
    return null;
  }
  return null;
}
