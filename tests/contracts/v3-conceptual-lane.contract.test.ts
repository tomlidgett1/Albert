import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Runner } from "@openai/agents";

import { loadAgentConfig } from "../../packages/albert-v3/src/agent-config/loader.js";
import {
  conceptualDefinitionCards,
  renderConceptualDefinitions,
  runConceptualLane,
} from "../../packages/albert-v3/src/engine/conceptual-lane.js";
import type { V3TurnContext } from "../../packages/albert-v3/src/engine/context.js";
import { resolveV3ToolRoute } from "../../packages/albert-v3/src/engine/connector-routing.js";
import { buildTurnProvenance, groundedAnswerState } from "../../packages/albert-v3/src/engine/grounding.js";
import { finalAnswerSchema, type LaneRunInput } from "../../packages/albert-v3/src/engine/lanes.js";
import {
  isDefinitionOnlyQuestion,
  normaliseConceptualIntent,
  type IntentDecision,
} from "../../packages/albert-v3/src/engine/orchestrator.js";
import type { CubeCatalogue } from "../../packages/albert-v3/src/cube/types.js";

const config = loadAgentConfig();

const catalogue: CubeCatalogue = {
  fetchedAt: "2026-08-19T00:00:00.000Z",
  views: [{
    name: "sales_analytics",
    title: "Sales analytics",
    description: "Sales performance definitions.",
    members: [
      {
        name: "sales_analytics.gross_margin_pct",
        kind: "measure",
        title: "Gross margin %",
        shortTitle: "Gross margin %",
        description: "Gross profit as a percentage of net sales excluding tax.",
        type: "number",
      },
      {
        name: "sales_analytics.gross_profit",
        kind: "measure",
        title: "Gross profit",
        shortTitle: "Gross profit",
        description: "Net sales excluding tax minus cost of goods sold.",
        type: "number",
      },
      {
        name: "sales_analytics.internal_margin_note",
        kind: "dimension",
        title: "Internal note",
        shortTitle: "Internal note",
        description: "Must never be visible.",
        aiHidden: true,
      },
    ],
  }],
};

const route = {
  cube: true,
  shopifyQL: false,
  shopifyAdmin: false,
  mode: "cube" as const,
  activeCubeConnectors: ["lightspeed"],
  preferredCubeConnectors: ["lightspeed"],
  unavailableRequestedConnectors: [],
  reasons: ["definition"],
};

function decision(lane: IntentDecision["lane"], answerShape: IntentDecision["answerShape"] = "fact"): IntentDecision {
  return {
    lane,
    resolvedQuestion: "How does gross margin work?",
    ownerGoal: null,
    answerShape,
    answerMustCover: [],
    assumptions: [],
    clarificationQuestion: null,
    clarificationOptions: [],
    recipe: null,
    recipeDateRange: null,
    recipeEntity: null,
    nativeCapability: null,
  };
}

function laneInput(runner: Runner, context: V3TurnContext, question = "How does gross margin work?"): LaneRunInput {
  return {
    runner,
    preferences: { model: "gpt-5.6-luna", reasoningEffort: "medium", fastMode: false },
    config,
    catalogue,
    context,
    conversation: [],
    intent: { ...decision("conceptual"), resolvedQuestion: question },
  };
}

function context() {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    value: {
      config,
      toolRoute: route,
      promptCachePartition: "conceptual-fixture",
      connectorFreshness: [],
      sourceFindings: [],
      commentary: { enabled: false, updates: 0, lastQueryCount: 0, messages: [] },
      definitionEvidence: [],
      executedQueries: [],
      tableResults: new Map(),
      priorResults: new Map(),
      chartedResultIds: new Set(),
      budget: { maxQueries: 3, executed: 0 },
      emit: async (event: Record<string, unknown>) => {
        events.push(event);
        return event;
      },
    } as unknown as V3TurnContext,
  };
}

test("definition-only and actual-value twins route to different lanes", () => {
  assert.equal(isDefinitionOnlyQuestion("How does gross margin work?"), true);
  assert.equal(isDefinitionOnlyQuestion("What is gross margin?"), true);
  assert.equal(isDefinitionOnlyQuestion("What is my gross margin?"), false);
  assert.equal(isDefinitionOnlyQuestion("What is my gross margin this month?"), false);
  assert.equal(isDefinitionOnlyQuestion("Why is our margin down?"), false);
  assert.equal(isDefinitionOnlyQuestion("Define gross margin and show me mine this month"), false);
  assert.equal(isDefinitionOnlyQuestion("Show me sales this month and define gross margin"), false);
  assert.equal(isDefinitionOnlyQuestion("What is gross margin for July?"), false);
  assert.equal(isDefinitionOnlyQuestion("What is gross margin at Fitzroy?"), false);
  assert.equal(isDefinitionOnlyQuestion("What is gross margin on Trek Marlin 7?"), false);
  assert.equal(isDefinitionOnlyQuestion("How is my gross margin calculated?"), true);
  assert.equal(isDefinitionOnlyQuestion("What's gross margin?"), true);
  assert.equal(isDefinitionOnlyQuestion("What's COGS?"), true);
  assert.equal(isDefinitionOnlyQuestion("Explain gross margin"), true);
  assert.equal(isDefinitionOnlyQuestion("Can you explain gross margin?"), true);
  assert.equal(isDefinitionOnlyQuestion("What is return on investment?"), true);
  assert.equal(isDefinitionOnlyQuestion("How does return on ad spend work?"), true);
  assert.equal(isDefinitionOnlyQuestion("What is inventory turnover for a retailer?"), true);
  assert.equal(isDefinitionOnlyQuestion("What is photosynthesis?"), false);

  assert.equal(normaliseConceptualIntent(decision("quick"), "How does gross margin work?").lane, "conceptual");
  assert.equal(normaliseConceptualIntent(decision("conceptual"), "What is my gross margin?").lane, "quick");
  assert.equal(normaliseConceptualIntent(decision("conceptual", "diagnosis"), "Why is our margin down?").lane, "analytical");
  assert.equal(normaliseConceptualIntent(decision("explain"), "How did you calculate that margin?").lane, "explain");
  assert.equal(normaliseConceptualIntent(decision("explain"), "What is gross margin?", false).lane, "conceptual");
  assert.equal(normaliseConceptualIntent(decision("explain"), "What is gross margin?", true).lane, "explain");
  assert.equal(normaliseConceptualIntent(decision("off_topic"), "What is photosynthesis?").lane, "off_topic");
});

test("catalogue retrieval exposes only connector-scoped model-visible definitions", () => {
  const cards = conceptualDefinitionCards({
    catalogue,
    config,
    route,
    question: "How does gross margin work?",
  });
  assert.ok(cards.some(({ member }) => member === "sales_analytics.gross_margin_pct"));
  assert.ok(cards.some(({ member }) => member === "sales_analytics.gross_profit"));
  assert.equal(cards.some(({ member }) => member.includes("internal_margin_note")), false);
  assert.ok(cards.every(({ connector }) => connector === "lightspeed"));

  const shopifyOnly = conceptualDefinitionCards({
    catalogue,
    config,
    route: { ...route, activeCubeConnectors: ["shopify"], preferredCubeConnectors: ["shopify"] },
    question: "How does gross margin work?",
  });
  assert.deepEqual(shopifyOnly, [], "another connector's definition is never substituted");
});

test("the conceptual lane makes no model call and renders exact published definitions", async () => {
  const runner = {
    run: async () => { throw new Error("the conceptual lane must not call a model"); },
  } as unknown as Runner;
  const fixture = context();
  const answer = await runConceptualLane(laneInput(runner, fixture.value));
  assert.equal(answer.state, "Verified");
  assert.deepEqual(answer.followUps, []);
  assert.equal(fixture.value.executedQueries.length, 0);
  assert.match(answer.answer, /Gross margin %[\s\S]*Gross profit as a percentage of net sales excluding tax/u);
  assert.ok(fixture.value.definitionEvidence?.some(({ member }) => member === "sales_analytics.gross_margin_pct"));
  assert.equal(fixture.events.some((event) => event.status === "running"), false);

  const provenance = buildTurnProvenance(fixture.value);
  assert.ok(provenance.definitions.some(({ metric }) => metric === "sales_analytics.gross_margin_pct"));
  assert.equal(provenance.timeRange.label, "Not applicable — definition");
  assert.equal(groundedAnswerState({
    lane: "conceptual",
    requested: "Verified",
    queriesExecuted: 0,
    rowsSeen: 0,
    definitionEvidenceCount: 1,
  }), "Verified");
});

test("unknown concepts fail closed and zero follow-ups are schema-valid", async () => {
  assert.doesNotThrow(() => finalAnswerSchema.parse({
    answer: "Definition supplied.",
    state: "Verified",
    followUps: [],
    assumptionsDisclosed: [],
  }));
  assert.equal(renderConceptualDefinitions([]), "I don’t have a governed definition for that concept yet, so I can’t explain it reliably.");
  const runner = { run: async () => { throw new Error("must not run"); } } as unknown as Runner;
  const fixture = context();
  const answer = await runConceptualLane(laneInput(runner, fixture.value, "What does quantum entanglement mean?"));
  assert.equal(answer.state, "Unavailable");
  assert.equal(fixture.value.definitionEvidence?.length, 0);
});

test("conceptual dispatch skips native reports, freshness loads, and business-context refresh", () => {
  const engine = readFileSync(new URL("../../packages/albert-v3/src/engine/engine.ts", import.meta.url), "utf8");
  assert.match(engine, /definitionOnly\s*\?\s*undefined\s*:\s*detectNativeCapability/u);
  assert.match(engine, /definitionOnly \? Promise\.resolve\(options\.connectorFreshness \?\? \[\]\) : deriveConnectorFreshness/u);
  assert.match(engine, /!definitionOnly && lane !== "conceptual" && options\.businessContext\?\.refresh\?\.due/u);
  assert.match(engine, /lane === "conceptual"[\s\S]*runConceptualLane/u);

  const routed = resolveV3ToolRoute({
    question: "How does Shopify gross margin work?",
    resolvedQuestion: "How does Shopify gross margin work?",
    lane: "conceptual",
    conversation: [],
    config,
    activeConnectors: ["shopify"],
    cubeAvailable: true,
    shopifyQLAvailable: true,
    shopifyAdminAvailable: true,
  });
  assert.equal(routed.cube, true, "catalogue metadata remains available");
  assert.equal(routed.shopifyQL, false, "definition questions never call live reporting");
  assert.equal(routed.shopifyAdmin, false, "definition questions never call live Admin");
});
