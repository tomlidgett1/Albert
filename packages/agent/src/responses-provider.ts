import { OpenAIProvider } from "@openai/agents";
import type { ResolvedAlbertModelTransport } from "../../shared/src/index.js";

/**
 * OpenAI-compatible Responses transport. GPT profiles use the configured
 * OpenAI host. Grok 4.6 uses the official xAI host with the same SDK.
 */
export function createAlbertResponsesProvider(
  transport: ResolvedAlbertModelTransport,
): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: transport.apiKey,
    baseURL: transport.baseUrl,
    useResponses: true,
    // xAI is Responses-compatible but does not implement every OpenAI-only
    // feature the SDK can emit. Fail open on those rather than 400 the turn.
    strictFeatureValidation: transport.provider === "openai",
  });
}
