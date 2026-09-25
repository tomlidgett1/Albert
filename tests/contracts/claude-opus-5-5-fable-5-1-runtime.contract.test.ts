import assert from "node:assert/strict";
import test from "node:test";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages";
import { user, type ModelRequest } from "@openai/agents";

import {
  ANTHROPIC_FAST_MODE_BETA,
  CLAUDE_FABLE_5_1_MODEL_ID,
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_SONNET_5_MODEL_ID,
  anthropicMaxOutputTokens,
  anthropicModelRequiresRetention,
  anthropicRequiresThinking,
  anthropicUsesAdaptiveThinking,
  isAnthropicModel,
  modelSupportsFastMode,
  resolveAlbertModelTransport,
  serviceTierForPreferences,
} from "../../packages/shared/src/index.ts";
import {
  AnthropicMessagesModelProvider,
  anthropicMessagesRequestForTest,
} from "../../packages/agent/src/anthropic-messages-provider.ts";
import { meterOpenAIUsage } from "../../packages/usage-metering/src/index.ts";

/**
 * Claude Opus 5.5, Claude Fable 5.1 and Anthropic fast mode (ADR 0147). The
 * wire facts were verified against the live Messages API on 2026-09-23: both
 * models 400 on disabled thinking, `speed` 400s without the fast-mode beta,
 * Sonnet 5 400s on `speed`, and an account without fast-mode access gets a
 * 429 ("rate limit of 0 fast mode input tokens per minute").
 */

type StreamOptions = Readonly<{ signal?: AbortSignal; headers?: Readonly<Record<string, string>>; maxRetries?: number }>;

function request(settings: Partial<ModelRequest["modelSettings"]> = {}): ModelRequest {
  return {
    input: [user("Answer in one word.")],
    modelSettings: { reasoning: { effort: "high" }, ...settings },
    tools: [],
    outputType: "text",
    handoffs: [],
    tracing: false,
  };
}

function reply(model: string, speed?: "fast" | "standard"): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 3, ...(speed ? { speed } : {}) },
  } as unknown as Message;
}

function recordingClient(respond: (body: MessageCreateParamsNonStreaming & { speed?: string }, options?: StreamOptions) => Message) {
  const calls: { body: MessageCreateParamsNonStreaming & { speed?: string }; options?: StreamOptions }[] = [];
  return {
    calls,
    client: {
      messages: {
        stream: (body: MessageCreateParamsNonStreaming, options?: StreamOptions) => ({
          finalMessage: async () => {
            const sent = structuredClone(body) as MessageCreateParamsNonStreaming & { speed?: string };
            calls.push({ body: sent, ...(options ? { options } : {}) });
            return respond(sent, options);
          },
        }),
      },
    },
  };
}

test("Opus 5.5 and Fable 5.1 are adaptive Claude models whose thinking always runs; only Opus has Fast", () => {
  for (const model of [CLAUDE_OPUS_5_5_MODEL_ID, CLAUDE_FABLE_5_1_MODEL_ID]) {
    assert.equal(isAnthropicModel(model), true);
    assert.equal(anthropicUsesAdaptiveThinking(model), true);
    assert.equal(anthropicRequiresThinking(model), true);
    assert.equal(anthropicMaxOutputTokens(model), 128_000);
  }
  assert.equal(anthropicRequiresThinking(CLAUDE_SONNET_5_MODEL_ID), false);
  assert.equal(modelSupportsFastMode(CLAUDE_OPUS_5_5_MODEL_ID), true);
  assert.equal(modelSupportsFastMode(CLAUDE_FABLE_5_1_MODEL_ID), false);
  assert.equal(modelSupportsFastMode(CLAUDE_SONNET_5_MODEL_ID), false);
  assert.equal(serviceTierForPreferences({ model: CLAUDE_OPUS_5_5_MODEL_ID, reasoningEffort: "high", fastMode: true }), "fast");
  assert.equal(serviceTierForPreferences({ model: CLAUDE_FABLE_5_1_MODEL_ID, reasoningEffort: "high", fastMode: true }), "default");
  assert.equal(anthropicModelRequiresRetention(CLAUDE_FABLE_5_1_MODEL_ID), true);
  assert.equal(anthropicModelRequiresRetention(CLAUDE_OPUS_5_5_MODEL_ID), false);
});

test("Effort none never disables thinking on Opus 5.5 or Fable 5.1: it runs as low", () => {
  for (const model of [CLAUDE_OPUS_5_5_MODEL_ID, CLAUDE_FABLE_5_1_MODEL_ID]) {
    const { body, effort } = anthropicMessagesRequestForTest(model, request({ reasoning: { effort: "none" } }));
    assert.equal(effort, "low");
    assert.deepEqual(body.thinking, { type: "adaptive", display: "omitted" });
    assert.equal(body.output_config?.effort, "low");
  }
  // Sonnet 5 can still switch thinking off.
  const sonnet = anthropicMessagesRequestForTest(CLAUDE_SONNET_5_MODEL_ID, request({ reasoning: { effort: "none" } }));
  assert.deepEqual(sonnet.body.thinking, { type: "disabled" });
});

test("Albert Fast on Opus 5.5 sends speed fast with the beta header and no SDK retries", async () => {
  const { client, calls } = recordingClient((body) => reply(CLAUDE_OPUS_5_5_MODEL_ID, body.speed === "fast" ? "fast" : "standard"));
  const model = new AnthropicMessagesModelProvider(client, CLAUDE_OPUS_5_5_MODEL_ID).getModel();
  const response = await model.getResponse(request({ providerData: { service_tier: "fast" } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.speed, "fast");
  assert.equal(calls[0]!.options?.headers?.["anthropic-beta"], ANTHROPIC_FAST_MODE_BETA);
  assert.equal(calls[0]!.options?.maxRetries, 0);
  assert.equal(response.providerData?.speed, "fast");
  assert.equal(response.providerData?.fast_fallback, undefined);

  // Without Albert Fast the same model sends no speed and no beta header.
  const standard = recordingClient(() => reply(CLAUDE_OPUS_5_5_MODEL_ID, "standard"));
  await new AnthropicMessagesModelProvider(standard.client, CLAUDE_OPUS_5_5_MODEL_ID).getModel().getResponse(request({ providerData: { service_tier: "default" } }));
  assert.equal(standard.calls[0]!.body.speed, undefined);
  assert.equal(standard.calls[0]!.options?.headers, undefined);
});

test("A fast-mode 429 falls back to standard speed at once, for the rest of the turn", async () => {
  const { client, calls } = recordingClient((body) => {
    if (body.speed === "fast") throw Object.assign(new Error("This request would exceed your rate limit of 0 fast mode input tokens per minute"), { status: 429 });
    return reply(CLAUDE_OPUS_5_5_MODEL_ID, "standard");
  });
  const model = new AnthropicMessagesModelProvider(client, CLAUDE_OPUS_5_5_MODEL_ID).getModel();
  const first = await model.getResponse(request({ providerData: { service_tier: "fast" } }));
  assert.deepEqual(calls.map((call) => call.body.speed ?? "standard"), ["fast", "standard"]);
  assert.equal(calls[1]!.options?.headers, undefined);
  assert.equal(first.providerData?.speed, "standard");
  assert.equal(first.providerData?.fast_fallback, true);
  // The next step of the same turn goes straight to standard speed.
  await model.getResponse(request({ providerData: { service_tier: "fast" } }));
  assert.deepEqual(calls.map((call) => call.body.speed ?? "standard"), ["fast", "standard", "standard"]);

  // Any other failure of a fast request is not swallowed.
  const failing = recordingClient(() => { throw Object.assign(new Error("overloaded"), { status: 529 }); });
  await assert.rejects(
    new AnthropicMessagesModelProvider(failing.client, CLAUDE_OPUS_5_5_MODEL_ID).getModel().getResponse(request({ providerData: { service_tier: "fast" } })),
    /overloaded/u,
  );
});

test("Models without fast mode never send speed, whatever the tier says", async () => {
  for (const modelId of [CLAUDE_SONNET_5_MODEL_ID, CLAUDE_FABLE_5_1_MODEL_ID]) {
    const { client, calls } = recordingClient(() => reply(modelId));
    await new AnthropicMessagesModelProvider(client, modelId).getModel().getResponse(request({ providerData: { service_tier: "fast" } }));
    assert.equal(calls[0]!.body.speed, undefined, modelId);
    assert.equal(calls[0]!.options?.headers, undefined, modelId);
  }
});

test("Fable 5.1 runs only with the retention approval; Opus 5.5 needs only the Claude credentials", () => {
  assert.throws(
    () => resolveAlbertModelTransport({ model: CLAUDE_FABLE_5_1_MODEL_ID, anthropicApiKey: "sk-ant-test" }),
    /Claude Fable 5\.1 is not approved/u,
  );
  assert.equal(resolveAlbertModelTransport({ model: CLAUDE_FABLE_5_1_MODEL_ID, anthropicApiKey: "sk-ant-test", anthropicRetentionApproved: true }).model, CLAUDE_FABLE_5_1_MODEL_ID);
  assert.equal(resolveAlbertModelTransport({ model: CLAUDE_OPUS_5_5_MODEL_ID, anthropicApiKey: "sk-ant-test" }).provider, "anthropic");
  assert.throws(() => resolveAlbertModelTransport({ model: CLAUDE_OPUS_5_5_MODEL_ID }), /not configured/u);
});

test("Claude 5 rates: Opus 5.5 Fast doubles; Sonnet 5 and Fable 5.1 never price as Fast", () => {
  const million = { requests: 1, inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };
  const opus = meterOpenAIUsage({ model: CLAUDE_OPUS_5_5_MODEL_ID, fastMode: false, usage: million });
  assert.equal(opus.estimatedCostUsdMicros, 24_000_000);
  assert.equal(opus.rateCardId, "anthropic-claude-5-2026-09-23");
  const opusFast = meterOpenAIUsage({ model: CLAUDE_OPUS_5_5_MODEL_ID, fastMode: true, usage: million });
  assert.equal(opusFast.estimatedCostUsdMicros, 48_000_000);
  assert.equal(opusFast.fastMode, true);
  const fable = meterOpenAIUsage({ model: CLAUDE_FABLE_5_1_MODEL_ID, fastMode: true, usage: million });
  assert.equal(fable.estimatedCostUsdMicros, 60_000_000);
  assert.equal(fable.fastMode, false);
  assert.equal(meterOpenAIUsage({ model: CLAUDE_SONNET_5_MODEL_ID, fastMode: false, usage: million }).estimatedCostUsdMicros, 12_000_000);
});
