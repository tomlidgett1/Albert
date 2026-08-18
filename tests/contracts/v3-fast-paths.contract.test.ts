/**
 * Contract tests for the 2026-08 engine architecture work: prior-result
 * retention, the chart layer's data-shape transforms, certified recipes, the
 * native-capability registry, and the represent/meta lanes' routing surface.
 * All deterministic — no model, no Cube.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { prepareChartRows, resolveChartType, looksLikeTimeAxis } from "../../packages/albert-v3/src/engine/chart-layer.js";
import { priorResultsFromTraceEvents, renderPriorResultsForPrompt, registerPriorResults, resolveTableResult } from "../../packages/albert-v3/src/engine/prior-results.js";
import { normaliseRecipeDateRange, recipeToolInput } from "../../packages/albert-v3/src/engine/recipe-lane.js";
import { detectNativeCapability, renderNativeCapabilitiesForClassifier, resolveNativeCapability } from "../../packages/albert-v3/src/engine/native-capabilities.js";
import { LANES, intentSchema } from "../../packages/albert-v3/src/engine/orchestrator.js";
import { loadAgentConfig, recipesForRoute, findCertifiedQuery } from "../../packages/albert-v3/src/agent-config/loader.js";
import { groundedAnswerState, laneMayReusePriorResults } from "../../packages/albert-v3/src/engine/grounding.js";
import { detectXeroStatementRequest } from "../../packages/albert-v3/src/engine/statement-lane.js";
import type { StoredTableResult, V3TurnContext } from "../../packages/albert-v3/src/engine/context.js";

const provenance = {
  sources: [], timeRange: { label: "x", start: "unknown", end: "unknown", timezone: "UTC" },
  definitions: [], semanticBundleHash: "x", identityGraph: { version: 0, hash: "x" },
};

function table(rows: Array<Record<string, string | number | null>>, columns: StoredTableResult["columns"]): StoredTableResult {
  return {
    tableEventId: "evt", resultId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", caption: "t",
    columns, rows, columnKeys: columns.map((c) => c.key),
    numericColumnKeys: columns.filter((c) => c.type === "number" || c.type === "currency").map((c) => c.key),
    rowCount: rows.length, provenance, presentation: "evidence",
  };
}

test("chart layer: long rows pivot into wide series, sort/limit/take are deterministic, auto type follows the x axis", () => {
  const long = table([
    { "w.month": "2026-01-01T00:00:00.000", "w.staff": "Jack", "w.hours": 100 },
    { "w.month": "2026-01-01T00:00:00.000", "w.staff": "Leigh", "w.hours": 80 },
    { "w.month": "2026-02-01T00:00:00.000", "w.staff": "Jack", "w.hours": 120 },
    { "w.month": "2026-02-01T00:00:00.000", "w.staff": "Leigh", "w.hours": 90 },
    { "w.month": "2026-03-01T00:00:00.000", "w.staff": "Jack", "w.hours": 110 },
  ], [
    { key: "w.month", label: "Month", type: "datetime" },
    { key: "w.staff", label: "Staff", type: "string" },
    { key: "w.hours", label: "Hours", type: "number" },
  ]);
  const pivot = prepareChartRows(long, { resultId: long.resultId, chartType: "auto", caption: "c", xKey: "w.month", yKey: "w.hours", seriesKey: "w.staff" });
  assert.equal(pivot.transformed, true);
  assert.deepEqual(pivot.seriesKeys, ["series_jack", "series_leigh"]);
  assert.equal(pivot.rows.length, 3);
  assert.equal(pivot.rows[2]!["series_leigh"], null);
  assert.equal(resolveChartType({ resultId: long.resultId, chartType: "auto", caption: "c", xKey: "w.month", yKey: "w.hours" }, long, pivot.rows).chartType, "line");

  const daily = table(Array.from({ length: 10 }, (_, i) => ({ "s.day": `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000`, "s.sales": 100 + i })), [
    { key: "s.day", label: "Day", type: "datetime" }, { key: "s.sales", label: "Sales", type: "currency" },
  ]);
  const lastSeven = prepareChartRows(daily, { resultId: daily.resultId, chartType: "bar", caption: "c", xKey: "s.day", yKey: "s.sales", limit: 7, take: "last" });
  assert.equal(lastSeven.rows.length, 7);
  assert.equal(String(lastSeven.rows[0]!["s.day"]).slice(0, 10), "2026-08-04");
  const topThree = prepareChartRows(daily, { resultId: daily.resultId, chartType: "bar", caption: "c", xKey: "s.day", yKey: "s.sales", sort: "y_desc", limit: 3 });
  assert.equal(topThree.rows[0]!["s.sales"], 109);
  assert.equal(resolveChartType({ resultId: daily.resultId, chartType: "auto", caption: "c", xKey: "s.day", yKey: "s.sales", sort: "y_desc" }, daily, topThree.rows).chartType, "bar");
  assert.equal(looksLikeTimeAxis(undefined, "x.completed_at.week", ["2026-08-03T00:00:00.000"]), true);
  assert.equal(looksLikeTimeAxis(undefined, "x.category", ["Bikes"]), false);
});

test("prior results: rebuilt from persisted trace events, rendered for the prompt, materialised on first use", async () => {
  const events = [
    { type: "query", view: "sales_analytics", queryYaml: "measures: [sales_analytics.gross_takings]" },
    { type: "table", resultId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", caption: "Weekly sales", presentation: "evidence",
      columns: [{ key: "sales_analytics.completed_at.week", label: "Week", type: "datetime" }, { key: "sales_analytics.gross_takings", label: "Sales", type: "currency" }],
      rows: [{ "sales_analytics.completed_at.week": "2026-08-03T00:00:00.000", "sales_analytics.gross_takings": 1234.5 }],
      provenance: { ...provenance, view: { name: "sales_analytics", label: "Sales", description: "" }, timeRange: { label: "last 12 weeks", start: "unknown", end: "unknown", timezone: "UTC" } } },
    { type: "answer", text: "…" },
  ];
  const prior = priorResultsFromTraceEvents([{ turnsAgo: 1, events }]);
  assert.equal(prior.length, 1);
  assert.equal(prior[0]!.view, "sales_analytics");
  assert.equal(prior[0]!.queryYaml, "measures: [sales_analytics.gross_takings]");
  const rendered = renderPriorResultsForPrompt(prior);
  assert.match(rendered, /resultId 01ARZ3NDEKTSV4RRFFQ69G5FAV/u);
  assert.match(rendered, /0: 2026-08-03T00:00:00.000 \| 1234.50/u);

  const emitted: unknown[] = [];
  const context = {
    config: { timezone: "Australia/Melbourne" },
    emit: async (event: Record<string, unknown>) => { emitted.push(event); return { ...event, id: "ev_1", sequence: 1, occurredAt: "now" }; },
    tableResults: new Map(),
    priorResults: new Map(),
  } as unknown as V3TurnContext;
  registerPriorResults(context, prior);
  assert.equal(context.priorResults.size, 1);
  const stored = await resolveTableResult(context, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
  assert.ok(stored?.reusedFromPriorTurn);
  assert.equal(emitted.length, 1, "materialised as one table event");
  assert.equal(context.priorResults.size, 0);
  assert.ok((await resolveTableResult(context, "01ARZ3NDEKTSV4RRFFQ69G5FAV"))?.reusedFromPriorTurn);
  assert.equal(emitted.length, 1, "second use does not re-emit");
});

test("recipes: flagged certified queries convert to governed tool input with the owner's period substituted", () => {
  const config = loadAgentConfig();
  const recipes = recipesForRoute(config, ["lightspeed", "deputy", "xero"]);
  assert.ok(recipes.length >= 20, `expected recipes for the three test connectors, got ${recipes.length}`);
  assert.equal(recipesForRoute(config, ["shopify"]).length, 0);
  const sales = findCertifiedQuery("recipe-sales-total-for-period", config);
  assert.ok(sales?.recipe);
  const input = recipeToolInput(sales, "last week", null);
  assert.equal(input.timeDimensions?.[0]?.dateRange, "last week");
  assert.deepEqual(input.measures, ["sales_analytics.gross_takings", "sales_analytics.transactions", "sales_analytics.average_sale_value"]);
  const suppliers = findCertifiedQuery("recipe-top-suppliers-by-spend", config);
  const narrowed = recipeToolInput(suppliers!, undefined, "Pon Bike");
  assert.ok(narrowed.filters?.some((f) => f.operator === "contains" && f.values?.includes("Pon Bike")));
  assert.equal(normaliseRecipeDateRange("Last  Month"), "last month");
  assert.equal(normaliseRecipeDateRange("2026-07-01, 2026-07-31"), "2026-07-01,2026-07-31");
  assert.equal(normaliseRecipeDateRange("since the shop opened"), undefined);
});

test("native capabilities: registry detects statement questions by wording and intent, and renders for the classifier", () => {
  const withXero = { xeroMcp: {} } as unknown as Pick<V3TurnContext, "xeroMcp">;
  assert.equal(detectNativeCapability("What was our net profit for the last financial year?", withXero, ["xero", "deputy"])?.kind, "profit_and_loss");
  assert.equal(detectNativeCapability("What are our biggest expense accounts this financial year?", withXero, ["xero"])?.kind, "profit_and_loss");
  assert.equal(detectNativeCapability("Show me the balance sheet as at 30 June 2026.", withXero, ["xero"])?.kind, "balance_sheet");
  assert.equal(detectNativeCapability("How much do we owe suppliers?", withXero, ["xero"]), undefined);
  assert.equal(detectNativeCapability("What was our net profit last year?", { xeroMcp: undefined }, ["xero"]), undefined, "no client, no delegation");
  assert.equal(detectNativeCapability("What was our net profit last year?", withXero, ["deputy"]), undefined, "not connected, no delegation");
  assert.equal(resolveNativeCapability("xero.statement:profit_and_loss", withXero, ["xero"])?.kind, "profit_and_loss");
  assert.equal(resolveNativeCapability("xero.statement:nope", withXero, ["xero"]), undefined);
  assert.match(renderNativeCapabilitiesForClassifier(["xero"]), /xero\.statement:balance_sheet/u);
  assert.equal(renderNativeCapabilitiesForClassifier(["deputy"]), "");
  // Grain the statement lacks keeps the general path.
  assert.equal(detectXeroStatementRequest("P&L by product category for July"), undefined);
});

test("routing surface: represent and meta lanes exist, reuse prior results, and the intent schema carries the fast-path fields", () => {
  assert.ok((LANES as readonly string[]).includes("represent"));
  assert.ok((LANES as readonly string[]).includes("meta"));
  assert.ok(intentSchema.shape.recipe && intentSchema.shape.recipeDateRange && intentSchema.shape.recipeEntity && intentSchema.shape.nativeCapability);
  assert.equal(laneMayReusePriorResults("represent"), true);
  assert.equal(laneMayReusePriorResults("quick"), false);
  // A represent answer built purely from prior results ships Verified, not "No data".
  assert.equal(groundedAnswerState({ lane: "represent", requested: "Verified", queriesExecuted: 0, rowsSeen: 0 }), "Verified");
  assert.equal(groundedAnswerState({ lane: "quick", requested: "Verified", queriesExecuted: 0, rowsSeen: 0 }), "Unavailable");
});

test("planned lane: a bound step substitutes the source step's value instead of guessing it", async () => {
  const { bindStep } = await import("../../packages/albert-v3/src/engine/planned-lane.js");
  const source = { ok: true, resultId: "r1" };
  const rows = [
    { "sales_analytics.completed_at.day": "2026-05-09T00:00:00.000", "sales_analytics.gross_takings": 8750.68 },
    { "sales_analytics.completed_at.day": "2026-03-01T00:00:00.000", "sales_analytics.gross_takings": 5000 },
  ];
  const byDate = bindStep({
    topic: "Who worked that day", measures: ["workforce_analytics.hours_worked"], dimensions: ["workforce_analytics.employee_name"],
    bind: { fromStep: 0, fromColumn: "sales_analytics.completed_at.day", pick: "first", targetKind: "dateRange", targetMember: "workforce_analytics.shift_started_at" },
  }, source, rows);
  assert.ok("query" in byDate);
  assert.deepEqual(byDate.query.timeDimensions, [{ dimension: "workforce_analytics.shift_started_at", dateRange: "2026-05-09,2026-05-09" }]);
  const byFilter = bindStep({
    topic: "Purchases of the top customers", measures: ["sales_analytics.gross_takings"],
    bind: { fromStep: 0, fromColumn: "sales_analytics.completed_at.day", pick: "all", targetKind: "filter", targetMember: "sales_analytics.customer_name" },
  }, source, rows);
  assert.ok("query" in byFilter);
  assert.equal(byFilter.query.filters?.[0]?.values?.length, 2);
  const missing = bindStep({ topic: "x", measures: ["a.b"], bind: { fromStep: 0, fromColumn: "nope", pick: "first", targetKind: "filter", targetMember: "a.c" } }, source, rows);
  assert.ok("error" in missing);
  const unbound = bindStep({ topic: "x", measures: ["a.b"], bind: null }, undefined, undefined);
  assert.ok("query" in unbound && !("bind" in unbound.query));
});

test("aggregate layer: date parts bucket deterministically over the full in-memory rows", async () => {
  const { aggregateRows, dateBucket } = await import("../../packages/albert-v3/src/engine/aggregate-layer.js");
  assert.equal(dateBucket("2026-05-09T00:00:00.000", "weekday")?.label, "Saturday");
  assert.equal(dateBucket("2026-05-11T14:00:00.000", "hour")?.label, "14:00");
  assert.equal(dateBucket("2026-05-11", "hour"), undefined, "no hour in a bare date");
  assert.equal(dateBucket("2026-05-11T14:00:00.000", "week")?.label, "2026-05-11");
  const columns = [
    { key: "s.day", label: "Day", type: "datetime" as const },
    { key: "s.sales", label: "Sales", type: "currency" as const, currency: "AUD" },
  ];
  // 92 daily rows: 18 May – 17 Aug 2026; the client-facing slice is 50 rows, allRows has all.
  const allRows = Array.from({ length: 92 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 4, 18 + i));
    return { "s.day": `${d.toISOString().slice(0, 10)}T00:00:00.000`, "s.sales": 100 + (d.getUTCDay() === 6 ? 50 : 0) };
  });
  const out = aggregateRows({ rows: allRows.slice(0, 50), allRows, columns }, { groupColumn: "s.day", groupPart: "weekday", measures: ["s.sales"], aggregate: "sum", sort: "group", limit: null });
  assert.equal(out.rows.length, 7);
  assert.equal(out.rows[0]!["group_weekday"], "Monday");
  assert.equal(out.rows[5]!["group_weekday"], "Saturday");
  const saturdays = allRows.filter((r) => new Date(r["s.day"]!).getUTCDay() === 6).length;
  assert.equal(out.rows[5]!["s.sales"], saturdays * 150);
  assert.equal(out.columns[1]!.type, "currency");
  const top = aggregateRows({ rows: allRows, allRows, columns }, { groupColumn: "s.day", groupPart: "weekday", measures: ["s.sales"], aggregate: "sum", sort: "value_desc", limit: 1 });
  assert.equal(top.rows[0]!["group_weekday"], "Saturday");
});

test("aggregate layer: a date-part filter keeps only the wanted rows before grouping", async () => {
  const { aggregateRows } = await import("../../packages/albert-v3/src/engine/aggregate-layer.js");
  const columns = [{ key: "s.hour", label: "Hour", type: "datetime" as const }, { key: "s.sales", label: "Sales", type: "currency" as const }];
  const rows: Array<Record<string, string | number | null>> = [];
  for (let day = 0; day < 14; day += 1) {
    for (const hour of [9, 10, 14]) {
      const d = new Date(Date.UTC(2026, 7, 3 + day, hour)); // 3 Aug 2026 is a Monday
      rows.push({ "s.hour": d.toISOString().slice(0, 19), "s.sales": d.getUTCDay() === 6 ? 200 : 100 });
    }
  }
  const saturdaysByHour = aggregateRows({ rows, allRows: rows, columns }, {
    groupColumn: "s.hour", groupPart: "hour", measures: ["s.sales"], aggregate: "sum", sort: "group", limit: null,
    filterColumn: "s.hour", filterPart: "weekday", filterValues: ["Saturday"],
  });
  assert.equal(saturdaysByHour.kept, 6, "two Saturdays × three hours");
  assert.deepEqual(saturdaysByHour.rows.map((r) => r["group_hour"]), ["09:00", "10:00", "14:00"]);
  assert.equal(saturdaysByHour.rows[0]!["s.sales"], 400);
  const mornings = aggregateRows({ rows, allRows: rows, columns }, {
    groupColumn: "s.hour", groupPart: "weekday", measures: ["s.sales"], aggregate: "sum", sort: "group", limit: null,
    filterColumn: "s.hour", filterPart: "hour", filterValues: ["09:00", "10:00"],
  });
  assert.equal(mornings.rows.length, 7);
  assert.equal(mornings.rows[5]!["group_weekday"], "Saturday");
  assert.equal(mornings.rows[5]!["s.sales"], 800);
});
