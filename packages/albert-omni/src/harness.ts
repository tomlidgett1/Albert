import type { AgentInputItem, RunContext } from "@openai/agents";
import type { AgentRunPreferences } from "../../shared/src/agent-runtime.js";

/** Orchestration boundary; analytics tools and evidence validation stay in Albert. */
export interface AnalyticalHarness {
  run(input: Readonly<{
    instructions: string;
    tools: readonly Readonly<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      invoke: (context: RunContext<unknown>, input: string) => Promise<unknown>;
    }>[];
    input: readonly AgentInputItem[];
    preferences: AgentRunPreferences;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
  }>>;
  close(): Promise<void>;
}
