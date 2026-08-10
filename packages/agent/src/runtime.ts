import {
  normalizeAgentPreferences,
  type AgentRunPreferences,
} from "../../shared/src/index.js";
import {
  assertSemanticOnlyToolNames,
  type SemanticAgentToolName,
} from "./semantic-tools.js";

export type OpenAIAgentModelSettings = Readonly<{
  reasoning: Readonly<{
    effort: AgentRunPreferences["reasoningEffort"];
    context: "current_turn";
    mode: "standard";
  }>;
  /** Forwarded by the OpenAI provider adapter, separate from reasoning. */
  providerData: Readonly<{
    service_tier: "default" | "fast";
  }>;
}>;

export type OpenAIAgentRunConfig = Readonly<{
  model: AgentRunPreferences["model"];
  modelSettings: OpenAIAgentModelSettings;
}>;

export function buildOpenAIAgentRunConfig(input: unknown): OpenAIAgentRunConfig {
  const preferences = normalizeAgentPreferences(input);

  return Object.freeze({
    model: preferences.model,
    modelSettings: Object.freeze({
      // Albert persists only the governed, bounded narrative context. Keeping
      // reasoning scoped to the current turn prevents the provider from
      // expecting stored/encrypted reasoning items when `store` is disabled.
      reasoning: Object.freeze({
        effort: preferences.reasoningEffort,
        context: "current_turn" as const,
        mode: "standard" as const,
      }),
      // Make the processing contract observable in the provider response.
      // Omitting service_tier means `auto`, which cannot prove that a capped
      // evaluation avoided Fast/priority processing.
      providerData: Object.freeze({
        service_tier: preferences.fastMode
          ? ("fast" as const)
          : ("default" as const),
      }),
    }),
  });
}

export type SdkToolLike = Readonly<{
  name: string;
  [key: string]: unknown;
}>;

export type OpenAIAgentDefinition = Readonly<{
  name: string;
  instructions: string;
  model: AgentRunPreferences["model"];
  modelSettings: OpenAIAgentModelSettings;
  tools: readonly SdkToolLike[];
}>;

/**
 * Minimal structural interface implemented by `@openai/agents`.
 * Injection keeps this package compile-safe until the SDK is installed and
 * makes the provider boundary easy to contract-test.
 */
export interface OpenAIAgentsSdkLike {
  Agent: new (definition: OpenAIAgentDefinition) => unknown;
  run(
    agent: unknown,
    input: string,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export type OpenAIAgentRuntime = Readonly<{
  agent: unknown;
  preferences: AgentRunPreferences;
  run: (
    input: string,
    options?: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
}>;

export type CreateOpenAIAgentRuntimeOptions = Readonly<{
  sdk: OpenAIAgentsSdkLike;
  name?: string;
  instructions: string;
  preferences?: unknown;
  /** SDK tool wrappers created from the semantic tool implementations. */
  tools: readonly SdkToolLike[];
}>;

/**
 * Optional `@openai/agents` runtime factory. It cannot attach a tool whose name
 * is outside Albert's semantic allowlist.
 */
export function createOpenAIAgentRuntime(
  options: CreateOpenAIAgentRuntimeOptions,
): OpenAIAgentRuntime {
  const preferences = normalizeAgentPreferences(options.preferences);
  const instructions = options.instructions.trim();
  if (!instructions) throw new Error("Agent instructions are required.");

  const toolNames = options.tools.map(({ name }) => name);
  assertSemanticOnlyToolNames(toolNames);

  const runConfig = buildOpenAIAgentRunConfig(preferences);
  const tools = Object.freeze([...options.tools]) as readonly (
    SdkToolLike & { name: SemanticAgentToolName }
  )[];
  const agent = new options.sdk.Agent({
    name: options.name?.trim() || "Albert",
    instructions,
    model: runConfig.model,
    modelSettings: runConfig.modelSettings,
    tools,
  });

  return Object.freeze({
    agent,
    preferences,
    run(input: string, runOptions?: Readonly<Record<string, unknown>>) {
      const normalizedInput = input.trim();
      if (!normalizedInput) return Promise.reject(new Error("Agent input is required."));
      return options.sdk.run(agent, normalizedInput, runOptions);
    },
  });
}
