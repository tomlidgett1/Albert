import assert from "node:assert/strict";
import test from "node:test";
import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "@openai/agents";
import { Usage } from "@openai/agents";
import {
  semanticToolResponseSchema,
  type RemoteSemanticAgentToolName,
  type SemanticToolResponse,
} from "../../packages/agent/src/semantic-tools.js";
import {
  createTraceEmitter,
  runLiveAlbertTurn,
} from "../../services/conversation/src/live.js";
import { intentPlanSchema } from "../../services/conversation/src/intent-plan.js";
import type { TraceEvent } from "../../packages/shared/src/index.js";

const answerIntentPlan = intentPlanSchema.parse({
  disposition: "answer",
  caseId: null,
  domain: "sales",
  grain: "line",
  namedEntities: [],
  tables: ["source_lightspeed.ls_sale_lines", "source_lightspeed.ls_sales"],
  planSteps: [
    "Load confirmed preferences",
    "Look up net sales by category",
    "Break the result down by location",
    "Present the figures in a table",
  ],
  summary: "Planning how to look up net sales by category",
  clarification: null,
  unavailableReason: null,
});

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
    toolStep(1, "update_analysis_plan", {
      summary: "Plan category and location sales analysis",
      steps: [
        "Find the category and sales tables",
        "Compare net sales by category",
        "Break net sales down by location",
        "Chart and explain the result",
      ],
      reason: "initial",
    }),
    toolStep(2, "run_sql", {
      sql: categorySql,
      purpose: "Net sales by product category for last week",
      limit: 10,
    }),
    toolStep(3, "update_analysis_plan", {
      summary: "Revise the plan using the category result",
      steps: ["Keep the supported category result", "Add the location comparison", "Chart and explain both cuts"],
      reason: "evidence",
    }),
    toolStep(4, "run_sql", {
      sql: locationSql,
      purpose: "Net sales by location for last week",
      limit: 10,
    }),
    toolStep(5, "make_chart", {
      dataRef: locationResultId,
      chartType: "bar",
      xKey: "location_name",
      yKey: "net_sales_ex_gst",
    }),
    Object.freeze({
      responseId: "resp_6",
      output: Object.freeze({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            state: "Verified",
            text: "Melbourne led location sales last week.\n\n```mermaid\ngraph LR\nMelbourne --> Leads\n```\n\n| Location | Net sales |\n| --- | --- |\n| Melbourne | $800.00 |",
            claims: [{
              statement: "Location Melbourne had Net sales of 800.0000.",
              assertion: "value",
              refs: [
                { resultId: locationResultId, rowIndex: 0, columnKey: "net_sales_ex_gst" },
                { resultId: locationResultId, rowIndex: 0, columnKey: "location_name" },
              ],
            }],
            followUps: ["Would you like the same view by store?"],
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

class StandaloneInterpretationModel implements Model {
  readonly requests: ModelRequest[] = [];
  private cursor = 0;
  private readonly steps: readonly ScriptStep[] = Object.freeze([
    Object.freeze({
      responseId: "resp_interpretation",
      output: Object.freeze({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            continuity: "standalone",
            resolvedQuestion: question,
            resolvedSubject: {
              label: "category sales last week",
              kind: "sales comparison",
              resolvedQuestion: question,
            },
            lane: "standard",
            domains: ["sales"],
            requestedWorkstreams: ["Compare last week's sales by product category"],
            policyRouteCaseId: null,
            reason: "The request needs one grouped comparison rather than a factual record lookup.",
          }),
        }],
      }),
    }),
    toolStep(101, "update_analysis_plan", {
      summary: "Compare last week's category sales",
      steps: ["Query completed sales by category", "Explain the leading category"],
      reason: "initial",
    }),
    toolStep(102, "run_sql", {
      sql: categorySql,
      purpose: "Net sales by product category for last week",
      limit: 10,
    }),
    Object.freeze({
      responseId: "resp_interpreted_answer",
      output: Object.freeze({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            state: "Exploratory",
            text: "Bikes was the leading category in the returned sales comparison.",
            claims: [],
            followUps: [],
            scope: null,
            resolvedSubject: {
              label: "category sales last week",
              kind: "sales comparison",
              resolvedQuestion: question,
            },
          }),
        }],
      }),
    }),
  ]);

  private next(request: ModelRequest): ScriptStep {
    this.requests.push(request);
    const step = this.steps[this.cursor++];
    if (!step) throw new Error("The standalone interpreted turn made an unexpected model request.");
    return step;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const step = this.next(request);
    return {
      responseId: step.responseId,
      usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      output: [step.output as ModelResponse["output"][number]],
    };
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const step = this.next(request);
    yield { type: "response_started" };
    yield {
      type: "response_done",
      response: {
        id: step.responseId,
        usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        output: [step.output],
      },
    } as StreamEvent;
  }
}

test("standalone production turns use model-owned interpretation before the SQL analyst", async () => {
  const model = new StandaloneInterpretationModel();
  const events: TraceEvent[] = [];
  const emit = createTraceEmitter({
    persist: async (event) => { events.push(event); },
    deliver: () => undefined,
  });
  const result = await runLiveAlbertTurn({
    message: question,
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "high", fastMode: true },
    tenantId: "tenant_interpreted",
    role: "owner",
    conversationId: "conversation_interpreted",
    turnId: "turn_interpreted",
    modelContext: [{ role: "user", text: question }],
    openaiApiKey: "test-only",
    openaiBaseUrl: "https://api.openai.com/v1",
    semanticServiceUrl: "https://semantic.test.invalid",
    semanticSigningSecret: "test-only-signing-secret-with-32-bytes",
    safetyIdentifier: "safety_interpreted",
    modelProvider: { getModel: () => model },
    reviewTerminalAnswer: async () => ({ verdict: "pass", reason: "Answer is relevant.", repairInstruction: null }),
    semanticClient: {
      execute: async (name) => {
        if (name !== "run_sql") throw new Error(`Unexpected semantic call: ${name}`);
        return semanticResponses.run_sql;
      },
    },
    emit,
  });

  assert.equal(result.analysisLane, "standard");
  assert.equal(model.requests.length, 4);
  assert.match(model.requests[1]?.systemInstructions ?? "", /Compare last week's sales by product category/u);
  assert.equal(events.some((event) => event.type === "query" && event.topic === "sql_first"), true);
});

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
    reviewTerminalAnswer: async () => ({ verdict: "pass", reason: "Answer is relevant.", repairInstruction: null }),
    semanticClient,
    resolveIntentPlan: async () => answerIntentPlan,
    onProviderUsage: async (usage) => { usages.push(usage); },
    emit,
  });

  // One primary analyst plans, queries, charts, and answers in one context.
  assert.deepEqual(semanticCalls, [
    "run_sql",
    "run_sql",
  ]);
  assert.equal(model.requests.length, 6);
  assert.equal(model.requests[0]?.modelSettings.providerData?.service_tier, "fast");
  assert.equal(model.requests[0]?.modelSettings.reasoning?.effort, "high");
  assert.equal(model.requests[0]?.modelSettings.store, false);
  assert.deepEqual(events.map(({ sequence }) => sequence), events.map((_, index) => index + 1));
  assert.deepEqual(events.map(({ type }) => type), [
    "progress",
    "progress",
    "progress",
    "query",
    "table",
    "progress",
    "progress",
    "query",
    "table",
    "chart",
    "answer",
  ]);
  // Passed lint / claim checks stay off the owner trail.
  assert.equal(events.some((event) => event.type === "validation"), false);
  const progressSteps = events
    .filter((event): event is Extract<TraceEvent, { type: "progress" }> => event.type === "progress")
    .map(({ stage, label, detail }) => ({ stage, label, detail }));
  assert.deepEqual(progressSteps.map(({ stage }) => stage), [
    "planning",
    "planning",
    "query",
    "planning",
    "query",
  ]);
  const queryStep = progressSteps.find(({ stage }) => stage === "query");
  assert.equal(queryStep?.label, "Net sales by product category for last week");
  assert.equal(queryStep?.detail, "");
  assert.equal(progressSteps.some(({ stage }) => stage === "catalogue"), false);
  // First shimmer is question-contextual from the intent/fallback plan summary.
  assert.match(progressSteps[0]?.label ?? "", /look up|sales|category|plan/iu);
  assert.equal(progressSteps[1]?.label, "Plan category and location sales analysis");
  assert.equal(progressSteps[3]?.label, "Revise the plan using the category result");
  const tables = events.filter((event): event is Extract<TraceEvent, { type: "table" }> => event.type === "table");
  assert.equal(tables.length, 2);
  assert.equal(tables[0]?.resultId, resultId);
  assert.equal(tables[0]?.rows[0]?.net_sales_ex_gst, "1200.0000");
  assert.equal(tables[1]?.resultId, locationResultId);
  assert.equal(tables[1]?.rows[0]?.net_sales_ex_gst, "800.0000");
  const firstQueryIndex = events.findIndex((event) => event.type === "query");
  const secondQueryIndex = events.findIndex((event, index) => index > firstQueryIndex && event.type === "query");
  const secondTableIndex = events.findIndex((event) => event.type === "table" && event.resultId === locationResultId);
  assert.ok(firstQueryIndex > 0 && secondQueryIndex > firstQueryIndex && secondTableIndex > secondQueryIndex);
  const answer = events.at(-1);
  assert.ok(answer && answer.type === "answer");
  assert.equal(answer.state, "Verified");
  assert.match(answer.text, /Melbourne/u);
  assert.match(answer.text, /\$800\.00/u);
  assert.match(answer.text, /\|/u);
  assert.doesNotMatch(answer.text, /mermaid|graph LR|Melbourne --> Leads/u);
  // Period may be in the lead sentence ("last week") or the disclosure line.
  assert.match(answer.text, /last week|These figures cover Last week from Lightspeed Retail/iu);
  assert.equal(answer.claims?.[0]?.refs.length, 2);
  assert.equal(result.lastResponseId, "resp_6");
  assert.equal(result.analysisLane, "standard");
  assert.equal(result.answerState, "Verified");
  assert.match(result.resultDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(result.queryAuditIds, [queryAuditId, locationQueryAuditId]);
  assert.equal(result.usage.requests, 6);
  assert.equal(usages.length, 1);
  assert.equal(usages[0]?.requests, 6);
});

class DeepReviewModel implements Model {
  readonly requests: ModelRequest[] = [];
  private cursor = 0;
  private readonly steps: readonly ScriptStep[] = Object.freeze([
    toolStep(21, "update_analysis_plan", {
      summary: "Plan the diagnostic sales review",
      steps: ["Establish the sales evidence", "Assess the conclusion", "Recommend the next decision"],
      reason: "initial",
    }),
    toolStep(22, "run_sql", {
      sql: categorySql,
      purpose: "Establish category sales evidence for the diagnostic review",
      limit: 10,
    }),
    Object.freeze({
      responseId: "resp_23",
      output: Object.freeze({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            state: "Qualified",
            text: "Bikes recorded $1,200 in net sales. Change the range immediately.",
            claims: [],
            followUps: [],
            scope: null,
          }),
        }],
      }),
    }),
    Object.freeze({
      responseId: "resp_24",
      output: Object.freeze({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            verdict: "repair",
            summary: "The recommendation is stronger than a single-period category result supports.",
            requiresMoreEvidence: false,
            issues: [{
              code: "unsupported_conclusion",
              detail: "A single period does not establish a decline or causal driver.",
              repairInstruction: "Keep the observed category result, remove the unsupported causal claim, and recommend a comparison period before changing operations.",
            }],
          }),
        }],
      }),
    }),
    Object.freeze({
      responseId: "resp_25",
      output: Object.freeze({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            state: "Qualified",
            text: "Bikes recorded $1,200 in net sales. Treat this as a snapshot and compare it with a prior period before changing operations.",
            claims: [],
            followUps: [],
            scope: null,
          }),
        }],
      }),
    }),
  ]);

  private next(request: ModelRequest): ScriptStep {
    this.requests.push(request);
    const step = this.steps[this.cursor++];
    if (!step) throw new Error("The deep analyst exceeded its one bounded repair flow.");
    return step;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const step = this.next(request);
    return {
      responseId: step.responseId,
      usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      output: [step.output as ModelResponse["output"][number]],
    };
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const step = this.next(request);
    yield { type: "response_started" };
    yield {
      type: "response_done",
      response: {
        id: step.responseId,
        usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        output: [step.output],
      },
    } as StreamEvent;
  }
}

test("deep analysis runs one independent review and one bounded repair", async () => {
  const model = new DeepReviewModel();
  const events: TraceEvent[] = [];
  const emit = createTraceEmitter({
    persist: async (event) => { events.push(event); },
    deliver: () => undefined,
  });
  const deepQuestion = "Why did sales decline and what should I do?";
  const result = await runLiveAlbertTurn({
    message: deepQuestion,
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "high", fastMode: true },
    tenantId: "tenant_deep",
    role: "owner",
    conversationId: "conversation_deep",
    turnId: "turn_deep",
    modelContext: [{ role: "user", text: deepQuestion }],
    openaiApiKey: "test-only",
    openaiBaseUrl: "https://api.openai.com/v1",
    semanticServiceUrl: "https://semantic.test.invalid",
    semanticSigningSecret: "test-only-signing-secret-with-32-bytes",
    safetyIdentifier: "safety_deep",
    modelProvider: { getModel: () => model },
    reviewTerminalAnswer: async () => ({ verdict: "pass", reason: "Answer is relevant.", repairInstruction: null }),
    semanticClient: {
      execute: async (name) => {
        if (name !== "run_sql") throw new Error(`Unexpected semantic call: ${name}`);
        return semanticResponses.run_sql;
      },
    },
    resolveIntentPlan: async () => answerIntentPlan,
    resolveTurnInterpretation: async () => ({
      continuity: "standalone" as const,
      resolvedQuestion: deepQuestion,
      resolvedSubject: {
        label: "sales performance review",
        kind: "business review",
        resolvedQuestion: deepQuestion,
      },
      lane: "deep" as const,
      domains: ["sales" as const],
      requestedWorkstreams: ["Review sales performance", "Recommend evidence-linked priorities"],
      policyRouteCaseId: null,
      reason: "The request requires analysis and recommendations rather than a single lookup.",
    }),
    emit,
  });

  assert.equal(model.requests.length, 5);
  assert.equal(result.lastResponseId, "resp_25");
  assert.equal(result.analysisLane, "deep");
  const reviewEvents = events.filter(
    (event): event is Extract<TraceEvent, { type: "validation" }> =>
      event.type === "validation" && event.name === "analytical_review",
  );
  assert.equal(reviewEvents.length, 1);
  assert.equal(reviewEvents[0]?.outcome, "qualified");
  const answer = events.at(-1);
  assert.ok(answer && answer.type === "answer");
  assert.match(answer.text, /compare it with a prior period before changing operations/u);
  assert.doesNotMatch(answer.text, /Change the range immediately/u);
});

class SpecialistDelegationModel implements Model {
  readonly requests: ModelRequest[] = [];
  private cursor = 0;
  private readonly steps: readonly ScriptStep[] = Object.freeze([
    toolStep(31, "update_analysis_plan", {
      summary: "Plan the sales review",
      steps: ["Delegate the sales evidence", "Integrate the finding", "Recommend the next decision"],
      reason: "initial",
    }),
    toolStep(32, "research_sales", {
      task: "Establish the strongest supported sales finding",
      questions: ["Which category result is most decision-useful?"],
      successCriteria: ["Return exact governed result references"],
    }),
    toolStep(33, "run_sql", {
      sql: categorySql,
      purpose: "Establish category sales evidence for the delegated review",
      limit: 10,
    }),
    Object.freeze({
      responseId: "resp_34",
      output: Object.freeze({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            status: "ready",
            resultIds: [resultId],
            claims: [],
            caveats: ["A comparison period is still needed before inferring a trend."],
            suggestedNextStep: "Compare the same category measure with the prior period.",
          }),
        }],
      }),
    }),
    Object.freeze({
      responseId: "resp_35",
      output: Object.freeze({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            state: "Qualified",
            text: "Bikes recorded $1,200 in net sales. Use a prior-period comparison before changing category priorities.",
            claims: [],
            followUps: [],
            scope: null,
          }),
        }],
      }),
    }),
    Object.freeze({
      responseId: "resp_36",
      output: Object.freeze({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            verdict: "pass",
            summary: "The draft uses the supported result and calibrates the missing comparison.",
            requiresMoreEvidence: false,
            issues: [],
          }),
        }],
      }),
    }),
  ]);

  private next(request: ModelRequest): ScriptStep {
    this.requests.push(request);
    const step = this.steps[this.cursor++];
    if (!step) throw new Error("The delegated review made an unexpected model request.");
    return step;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const step = this.next(request);
    return {
      responseId: step.responseId,
      usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      output: [step.output as ModelResponse["output"][number]],
    };
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const step = this.next(request);
    yield { type: "response_started" };
    yield {
      type: "response_done",
      response: {
        id: step.responseId,
        usage: { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        output: [step.output],
      },
    } as StreamEvent;
  }
}

test("deep manager delegates to a specialist over the shared governed ledger", async () => {
  const model = new SpecialistDelegationModel();
  const events: TraceEvent[] = [];
  const emit = createTraceEmitter({
    persist: async (event) => { events.push(event); },
    deliver: () => undefined,
  });
  const deepQuestion = "Review sales performance and recommend priorities";
  const result = await runLiveAlbertTurn({
    message: deepQuestion,
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "high", fastMode: true },
    tenantId: "tenant_specialist",
    role: "owner",
    conversationId: "conversation_specialist",
    turnId: "turn_specialist",
    modelContext: [{ role: "user", text: deepQuestion }],
    openaiApiKey: "test-only",
    openaiBaseUrl: "https://api.openai.com/v1",
    semanticServiceUrl: "https://semantic.test.invalid",
    semanticSigningSecret: "test-only-signing-secret-with-32-bytes",
    safetyIdentifier: "safety_specialist",
    modelProvider: { getModel: () => model },
    reviewTerminalAnswer: async () => ({ verdict: "pass", reason: "Answer is relevant.", repairInstruction: null }),
    semanticClient: {
      execute: async (name) => {
        if (name !== "run_sql") throw new Error(`Unexpected semantic call: ${name}`);
        return semanticResponses.run_sql;
      },
    },
    resolveIntentPlan: async () => answerIntentPlan,
    resolveTurnInterpretation: async () => ({
      continuity: "standalone" as const,
      resolvedQuestion: deepQuestion,
      resolvedSubject: {
        label: "sales performance review",
        kind: "business review",
        resolvedQuestion: deepQuestion,
      },
      lane: "deep" as const,
      domains: ["sales" as const],
      requestedWorkstreams: ["Review sales performance", "Recommend evidence-linked priorities"],
      policyRouteCaseId: null,
      reason: "The request benefits from an independent sales workstream and analytical review.",
    }),
    emit,
  });

  assert.equal(model.requests.length, 6);
  assert.equal(result.lastResponseId, "resp_35");
  assert.equal(result.analysisLane, "deep");
  assert.equal(events.some((event) => event.type === "table" && event.resultId === resultId), true);
  assert.equal(events.some((event) =>
    event.type === "progress" && event.label === "Sales research complete"), true);
  const review = events.find((event) => event.type === "validation" && event.name === "analytical_review");
  assert.ok(review && review.type === "validation");
  assert.equal(review.outcome, "passed");
  const answer = events.at(-1);
  assert.ok(answer && answer.type === "answer");
  assert.match(answer.text, /Bikes recorded \$1,200/u);
});

const contextualTransactionQuestion = "They are the only transactions?";
const resolvedTransactionQuestion = "Are the records already listed the only sales transactions for Tom Lidgett, and how many are completed versus still open?";
const transactionResultId = "result_tom_lidgett_transaction_scope";
const transactionSql = `SELECT
  'Tom Lidgett' AS customer_name,
  COUNT(*) AS total_records,
  COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND voided_at IS NULL) AS completed_records,
  COUNT(*) FILTER (WHERE completed_at IS NULL AND voided_at IS NULL) AS open_records,
  COUNT(*) FILTER (WHERE voided_at IS NOT NULL) AS voided_records,
  0.10 AS completed_total,
  2378.90 AS open_total
FROM source_lightspeed.ls_sales
WHERE first_name = 'Tom' AND last_name = 'Lidgett'`;

const transactionScopeResponse = response({
  resultId: transactionResultId,
  scopeReceipt: {
    kind: "sql",
    relations: [{ schema: "source_lightspeed", relation: "ls_sales" }],
    predicates: [
      { expression: "first_name", operator: "eq", values: ["Tom"] },
      { expression: "last_name", operator: "eq", values: ["Lidgett"] },
    ],
    resultValues: [{ column: "customer_name", values: ["Tom Lidgett"] }],
  },
  data: {
    columns: [
      "customer_name",
      "total_records",
      "completed_records",
      "open_records",
      "voided_records",
      "completed_total",
      "open_total",
    ],
    rows: [{
      customer_name: "Tom Lidgett",
      total_records: "9",
      completed_records: "5",
      open_records: "4",
      voided_records: "0",
      completed_total: "0.10",
      open_total: "2378.90",
    }],
    resultWindow: {
      requestedLimit: 10,
      orderedBeforeLimit: true,
      orderBy: [{ columnKey: "total_records", direction: "desc" }],
    },
  },
  queryAudit: {
    queryAuditId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    route: "sql_first",
    bundleHash,
    registryVersion: "2026-08-03.1",
    resultDigest: "1".repeat(64),
    compilerOutputHash: "2".repeat(64),
  },
  performance: { cacheHit: false, durationMs: 8, rowCount: 1 },
});

function finalMessageStep(index: number, output: Readonly<Record<string, unknown>>): ScriptStep {
  return Object.freeze({
    responseId: `resp_${index}`,
    output: Object.freeze({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(output) }],
    }),
  });
}

class ContextualTransactionModel implements Model {
  private cursor = 0;
  readonly requests: ModelRequest[] = [];
  private readonly steps: readonly ScriptStep[] = Object.freeze([
    toolStep(71, "update_analysis_plan", {
      summary: "Verify the resolved customer's full transaction population",
      steps: ["Count all records", "Separate completed, open and voided records", "Answer the follow-up directly"],
      reason: "initial",
    }),
    toolStep(72, "run_sql", {
      sql: transactionSql,
      purpose: "Verify all transaction records for the resolved customer and distinguish their states",
      limit: 10,
    }),
    finalMessageStep(73, {
      state: "Verified",
      text: "No. Tom Lidgett has 9 sales records in total: 5 completed and 4 still open; none are voided. The completed records total $0.10, while the open records total $2,378.90.",
      claims: [],
      followUps: [],
      // Deliberately over-broad model-authored wording: server scope evidence
      // must trigger resynthesis without destroying the supported answer.
      scope: {
        segment: "Tom Lidgett purchases",
        dimension: "customer_name",
        value: "Tom Lidgett purchases",
      },
      resolvedSubject: {
        label: "Tom Lidgett transactions",
        kind: "customer transactions",
        resolvedQuestion: resolvedTransactionQuestion,
      },
      presentation: { resultIds: [transactionResultId] },
    }),
  ]);

  async getResponse(): Promise<ModelResponse> {
    throw new Error("This contract exercises the streaming Responses path.");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const step = this.steps[this.cursor++];
    if (!step) throw new Error("The contextual transaction turn made an unexpected model request.");
    yield { type: "response_started" };
    yield {
      type: "response_done",
      response: {
        id: step.responseId,
        usage: { requests: 1, inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        output: [step.output],
      },
    } as StreamEvent;
  }
}

function contextualTransactionTurnOptions(input: Readonly<{
  events: TraceEvent[];
  reviewTerminalAnswer: (packet: string) => Promise<{
    verdict: "pass" | "repair";
    reason: string;
    repairInstruction: string | null;
  }>;
}>) {
  const model = new ContextualTransactionModel();
  return {
    model,
    options: {
      message: contextualTransactionQuestion,
      preferences: { model: "gpt-5.6-sol" as const, reasoningEffort: "high" as const, fastMode: true },
      tenantId: "tenant_contextual_transactions",
      role: "owner" as const,
      conversationId: "conversation_contextual_transactions",
      turnId: `turn_contextual_transactions_${input.events.length}`,
      modelContext: [
        { role: "user" as const, text: "What is the most recent sale for Tom Lidgett?" },
        {
          role: "assistant" as const,
          text: "The most recent sale I found for Tom Lidgett is sale 61740.",
          resolvedSubject: {
            label: "Tom Lidgett",
            kind: "customer",
            resolvedQuestion: "What is the most recent sale for Tom Lidgett?",
          },
        },
        { role: "user" as const, text: contextualTransactionQuestion },
      ],
      openaiApiKey: "test-only",
      openaiBaseUrl: "https://api.openai.com/v1",
      semanticServiceUrl: "https://semantic.test.invalid",
      semanticSigningSecret: "test-only-signing-secret-with-32-bytes",
      safetyIdentifier: "contextual_transaction_test",
      modelProvider: { getModel: () => model } satisfies ModelProvider,
      semanticClient: {
        execute: async (name: RemoteSemanticAgentToolName) => {
          if (name !== "run_sql") throw new Error(`Unexpected semantic call: ${name}`);
          return transactionScopeResponse;
        },
      },
      resolveIntentPlan: async () => answerIntentPlan,
      resolveTurnInterpretation: async () => ({
        continuity: "continued" as const,
        resolvedQuestion: resolvedTransactionQuestion,
        resolvedSubject: {
          label: "Tom Lidgett transactions",
          kind: "customer transactions",
          resolvedQuestion: resolvedTransactionQuestion,
        },
        lane: "lookup" as const,
        domains: ["sales" as const],
        requestedWorkstreams: ["Establish the complete transaction population for Tom Lidgett"],
        policyRouteCaseId: null,
        reason: "The pronoun refers to the persisted customer and the user is checking the complete transaction population.",
      }),
      reviewTerminalAnswer: input.reviewTerminalAnswer,
      repairTerminalAnswer: async () => ({
        state: "Verified" as const,
        text: "No. Tom Lidgett has 9 sales records in total: 5 completed and 4 still open; none are voided. The completed records total $0.10, while the open records total $2,378.90.",
        claims: [],
        followUps: [],
        scope: {
          segment: "Tom Lidgett",
          dimension: "customer_name",
          value: "Tom Lidgett",
        },
        resolvedSubject: {
          label: "Tom Lidgett transactions",
          kind: "customer transactions",
          resolvedQuestion: resolvedTransactionQuestion,
        },
        presentation: { resultIds: [] },
      }),
      emit: createTraceEmitter({
        persist: async (event: TraceEvent) => { input.events.push(event); },
        deliver: () => undefined,
      }),
    },
  };
}

test("extreme contextual follow-up preserves the persisted subject and resynthesises a scope mismatch without a refusal", async () => {
  const events: TraceEvent[] = [];
  const reviewPackets: Readonly<Record<string, unknown>>[] = [];
  const turn = contextualTransactionTurnOptions({
    events,
    reviewTerminalAnswer: async (packet) => {
      reviewPackets.push(JSON.parse(packet) as Readonly<Record<string, unknown>>);
      return reviewPackets.length === 1
        ? {
            verdict: "repair",
            reason: "The findings are relevant, but the model-authored scope label is broader than the executed receipt.",
            repairInstruction: "Preserve every supported count and amount, correct the scope to Tom Lidgett, and answer the yes/no question directly without a table.",
          }
        : { verdict: "pass", reason: "The repaired answer is direct, scoped and concise.", repairInstruction: null };
    },
  });

  const result = await runLiveAlbertTurn(turn.options);
  const answer = events.findLast((event) => event.type === "answer");
  assert.ok(answer?.type === "answer");
  assert.equal(result.analysisLane, "lookup");
  assert.equal(answer.state, "Verified");
  assert.match(answer.text, /^No\. Tom Lidgett has 9 sales records/iu);
  assert.match(answer.text, /5 completed and 4 still open/iu);
  assert.doesNotMatch(answer.text, /can't answer|unavailable|executed query|scope/iu);
  assert.doesNotMatch(answer.text, /\|/u);
  assert.deepEqual(answer.presentedResultIds, []);
  assert.deepEqual(answer.resolvedSubject, {
    label: "Tom Lidgett transactions",
    kind: "customer transactions",
    resolvedQuestion: resolvedTransactionQuestion,
  });
  assert.equal(reviewPackets.length, 2, "the repaired, transformed answer must receive a second terminal review");
  assert.equal(reviewPackets[0]?.resolvedQuestion, resolvedTransactionQuestion);
  assert.match(String(reviewPackets[0]?.scopeDiagnostic), /not attested/iu);
  assert.equal(reviewPackets[1]?.scopeDiagnostic, null);
  assert.ok(events.some((event) => event.type === "validation" && event.name === "answer_scope_guard"));
  assert.ok(events.some((event) => event.type === "validation" && event.name === "terminal_relevance"));
  assert.ok(events.some((event) => event.type === "validation" && event.name === "terminal_relevance_recheck" && event.outcome === "passed"));
});

test("an adverse second terminal verdict retains the grounded resynthesis and only lowers confidence", async () => {
  const events: TraceEvent[] = [];
  let reviews = 0;
  const turn = contextualTransactionTurnOptions({
    events,
    reviewTerminalAnswer: async () => {
      reviews += 1;
      return {
        verdict: "repair",
        reason: reviews === 1 ? "Correct the declared scope." : "The response could still be phrased more tersely.",
        repairInstruction: "Keep the supported transaction findings and answer directly.",
      };
    },
  });

  const result = await runLiveAlbertTurn(turn.options);
  const answer = events.findLast((event) => event.type === "answer");
  assert.ok(answer?.type === "answer");
  assert.equal(reviews, 2);
  assert.equal(result.answerState, "Qualified");
  assert.match(answer.text, /9 sales records.*5 completed and 4 still open/isu);
  assert.doesNotMatch(answer.text, /can't answer|unavailable/iu);
  assert.ok(events.some((event) =>
    event.type === "validation"
      && event.name === "terminal_relevance_recheck"
      && event.outcome === "qualified"));
});

test("a scope mismatch forces grounded resynthesis even when the terminal reviewer initially passes it", async () => {
  const events: TraceEvent[] = [];
  let reviews = 0;
  const turn = contextualTransactionTurnOptions({
    events,
    reviewTerminalAnswer: async () => {
      reviews += 1;
      return { verdict: "pass", reason: "The prose itself is relevant.", repairInstruction: null };
    },
  });

  const result = await runLiveAlbertTurn(turn.options);
  const answer = events.findLast((event) => event.type === "answer");
  assert.ok(answer?.type === "answer");
  assert.equal(reviews, 2);
  assert.equal(result.answerState, "Verified");
  assert.match(answer.text, /9 sales records.*5 completed and 4 still open/isu);
  assert.doesNotMatch(answer.text, /can't answer|unavailable/iu);
  assert.ok(events.some((event) => event.type === "validation" && event.name === "terminal_relevance"));
});

test("a scope mismatch still resynthesises when the initial terminal reviewer is unavailable", async () => {
  const events: TraceEvent[] = [];
  let reviews = 0;
  const turn = contextualTransactionTurnOptions({
    events,
    reviewTerminalAnswer: async () => {
      reviews += 1;
      if (reviews === 1) throw new Error("temporary reviewer outage");
      return { verdict: "pass", reason: "The forced repair is relevant and scoped.", repairInstruction: null };
    },
  });

  const result = await runLiveAlbertTurn(turn.options);
  const answer = events.findLast((event) => event.type === "answer");
  assert.ok(answer?.type === "answer");
  assert.equal(reviews, 2);
  assert.equal(result.answerState, "Verified");
  assert.match(answer.text, /9 sales records.*5 completed and 4 still open/isu);
  assert.doesNotMatch(answer.text, /can't answer|unavailable/iu);
  assert.ok(events.some((event) =>
    event.type === "validation"
      && event.name === "terminal_relevance_recheck"
      && event.outcome === "passed"));
});

class ProductionTerminalGateModel implements Model {
  private cursor = 0;
  readonly requests: ModelRequest[] = [];
  private readonly steps: readonly ScriptStep[] = Object.freeze([
    toolStep(81, "update_analysis_plan", {
      summary: "Verify the complete customer transaction population",
      steps: ["Count all records", "Separate their states", "Answer directly"],
      reason: "initial",
    }),
    toolStep(82, "run_sql", {
      sql: transactionSql,
      purpose: "Verify all transactions for Tom Lidgett",
      limit: 10,
    }),
    finalMessageStep(83, {
      state: "Verified",
      text: "No. Tom Lidgett has 9 sales records in total: 5 completed and 4 still open; none are voided. The completed records total $0.10, while the open records total $2,378.90.",
      claims: [],
      followUps: [],
      scope: { segment: "Tom Lidgett purchases", dimension: "customer_name", value: "Tom Lidgett purchases" },
      resolvedSubject: {
        label: "Tom Lidgett transactions",
        kind: "customer transactions",
        resolvedQuestion: resolvedTransactionQuestion,
      },
      presentation: { resultIds: [transactionResultId] },
    }),
    finalMessageStep(84, {
      verdict: "repair",
      reason: "The direct findings are supported, but the declared scope label is not attested.",
      repairInstruction: "Preserve the counts and amounts, correct the customer scope and remove the raw table selection.",
    }),
    finalMessageStep(85, {
      state: "Verified",
      text: "No. Tom Lidgett has 9 sales records in total: 5 completed and 4 still open; none are voided. The completed records total $0.10, while the open records total $2,378.90.",
      claims: [],
      followUps: [],
      scope: { segment: "Tom Lidgett", dimension: "customer_name", value: "Tom Lidgett" },
      resolvedSubject: {
        label: "Tom Lidgett transactions",
        kind: "customer transactions",
        resolvedQuestion: resolvedTransactionQuestion,
      },
      presentation: { resultIds: [] },
    }),
    finalMessageStep(86, {
      verdict: "pass",
      reason: "The transformed repair directly answers the question and preserves every supported distinction.",
      repairInstruction: null,
    }),
  ]);

  private next(request: ModelRequest): ScriptStep {
    this.requests.push(request);
    const step = this.steps[this.cursor++];
    if (!step) throw new Error("The production terminal gate made an unexpected model request.");
    return step;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const step = this.next(request);
    return {
      responseId: step.responseId,
      usage: new Usage({ requests: 1, inputTokens: 20, outputTokens: 10, totalTokens: 30 }),
      output: [step.output as ModelResponse["output"][number]],
    };
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const step = this.next(request);
    yield { type: "response_started" };
    yield {
      type: "response_done",
      response: {
        id: step.responseId,
        usage: { requests: 1, inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        output: [step.output],
      },
    } as StreamEvent;
  }
}

test("the production tool-less terminal agents review, resynthesise, transform and recheck exactly once", async () => {
  const events: TraceEvent[] = [];
  const model = new ProductionTerminalGateModel();
  let meteredResponseId: string | null = null;
  const result = await runLiveAlbertTurn({
    message: resolvedTransactionQuestion,
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "high", fastMode: true },
    tenantId: "tenant_terminal_production",
    role: "owner",
    conversationId: "conversation_terminal_production",
    turnId: "turn_terminal_production",
    modelContext: [{ role: "user", text: resolvedTransactionQuestion }],
    openaiApiKey: "test-only",
    openaiBaseUrl: "https://api.openai.com/v1",
    semanticServiceUrl: "https://semantic.test.invalid",
    semanticSigningSecret: "test-only-signing-secret-with-32-bytes",
    safetyIdentifier: "terminal_production_test",
    modelProvider: { getModel: () => model },
    semanticClient: {
      execute: async (name) => {
        if (name !== "run_sql") throw new Error(`Unexpected semantic call: ${name}`);
        return transactionScopeResponse;
      },
    },
    resolveIntentPlan: async () => answerIntentPlan,
    onProviderUsage: async (_usage, responseId) => { meteredResponseId = responseId; },
    emit: createTraceEmitter({
      persist: async (event) => { events.push(event); },
      deliver: () => undefined,
    }),
  });

  const answer = events.findLast((event) => event.type === "answer");
  assert.ok(answer?.type === "answer");
  assert.equal(model.requests.length, 6);
  assert.equal(result.lastResponseId, "resp_85", "the owner-facing repair remains the conversation response id");
  assert.equal(meteredResponseId, "resp_86", "usage is checkpointed against the actual final provider call");
  assert.equal(answer.state, "Verified");
  assert.deepEqual(answer.presentedResultIds, []);
  assert.match(answer.text, /9 sales records.*5 completed and 4 still open/isu);
  assert.ok(events.some((event) => event.type === "validation" && event.name === "terminal_relevance_recheck" && event.outcome === "passed"));
});
