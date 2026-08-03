import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  REMOTE_SEMANTIC_AGENT_TOOL_NAMES,
  semanticToolResponseSchema,
  semanticToolInputSchemas,
  type AgentToolContext,
} from "../packages/agent/src/semantic-tools.js";
import { loadRegistryFile } from "../packages/semantic-registry/src/index.js";
import {
  adaptGovernedResult,
  enforceEvidenceBoundAnswerState,
  requireCapabilities,
  requireCatalogue,
  requireDataHealth,
  requireDefinition,
  requireFieldValues,
  requireRememberedPreference,
} from "../services/conversation/src/index.js";
import { SemanticServiceClient } from "../services/conversation/src/semantic-client.js";
import {
  DefaultSemanticToolExecutor,
  MemorySemanticResultCache,
  startSemanticNodeServer,
  type SemanticServiceComposition,
  type SemanticServiceDependencies,
  type SourceField,
} from "../services/semantic-query/src/index.js";
import { FIXTURE_NOW, FIXTURE_TENANT_ID } from "./fixtures/retail.js";

const registry = loadRegistryFile(resolve("packages/semantic-registry/registry/registry.yaml"));
const capabilities = new Set([...registry.metrics.values()].flatMap((metric) => metric.requiredCapabilities));
const trusted: AgentToolContext = {
  tenantId: FIXTURE_TENANT_ID,
  role: "owner",
  conversationId: "01J00000000000000000000002",
  turnId: "01J00000000000000000000003",
  confirmedPreference: "employee.performance_default",
  confirmedValue: "commerce.net_sales_ex_gst",
};
const sourceField: SourceField = {
  connectionId: "01J00000000000000000000011",
  connectorId: "lightspeed-r",
  sourceSchema: "source_lightspeed",
  sourceTable: "sales",
  sourceField: "discount_reason",
  fieldType: "text",
  piiClass: "business",
  authorityConcept: "operational_sales",
  definition: "The source-recorded reason associated with a discount.",
  packVersion: "1.0.0",
};

test("every remote agent tool traverses canonical schema, signed HTTP, service and trace adapters", async () => {
  const called = new Set<string>();
  const audits: string[] = [];
  const dependencies: SemanticServiceDependencies = {
    registry,
    contextProvider: {
      async load() {
        return {
          timezone: "Australia/Melbourne",
          tradingDayCutoff: "00:00",
          fiscalYearStartMonth: 7,
          fiscalYearStartDay: 1,
          weekStartsOn: 1,
          tenantParameters: { active_customer_days: 90, lapsed_customer_days: 180, stock_velocity_days: 30 },
          capabilities,
          overlayVersion: "1",
          identityGraphVersion: 0,
          identityGraphHash: "d41d8cd98f00b204e9800998ecf8427e",
          defaults: { "sales.default_metric": "commerce.net_sales_ex_gst" },
          dossier: { industry: "Retail" },
          packVersions: { "lightspeed-r": "1.0.0" },
          sourceWatermarks: { [sourceField.connectionId]: "2026-03-15T11:30:00.000Z" },
          sourceDetails: [{ connectorId: "lightspeed-r", connectionId: sourceField.connectionId, label: "Lightspeed", dataThrough: "2026-03-15T11:30:00.000Z" }],
          authorityByConcept: { operational_sales: sourceField.connectionId },
        };
      },
    },
    database: {
      async queryAsSemanticRole(request) {
        assert.equal(request.tenantId, FIXTURE_TENANT_ID);
        assert.equal(request.parameters[0], FIXTURE_TENANT_ID);
        if (request.sql.includes('FROM "core"."location"')) return { rows: [{ value: "Carlton" }], durationMs: 1 };
        if (request.sql.includes('FROM "source_lightspeed"."sales"')) return { rows: [{ distinct_reasons: "2" }], durationMs: 2 };
        return { rows: [{ __key_location: "loc-1", location: "Carlton", net_sales_ex_gst: "210.0000" }], durationMs: 3 };
      },
    },
    cache: new MemorySemanticResultCache(() => Date.parse(FIXTURE_NOW)),
    sourceCatalogue: {
      async listFields() { return [sourceField]; },
      async searchFields() { return [sourceField]; },
      async listFieldValues() { return [{ value: "staff purchase", count: 2 }]; },
    },
    dataHealth: {
      async getForTopic() { return { status: "passed", checks: [{ checkId: "line_maths", status: "passed" }] }; },
      async getForDomain() { return { status: "passed", checks: [{ checkId: "domain_ready", status: "passed" }] }; },
    },
    audit: {
      async append(record) { audits.push(record.route); },
      async promoteSourceField() { return "01J00000000000000000000021"; },
    },
    publicationEvidence: {
      async inspect() {
        return { registryVersion: registry.version, registryHash: "f".repeat(64), activePublicationMatches: true };
      },
    },
    preferenceStore: { async remember(_context, preference, value) { assert.equal(preference, "employee.performance_default"); assert.equal(value, "commerce.net_sales_ex_gst"); return 2; } },
    clock: () => new Date(FIXTURE_NOW),
  };
  const baseExecutor = new DefaultSemanticToolExecutor(dependencies);
  const composition: SemanticServiceComposition = {
    executor: { async execute(name, input, context) { called.add(name); return baseExecutor.execute(name, input, context); } },
    async readiness() { return { ready: true, checks: { contract: true } }; },
    async close() {},
  };
  const secret = "semantic-contract-signing-secret-at-least-32-bytes";
  const running = await startSemanticNodeServer({ composition, signingSecret: secret, port: 0 });
  try {
    const client = new SemanticServiceClient(running.url, secret);
    const catalogue=requireCatalogue(await client.execute("search_catalogue", { question: "sales by location" }, trusted));
    assert.ok(catalogue.topics.length > 0);
    assert.equal(catalogue.tenantContext.defaults["sales.default_metric"],"commerce.net_sales_ex_gst");
    assert.equal(catalogue.tenantContext.dossier.industry,"Retail");
    assert.ok(requireDefinition(await client.execute("get_definition", { name: "net_sales_ex_gst" }, trusted)).definition);
    assert.equal(requireCapabilities(await client.execute("get_capabilities", { topic: "sales_performance" }, trusted)).answerable, true);
    assert.deepEqual(requireFieldValues(await client.execute("list_field_values", { field: "location", query: "Carl", limit: 10 }, trusted)), [{ value: "Carlton" }]);
    assert.equal(requireDataHealth(await client.execute("get_data_health", { domain: "sales_performance" }, trusted)).status, "passed");

    const semantic = await client.execute("run_semantic_query", {
      kind: "single",
      topic: "sales_performance",
      metrics: ["net_sales_ex_gst"],
      dimensions: ["location"],
      filters: [],
      time: { field: "business_date", range: { type: "absolute", from: "2026-03-01T00:00:00.000Z", to: "2026-03-16T00:00:00.000Z" }, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    }, trusted);
    const semanticTrace = adaptGovernedResult(semantic);
    assert.equal(semanticTrace.rows[0]?.net_sales_ex_gst, "210.0000");
    assert.equal(semanticTrace.columns.find(({ key }) => key === "net_sales_ex_gst")?.type, "currency");
    assert.equal(semanticTrace.provenance.sources[0]?.connector, "lightspeed");

    const source = await client.execute("run_source_query", {
      connectionId: sourceField.connectionId,
      sourceTable: "sales",
      fields: [],
      aggregates: [{ op: "count_distinct", field: "discount_reason", as: "distinct_reasons" }],
      groupBy: [],
      filters: [],
      limit: 20,
      requestedMetricConcept: "discount_reason_usage",
    }, trusted);
    const sourceTrace = adaptGovernedResult(source);
    assert.equal(sourceTrace.rows[0]?.distinct_reasons, "2");
    assert.equal(source.promotionCandidateId, "01J00000000000000000000021");

    const remembered = requireRememberedPreference(await client.execute("remember", {
      preference: "employee.performance_default",
      value: "commerce.net_sales_ex_gst",
      explicitlyConfirmed: true,
    }, trusted));
    assert.equal(remembered.overlayVersion, 2);
  } finally {
    await running.close();
  }
  assert.deepEqual([...called].sort(), [...REMOTE_SEMANTIC_AGENT_TOOL_NAMES].sort());
  assert.deepEqual(audits.sort(), ["semantic", "source_exploration"]);
  assert.doesNotThrow(() => semanticToolInputSchemas.ask_user.parse({ question: "Which lens?", options: [{ id: "employee.net_sales" }, { id: "employee.gross_margin" }] }));
  assert.doesNotThrow(() => semanticToolInputSchemas.make_chart.parse({ dataRef: "semantic:result", chartType: "bar", xKey: "location", yKey: "net_sales_ex_gst" }));
});

test("answer-state guard cannot promote weak or absent evidence", () => {
  const base = {
    resultId: "semantic:test",
    data: { columns: ["value"], rows: [{ value: "1" }] },
    provenance: { bundleHash: "a".repeat(64), registryVersion: "1.0.0", identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" }, sources: [], sourceWatermarks: {}, sourceDetails: [], definitionsApplied: [], definitionDetails: [], timeRange: { label: "Today", start: FIXTURE_NOW, end: FIXTURE_NOW, timezone: "Australia/Melbourne" } },
    performance: { cacheHit: false, durationMs: 1, rowCount: 1 },
  };
  const response = (
    state: "verified" | "qualified" | "exploratory" | "unavailable",
    status: "passed" | "warning" | "blocked",
    checkStatus: "passed" | "warning" | "blocked",
    warnings: string[] = [],
  ) => semanticToolResponseSchema.parse({ ...base, state, validation: { status, checks: [{ checkId: "evidence", status: checkStatus }], warnings } });
  assert.equal(enforceEvidenceBoundAnswerState("Verified", [], false), "Unavailable");
  assert.equal(enforceEvidenceBoundAnswerState("Exploratory", [response("verified", "passed", "passed")], false), "Unavailable");
  assert.equal(enforceEvidenceBoundAnswerState("Verified", [response("qualified", "warning", "warning", ["stale"])], false), "Qualified");
  assert.equal(enforceEvidenceBoundAnswerState("Verified", [response("unavailable", "blocked", "blocked")], false), "Unavailable");
  assert.equal(enforceEvidenceBoundAnswerState("Verified", [response("exploratory", "passed", "passed")], false), "Exploratory");
  assert.equal(enforceEvidenceBoundAnswerState("Clarification", [], false), "Unavailable");
  assert.equal(enforceEvidenceBoundAnswerState("Verified", [], true), "Clarification");
  assert.equal(enforceEvidenceBoundAnswerState("Verified", [response("verified", "passed", "passed")], false), "Verified");
});
