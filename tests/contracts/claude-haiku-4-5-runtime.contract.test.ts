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
  ANTHROPIC_API_BASE_URL,
  CLAUDE_HAIKU_4_5_MODEL_ID,
  HAIKU_MAX_OUTPUT_TOKENS,
  HAIKU_THINKING_BUDGET_TOKENS,
  isAnthropicModel,
  modelSupportsFastMode,
  normalizeAgentPreferences,
  resolveAlbertModelTransport,
  serviceTierForPreferences,
} from "../../packages/shared/src/index.ts";
import {
  AnthropicHaikuModel,
  AnthropicHaikuModelProvider,
  anthropicHaikuRequestForTest,
} from "../../packages/agent/src/anthropic-messages-provider.ts";
import {
  finalAnswerSchema,
  laneModelSettings,
} from "../../packages/albert-v3/src/engine/lanes.ts";
import { createV3Tools } from "../../packages/albert-v3/src/engine/tools.ts";
import { queryPlanSchema } from "../../packages/albert-v3/src/engine/planned-lane.ts";
import { inspectRuntimeEnvironment } from "../../packages/config/src/env.ts";

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
  requestId?: string,
) {
  return {
    messages: {
      stream: (
        body: MessageCreateParamsNonStreaming,
        options?: Readonly<{ signal?: AbortSignal }>,
      ) => ({
        ...(requestId ? { request_id: requestId } : {}),
        finalMessage: async () => handler(body, options),
      }),
    },
  };
}

function strictSchemaComplexity(body: MessageCreateParamsNonStreaming): Readonly<{
  optionalParameters: number;
  strictTools: number;
  unionParameters: number;
}> {
  let optionalParameters = 0;
  let unionParameters = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.anyOf) || Array.isArray(record.type)) {
      unionParameters += 1;
    }
    if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
      const required = new Set(Array.isArray(record.required) ? record.required : []);
      optionalParameters += Object.keys(record.properties as Record<string, unknown>)
        .filter((property) => !required.has(property))
        .length;
    }
    Object.values(record).forEach(visit);
  };
  const outputSchema = body.output_config?.format?.schema;
  if (outputSchema) visit(outputSchema);
  let strictTools = 0;
  for (const tool of body.tools ?? []) {
    if (!("strict" in tool) || tool.strict !== true || !("input_schema" in tool)) continue;
    strictTools += 1;
    visit(tool.input_schema);
  }
  return { optionalParameters, strictTools, unionParameters };
}

test("latest Haiku is allowlisted with app-defined manual thinking levels and no Fast mode", () => {
  assert.equal(CLAUDE_HAIKU_4_5_MODEL_ID, "claude-haiku-4-5-20251001");
  assert.equal(ANTHROPIC_API_BASE_URL, "https://api.anthropic.com");
  assert.equal(isAnthropicModel(CLAUDE_HAIKU_4_5_MODEL_ID), true);
  assert.equal(modelSupportsFastMode(CLAUDE_HAIKU_4_5_MODEL_ID), false);
  assert.equal(serviceTierForPreferences({
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    reasoningEffort: "high",
    fastMode: true,
  }), "default");
  assert.deepEqual(HAIKU_THINKING_BUDGET_TOKENS, {
    none: 0,
    low: 1_024,
    medium: 4_096,
    high: 8_192,
    xhigh: 16_000,
    max: 32_000,
  });
  assert.equal(HAIKU_MAX_OUTPUT_TOKENS.low, 9_216);
  for (const effort of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
    assert.ok(HAIKU_MAX_OUTPUT_TOKENS[effort] > HAIKU_THINKING_BUDGET_TOKENS[effort]);
    const preferences = normalizeAgentPreferences({
      model: CLAUDE_HAIKU_4_5_MODEL_ID,
      reasoningEffort: effort,
      fastMode: true,
    });
    assert.equal(preferences.reasoningEffort, effort);
    assert.equal(preferences.fastMode, false);
  }
});

test("Haiku transport never reuses OpenAI or xAI credentials", () => {
  const transport = resolveAlbertModelTransport({
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    openaiApiKey: "must-not-be-used",
    xaiApiKey: "must-not-be-used",
    anthropicApiKey: "anthropic-test",
  });
  assert.deepEqual(transport, {
    provider: "anthropic",
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    apiKey: "anthropic-test",
    baseUrl: "https://api.anthropic.com",
  });
  assert.throws(
    () => resolveAlbertModelTransport({ model: CLAUDE_HAIKU_4_5_MODEL_ID }),
    /Claude Haiku 4\.5 is not configured/u,
  );
});

test("Haiku wire maps Albert reasoning to budget_tokens and relaxes forced tools", () => {
  const prepared = anthropicHaikuRequestForTest(
    CLAUDE_HAIKU_4_5_MODEL_ID,
    request(),
  );
  assert.deepEqual(prepared.body.thinking, {
    type: "enabled",
    budget_tokens: 8_192,
    display: "omitted",
  });
  assert.equal(prepared.body.max_tokens, 16_384);
  assert.deepEqual(prepared.body.tool_choice, { type: "auto" });
  assert.equal(prepared.body.tools?.[0]?.strict, true);
  assert.equal(prepared.body.service_tier, "standard_only");
  assert.equal("effort" in prepared.body, false);
  assert.equal(prepared.body.output_config, undefined);

  const disabled = anthropicHaikuRequestForTest(
    CLAUDE_HAIKU_4_5_MODEL_ID,
    request({ modelSettings: { reasoning: { effort: "none" }, toolChoice: "required" } }),
  );
  assert.deepEqual(disabled.body.thinking, { type: "disabled" });
  assert.deepEqual(disabled.body.tool_choice, { type: "any" });
});

test("Haiku gets native JSON schema output and no OpenAI-only lane settings", () => {
  const prepared = anthropicHaikuRequestForTest(
    CLAUDE_HAIKU_4_5_MODEL_ID,
    request({
      outputType: {
        type: "json_schema",
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "string", minLength: 4 } },
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
        properties: { answer: { type: "string", description: "{minLength: 4}" } },
        required: ["answer"],
        additionalProperties: false,
      },
    },
  });
  const settings = laneModelSettings(
    normalizeAgentPreferences({
      model: CLAUDE_HAIKU_4_5_MODEL_ID,
      reasoningEffort: "high",
      fastMode: true,
    }),
    "low",
    { toolChoice: "required", promptCacheKey: "bounded" },
  );
  assert.deepEqual(settings.reasoning, { effort: "low" });
  assert.equal(settings.toolChoice, "required");
  assert.equal(settings.store, undefined);
  assert.equal(settings.providerData, undefined);
  assert.deepEqual(settings.promptCacheOptions, { mode: "explicit" });
  const noneSettings = laneModelSettings(
    normalizeAgentPreferences({
      model: CLAUDE_HAIKU_4_5_MODEL_ID,
      reasoningEffort: "none",
      fastMode: false,
    }),
    "high",
  );
  assert.deepEqual(noneSettings.reasoning, { effort: "none" });
  const nonePrepared = anthropicHaikuRequestForTest(
    CLAUDE_HAIKU_4_5_MODEL_ID,
    request({ modelSettings: noneSettings }),
  );
  assert.deepEqual(nonePrepared.body.thinking, { type: "disabled" });
  const maxPreferences = normalizeAgentPreferences({
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    reasoningEffort: "max",
    fastMode: false,
  });
  assert.deepEqual(
    laneModelSettings(maxPreferences, "medium").reasoning,
    { effort: "medium" },
  );
  assert.deepEqual(
    laneModelSettings(maxPreferences, "high").reasoning,
    { effort: "max" },
  );
  assert.deepEqual(
    laneModelSettings(maxPreferences, "high", { maxEffort: "medium" }).reasoning,
    { effort: "low" },
  );
});

test("tool continuation preserves omitted thinking signatures and accounts for cache usage", async () => {
  const firstMessage = {
    id: "msg_haiku_tool",
    type: "message",
    role: "assistant",
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    content: [
      { type: "thinking", thinking: "", signature: "signed-thinking" },
      { type: "tool_use", id: "toolu_1", name: "lookup_metric", input: { metric: "sales" } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 5,
      output_tokens_details: { thinking_tokens: 2 },
      service_tier: "standard",
      server_tool_use: null,
    },
  } as unknown as Message;
  const fakeClient = fakeAnthropicClient(async () => firstMessage);
  const model = new AnthropicHaikuModel(fakeClient, CLAUDE_HAIKU_4_5_MODEL_ID);
  const response = await model.getResponse(request());
  assert.equal(response.usage.inputTokens, 15);
  assert.equal(response.usage.outputTokens, 5);
  assert.deepEqual(response.usage.inputTokensDetails, [{
    cached_tokens: 3,
    cache_write_tokens: 2,
  }]);
  const call = response.output.find((item) => item.type === "function_call");
  assert.ok(call && call.type === "function_call");

  const continuation = anthropicHaikuRequestForTest(
    CLAUDE_HAIKU_4_5_MODEL_ID,
    request({
      input: [
        ...response.output,
        {
          type: "function_call_result",
          name: "lookup_metric",
          callId: call.callId,
          status: "completed",
          output: "42",
        },
      ],
    }),
  );
  assert.equal(continuation.body.messages.length, 2);
  assert.deepEqual(continuation.body.messages[0], {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "signed-thinking" },
      { type: "tool_use", id: "toolu_1", name: "lookup_metric", input: { metric: "sales" } },
    ],
  });
  assert.deepEqual(continuation.body.messages[1], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }],
  });
});

test("Agents Runner completes a native Haiku thinking, tool, and structured-output loop", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const responses: Message[] = [
    {
      id: "msg_runner_tool",
      type: "message",
      role: "assistant",
      model: CLAUDE_HAIKU_4_5_MODEL_ID,
      content: [
        { type: "thinking", thinking: "", signature: "runner-signature" },
        {
          type: "tool_use",
          id: "toolu_runner",
          name: "lookup_metric",
          input: { metric: "sales" },
          caller: { type: "direct" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as unknown as Message,
    {
      id: "msg_runner_final",
      type: "message",
      role: "assistant",
      model: CLAUDE_HAIKU_4_5_MODEL_ID,
      content: [{ type: "text", text: '{"answer":"Sales are grounded.","value":42}' }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 8 },
    } as unknown as Message,
  ];
  const fakeClient = fakeAnthropicClient(async (body) => {
    bodies.push(structuredClone(body) as unknown as Record<string, unknown>);
    const response = responses.shift();
    assert.ok(response, "unexpected extra Haiku request");
    return response;
  });
  const provider = new AnthropicHaikuModelProvider(
    fakeClient,
    CLAUDE_HAIKU_4_5_MODEL_ID,
  );
  const lookup = tool({
    name: "lookup_metric",
    description: "Return one governed fixture metric.",
    parameters: z.object({ metric: z.string() }),
    execute: async () => ({ value: 42 }),
  });
  const agent = new Agent({
    name: "Haiku contract agent",
    instructions: "Call the tool, then return the strict result.",
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    modelSettings: { reasoning: { effort: "medium" }, toolChoice: "required" },
    tools: [lookup],
    outputType: z.object({ answer: z.string(), value: z.number() }),
  });
  const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
  const result = await runner.run(agent, [user("Look up sales.")], { maxTurns: 4 });

  assert.deepEqual(result.finalOutput, { answer: "Sales are grounded.", value: 42 });
  assert.equal(result.lastResponseId, "msg_runner_final");
  assert.equal(result.runContext.usage.requests, 2);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0]?.thinking, {
    type: "enabled",
    budget_tokens: 4_096,
    display: "omitted",
  });
  assert.deepEqual(bodies[0]?.tool_choice, { type: "auto" });
  const continuation = bodies[1]?.messages as Array<{ role: string; content: unknown[] }>;
  assert.deepEqual(continuation[1], {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "runner-signature" },
      {
        type: "tool_use",
        id: "toolu_runner",
        name: "lookup_metric",
        input: { metric: "sales" },
        caller: { type: "direct" },
      },
    ],
  });
  assert.equal(continuation[2]?.role, "user");
  assert.equal((continuation[2]?.content[0] as { type?: string }).type, "tool_result");
});

test("full V3 tool inventory stays within Anthropic's combined strict-schema limits", async () => {
  const bodies: MessageCreateParamsNonStreaming[] = [];
  const fakeClient = fakeAnthropicClient(async (body) => {
    bodies.push(structuredClone(body));
    return {
      id: "msg_v3_schema_budget",
      type: "message",
      role: "assistant",
      model: CLAUDE_HAIKU_4_5_MODEL_ID,
      content: [{
        type: "text",
        text: JSON.stringify({
          answer: "The provider-facing schema fits its compilation budget.",
          state: "Unavailable",
          followUps: [],
          assumptionsDisclosed: [],
        }),
      }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    } as unknown as Message;
  });
  const provider = new AnthropicHaikuModelProvider(fakeClient, CLAUDE_HAIKU_4_5_MODEL_ID);
  const agent = new Agent({
    name: "Albert V3 schema budget contract",
    instructions: "Return the strict final result without calling a tool.",
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    modelSettings: { reasoning: { effort: "none" }, toolChoice: "auto" },
    tools: [...createV3Tools({ lane: "analytical", purpose: "answer", chartable: true })],
    outputType: finalAnswerSchema,
  });
  const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
  const result = await runner.run(agent, [user("Return the fixture result.")], { maxTurns: 2 });
  assert.equal(result.finalOutput?.state, "Unavailable");
  assert.equal(bodies.length, 1);
  const body = bodies[0]!;
  const complexity = strictSchemaComplexity(body);
  assert.ok((body.tools?.length ?? 0) > 0);
  assert.equal(complexity.strictTools, 0);
  assert.ok(complexity.optionalParameters <= 24);
  assert.ok(complexity.unionParameters <= 16);
});

test("query-plan output removes nullable grammar unions and restores required nulls", async () => {
  const bodies: MessageCreateParamsNonStreaming[] = [];
  const provider = new AnthropicHaikuModelProvider(fakeAnthropicClient(async (body) => {
    bodies.push(structuredClone(body));
    return {
      id: "msg_query_plan_simplified",
      type: "message",
      role: "assistant",
      model: CLAUDE_HAIKU_4_5_MODEL_ID,
      content: [{
        type: "text",
        text: JSON.stringify({
          plan: "Run one harmless fixture query.",
          steps: [{
            topic: "Fixture sales lookup",
            measures: ["sales_analytics.net_sales"],
          }],
          presentation: {
            shape: "fact",
            table: false,
          },
        }),
      }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    } as unknown as Message;
  }), CLAUDE_HAIKU_4_5_MODEL_ID);
  const agent = new Agent({
    name: "Albert query-plan nullable schema contract",
    instructions: "Return the fixture query plan.",
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    modelSettings: { reasoning: { effort: "none" }, toolChoice: "none" },
    outputType: queryPlanSchema,
  });
  const result = await new Runner({ modelProvider: provider, tracingDisabled: true })
    .run(agent, [user("Return the fixture query plan.")], { maxTurns: 2 });
  assert.equal(result.finalOutput?.steps[0]?.bind, null);
  assert.equal(result.finalOutput?.presentation.chart, null);
  const complexity = strictSchemaComplexity(bodies[0]!);
  assert.equal(complexity.unionParameters, 0);
  assert.ok(complexity.optionalParameters <= 24);
});

test("host validation rejects non-strict Haiku tool input before execution", async () => {
  let executions = 0;
  const invalidToolMessage = {
    id: "msg_invalid_non_strict_tool",
    type: "message",
    role: "assistant",
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    content: [{
      type: "tool_use",
      id: "toolu_invalid_non_strict",
      name: "lookup_metric",
      input: { metric: 42 },
      caller: { type: "direct" },
    }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 2 },
  } as unknown as Message;
  const provider = new AnthropicHaikuModelProvider(
    fakeAnthropicClient(async () => invalidToolMessage),
    CLAUDE_HAIKU_4_5_MODEL_ID,
  );
  const lookup = tool({
    name: "lookup_metric",
    description: "Return one governed fixture metric.",
    parameters: z.object({ metric: z.string() }),
    execute: async () => {
      executions += 1;
      return { value: 42 };
    },
  });
  const agent = new Agent({
    name: "Albert non-strict host validation contract",
    instructions: "Call the tool, then return the strict result.",
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    modelSettings: { reasoning: { effort: "low" }, toolChoice: "required" },
    tools: [lookup],
    outputType: z.object({ answer: z.string() }),
  });
  await assert.rejects(
    new Runner({ modelProvider: provider, tracingDisabled: true })
      .run(agent, [user("Call the fixture tool.")], { maxTurns: 2 }),
    /max turns|invalid|tool|input/iu,
  );
  assert.equal(executions, 0);
});

test("redacted thinking and tool caller metadata replay without mutation", async () => {
  const message = {
    id: "msg_redacted",
    type: "message",
    role: "assistant",
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    content: [
      { type: "redacted_thinking", data: "opaque-redacted-state" },
      {
        type: "tool_use",
        id: "toolu_redacted",
        name: "lookup_metric",
        input: { metric: "margin" },
        caller: { type: "direct" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 2 },
  } as unknown as Message;
  const model = new AnthropicHaikuModel(
    fakeAnthropicClient(async () => message),
    CLAUDE_HAIKU_4_5_MODEL_ID,
  );
  const response = await model.getResponse(request());
  const call = response.output.find((item) => item.type === "function_call");
  assert.ok(call && call.type === "function_call");
  const replay = anthropicHaikuRequestForTest(CLAUDE_HAIKU_4_5_MODEL_ID, request({
    input: [
      ...response.output,
      {
        type: "function_call_result",
        name: call.name,
        callId: call.callId,
        status: "completed",
        output: "ok",
      },
    ],
  }));
  assert.deepEqual(replay.body.messages[0], {
    role: "assistant",
    content: message.content,
  });
});

test("parallel Haiku tool calls replay one assistant turn and all tool results", async () => {
  const message = {
    id: "msg_parallel",
    type: "message",
    role: "assistant",
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    content: [
      { type: "thinking", thinking: "", signature: "parallel-signature" },
      { type: "tool_use", id: "toolu_a", name: "lookup_metric", input: { metric: "sales" } },
      { type: "tool_use", id: "toolu_b", name: "lookup_metric", input: { metric: "margin" } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 2 },
  } as unknown as Message;
  const model = new AnthropicHaikuModel(
    fakeAnthropicClient(async () => message),
    CLAUDE_HAIKU_4_5_MODEL_ID,
  );
  const response = await model.getResponse(request());
  const calls = response.output.filter((item) => item.type === "function_call");
  assert.equal(calls.length, 2);
  const replay = anthropicHaikuRequestForTest(CLAUDE_HAIKU_4_5_MODEL_ID, request({
    input: [
      ...response.output,
      ...calls.map((call) => ({
        type: "function_call_result" as const,
        name: call.name,
        callId: call.callId,
        status: "completed" as const,
        output: call.callId === "toolu_a" ? "100" : "40",
      })),
    ],
  }));
  assert.equal(replay.body.messages.length, 2);
  assert.deepEqual(replay.body.messages[0], { role: "assistant", content: message.content });
  assert.equal(Array.isArray(replay.body.messages[1]?.content)
    ? replay.body.messages[1].content.length
    : 0, 2);
});

test("Haiku forwards the run abort signal to the native SDK", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled", "AbortError"));
  let receivedSignal: AbortSignal | undefined;
  const model = new AnthropicHaikuModel(
    fakeAnthropicClient(async (_body, options) => {
      receivedSignal = options?.signal;
      receivedSignal?.throwIfAborted();
      throw new Error("the aborted request must not continue");
    }),
    CLAUDE_HAIKU_4_5_MODEL_ID,
  );
  await assert.rejects(
    model.getResponse(request({ signal: controller.signal })),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(receivedSignal, controller.signal);
});

test("Haiku Max uses the streaming accumulator and preserves its request id", async () => {
  let streamedBody: MessageCreateParamsNonStreaming | undefined;
  const message = {
    id: "msg_streamed_max",
    type: "message",
    role: "assistant",
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    content: [{ type: "text", text: "complete" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 2 },
  } as unknown as Message;
  const model = new AnthropicHaikuModel(
    fakeAnthropicClient(async (body) => {
      streamedBody = body;
      return message;
    }, "req_streamed_max"),
    CLAUDE_HAIKU_4_5_MODEL_ID,
  );
  const response = await model.getResponse(request({
    tools: [],
    modelSettings: { reasoning: { effort: "max" }, toolChoice: "none" },
  }));
  assert.equal(streamedBody?.max_tokens, 40_192);
  assert.equal(response.requestId, "req_streamed_max");
});

test("Haiku fails closed on truncated or refused provider responses", async () => {
  for (const stopReason of ["max_tokens", "model_context_window_exceeded", "refusal"] as const) {
    const fakeClient = fakeAnthropicClient(async () => ({
      id: `msg_${stopReason}`,
      type: "message",
      role: "assistant",
      model: CLAUDE_HAIKU_4_5_MODEL_ID,
      content: [{ type: "text", text: "partial" }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Message));
    const model = new AnthropicHaikuModel(fakeClient, CLAUDE_HAIKU_4_5_MODEL_ID);
    await assert.rejects(
      model.getResponse(request()),
      new RegExp(`stopped without a complete Albert response \\(${stopReason}\\)`, "u"),
    );
  }
});

test("selector, V3 route and persistence remain wired to the pinned model", () => {
  const controls = readFileSync("app/dash/components/ModelRunControls.tsx", "utf8");
  const dash = readFileSync("app/dash/page.tsx", "utf8");
  const route = readFileSync("app/api/v3-conversation/route.ts", "utf8");
  const orchestrator = readFileSync("packages/albert-v3/src/engine/orchestrator.ts", "utf8");
  const migration = readFileSync(
    "infra/migrations/control-plane/0156_m6_claude_haiku_4_5_model_allowlist.sql",
    "utf8",
  );
  assert.match(controls, /CLAUDE_HAIKU_4_5_MODEL_ID/u);
  assert.match(controls, /Haiku starts at Low/u);
  assert.match(controls, /switchingToHaiku[\s\S]{0,180}reasoningEffort: "low"/u);
  assert.match(dash, /isAnthropicModel\(runPreferences\.model\)[\s\S]{0,80}\? "v3"/u);
  assert.match(route, /ANTHROPIC_API_KEY/u);
  assert.match(route, /ALBERT_ANTHROPIC_ZDR_APPROVED/u);
  assert.match(
    orchestrator,
    /isAnthropicModel\(input\.preferences\.model\)[\s\S]{0,120}reasoningEffort: "none"/u,
  );
  assert.match(migration, /'claude-haiku-4-5-20251001'/u);
  assert.match(migration, /public\.albert_record_turn_usage/u);
  assert.match(migration, /NOTIFY pgrst, 'reload schema'/u);
});

test("production web admits Haiku credentials only with explicit APP 8 and ZDR approval", () => {
  const unsafe = inspectRuntimeEnvironment("web", {
    NODE_ENV: "production",
    ANTHROPIC_API_KEY: "test-only",
  });
  assert.ok(unsafe.invalid.includes("ALBERT_ANTHROPIC_APP8_APPROVED"));
  assert.ok(unsafe.invalid.includes("ALBERT_ANTHROPIC_ZDR_APPROVED"));

  const approved = inspectRuntimeEnvironment("web", {
    NODE_ENV: "production",
    ANTHROPIC_API_KEY: "test-only",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ALBERT_ANTHROPIC_APP8_APPROVED: "true",
    ALBERT_ANTHROPIC_ZDR_APPROVED: "true",
  });
  assert.equal(approved.invalid.includes("ANTHROPIC_API_KEY"), false);
  assert.equal(approved.invalid.includes("ANTHROPIC_BASE_URL"), false);
  assert.equal(approved.invalid.includes("ALBERT_ANTHROPIC_APP8_APPROVED"), false);
  assert.equal(approved.invalid.includes("ALBERT_ANTHROPIC_ZDR_APPROVED"), false);
});
