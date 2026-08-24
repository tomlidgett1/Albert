/**
 * Parent-turn events for a Swarm run. The owner thread shows the plan and
 * the synthesised answer. Child traces stay on their own conversations.
 */
import type { AnswerState, TraceEvent, TracePlanStep, TraceProvenance } from "@/packages/shared/src";

export function swarmEmptyProvenance(timezone: string): TraceProvenance {
  return {
    sources: [],
    timeRange: {
      label: "As investigated by the swarm",
      start: "unknown",
      end: "unknown",
      timezone,
    },
    definitions: [],
    semanticBundleHash: "albert-swarm-no-direct-query",
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  };
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

export function swarmParentAnswerEvent(input: Readonly<{
  id: string;
  sequence: number;
  occurredAt: string;
  answer: string;
  answerState: AnswerState;
  followUps: readonly string[];
  timezone: string;
}>): TraceEvent {
  return {
    id: input.id,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    type: "answer",
    status: input.answerState === "Unavailable" ? "warning" : "complete",
    state: input.answerState,
    text: input.answer,
    provenance: swarmEmptyProvenance(input.timezone),
    followUps: [...input.followUps],
    presentedResultIds: [],
    claims: [],
  };
}
