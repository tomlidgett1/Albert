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

const categorySql =
  "SELECT c.category_name AS product_category, SUM(f.signed_net_amount_ex_tax) AS net_sales_ex_gst FROM mart.commerce_sales_event f JOIN core.product_category c ON c.category_id = f.rollup_category_id WHERE f.business_date >= '2026-07-27' AND f.business_date < '2026-08-03' GROUP BY c.category_name ORDER BY net_sales_ex_gst DESC";
const locationSql =
  "SELECT l.location_name, SUM(f.signed_net_amount_ex_tax) AS net_sales_ex_gst FROM mart.commerce_sales_event f JOIN core.location l ON l.location_id = f.location_id WHERE f.business_date >= '2026-07-27' AND f.business_date < '2026-08-03' GROUP BY l.location_name ORDER BY net_sales_ex_gst DESC";

const provenance = Object.freeze({
  bundleHash,
  registryVersion: "2026-08-03.1",
  identityGraph: Object.freeze({ version: 7, hash: "b".repeat(32) }),
  sources: Object.freeze(["commerce_sales_event"]),
  sourceWatermarks: Object.freeze({ commerce_sales_event: "2026-08-02T23:59:59.000Z" }),
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
  // The preferences lookup: confirmed defaults and dossier only. The
  // topic-matching choreography is retired with the typed plan; the model
  // writes SQL from the canonical schema in its instructions.
  search_catalogue: response({
    catalogue: {
      topics: [{ id: "sales_performance", label: "Sales performance", description: "Governed retail sales performance.", answerable: true }],
      metrics: [{ id: "net_sales_ex_gst", label: "Net sales", description: "Sales excluding GST.", unit: "AUD" }],
      dimensions: [{ id: "product_category", label: "Product Category", topics: ["sales_performance"] }],
      fields: [],
      tenantContext: { defaults: { "sales.default_metric": "commerce.net_sales_ex_gst" }, dossier: {} },
    },
  }),
  run_sql: response({
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
      route: "sql_first",
      bundleHash,
      registryVersion: "2026-08-03.1",
      resultDigest: "c".repeat(64),
      compilerOutputHash: "d".repeat(64),
    },
    validation: {
      status: "passed",
      checks: [
        { checkId: "claim_attested:commerce.net_sales_ex_gst", status: "passed" },
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
    route: "sql_first",
    bundleHash,
    registryVersion: "2026-08-03.1",
    resultDigest: "e".repeat(64),
    compilerOutputHash: "f".repeat(64),
  },
  validation: {
    status: "passed",
    checks: [
      { checkId: "claim_attested:commerce.net_sales_ex_gst", status: "passed" },
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
    toolStep(2, "run_sql", {
      sql: categorySql,
      purpose: "Net sales by product category for last week",
      claims: [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales_ex_gst" }],
      time: { from: "2026-07-27", to: "2026-08-03" },
      filters: [],
      limit: 10,
    }),
    toolStep(3, "publish_observation", {
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
    toolStep(4, "run_sql", {
      sql: locationSql,
      purpose: "Net sales by location for last week",
      claims: [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales_ex_gst" }],
      time: { from: "2026-07-27", to: "2026-08-03" },
      filters: [],
      limit: 10,
    }),
    toolStep(5, "publish_observation", {
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
    toolStep(6, "make_chart", {
      dataRef: locationResultId,
      chartType: "bar",
      xKey: "location_name",
      yKey: "net_sales_ex_gst",
    }),
    Object.freeze({
      responseId: "resp_7",
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

test("the real Agents SDK loop executes SQL-first tools and emits a sequential analytical trace", async () => {
  const model = new ScriptedAnalyticsModel();
  const provider: ModelProvider = { getModel: () => model };
  const semanticCalls: RemoteSemanticAgentToolName[] = [];
  const events: TraceEvent[] = [];
  const usages: Readonly<Record<string, unknown>>[] = [];
  const semanticClient = {
    async execute(name: RemoteSemanticAgentToolName, input: unknown): Promise<SemanticToolResponse> {
      semanticCalls.push(name);
      if (name === "run_sql"
        && typeof input === "object"
        && input !== null
        && String(Reflect.get(input, "sql")).includes("location_name")) {
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

  // The typed-plan IR never runs: the model writes SQL and the service attests
  // its claims. The catalogue call survives only as the preferences lookup.
  assert.deepEqual(semanticCalls, [
    "search_catalogue",
    "run_sql",
    "run_sql",
  ]);
  assert.equal(model.requests.length, 7);
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
    "query",
    "query",
  ]);
  const queryStep = progressSteps.find(({ stage }) => stage === "query");
  assert.equal(queryStep?.label, "Running SQL with governed claims");
  assert.equal(queryStep?.detail, "Net sales by product category for last week");
  assert.equal(
    progressSteps.find(({ stage }) => stage === "catalogue")?.label,
    "Loading confirmed preferences",
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
  assert.equal(result.lastResponseId, "resp_7");
  assert.equal(result.answerState, "Verified");
  assert.match(result.resultDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(result.queryAuditIds, [queryAuditId, locationQueryAuditId]);
  assert.equal(result.usage.requests, 7);
  assert.equal(usages.length, 1);
  assert.equal(usages[0]?.requests, 7);
});
