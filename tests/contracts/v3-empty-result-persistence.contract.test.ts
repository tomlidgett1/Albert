import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { Agent, AgentOutputType, Runner } from "@openai/agents";

import { loadAgentConfig } from "../../packages/albert-v3/src/agent-config/loader.ts";
import type { CubeCatalogue, CubeLoadResponse } from "../../packages/albert-v3/src/cube/types.ts";
import type { ValidatedCubeQuery } from "../../packages/albert-v3/src/cube/client.ts";
import { createV3CommentaryState } from "../../packages/albert-v3/src/engine/commentary.ts";
import type { V3ToolRoute } from "../../packages/albert-v3/src/engine/connector-routing.ts";
import type { V3TurnContext } from "../../packages/albert-v3/src/engine/context.ts";
import {
  elevatedLaneEffort,
  finalAnswerSchema,
  laneModelSettings,
  renderRequestContext,
  runAnalyticalLane,
  runQuickLane,
  type LaneRunInput,
} from "../../packages/albert-v3/src/engine/lanes.ts";
import { intentSchema } from "../../packages/albert-v3/src/engine/orchestrator.ts";
import {
  createV3Tools,
  executeGovernedCubeQuery,
  relaxDateConstraints,
} from "../../packages/albert-v3/src/engine/tools.ts";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const config = loadAgentConfig();

const VIEW = "xero_finance_analytics";
const DUE_ON = `${VIEW}.due_on`;

test("relaxDateConstraints strips date windows and groups monthly on the constrained member", () => {
  const relaxed = relaxDateConstraints({
    measures: [`${VIEW}.total_amount_due`],
    dimensions: [`${VIEW}.invoice_number`],
    segments: [`${VIEW}.bills`, `${VIEW}.outstanding`],
    timeDimensions: [{ dimension: DUE_ON, dateRange: ["2026-08-13", "2026-08-31"] }],
    filters: [{ member: `${VIEW}.invoice_status`, operator: "equals", values: ["AUTHORISED"] }],
    timezone: "Australia/Melbourne",
  });
  assert.ok(relaxed);
  assert.equal(relaxed.member, DUE_ON);
  assert.equal(relaxed.dropped.length, 1);
  assert.equal(relaxed.windowStart, "2026-08-13");
  assert.equal(relaxed.windowEnd, "2026-08-31");
  // The diagnostic keeps everything that defines what the data is (measures,
  // segments, non-date filters) and drops only the date window and the
  // row-level dimensions.
  assert.deepEqual(relaxed.diagnostic.measures, [`${VIEW}.total_amount_due`]);
  assert.deepEqual(relaxed.diagnostic.segments, [`${VIEW}.bills`, `${VIEW}.outstanding`]);
  assert.equal(relaxed.diagnostic.dimensions, undefined);
  assert.deepEqual(relaxed.diagnostic.timeDimensions, [{ dimension: DUE_ON, granularity: "month" }]);
  assert.deepEqual(relaxed.diagnostic.filters, [
    { member: `${VIEW}.invoice_status`, operator: "equals", values: ["AUTHORISED"] },
  ]);
  assert.deepEqual(relaxed.diagnostic.order, { [DUE_ON]: "asc" });
  assert.equal(relaxed.diagnostic.timezone, "Australia/Melbourne");
});

test("relaxDateConstraints also relaxes date-operator filters, which bypass timeDimensions", () => {
  const relaxed = relaxDateConstraints({
    measures: [`${VIEW}.total_amount_due`],
    filters: [
      { member: DUE_ON, operator: "inDateRange", values: ["2026-08-13", "2026-08-31"] },
      { member: `${VIEW}.invoice_status`, operator: "equals", values: ["AUTHORISED"] },
    ],
  });
  assert.ok(relaxed);
  assert.equal(relaxed.member, DUE_ON);
  assert.equal(relaxed.windowStart, "2026-08-13");
  assert.equal(relaxed.windowEnd, "2026-08-31");
  assert.deepEqual(relaxed.diagnostic.timeDimensions, [{ dimension: DUE_ON, granularity: "month" }]);
  assert.deepEqual(relaxed.diagnostic.filters, [
    { member: `${VIEW}.invoice_status`, operator: "equals", values: ["AUTHORISED"] },
  ]);
});

test("relaxDateConstraints refuses queries it cannot relax faithfully", () => {
  // No date constraint at all: emptiness is not explained by a window.
  assert.equal(relaxDateConstraints({
    measures: [`${VIEW}.total_amount_due`],
    filters: [{ member: `${VIEW}.invoice_status`, operator: "equals", values: ["PAID"] }],
  }), null);
  // A date operator nested in a boolean group cannot be dropped without
  // changing the group's meaning.
  assert.equal(relaxDateConstraints({
    measures: [`${VIEW}.total_amount_due`],
    filters: [{
      or: [
        { member: DUE_ON, operator: "beforeDate", values: ["2026-08-01"] },
        { member: `${VIEW}.invoice_status`, operator: "equals", values: ["PAID"] },
      ],
    }],
  }), null);
});

function stubContext(input: Readonly<{
  loadQuery: (query: unknown) => Promise<Readonly<{
    validated: ValidatedCubeQuery | undefined;
    result: CubeLoadResponse;
  }>>;
}>): V3TurnContext {
  const catalogue: CubeCatalogue = { views: [], fetchedAt: "2026-08-13T00:00:00.000Z" };
  return {
    cube: {
      loadQuery: input.loadQuery,
      fetchCatalogue: async () => catalogue,
    } as unknown as V3TurnContext["cube"],
    config,
    promptCachePartition: "fixturetenant",
    toolRoute: route(),
    emit: async (event) => ({
      ...event,
      id: "01K2K2A6S9W9M4FW4NG4TDD9E1",
      sequence: 1,
      occurredAt: "2026-08-13T00:00:00.000Z",
    } as never),
    budget: { maxQueries: 3, executed: 0 },
    commentary: createV3CommentaryState(false),
    executedQueries: [],
    tableResults: new Map(),
    chartedResultIds: new Set(),
  };
}

test("a zero-row date-windowed query ships with a free diagnostic showing where the data falls", async () => {
  const seen: unknown[] = [];
  const windowedQuery = {
    measures: [`${VIEW}.total_amount_due`],
    segments: [`${VIEW}.bills`],
    timeDimensions: [{ dimension: DUE_ON, dateRange: "2026-08-13,2026-08-31" }],
  };
  const context = stubContext({
    loadQuery: async (query) => {
      seen.push(query);
      const windowed = JSON.stringify(query).includes("2026-08-13");
      const validated: ValidatedCubeQuery = {
        query: query as ValidatedCubeQuery["query"],
        view: VIEW,
        cubes: ["xero_invoices"],
        members: [`${VIEW}.total_amount_due`, DUE_ON],
      };
      return {
        validated,
        result: {
          ok: true,
          rows: windowed
            ? []
            : [
                { [`${DUE_ON}.month`]: "2026-06-01T00:00:00.000", [`${VIEW}.total_amount_due`]: "1200" },
                { [`${DUE_ON}.month`]: "2026-07-01T00:00:00.000", [`${VIEW}.total_amount_due`]: "23844" },
              ],
          annotation: {},
          executionMs: 5,
          cached: false,
        },
      };
    },
  });
  const output = await executeGovernedCubeQuery(context, {
    topic: "Outstanding bills due 13-31 August",
    ...windowedQuery,
  });
  assert.equal(output.ok, true);
  assert.equal(output.rowCount, 0);
  const diagnostic = output.emptyResultDiagnostic as Record<string, unknown>;
  assert.ok(diagnostic, "an empty windowed result must carry its own explanation");
  assert.equal(diagnostic.rowCount, 2);
  // Both months fall before the window, so the nearest-before marker is July
  // and every row survives into the model payload.
  assert.equal(diagnostic.nearestDataBeforeWindow, "2026-07-01");
  assert.equal(diagnostic.nearestDataAfterWindow, undefined);
  assert.equal((diagnostic.rows as unknown[]).length, 2);
  assert.match(String(diagnostic.note), /months of this data closest to the window/u);
  assert.match(String(diagnostic.note), /anything unpaid there is still owed now/u);
  // The diagnostic is free: only the original query consumed budget.
  assert.equal(context.budget.executed, 1);
  assert.equal(context.emptyResultDiagnostics, 1);
  assert.equal(seen.length, 2);
  // The diagnostic run itself was date-unconstrained and month-grouped.
  assert.match(JSON.stringify(seen[1]), /"granularity":"month"/u);
  assert.doesNotMatch(JSON.stringify(seen[1]), /2026-08-13/u);
});

test("a non-empty result never triggers the diagnostic", async () => {
  let calls = 0;
  const context = stubContext({
    loadQuery: async (query) => {
      calls += 1;
      return {
        validated: {
          query: query as ValidatedCubeQuery["query"],
          view: VIEW,
          cubes: ["xero_invoices"],
          members: [`${VIEW}.total_amount_due`],
        },
        result: {
          ok: true,
          rows: [{ [`${VIEW}.total_amount_due`]: "250" }],
          annotation: {},
          executionMs: 5,
          cached: false,
        },
      };
    },
  });
  const output = await executeGovernedCubeQuery(context, {
    topic: "Outstanding bills due 13-31 August",
    measures: [`${VIEW}.total_amount_due`],
    timeDimensions: [{ dimension: DUE_ON, dateRange: "2026-08-13,2026-08-31" }],
  });
  assert.equal(output.ok, true);
  assert.equal(output.emptyResultDiagnostic, undefined);
  assert.equal(calls, 1);
  assert.equal(context.emptyResultDiagnostics ?? 0, 0);
});

function route(): V3ToolRoute {
  return Object.freeze({
    cube: true,
    shopifyQL: false,
    shopifyAdmin: false,
    activeCubeConnectors: Object.freeze(["xero"]),
    preferredCubeConnectors: Object.freeze([]),
    unavailableRequestedConnectors: Object.freeze([]),
    mode: "cube" as const,
    reasons: Object.freeze(["persistence contract fixture"]),
  }) as V3ToolRoute;
}

async function captureLaneInstructions(
  lane: "quick" | "analytical",
): Promise<string> {
  let captured: Agent<unknown, AgentOutputType> | undefined;
  const runner = {
    run: async (agent: Agent<unknown, AgentOutputType>) => {
      captured = agent;
      return {
        finalOutput: {
          answer: "Fixture answer.",
          state: "Verified",
          followUps: ["Show me the detail"],
          assumptionsDisclosed: [],
        },
      };
    },
  } as unknown as Runner;
  const toolRoute = route();
  const context: V3TurnContext = {
    cube: {} as V3TurnContext["cube"],
    config,
    promptCachePartition: "fixturetenant",
    toolRoute,
    emit: async (event) => ({
      ...event,
      id: "01K2K2A6S9W9M4FW4NG4TDD9E1",
      sequence: 1,
      occurredAt: "2026-08-13T00:00:00.000Z",
    } as never),
    budget: { maxQueries: 8, executed: 0 },
    commentary: createV3CommentaryState(lane === "analytical"),
    executedQueries: [],
    tableResults: new Map(),
    chartedResultIds: new Set(),
  };
  const input: LaneRunInput = {
    runner,
    preferences: { model: "gpt-5.6-luna", reasoningEffort: "medium", fastMode: false },
    config,
    catalogue: { views: [], fetchedAt: "2026-08-13T00:00:00.000Z" },
    context,
    conversation: [],
    intent: {
      lane,
      resolvedQuestion: "What invoices do we have due end of August?",
      ownerGoal: "Plan which supplier payments must go out this month.",
      answerMustCover: ["Anything already overdue and unpaid"],
      assumptions: [],
      clarificationQuestion: null,
      clarificationOptions: [],
    },
  };
  await (lane === "quick" ? runQuickLane : runAnalyticalLane)(input);
  assert.ok(captured);
  if (typeof captured.instructions !== "string") throw new Error("dynamic instructions");
  return captured.instructions;
}

test("the quick lane can escalate instead of hedging; the analytical lane must resolve", async () => {
  assert.ok(finalAnswerSchema.shape.state.options.includes("Escalate"));

  const quick = await captureLaneInstructions("quick");
  assert.match(quick, /return state=Escalate/u);
  assert.match(quick, /Escalating always\s+beats hedging/u);
  assert.match(quick, /lead to investigate, not an answer to report/u);
  assert.match(quick, /Money owed stays owed until paid/u);
  assert.doesNotMatch(quick, /Do not over-investigate\./u);

  const analytical = await captureLaneInstructions("analytical");
  assert.match(analytical, /never return state=Escalate/u);
  assert.match(analytical, /lead to investigate, not an answer to report/u);
  assert.match(analytical, /Money owed stays owed until paid/u);
});

test("the intent agent infers a goal and useful-answer criteria that reach every lane", () => {
  const shape = intentSchema.shape;
  assert.ok(shape.ownerGoal);
  assert.ok(shape.answerMustCover);

  const context = renderRequestContext({
    config,
    question: "What bills are due in August?",
    ownerGoal: "Plan which supplier payments must go out this month.",
    answerMustCover: ["Anything already overdue and unpaid", "What falls due inside August"],
  });
  assert.match(context, /Owner's practical goal: Plan which supplier payments/u);
  assert.match(context, /A useful answer must cover:\n- Anything already overdue and unpaid\n- What falls due inside August/u);

  const orchestrator = read("packages/albert-v3/src/engine/orchestrator.ts");
  assert.match(orchestrator, /answerMustCover: up to 4 short points/u);
});

test("the user's reasoning effort is a floor for lane effort, never silently downgraded", () => {
  assert.equal(elevatedLaneEffort("low", "max"), "xhigh");
  assert.equal(elevatedLaneEffort("low", "high"), "high");
  assert.equal(elevatedLaneEffort("high", "low"), "high");
  assert.equal(elevatedLaneEffort("medium", undefined), "medium");
  const settings = laneModelSettings(
    { model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: false },
    "low",
  );
  assert.equal(settings.reasoning?.effort, "xhigh");
});

test("the visible plan tool ships on the analytical lane and its events pass the persistence gate", () => {
  const names = (lane: "quick" | "analytical") =>
    createV3Tools({ route: route(), lane, purpose: "answer" }).map((tool) => tool.name);
  assert.ok(names("analytical").includes("update_plan"));
  assert.equal(names("quick").includes("update_plan"), false);

  // The analytical prompt instructs the model to maintain the plan, and the
  // control-plane append gate accepts 'plan' events (migration 0140).
  const lanes = read("packages/albert-v3/src/engine/lanes.ts");
  assert.match(lanes, /call update_plan with 2-5 short owner-readable steps/u);
  const migration = read("infra/migrations/control-plane/0140_m8_plan_trace_events.sql");
  assert.match(migration, /'progress', 'narrative', 'plan', 'query', 'table', 'chart',/u);
});

test("the engine escalates a quick turn on state=Escalate with a refilled budget and never ships Escalate", () => {
  const engine = read("packages/albert-v3/src/engine/engine.ts");
  // Escalation triggers the analytical rerun alongside the existing
  // no-answer/no-query fallbacks.
  assert.match(engine, /askedToEscalate = lane === "quick" && finalAnswer\?\.state === "Escalate"/u);
  assert.match(engine, /!finalAnswer \|\| ranNoQueries \|\| askedToEscalate/u);
  // A surprise refills the budget rather than inheriting the spent quick allowance.
  assert.match(engine, /context\.budget\.executed \+ config\.lanes\.analytical\.maxQueries/u);
  // Escalate is engine-internal and is coerced before the answer ships.
  assert.match(engine, /finalAnswer\.state === "Escalate" \? "Exploratory" : finalAnswer\.state/u);
});
