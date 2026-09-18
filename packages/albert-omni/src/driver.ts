import type { AgentInputItem, Tool } from "@openai/agents";
import type { AgentRunPreferences } from "../../shared/src/index.js";
import type { OmniTurnUsage } from "./contracts.js";

/**
 * The agent-loop seam of an Omni-style turn (ADR 0141).
 *
 * `runOmniSemanticTurn` owns the governed tools, the evidence registry, the
 * answer contract and the trace; a driver owns only how the model is run
 * against those tools. The in-process `@openai/agents` Runner is the default
 * driver; the OAI Codex harness supplies one backed by OpenAI's managed
 * Agents API. Both see the same instructions, the same tool set and the same
 * nudges, so a side-by-side comparison measures the harness, not the tools.
 */

/**
 * A governed tool as `@openai/agents` builds it: a JSON-schema `parameters`
 * block (strict: every field required, no extras) and an `invoke` that
 * validates the arguments and answers invalid ones through the tool's own
 * error function. Every Omni tool is a function tool.
 */
export type OmniFunctionTool = Extract<Tool, { type: "function" }>;

export function isOmniFunctionTool(tool: Tool): tool is OmniFunctionTool {
  return tool.type === "function";
}

/** A continuation of the same conversation: the assistant's last reply, then a new instruction. */
export type OmniDriverContinuation = Readonly<{
  assistantText: string;
  userText: string;
}>;

export type OmniDriverResume = Readonly<{
  /** `@openai/agents` history for the in-process driver. */
  history?: readonly AgentInputItem[];
  /** Opaque driver continuation state (a managed session identity, for example). */
  driverState?: unknown;
  usage?: OmniTurnUsage;
  modelRequests?: number;
}>;

export type OmniAgentDriverInput = Readonly<{
  /** Display name of the agent ("Albert Omni analyst"). */
  name: string;
  instructions: string;
  tools: readonly Tool[];
  preferences: AgentRunPreferences;
  identity: Readonly<{
    tenantId: string;
    actorId: string;
    conversationId: string;
    turnId: string;
  }>;
  priorConversation: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
  message: string;
  signal: AbortSignal;
  /** Interim assistant prose between tool calls; never the final answer. */
  onNarrative: (text: string) => Promise<void>;
  /** Called after each completed tool result so the turn can checkpoint. */
  onCheckpoint: () => Promise<void>;
  resume?: OmniDriverResume;
}>;

export type OmniDriverCheckpointState = Readonly<{
  history: readonly AgentInputItem[];
  driverState?: unknown;
}>;

export type OmniAgentDriver = Readonly<{
  /**
   * Runs the agent until it stops and returns everything it said after its
   * last successful tool result. With a continuation, the conversation
   * carries on from the assistant's prior reply with a new user instruction.
   */
  run: (continuation?: OmniDriverContinuation) => Promise<string>;
  modelRequests: () => number;
  usage: () => OmniTurnUsage;
  checkpointState: () => OmniDriverCheckpointState;
  /** Releases any remote resources the driver holds (best effort). */
  close: () => Promise<void>;
}>;

export type OmniAgentDriverFactory = (input: OmniAgentDriverInput) => OmniAgentDriver;

export const EMPTY_OMNI_TURN_USAGE: OmniTurnUsage = Object.freeze({
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

/** The last-successful-tool-result rule shared by every driver: transitions are dropped, duplicates collapse. */
export function assembleDriverAnswer(parts: readonly string[], finalText: string): string {
  const assembled = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part, index, all) => all.indexOf(part) === index)
    .filter((part, index, all) => index === all.length - 1 || !isTransitionMessage(part))
    .join("\n\n");
  const final = finalText.trim();
  return assembled.length > final.length ? assembled : final;
}

/** Short lead-ins the model writes before a tool call ("Let me fix that:"). */
export function isTransitionMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 160 && (/[:…]$/u.test(trimmed) || /^(?:let me|now (?:let me|i)|i'll|i will|next,?)\b/iu.test(trimmed));
}
