import {
  isXaiModel,
  normalizeAgentPreferences,
  serviceTierForPreferences,
  type AgentRunPreferences,
} from "../../shared/src/index.js";

/** Official xAI include for tool-loop continuity when `store` is false. */
export const XAI_ENCRYPTED_REASONING_INCLUDE = [
  "reasoning.encrypted_content",
] as const;

export type OpenAIAgentModelSettings = Readonly<{
  store: false;
  reasoning: Readonly<{
    effort: AgentRunPreferences["reasoningEffort"];
    context?: "current_turn";
    mode?: "standard";
  }>;
  text?: Readonly<{ verbosity: "low" | "medium" }>;
  parallelToolCalls?: boolean;
  /** Forwarded by the OpenAI provider adapter, separate from reasoning. */
  providerData: Readonly<{
    service_tier?: "default" | "fast" | "priority";
    prompt_cache_key?: string;
    include?: readonly string[];
    safety_identifier?: string;
  }>;
}>;

export type OpenAIAgentRunConfig = Readonly<{
  model: AgentRunPreferences["model"];
  modelSettings: OpenAIAgentModelSettings;
}>;

export function buildOpenAIAgentRunConfig(input: unknown): OpenAIAgentRunConfig {
  const preferences = normalizeAgentPreferences(input);

  if (isXaiModel(preferences.model)) {
    // Official xAI Grok 4.6 contract: reasoning.effort only, store disabled,
    // Fast maps to service_tier priority (not OpenAI fast). Extra OpenAI
    // reasoning fields 400.
    return Object.freeze({
      model: preferences.model,
      modelSettings: Object.freeze({
        store: false as const,
        reasoning: Object.freeze({
          effort: preferences.reasoningEffort,
        }),
        providerData: Object.freeze({
          include: XAI_ENCRYPTED_REASONING_INCLUDE,
          service_tier: serviceTierForPreferences(preferences),
        }),
      }),
    });
  }

  return Object.freeze({
    model: preferences.model,
    modelSettings: Object.freeze({
      store: false as const,
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
        service_tier: serviceTierForPreferences(preferences),
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


export type LiveAgentModelSettingsOptions = Readonly<{
  reasoning?: OpenAIAgentModelSettings["reasoning"];
  verbosity?: "low" | "medium";
  parallelToolCalls?: boolean;
  safetyIdentifier?: string;
}>;

/**
 * Builds Responses `modelSettings` for a live agent. Grok 4.6 rejects OpenAI
 * reasoning.context/mode and text.verbosity; safety_identifier stays
 * OpenAI-only. Fast maps to xAI `priority`. Encrypted reasoning is requested
 * only on the xAI wire.
 */
export function buildLiveAgentModelSettings(
  runConfig: OpenAIAgentRunConfig,
  options: LiveAgentModelSettingsOptions = {},
): OpenAIAgentModelSettings {
  const grok = isXaiModel(runConfig.model);
  const reasoning = options.reasoning ?? runConfig.modelSettings.reasoning;
  return Object.freeze({
    store: false as const,
    reasoning: grok
      ? Object.freeze({ effort: reasoning.effort })
      : Object.freeze({ ...reasoning }),
    ...(grok || !options.verbosity
      ? {}
      : { text: Object.freeze({ verbosity: options.verbosity }) }),
    ...(options.parallelToolCalls === undefined
      ? {}
      : { parallelToolCalls: options.parallelToolCalls }),
    providerData: grok
      ? Object.freeze({
          include: XAI_ENCRYPTED_REASONING_INCLUDE,
          service_tier: runConfig.modelSettings.providerData.service_tier ?? "default",
        })
      : Object.freeze({
          ...runConfig.modelSettings.providerData,
          ...(options.safetyIdentifier
            ? { safety_identifier: options.safetyIdentifier }
            : {}),
        }),
  });
}
