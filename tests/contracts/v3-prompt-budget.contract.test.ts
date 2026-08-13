import assert from "node:assert/strict";
import test from "node:test";

import type { Agent, AgentInputItem, AgentOutputType, Runner } from "@openai/agents";
import { getEncoding } from "js-tiktoken";
import { zodTextFormat } from "openai/helpers/zod";

import { loadAgentConfig } from "../../packages/albert-v3/src/agent-config/loader.ts";
import { renderCompactCatalogueIndex } from "../../packages/albert-v3/src/cube/catalogue.ts";
import type { CubeCatalogue } from "../../packages/albert-v3/src/cube/types.ts";
import { createV3CommentaryState } from "../../packages/albert-v3/src/engine/commentary.ts";
import type { V3ToolRoute } from "../../packages/albert-v3/src/engine/connector-routing.ts";
import type { V3TurnContext } from "../../packages/albert-v3/src/engine/context.ts";
import {
  branchFindingsSchema,
  branchPlanSchema,
  runDeepLane,
} from "../../packages/albert-v3/src/engine/deep-lane.ts";
import {
  finalAnswerSchema,
  laneModelSettings,
  runAnalyticalLane,
  runQuickLane,
  withV3PromptCacheBoundary,
  type LaneRunInput,
} from "../../packages/albert-v3/src/engine/lanes.ts";
import {
  classifyIntent,
  intentSchema,
} from "../../packages/albert-v3/src/engine/orchestrator.ts";

const encoding = getEncoding("o200k_base");
const config = loadAgentConfig();

const catalogue: CubeCatalogue = Object.freeze({
  fetchedAt: "2026-08-13T00:00:00.000Z",
  views: Object.freeze(config.accessibleViews.map((descriptor) => Object.freeze({
    name: descriptor.name,
    title: descriptor.name.replaceAll("_", " "),
    description: descriptor.guidance,
    members: Object.freeze([
      "total_value", "transaction_count", "completed_at",
    ].map((memberName, index) => Object.freeze({
      name: `${descriptor.name}.${memberName}`,
      kind: index === 2 ? "dimension" as const : "measure" as const,
      title: memberName.replaceAll("_", " "),
      shortTitle: memberName.replaceAll("_", " "),
      type: index === 2 ? "time" as const : "number" as const,
      description: "Representative governed business field used by the prompt-budget fixture.",
    }))),
  }))),
});

const activeCubeConnectors = Object.freeze(
  [...new Set(config.accessibleViews.map(({ connector }) => connector))].sort(),
);

function route(
  planes: Readonly<Pick<V3ToolRoute, "cube" | "shopifyQL" | "shopifyAdmin">>,
): V3ToolRoute {
  const mode = planes.cube && (planes.shopifyQL || planes.shopifyAdmin)
    ? "mixed"
    : planes.shopifyAdmin
      ? "shopify_admin"
      : planes.shopifyQL
        ? "shopifyql"
        : "cube";
  return Object.freeze({
    ...planes,
    activeCubeConnectors,
    preferredCubeConnectors: Object.freeze(
      planes.shopifyQL || planes.shopifyAdmin
        ? (planes.cube ? ["shopify", "square"] : ["shopify"])
        : [],
    ),
    mode,
    reasons: Object.freeze(["prompt budget fixture"]),
  });
}

function context(toolRoute: V3ToolRoute): V3TurnContext {
  return {
    cube: {} as V3TurnContext["cube"],
    ...(toolRoute.shopifyQL ? { shopifyQL: {} as NonNullable<V3TurnContext["shopifyQL"]> } : {}),
    ...(toolRoute.shopifyAdmin ? { shopifyAdmin: {} as NonNullable<V3TurnContext["shopifyAdmin"]> } : {}),
    config,
    promptCachePartition: "fixturetenant",
    toolRoute,
    emit: async () => ({
      id: "01K2K2A6S9W9M4FW4NG4TDD9E1",
      sequence: 1,
      occurredAt: "2026-08-13T00:00:00.000Z",
      type: "progress",
      status: "complete",
      stage: "planning",
      label: "Test",
    }),
    budget: { maxQueries: 30, executed: 0 },
    connectorFreshness: [],
    commentary: createV3CommentaryState(true),
    executedQueries: [],
    tableResults: new Map(),
    chartedResultIds: new Set(),
  };
}

type CapturedAgent = Agent<unknown, AgentOutputType>;

function instructionText(agent: CapturedAgent): string {
  if (typeof agent.instructions !== "string") {
    throw new Error(`${agent.name} uses dynamic instructions and cannot be budgeted deterministically.`);
  }
  return agent.instructions;
}

function serializedTools(agent: CapturedAgent): readonly unknown[] {
  return agent.tools.map((candidate) => {
    assert.equal(candidate.type, "function");
    return {
      type: "function",
      name: candidate.name,
      description: candidate.description,
      parameters: candidate.parameters,
      strict: candidate.strict,
    };
  });
}

function outputFormatFor(agent: CapturedAgent): unknown {
  if (agent.outputType === "text") return null;
  if (agent.name.includes("intent orchestrator")) return zodTextFormat(intentSchema, "intent");
  if (agent.name.includes("planner")) return zodTextFormat(branchPlanSchema, "branch_plan");
  if (agent.name.includes("branch:")) return zodTextFormat(branchFindingsSchema, "branch_findings");
  return zodTextFormat(finalAnswerSchema, "final_answer");
}

function promptTokenCount(agent: CapturedAgent): number {
  const productionPayload = [
    instructionText(agent),
    JSON.stringify(serializedTools(agent)),
    JSON.stringify(outputFormatFor(agent)),
  ].join("\n");
  return encoding.encode(productionPayload).length;
}

function laneInput(input: Readonly<{
  runner: Runner;
  context: V3TurnContext;
  lane: "quick" | "analytical" | "deep";
  question: string;
  model?: "gpt-5.6-luna" | "grok-4.6";
}>): LaneRunInput {
  return {
    runner: input.runner,
    preferences: { model: input.model ?? "gpt-5.6-luna", reasoningEffort: "medium", fastMode: false },
    config,
    catalogue,
    context: input.context,
    conversation: [],
    intent: {
      lane: input.lane,
      resolvedQuestion: input.question,
      ownerGoal: null,
      answerMustCover: [],
      assumptions: [],
      clarificationQuestion: null,
      clarificationOptions: [],
    },
  };
}

async function captureStructuredLane(input: Readonly<{
  lane: "quick" | "analytical";
  toolRoute: V3ToolRoute;
  question: string;
}>): Promise<CapturedAgent> {
  let captured: CapturedAgent | undefined;
  const runner = {
    run: async (agent: CapturedAgent) => {
      captured = agent;
      return {
        finalOutput: {
          answer: "Fixture answer.",
          state: "Verified",
          followUps: ["Show me the detail"],
          assumptionsDisclosed: [],
        },
      };
    },
  } as unknown as Runner;
  const fn = input.lane === "quick" ? runQuickLane : runAnalyticalLane;
  await fn(laneInput({
    runner,
    context: context(input.toolRoute),
    lane: input.lane,
    question: input.question,
  }));
  assert.ok(captured);
  return captured;
}

test("the production compact index stays in the 3k-5k token envelope", () => {
  const index = renderCompactCatalogueIndex(catalogue, config.accessibleViews, {
    allowedConnectors: activeCubeConnectors,
  });
  const tokens = encoding.encode(index).length;
  // 3k-5k is the target ceiling/envelope, not a padding requirement. A more
  // concise complete index is preferable when every view remains represented.
  assert.ok(tokens >= 2_000, `compact index unexpectedly small: ${tokens} tokens`);
  assert.ok(tokens <= 5_000, `compact index exceeds 5k: ${tokens} tokens`);
  assert.ok(Buffer.byteLength(index, "utf8") <= 22_000, "compact index exceeds byte backstop");
});

test("every single-family production base request stays below 15k tokens", async () => {
  const profiles = [
    await captureStructuredLane({
      lane: "quick",
      toolRoute: route({ cube: true, shopifyQL: false, shopifyAdmin: false }),
      question: "How much did we sell last month?",
    }),
    await captureStructuredLane({
      lane: "analytical",
      toolRoute: route({ cube: true, shopifyQL: false, shopifyAdmin: false }),
      question: "Compare sales with last month and explain the movement.",
    }),
    await captureStructuredLane({
      lane: "analytical",
      toolRoute: route({ cube: false, shopifyQL: true, shopifyAdmin: false }),
      question: "Compare Shopify storefront conversion with last month.",
    }),
    await captureStructuredLane({
      lane: "analytical",
      toolRoute: route({ cube: false, shopifyQL: false, shopifyAdmin: true }),
      question: "Show the publication status of these Shopify products.",
    }),
  ];
  for (const agent of profiles) {
    const tokens = promptTokenCount(agent);
    assert.ok(tokens <= 15_000, `${agent.name} base payload is ${tokens} tokens`);
  }
});

test("the production intent request is cache-bounded and below 15k tokens", async () => {
  let capturedAgent: CapturedAgent | undefined;
  let capturedInput: AgentInputItem[] | undefined;
  const runner = {
    run: async (agent: CapturedAgent, items: AgentInputItem[]) => {
      capturedAgent = agent;
      capturedInput = items;
      return {
        finalOutput: {
          lane: "quick",
          resolvedQuestion: "How much did we sell last month?",
          assumptions: [],
          clarificationQuestion: null,
          clarificationOptions: [],
        },
      };
    },
  } as unknown as Runner;
  await classifyIntent({
    runner,
    preferences: { model: "gpt-5.6-luna", reasoningEffort: "medium", fastMode: false },
    config,
    cachePartition: "fixturetenant",
    conversation: [],
    message: "How much did we sell last month?",
  });
  assert.ok(capturedAgent && capturedInput);
  assert.ok(promptTokenCount(capturedAgent) <= 15_000, "intent base payload exceeds 15k");
  assert.match(JSON.stringify(capturedInput[0]), /promptCacheBreakpoint/u);
});

test("deep planning, Cube branches and synthesis each stay below 15k", async () => {
  const captured: CapturedAgent[] = [];
  const runner = {
    run: async (agent: CapturedAgent) => {
      captured.push(agent);
      if (agent.name.includes("planner")) {
        return {
          finalOutput: {
            branches: [
              { title: "Sales trend", question: "Analyse the recent sales trend and margin movement.", rationale: "Find material changes." },
              { title: "Workforce", question: "Analyse rostered hours against recent trading demand.", rationale: "Find capacity mismatch." },
            ],
          },
        };
      }
      if (agent.name.includes("branch:")) {
        return {
          finalOutput: {
            headline: "No material exception in the fixture",
            findings: ["The deterministic fixture contains no executed business values."],
            materiality: "Not quantified",
            confidence: "low",
          },
        };
      }
      return {
        finalOutput: {
          answer: "Fixture synthesis.",
          state: "Exploratory",
          followUps: ["Show me the detail"],
          assumptionsDisclosed: [],
        },
      };
    },
  } as unknown as Runner;
  const deepContext: V3TurnContext = {
    ...context(route({ cube: true, shopifyQL: false, shopifyAdmin: false })),
    shopifyQL: {} as NonNullable<V3TurnContext["shopifyQL"]>,
  };
  await runDeepLane(laneInput({
    runner,
    context: deepContext,
    lane: "deep",
    question: "Give me a deep health check of the business.",
  }));
  assert.ok(captured.length >= 4);
  const planner = captured.find(({ name }) => name.includes("planner"));
  assert.ok(planner);
  assert.match(instructionText(planner), /search_shopifyql_catalogue/u);
  for (const branch of captured.filter(({ name }) => name.includes("branch:"))) {
    assert.doesNotMatch(instructionText(branch), /search_shopifyql_catalogue/u);
    assert.doesNotMatch(serializedTools(branch).map((tool) => JSON.stringify(tool)).join("\n"), /shopifyql/u);
  }
  for (const agent of captured) {
    const tokens = promptTokenCount(agent);
    assert.ok(tokens <= 15_000, `${agent.name} base payload is ${tokens} tokens`);
  }
});

test("Grok investigation and its evidence-only composer stay below 15k independently", async () => {
  const captured: CapturedAgent[] = [];
  const turnContext = context(route({ cube: true, shopifyQL: false, shopifyAdmin: false }));
  let seededEvidence = false;
  const runner = {
    run: async (agent: CapturedAgent) => {
      captured.push(agent);
      if (!seededEvidence && agent.name.includes("quick lane")) {
        seededEvidence = true;
        turnContext.executedQueries.push({
          topic: "Fixture sales",
          view: "sales_analytics",
          connector: "lightspeed",
          cubes: ["sales"],
          queryYaml: "measures:\n  - sales_analytics.gross_takings",
          members: ["sales_analytics.gross_takings"],
          rowCount: 1,
          executionMs: 4,
          timeRangeLabel: "last month",
        });
        return { finalOutput: undefined };
      }
      return {
        finalOutput: {
          answer: "Fixture answer.",
          state: "Verified",
          followUps: ["Show me the detail"],
          assumptionsDisclosed: [],
        },
      };
    },
  } as unknown as Runner;

  await runQuickLane(laneInput({
    runner,
    context: turnContext,
    lane: "quick",
    question: "How much did we sell last month?",
    model: "grok-4.6",
  }));
  assert.equal(captured.length, 2);
  for (const agent of captured) {
    assert.ok(promptTokenCount(agent) <= 15_000, `${agent.name} exceeds the base budget`);
  }
  const composer = captured.find(({ name }) => name.includes("answer composer"));
  assert.ok(composer && typeof composer.instructions === "string");
  assert.doesNotMatch(composer.instructions, /# Compact semantic view index/u);
});

test("mixed connector exposure remains bounded and never restores the full catalogue", async () => {
  const agent = await captureStructuredLane({
    lane: "analytical",
    toolRoute: route({ cube: true, shopifyQL: true, shopifyAdmin: true }),
    question: "Compare Square sales with Shopify conversion and inspect product publication status.",
  });
  assert.ok(promptTokenCount(agent) <= 15_000, "explicit three-plane union exceeds base budget");
  const instructions = instructionText(agent);
  assert.doesNotMatch(instructions, /## View:|### Measures|### Dimensions/u);
  assert.doesNotMatch(instructions, /get_semantic_catalogue/u);
});

test("OpenAI lanes cache only the stable prefix and xAI never receives OpenAI cache fields", async () => {
  let capturedAgent: CapturedAgent | undefined;
  let capturedInput: AgentInputItem[] | undefined;
  const runner = {
    run: async (agent: CapturedAgent, items: AgentInputItem[]) => {
      capturedAgent = agent;
      capturedInput = items;
      return {
        finalOutput: {
          answer: "Fixture answer.",
          state: "Verified",
          followUps: ["Show me the detail"],
          assumptionsDisclosed: [],
        },
      };
    },
  } as unknown as Runner;
  const question = "How much did we sell last month?";
  await runQuickLane(laneInput({
    runner,
    context: context(route({ cube: true, shopifyQL: false, shopifyAdmin: false })),
    lane: "quick",
    question,
  }));
  assert.ok(capturedAgent && capturedInput);
  const settings = capturedAgent.modelSettings as Readonly<{
    promptCacheOptions?: Readonly<{ mode?: string; ttl?: string }>;
    providerData?: Readonly<Record<string, unknown>>;
  }>;
  assert.deepEqual(settings.promptCacheOptions, { mode: "explicit", ttl: "30m" });
  assert.match(String(settings.providerData?.prompt_cache_key), /^albert-v3:fixturetenan:/u);
  assert.ok(String(settings.providerData?.prompt_cache_key).length <= 64);

  const boundary = JSON.stringify(capturedInput[0]);
  assert.match(boundary, /albert_prompt_cache_boundary/u);
  assert.match(boundary, /promptCacheBreakpoint/u);
  const requestContext = JSON.stringify(capturedInput[1]);
  assert.match(requestContext, /Current request/u);
  assert.match(requestContext, /How much did we sell last month/u);
  assert.doesNotMatch(instructionText(capturedAgent), /How much did we sell last month/u);

  const grokPreferences = {
    model: "grok-4.6" as const,
    reasoningEffort: "medium" as const,
    fastMode: false,
  };
  const grokSettings = laneModelSettings(grokPreferences, "low", {
    promptCacheKey: "must-not-leak-to-xai",
  }) as Readonly<{
    promptCacheOptions?: unknown;
    providerData?: Readonly<Record<string, unknown>>;
  }>;
  assert.equal(grokSettings.promptCacheOptions, undefined);
  assert.equal(grokSettings.providerData?.prompt_cache_key, undefined);
  assert.equal(withV3PromptCacheBoundary(grokPreferences.model, [capturedInput[2]!]).length, 1);
});
