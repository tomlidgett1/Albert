import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { looksLikeLiveShopifyQuestion } from "../packages/albert-v3/src/engine/engine.js";

const LIVE_SHOPIFY_QUESTIONS = [
  "How much Shopify website traffic did we get each day?",
  "Which landing pages convert the most sessions?",
  "What are customers searching for and which searches convert?",
  "Compare first-click and last-click marketing attribution by channel",
  "Show Shopify-calculated profitability and gross margin by product",
  "How are new customer cohorts retaining over time?",
  "Which referrers brought returning visitors?",
  "Where are people dropping out of checkout conversion?",
  "How did storefront web performance change this month?",
  "Which chargebacks affected the store last quarter?",
] as const;

test("representative Shopify-native questions remain in the governed V3 execution lane", () => {
  for (const question of LIVE_SHOPIFY_QUESTIONS) {
    assert.equal(looksLikeLiveShopifyQuestion(question), true, question);
  }
});

test("V3 planning names the official discovery/execution tools and forbids raw languages", async () => {
  const [lanes, tools, orchestrator] = await Promise.all([
    readFile(new URL("../packages/albert-v3/src/engine/lanes.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/albert-v3/src/engine/tools.ts", import.meta.url), "utf8"),
    readFile(new URL("../packages/albert-v3/src/engine/orchestrator.ts", import.meta.url), "utf8"),
  ]);
  assert.match(lanes, /search_shopifyql_catalogue[\s\S]*run_shopifyql_query/iu);
  assert.match(lanes, /Never write or request raw ShopifyQL, GraphQL, SQL/iu);
  assert.match(tools, /official pinned ShopifyQL 2026-07 schema registry/iu);
  assert.match(tools, /explicit bounded date window is mandatory/iu);
  assert.match(orchestrator, /traffic,[\s\S]*conversion[\s\S]*attribution/iu);
});

