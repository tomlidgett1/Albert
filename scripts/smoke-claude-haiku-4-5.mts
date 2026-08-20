import { Agent, Runner, tool, user } from "@openai/agents";
import { z } from "zod";

import { createAlbertModelProvider } from "../packages/agent/src/responses-provider.js";
import { finalAnswerSchema } from "../packages/albert-v3/src/engine/lanes.js";
import { loadAgentConfig } from "../packages/albert-v3/src/agent-config/loader.js";
import { classifyIntent } from "../packages/albert-v3/src/engine/orchestrator.js";
import { queryPlanSchema } from "../packages/albert-v3/src/engine/planned-lane.js";
import { createV3Tools } from "../packages/albert-v3/src/engine/tools.js";
import {
  CLAUDE_HAIKU_4_5_MODEL_ID,
  resolveAlbertModelTransport,
} from "../packages/shared/src/index.js";

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for the Haiku smoke test.");

let toolCalls = 0;
const addFixtureNumbers = tool({
  name: "add_fixture_numbers",
  description: "Add two non-sensitive fixture integers. Always call this before answering.",
  parameters: z.object({ left: z.number().int(), right: z.number().int() }),
  execute: async ({ left, right }) => {
    toolCalls += 1;
    return { sum: left + right, source: "deterministic_fixture" };
  },
});

const provider = createAlbertModelProvider(resolveAlbertModelTransport({
  model: CLAUDE_HAIKU_4_5_MODEL_ID,
  anthropicApiKey: apiKey,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
}));
const agent = new Agent({
  name: "Albert Claude Haiku smoke test",
  instructions:
    "Call add_fixture_numbers exactly once with left=3 and right=4. "
    + "Then return the strict JSON result. Never calculate the value yourself.",
  model: CLAUDE_HAIKU_4_5_MODEL_ID,
  modelSettings: {
    reasoning: { effort: "low" },
    toolChoice: "required",
  },
  tools: [addFixtureNumbers],
  outputType: z.object({
    sum: z.number().int(),
    source: z.literal("deterministic_fixture"),
  }),
});
const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
const result = await runner.run(
  agent,
  [user("Use the fixture tool and return its result.")],
  { maxTurns: 4 },
);

if (toolCalls !== 1) throw new Error(`Expected exactly one tool call, received ${toolCalls}.`);
if (result.finalOutput?.sum !== 7 || result.finalOutput.source !== "deterministic_fixture") {
  throw new Error("Claude Haiku returned the wrong structured fixture result.");
}
if (result.runContext.usage.requests < 2 || result.runContext.usage.totalTokens < 1) {
  throw new Error("Claude Haiku smoke usage did not record the complete tool loop.");
}
if (!result.lastResponseId) throw new Error("Claude Haiku smoke did not return a response id.");

// Exercise the exact schema-complexity failure that the full V3 inventory used
// to trigger. Tool choice stays none, so this sends definitions only and never
// touches a connector or tenant data source.
const schemaBudgetAgent = new Agent({
  name: "Albert Claude Haiku V3 schema-budget smoke test",
  instructions:
    "Do not call a tool. Return a strict Unavailable fixture answer with no follow-ups or assumptions.",
  model: CLAUDE_HAIKU_4_5_MODEL_ID,
  modelSettings: {
    reasoning: { effort: "max" },
    toolChoice: "none",
  },
  tools: [...createV3Tools({ lane: "analytical", purpose: "answer", chartable: true })],
  outputType: finalAnswerSchema,
});
const schemaBudgetResult = await runner.run(
  schemaBudgetAgent,
  [user("Return the non-sensitive schema-budget fixture result.")],
  { maxTurns: 2 },
);
if (schemaBudgetResult.finalOutput?.state !== "Unavailable") {
  throw new Error("Claude Haiku did not complete the full V3 schema-budget smoke test.");
}
if (!schemaBudgetResult.lastResponseId) {
  throw new Error("Claude Haiku schema-budget smoke did not return a response id.");
}

// The one-shot planner output consumes Anthropic's entire published union
// allowance even without tools. Probe it independently so hidden grammar-size
// regressions cannot masquerade as tool-inventory failures.
const queryPlanAgent = new Agent({
  name: "Albert Claude Haiku query-plan schema smoke test",
  instructions: `Return exactly one harmless fixture query plan.
Use sales_analytics.net_sales as its only measure. Use null for every nullable field.
The presentation is a fact with no chart and no table.`,
  model: CLAUDE_HAIKU_4_5_MODEL_ID,
  modelSettings: {
    reasoning: { effort: "low" },
    toolChoice: "none",
  },
  outputType: queryPlanSchema,
});
const queryPlanResult = await runner.run(
  queryPlanAgent,
  [user("Return the non-sensitive query-plan schema fixture.")],
  { maxTurns: 2 },
);
if (queryPlanResult.finalOutput?.steps.length !== 1) {
  throw new Error("Claude Haiku did not complete the query-plan schema smoke test.");
}
if (!queryPlanResult.lastResponseId) {
  throw new Error("Claude Haiku query-plan schema smoke did not return a response id.");
}

const classifierStartedAt = Date.now();
const classifierResult = await classifyIntent({
  runner,
  preferences: {
    model: CLAUDE_HAIKU_4_5_MODEL_ID,
    reasoningEffort: "max",
    fastMode: false,
  },
  config: loadAgentConfig(),
  cachePartition: "haiku-smoke",
  conversation: [],
  message: "who's working tomorrow?",
  activeConnectors: ["deputy"],
});
const classifierDurationMs = Date.now() - classifierStartedAt;

process.stdout.write(`${JSON.stringify({
  ok: true,
  model: CLAUDE_HAIKU_4_5_MODEL_ID,
  reasoningLevel: "low",
  toolCalls,
  requests: result.runContext.usage.requests,
  inputTokens: result.runContext.usage.inputTokens,
  outputTokens: result.runContext.usage.outputTokens,
  responseIdRecorded: true,
  schemaBudgetRequests: schemaBudgetResult.runContext.usage.requests,
  schemaBudgetReasoningLevel: "max",
  schemaBudgetResponseIdRecorded: true,
  queryPlanRequests: queryPlanResult.runContext.usage.requests,
  queryPlanResponseIdRecorded: true,
  classifierDurationMs,
  classifierLane: classifierResult.lane,
})}\n`);
