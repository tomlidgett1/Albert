import assert from "node:assert/strict";
import test from "node:test";
import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "@openai/agents";
import {
  semanticToolResponseSchema,
  type RemoteSemanticAgentToolName,
  type SemanticToolResponse,
} from "../../packages/agent/src/semantic-tools.js";
import {
  createTraceEmitter,
  runLiveAlbertTurn,
} from "../../services/conversation/src/live.js";
import type { TraceEvent } from "../../packages/shared/src/index.js";

const question = "What were net sales by product category last week, then break the result down by location and show a chart?";
const queryAuditId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const locationQueryAuditId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const resultId = "result_category";
const locationResultId = "result_location";
const bundleHash = "a".repeat(64);

const provenance = Object.freeze({
  bundleHash,
  registryVersion: "2026-08-03.1",
  identityGraph: Object.freeze({ version: 7, hash: "b".repeat(32) }),
  sources: Object.freeze(["commerce_sales_line"]),
  sourceWatermarks: Object.freeze({ commerce_sales_line: "2026-08-02T23:59:59.000Z" }),
  sourceDetails: Object.freeze([{
    connectorId: "lightspeed-r",
    connectionId: "conn_lightspeed",
    label: "Lightspeed Retail",
    dataThrough: "2026-08-02T23:59:59.000Z",
  }]),
  definitionsApplied: Object.freeze(["net_sales_ex_gst", "product_category"]),
  definitionDetails: Object.freeze([
    { id: "net_sales_ex_gst", label: "Net sales", definition: "Sales excluding GST after governed discounts and returns." },
    { id: "product_category", label: "Product Category", definition: "The source-governed retail product category." },
  ]),
  timeRange: Object.freeze({
    label: "Last week",
    start: "2026-07-27T00:00:00.000+10:00",
    end: "2026-08-03T00:00:00.000+10:00",
    timezone: "Australia/Melbourne",
  }),
});

function response(
  payload: Partial<SemanticToolResponse> = {},
): SemanticToolResponse {
  return semanticToolResponseSchema.parse({
    state: "verified",
    provenance,
    validation: { status: "passed", checks: [], warnings: [] },
    performance: { cacheHit: false, durationMs: 4, rowCount: 0 },
    ...payload,
  });
}

const semanticResponses = Object.freeze({
  search_catalogue: response({
    catalogue: {
      topics: [{ id: "sales_performance", label: "Sales performance", description: "Governed retail sales performance.", answerable: true }],
      metrics: [{ id: "net_sales_ex_gst", label: "Net sales", description: "Sales excluding GST.", unit: "AUD" }],
      dimensions: [{ id: "product_category", label: "Product Category", topics: ["sales_performance"] }],
      fields: [],
      tenantContext: { defaults: { "sales.default_metric": "commerce.net_sales_ex_gst" }, dossier: {} },
    },
  }),
  get_capabilities: response({
    capabilities: {
      topic: "sales_performance",
      answerable: true,
      required: ["commerce.sales"],
      available: ["commerce.sales"],
      missing: [],
      details: [{
        id: "commerce.sales",
        requiredForTopic: true,
        available: true,
        support: "full",
        observations: [{
          connectorId: "lightspeed-r",
          connectionId: "conn_lightspeed",
          support: "full",
          coverage: { streams: ["sales", "sale_lines", "products"] },
        }],
      }],
    },
  }),
  get_data_health: response({
    dataHealth: {
      domain: "sales",
      status: "passed",
      dataThrough: "2026-08-02T23:59:59.000Z",
      checks: [{ checkId: "freshness", status: "passed" }],
      warnings: [],
    },
  }),
  run_semantic_query: response({
    resultId,
    data: {
      columns: ["product_category", "net_sales_ex_gst"],
      rows: [{ product_category: "Bikes", net_sales_ex_gst: "1200.0000" }],
      resultWindow: {
        requestedLimit: 10,
        orderedBeforeLimit: true,
        orderBy: [{ columnKey: "net_sales_ex_gst", direction: "desc" }],
      },
    },
    queryAudit: {
      queryAuditId,
      route: "semantic",
      bundleHash,
      registryVersion: "2026-08-03.1",
      resultDigest: "c".repeat(64),
      compilerOutputHash: "d".repeat(64),
    },
    validation: {
      status: "passed",
      checks: [
        { checkId: "line_maths", status: "passed" },
        { checkId: "slice_single_currency:net_sales_ex_gst", status: "passed", currencies: ["AUD"] },
      ],
      warnings: [],
    },
    performance: { cacheHit: false, durationMs: 12, rowCount: 1 },
  }),
});

const locationQueryResponse = response({
  resultId: locationResultId,
  provenance: {
    ...provenance,
    identityGraph: { ...provenance.identityGraph },
    sources: [...provenance.sources],
    sourceWatermarks: { ...provenance.sourceWatermarks },
    sourceDetails: provenance.sourceDetails.map((source) => ({ ...source })),
    definitionsApplied: ["net_sales_ex_gst", "location_name"],
    definitionDetails: [
      { id: "net_sales_ex_gst", label: "Net sales", definition: "Sales excluding GST after governed discounts and returns." },
      { id: "location_name", label: "Location", definition: "The governed retail trading location." },
    ],
    timeRange: { ...provenance.timeRange },
  },
  data: {
    columns: ["location_name", "net_sales_ex_gst"],
    rows: [{ location_name: "Melbourne", net_sales_ex_gst: "800.0000" }],
    resultWindow: {
      requestedLimit: 10,
      orderedBeforeLimit: true,
      orderBy: [{ columnKey: "net_sales_ex_gst", direction: "desc" }],
    },
  },
  queryAudit: {
    queryAuditId: locationQueryAuditId,
    route: "semantic",
    bundleHash,
    registryVersion: "2026-08-03.1",
    resultDigest: "e".repeat(64),
    compilerOutputHash: "f".repeat(64),
  },
  validation: {
    status: "passed",
    checks: [
      { checkId: "line_maths", status: "passed" },
      { checkId: "slice_single_currency:net_sales_ex_gst", status: "passed", currencies: ["AUD"] },
    ],
    warnings: [],
  },
  performance: { cacheHit: false, durationMs: 9, rowCount: 1 },
});

type ScriptStep = Readonly<{
  responseId: string;
  output: Readonly<Record<string, unknown>>;
}>;

function toolStep(index: number, name: string, argumentsValue: Readonly<Record<string, unknown>>): ScriptStep {
  return Object.freeze({
    responseId: `resp_${index}`,
    output: Object.freeze({
      type: "function_call",
      callId: `call_${index}`,
      name,
      arguments: JSON.stringify(argumentsValue),
      status: "completed",
    }),
  });
}

class ScriptedAnalyticsModel implements Model {
  readonly requests: ModelRequest[] = [];
  private cursor = 0;
  private readonly steps: readonly ScriptStep[] = Object.freeze([
    toolStep(1, "search_catalogue", { question }),
    toolStep(2, "get_capabilities", { topic: "sales_performance" }),
    toolStep(3, "get_data_health", { domain: "sales" }),
    toolStep(4, "run_semantic_query", {
      kind: "single",
      topic: "sales_performance",
      metrics: ["net_sales_ex_gst"],
      dimensions: ["product_category"],
      filters: [],
      time: {
        field: "business_date",
        range: {
          type: "absolute",
          from: "2026-07-27T00:00:00.000Z",
          to: "2026-08-03T00:00:00.000Z",
        },
        compare: "none",
      },
      sort: [{ metric: "net_sales_ex_gst", dir: "desc" }],
      limit: 10,
    }),
    toolStep(5, "publish_observation", {
      claim: {
        statement: "Product Category Bikes had Net sales of 1200.0000.",
        assertion: "value",
        refs: [
          { resultId, rowIndex: 0, columnKey: "net_sales_ex_gst" },
          { resultId, rowIndex: 0, columnKey: "product_category" },
        ],
      },
      nextStep: "break_down_by_location",
    }),
    toolStep(6, "run_semantic_query", {
      kind: "single",
      topic: "sales_performance",
      metrics: ["net_sales_ex_gst"],
      dimensions: ["location_name"],
      filters: [],
      time: {
        field: "business_date",
        range: {
          type: "absolute",
          from: "2026-07-27T00:00:00.000Z",
          to: "2026-08-03T00:00:00.000Z",
        },
        compare: "none",
      },
      sort: [{ metric: "net_sales_ex_gst", dir: "desc" }],
      limit: 10,
    }),
    toolStep(7, "publish_observation", {
      claim: {
        statement: "Location Melbourne had Net sales of 800.0000.",
        assertion: "value",
        refs: [
          { resultId: locationResultId, rowIndex: 0, columnKey: "net_sales_ex_gst" },
          { resultId: locationResultId, rowIndex: 0, columnKey: "location_name" },
        ],
      },
      nextStep: "visualise_result",
    }),
    toolStep(8, "make_chart", {
      dataRef: locationResultId,
      chartType: "bar",
      xKey: "location_name",
      yKey: "net_sales_ex_gst",
    }),
    Object.freeze({
      responseId: "resp_9",
      output: Object.freeze({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            state: "Verified",
            text: "The governed result is ready.",
            claims: [{
              statement: "Location Melbourne had Net sales of 800.0000.",
              assertion: "value",
              refs: [
                { resultId: locationResultId, rowIndex: 0, columnKey: "net_sales_ex_gst" },
                { resultId: locationResultId, rowIndex: 0, columnKey: "location_name" },
              ],
            }],
            followUps: ["Would you like the same governed view by store?"],
          }),
        }],
      }),
    }),
  ]);

  async getResponse(): Promise<ModelResponse> {
    throw new Error("Albert's live runtime must use the streaming Responses path.");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const step = this.steps[this.cursor++];
    if (!step) throw new Error("The live agent made an unexpected additional model request.");
    yield { type: "response_started" };
    yield {
      type: "response_done",
      response: {
        id: step.responseId,
        usage: {
          requests: 1,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
        output: [step.output],
      },
    } as StreamEvent;
  }
}

test("the real Agents SDK loop executes governed tools and emits a sequential analytical trace", async () => {
  const model = new ScriptedAnalyticsModel();
  const provider: ModelProvider = { getModel: () => model };
  const semanticCalls: RemoteSemanticAgentToolName[] = [];
  const events: TraceEvent[] = [];
  const usages: Readonly<Record<string, unknown>>[] = [];
  const semanticClient = {
    async execute(name: RemoteSemanticAgentToolName, input: unknown): Promise<SemanticToolResponse> {
      semanticCalls.push(name);
      if (name === "run_semantic_query"
        && typeof input === "object"
        && input !== null
        && Array.isArray(Reflect.get(input, "dimensions"))
        && Reflect.get(input, "dimensions").includes("location_name")) {
        return locationQueryResponse;
      }
      const result = semanticResponses[name as keyof typeof semanticResponses];
      if (!result) throw new Error(`Unexpected semantic call: ${name}`);
      return result;
    },
  };
  const emit = createTraceEmitter({
    persist: async (event) => { events.push(event); },
    deliver: () => undefined,
  });

  const result = await runLiveAlbertTurn({
    message: question,
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "high", fastMode: true },
    tenantId: "tenant_01",
    role: "owner",
    conversationId: "conversation_01",
    turnId: "turn_01",
    modelContext: [{ role: "user", text: question }],
    openaiApiKey: "test-only",
    openaiBaseUrl: "https://api.openai.com/v1",
    semanticServiceUrl: "https://semantic.test.invalid",
    semanticSigningSecret: "test-only-signing-secret-with-32-bytes",
    safetyIdentifier: "safety_test",
    modelProvider: provider,
    semanticClient,
    onProviderUsage: async (usage) => { usages.push(usage); },
    emit,
  });

  assert.deepEqual(semanticCalls, [
    "search_catalogue",
    "get_capabilities",
    "get_data_health",
    "run_semantic_query",
    "run_semantic_query",
  ]);
  assert.equal(model.requests.length, 9);
  assert.equal(model.requests[0]?.modelSettings.providerData?.service_tier, "fast");
  assert.equal(model.requests[0]?.modelSettings.reasoning?.effort, "high");
  assert.equal(model.requests[0]?.modelSettings.store, false);
  assert.deepEqual(events.map(({ sequence }) => sequence), events.map((_, index) => index + 1));
  // Every governed tool opens and settles its own progress step so the browser
  // can show the exact work in flight instead of a generic placeholder.
  assert.deepEqual(events.map(({ type }) => type), [
    "progress",
    "progress",
    "progress",
    "progress",
    "progress",
    "progress",
    "progress",
    "progress",
    "query",
    "table",
    "validation",
    "validation",
    "narrative",
    "progress",
    "query",
    "table",
    "validation",
    "validation",
    "narrative",
    "chart",
    "answer",
  ]);
  const progressSteps = events
    .filter((event): event is Extract<TraceEvent, { type: "progress" }> => event.type === "progress")
    .map(({ stage, label, detail }) => ({ stage, label, detail }));
  assert.deepEqual(progressSteps.map(({ stage }) => stage), [
    "planning",
    "catalogue",
    "catalogue",
    "capabilities",
    "capabilities",
    "data_health",
    "data_health",
    "query",
    "query",
  ]);
  const queryStep = progressSteps.find(({ stage }) => stage === "query");
  assert.equal(queryStep?.label, "Querying sales performance");
  assert.equal(
    queryStep?.detail,
    "net sales ex GST · by product category · 27 July 2026 – 3 Aug 2026",
  );
  assert.equal(
    progressSteps.find(({ stage }) => stage === "capabilities")?.label,
    "Checking source support for sales performance",
  );
  assert.ok(progressSteps.every(({ label }) => label.length > 0 && label !== "Understanding the question"));
  const tables = events.filter((event): event is Extract<TraceEvent, { type: "table" }> => event.type === "table");
  assert.equal(tables.length, 2);
  assert.equal(tables[0]?.resultId, resultId);
  assert.equal(tables[0]?.rows[0]?.net_sales_ex_gst, "1200.0000");
  assert.equal(tables[1]?.resultId, locationResultId);
  assert.equal(tables[1]?.rows[0]?.net_sales_ex_gst, "800.0000");
  const firstObservationIndex = events.findIndex((event) => event.type === "narrative" && event.text.includes("AUD 1,200"));
  const secondQueryIndex = events.findIndex((event, index) => index > firstObservationIndex && event.type === "query");
  const secondTableIndex = events.findIndex((event) => event.type === "table" && event.resultId === locationResultId);
  assert.ok(firstObservationIndex > 0 && secondQueryIndex > firstObservationIndex && secondTableIndex > secondQueryIndex);
  const answer = events.at(-1);
  assert.ok(answer && answer.type === "answer");
  assert.equal(answer.state, "Verified");
  // The narrative the model wrote is what the user reads, once every figure in
  // it has been proved against a governed cell. The server-canonical rendering
  // remains the fallback when that proof fails, and claims stay the lineage.
  assert.equal(
    answer.text,
    "The governed result is ready.\n\nFigures cover Last week from Lightspeed Retail, current to 2026-08-02.",
  );
  assert.equal(answer.claims?.[0]?.refs.length, 2);
  assert.equal(result.lastResponseId, "resp_9");
  assert.equal(result.answerState, "Verified");
  assert.match(result.resultDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(result.queryAuditIds, [queryAuditId, locationQueryAuditId]);
  assert.equal(result.usage.requests, 9);
  assert.equal(usages.length, 1);
  assert.equal(usages[0]?.requests, 9);
});
