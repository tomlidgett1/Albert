/**
 * Parent-turn events for a Swarm run. The owner thread shows the plan and
 * the synthesised answer. Child traces stay on their own conversations.
 */
import type { AnswerState, TraceEvent, TracePlanStep, TraceProvenance } from "@/packages/shared/src";

export type SwarmProvenancePeriod = Readonly<{
  label: string;
  start: string;
  end: string;
}>;

export function swarmParentProvenance(input: Readonly<{
  timezone: string;
  period?: SwarmProvenancePeriod | null;
}>): TraceProvenance {
  return {
    sources: [],
    timeRange: {
      label: input.period?.label ?? "As investigated by the swarm",
      start: input.period?.start ?? "unknown",
      end: input.period?.end ?? "unknown",
      timezone: input.timezone,
    },
    definitions: [],
    semanticBundleHash: "albert-swarm-no-direct-query",
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  };
}

export function swarmEmptyProvenance(timezone: string): TraceProvenance {
  return swarmParentProvenance({ timezone });
}

export function swarmPlanSteps(input: Readonly<{
  agents: readonly Readonly<{ key: string; title: string; status: string }>[];
  synthesising?: boolean;
  synthesised?: boolean;
}>): readonly TracePlanStep[] {
  let sawActive = false;
  const workerSteps = input.agents.map((agent) => {
    const finished = agent.status === "completed" || agent.status === "done";
    const failed = agent.status === "failed" || agent.status === "stopped";
    const running = agent.status === "running" || agent.status === "researching";
    const active = running && !sawActive;
    if (active) sawActive = true;
    return {
      id: agent.key.slice(0, 47),
      label: agent.title,
      status: finished
        ? "done" as const
        : failed
          ? "incomplete" as const
          : active
            ? "active" as const
            : "pending" as const,
      kind: "evidence" as const,
      evidenceResultIds: [],
      ...(failed ? { statusDetail: "This specialist could not finish." } : {}),
    };
  });
  return Object.freeze([
    ...workerSteps,
    {
      id: "swarm-synthesis",
      label: "Combine the findings",
      status: input.synthesised
        ? "done" as const
        : input.synthesising
          ? "active" as const
          : "pending" as const,
      kind: "synthesis" as const,
      evidenceResultIds: [],
    },
  ]);
}

export type SwarmLiveCommentaryAgent = Readonly<{
  key: string;
  title: string;
  tagline: string;
  phase: string;
  statusLine: string;
  queriesSeen: number;
  headline: string | null;
  answerState: string | null;
  error: string | null;
}>;

function elapsedLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.max(0, Math.floor((ms % 60_000) / 1000));
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * Live commentary for the parent thread while the fleet runs: a milestone
 * line per specialist as it starts and settles, a rewriting status line per
 * specialist still working (every one, not just the busiest), and a fleet
 * pulse with finished count, governed queries and elapsed time. Milestone
 * ids are stable so settled lines keep their place; the in-flight lines and
 * the pulse rewrite via `nowIso`.
 */
export function swarmLiveCommentary(input: Readonly<{
  runId: string;
  agents: readonly SwarmLiveCommentaryAgent[];
  synthesising: boolean;
  startedAtMs: number | null;
  nowMs: number;
  nowIso: string;
  checkpointText?: string | null;
  startSequence: number;
  stamp: (id: string) => string;
}>): TraceEvent[] {
  const events: TraceEvent[] = [];
  let sequence = input.startSequence;
  for (const agent of input.agents) {
    if (agent.phase === "pending") continue;
    const startId = `swarm_live_${input.runId}_${agent.key}_start`;
    events.push({
      id: startId,
      sequence: sequence += 1,
      type: "narrative",
      occurredAt: input.stamp(startId),
      text: agent.tagline
        ? `${agent.title} is investigating: ${agent.tagline}`
        : `${agent.title} is investigating.`,
    });
    if (agent.phase === "done") {
      const doneId = `swarm_live_${input.runId}_${agent.key}_done`;
      const reported = agent.answerState ? `reported (${agent.answerState})` : "reported";
      events.push({
        id: doneId,
        sequence: sequence += 1,
        type: "narrative",
        occurredAt: input.stamp(doneId),
        text: agent.headline
          ? `${agent.title} ${reported}: ${agent.headline}`
          : `${agent.title} has finished${agent.queriesSeen > 0 ? ` after ${agent.queriesSeen} governed ${agent.queriesSeen === 1 ? "query" : "queries"}` : ""}.`,
      });
    } else if (agent.phase === "failed") {
      const failId = `swarm_live_${input.runId}_${agent.key}_failed`;
      events.push({
        id: failId,
        sequence: sequence += 1,
        type: "narrative",
        occurredAt: input.stamp(failId),
        text: `${agent.title} couldn't finish${agent.error ? ` — ${agent.error}` : "."}`,
      });
    }
  }

  const inFlight = input.agents.filter((agent) => (
    agent.phase === "starting" || agent.phase === "researching" || agent.phase === "recording"
  ));
  if (input.synthesising) {
    const synthId = `swarm_live_${input.runId}_synthesising`;
    events.push({
      id: synthId,
      sequence: sequence += 1,
      type: "narrative",
      occurredAt: input.stamp(synthId),
      text: "All specialists have reported. Combining their findings into one answer…",
    });
  } else {
    for (const agent of inFlight) {
      events.push({
        id: `swarm_live_${input.runId}_now_${agent.key}`,
        sequence: sequence += 1,
        type: "narrative",
        occurredAt: input.nowIso,
        text: agent.queriesSeen > 0
          ? `${agent.title} · ${agent.statusLine} (${agent.queriesSeen} ${agent.queriesSeen === 1 ? "query" : "queries"})`
          : `${agent.title} · ${agent.statusLine}`,
      });
    }
    if (inFlight.length > 0 && input.agents.length > 1) {
      const settled = input.agents.filter((agent) => agent.phase === "done" || agent.phase === "failed").length;
      const totalQueries = input.agents.reduce((total, agent) => total + agent.queriesSeen, 0);
      const parts = [
        `${settled} of ${input.agents.length} specialists finished`,
        `${totalQueries} governed ${totalQueries === 1 ? "query" : "queries"} so far`,
        ...(input.startedAtMs ? [`${elapsedLabel(input.nowMs - input.startedAtMs)} elapsed`] : []),
      ];
      events.push({
        id: `swarm_live_${input.runId}_pulse`,
        sequence: sequence += 1,
        type: "narrative",
        occurredAt: input.nowIso,
        text: parts.join(" · "),
      });
    }
  }
  if (input.checkpointText) {
    events.push({
      id: `swarm_live_${input.runId}_checkpoint`,
      sequence: sequence += 1,
      type: "narrative",
      occurredAt: input.nowIso,
      text: input.checkpointText,
    });
  }
  return events;
}

export function swarmParentAnswerEvent(input: Readonly<{
  id: string;
  sequence: number;
  occurredAt: string;
  answer: string;
  answerState: AnswerState;
  followUps: readonly string[];
  timezone: string;
  period?: SwarmProvenancePeriod | null;
}>): TraceEvent {
  return {
    id: input.id,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    type: "answer",
    status: input.answerState === "Unavailable" ? "warning" : "complete",
    state: input.answerState,
    text: input.answer,
    provenance: swarmParentProvenance({ timezone: input.timezone, period: input.period }),
    followUps: [...input.followUps],
    presentedResultIds: [],
    claims: [],
  };
}
