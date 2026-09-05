/**
 * The visualisation agent: shape-driven chart selection (ADR 0101).
 *
 * The regression this guards is the 2026-08-18 workshop deep-dive turn where
 * a branch investigator drew a nine-series line over three months (the pivot
 * ran on the 50-row client slice of a 483-row result) and a line whose legend
 * was raw item-type codes with a "(blank)" series. Every rule below is the
 * runtime's, not the model's.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createV3CommentaryState } from "../../packages/albert-v3/src/engine/commentary.ts";
import type { V3ToolRoute } from "../../packages/albert-v3/src/engine/connector-routing.ts";
import type { StoredTableResult, V3TurnContext } from "../../packages/albert-v3/src/engine/context.ts";
import { createMakeChartTool, humaniseSeriesLabel, yearAgnosticTimeBucket } from "../../packages/albert-v3/src/engine/chart-layer.ts";
import { profileResult, recommendVisual, renderResultShape } from "../../packages/albert-v3/src/engine/result-shape.ts";
import { createV3Tools } from "../../packages/albert-v3/src/engine/tools.ts";
import { chartCandidates, isDerivedChartTable, VISUALISER_INSTRUCTIONS } from "../../packages/albert-v3/src/engine/visualise-lane.ts";
import { ALBERT_VALUE_FIELD, type TraceEvent } from "../../packages/shared/src/index.ts";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

function route(): V3ToolRoute {
  return {
    cube: true, shopifyQL: false, shopifyAdmin: false,
    activeCubeConnectors: ["lightspeed"], unavailableRequestedConnectors: [], preferredCubeConnectors: [],
    mode: "cube", reasons: ["test"],
  } as V3ToolRoute;
}

function stubContext(): V3TurnContext & { emitted: TraceEvent[] } {
  const emitted: TraceEvent[] = [];
  let sequence = 0;
  return {
    emitted,
    cube: {} as V3TurnContext["cube"],
    config: {} as V3TurnContext["config"],
    promptCachePartition: "fixturetenant",
    toolRoute: route(),
    emit: async (event) => {
      sequence += 1;
      const full = { ...event, id: `01K2K2A6S9W9M4FW4NG4TDD9E${sequence}`, sequence, occurredAt: "2026-08-19T00:00:00.000Z" } as never;
      emitted.push(full);
      return full;
    },
    budget: { maxQueries: 3, executed: 0 },
    connectorFreshness: [],
    sourceFindings: [],
    commentary: createV3CommentaryState(false),
    executedQueries: [],
    tableResults: new Map(),
    priorResults: new Map(),
    chartedResultIds: new Set(),
  } as unknown as V3TurnContext & { emitted: TraceEvent[] };
}

const provenance = {
  sources: [], timeRange: { label: "x", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
  definitions: [], semanticBundleHash: "x", identityGraph: { version: 0, hash: "x" },
};

function table(input: Pick<StoredTableResult, "resultId" | "caption" | "columns"> & { rows: readonly Readonly<Record<string, string | number | null>>[]; clientRows?: number }): StoredTableResult {
  const clientRows = input.rows.slice(0, input.clientRows ?? 50);
  return {
    tableEventId: `evt_${input.resultId}`,
    resultId: input.resultId,
    caption: input.caption,
    columns: input.columns,
    rows: clientRows,
    ...(clientRows.length < input.rows.length ? { allRows: input.rows } : {}),
    columnKeys: input.columns.map((c) => c.key),
    numericColumnKeys: input.columns.filter((c) => ["number", "currency", "percent"].includes(c.type)).map((c) => c.key),
    rowCount: input.rows.length,
    provenance,
    presentation: "evidence",
  };
}

const MONTHS_24 = Array.from({ length: 24 }, (_, i) => `${2024 + Math.floor((7 + i) / 12)}-${String(((7 + i) % 12) + 1).padStart(2, "0")}-01T00:00:00.000`);
const SERVICES = ["Service - General Service", "Service - Full Service", "Service - Change Tyre", "Service - Brake Pad", "Service - Fit Chain", "Service - Brake Bleed", "Service - Fit Gear Cable", "Service - BB", "Service - True Wheel", "Kids Service", "Service - Headset"];

/** The 483-row long-format service × month result from the workshop turn, with the two compare periods. */
function serviceByMonth(): StoredTableResult {
  const rows: Array<Record<string, string | number | null>> = [];
  for (const [mi, month] of MONTHS_24.entries()) {
    for (const [si, service] of SERVICES.entries()) {
      rows.push({
        "psa.items_name": service,
        "psa.completed_at.month": month,
        "psa.line_revenue": 5000 / (si + 1) + mi * 10,
        compareDateRange: mi < 12 ? "2024-08-01T00:00:00.000 - 2025-07-31T23:59:59.999" : "2025-08-01T00:00:00.000 - 2026-07-31T23:59:59.999",
      });
    }
  }
  return table({
    resultId: "01M0BM0YC01YJBSZNZQ10CXK4T",
    caption: "Named workshop service types by month, current and prior trailing 12 months",
    columns: [
      { key: "psa.items_name", label: "Item name", type: "string" },
      { key: "psa.completed_at.month", label: "Completed at (business date)", type: "datetime" },
      { key: "psa.line_revenue", label: "Line revenue (inc tax)", type: "currency", currency: "AUD" },
      { key: "compareDateRange", label: "Date range", type: "string" },
    ],
    rows,
  });
}

function itemTypeByMonth(): StoredTableResult {
  const rows: Array<Record<string, string | number | null>> = [];
  for (const month of MONTHS_24.slice(12)) {
    for (const type of ["default", "non_inventory", null, "assembly"]) {
      rows.push({ "psa.items_item_type": type, "psa.completed_at.month": month, "psa.line_revenue": type === "default" ? 18000 : type === "non_inventory" ? 10000 : type === null ? 900 : 100 });
    }
  }
  return table({
    resultId: "01M0BM09SQJ5GFW57MN9NFQ31A",
    caption: "Workshop revenue by line item type, monthly",
    columns: [
      { key: "psa.items_item_type", label: "Items Item Type", type: "string" },
      { key: "psa.completed_at.month", label: "Completed at (business date)", type: "datetime" },
      { key: "psa.line_revenue", label: "Line revenue (inc tax)", type: "currency", currency: "AUD" },
    ],
    rows,
  });
}

/** Sales by month across two calendar years, no extra dimension: the y/y overlay case. */
function salesByMonthYoY(): StoredTableResult {
  const months = ["01", "02", "03", "04", "05", "06", "07", "08"];
  const rows: Array<Record<string, string | number | null>> = [];
  for (const year of [2025, 2026]) {
    for (const month of months) {
      rows.push({
        "sales_analytics.completed_at.month": `${year}-${month}-01T00:00:00.000`,
        "sales_analytics.total_sales": year === 2025 ? 40_000 + Number(month) * 1_000 : 50_000 + Number(month) * 800,
        compareDateRange: year === 2025
          ? "2025-01-01T00:00:00.000 - 2025-08-19T23:59:59.999"
          : "2026-01-01T00:00:00.000 - 2026-08-19T23:59:59.999",
      });
    }
  }
  return table({
    resultId: "01M0SALESYY0000000000000001",
    caption: "Monthly sales, 2026 versus the same period in 2025",
    columns: [
      { key: "sales_analytics.completed_at.month", label: "Completed at (month)", type: "datetime" },
      { key: "sales_analytics.total_sales", label: "Total sales", type: "currency", currency: "AUD" },
      { key: "compareDateRange", label: "Date range", type: "string" },
    ],
    rows,
  });
}

function serviceRanking(): StoredTableResult {
  return table({
    resultId: "01M0BM0T1Q3CKXYKG34RXXEFP5",
    caption: "Non-inventory workshop service types ranked by gross profit",
    columns: [
      { key: "psa.items_name", label: "Item name", type: "string" },
      { key: "psa.line_count", label: "Sale line count", type: "number" },
      { key: "psa.line_gross_profit", label: "Line gross profit", type: "currency", currency: "AUD" },
      { key: "psa.line_gross_margin_pct", label: "Line gross margin %", type: "percent" },
    ],
    // Alphabetical on purpose: the chart layer must rank it.
    rows: SERVICES.map((s, i) => ({ "psa.items_name": s, "psa.line_count": 600 - i * 40, "psa.line_gross_profit": 70000 / (i + 1), "psa.line_gross_margin_pct": 100 - i }))
      .sort((a, b) => a["psa.items_name"].localeCompare(b["psa.items_name"])),
  });
}

async function makeChart(context: V3TurnContext, args: Record<string, unknown>) {
  const tool = createMakeChartTool();
  assert.ok(tool.type === "function");
  const raw = await (tool.invoke as (ctx: unknown, args: string) => Promise<unknown>)({ context }, JSON.stringify({ chartType: "auto", ...args }));
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as { ok: boolean; error?: string; chartType?: string; points?: number; series?: number; seriesLabels?: string[]; notes?: string[] };
}

test("the shape profiler classifies columns and makes Omni-style best guesses", () => {
  const trend = profileResult(itemTypeByMonth());
  assert.equal(trend.timeKey, "psa.completed_at.month");
  assert.equal(trend.grain, "time-by-category");
  const typeColumn = trend.columns.find((c) => c.key === "psa.items_item_type")!;
  assert.equal(typeColumn.role, "dimension");
  assert.equal(typeColumn.codeLike, true, "item_type values are internal codes");
  assert.equal(typeColumn.nulls, 12);
  assert.equal(trend.recommendation.form, "line", "≤4 series over time is a line");
  assert.equal(trend.recommendation.seriesKey, "psa.items_item_type");
  assert.ok(trend.notes.some((n) => /internal codes/u.test(n)));

  const ranking = profileResult(serviceRanking());
  assert.equal(ranking.grain, "category");
  assert.equal(ranking.recommendation.form, "bar");
  assert.equal(ranking.recommendation.yKey, "psa.line_gross_profit", "profit outranks counts and percentages as the headline measure");
  assert.equal(ranking.recommendation.sort, "y_desc");
  assert.equal(ranking.recommendation.orientation, "horizontal");

  const compare = profileResult(serviceByMonth());
  assert.equal(compare.periodKey, "compareDateRange");
  assert.equal(compare.grain, "time-by-category");
  assert.equal(compare.recommendation.form, "stacked_bar", "eleven services over time is a stack, never eleven lines");
  assert.ok(compare.notes.some((n) => /like-for-like period comparison/u.test(n)));

  const yoy = profileResult(salesByMonthYoY());
  assert.equal(yoy.grain, "time-series");
  assert.equal(yoy.recommendation.form, "line");
  assert.equal(yoy.recommendation.seriesKey, "compareDateRange");
  assert.match(yoy.recommendation.reason, /overlay/u);

  const scalar = recommendVisual({ ...profileResult(table({ resultId: "01ONE", caption: "one", columns: [{ key: "n", label: "N", type: "number" }], rows: [{ n: 4 }] })), grain: "scalar" });
  assert.equal(scalar.form, "kpi");

  const rendered = renderResultShape(ranking);
  assert.match(rendered, /best guess: bar \(x=psa\.items_name y=psa\.line_gross_profit/u);
});

test("a period-comparison result is never squashed onto one axis, and series labels are humanised", async () => {
  const context = stubContext();
  const source = serviceByMonth();
  context.tableResults.set(source.resultId, source);

  // The original failure: pivot services over months across BOTH periods.
  const squashed = await makeChart(context, { resultId: source.resultId, caption: "Service revenue by month", xKey: "psa.completed_at.month", yKey: "psa.line_revenue", seriesKey: "psa.items_name" });
  assert.equal(squashed.ok, false);
  assert.match(String(squashed.error), /compares two periods/u);

  // Period as series, x = month bucket: overlay on a shared month axis (12
  // months × 2 years), never 24 calendar months end to end. Pivot still
  // reads every held row, not the 50-row client slice.
  const byPeriod = await makeChart(context, { resultId: source.resultId, caption: "This year vs last, monthly", xKey: "psa.completed_at.month", yKey: "psa.line_revenue", seriesKey: "compareDateRange" });
  assert.equal(byPeriod.ok, true, byPeriod.error);
  assert.equal(byPeriod.points, 12, "two years overlay on twelve months, not twenty-four calendar points");
  assert.deepEqual(byPeriod.seriesLabels, ["Aug 2025 – Jul 2026", "Aug 2024 – Jul 2025"]);
  assert.ok(byPeriod.notes?.some((n) => /share a month axis/u.test(n)));
  const overlayTable = context.emitted.filter((event) => event.type === "table").at(-1) as { rows: Array<Record<string, unknown>> };
  assert.deepEqual(overlayTable.rows.map((row) => row["psa.completed_at.month"]), ["Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"]);
  const overlayChart = context.emitted.filter((event) => event.type === "chart").at(-1) as { flint?: { field_display_names: Record<string, string> } };
  assert.equal(overlayChart.flint?.field_display_names[ALBERT_VALUE_FIELD], "Line revenue (inc tax)");
  assert.equal(overlayChart.flint?.field_display_names["psa.completed_at.month"], "Month");

  const sales = salesByMonthYoY();
  context.tableResults.set(sales.resultId, sales);
  const salesYoY = await makeChart(context, { resultId: sales.resultId, caption: "Monthly sales: 2026 versus the same period in 2025", xKey: "sales_analytics.completed_at.month", yKey: "sales_analytics.total_sales", seriesKey: "compareDateRange" });
  assert.equal(salesYoY.ok, true, salesYoY.error);
  assert.equal(salesYoY.points, 8);
  assert.equal(salesYoY.chartType, "line");
  const salesTable = context.emitted.filter((event) => event.type === "table").at(-1) as { rows: Array<Record<string, unknown>> };
  assert.deepEqual(salesTable.rows.map((row) => row["sales_analytics.completed_at.month"]), ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"]);

  // One period, eleven services over time: auto resolves to a stack, not eleven lines.
  const oneperiod = await makeChart(context, { resultId: source.resultId, caption: "Which services carry the workshop", xKey: "psa.completed_at.month", yKey: "psa.line_revenue", seriesKey: "psa.items_name", where: { key: "compareDateRange", equals: "Aug 2025 – Jul 2026" } });
  assert.equal(oneperiod.ok, true, oneperiod.error);
  assert.equal(oneperiod.chartType, "stacked_bar");
  assert.equal(oneperiod.points, 12);
  assert.equal(oneperiod.series, 8, "top 7 services + Other");
  assert.ok(oneperiod.seriesLabels?.includes("Other"));
  const chart = context.emitted.filter((e) => e.type === "chart").at(-1) as { chartType: string; stacked?: boolean; flint?: { chart_spec: { chartType: string } } };
  assert.equal(chart.chartType, "bar");
  assert.equal(chart.stacked, true);
  assert.equal(chart.flint?.chart_spec.chartType, "Stacked Bar Chart");

  // An explicit line request over eleven series keeps the top three + Other.
  const forcedLine = await makeChart(context, { resultId: source.resultId, chartType: "line", caption: "Top services trend", xKey: "psa.completed_at.month", yKey: "psa.line_revenue", seriesKey: "psa.items_name", where: { key: "compareDateRange", equals: "Aug 2025 – Jul 2026" } });
  assert.equal(forcedLine.ok, true, forcedLine.error);
  assert.equal(forcedLine.chartType, "line");
  assert.equal(forcedLine.series, 4);
});

test("code-like dimensions and blanks become owner-facing labels; category bars rank by default", async () => {
  assert.equal(humaniseSeriesLabel("non_inventory"), "Non inventory");
  assert.equal(humaniseSeriesLabel(null), "(not set)");
  assert.equal(humaniseSeriesLabel("2024-08-01T00:00:00.000 - 2025-07-31T23:59:59.999"), "Aug 2024 – Jul 2025");
  assert.equal(humaniseSeriesLabel("Service - BB"), "Service - BB");
  assert.equal(yearAgnosticTimeBucket("2025-03-01T00:00:00.000"), "Mar");
  assert.equal(yearAgnosticTimeBucket("2026-08-19"), "19 Aug");
  assert.equal(yearAgnosticTimeBucket("2026-08-01", true), "1 Aug");

  const context = stubContext();
  const types = itemTypeByMonth();
  context.tableResults.set(types.resultId, types);
  const byType = await makeChart(context, { resultId: types.resultId, caption: "Parts vs labour revenue", xKey: "psa.completed_at.month", yKey: "psa.line_revenue", seriesKey: "psa.items_item_type" });
  assert.equal(byType.ok, true, byType.error);
  assert.equal(byType.chartType, "line");
  assert.deepEqual(byType.seriesLabels, ["Default", "Non inventory", "Assembly", "(not set)"]);
  assert.ok(byType.notes?.some((n) => /"\(not set\)"/u.test(n)));

  const ranking = serviceRanking();
  context.tableResults.set(ranking.resultId, ranking);
  const bars = await makeChart(context, { resultId: ranking.resultId, caption: "General servicing earns the most profit", xKey: "psa.items_name", yKey: "psa.line_gross_profit" });
  assert.equal(bars.ok, true, bars.error);
  assert.equal(bars.chartType, "bar");
  const derived = context.emitted.filter((e) => e.type === "table").at(-1) as { rows: Array<Record<string, unknown>> };
  assert.equal(derived.rows[0]!["psa.items_name"], "Service - General Service", "ranked descending without being asked");
  const chart = context.emitted.filter((e) => e.type === "chart").at(-1) as { orientation?: string };
  assert.equal(chart.orientation, "horizontal");

  // A line over categories is drawn as bars, with the reason returned.
  const line = await makeChart(context, { resultId: ranking.resultId, chartType: "line", caption: "Profit by service", xKey: "psa.items_name", yKey: "psa.line_count" });
  assert.equal(line.ok, true, line.error);
  assert.equal(line.chartType, "bar");
  assert.ok(line.notes?.some((n) => /categorical/u.test(n)));

  // Mixed units never share an axis.
  const mixed = await makeChart(context, { resultId: ranking.resultId, caption: "Profit and margin", xKey: "psa.items_name", yKey: "psa.line_gross_profit", extraYKeys: ["psa.line_gross_margin_pct"] });
  assert.equal(mixed.ok, false);
  assert.match(String(mixed.error), /different units/u);
});

test("the visualiser owns presentation in the deep lane; branches only investigate", () => {
  const branchTools = createV3Tools({ route: route(), lane: "deep", purpose: "investigation", chartable: false }).map((t) => t.name);
  assert.equal(branchTools.includes("make_chart"), false);
  const deepLane = read("packages/albert-v3/src/engine/deep-lane.ts");
  assert.match(deepLane, /chartable: false/u, "deep branches must not draw charts mid-investigation");
  assert.match(deepLane, /runVisualiser\(\{ lane: input, answer \}\)/u, "the visualiser runs against the finished synthesis");
  assert.match(VISUALISER_INSTRUCTIONS, /at most four series/u);
  assert.match(VISUALISER_INSTRUCTIONS, /Never a pie/u);
  assert.match(VISUALISER_INSTRUCTIONS, /Two charts is the maximum/u);
  assert.match(VISUALISER_INSTRUCTIONS, /never[\s\S]*end to end/u);

  const context = stubContext();
  const source = serviceRanking();
  context.tableResults.set(source.resultId, source);
  context.tableResults.set("01DERIVED000000000000000000", { ...source, resultId: "01DERIVED000000000000000000", provenance: { ...provenance, definitions: [{ metric: "albert.chart_transform", label: "Chart data", definition: "x" }] } });
  const candidates = chartCandidates(context);
  assert.equal(candidates.length, 1, "chart-data derivations are not re-offered as sources");
  assert.equal(isDerivedChartTable(context.tableResults.get("01DERIVED000000000000000000")!), true);
});
