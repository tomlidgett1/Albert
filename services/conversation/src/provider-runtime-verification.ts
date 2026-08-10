type RecordLike = Readonly<Record<string, unknown>>;

export type OpenAIProviderRuntimeRequirement = Readonly<{
  model: string;
  reasoningEffort: string;
  reasoningMode: "standard";
  serviceTier: "default" | "fast";
}>;

export type OpenAIProviderRuntimeReceipt = Readonly<
  OpenAIProviderRuntimeRequirement & {
    responseCount: number;
    verified: true;
  }
>;

function record(value: unknown): RecordLike | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

/**
 * Verifies the effective settings echoed by every OpenAI Responses API call.
 * Only the bounded settings receipt escapes this function; raw provider data,
 * model output and reasoning content remain private.
 */
export function verifyOpenAIProviderRuntime(
  rawResponses: readonly unknown[],
  expected: OpenAIProviderRuntimeRequirement,
): OpenAIProviderRuntimeReceipt {
  if (rawResponses.length === 0)
    throw new Error(
      "Provider runtime verification requires at least one response.",
    );

  for (const [index, rawResponse] of rawResponses.entries()) {
    const response = record(rawResponse);
    const providerData = record(response?.providerData);
    const reasoning = record(providerData?.reasoning);
    if (!providerData || !reasoning)
      throw new Error(
        `Provider response ${index + 1} did not expose effective runtime settings.`,
      );
    if (providerData.model !== expected.model)
      throw new Error(
        `Provider response ${index + 1} did not use the required model.`,
      );
    if (reasoning.effort !== expected.reasoningEffort)
      throw new Error(
        `Provider response ${index + 1} did not use the required reasoning effort.`,
      );
    if (reasoning.mode !== expected.reasoningMode)
      throw new Error(
        `Provider response ${index + 1} did not use the required reasoning mode.`,
      );
    if (providerData.service_tier !== expected.serviceTier)
      throw new Error(
        `Provider response ${index + 1} did not use the required processing tier.`,
      );
  }

  return Object.freeze({
    ...expected,
    responseCount: rawResponses.length,
    verified: true as const,
  });
}
