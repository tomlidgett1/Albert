import type { AgentInputItem } from "@openai/agents";
import type { CodexEvidenceResult } from "../../albert-codex/src/semantic-runtime.js";
import type { ResultSemantics, TraceTableDerivationV1, TraceTableEvent } from "../../shared/src/index.js";
import type { ComposedAnswer } from "./answer.js";
import type { OmniComposeDashboardInput, OmniTurnUsage } from "./contracts.js";

export type OmniEvidenceResult = CodexEvidenceResult & Readonly<{
  semantics?: ResultSemantics;
  priorTurn?: boolean;
  rowFormats?: TraceTableEvent["rowFormats"];
}>;

/** Private, encrypted, short-lived continuation state. Never a public trace event. */
export type OmniTurnCheckpoint = Readonly<{
  version: 1;
  startedAt: number;
  catalogueDigest: string;
  history: readonly AgentInputItem[];
  evidence: readonly OmniEvidenceResult[];
  tasks: readonly Readonly<{ id: string; label: string; completed: boolean }>[];
  queriesExecuted: number;
  queryAttempts: number;
  modelSearches: number;
  valueLookups: number;
  modelRequests: number;
  hadQueryFailures: boolean;
  inspectedTopics: readonly string[];
  seenQueryDigests: readonly string[];
  derivations: readonly (readonly [string, TraceTableDerivationV1])[];
  unreplayableResultIds: readonly string[];
  charts: Readonly<{ emitted: number; signatures: readonly string[] }>;
  acceptedAnswer: ComposedAnswer | null;
  acceptedPlan: OmniComposeDashboardInput | null;
  usage: OmniTurnUsage;
}>;
