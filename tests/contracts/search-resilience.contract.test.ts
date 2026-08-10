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
import type { TraceEvent } from "../../packages/shared/src/index.js";
import {
  createTraceEmitter,
  inconclusiveSearchNeedsRecovery,
  inconclusiveSearchRecoveryInput,
  runLiveAlbertTurn,
  sqlStatementSignature,
} from "../../services/conversation/src/live.js";
import { intentPlanSchema } from "../../services/conversation/src/intent-plan.js";

const question = "what is the customer for mobile 0428889749";
const bundleHash = "a".repeat(64);

const lookupIntentPlan = intentPlanSchema.parse({
  disposition: "answer",
  caseId: null,
  domain: "customers",
  grain: "unknown",
  namedEntities: ["0428889749"],
  tables: [
    "source_lightspeed.ls_contact_phones",
    "source_lightspeed.ls_contacts",
    "source_lightspeed.ls_customers",
  ],
  planSteps: [
    "Inspect the available customer phone records",
    "Match the supplied mobile robustly",
    "Check whether the match is unique",
  ],
  summary: "Looking up the supplied mobile across customer contact records",
  clarification: null,
  unavailableReason: null,
});

const exactSql = `SELECT c.first_name, c.last_name, CAST(cp.phone AS text) AS stored_phone
FROM source_lightspeed.ls_contact_phones cp
JOIN source_lightspeed.ls_contacts c ON c.contact_id = cp.contact_id
WHERE CAST(cp.phone AS text) = '0428889749'`;

const punctuationNormalisedSql = `SELECT c.first_name, c.last_name, CAST(cp.phone AS text) AS stored_phone
FROM source_lightspeed.ls_contact_phones cp
JOIN source_lightspeed.ls_contacts c ON c.contact_id = cp.contact_id
WHERE regexp_replace(CAST(cp.phone AS text), '[^0-9]', '', 'g') = '0428889749'`;

const storageShapeSql = `SELECT c.first_name, c.last_name, CAST(cp.phone AS text) AS stored_phone
FROM source_lightspeed.ls_contact_phones cp
JOIN source_lightspeed.ls_contacts c ON c.contact_id = cp.contact_id
WHERE right(regexp_replace(CAST(cp.phone AS text), '[^0-9]', '', 'g'), 9)
    = right('0428889749', 9)`;

const alternateRelationshipSql = `SELECT cu.first_name, cu.last_name, CAST(cu.phone AS text) AS stored_phone
FROM source_lightspeed.ls_customers cu
WHERE right(regexp_replace(CAST(cu.phone AS text), '[^0-9]', '', 'g'), 9)
    = right('0428889749', 9)`;

const typeMismatchSql = `SELECT COALESCE(cp.phone, '') AS stored_phone
FROM source_lightspeed.ls_contact_phones cp
WHERE CAST(cp.phone AS text) = '0428889749'`;

const provenance = Object.freeze({
  bundleHash,
  registryVersion: "2026-08-09.1",
  identityGraph: Object.freeze({ version: 1, hash: "b".repeat(32) }),
  sources: Object.freeze(["ls_contact_phones", "ls_contacts", "ls_customers"]),
  sourceWatermarks: Object.freeze({ ls_contact_phones: "2026-08-09T03:30:00.000Z" }),
  sourceDetails: Object.freeze([{
    connectorId: "lightspeed-r",
    connectionId: "conn_lightspeed",
    label: "Lightspeed Retail",
    dataThrough: "2026-08-09T03:30:00.000Z",
  }]),
  definitionsApplied: Object.freeze(["sql_first"]),
  definitionDetails: Object.freeze([{
    id: "sql_first",
    label: "SQL-first statement",
    definition: "Read-only customer contact lookup.",
  }]),
  timeRange: Object.freeze({
    label: "Available customer records",
    start: "0001-01-01T00:00:00.000Z",
    end: "2026-08-09T03:30:00.000Z",
    timezone: "Australia/Melbourne",
  }),
});

function sqlResponse(
  index: number,
  rows: readonly Readonly<Record<string, string>>[],
): SemanticToolResponse {
  const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
  return semanticToolResponseSchema.parse({
    state: "exploratory",
    resultId: `lookup_result_${index}`,
    provenance,
    data: {
      columns,
      rows,
      resultWindow: {
        requestedLimit: 20,
        orderedBeforeLimit: true,
        orderBy: [],
      },
    },
    queryAudit: {
      queryAuditId: [
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      ][index - 1],
      route: "sql_first",
      bundleHash,
      registryVersion: "2026-08-09.1",
      resultDigest: String(index).repeat(64),
      compilerOutputHash: String(index + 1).repeat(64),
    },
    validation: { status: "passed", checks: [], warnings: [] },
    performance: { cacheHit: false, durationMs: 4, rowCount: rows.length },
  });
}

type ScriptStep = Readonly<{
  responseId: string;
  output: Readonly<Record<string, unknown>>;
}>;

function toolStep(index: number, name: string, argumentsValue: Readonly<Record<string, unknown>>): ScriptStep {
  return Object.freeze({
    responseId: `resp_resilience_${index}`,
    output: Object.freeze({
      type: "function_call",
      callId: `call_resilience_${index}`,
      name,
      arguments: JSON.stringify(argumentsValue),
      status: "completed",
    }),
  });
}

function answerStep(index: number, text: string): ScriptStep {
  return Object.freeze({
    responseId: `resp_resilience_${index}`,
    output: Object.freeze({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text: JSON.stringify({
          state: "Exploratory",
          text,
          claims: [],
          followUps: [],
          scope: null,
          resolvedSubject: {
            label: "Mobile 0428889749",
            kind: "customer mobile lookup",
            resolvedQuestion: question,
          },
          presentation: { resultIds: [] },
        }),
      }],
    }),
  });
}

class SearchResilienceModel implements Model {
  readonly requests: ModelRequest[] = [];
  private cursor = 0;

  constructor(private readonly steps: readonly ScriptStep[]) {}

  private next(request: ModelRequest): ScriptStep {
    this.requests.push(request);
    const step = this.steps[this.cursor++];
    if (!step) throw new Error("The search resilience run made an unexpected model request.");
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

type SemanticOutcome = SemanticToolResponse | Error;

async function runScenario(
  id: string,
  steps: readonly ScriptStep[],
  outcomes: readonly SemanticOutcome[],
): Promise<Readonly<{
  answer: Extract<TraceEvent, { type: "answer" }>;
  events: readonly TraceEvent[];
  model: SearchResilienceModel;
  sqlCalls: readonly string[];
}>> {
  const model = new SearchResilienceModel(steps);
  const events: TraceEvent[] = [];
  const sqlCalls: string[] = [];
  let outcomeCursor = 0;
  const semanticClient = {
    async execute(name: RemoteSemanticAgentToolName, input: unknown): Promise<SemanticToolResponse> {
      assert.equal(name, "run_sql");
      const sql = String(Reflect.get(input as object, "sql"));
      sqlCalls.push(sql);
      const outcome = outcomes[outcomeCursor++];
      if (!outcome) throw new Error(`No semantic outcome configured for SQL call ${outcomeCursor}.`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  const emit = createTraceEmitter({
    persist: async (event) => { events.push(event); },
    deliver: () => undefined,
  });

  await runLiveAlbertTurn({
    message: question,
    preferences: { model: "gpt-5.6-sol", reasoningEffort: "high", fastMode: true },
    tenantId: `tenant_${id}`,
    role: "owner",
    conversationId: `conversation_${id}`,
    turnId: `turn_${id}`,
    modelContext: [{ role: "user", text: question }],
    openaiApiKey: "test-only",
    openaiBaseUrl: "https://api.openai.com/v1",
    semanticServiceUrl: "https://semantic.test.invalid",
    semanticSigningSecret: "test-only-signing-secret-with-32-bytes",
    safetyIdentifier: `safety_${id}`,
    modelProvider: { getModel: () => model } satisfies ModelProvider,
    semanticClient,
    resolveIntentPlan: async () => lookupIntentPlan,
    reviewTerminalAnswer: async () => ({
      verdict: "pass",
      reason: "The answer is relevant to the recovered mobile lookup.",
      repairInstruction: null,
    }),
    emit,
  });

  const answer = events.findLast((event): event is Extract<TraceEvent, { type: "answer" }> => event.type === "answer");
  assert.ok(answer, "the scenario must emit an owner-facing answer");
  return { answer, events, model, sqlCalls };
}

const initialEmptySteps = Object.freeze([
  toolStep(1, "update_analysis_plan", {
    summary: "Match the mobile to a customer contact",
    steps: ["Search the phone records", "Check the linked customer", "Report only a supported match"],
    reason: "initial",
  }),
  toolStep(2, "run_sql", { purpose: "Exact customer mobile match", sql: exactSql, limit: 20 }),
  toolStep(3, "run_sql", { purpose: "Punctuation-normalised customer mobile match", sql: punctuationNormalisedSql, limit: 20 }),
  answerStep(4, "I could not match mobile 0428889749 in the attempted customer phone records."),
] as const);

const recoveryPlanStep = toolStep(5, "update_analysis_plan", {
  summary: "The empty matches may reflect the stored phone representation",
  steps: [
    "Reason from the numeric field shape",
    "Compare the significant subscriber digits",
    "Return every candidate so ambiguity remains visible",
  ],
  reason: "recovery",
});

test("empty exact and punctuation matches reopen the analyst and recover a dropped-leading-zero record", async () => {
  const scenario = await runScenario(
    "leading_zero",
    [
      ...initialEmptySteps,
      recoveryPlanStep,
      toolStep(6, "run_sql", {
        purpose: "Match the significant mobile digits against the numeric storage shape",
        sql: storageShapeSql,
        limit: 20,
      }),
      answerStep(7, "Mobile 0428889749 is linked to Jane Nguyen."),
    ],
    [
      sqlResponse(1, []),
      sqlResponse(2, []),
      sqlResponse(3, [{ first_name: "Jane", last_name: "Nguyen", stored_phone: "428889749" }]),
    ],
  );

  assert.equal(scenario.sqlCalls.length, 3);
  assert.equal(new Set(scenario.sqlCalls.map(sqlStatementSignature)).size, 3);
  assert.match(scenario.answer.text, /linked to Jane Nguyen/iu);
  assert.doesNotMatch(scenario.answer.text, /could not match/iu);
  assert.ok(scenario.events.some((event) =>
    event.type === "validation" && event.name === "search_resilience" && event.outcome === "passed"));
  assert.match(JSON.stringify(scenario.model.requests), /SEARCH RESILIENCE CONTINUATION/u);
});

test("cosmetically renamed duplicate SQL is refused without consuming another database attempt", async () => {
  const scenario = await runScenario(
    "duplicate_retry",
    [
      ...initialEmptySteps,
      recoveryPlanStep,
      toolStep(6, "run_sql", {
        purpose: "A newly worded purpose for the same exact search",
        sql: `  ${exactSql}\n; `,
        limit: 20,
      }),
      toolStep(7, "run_sql", {
        purpose: "Use the stored numeric shape instead of repeating the exact comparison",
        sql: storageShapeSql,
        limit: 20,
      }),
      answerStep(8, "Mobile 0428889749 is linked to Jane Nguyen."),
    ],
    [
      sqlResponse(1, []),
      sqlResponse(2, []),
      sqlResponse(3, [{ first_name: "Jane", last_name: "Nguyen", stored_phone: "428889749" }]),
    ],
  );

  assert.equal(scenario.sqlCalls.length, 3, "the duplicate is rejected before semantic execution");
  assert.deepEqual(scenario.sqlCalls, [exactSql, punctuationNormalisedSql, storageShapeSql]);
  assert.match(scenario.answer.text, /linked to Jane Nguyen/iu);
});

test("recovery surfaces conflicting normalized candidates instead of inventing one owner", async () => {
  const scenario = await runScenario(
    "ambiguous",
    [
      ...initialEmptySteps,
      recoveryPlanStep,
      toolStep(6, "run_sql", {
        purpose: "Return every customer sharing the significant mobile digits",
        sql: storageShapeSql,
        limit: 20,
      }),
      answerStep(7, "I found two customer records for mobile 0428889749: Jane Nguyen and John Smith, so I cannot identify one owner safely."),
    ],
    [
      sqlResponse(1, []),
      sqlResponse(2, []),
      sqlResponse(3, [
        { first_name: "Jane", last_name: "Nguyen", stored_phone: "428889749" },
        { first_name: "John", last_name: "Smith", stored_phone: "+61 428 889 749" },
      ]),
    ],
  );

  assert.match(scenario.answer.text, /Jane Nguyen.*John Smith/isu);
  assert.match(scenario.answer.text, /cannot identify one owner safely/iu);
  assert.equal(scenario.answer.state, "Exploratory");
});

test("a SQL type failure remains recoverable and does not become a false no-match", async () => {
  const scenario = await runScenario(
    "sql_failure",
    [
      toolStep(1, "update_analysis_plan", {
        summary: "Match the mobile across linked customer records",
        steps: ["Search the phone records", "Repair field-type problems", "Verify any customer match"],
        reason: "initial",
      }),
      toolStep(2, "run_sql", { purpose: "Exact customer mobile match", sql: typeMismatchSql, limit: 20 }),
      toolStep(3, "update_analysis_plan", {
        summary: "Repair the mixed phone field types",
        steps: ["Cast phone fields consistently", "Retry the exact normalized comparison"],
        reason: "recovery",
      }),
      toolStep(4, "run_sql", { purpose: "Corrected exact customer mobile match", sql: punctuationNormalisedSql, limit: 20 }),
      answerStep(5, "I could not match mobile 0428889749 after correcting the field type."),
      toolStep(6, "update_analysis_plan", {
        summary: "The corrected empty result may still reflect numeric storage",
        steps: ["Account for the stored digit shape", "Check all returned candidates"],
        reason: "recovery",
      }),
      toolStep(7, "run_sql", {
        purpose: "Match significant digits after the corrected typed comparison",
        sql: storageShapeSql,
        limit: 20,
      }),
      answerStep(8, "Mobile 0428889749 is linked to Jane Nguyen."),
    ],
    [
      new Error("COALESCE types numeric and text cannot be matched"),
      sqlResponse(1, []),
      sqlResponse(2, [{ first_name: "Jane", last_name: "Nguyen", stored_phone: "428889749" }]),
    ],
  );

  assert.equal(scenario.sqlCalls.length, 3);
  assert.match(scenario.answer.text, /linked to Jane Nguyen/iu);
  assert.ok(scenario.events.some((event) => event.type === "progress" && event.status === "error"));
  assert.ok(scenario.events.some((event) =>
    event.type === "validation" && event.name === "search_resilience" && event.outcome === "passed"));
});

test("a true no-match is accepted only after materially distinct recovery routes remain empty", async () => {
  const scenario = await runScenario(
    "true_no_match",
    [
      ...initialEmptySteps,
      recoveryPlanStep,
      toolStep(6, "run_sql", {
        purpose: "Match significant digits against the contact phone storage shape",
        sql: storageShapeSql,
        limit: 20,
      }),
      toolStep(7, "run_sql", {
        purpose: "Check the alternate customer-level phone relationship",
        sql: alternateRelationshipSql,
        limit: 20,
      }),
      answerStep(8, "I found no customer match for mobile 0428889749 after checking the distinct contact and customer phone routes."),
    ],
    [sqlResponse(1, []), sqlResponse(2, []), sqlResponse(3, []), sqlResponse(4, [])],
  );

  assert.equal(scenario.sqlCalls.length, 4);
  assert.equal(new Set(scenario.sqlCalls.map(sqlStatementSignature)).size, 4);
  assert.match(scenario.answer.text, /no customer match/iu);
  assert.ok(scenario.events.some((event) =>
    event.type === "validation" && event.name === "search_resilience" && event.outcome === "qualified"));
});

test("the generic recovery contract does not encode identifier-specific variants", () => {
  const fakeResults = new Map([["empty", {
    resultId: "empty",
    columns: [],
    rows: [],
    provenance: {
      sources: [],
      timeRange: { label: "test", start: "0", end: "1", timezone: "Australia/Melbourne" },
      definitions: [],
      semanticBundleHash: "x",
      identityGraph: { version: 0, hash: "y" },
    },
    validations: [],
  }]]);
  assert.equal(inconclusiveSearchNeedsRecovery(fakeResults), true);
  const instruction = inconclusiveSearchRecoveryInput({
    question: "Find record X",
    successfulEmptyQueries: 1,
    failedQueries: 0,
  });
  assert.match(instruction, /model|yourself|decide|actual schema|stored shape/iu);
  assert.doesNotMatch(instruction, /\+61|leading zero|Australian phone|email format|SKU format/iu);
  assert.equal(
    sqlStatementSignature("SELECT phone FROM contacts WHERE id = 'CaseSensitive';"),
    sqlStatementSignature("select PHONE /* cosmetic */ from CONTACTS where ID='CaseSensitive' -- same query"),
  );
  assert.notEqual(
    sqlStatementSignature("SELECT phone FROM contacts WHERE id = 'CaseSensitive'"),
    sqlStatementSignature("SELECT phone FROM contacts WHERE id = 'casesensitive'"),
  );
});
