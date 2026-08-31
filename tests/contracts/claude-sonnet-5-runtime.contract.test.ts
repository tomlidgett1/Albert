import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  Message,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages";
import { Agent, Runner, tool, user, type ModelRequest } from "@openai/agents";
import { z } from "zod";

import {
  ANTHROPIC_ADAPTIVE_DEFAULT_MAX_OUTPUT_TOKENS,
  CLAUDE_HAIKU_4_5_MODEL_ID,
  CLAUDE_SONNET_5_MODEL_ID,
  anthropicMaxOutputTokens,
  anthropicUsesAdaptiveThinking,
  isAnthropicModel,
  modelSupportsFastMode,
  normalizeAgentPreferences,
  reasoningEffortsForModel,
  resolveAlbertModelTransport,
  serviceTierForPreferences,
} from "../../packages/shared/src/index.ts";
import {
  AnthropicMessagesModelProvider,
  anthropicMessagesRequestForTest,
} from "../../packages/agent/src/anthropic-messages-provider.ts";
import { ALBERT_OMNI_MODEL_IDS } from "../../packages/albert-omni/src/contracts.ts";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    input: [user("Use the governed tool, then answer.")],
    modelSettings: {
      reasoning: { effort: "high" },
      toolChoice: "required",
    },
    tools: [{
      type: "function",
      name: "lookup_metric",
      description: "Look up one governed metric.",
      parameters: {
        type: "object",
        properties: { metric: { type: "string" } },
        required: ["metric"],
        additionalProperties: false,
      },
      strict: true,
    }],
    outputType: "text",
    handoffs: [],
    tracing: false,
    ...overrides,
  };
}

function fakeAnthropicClient(
  handler: (
    body: MessageCreateParamsNonStreaming,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Message | Promise<Message>,
) {
  return {
    messages: {
      stream: (
        body: MessageCreateParamsNonStreaming,
        options?: Readonly<{ signal?: AbortSignal }>,
      ) => ({
        finalMessage: async () => handler(body, options),
      }),
    },
  };
}

test("Sonnet 5 is allowlisted as an adaptive-thinking Anthropic model without Fast mode", () => {
  assert.equal(CLAUDE_SONNET_5_MODEL_ID, "claude-sonnet-5");
  assert.equal(isAnthropicModel(CLAUDE_SONNET_5_MODEL_ID), true);
  assert.equal(anthropicUsesAdaptiveThinking(CLAUDE_SONNET_5_MODEL_ID), true);
  assert.equal(anthropicUsesAdaptiveThinking(CLAUDE_HAIKU_4_5_MODEL_ID), false);
  assert.equal(anthropicMaxOutputTokens(CLAUDE_SONNET_5_MODEL_ID), 128_000);
  assert.equal(anthropicMaxOutputTokens(CLAUDE_HAIKU_4_5_MODEL_ID), 64_000);
  assert.equal(modelSupportsFastMode(CLAUDE_SONNET_5_MODEL_ID), false);
  assert.equal(serviceTierForPreferences({
    model: CLAUDE_SONNET_5_MODEL_ID,
    reasoningEffort: "high",
    fastMode: true,
  }), "default");
  assert.deepEqual(reasoningEffortsForModel(CLAUDE_SONNET_5_MODEL_ID), [
    "none", "low", "medium", "high", "xhigh", "max",
  ]);
  for (const effort of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
    const preferences = normalizeAgentPreferences({
      model: CLAUDE_SONNET_5_MODEL_ID,
      reasoningEffort: effort,
      fastMode: true,
    });
    assert.equal(preferences.reasoningEffort, effort, "no effort is clamped away");
    assert.equal(preferences.fastMode, false);
  }
});

test("Sonnet 5 transport requires its own Anthropic credentials", () => {
  const transport = resolveAlbertModelTransport({
    model: CLAUDE_SONNET_5_MODEL_ID,
    openaiApiKey: "must-not-be-used",
    anthropicApiKey: "anthropic-test",
  });
  assert.deepEqual(transport, {
    provider: "anthropic",
    model: CLAUDE_SONNET_5_MODEL_ID,
    apiKey: "anthropic-test",
    baseUrl: "https://api.anthropic.com",
  });
  assert.throws(
    () => resolveAlbertModelTransport({ model: CLAUDE_SONNET_5_MODEL_ID }),
    /Claude Sonnet 5 is not configured/u,
  );
});

test("Sonnet 5 wire uses adaptive thinking plus output_config.effort at every level", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    const prepared = anthropicMessagesRequestForTest(
      CLAUDE_SONNET_5_MODEL_ID,
      request({ modelSettings: { reasoning: { effort }, toolChoice: "required" } }),
    );
    assert.deepEqual(prepared.body.thinking, { type: "adaptive", display: "omitted" }, effort);
    assert.deepEqual(prepared.body.output_config, { effort }, effort);
    assert.equal(prepared.body.max_tokens, ANTHROPIC_ADAPTIVE_DEFAULT_MAX_OUTPUT_TOKENS, effort);
    // budget_tokens is rejected outright on the 4.6+ family; it must not
    // appear anywhere in the serialized request.
    assert.equal(JSON.stringify(prepared.body).includes("budget_tokens"), false, effort);
    // Forced tool choice is incompatible with active thinking; it relaxes.
    assert.deepEqual(prepared.body.tool_choice, { type: "auto" }, effort);
    assert.equal(prepared.body.service_tier, "standard_only", effort);
  }
});

test("Sonnet 5 effort none disables thinking and restores forced tool choice", () => {
  const prepared = anthropicMessagesRequestForTest(
    CLAUDE_SONNET_5_MODEL_ID,
    request({ modelSettings: { reasoning: { effort: "none" }, toolChoice: "required" } }),
  );
  assert.deepEqual(prepared.body.thinking, { type: "disabled" });
  assert.equal(prepared.body.output_config, undefined, "none is not a provider effort value");
  assert.deepEqual(prepared.body.tool_choice, { type: "any" });
});

test("Sonnet 5 honours configured output allowances up to its 128k ceiling", () => {
  const configured = anthropicMessagesRequestForTest(
    CLAUDE_SONNET_5_MODEL_ID,
    request({ modelSettings: { reasoning: { effort: "max" }, maxTokens: 128_000 } }),
  );
  assert.equal(configured.body.max_tokens, 128_000);
  assert.throws(
    () => anthropicMessagesRequestForTest(
      CLAUDE_SONNET_5_MODEL_ID,
      request({ modelSettings: { reasoning: { effort: "max" }, maxTokens: 128_001 } }),
    ),
    /at most 128000/u,
  );
  // Haiku keeps its own smaller provider ceiling.
  assert.throws(
    () => anthropicMessagesRequestForTest(
      CLAUDE_HAIKU_4_5_MODEL_ID,
      request({ modelSettings: { reasoning: { effort: "max" }, maxTokens: 128_000 } }),
    ),
    /at most 64000/u,
  );
});

test("Sonnet 5 merges structured output and effort into one output_config", () => {
  const prepared = anthropicMessagesRequestForTest(
    CLAUDE_SONNET_5_MODEL_ID,
    request({
      modelSettings: { reasoning: { effort: "xhigh" } },
      outputType: {
        type: "json_schema",
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    }),
  );
  assert.deepEqual(prepared.body.output_config, {
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    },
    effort: "xhigh",
  });
});

test("Agents Runner completes a native Sonnet 5 adaptive thinking and tool loop", async () => {
  const bodies: MessageCreateParamsNonStreaming[] = [];
  const responses: Message[] = [
    {
      id: "msg_sonnet_tool",
      type: "message",
      role: "assistant",
      model: CLAUDE_SONNET_5_MODEL_ID,
      content: [
        { type: "thinking", thinking: "", signature: "sonnet-signature" },
        { type: "tool_use", id: "toolu_sonnet", name: "lookup_metric", input: { metric: "sales" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as Message,
    {
      id: "msg_sonnet_final",
      type: "message",
      role: "assistant",
      model: CLAUDE_SONNET_5_MODEL_ID,
      content: [{ type: "text", text: '{"answer":"Sales are grounded.","value":42}' }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 8 },
    } as unknown as Message,
  ];
  const fakeClient = fakeAnthropicClient(async (body) => {
    bodies.push(structuredClone(body));
    const response = responses.shift();
    assert.ok(response, "unexpected extra Sonnet request");
    return response;
  });
  const provider = new AnthropicMessagesModelProvider(fakeClient, CLAUDE_SONNET_5_MODEL_ID);
  const lookup = tool({
    name: "lookup_metric",
    description: "Return one governed fixture metric.",
    parameters: z.object({ metric: z.string() }),
    execute: async () => ({ value: 42 }),
  });
  const agent = new Agent({
    name: "Sonnet contract agent",
    instructions: "Call the tool, then return the strict result.",
    model: CLAUDE_SONNET_5_MODEL_ID,
    modelSettings: { reasoning: { effort: "xhigh" }, toolChoice: "required" },
    tools: [lookup],
    outputType: z.object({ answer: z.string(), value: z.number() }),
  });
  const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
  const result = await runner.run(agent, [user("Look up sales.")], { maxTurns: 4 });

  assert.deepEqual(result.finalOutput, { answer: "Sales are grounded.", value: 42 });
  assert.equal(result.lastResponseId, "msg_sonnet_final");
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.deepEqual(body.thinking, { type: "adaptive", display: "omitted" });
    assert.equal(body.output_config?.effort, "xhigh");
    assert.equal(JSON.stringify(body).includes("budget_tokens"), false);
  }
  const continuation = bodies[1]?.messages as Array<{ role: string; content: unknown[] }>;
  assert.deepEqual(continuation[1], {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "sonnet-signature" },
      { type: "tool_use", id: "toolu_sonnet", name: "lookup_metric", input: { metric: "sales" } },
    ],
  });
  assert.equal(continuation[2]?.role, "user");
  assert.equal((continuation[2]?.content[0] as { type?: string }).type, "tool_result");
});

test("Omni admits Sonnet 5 and the usage ledger already allowlists it", () => {
  assert.ok((ALBERT_OMNI_MODEL_IDS as readonly string[]).includes(CLAUDE_SONNET_5_MODEL_ID));
  // Migration 0166 carries the current provider-neutral usage-ledger CHECK;
  // Sonnet 5 was provisioned there ahead of runtime adoption.
  const migration = readFileSync(
    "infra/migrations/control-plane/0166_m6_gemini_3_7_flash_model_allowlist.sql",
    "utf8",
  );
  assert.match(migration, /'claude-sonnet-5'/u);
});
