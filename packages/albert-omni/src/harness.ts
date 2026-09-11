import type { AgentInputItem, RunContext } from "@openai/agents";
import type { AgentRunPreferences } from "../../shared/src/agent-runtime.js";

export interface AnalyticalResultHandles {
  register(id: string): string;
  resolve(alias: string): string | undefined;
  encode(value: unknown): unknown;
  referencedIds(value: unknown): string[];
}

export type AnalyticalNativeRun = Readonly<{
  deadlineAt?: number;
  getProgress?: () => Readonly<{ results: number; queries: number }>;
  onSynthesis?: () => Promise<void>;
  question: string;
  context: string;
  resultsContext: string;
  catalogueDigest: string;
  getInspectedTopics: () => readonly string[];
  resetInspectedTopics: () => void;
  ensureResults: (ids: readonly string[]) => Promise<void>;
  finalSchema: Record<string, unknown>;
  validateFinal: (value: unknown) => Promise<readonly string[]>;
  recordToolFailure: (name: string, detail: string) => Promise<void>;
}>;

/** Orchestration boundary; analytics tools and evidence validation stay in Albert. */
export interface AnalyticalHarness {
  readonly native?: boolean;
  readonly references?: AnalyticalResultHandles;
  knownTopics?(catalogueDigest: string): readonly string[];
  run(input: Readonly<{
    instructions: string;
    tools: readonly Readonly<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      invoke: (context: RunContext<unknown>, input: string) => Promise<unknown>;
      invokeNative?: (argumentsValue: unknown) => Promise<unknown>;
    }>[];
    input: readonly AgentInputItem[];
    preferences: AgentRunPreferences;
    signal: AbortSignal;
    native?: AnalyticalNativeRun;
  }>): Promise<Readonly<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningTokens: number;
  }>>;
  close(): Promise<void>;
}
