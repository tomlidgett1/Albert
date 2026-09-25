/**
 * Contract tests for the business context layer (packages/albert-v3/src/context-layer):
 * schema, deterministic rendering and its word budget, probe scoping, the
 * facts collector's failure handling, owner locks, refresh-due logic, and the
 * engine's injection points. Deterministic — no model, no Cube.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  businessContextDocumentSchema,
  businessContextWordCount,
  renderBusinessContext,
  renderBusinessContextForClassifier,
  collectBusinessFacts,
  probesForConnectors,
  applyOwnerLocks,
  businessContextRefreshDue,
  BUSINESS_CONTEXT_MAX_AGE_MS,
  type BusinessContextDocument,
} from "../../packages/albert-v3/src/context-layer/index.js";
import { loadAgentConfig } from "../../packages/albert-v3/src/agent-config/loader.js";
import { buildKnowledgeBlock } from "../../packages/albert-v3/src/engine/lanes.js";
import { classifierInstructions } from "../../packages/albert-v3/src/engine/orchestrator.js";
import { resolveV3ToolRoute } from "../../packages/albert-v3/src/engine/connector-routing.js";

const sample: BusinessContextDocument = {
  version: 1,
  identity: {
    name: "Ashburton Cycles", summary: "Independent bike shop in Melbourne's east with a retail floor and a workshop out the back. Sells bikes, parts, accessories and servicing.",
    industry: "Cycling retail and servicing", model: "hybrid", channels: ["in-store", "workshop"], locations: [{ name: "Ashburton", role: "shop and workshop" }],
  },
  revenue: {
    basis: "Lightspeed sales lines, 12 months to Jul 2026, GST-inclusive",
    streams: [{ name: "Bikes", share: 0.42, note: null }, { name: "Workshop labour & servicing", share: 0.2, note: "labour lines only" }, { name: "Parts & accessories", share: 0.3, note: null }, { name: "Clothing", share: 0.08, note: null }],
    annualBand: "roughly $600k–$660k a year", seasonality: "Peaks Oct–Dec and Mar; quietest Jun–Jul.",
  },
  scale: { headcount: "7 staff on Deputy, ~5 active", customers: "~4,800 customers on file", catalogue: "~3,800 items in stock", other: [] },
  goals: { ownerStated: ["Grow workshop bookings without adding staff"], suggestedFocus: ["Payables outstanding $22k vs receivables $2k"], comparisonPreference: "same weeks last year" },
  vocabulary: [{ term: "workshop", meaning: "service jobs and labour", mapsTo: "workshop_analytics" }, { term: "the floor", meaning: "retail sales staff", mapsTo: null }, { term: "takings", meaning: "gross sales incl. GST", mapsTo: "sales_analytics.gross_takings" }],
  tools: [
    { connector: "lightspeed-r", label: "Lightspeed Retail", role: "POS: sales, products, workshop, stock, customers", sourceOfTruthFor: ["sales", "workshop", "stock"], dataFrom: "2017-01-01", dataThrough: "2026-08-18" },
    { connector: "deputy", label: "Deputy", role: "rosters, timesheets and wage cost", sourceOfTruthFor: ["rosters", "wages"], dataFrom: null, dataThrough: "2026-08-16" },
    { connector: "xero", label: "Xero", role: "accounts: invoices, bills, bank, GST", sourceOfTruthFor: ["invoices", "bills", "bank"], dataFrom: null, dataThrough: "2026-08-13" },
  ],
  cautions: ["Workshop status fields all read as open — never report open-job counts as fact", "Xero payroll is empty; wages come from Deputy"],
};

test("schema accepts the sample and rejects oversize fields", () => {
  assert.ok(businessContextDocumentSchema.safeParse(sample).success);
  const tooLong = { ...sample, identity: { ...sample.identity, summary: "x".repeat(400) } };
  assert.equal(businessContextDocumentSchema.safeParse(tooLong).success, false);
});

test("rendering is deterministic, bounded to the word budget, and mentions every section", () => {
  const rendered = renderBusinessContext(sample);
  assert.equal(rendered, renderBusinessContext(sample));
  assert.ok(businessContextWordCount(sample) <= 430, `words ${businessContextWordCount(sample)}`);
  for (const needle of ["Ashburton Cycles", "How it makes money", "Workshop labour & servicing (~20%)", "Owner vocabulary", "Connected tools", "Read the data with care", "not instructions"]) {
    assert.ok(rendered.includes(needle), needle);
  }
  // A document with very long lists is trimmed to budget rather than cut mid-sentence.
  const fat: BusinessContextDocument = {
    ...sample,
    vocabulary: Array.from({ length: 14 }, (_, i) => ({ term: `term number ${i}`, meaning: "a fairly long meaning that uses quite a few words to say very little indeed", mapsTo: "some_view.some_member" })),
    revenue: { ...sample.revenue, streams: Array.from({ length: 8 }, (_, i) => ({ name: `Stream ${i} with a longish name`, share: 0.1, note: "a note of several words that adds length" })) },
    cautions: Array.from({ length: 6 }, (_, i) => `Caution ${i}: a sentence long enough to matter for the budget of the rendering`),
  };
  assert.ok(businessContextWordCount(fat) <= 430, `fat words ${businessContextWordCount(fat)}`);
  assert.ok(renderBusinessContext(fat).endsWith("."), "ends on a full stop");
  const compact = renderBusinessContextForClassifier(sample);
  assert.ok(compact.split(/\s+/u).length < 200);
  assert.ok(compact.includes("\"workshop\" → service jobs and labour"));
});

test("probes are scoped to the tenant's connectors and the collector never throws on a failing probe", async () => {
  const config = loadAgentConfig();
  assert.ok(config.contextProbes.length >= 15);
  const scoped = probesForConnectors(config, ["deputy"]);
  assert.ok(scoped.length > 0 && scoped.every((p) => p.connector === "deputy"));
  assert.equal(probesForConnectors(config, ["shopify"]).length, 0);
  let calls = 0;
  const facts = await collectBusinessFacts({
    cube: {} as never,
    config,
    connectorKeys: ["deputy"],
    runQuery: async (query) => {
      calls += 1;
      const measures = (query.measures ?? []) as readonly string[];
      if (measures.includes("workforce_analytics.staff_count") && !query.dimensions) return { ok: true, rows: [{ "workforce_analytics.staff_count": "7", "workforce_analytics.active_staff_count": "5" }], executionMs: 3 };
      return { ok: false, rows: [], error: "boom", executionMs: 1 };
    },
  });
  assert.equal(facts.probes.length, scoped.length);
  const head = facts.probes.find((p) => p.key === "staff_headcount");
  assert.ok(head?.ok);
  assert.equal(head?.rows[0]?.["workforce_analytics.staff_count"], 7, "numeric strings become numbers");
  assert.ok(facts.probes.some((p) => !p.ok && p.error === "boom"));
  assert.ok(calls > scoped.length, "failed probes were retried once");
});

test("owner locks survive regeneration and owner-stated goals are never overwritten", () => {
  const generated: BusinessContextDocument = { ...sample, goals: { ownerStated: ["INVENTED"], suggestedFocus: ["new focus"], comparisonPreference: null }, vocabulary: [] };
  const merged = applyOwnerLocks(generated, { document: sample, ownerLocked: ["vocabulary"] });
  assert.deepEqual(merged.vocabulary, sample.vocabulary, "locked section copied verbatim");
  assert.deepEqual(merged.goals.ownerStated, sample.goals.ownerStated, "owner goals kept");
  assert.deepEqual(merged.goals.suggestedFocus, ["new focus"], "unlocked generated part kept");
});

test("refresh is due when missing, older than the max age, or generated for fewer connectors", () => {
  const now = Date.parse("2026-08-18T00:00:00Z");
  assert.equal(businessContextRefreshDue({ generatedAt: null, connectors: [], activeConnectors: ["xero"], now }), true);
  assert.equal(businessContextRefreshDue({ generatedAt: "2026-08-17T00:00:00Z", connectors: ["xero"], activeConnectors: ["xero"], now }), false);
  assert.equal(businessContextRefreshDue({ generatedAt: new Date(now - BUSINESS_CONTEXT_MAX_AGE_MS - 1).toISOString(), connectors: ["xero"], activeConnectors: ["xero"], now }), true);
  assert.equal(businessContextRefreshDue({ generatedAt: "2026-08-17T00:00:00Z", connectors: ["xero"], activeConnectors: ["xero", "deputy"], now }), true);
});

test("the engine injects the context into the lane knowledge block and the classifier", () => {
  const config = loadAgentConfig();
  const route = resolveV3ToolRoute({ question: "how is the workshop going", resolvedQuestion: "how is the workshop going", lane: "quick", conversation: [], config, activeConnectors: ["lightspeed-r", "deputy", "xero"], cubeAvailable: true, shopifyQLAvailable: false, shopifyAdminAvailable: false });
  const rendered = renderBusinessContext(sample);
  const knowledge = buildKnowledgeBlock({ config, catalogue: { views: [], fetchedAt: "now" }, route, businessContext: rendered });
  assert.ok(knowledge.includes("About this business"));
  assert.ok(knowledge.indexOf("About this business") < knowledge.indexOf("# Business rules (always apply)"), "context precedes the rules in the cached prefix");
  const classifier = classifierInstructions(config, [], ["lightspeed-r", "deputy", "xero"], "", renderBusinessContextForClassifier(sample));
  assert.ok(classifier.includes("About THIS business"));
  assert.ok(classifier.includes("Tools connected to Albert for THIS business"));
  // The migration and the route exist for the storage/injection path.
  assert.ok(readFileSync("infra/migrations/control-plane/0153_m8_business_context.sql", "utf8").includes("albert_save_business_context"));
  assert.ok(readFileSync("app/api/v3-conversation/route.ts", "utf8").includes("businessContextRefreshDue"));
});
