import {
  Agent,
  run,
  type ModelSettings,
  type Tool,
} from "@openai/agents";
import {
  normalizeAgentPreferences,
  type AgentRunPreferences,
} from "../../shared/src/index.js";
import { assertSemanticOnlyToolNames } from "./semantic-tools.js";
import { buildOpenAIAgentRunConfig } from "./runtime.js";

export type SemanticSdkTool<TContext = unknown> = Extract<
  Tool<TContext>,
  { type: "function" }
>;

export type CreateAlbertOpenAIAgentOptions<TContext = unknown> = Readonly<{
  name?: string;
  instructions: string;
  preferences?: unknown;
  /** Function tools already wrapped with `@openai/agents` `tool()`. */
  tools: readonly SemanticSdkTool<TContext>[];
}>;

export type AlbertOpenAIAgent<TContext = unknown> = Readonly<{
  agent: Agent<TContext>;
  preferences: AgentRunPreferences;
}>;

/**
 * Production adapter for the current `@openai/agents` stack. Construction is
 * side-effect free; API access happens only when `runAlbertOpenAIAgent` runs.
 */
export function createAlbertOpenAIAgent<TContext = unknown>(
  options: CreateAlbertOpenAIAgentOptions<TContext>,
): AlbertOpenAIAgent<TContext> {
  const preferences = normalizeAgentPreferences(options.preferences);
  const instructions = options.instructions.trim();
  if (!instructions) throw new Error("Agent instructions are required.");

  const toolNames = options.tools.map(({ name }) => name);
  assertSemanticOnlyToolNames(toolNames);

  const runConfig = buildOpenAIAgentRunConfig(preferences);
  const modelSettings: ModelSettings = {
    reasoning: { effort: runConfig.modelSettings.reasoning.effort },
    providerData: { ...runConfig.modelSettings.providerData },
  };

  const agent = new Agent<TContext>({
    name: options.name?.trim() || "Albert",
    instructions,
    model: runConfig.model,
    modelSettings,
    tools: [...options.tools],
  });

  return Object.freeze({ agent, preferences });
}

/** Retains the SDK's typed streaming and non-streaming overloads. */
export { run as runAlbertOpenAIAgent };
