import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "@openai/agents";
import {
  semanticQueryIrSchema,
  semanticToolResponseSchema,
  type AgentToolContext,
  type RemoteSemanticAgentToolName,
  type SemanticQueryIr,
  type SemanticToolResponse,
} from "../../packages/agent/src/semantic-tools.js";
import { compileSemanticQuery } from "../../packages/compiler/src/index.js";
import { loadRegistryFile } from "../../packages/semantic-registry/src/index.js";
import type { TraceEvent } from "../../packages/shared/src/index.js";
import {
  createTraceEmitter,
  runLiveAlbertTurn,
} from "../../services/conversation/src/live.js";

const initialQuestion = "Which of my employees working today performed best over the last six months?";
const clarificationQuestion = "What should ‘performed best’ mean for this answer?";
const followUpMessage = "Use net sales.";
const bundleHash = "a".repeat(64);
const identityHash = "b".repeat(32);
const rosterResultId = "result_workers_rostered_today";
const performanceResultId = "result_rostered_worker_performance";
const rosterQueryAuditId = "01K20M8C4T4J25SB8RR4RG0001";
const performanceQueryAuditId = "01K20M8C4T4J25SB8RR4RG0002";
const samWorkerId = "01K20M8C4T4J25SB8RR4RG0SAM";
const joWorkerId = "01K20M8C4T4J25SB8RR4RG00JO";

function response(payload: Partial<SemanticToolResponse> = {}): SemanticToolResponse {
  return semanticToolResponseSchema.parse({
    state: "verified",
    provenance: {
      bundleHash,
      registryVersion: "2026-08-03.1",
      identityGraph: { version: 11, hash: identityHash },
      sources: [],
      sourceWatermarks: {},
      sourceDetails: [],
      definitionsApplied: [],
      definitionDetails: [],
    },
    validation: { status: "passed", checks: [], warnings: [] },
    performance: { cacheHit: false, durationMs: 2, rowCount: 0 },
    ...payload,
  });
}

const catalogueResponse = response({
  catalogue: {
    topics: [
      {
        id: "workforce_labour",
        label: "Workforce and labour",
        description: "Governed roster and actual-time analysis.",
        answerable: true,
      },
      {
        id: "workforce_sales",
        label: "Workforce and sales",
        description: "Independently aggregated sales and labour aligned on canonical workers.",
        answerable: true,
      },
    ],
    metrics: [
      { id: "workforce.rostered_hours", label: "Rostered hours", description: "Planned hours from governed shifts.", unit: "hours" },
      { id: "commerce.net_sales_ex_gst", label: "Net sales", description: "Net sales excluding GST after returns.", unit: "AUD" },
      { id: "workforce.worked_hours", label: "Worked hours", description: "Approved actual worked hours.", unit: "hours" },
      { id: "commerce.gross_margin", label: "Gross margin", description: "Operational gross profit after observed line cost.", unit: "AUD" },
      { id: "composites.gross_profit_per_labour_hour", label: "Gross profit per worked hour", description: "Gross profit divided by worked hours after canonical-worker alignment.", unit: "AUD/hour" },
    ],
    dimensions: [{ id: "worker", label: "Worker", topics: ["workforce_labour", "workforce_sales"] }],
    fields: [],
    tenantContext: { defaults: {}, dossier: { timezone: "Australia/Melbourne" } },
  },
});

const labourCapabilitiesResponse = response({
  capabilities: {
    topic: "workforce_labour",
    answerable: true,
    required: ["workforce.shifts", "workforce.time_entries"],
    available: ["workforce.shifts", "workforce.time_entries"],
    missing: [],
    details: [
      {
        id: "workforce.shifts",
        requiredForTopic: true,
        available: true,
        support: "full",
        observations: [{
          connectorId: "deputy",
          connectionId: "conn_deputy",
          support: "full",
          coverage: { streams: ["rosters"] },
        }],
      },
      {
        id: "workforce.time_entries",
        requiredForTopic: true,
        available: true,
        support: "full",
        observations: [{
          connectorId: "deputy",
          connectionId: "conn_deputy",
          support: "full",
          coverage: { streams: ["timesheets"] },
        }],
      },
    ],
  },
});

const workforceSalesCapabilitiesResponse = response({
  capabilities: {
    topic: "workforce_sales",
    answerable: true,
    required: ["commerce.order_lines", "commerce.order_lines.cost", "commerce.order_lines.worker_attribution", "workforce.time_entries"],
    available: ["commerce.order_lines", "commerce.order_lines.cost", "commerce.order_lines.worker_attribution", "workforce.time_entries"],
    missing: [],
    details: [
      {
        id: "commerce.order_lines",
        requiredForTopic: true,
        available: true,
        support: "full",
        observations: [{
          connectorId: "lightspeed-r",
          connectionId: "conn_lightspeed",
          support: "full",
          coverage: { streams: ["sales"], fields: ["SaleLines"] },
        }],
      },
      {
        id: "commerce.order_lines.cost",
        requiredForTopic: true,
        available: true,
        support: "full",
        observations: [{
          connectorId: "lightspeed-r",
          connectionId: "conn_lightspeed",
          support: "full",
          coverage: { streams: ["sales"], fields: ["SaleLines.unitCost"] },
        }],
      },
      {
        id: "commerce.order_lines.worker_attribution",
        requiredForTopic: true,
        available: true,
        support: "full",
        observations: [{
          connectorId: "lightspeed-r",
          connectionId: "conn_lightspeed",
          support: "full",
          coverage: { streams: ["sales"], fields: ["employeeID"] },
        }],
      },
      {
        id: "workforce.time_entries",
        requiredForTopic: true,
        available: true,
        support: "full",
        observations: [{
          connectorId: "deputy",
          connectionId: "conn_deputy",
          support: "full",
          coverage: { streams: ["timesheets"] },
        }],
      },
    ],
  },
});

const healthResponses = Object.freeze({
  workforce: response({
    dataHealth: {
      domain: "workforce",
      status: "passed",
      dataThrough: "2026-08-03T08:55:00.000Z",
      checks: [{ checkId: "shift_timesheet_coverage", status: "passed" }],
      warnings: [],
    },
  }),
  sales: response({
    dataHealth: {
      domain: "sales",
      status: "passed",
      dataThrough: "2026-08-03T08:58:00.000Z",
      checks: [{ checkId: "line_maths", status: "passed" }],
      warnings: [],
    },
  }),
});

const rosterSql =
  "SELECT w.worker_name AS worker, SUM(m.rostered_hours) AS rostered_hours FROM mart.workforce_day_worker_location m JOIN core.worker w ON w.worker_id = m.worker_id WHERE m.business_date = '2026-08-03' GROUP BY w.worker_name ORDER BY rostered_hours DESC";
const performanceSql =
  "SELECT a.worker_name AS worker, SUM(a.net_sales_ex_gst) AS net_sales_ex_gst, SUM(a.worked_hours) AS worked_hours, SUM(a.net_sales_ex_gst) / NULLIF(SUM(a.worked_hours), 0) AS sales_per_labour_hour FROM mart.workforce_sales_aligned a WHERE a.business_date >= '2026-02-03' AND a.business_date < '2026-08-04' GROUP BY a.worker_name ORDER BY net_sales_ex_gst DESC";
const rosterSqlArgs = Object.freeze({
  sql: rosterSql,
  purpose: "Rostered hours by worker for today",
  claims: [{ metricId: "workforce.rostered_hours", column: "rostered_hours" }],
  time: { from: "2026-08-03", to: "2026-08-04" },
  filters: [],
  limit: 50,
});
const performanceSqlArgs = Object.freeze({
  sql: performanceSql,
  purpose: "Net sales and worked hours by worker over the confirmed period",
  claims: [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales_ex_gst" }],
  time: { from: "2026-02-03", to: "2026-08-04" },
  filters: [],
  limit: 50,
});

const rosterQuery: SemanticQueryIr = semanticQueryIrSchema.parse({
  kind: "single",
  topic: "workforce_labour",
  metrics: ["rostered_hours"],
  dimensions: ["worker"],
  filters: [],
  time: { field: "business_date", range: { type: "today" }, compare: "none" },
  sort: [{ metric: "rostered_hours", dir: "desc" }],
  limit: 50,
});

const performanceQuery: SemanticQueryIr = semanticQueryIrSchema.parse({
  kind: "composite",
  topic: "workforce_sales",
  // The composite contract requires a derived metric; its independently
  // aggregated component columns remain query output and net sales is the
  // selected ranking lens for this turn.
  metrics: ["sales_per_labour_hour"],
  queries: [
    {
      topic: "sales_performance",
      metrics: ["net_sales_ex_gst"],
      dimensions: ["worker"],
      filters: [{ field: "worker", op: "in", values: [samWorkerId, joWorkerId] }],
      time: {
        field: "business_date",
        range: {
          type: "absolute",
          from: "2026-02-03T00:00:00.000Z",
          to: "2026-08-03T00:00:00.000Z",
        },
        compare: "none",
      },
    },
    {
      topic: "workforce_labour",
      metrics: ["worked_hours"],
      dimensions: ["worker"],
      filters: [{ field: "worker", op: "in", values: [samWorkerId, joWorkerId] }],
      time: {
        field: "business_date",
        range: {
          type: "absolute",
          from: "2026-02-03T00:00:00.000Z",
          to: "2026-08-03T00:00:00.000Z",
        },
        compare: "none",
      },
    },
  ],
  alignOn: ["worker"],
  sort: [{ metric: "net_sales_ex_gst", dir: "desc" }],
  limit: 50,
});

const grossProfitPerHourQuery: SemanticQueryIr = semanticQueryIrSchema.parse({
  kind: "composite",
  topic: "workforce_sales",
  metrics: ["gross_profit_per_labour_hour"],
  queries: [
    {
      topic: "sales_performance",
      metrics: ["gross_margin"],
      dimensions: ["worker"],
      filters: [{ field: "worker", op: "in", values: [samWorkerId, joWorkerId] }],
      time: {
        field: "business_date",
        range: {
          type: "absolute",
          from: "2026-02-03T00:00:00.000Z",
          to: "2026-08-03T00:00:00.000Z",
        },
        compare: "none",
      },
    },
    {
      topic: "workforce_labour",
      metrics: ["worked_hours"],
      dimensions: ["worker"],
      filters: [{ field: "worker", op: "in", values: [samWorkerId, joWorkerId] }],
      time: {
        field: "business_date",
        range: {
          type: "absolute",
          from: "2026-02-03T00:00:00.000Z",
          to: "2026-08-03T00:00:00.000Z",
        },
        compare: "none",
      },
    },
  ],
  alignOn: ["worker"],
  sort: [{ metric: "gross_profit_per_labour_hour", dir: "desc" }],
  limit: 50,
});

const rosterResponse = response({
  resultId: rosterResultId,
  data: {
    columns: ["worker", "rostered_hours"],
    rows: [
      { worker: "Sam", rostered_hours: "8.0000" },
      { worker: "Jo", rostered_hours: "6.5000" },
    ],
    filterRefs: [
      { worker: samWorkerId },
      { worker: joWorkerId },
    ],
    resultWindow: {
      requestedLimit: 50,
      orderedBeforeLimit: true,
      orderBy: [{ columnKey: "rostered_hours", direction: "desc" }],
    },
  },
  provenance: {
    bundleHash,
    registryVersion: "2026-08-03.1",
    identityGraph: { version: 11, hash: identityHash },
    sources: ["workforce_shift"],
    sourceWatermarks: { workforce_shift: "2026-08-03T08:55:00.000Z" },
    sourceDetails: [{
      connectorId: "deputy",
      connectionId: "conn_deputy",
      label: "Deputy",
      dataThrough: "2026-08-03T08:55:00.000Z",
    }],
    definitionsApplied: ["workforce.rostered_hours", "worker"],
    definitionDetails: [
      { id: "workforce.rostered_hours", label: "Rostered hours", definition: "Planned shift duration from Deputy rosters." },
      { id: "worker", label: "Worker", definition: "The canonical tenant-local worker identity." },
    ],
    timeRange: {
      label: "Today",
      start: "2026-08-03T00:00:00.000+10:00",
      end: "2026-08-04T00:00:00.000+10:00",
      timezone: "Australia/Melbourne",
    },
  },
  queryAudit: {
    queryAuditId: rosterQueryAuditId,
    route: "sql_first",
    bundleHash,
    registryVersion: "2026-08-03.1",
    resultDigest: "c".repeat(64),
    compilerOutputHash: "d".repeat(64),
  },
  validation: {
    status: "passed",
    checks: [
      { checkId: "shift_timesheet_coverage", status: "passed" },
      { checkId: "identity_coverage", status: "passed" },
    ],
    warnings: [],
  },
  performance: { cacheHit: false, durationMs: 11, rowCount: 2 },
});

const performanceResponse = response({
  state: "qualified",
  resultId: performanceResultId,
  data: {
    columns: ["worker", "net_sales_ex_gst", "worked_hours", "sales_per_labour_hour"],
    rows: [
      { worker: "Sam", net_sales_ex_gst: "15000.0000", worked_hours: "510.0000", sales_per_labour_hour: "29.4118" },
      { worker: "Jo", net_sales_ex_gst: "12300.0000", worked_hours: "472.5000", sales_per_labour_hour: "26.0317" },
    ],
    resultWindow: {
      requestedLimit: 50,
      orderedBeforeLimit: true,
      orderBy: [{ columnKey: "net_sales_ex_gst", direction: "desc" }],
    },
  },
  provenance: {
    bundleHash,
    registryVersion: "2026-08-03.1",
    identityGraph: { version: 11, hash: identityHash },
    sources: ["commerce_sales_event", "workforce_day_worker_location"],
    sourceWatermarks: {
      commerce_sales_event: "2026-08-03T08:58:00.000Z",
      workforce_day_worker_location: "2026-08-03T08:55:00.000Z",
    },
    sourceDetails: [
      {
        connectorId: "lightspeed-r",
        connectionId: "conn_lightspeed",
        label: "Lightspeed Retail R-Series",
        dataThrough: "2026-08-03T08:58:00.000Z",
      },
      {
        connectorId: "deputy",
        connectionId: "conn_deputy",
        label: "Deputy",
        dataThrough: "2026-08-03T08:55:00.000Z",
      },
    ],
    definitionsApplied: ["commerce.net_sales_ex_gst", "workforce.worked_hours", "composites.sales_per_labour_hour", "worker"],
    definitionDetails: [
      { id: "commerce.net_sales_ex_gst", label: "Net sales", definition: "Completed sales excluding GST after governed discounts and refunds." },
      { id: "workforce.worked_hours", label: "Worked hours", definition: "Approved actual time from Deputy timesheets." },
      { id: "composites.sales_per_labour_hour", label: "Sales per labour hour", definition: "Net sales divided by worked hours after independent aggregation and worker alignment." },
      { id: "worker", label: "Worker", definition: "The canonical identity used to align separately aggregated facts." },
    ],
    timeRange: {
      label: "3 February – 2 August 2026",
      start: "2026-02-03T00:00:00.000+11:00",
      end: "2026-08-03T00:00:00.000+10:00",
      timezone: "Australia/Melbourne",
    },
  },
  queryAudit: {
    queryAuditId: performanceQueryAuditId,
    route: "sql_first",
    bundleHash,
    registryVersion: "2026-08-03.1",
    resultDigest: "e".repeat(64),
    compilerOutputHash: "f".repeat(64),
  },
  validation: {
    status: "warning",
    checks: [
      { checkId: "aggregate_then_align", status: "passed" },
      { checkId: "worker_attribution_coverage", status: "passed", coveragePercent: "98.7000" },
      { checkId: "identity_coverage", status: "warning", coveragePercent: "97.9000" },
      { checkId: "refund_handling", status: "passed" },
      { checkId: "slice_single_currency:net_sales_ex_gst", status: "passed", currencies: ["AUD"] },
    ],
    warnings: ["A small share of source workers remains unlinked, so the ranking excludes those records."],
  },
  performance: { cacheHit: false, durationMs: 18, rowCount: 2 },
});

type ScriptStep = Readonly<{
  responseId: string;
  output: Readonly<Record<string, unknown>>;
}>;


/**
 * The model calls tools with the flattened tool-facing shape; the compiler IR
 * (which defaults `parameters`) is what the service derives from it. These
 * constants stay IR-parsed for response fixtures, so the scripted tool
 * arguments strip the IR-only keys back off.
 */
function toolShapedQuery(query: SemanticQueryIr): Readonly<Record<string, unknown>> {
  const { parameters: _parameters, ...rest } = query as Record<string, unknown> & { parameters?: unknown };
  void _parameters;
  if ((query as { kind?: string }).kind === "composite") {
    const composite = rest as { queries?: readonly (Record<string, unknown> & { parameters?: unknown })[] };
    return {
      ...rest,
      queries: (composite.queries ?? []).map(({ parameters: _sub, ...subRest }) => {
        void _sub;
        return subRest;
      }),
    };
  }
  return rest;
}

function toolStep(prefix: string, index: number, name: string, argumentsValue: Readonly<Record<string, unknown>>): ScriptStep {
  return Object.freeze({
    responseId: `${prefix}_response_${index}`,
    output: Object.freeze({
      type: "function_call",
      callId: `${prefix}_call_${index}`,
      name,
      arguments: JSON.stringify(argumentsValue),
      status: "completed",
    }),
  });
}

function finalStep(prefix: string, index: number, output: Readonly<Record<string, unknown>>): ScriptStep {
  return Object.freeze({
    responseId: `${prefix}_response_${index}`,
    output: Object.freeze({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(output) }],
    }),
  });
}

class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  private cursor = 0;

  constructor(private readonly steps: readonly ScriptStep[]) {}

  async getResponse(): Promise<ModelResponse> {
    throw new Error("Albert's production loop must use the streaming Responses path.");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const step = this.steps[this.cursor++];
    if (!step) throw new Error("The flagship agent made an unexpected extra provider request.");
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

type SemanticCall = Readonly<{
  name: RemoteSemanticAgentToolName;
  input: unknown;
  context: Readonly<Pick<AgentToolContext, "confirmedPreference" | "confirmedValue">>;
}>;

function semanticClient(calls: SemanticCall[]) {
  return {
    async execute(
      name: RemoteSemanticAgentToolName,
      input: unknown,
      context: AgentToolContext,
    ): Promise<SemanticToolResponse> {
      calls.push({
        name,
        input,
        context: {
          ...(context.confirmedPreference ? { confirmedPreference: context.confirmedPreference } : {}),
          ...(context.confirmedValue ? { confirmedValue: context.confirmedValue } : {}),
        },
      });
      if (name === "search_catalogue") return catalogueResponse;
      if (name === "get_capabilities") {
        const topic = Reflect.get(input as object, "topic");
        if (topic === "workforce_labour") return labourCapabilitiesResponse;
        if (topic === "workforce_sales") return workforceSalesCapabilitiesResponse;
      }
      if (name === "get_data_health") {
        const domain = Reflect.get(input as object, "domain");
        if (domain === "workforce") return healthResponses.workforce;
        if (domain === "sales") return healthResponses.sales;
      }
      if (name === "run_sql") {
        const sql = String(Reflect.get(input as object, "sql"));
        if (sql.includes("workforce_day_worker_location")) {
          assert.deepEqual(input, rosterSqlArgs);
          return rosterResponse;
        }
        if (sql.includes("workforce_sales_aligned")) {
          assert.deepEqual(input, performanceSqlArgs);
          return performanceResponse;
        }
      }
      throw new Error(`Unexpected flagship semantic call: ${name}`);
    },
  };
}

function emitter(events: TraceEvent[]) {
  return createTraceEmitter({
    persist: async (event) => { events.push(event); },
    deliver: () => undefined,
  });
}

test("the flagship employee question clarifies once, then runs the governed composite agent loop", async () => {
  const clarificationModel = new ScriptedModel([
    toolStep("clarify", 1, "search_catalogue", { question: initialQuestion }),
    toolStep("clarify", 2, "get_capabilities", { topic: "workforce_labour" }),
    toolStep("clarify", 3, "get_capabilities", { topic: "workforce_sales" }),
    toolStep("clarify", 4, "get_data_health", { domain: "workforce" }),
    toolStep("clarify", 5, "get_data_health", { domain: "sales" }),
    toolStep("clarify", 6, "ask_user", {
      question: clarificationQuestion,
      options: [
        { id: "employee.net_sales" },
        { id: "employee.gross_margin" },
        { id: "employee.gross_profit_per_labour_hour" },
      ],
    }),
    finalStep("clarify", 7, {
      state: "Clarification",
      text: clarificationQuestion,
      claims: [],
      followUps: [],
    }),
  ]);
  const clarificationEvents: TraceEvent[] = [];
  const clarificationCalls: SemanticCall[] = [];
  const clarificationResult = await runLiveAlbertTurn({
    message: initialQuestion,
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "high", fastMode: true },
    tenantId: "tenant_flagship",
    role: "owner",
    conversationId: "conversation_flagship",
    turnId: "turn_flagship_clarification",
    modelContext: [{ role: "user", text: initialQuestion }],
    openaiApiKey: "test-only",
    openaiBaseUrl: "https://api.openai.com/v1",
    semanticServiceUrl: "https://semantic.test.invalid",
    semanticSigningSecret: "test-only-signing-secret-with-32-bytes",
    safetyIdentifier: "flagship_test",
    modelProvider: { getModel: () => clarificationModel } satisfies ModelProvider,
    semanticClient: semanticClient(clarificationCalls),
    emit: emitter(clarificationEvents),
  });

  assert.equal(clarificationResult.answerState, "Clarification");
  assert.equal(clarificationModel.requests.length, 7);
  assert.deepEqual(
    clarificationCalls.map(({ name }) => name),
    ["search_catalogue", "get_capabilities", "get_capabilities", "get_data_health", "get_data_health"],
  );
  assert.equal(clarificationEvents.some(({ type }) => type === "table" || type === "chart" || type === "answer"), false);
  const clarification = clarificationEvents.find((event) => event.type === "clarification");
  assert.ok(clarification?.type === "clarification");
  assert.equal(clarification.question, clarificationQuestion);
  assert.deepEqual(clarification.options, [
    { id: "employee.net_sales", label: "Net sales" },
    { id: "employee.gross_margin", label: "Gross profit" },
    { id: "employee.gross_profit_per_labour_hour", label: "Gross profit per worked hour" },
  ]);

  const followUpModel = new ScriptedModel([
    toolStep("answer", 1, "search_catalogue", { question: followUpMessage }),
    toolStep("answer", 2, "get_capabilities", { topic: "workforce_labour" }),
    toolStep("answer", 3, "get_capabilities", { topic: "workforce_sales" }),
    toolStep("answer", 4, "get_data_health", { domain: "workforce" }),
    toolStep("answer", 5, "get_data_health", { domain: "sales" }),
    toolStep("answer", 6, "run_sql", rosterSqlArgs),
    toolStep("answer", 7, "publish_observation", {
      claim: {
        statement: "Worker Sam had Rostered hours of 8.0000.",
        assertion: "value",
        refs: [
          { resultId: rosterResultId, rowIndex: 0, columnKey: "rostered_hours" },
          { resultId: rosterResultId, rowIndex: 0, columnKey: "worker" },
        ],
      },
      nextStep: "check_labour",
    }),
    toolStep("answer", 8, "run_sql", performanceSqlArgs),
    toolStep("answer", 9, "publish_observation", {
      claim: {
        statement: "Worker Sam had the highest Net sales at 15000.0000.",
        assertion: "highest",
        refs: [
          { resultId: performanceResultId, rowIndex: 0, columnKey: "net_sales_ex_gst" },
          { resultId: performanceResultId, rowIndex: 0, columnKey: "worker" },
        ],
      },
      nextStep: "visualise_result",
    }),
    toolStep("answer", 10, "make_chart", {
      dataRef: performanceResultId,
      chartType: "bar",
      xKey: "worker",
      yKey: "net_sales_ex_gst",
    }),
    finalStep("answer", 11, {
      state: "Qualified",
      text: "The governed ranking is ready with its identity-coverage limitation disclosed.",
      claims: [{
        statement: "Worker Sam had the highest Net sales at 15000.0000.",
        assertion: "highest",
        refs: [
          { resultId: performanceResultId, rowIndex: 0, columnKey: "net_sales_ex_gst" },
          { resultId: performanceResultId, rowIndex: 0, columnKey: "worker" },
        ],
      }],
      followUps: ["Would you like to compare this with gross margin?"],
    }),
  ]);
  const followUpEvents: TraceEvent[] = [];
  const followUpCalls: SemanticCall[] = [];
  const followUpResult = await runLiveAlbertTurn({
    message: followUpMessage,
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "high", fastMode: true },
    tenantId: "tenant_flagship",
    role: "owner",
    conversationId: "conversation_flagship",
    turnId: "turn_flagship_answer",
    modelContext: [
      { role: "user", text: initialQuestion },
      { role: "assistant", text: clarificationQuestion },
      { role: "user", text: followUpMessage },
    ],
    confirmedPreference: {
      optionId: "employee.net_sales",
      preference: "employee.performance_default",
      value: "commerce.net_sales_ex_gst",
    },
    openaiApiKey: "test-only",
    openaiBaseUrl: "https://api.openai.com/v1",
    semanticServiceUrl: "https://semantic.test.invalid",
    semanticSigningSecret: "test-only-signing-secret-with-32-bytes",
    safetyIdentifier: "flagship_test",
    modelProvider: { getModel: () => followUpModel } satisfies ModelProvider,
    semanticClient: semanticClient(followUpCalls),
    emit: emitter(followUpEvents),
  });

  assert.equal(followUpResult.answerState, "Qualified");
  assert.deepEqual(followUpResult.queryAuditIds, [rosterQueryAuditId, performanceQueryAuditId]);
  assert.equal(followUpModel.requests.length, 11);
  assert.deepEqual(followUpEvents.map(({ sequence }) => sequence), followUpEvents.map((_, index) => index + 1));

  const eventIndex = (predicate: (event: TraceEvent) => boolean): number => followUpEvents.findIndex(predicate);
  const rosterTableIndex = eventIndex((event) => event.type === "table" && event.resultId === rosterResultId);
  const rosterValidationIndex = followUpEvents.findIndex((event, index) => index > rosterTableIndex && event.type === "validation");
  const rosterObservationIndex = followUpEvents.findIndex((event, index) => index > rosterValidationIndex && event.type === "narrative" && event.text.includes("Rostered hours"));
  const compositeQueryIndex = followUpEvents.findIndex((event, index) => index > rosterObservationIndex && event.type === "query" && event.topic === "sql_first");
  const performanceTableIndex = eventIndex((event) => event.type === "table" && event.resultId === performanceResultId);
  const performanceValidationIndex = followUpEvents.findIndex((event, index) => index > performanceTableIndex && event.type === "validation");
  const performanceObservationIndex = followUpEvents.findIndex((event, index) => index > performanceValidationIndex && event.type === "narrative" && event.text.includes("highest Net sales"));
  const chartIndex = eventIndex((event) => event.type === "chart" && event.dataRef === performanceResultId);
  const answerIndex = eventIndex((event) => event.type === "answer");
  assert.ok(
    rosterTableIndex > 0
      && rosterValidationIndex > rosterTableIndex
      && rosterObservationIndex > rosterValidationIndex
      && compositeQueryIndex > rosterObservationIndex
      && performanceTableIndex > compositeQueryIndex
      && performanceValidationIndex > performanceTableIndex
      && performanceObservationIndex > performanceValidationIndex
      && chartIndex > performanceObservationIndex
      && answerIndex > chartIndex,
    "The streamed flagship trace must remain narrative → table → validation → observation → composite table → validation → observation → chart → answer.",
  );

  const answer = followUpEvents[answerIndex];
  assert.ok(answer?.type === "answer");
  assert.equal(answer.state, "Qualified");
  assert.equal(answer.text, "Worker Sam had the highest Net sales at AUD 15000.");
  assert.deepEqual(answer.provenance.sources.map(({ connector }) => connector), ["lightspeed", "deputy"]);
  assert.equal(answer.provenance.identityGraph.version, 11);

  const queryCalls = followUpCalls.filter(({ name }) => name === "run_sql");
  assert.equal(queryCalls.length, 2);
  assert.deepEqual(queryCalls.map(({ input }) => input), [rosterSqlArgs, performanceSqlArgs]);
  assert.ok(queryCalls.every(({ context }) =>
    context.confirmedPreference === "employee.performance_default"
      && context.confirmedValue === "commerce.net_sales_ex_gst"));
  assert.equal(followUpCalls.some(({ name }) => name === "run_source_query"), false);
  assert.equal(JSON.stringify(queryCalls).includes("overtime"), false);
  const registry = loadRegistryFile(resolve("packages/semantic-registry/registry/registry.yaml"));
  const compilerContext = {
    tenantId: "tenant_flagship",
    role: "owner" as const,
    capabilities: new Set([
      "workforce.shifts",
      "workforce.time_entries",
      "commerce.order_lines",
      "commerce.order_lines.cost",
      "commerce.order_lines.worker_attribution",
    ]),
    now: "2026-08-03T00:00:00.000Z",
    timezone: "Australia/Melbourne",
    tradingDayCutoff: "00:00",
    fiscalYearStartMonth: 7,
    fiscalYearStartDay: 1,
    weekStartsOn: 1,
    tenantParameters: {},
  };
  const compiledRoster = compileSemanticQuery(rosterQuery, registry, compilerContext);
  assert.deepEqual(compiledRoster.sourceTables, ["mart.workforce_day_worker_location"]);
  const compiledComposite = compileSemanticQuery(performanceQuery, registry, compilerContext);
  assert.match(compiledComposite.sql, /FULL OUTER JOIN/u);
  assert.deepEqual([...compiledComposite.sourceTables].sort(), [
    "mart.commerce_sales_event",
    "mart.workforce_day_worker_location",
  ]);
  assert.ok(compiledComposite.resultColumns.includes("net_sales_ex_gst"));
  assert.doesNotMatch(compiledComposite.sql, /commerce_order_line[\s\S]*JOIN[\s\S]*workforce_time_entry/iu);
  const compiledGrossProfitPerHour = compileSemanticQuery(grossProfitPerHourQuery, registry, compilerContext);
  assert.match(compiledGrossProfitPerHour.sql, /FULL OUTER JOIN/u);
  assert.match(compiledGrossProfitPerHour.sql, /"gross_margin"[^\n]*\/ NULLIF\([^\n]*"worked_hours"[^\n]*, 0\)/u);
  assert.ok(compiledGrossProfitPerHour.resultColumns.includes("gross_profit_per_labour_hour"));
  assert.deepEqual(compiledGrossProfitPerHour.sourceTables, [
    "mart.commerce_sales_event",
    "mart.workforce_day_worker_location",
  ]);
  assert.doesNotMatch(compiledGrossProfitPerHour.sql, /commerce_order_line[\s\S]*JOIN[\s\S]*workforce_time_entry/iu);
  assert.deepEqual(
    followUpCalls.map(({ name }) => name),
    [
      "search_catalogue",
      "get_capabilities",
      "get_capabilities",
      "get_data_health",
      "get_data_health",
      "run_sql",
      "run_sql",
    ],
  );
});

test("a claims-empty final cannot swap a governed value onto another row label", async () => {
  const model = new ScriptedModel([
    toolStep("swapped", 1, "search_catalogue", { question: followUpMessage }),
    toolStep("swapped", 2, "get_capabilities", { topic: "workforce_labour" }),
    toolStep("swapped", 3, "get_capabilities", { topic: "workforce_sales" }),
    toolStep("swapped", 4, "get_data_health", { domain: "workforce" }),
    toolStep("swapped", 5, "get_data_health", { domain: "sales" }),
    toolStep("swapped", 6, "run_sql", rosterSqlArgs),
    toolStep("swapped", 7, "publish_observation", {
      claim: {
        statement: "Worker Sam had Rostered hours of 8.0000.",
        assertion: "value",
        refs: [
          { resultId: rosterResultId, rowIndex: 0, columnKey: "rostered_hours" },
          { resultId: rosterResultId, rowIndex: 0, columnKey: "worker" },
        ],
      },
      nextStep: "check_margin",
    }),
    toolStep("swapped", 8, "run_sql", performanceSqlArgs),
    toolStep("swapped", 9, "publish_observation", {
      claim: {
        statement: "Worker Sam had Net sales of 15000.0000.",
        assertion: "value",
        refs: [
          { resultId: performanceResultId, rowIndex: 0, columnKey: "net_sales_ex_gst" },
          { resultId: performanceResultId, rowIndex: 0, columnKey: "worker" },
        ],
      },
      nextStep: "prepare_answer",
    }),
    finalStep("swapped", 10, {
      state: "Qualified",
      text: "Worker Jo had Net sales of 15000.",
      claims: [],
      followUps: [],
    }),
  ]);
  const events: TraceEvent[] = [];
  const calls: SemanticCall[] = [];
  const result = await runLiveAlbertTurn({
    message: followUpMessage,
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "medium", fastMode: false },
    tenantId: "tenant_flagship",
    role: "owner",
    conversationId: "conversation_swapped_claim",
    turnId: "turn_swapped_claim",
    modelContext: [{ role: "user", text: followUpMessage }],
    confirmedPreference: {
      optionId: "employee.net_sales",
      preference: "employee.performance_default",
      value: "commerce.net_sales_ex_gst",
    },
    openaiApiKey: "test-only",
    openaiBaseUrl: "https://api.openai.com/v1",
    semanticServiceUrl: "https://semantic.test.invalid",
    semanticSigningSecret: "test-only-signing-secret-with-32-bytes",
    safetyIdentifier: "swapped_claim_test",
    modelProvider: { getModel: () => model },
    semanticClient: semanticClient(calls),
    emit: emitter(events),
  });

  assert.equal(result.answerState, "Qualified");
  const answer = events.findLast((event) => event.type === "answer");
  assert.ok(answer?.type === "answer");
  assert.equal(
    answer.text,
    "Albert withheld the narrative because a quantitative claim was not bound to its exact governed table cells. The governed table remains available above.",
  );
  assert.equal(answer.text.includes("Worker Jo had Net sales of 15000"), false);
  assert.ok(events.some((event) => event.type === "validation" && event.name === "numeric_grounding"));
});
