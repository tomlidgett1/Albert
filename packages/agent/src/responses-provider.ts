import { OpenAIProvider, type ModelProvider } from "@openai/agents";
import type { ResolvedAlbertModelTransport } from "../../shared/src/index.js";
import { createAnthropicMessagesModelProvider } from "./anthropic-messages-provider.js";

/**
 * OpenAI-compatible Responses transport. GPT profiles use the configured
 * OpenAI host. Grok 4.6 uses the official xAI host with the same SDK.
 */
export function createAlbertResponsesProvider(
  transport: ResolvedAlbertModelTransport,
): OpenAIProvider {
  if (transport.provider === "anthropic") {
    throw new Error("Anthropic Messages is not an OpenAI Responses transport.");
  }
  return new OpenAIProvider({
    apiKey: transport.apiKey,
    baseURL: transport.baseUrl,
    useResponses: true,
    // xAI is Responses-compatible but does not implement every OpenAI-only
    // feature the SDK can emit. Fail open on those rather than 400 the turn.
    strictFeatureValidation: transport.provider === "openai",
  });
}

/** Resolve the selected provider without pretending Messages is Responses-compatible. */
export function createAlbertModelProvider(
  transport: ResolvedAlbertModelTransport,
): ModelProvider {
  return transport.provider === "anthropic"
    ? createAnthropicMessagesModelProvider(transport)
    : createAlbertResponsesProvider(transport);
}
