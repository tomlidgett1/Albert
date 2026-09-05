import assert from "node:assert/strict";
import test from "node:test";

import type { Agent, AgentInputItem, AgentOutputType, Runner } from "@openai/agents";

import { loadAgentConfig } from "../../packages/albert-v3/src/agent-config/loader.js";
import { shouldReviewEvidence } from "../../packages/albert-v3/src/engine/engine.js";
import {
  classifierInstructions,
  classifyIntent,
  scopedClassifierConnectors,
} from "../../packages/albert-v3/src/engine/orchestrator.js";
import { renderDataFactSheet } from "../../packages/albert-v3/src/engine/meta-lane.js";
import type { LaneRunInput } from "../../packages/albert-v3/src/engine/lanes.js";

const config = loadAgentConfig();

type CapturedAgent = Agent<unknown, AgentOutputType>;

function connectorsIn(instructions: string): ReadonlySet<string> {
  const tags = new Set<string>();
  for (const match of instructions.matchAll(/^- [a-z0-9_]+ \[([a-z0-9-]+)\]: /gmu)) {
    tags.add(match[1]!);
  }
  return tags;
}

test("the classifier only lists the views behind this tenant's connected tools", () => {
  // Ashburton Cycles: Lightspeed R-Series (control-plane key lightspeed-r),
  // Xero and Deputy. No Square, Shopify, Momence or X-Series.
  const instructions = classifierInstructions(config, [], ["lightspeed-r", "xero", "deputy"]);
  const tagged = connectorsIn(instructions);
  assert.deepEqual([...tagged].sort(), ["deputy", "lightspeed", "xero"]);
  assert.doesNotMatch(instructions, /^- square_[a-z_]+ \[/mu);
  assert.doesNotMatch(instructions, /^- shopify_[a-z_]+ \[/mu);
  assert.doesNotMatch(instructions, /^- lightspeed_x_[a-z_]+ \[/mu);
  assert.match(instructions, /Tools connected to Albert for THIS business/u);
  assert.match(instructions, /- lightspeed: Lightspeed Retail \(R-Series\)/u);
  assert.match(instructions, /- deputy: Deputy rostering/u);
  assert.match(instructions, /- xero: Xero accounting/u);
});

test("Shopify live-plane routing guidance only appears when Shopify is connected", () => {
  const withoutShopify = classifierInstructions(config, [], ["lightspeed-r", "xero"]);
  assert.doesNotMatch(withoutShopify, /ShopifyQL 2026-07 reporting schemas/u);
  assert.doesNotMatch(withoutShopify, /Shopify Admin 2026-07 read plane/u);

  const withShopify = classifierInstructions(config, [], ["shopify", "xero"]);
  assert.match(withShopify, /ShopifyQL 2026-07 reporting schemas/u);
  assert.match(withShopify, /Shopify Admin 2026-07 read plane/u);
  assert.match(withShopify, /in scope when they concern a connected Shopify store/u);
});

test("a named-but-unconnected tool routes to a working lane, never off_topic or clarification", () => {
  const instructions = classifierInstructions(config, [], ["lightspeed-r"]);
  assert.match(instructions, /names a tool that is not listed[\s\S]*do NOT route\s+off_topic and do NOT clarify/u);
});

test("unknown or stale connection state widens to every configured tool (fail open)", () => {
  const configured = [...new Set(config.accessibleViews.map(({ connector }) => connector))].sort();
  assert.deepEqual([...scopedClassifierConnectors(config, undefined)], configured);
  assert.deepEqual([...scopedClassifierConnectors(config, ["not-a-connector"])], configured);
  const instructions = classifierInstructions(config, [], undefined);
  assert.match(instructions, /connection state was unavailable/u);
  assert.deepEqual([...connectorsIn(instructions)].sort(), configured);
});

test("a tenant with zero connections is never widened: the classifier is told nothing is connected", () => {
  // A present-but-empty list is a real answer (no connections), not missing
  // state; widening it presented the whole configured catalogue to brand-new
  // accounts as "connected".
  assert.deepEqual([...scopedClassifierConnectors(config, [])], []);
  const instructions = classifierInstructions(config, [], []);
  assert.match(instructions, /NO tools are connected to Albert for THIS business yet/u);
  assert.doesNotMatch(instructions, /Tools connected to Albert for THIS business \(the only sources of data\)/u);
  assert.doesNotMatch(instructions, /connection state was unavailable/u);
  assert.deepEqual([...connectorsIn(instructions)], []);
});

test("the meta lane fact sheet never presents configured tools as connected to a zero-connection tenant", () => {
  const input = {
    config,
    context: { connectorFreshness: [], sourceFindings: [] },
  } as unknown as LaneRunInput;
  const emptyTenant = renderDataFactSheet(input, []);
  assert.match(emptyTenant, /- none\. No business tools are connected to Albert yet/u);
  assert.doesNotMatch(emptyTenant, /^- (?:xero|lightspeed|deputy|square|shopify|momence):/mu);
  // Every configured tool lands in the not-connected section instead.
  assert.match(emptyTenant, /# Not connected/u);
  assert.match(emptyTenant, /Xero accounting/u);

  // Unknown state (the control-plane read failed) still fails open.
  const unknownState = renderDataFactSheet(input, undefined);
  assert.match(unknownState, /^- xero:/mu);
  const connectedTenant = renderDataFactSheet(input, ["lightspeed-r", "xero"]);
  assert.match(connectedTenant, /^- xero:/mu);
  assert.doesNotMatch(connectedTenant, /^- square:/mu);
});

test("control-plane keys normalise to descriptor connectors and de-duplicate", () => {
  assert.deepEqual(
    [...scopedClassifierConnectors(config, ["fivetran-lightspeed", "lightspeed-r", "XERO", "xero"])],
    ["lightspeed", "xero"],
  );
});

test("classifyIntent hands the tenant's connectors to the classifier prompt", async () => {
  let captured: CapturedAgent | undefined;
  const runner = {
    run: async (agent: CapturedAgent, _items: AgentInputItem[]) => {
      captured = agent;
      return {
        finalOutput: {
          lane: "quick",
          resolvedQuestion: "Who is rostered on this week?",
          ownerGoal: null,
          answerShape: "list",
          answerMustCover: [],
          assumptions: [],
          clarificationQuestion: null,
          clarificationOptions: [],
          recipe: null,
          recipeDateRange: null,
          recipeEntity: null,
          nativeCapability: null,
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
    message: "Who is rostered on this week?",
    activeConnectors: ["deputy", "lightspeed-r"],
  });
  assert.ok(captured);
  const instructions = String(captured.instructions);
  assert.deepEqual([...connectorsIn(instructions)].sort(), ["deputy", "lightspeed"]);
});

test("a clean quick lookup skips the evidence review; everything else keeps it", () => {
  const clean = {
    lane: "quick" as const,
    escalated: false,
    state: "Verified" as const,
    queriesExecuted: 1,
    rowsSeen: 12,
    freshnessQualified: false,
  };
  assert.equal(shouldReviewEvidence(clean), false);

  // Any doubt keeps the reviewer on for the quick lane.
  assert.equal(shouldReviewEvidence({ ...clean, state: "Exploratory" }), true);
  assert.equal(shouldReviewEvidence({ ...clean, state: "No data" }), true);
  assert.equal(shouldReviewEvidence({ ...clean, rowsSeen: 0 }), true);
  assert.equal(shouldReviewEvidence({ ...clean, freshnessQualified: true }), true);
  assert.equal(shouldReviewEvidence({ ...clean, escalated: true }), true);

  // Analytical turns are always reviewed when they ran queries.
  assert.equal(shouldReviewEvidence({ ...clean, lane: "analytical" }), true);

  // Nothing to review without evidence; terminal handoffs are not reviewed.
  assert.equal(shouldReviewEvidence({ ...clean, queriesExecuted: 0 }), false);
  assert.equal(shouldReviewEvidence({ ...clean, lane: "analytical", state: "Escalate" }), false);
  assert.equal(shouldReviewEvidence({ ...clean, lane: "analytical", state: "Unavailable" }), false);
  assert.equal(shouldReviewEvidence({ ...clean, lane: "deep" }), false);
  assert.equal(shouldReviewEvidence({ ...clean, lane: "explain" }), false);
});
