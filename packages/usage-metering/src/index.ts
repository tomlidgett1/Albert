import type { AlbertModelId } from "../../shared/src/index.js";
import { modelSupportsFastMode } from "../../shared/src/agent-runtime.js";

/**
 * Versioned public OpenAI rate card used for tenant cost attribution.
 *
 * Rates are represented as USD nanos per token so half-micro input prices and
 * cached-token discounts remain exact without floating point arithmetic.
 */
export const OPENAI_GPT_5_6_RATE_CARD = Object.freeze({
  id: "openai-gpt-5.6-au-2026-08-03",
  effectiveAt: "2026-08-03T00:00:00.000Z",
  source: "https://developers.openai.com/api/docs/pricing",
  dataResidencyRegion: "AU",
  longContextThresholdInputTokens: 272_000,
  models: Object.freeze({
    "gpt-5.6-sol": Object.freeze({ input: 5_000n, cachedInput: 500n, output: 30_000n }),
    "gpt-5.6-terra": Object.freeze({ input: 2_000n, cachedInput: 200n, output: 12_000n }),
    "gpt-5.6-luna": Object.freeze({ input: 200n, cachedInput: 20n, output: 1_200n }),
  }),
  cacheWriteInputNumerator: 5n,
  cacheWriteInputDenominator: 4n,
  fastModeNumerator: 2n,
  fastModeDenominator: 1n,
  longContextInputNumerator: 2n,
  longContextInputDenominator: 1n,
  longContextOutputNumerator: 3n,
  longContextOutputDenominator: 2n,
  regionalProcessingNumerator: 11n,
  regionalProcessingDenominator: 10n,
} as const);

/**
 * OpenAI GPT-6 standard rates (2026-09-23). GPT-6 is served only from
 * OpenAI's global host (ADR 0145), so there is no regional-processing uplift.
 * Cache writes are 1.25x input, Fast is 2x, and prompts over 272K input tokens
 * price at 2x input and 1.5x output for the whole request.
 */
export const OPENAI_GPT_6_RATE_CARD = Object.freeze({
  id: "openai-gpt-6-global-2026-09-23",
  effectiveAt: "2026-09-23T00:00:00.000Z",
  source: "https://developers.openai.com/api/docs/pricing",
  dataResidencyRegion: "global",
  longContextThresholdInputTokens: 272_000,
  models: Object.freeze({
    "gpt-6-astra": Object.freeze({ input: 10_000n, cachedInput: 1_000n, output: 50_000n }),
    "gpt-6-sol": Object.freeze({ input: 2_000n, cachedInput: 200n, output: 10_000n }),
    "gpt-6-luna": Object.freeze({ input: 100n, cachedInput: 10n, output: 500n }),
  }),
  cacheWriteInputNumerator: 5n,
  cacheWriteInputDenominator: 4n,
  fastModeNumerator: 2n,
  fastModeDenominator: 1n,
  longContextInputNumerator: 2n,
  longContextInputDenominator: 1n,
  longContextOutputNumerator: 3n,
  longContextOutputDenominator: 2n,
  regionalProcessingNumerator: 1n,
  regionalProcessingDenominator: 1n,
} as const);

/**
 * Official xAI Grok 4.6 rate card. Cached input is $0.50 / 1M below 200k
 * prompt tokens and $1.00 / 1M at or above that threshold. There is no
 * Australian residency uplift. Fast maps to xAI Priority Processing at 2x.
 */
export const XAI_GROK_4_6_RATE_CARD = Object.freeze({
  id: "xai-grok-4.6-2026-08-13",
  effectiveAt: "2026-08-13T00:00:00.000Z",
  source: "https://docs.x.ai/developers/pricing",
  dataResidencyRegion: "US",
  // Official xAI long-context is ≥ 200k prompt tokens. The shared meter uses
  // a strict greater-than check, so 199_999 makes 200_000 the first 2x request.
  longContextThresholdInputTokens: 199_999,
  models: Object.freeze({
    "grok-4.6": Object.freeze({ input: 2_000n, cachedInput: 500n, output: 6_000n }),
  }),
  cacheWriteInputNumerator: 1n,
  cacheWriteInputDenominator: 1n,
  fastModeNumerator: 2n,
  fastModeDenominator: 1n,
  longContextInputNumerator: 2n,
  longContextInputDenominator: 1n,
  longContextOutputNumerator: 2n,
  longContextOutputDenominator: 1n,
  regionalProcessingNumerator: 1n,
  regionalProcessingDenominator: 1n,
} as const);

/**
 * First-party Claude API rates for the pinned Haiku 4.5 snapshot. Albert uses
 * the default five-minute prompt-cache write tier and standard processing.
 * Manual thinking tokens are included in `output_tokens` by Anthropic.
 */
export const ANTHROPIC_HAIKU_4_5_RATE_CARD = Object.freeze({
  id: "anthropic-claude-haiku-4.5-2026-08-19",
  effectiveAt: "2026-08-19T00:00:00.000Z",
  source: "https://platform.claude.com/docs/en/about-claude/pricing",
  dataResidencyRegion: "global",
  longContextThresholdInputTokens: Number.MAX_SAFE_INTEGER,
  models: Object.freeze({
    "claude-haiku-4-5-20251001": Object.freeze({
      input: 1_000n,
      cachedInput: 100n,
      output: 5_000n,
    }),
  }),
  cacheWriteInputNumerator: 5n,
  cacheWriteInputDenominator: 4n,
  fastModeNumerator: 1n,
  fastModeDenominator: 1n,
  longContextInputNumerator: 1n,
  longContextInputDenominator: 1n,
  longContextOutputNumerator: 1n,
  longContextOutputDenominator: 1n,
  regionalProcessingNumerator: 1n,
  regionalProcessingDenominator: 1n,
} as const);

/**
 * First-party Claude API rates for the Claude 5 family (2026-09-23). Cache
 * reads are 0.1x input and five-minute cache writes 1.25x. Fast mode runs on
 * Opus 5.5 only, at 2x ($8 / $40 per MTok) across the whole context window;
 * no other model here can be metered as Fast. No long-context uplift.
 */
export const ANTHROPIC_CLAUDE_5_RATE_CARD = Object.freeze({
  id: "anthropic-claude-5-2026-09-23",
  effectiveAt: "2026-09-23T00:00:00.000Z",
  source: "https://platform.claude.com/docs/en/about-claude/pricing",
  dataResidencyRegion: "global",
  longContextThresholdInputTokens: Number.MAX_SAFE_INTEGER,
  models: Object.freeze({
    "claude-sonnet-5": Object.freeze({ input: 2_000n, cachedInput: 200n, output: 10_000n }),
    "claude-opus-5-5": Object.freeze({ input: 4_000n, cachedInput: 400n, output: 20_000n }),
    "claude-fable-5-1": Object.freeze({ input: 10_000n, cachedInput: 1_000n, output: 50_000n }),
  }),
  cacheWriteInputNumerator: 5n,
  cacheWriteInputDenominator: 4n,
  fastModeNumerator: 2n,
  fastModeDenominator: 1n,
  longContextInputNumerator: 1n,
  longContextInputDenominator: 1n,
  longContextOutputNumerator: 1n,
  longContextOutputDenominator: 1n,
  regionalProcessingNumerator: 1n,
  regionalProcessingDenominator: 1n,
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

/**
 * Exact persistence shape shared by the immutable answer finalizer and the
 * legacy usage RPC. Kept in this dependency-free metering module so plain
 * Node contract tests do not load Supabase/Next server dependencies.
 */
export function toModelUsageRpcPayload(
  metering: MeteredModelUsage,
): MeteredModelUsage {
  return Object.freeze({
    rateCardId: metering.rateCardId,
    model: metering.model,
    fastMode: metering.fastMode,
    requests: metering.requests,
    inputTokens: metering.inputTokens,
    cachedInputTokens: metering.cachedInputTokens,
    cacheWriteInputTokens: metering.cacheWriteInputTokens,
    outputTokens: metering.outputTokens,
    estimatedCostUsdMicros: metering.estimatedCostUsdMicros,
    pricingCompleteness: metering.pricingCompleteness,
  });
}

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

function rateCardFor(model: AlbertModelId) {
  if (model === "grok-4.6") return XAI_GROK_4_6_RATE_CARD;
  if (model === "claude-haiku-4-5-20251001") return ANTHROPIC_HAIKU_4_5_RATE_CARD;
  if (model === "claude-sonnet-5" || model === "claude-opus-5-5" || model === "claude-fable-5-1") {
    return ANTHROPIC_CLAUDE_5_RATE_CARD;
  }
  if (model === "gpt-6-astra" || model === "gpt-6-sol" || model === "gpt-6-luna") {
    return OPENAI_GPT_6_RATE_CARD;
  }
  return OPENAI_GPT_5_6_RATE_CARD;
}

function tokenRatesFor(model: AlbertModelId) {
  if (model === "grok-4.6") return XAI_GROK_4_6_RATE_CARD.models["grok-4.6"];
  if (model === "claude-haiku-4-5-20251001") {
    return ANTHROPIC_HAIKU_4_5_RATE_CARD.models["claude-haiku-4-5-20251001"];
  }
  if (model === "claude-sonnet-5" || model === "claude-opus-5-5" || model === "claude-fable-5-1") {
    return ANTHROPIC_CLAUDE_5_RATE_CARD.models[model];
  }
  if (model === "gpt-6-astra" || model === "gpt-6-sol" || model === "gpt-6-luna") {
    return OPENAI_GPT_6_RATE_CARD.models[model];
  }
  if (model === "gpt-5.6-sol" || model === "gpt-5.6-terra" || model === "gpt-5.6-luna") {
    return OPENAI_GPT_5_6_RATE_CARD.models[model];
  }
  throw new Error(`No Albert rate card for ${model}.`);
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
  const card = rateCardFor(model);
  const rates = tokenRatesFor(model);
  const longContext = inputTokens > card.longContextThresholdInputTokens;
  const inputMultiplier: readonly [bigint, bigint] = longContext
    ? [card.longContextInputNumerator, card.longContextInputDenominator] as const
    : [1n, 1n] as const;
  const outputMultiplier: readonly [bigint, bigint] = longContext
    ? [card.longContextOutputNumerator, card.longContextOutputDenominator] as const
    : [1n, 1n] as const;

  let nanos = 0n;
  nanos += multiplyRatio(BigInt(uncachedInputTokens) * rates.input, inputMultiplier[0], inputMultiplier[1]);
  nanos += multiplyRatio(BigInt(cachedInputTokens) * rates.cachedInput, inputMultiplier[0], inputMultiplier[1]);
  const cacheWriteRate = multiplyRatio(
    rates.input,
    card.cacheWriteInputNumerator,
    card.cacheWriteInputDenominator,
  );
  nanos += multiplyRatio(BigInt(cacheWriteInputTokens) * cacheWriteRate, inputMultiplier[0], inputMultiplier[1]);
  nanos += multiplyRatio(BigInt(outputTokens) * rates.output, outputMultiplier[0], outputMultiplier[1]);
  if (fastMode) {
    nanos = multiplyRatio(
      nanos,
      card.fastModeNumerator,
      card.fastModeDenominator,
    );
  }
  nanos = multiplyRatio(
    nanos,
    card.regionalProcessingNumerator,
    card.regionalProcessingDenominator,
  );
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
  const totalTokens = nonNegativeInteger(input.usage.totalTokens, "usage.totalTokens");
  if (totalTokens !== inputTokens + outputTokens) {
    throw new Error("Run usage total tokens do not reconcile to input and output tokens.");
  }
  if (requests === 0 && totalTokens > 0) {
    throw new Error("Run usage cannot contain tokens without a provider request.");
  }

  const entries = input.usage.requestUsageEntries;
  const requestLevel = entries !== undefined && entries.length > 0;
  if (requestLevel && entries.length !== requests) {
    throw new Error("Per-request usage entries do not reconcile to the provider request count.");
  }
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
  // Fast is priced only where the model has it: Claude's fast mode runs on Opus 5.5 alone.
  const fastMode = input.fastMode && modelSupportsFastMode(input.model);
  for (const entry of pricedEntries) {
    const priced = priceRequest(input.model, fastMode, entry);
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
    rateCardId: rateCardFor(input.model).id,
    model: input.model,
    fastMode,
    requests,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    estimatedCostUsdMicros: Number(usdMicros),
    pricingCompleteness: requestLevel ? "request_level" : "aggregate_estimate",
  });
}
