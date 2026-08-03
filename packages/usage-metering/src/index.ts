import type { AlbertModelId } from "../../shared/src/index.js";

/**
 * Versioned public OpenAI rate card used for tenant cost attribution.
 *
 * Rates are represented as USD nanos per token so half-micro input prices and
 * cached-token discounts remain exact without floating point arithmetic.
 */
export const OPENAI_GPT_5_6_RATE_CARD = Object.freeze({
  id: "openai-gpt-5.6-2026-08-03",
  effectiveAt: "2026-08-03T00:00:00.000Z",
  source: "https://developers.openai.com/api/docs/models/compare",
  longContextThresholdInputTokens: 272_000,
  models: Object.freeze({
    "gpt-5.6-sol": Object.freeze({ input: 5_000n, cachedInput: 500n, output: 30_000n }),
    "gpt-5.6-terra": Object.freeze({ input: 2_500n, cachedInput: 250n, output: 15_000n }),
    "gpt-5.6-luna": Object.freeze({ input: 1_000n, cachedInput: 100n, output: 6_000n }),
  }),
  cacheWriteInputNumerator: 5n,
  cacheWriteInputDenominator: 4n,
  fastModeNumerator: 2n,
  fastModeDenominator: 1n,
  longContextInputNumerator: 2n,
  longContextInputDenominator: 1n,
  longContextOutputNumerator: 3n,
  longContextOutputDenominator: 2n,
} as const);

export type ProviderRequestUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  inputTokensDetails?: Readonly<Record<string, number>>;
  outputTokensDetails?: Readonly<Record<string, number>>;
  endpoint?: string;
}>;

export type ProviderRunUsage = Readonly<{
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokensDetails?: readonly Readonly<Record<string, number>>[];
  outputTokensDetails?: readonly Readonly<Record<string, number>>[];
  requestUsageEntries?: readonly ProviderRequestUsage[];
}>;

export type MeteredModelUsage = Readonly<{
  rateCardId: string;
  model: AlbertModelId;
  fastMode: boolean;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  estimatedCostUsdMicros: number;
  pricingCompleteness: "request_level" | "aggregate_estimate";
}>;

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function detailCount(
  details: Readonly<Record<string, number>> | undefined,
  aliases: readonly string[],
): number {
  if (!details) return 0;
  for (const alias of aliases) {
    const value = details[alias];
    if (value !== undefined) return nonNegativeInteger(value, `usage.${alias}`);
  }
  return 0;
}

const cachedAliases = ["cached_tokens", "cachedTokens"] as const;
const cacheWriteAliases = [
  "cache_write_tokens",
  "cacheWriteTokens",
  "cache_write_input_tokens",
  "cacheWriteInputTokens",
] as const;

function multiplyRatio(value: bigint, numerator: bigint, denominator: bigint): bigint {
  return (value * numerator + denominator - 1n) / denominator;
}

function priceRequest(
  model: AlbertModelId,
  fastMode: boolean,
  request: ProviderRequestUsage,
): Readonly<{
  nanos: bigint;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
}> {
  const inputTokens = nonNegativeInteger(request.inputTokens, "request.inputTokens");
  const outputTokens = nonNegativeInteger(request.outputTokens, "request.outputTokens");
  const cachedInputTokens = detailCount(request.inputTokensDetails, cachedAliases);
  const cacheWriteInputTokens = detailCount(request.inputTokensDetails, cacheWriteAliases);
  if (cachedInputTokens + cacheWriteInputTokens > inputTokens) {
    throw new Error("Cached and cache-write input tokens cannot exceed total input tokens.");
  }

  const uncachedInputTokens = inputTokens - cachedInputTokens - cacheWriteInputTokens;
  const rates = OPENAI_GPT_5_6_RATE_CARD.models[model];
  const longContext = inputTokens > OPENAI_GPT_5_6_RATE_CARD.longContextThresholdInputTokens;
  const inputMultiplier: readonly [bigint, bigint] = longContext
    ? [OPENAI_GPT_5_6_RATE_CARD.longContextInputNumerator, OPENAI_GPT_5_6_RATE_CARD.longContextInputDenominator] as const
    : [1n, 1n] as const;
  const outputMultiplier: readonly [bigint, bigint] = longContext
    ? [OPENAI_GPT_5_6_RATE_CARD.longContextOutputNumerator, OPENAI_GPT_5_6_RATE_CARD.longContextOutputDenominator] as const
    : [1n, 1n] as const;

  let nanos = 0n;
  nanos += multiplyRatio(BigInt(uncachedInputTokens) * rates.input, inputMultiplier[0], inputMultiplier[1]);
  nanos += multiplyRatio(BigInt(cachedInputTokens) * rates.cachedInput, inputMultiplier[0], inputMultiplier[1]);
  const cacheWriteRate = multiplyRatio(
    rates.input,
    OPENAI_GPT_5_6_RATE_CARD.cacheWriteInputNumerator,
    OPENAI_GPT_5_6_RATE_CARD.cacheWriteInputDenominator,
  );
  nanos += multiplyRatio(BigInt(cacheWriteInputTokens) * cacheWriteRate, inputMultiplier[0], inputMultiplier[1]);
  nanos += multiplyRatio(BigInt(outputTokens) * rates.output, outputMultiplier[0], outputMultiplier[1]);
  if (fastMode) {
    nanos = multiplyRatio(
      nanos,
      OPENAI_GPT_5_6_RATE_CARD.fastModeNumerator,
      OPENAI_GPT_5_6_RATE_CARD.fastModeDenominator,
    );
  }
  return { nanos, cachedInputTokens, cacheWriteInputTokens };
}

function sumDetails(
  values: readonly Readonly<Record<string, number>>[] | undefined,
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const value of values ?? []) {
    for (const [key, count] of Object.entries(value)) {
      result[key] = (result[key] ?? 0) + nonNegativeInteger(count, `usage.${key}`);
    }
  }
  return result;
}

/**
 * Produces an immutable, auditable tenant-usage line. It is a cost estimate,
 * not an invoice: the provider's organisation costs endpoint remains the
 * financial reconciliation source.
 */
export function meterOpenAIUsage(input: Readonly<{
  model: AlbertModelId;
  fastMode: boolean;
  usage: ProviderRunUsage;
}>): MeteredModelUsage {
  const requests = nonNegativeInteger(input.usage.requests, "usage.requests");
  const inputTokens = nonNegativeInteger(input.usage.inputTokens, "usage.inputTokens");
  const outputTokens = nonNegativeInteger(input.usage.outputTokens, "usage.outputTokens");
  nonNegativeInteger(input.usage.totalTokens, "usage.totalTokens");

  const entries = input.usage.requestUsageEntries;
  const requestLevel = entries !== undefined && entries.length > 0;
  const pricedEntries = requestLevel
    ? entries
    : [{
        inputTokens,
        outputTokens,
        inputTokensDetails: sumDetails(input.usage.inputTokensDetails),
      }];

  let nanos = 0n;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  for (const entry of pricedEntries) {
    const priced = priceRequest(input.model, input.fastMode, entry);
    nanos += priced.nanos;
    cachedInputTokens += priced.cachedInputTokens;
    cacheWriteInputTokens += priced.cacheWriteInputTokens;
  }

  const meteredInput = pricedEntries.reduce((total, entry) => total + entry.inputTokens, 0);
  const meteredOutput = pricedEntries.reduce((total, entry) => total + entry.outputTokens, 0);
  if (meteredInput !== inputTokens || meteredOutput !== outputTokens) {
    throw new Error("Per-request usage does not reconcile to the run usage totals.");
  }

  const usdMicros = (nanos + 999n) / 1_000n;
  if (usdMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Metered cost exceeds the supported safe integer range.");
  }
  return Object.freeze({
    rateCardId: OPENAI_GPT_5_6_RATE_CARD.id,
    model: input.model,
    fastMode: input.fastMode,
    requests,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    estimatedCostUsdMicros: Number(usdMicros),
    pricingCompleteness: requestLevel ? "request_level" : "aggregate_estimate",
  });
}
