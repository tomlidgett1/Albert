import assert from "node:assert/strict";
import test from "node:test";
import {
  meterOpenAIUsage,
  OPENAI_GPT_5_6_RATE_CARD,
} from "../packages/usage-metering/src/index.ts";
import { toModelUsageRpcPayload } from "../services/conversation/src/artifact-store.ts";

test("meters standard, cached, cache-write, output, and Fast usage exactly", () => {
  const metered = meterOpenAIUsage({
    model: "gpt-5.6-sol",
    fastMode: true,
    usage: {
      requests: 1,
      inputTokens: 1_000,
      outputTokens: 100,
      totalTokens: 1_100,
      requestUsageEntries: [{
        inputTokens: 1_000,
        outputTokens: 100,
        inputTokensDetails: { cached_tokens: 200, cache_write_tokens: 100 },
      }],
    },
  });

  // Standard cost: 700*5µ + 200*0.5µ + 100*6.25µ + 100*30µ = 7,225µ.
  assert.equal(metered.estimatedCostUsdMicros, 14_450);
  assert.equal(metered.cachedInputTokens, 200);
  assert.equal(metered.cacheWriteInputTokens, 100);
  assert.equal(metered.pricingCompleteness, "request_level");
});

test("applies long-context rates per provider request", () => {
  const metered = meterOpenAIUsage({
    model: "gpt-5.6-luna",
    fastMode: false,
    usage: {
      requests: 2,
      inputTokens: 273_000,
      outputTokens: 2_000,
      totalTokens: 275_000,
      requestUsageEntries: [
        { inputTokens: 272_000, outputTokens: 1_000 },
        { inputTokens: 1_000, outputTokens: 1_000 },
      ],
    },
  });

  // Exactly 272K is standard; the separate 1K request is not long-context.
  assert.equal(metered.estimatedCostUsdMicros, 285_000);
});

test("rejects usage details that cannot reconcile", () => {
  assert.throws(() => meterOpenAIUsage({
    model: "gpt-5.6-terra",
    fastMode: false,
    usage: {
      requests: 1,
      inputTokens: 10,
      outputTokens: 1,
      totalTokens: 11,
      requestUsageEntries: [{ inputTokens: 9, outputTokens: 1 }],
    },
  }), /does not reconcile/);
});

test("model usage preserves the control-plane RPC contract", () => {
  const metering = meterOpenAIUsage({
    model: "gpt-5.6-terra",
    fastMode: false,
    usage: {
      requests: 1,
      inputTokens: 200,
      outputTokens: 50,
      totalTokens: 250,
    },
  });

  assert.deepEqual(toModelUsageRpcPayload(metering), {
    rateCardId: OPENAI_GPT_5_6_RATE_CARD.id,
    model: "gpt-5.6-terra",
    fastMode: false,
    requests: 1,
    inputTokens: 200,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 50,
    estimatedCostUsdMicros: metering.estimatedCostUsdMicros,
    pricingCompleteness: "aggregate_estimate",
  });
});
