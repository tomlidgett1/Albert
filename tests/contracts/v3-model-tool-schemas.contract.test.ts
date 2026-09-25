import assert from "node:assert/strict";
import test from "node:test";

import { zodTextFormat } from "openai/helpers/zod";

import { branchFindingsSchema, branchPlanSchema } from "../../packages/albert-v3/src/engine/deep-lane.ts";
import { finalAnswerSchema } from "../../packages/albert-v3/src/engine/lanes.ts";
import { intentSchema } from "../../packages/albert-v3/src/engine/orchestrator.ts";
import { queryPlanSchema } from "../../packages/albert-v3/src/engine/planned-lane.ts";
import { createV3Tools } from "../../packages/albert-v3/src/engine/tools.ts";
import { XAI_API_BASE_URL } from "../../packages/shared/src/index.ts";

const AU_OPENAI_BASE_URL = "https://au.api.openai.com/v1";

function responsesTools() {
  return createV3Tools().map((tool) => {
    assert.equal(tool.type, "function");
    assert.equal(typeof tool.name, "string");
    assert.equal(tool.strict, true);
    assert.equal(typeof tool.parameters, "object");
    assert.ok(tool.parameters);
    return {
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true,
    };
  });
}

test("v3 tool and output schemas convert for OpenAI/xAI strict structured outputs", () => {
  const tools = responsesTools();
  assert.ok(tools.length >= 10);
  assert.ok(tools.some((tool) => tool.name === "run_shopify_admin_query"));
  assert.ok(tools.some((tool) => tool.name === "run_cube_query"));
  assert.ok(tools.some((tool) => tool.name === "search_semantic_catalogue"));
  assert.ok(tools.some((tool) => tool.name === "get_view_schema"));
  assert.equal(tools.some((tool) => tool.name === "get_semantic_catalogue"), false);

  assert.doesNotThrow(() => zodTextFormat(intentSchema, "intent"));
  assert.doesNotThrow(() => zodTextFormat(finalAnswerSchema, "final_answer"));
  assert.doesNotThrow(() => zodTextFormat(branchPlanSchema, "branch_plan"));
  assert.doesNotThrow(() => zodTextFormat(branchFindingsSchema, "branch_findings"));
  assert.doesNotThrow(() => zodTextFormat(queryPlanSchema, "query_plan"));
});

async function postResponses(input: Readonly<{
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  extra?: Record<string, unknown>;
}>): Promise<void> {
  const tools = responsesTools();
  const formatted = zodTextFormat(finalAnswerSchema, "final_answer");
  const response = await fetch(`${input.baseUrl.replace(/\/+$/u, "")}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      input: "Reply with a one-word greeting. Do not call tools.",
      tools,
      tool_choice: "none",
      reasoning: { effort: "low" },
      text: {
        format: {
          type: formatted.type,
          name: formatted.name,
          strict: formatted.strict,
          schema: formatted.schema,
        },
      },
      ...input.extra,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.text();
  assert.equal(
    response.ok,
    true,
    `${input.label} Responses call failed (HTTP ${response.status}): ${body.slice(0, 800)}`,
  );
  assert.doesNotMatch(body, /optional\(\) without \.nullable/u);
}

const live = process.env.ALBERT_LIVE_MODEL_SMOKE === "1";

test("live OpenAI Luna accepts the v3 tool schemas", { skip: !live }, async () => {
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  assert.ok(apiKey, "OPENAI_API_KEY is missing from the environment.");
  await postResponses({
    label: "OpenAI",
    baseUrl: process.env.OPENAI_BASE_URL?.trim() || AU_OPENAI_BASE_URL,
    apiKey,
    model: "gpt-5.6-luna",
    extra: {
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<albert_prompt_cache_boundary />", prompt_cache_breakpoint: { mode: "explicit" } },
          { type: "input_text", text: "Reply with a one-word greeting. Do not call tools." },
        ],
      }],
      prompt_cache_key: "albert-v3-live-schema-smoke",
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
    },
  });
});

test("live Grok 4.6 accepts the v3 tool schemas", { skip: !live }, async () => {
  const apiKey = process.env.XAI_API_KEY?.trim() ?? "";
  assert.ok(apiKey, "XAI_API_KEY is missing from the environment.");
  await postResponses({
    label: "Grok",
    baseUrl: process.env.XAI_BASE_URL?.trim() || XAI_API_BASE_URL,
    apiKey,
    model: "grok-4.6",
    extra: { store: false },
  });
});
