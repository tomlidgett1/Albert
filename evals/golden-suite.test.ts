import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  compileSemanticQuery,
  SemanticCompilerError,
} from "../packages/compiler/src/index.js";
import {
  buildRegistry,
  loadRegistryFile,
  parseRegistryDocument,
} from "../packages/semantic-registry/src/index.js";
import { compileSourceQuery } from "../services/semantic-query/src/index.js";
import {
  FIXTURE_NOW,
  FIXTURE_TENANT_ID,
} from "./fixtures/retail.js";
import {
  FIXTURE_LIGHTSPEED_CONNECTION_ID,
  sourceFixtureCatalogue,
} from "./fixtures/source.js";
import { seedGoldenQuestions } from "./golden/questions.js";
import { runSeedGoldenSuite } from "./runner.js";

const registryPath = resolve("packages/semantic-registry/registry/registry.yaml");
const registry = loadRegistryFile(registryPath);
const compilerContext = {
  tenantId: FIXTURE_TENANT_ID,
  role: "owner" as const,
  capabilities: new Set(
    [
      ...[...registry.metrics.values()].flatMap((metric) => metric.requiredCapabilities),
      ...[...registry.topics.values()].flatMap((topic) => topic.requiredCapabilities),
    ],
  ),
  now: FIXTURE_NOW,
  timezone: "Australia/Melbourne",
  tradingDayCutoff: "00:00",
  fiscalYearStartMonth: 7,
  fiscalYearStartDay: 1,
  weekStartsOn: 1,
  tenantParameters: {
    active_customer_days: 90,
    lapsed_customer_days: 180,
    stock_velocity_days: 30,
  },
  maxRows: 1000,
  maxEstimatedCost: 100,
};

test("all 25 V1 seed questions run through the deterministic golden harness", async () => {
  const result = await runSeedGoldenSuite(registryPath);

  assert.equal(result.metricCount, 51);
  assert.equal(result.topicCount, 8);
  assert.equal(result.questionCount, 25);
  assert.equal(result.cases.length, 25);
  assert.equal(new Set(result.cases.map((item) => item.id)).size, 25);
  assert.equal(result.executableCount, 25);
  assert.deepEqual(result.executableGaps, []);

  for (const item of result.cases) {
    if (item.outcome === "passed" && (item.route === "semantic" || item.route === "source_exploration")) {
      assert.match(item.bundleHash ?? "", /^[a-f0-9]{64}$/);
    }
    if (item.outcome === "passed" && (item.route === "clarification" || item.route === "unavailable")) {
      assert.ok(item.reason);
    }
    if (item.outcome === "executable_gap") assert.ok(item.reason);
  }
});

test("golden capability expectations cannot invent unavailable Deputy overtime", () => {
  const overtime = seedGoldenQuestions.find((item) => item.id === "workforce-overtime");
  assert.equal(overtime?.expectedRoute, "unavailable");
  assert.equal(overtime?.expectedState, "unavailable");
  assert.equal(overtime?.ir, undefined);
  assert.equal(overtime?.expectedRows, undefined);
  assert.match(overtime?.rationale ?? "", /does not expose a governed overtime duration/u);
});

test("golden cases always declare a route, answer state and numeric rows when executable", () => {
  assert.equal(seedGoldenQuestions.length, 25);
  for (const question of seedGoldenQuestions) {
    assert.ok(question.expectedRoute, `${question.id} has no expected route`);
    assert.ok(question.expectedState, `${question.id} has no expected state`);
    if (question.ir || question.sourceQuery) {
      assert.ok(question.expectedRows, `${question.id} is executable without numeric fixture rows`);
    } else {
      assert.ok(question.rationale, `${question.id} has no executable IR or explicit rationale`);
    }
  }
});

test("composite analytics aggregate each fact independently before full-outer alignment", () => {
  const question = seedGoldenQuestions.find((item) => item.id === "workforce-sales-hour");
  assert.ok(question?.ir);
  const compiled = compileSemanticQuery(question.ir, registry, compilerContext);

  assert.deepEqual(compiled.sourceTables, [
    "mart.commerce_sales_event",
    "mart.workforce_day_worker_location",
  ]);
  assert.match(compiled.sql, /^WITH q0 AS \(/);
  assert.match(compiled.sql, /\),\nq1 AS \(/);
  assert.match(compiled.sql, /\nFULL OUTER JOIN q1 ON /);
  assert.doesNotMatch(compiled.sql, /JOIN "mart"\."(?:commerce_sales_event|workforce_day_worker_location)"/);

  const secondCte = compiled.sql.indexOf("),\nq1 AS (");
  const alignedSelect = compiled.sql.lastIndexOf("\nSELECT\n");
  assert.ok(compiled.sql.indexOf('FROM "mart"."commerce_sales_event"') < secondCte);
  assert.ok(compiled.sql.indexOf('FROM "mart"."workforce_day_worker_location"') > secondCte);
  assert.ok(compiled.sql.indexOf('FROM "mart"."workforce_day_worker_location"') < alignedSelect);
});

test("fan-out-capable dimension paths are permanently rejected", () => {
  const document = parseRegistryDocument(readFileSync(registryPath, "utf8"));
  const unsafeDocument = {
    ...document,
    facts: document.facts.map((fact) => fact.id === "commerce_sales_event"
      ? {
          ...fact,
          joins: fact.joins.map((join) => join.dimension === "location"
            ? { ...join, cardinality: "one_to_one" as const }
            : join),
        }
      : fact),
  };
  const unsafeRegistry = buildRegistry(unsafeDocument);

  assert.throws(
    () => compileSemanticQuery({
      topic: "sales_performance",
      metrics: ["net_sales_ex_gst"],
      dimensions: ["location"],
      filters: [],
      time: {
        field: "business_date",
        range: {
          type: "absolute",
          from: "2026-03-01T00:00:00.000Z",
          to: "2026-03-16T00:00:00.000Z",
        },
        compare: "none",
      },
      sort: [],
      limit: 20,
      parameters: {},
    }, unsafeRegistry, compilerContext),
    (error) => error instanceof SemanticCompilerError && error.code === "ILLEGAL_JOIN",
  );

  const raw = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, unknown>;
  const facts = raw.facts as Array<{ id: string; joins: Array<Record<string, unknown>> }>;
  const salesFact = facts.find((fact) => fact.id === "commerce_sales_event");
  assert.ok(salesFact);
  const location = salesFact.joins.find((join) => join.dimension === "location");
  assert.ok(location);
  location.cardinality = "one_to_many";
  assert.throws(() => parseRegistryDocument(JSON.stringify(raw)), /cardinality/);
});

test("snapshot values can never be summed across time", () => {
  const document = parseRegistryDocument(readFileSync(registryPath, "utf8"));
  const unsafeRegistry = buildRegistry({
    ...document,
    metrics: document.metrics.map((metric) => metric.id === "inventory.stock_on_hand_value"
      ? {
          ...metric,
          aggregation: "sum" as const,
          calculation: { op: "sum" as const, field: "stock_value" },
        }
      : metric),
  });

  assert.throws(
    () => compileSemanticQuery({
      topic: "inventory_health",
      metrics: ["stock_on_hand_value"],
      dimensions: [],
      filters: [],
      time: {
        field: "snapshot_date",
        range: {
          type: "absolute",
          from: "2026-03-01T00:00:00.000Z",
          to: "2026-03-16T00:00:00.000Z",
        },
        compare: "none",
      },
      sort: [],
      limit: 20,
      parameters: {},
    }, unsafeRegistry, compilerContext),
    (error) => error instanceof SemanticCompilerError
      && error.code === "SNAPSHOT_SUM_FORBIDDEN",
  );
});

test("source exploration can never fan across connections", () => {
  const secondConnectionCatalogue = sourceFixtureCatalogue.map((field) => ({
    ...field,
    connectionId: "01J00000000000000000000999",
  }));
  assert.throws(
    () => compileSourceQuery({
      connectionId: FIXTURE_LIGHTSPEED_CONNECTION_ID,
      sourceTable: "sales",
      fields: ["discount_reason"],
      aggregates: [],
      groupBy: [],
      filters: [],
      limit: 20,
    }, FIXTURE_TENANT_ID, "owner", [
      ...sourceFixtureCatalogue,
      ...secondConnectionCatalogue,
    ]),
    /exactly one connection and source table/,
  );
});
