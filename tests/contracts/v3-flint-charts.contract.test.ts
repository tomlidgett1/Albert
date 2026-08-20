import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compile } from "vega-lite";
import * as vega from "vega";
import { albertFlintTheme, assembleFlintChart, assembleFlintSpec, formatPointValue, preserveCategoryDomainOrder, vegaSafeField } from "../../app/dash/lib/flint-assemble.ts";
import {
  ALBERT_SERIES_FIELD,
  ALBERT_VALUE_FIELD,
  compileGroundedFlint,
  groundedFlintPlanForChart,
} from "../../packages/shared/src/flint-grounded.ts";
import type { TraceTableColumn } from "../../packages/shared/src/agent-runtime.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const currency: TraceTableColumn = { key: "revenue", label: "Revenue", type: "currency", currency: "AUD" };
const month: TraceTableColumn = { key: "month", label: "Month", type: "date" };
const service: TraceTableColumn = { key: "service", label: "Service", type: "string" };
const thisYear: TraceTableColumn = { key: "series_this", label: "This year", type: "currency", currency: "AUD" };
const lastYear: TraceTableColumn = { key: "series_last", label: "Last year", type: "currency", currency: "AUD" };

test("production charts compile a closed Flint spec from governed rows, never Nivo", () => {
  const chart = read("app/dash/components/AnalyticalTrace.tsx");
  const compact = read("app/dash/components/InsightsStyleTrace.tsx");
  const layer = read("packages/albert-v3/src/engine/chart-layer.ts");
  assert.match(chart, /groundedFlintPlanForChart/u);
  assert.match(chart, /FlintChartView/u);
  assert.match(chart, /Show the table behind this chart/u);
  assert.match(chart, /isPlaceholderChartRange/u);
  assert.doesNotMatch(chart, /\{showTable \? "Chart" : "Table"\}/u);
  assert.match(chart, /GovernedResultGrid/u);
  assert.match(read("app/dash/components/InsightsStyleTrace.tsx"), /GovernedResultGrid/u);
  assert.doesNotMatch(chart, /The governed source table is not available in this trace/u);
  assert.doesNotMatch(compact, /The governed source table is not available in this trace/u);
  assert.match(compact, /step\.chart\?\.table \? \[step\.chart\]/u);
  assert.doesNotMatch(chart, /style=\{\{ height: chartHeight \}\}/u);
  assert.doesNotMatch(chart, /@nivo\/bar|@nivo\/line/u);
  assert.match(layer, /compileGroundedFlint/u);
  assert.match(layer, /flint: \{/u);
  assert.doesNotMatch(layer, /from ["']vega|from ["']flint-chart/u);
  assert.doesNotMatch(read("packages/shared/src/flint-grounded.ts"), /from ["']vega|from ["']flint-chart/u);
});

test("a ranked category bar becomes a horizontal Flint Bar Chart", () => {
  const plan = compileGroundedFlint({
    caption: "Servicing still leads workshop profit",
    chartType: "bar",
    orientation: "horizontal",
    xKey: "service",
    yKey: "revenue",
    columns: [service, currency],
    rows: [
      { service: "Servicing", revenue: 42 },
      { service: "Tyres", revenue: 31 },
      { service: "Brakes", revenue: 18 },
    ],
  });
  assert.equal(plan.chart_spec.chartType, "Bar Chart");
  assert.equal(plan.chart_spec.encodings.y?.field, "service");
  assert.equal(plan.chart_spec.encodings.x?.field, "revenue");
  assert.equal((plan.semantic_types.revenue as { semanticType: string }).semanticType, "Price");
  const spec = assembleFlintSpec(plan, "light");
  assert.ok(spec.mark || spec.layer || spec.spec);
});

test("a time series becomes a Flint Line Chart", () => {
  const plan = compileGroundedFlint({
    caption: "Coffee sales rose into winter",
    chartType: "line",
    xKey: "month",
    yKey: "revenue",
    timeAxis: true,
    timeRangeLabel: "2026",
    columns: [month, currency],
    rows: [
      { month: "2026-01", revenue: 12 },
      { month: "2026-02", revenue: 18 },
      { month: "2026-03", revenue: 15 },
    ],
  });
  assert.equal(plan.chart_spec.chartType, "Line Chart");
  assert.equal(plan.chart_spec.encodings.x?.field, "month");
  assert.match(plan.chart_spec.subtitle, /2026/u);
  assembleFlintSpec(plan, "light");
});

test("period comparison unpivots to a Grouped Bar; composition uses color", () => {
  const rows = [
    { month: "2026-01", series_this: 10, series_last: 8 },
    { month: "2026-02", series_this: 14, series_last: 9 },
    { month: "2026-03", series_this: 11, series_last: 7 },
  ];
  const columns = [month, thisYear, lastYear];
  const series = [
    { key: "series_this", label: "This year" },
    { key: "series_last", label: "Last year" },
  ];
  const grouped = compileGroundedFlint({
    caption: "This year sits beside last year",
    chartType: "bar",
    xKey: "month",
    yKey: "series_this",
    series,
    timeAxis: true,
    columns,
    rows,
  });
  assert.equal(grouped.chart_spec.chartType, "Grouped Bar Chart");
  assert.equal(grouped.chart_spec.encodings.group?.field, ALBERT_SERIES_FIELD);
  assert.equal(grouped.chart_spec.encodings.y?.field, ALBERT_VALUE_FIELD);
  assert.equal(grouped.data.length, 6);
  assembleFlintSpec(grouped, "light");

  const stacked = compileGroundedFlint({
    caption: "The mix of this year and last",
    chartType: "bar",
    stacked: true,
    xKey: "month",
    yKey: "series_this",
    series,
    timeAxis: true,
    columns,
    rows,
  });
  assert.equal(stacked.chart_spec.chartType, "Stacked Bar Chart");
  assert.equal(stacked.chart_spec.encodings.color?.field, ALBERT_SERIES_FIELD);
  assembleFlintSpec(stacked, "light");
});

test("historical chart events without flint still compile from the governed table", () => {
  const plan = groundedFlintPlanForChart({
    caption: "Servicing still leads",
    chartType: "bar",
    xKey: "service",
    yKey: "revenue",
    orientation: "horizontal",
  }, {
    columns: [service, currency],
    rows: [
      { service: "Servicing", revenue: 42 },
      { service: "Tyres", revenue: 31 },
      { service: "Brakes", revenue: 18 },
    ],
    provenance: {
      sources: [],
      timeRange: { label: "FY26", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
      definitions: [],
      semanticBundleHash: "x",
      identityGraph: { version: 0, hash: "x" },
    },
  });
  assert.equal(plan.chart_spec.chartType, "Bar Chart");
  assert.match(plan.chart_spec.subtitle, /FY26/u);
});

test("card-fitted charts share the host surface and stay inside the frame", () => {
  const theme = albertFlintTheme("light");
  const surface = (theme.ink as { surface: { canvas: string; plot: string } }).surface;
  assert.equal(surface.canvas, "#ffffff");
  assert.equal(surface.plot, surface.canvas);
  assert.doesNotMatch(JSON.stringify(theme), /#f4f1ea/u);

  const plan = compileGroundedFlint({
    caption: "Coffee sales rose into winter",
    chartType: "line",
    xKey: "month",
    yKey: "revenue",
    timeAxis: true,
    columns: [month, currency],
    rows: [
      { month: "2026-01", revenue: 12 },
      { month: "2026-02", revenue: 18 },
      { month: "2026-03", revenue: 15 },
    ],
  });
  const { spec } = assembleFlintChart(plan, "light", { width: 534, height: 350 });
  assert.equal(spec.background, "#ffffff");
  assert.equal(spec.title, null);
  assert.deepEqual(spec.autosize, { type: "pad" });
  const view = (spec.config as { view?: { fill?: string; clip?: boolean } }).view;
  assert.equal(view?.fill, "#ffffff");
  assert.notEqual(view?.clip, true);
});

test("the browser frames the painted SVG instead of clipping it to a fixed box", () => {
  const view = read("app/dash/components/FlintChartView.tsx");
  const css = read("app/dash/dash.module.css");
  const host = read("app/dash/components/test-chart-workspace.module.css");
  assert.match(view, /containDrawnChart/u);
  assert.match(view, /getBBox\(\)/u);
  assert.match(view, /viewBox/u);
  assert.match(view, /preserveAspectRatio/u);
  assert.match(css, /\.traceChartCanvas svg \{[\s\S]*height:\s*auto/u);
  assert.match(host, /\.chartCanvas[^{]*\{[\s\S]*height:\s*auto/u);
  assert.doesNotMatch(view, /autosize:\s*\{\s*type:\s*["']fit["']/u);
});

test("line charts draw a point on each reading by default", () => {
  const theme = albertFlintTheme("light");
  assert.equal((theme.chartDefaults as { "Line Chart": { showPoints: boolean } })["Line Chart"].showPoints, true);
  assert.equal((theme.marks as { point: { presence: string } }).point.presence, "full");

  const plan = compileGroundedFlint({
    caption: "Coffee sales rose into winter",
    chartType: "line",
    xKey: "month",
    yKey: "revenue",
    timeAxis: true,
    columns: [month, currency],
    rows: [
      { month: "2026-01", revenue: 12 },
      { month: "2026-02", revenue: 18 },
      { month: "2026-03", revenue: 15 },
    ],
  });
  const spec = assembleFlintSpec(plan, "light");
  const marks = collectMarks(spec);
  assert.ok(marks.some((mark) => mark.type === "line" && Boolean(mark.point)));
  assert.ok(marks.some((mark) => mark.type === "text"));
  assert.match(JSON.stringify(spec), /__albert_value_label/u);
  assert.doesNotMatch(JSON.stringify(spec), /format\(datum\[/u);
  assert.equal(formatPointValue(12_000, { semanticType: "Price", unit: "AUD" }), "A$12k");
  assert.equal(formatPointValue(15.4, { semanticType: "Price", unit: "AUD" }), "A$15.40");
});

test("line labels stay numbers on Cube keys; Vega-Lite must not format them", () => {
  const plan = compileGroundedFlint({
    caption: "Monthly sales",
    chartType: "line",
    xKey: "sales_analytics.completed_at.month",
    yKey: "sales_analytics.total_sales",
    timeAxis: true,
    columns: [
      { key: "sales_analytics.completed_at.month", label: "Month", type: "datetime" },
      { key: "sales_analytics.total_sales", label: "Total sales", type: "currency", currency: "AUD" },
    ],
    rows: [
      { "sales_analytics.completed_at.month": "2026-01-01", "sales_analytics.total_sales": 12_000 },
      { "sales_analytics.completed_at.month": "2026-02-01", "sales_analytics.total_sales": 18_000 },
      { "sales_analytics.completed_at.month": "2026-03-01", "sales_analytics.total_sales": 15.4 },
    ],
  });
  const { spec } = assembleFlintChart(plan, "light", { width: 534, height: 350 });
  const values = (spec.data as { values?: Array<Record<string, unknown>> } | undefined)?.values
    ?? ((spec.spec as { data?: { values?: Array<Record<string, unknown>> } } | undefined)?.data?.values);
  assert.ok(values);
  assert.deepEqual(values.map((row) => row.__albert_value_label), ["A$12k", "A$18k", "A$15.40"]);
  assert.doesNotMatch(JSON.stringify(spec), /format\(datum\[/u);
});

test("Cube keys on a bar do not produce an unparseable tooltip", () => {
  assert.equal(vegaSafeField("sales_analytics.gross_takings"), "sales_analytics__gross_takings");
  const plan = compileGroundedFlint({
    caption: "Gross takings by month",
    chartType: "bar",
    xKey: "sales_analytics.completed_at.month",
    yKey: "sales_analytics.gross_takings",
    timeAxis: true,
    columns: [
      { key: "sales_analytics.completed_at.month", label: "Month", type: "datetime" },
      { key: "sales_analytics.gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
    ],
    rows: [
      { "sales_analytics.completed_at.month": "2026-01-01", "sales_analytics.gross_takings": 12_000 },
      { "sales_analytics.completed_at.month": "2026-02-01", "sales_analytics.gross_takings": 18_000 },
      { "sales_analytics.completed_at.month": "2026-03-01", "sales_analytics.gross_takings": 15_000 },
    ],
  });
  const { spec } = assembleFlintChart(plan, "light", { width: 534, height: 350 });
  const values = (spec.data as { values?: Array<Record<string, unknown>> }).values;
  assert.ok(values?.every((row) => "sales_analytics__gross_takings" in row));
  assert.ok(values?.every((row) => !("sales_analytics.gross_takings" in row)));
  assert.doesNotThrow(() => vega.parse(compile(spec).spec, {}, { ast: true }));
});

test("a year-on-year overlay uses the measure name on the y axis and keeps month order", () => {
  const plan = compileGroundedFlint({
    caption: "Monthly sales: 2026 versus the same period in 2025",
    chartType: "line",
    xKey: "month",
    yKey: "series_this",
    series: [
      { key: "series_this", label: "Jan 2026 – 19 Aug 2026" },
      { key: "series_last", label: "Jan 2025 – 19 Aug 2025" },
    ],
    timeAxis: false,
    measureLabel: "Total sales",
    columns: [
      { key: "month", label: "Month", type: "string" },
      thisYear,
      lastYear,
    ],
    rows: [
      { month: "Jan", series_this: 50, series_last: 40 },
      { month: "Feb", series_this: 52, series_last: 41 },
      { month: "Mar", series_this: 48, series_last: 39 },
    ],
  });
  assert.equal(plan.field_display_names[ALBERT_VALUE_FIELD], "Total sales");
  assert.notEqual(plan.field_display_names[ALBERT_VALUE_FIELD], "Jan 2026 – 19 Aug 2026");
  assert.equal(plan.semantic_types.month, "Category");

  const { spec } = assembleFlintChart(plan, "light", { width: 534, height: 350 });
  preserveCategoryDomainOrder(spec, plan);
  const body = (spec.spec && typeof spec.spec === "object" ? spec.spec : spec) as { encoding?: { x?: { sort?: unknown } }; layer?: Array<{ encoding?: { x?: { sort?: unknown } } }> };
  const xSort = body.encoding?.x?.sort ?? body.layer?.find((layer) => layer.encoding?.x)?.encoding?.x?.sort;
  assert.deepEqual(xSort, ["Jan", "Feb", "Mar"]);
});

function collectMarks(node: unknown): Array<{ type?: string; point?: unknown }> {
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const mark = record.mark && typeof record.mark === "object"
    ? [record.mark as { type?: string; point?: unknown }]
    : typeof record.mark === "string"
      ? [{ type: record.mark }]
      : [];
  const nested = [record.spec, record.layer, record.hconcat, record.vconcat]
    .flatMap((child) => Array.isArray(child) ? child : child ? [child] : [])
    .flatMap(collectMarks);
  return [...mark, ...nested];
}
