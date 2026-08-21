import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import type { Runner } from "@openai/agents";

import { loadAgentConfig, type CertifiedQuery } from "../../packages/albert-v3/src/agent-config/loader.js";
import type { ValidatedCubeQuery } from "../../packages/albert-v3/src/cube/client.js";
import type { CubeCatalogue, CubeLoadResponse, CubeQuery } from "../../packages/albert-v3/src/cube/types.js";
import { createV3CommentaryState } from "../../packages/albert-v3/src/engine/commentary.js";
import type { V3ToolRoute } from "../../packages/albert-v3/src/engine/connector-routing.js";
import type { StoredTableResult, V3TurnContext } from "../../packages/albert-v3/src/engine/context.js";
import type { LaneRunInput } from "../../packages/albert-v3/src/engine/lanes.js";
import {
  renderDeterministicRecipeAnswer,
  runRecipeLane,
} from "../../packages/albert-v3/src/engine/recipe-lane.js";
import { DEFAULT_AGENT_PREFERENCES } from "../../packages/shared/src/index.js";

const MEMBER = Object.freeze({
  customers: "customer_analytics.customer_count",
  orders: "customer_analytics.average_orders",
  repeatRate: "customer_analytics.repeat_purchase_rate_pct",
  value: "customer_analytics.total_lifetime_net_spend",
  asAt: "customer_analytics.last_purchase_at",
  segment: "customer_analytics.customer_group",
});

const TEMPLATE = [
  `We have {{${MEMBER.customers}|integer}} customers,`,
  `averaging {{${MEMBER.orders}|number}} orders,`,
  `with a {{${MEMBER.repeatRate}|percent}} repeat rate and`,
  `{{${MEMBER.value}|currency}} in value as at {{${MEMBER.asAt}|date}}.`,
  `Segment: {{${MEMBER.segment}|text}}.`,
].join(" ");

function deterministicRecipe(overrides: Partial<NonNullable<CertifiedQuery["recipe"]>> = {}): CertifiedQuery {
  return {
    name: "fixture-customer-answer",
    userRequest: "Give me the customer headline.",
    notes: "fixture",
    query: { measures: Object.values(MEMBER) },
    recipe: {
      presentation: "fact",
      answerTemplate: TEMPLATE,
      followUps: ["Which customers drove that value?", "How does this compare with last year?"],
      ...overrides,
    },
  };
}

function deterministicTable(): Pick<StoredTableResult, "columns" | "rows"> {
  return {
    columns: [
      { key: MEMBER.customers, label: "Customers", type: "number" },
      { key: MEMBER.orders, label: "Average orders", type: "number" },
      { key: MEMBER.repeatRate, label: "Repeat rate", type: "percent" },
      { key: MEMBER.value, label: "Lifetime value", type: "currency", currency: "AUD" },
      { key: MEMBER.asAt, label: "Last purchase", type: "datetime" },
      { key: MEMBER.segment, label: "Group", type: "string" },
    ],
    rows: [
      {
        [MEMBER.customers]: "1234",
        [MEMBER.orders]: "12.345",
        [MEMBER.repeatRate]: "37.5",
        [MEMBER.value]: "12345.6",
        [MEMBER.asAt]: "2026-08-20T00:00:00.000Z",
        [MEMBER.segment]: "Local *VIP* [north]",
      },
      {
        [MEMBER.customers]: "999999",
        [MEMBER.orders]: "999",
        [MEMBER.repeatRate]: "99",
        [MEMBER.value]: "999999",
        [MEMBER.asAt]: "2025-01-01T00:00:00.000Z",
        [MEMBER.segment]: "second row must not render",
      },
    ],
  };
}

const renderOptions = Object.freeze({
  currency: "AUD",
  timezone: "Australia/Melbourne",
  locale: "en-AU",
});

test("deterministic recipe renderer formats exact first-row cells and static owner follow-ups", () => {
  const answer = renderDeterministicRecipeAnswer(deterministicRecipe(), deterministicTable(), renderOptions);
  assert.deepEqual(answer, {
    answer: "We have 1,234 customers, averaging 12.35 orders, with a 37.5% repeat rate and $12,345.60 in value as at 20 Aug 2026. Segment: Local \\*VIP\\* \\[north\\].",
    state: "Verified",
    followUps: ["Which customers drove that value?", "How does this compare with last year?"],
    assumptionsDisclosed: [],
  });
});

test("deterministic recipe renderer fails closed on missing, null, malformed, or incompatible values", () => {
  const valid = deterministicTable();
  const first = { ...valid.rows[0] };
  delete first[MEMBER.customers];
  assert.equal(renderDeterministicRecipeAnswer(deterministicRecipe(), { ...valid, rows: [first] }, renderOptions), undefined);
  assert.equal(renderDeterministicRecipeAnswer(
    deterministicRecipe(),
    { ...valid, rows: [{ ...valid.rows[0], [MEMBER.value]: null }] },
    renderOptions,
  ), undefined);
  assert.equal(renderDeterministicRecipeAnswer(
    deterministicRecipe(),
    { ...valid, rows: [{ ...valid.rows[0], [MEMBER.customers]: "12.5" }] },
    renderOptions,
  ), undefined, "integer formatting never rounds a fractional value");
  assert.equal(renderDeterministicRecipeAnswer(
    deterministicRecipe({ answerTemplate: `Value: {{${MEMBER.customers}|currency}}` }),
    valid,
    renderOptions,
  ), undefined, "a number column cannot masquerade as governed currency");
  assert.equal(renderDeterministicRecipeAnswer(
    deterministicRecipe({ answerTemplate: `Value: {{${MEMBER.value}|money}}` }),
    valid,
    renderOptions,
  ), undefined, "unknown formats retain a literal brace and fail closed");
  assert.equal(renderDeterministicRecipeAnswer(
    deterministicRecipe({ followUps: ["Would you like me to contact these customers?"] }),
    valid,
    renderOptions,
  ), undefined, "assistant offers are not owner-voice follow-ups");
});

test("generator validates template members, formats, lengths, and owner-voice follow-ups", () => {
  const source = String.raw`
    import assert from "node:assert/strict";
    process.argv.push("--check");
    const generator = await import("./scripts/generate-albert-v3-agent-config.mts");
    const query = {
      measures: ["customer_analytics.customer_count"],
      timeDimensions: [{ dimension: "customer_analytics.created_at", granularity: "month" }],
    };
    assert.equal(
      generator.validateRecipeAnswerTemplate(
        "{{customer_analytics.customer_count|integer}} through {{customer_analytics.created_at.month|date}}",
        query,
        "fixture.md",
      ),
      "{{customer_analytics.customer_count|integer}} through {{customer_analytics.created_at.month|date}}",
    );
    assert.throws(() => generator.validateRecipeAnswerTemplate("{{customer_analytics.unknown|integer}}", query, "fixture.md"), /not an exact member/);
    assert.throws(() => generator.validateRecipeAnswerTemplate("{{customer_analytics.customer_count|money}}", query, "fixture.md"), /must be/);
    assert.throws(() => generator.validateRecipeAnswerTemplate("{{customer_analytics.customer_count|integer}", query, "fixture.md"), /member placeholders|malformed/);
    assert.throws(() => generator.validateRecipeAnswerTemplate("x".repeat(2001), query, "fixture.md"), /1-2000/);
    assert.deepEqual(generator.validateRecipeFollowUps(["Break this down by customer group"], "fixture.md"), ["Break this down by customer group"]);
    assert.throws(() => generator.validateRecipeFollowUps(["I can break this down"], "fixture.md"), /owner-voice/);
    assert.throws(() => generator.validateRecipeFollowUps(["Show the trend", "show the trend"], "fixture.md"), /unique/);
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
});

function lightspeedRoute(): V3ToolRoute {
  return Object.freeze({
    cube: true,
    shopifyQL: false,
    shopifyAdmin: false,
    activeCubeConnectors: Object.freeze(["lightspeed"]),
    preferredCubeConnectors: Object.freeze(["lightspeed"]),
    unavailableRequestedConnectors: Object.freeze([]),
    mode: "cube" as const,
    reasons: Object.freeze(["deterministic recipe fixture"]),
  }) as V3ToolRoute;
}

function laneContext(rows: readonly Readonly<Record<string, unknown>>[]): V3TurnContext {
  const config = loadAgentConfig();
  const catalogue: CubeCatalogue = { views: [], fetchedAt: "2026-08-20T00:00:00.000Z" };
  return {
    cube: {
      loadQuery: async (query: CubeQuery): Promise<Readonly<{ validated: ValidatedCubeQuery; result: CubeLoadResponse }>> => ({
        validated: {
          query: query as ValidatedCubeQuery["query"],
          view: "customer_analytics",
          cubes: ["customers"],
          members: [MEMBER.customers],
        },
        result: {
          ok: true,
          rows,
          annotation: {
            [MEMBER.customers]: {
              title: "Customer count",
              shortTitle: "Customers",
              type: "number",
            },
          },
          executionMs: 3,
          cached: true,
        },
      }),
      fetchCatalogue: async () => catalogue,
    } as unknown as V3TurnContext["cube"],
    config,
    promptCachePartition: "fixturetenant",
    toolRoute: lightspeedRoute(),
    emit: async (event) => ({
      ...event,
      id: "01K2K2A6S9W9M4FW4NG4TDD9E1",
      sequence: 1,
      occurredAt: "2026-08-20T00:00:00.000Z",
    } as never),
    budget: { maxQueries: 3, executed: 0 },
    connectorFreshness: [],
    sourceFindings: [],
    commentary: createV3CommentaryState(false),
    executedQueries: [],
    tableResults: new Map(),
    priorResults: new Map(),
    chartedResultIds: new Set(),
  };
}

function laneInput(context: V3TurnContext, runner: Runner): LaneRunInput {
  return {
    runner,
    preferences: DEFAULT_AGENT_PREFERENCES,
    config: context.config,
    catalogue: { views: [], fetchedAt: "2026-08-20T00:00:00.000Z" },
    context,
    conversation: [],
    intent: { resolvedQuestion: "How many customers do we have?" } as LaneRunInput["intent"],
  };
}

test("a valid one-row recipe returns immediately after its governed query with zero composer requests", async () => {
  const context = laneContext([{ [MEMBER.customers]: "42" }]);
  let composerRequests = 0;
  const runner = {
    run: async () => {
      composerRequests += 1;
      throw new Error("the deterministic recipe must not invoke the composer");
    },
  } as unknown as Runner;
  const recipe: CertifiedQuery = {
    name: "fixture-customer-count",
    userRequest: "How many customers do we have?",
    notes: "fixture",
    query: { measures: [MEMBER.customers] },
    recipe: {
      presentation: "fact",
      answerTemplate: `We have {{${MEMBER.customers}|integer}} customer profiles on file.`,
      followUps: ["How many of them have purchased from us?"],
    },
  };

  const answer = await runRecipeLane(laneInput(context, runner), recipe, undefined, null);
  assert.deepEqual(answer, {
    answer: "We have 42 customer profiles on file.",
    state: "Verified",
    followUps: ["How many of them have purchased from us?"],
    assumptionsDisclosed: [],
  });
  assert.equal(composerRequests, 0);
  assert.equal(context.executedQueries.length, 1);
  assert.equal(context.budget.executed, 1);
});

test("empty_answer remains a verified true negative through the existing composer fallback", async () => {
  const context = laneContext([]);
  let composerRequests = 0;
  const finalOutput = {
    answer: "There are no customer profiles on file.",
    state: "Verified" as const,
    followUps: [],
    assumptionsDisclosed: [],
  };
  const runner = {
    run: async () => {
      composerRequests += 1;
      return { finalOutput };
    },
  } as unknown as Runner;
  const recipe: CertifiedQuery = {
    name: "fixture-empty-customers",
    userRequest: "Do we have any customers?",
    notes: "fixture",
    query: { measures: [MEMBER.customers] },
    recipe: {
      presentation: "fact",
      answerTemplate: `We have {{${MEMBER.customers}|integer}} customer profiles on file.`,
      emptyAnswer: "there are no customer profiles on file",
    },
  };

  const answer = await runRecipeLane(laneInput(context, runner), recipe, undefined, null);
  assert.deepEqual(answer, finalOutput);
  assert.equal(composerRequests, 1);
  assert.equal(context.emptyResultIsAnswer, true);
});
