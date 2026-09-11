import assert from "node:assert/strict";
import test from "node:test";
import {
  codexChartReformatQueryAllowance,
  prepareCodexChart,
  type CodexChartEvidence,
  type CodexChartState,
} from "../../packages/albert-codex/src/chart-runtime.ts";
import { CODEX_DYNAMIC_TOOL_SPECS } from "../../packages/albert-codex/src/contracts.ts";
import type { TraceProvenance, TraceTableColumn } from "../../packages/shared/src/index.ts";

const provenance: TraceProvenance = {
  sources: [{ connector: "lightspeed", label: "Lightspeed", dataThrough: "2026-08-20" }],
  timeRange: {
    label: "1 January–30 April 2026",
    start: "2026-01-01",
    end: "2026-04-30",
    timezone: "Australia/Melbourne",
  },
  definitions: [],
  semanticBundleHash: "codex-chart-fixture",
  identityGraph: { version: 0, hash: "fixture" },
};

const month: TraceTableColumn = { key: "sales.month", label: "Month", type: "datetime" };
const sales: TraceTableColumn = { key: "sales.value", label: "Gross takings", type: "currency", currency: "AUD" };
const category: TraceTableColumn = { key: "sales.category", label: "Category", type: "string" };
const period: TraceTableColumn = { key: "compare_date_range", label: "Period", type: "string" };

function state(): CodexChartState {
  return { emitted: 0, maxCharts: 2, signatures: new Set() };
}

function evidence(input: Readonly<{
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, string | number | null>>[];
  topic?: string;
}>): CodexChartEvidence {
  return {
    resultId: "01J00000000000000000000901",
    topic: input.topic ?? "Sales evidence",
    columns: input.columns,
    rows: input.rows,
    provenance,
    rowCount: input.rows.length,
  };
}

test("chart captions accept proven reporting dates without authorizing invented financial figures", () => {
  const source = evidence({ columns: [category, sales], rows: [{ [category.key]: "North", [sales.key]: 400 }, { [category.key]: "South", [sales.key]: 200 }] });
  source.provenance = { ...provenance, timeRange: { ...provenance.timeRange, start: "2026-08-01", end: "2026-08-31", label: "August 2026" } };
  for (const caption of ["Gross takings by store — August 2026", "Gross takings by store, 1–31 August 2026"]) {
    const decision = prepareCodexChart({ question: "Chart those stores", source, state: state(), request: { resultId: source.resultId, purpose: "comparison", caption, chartType: "bar", xKey: category.key, yKey: sales.key, limit: 2 } });
    assert.ok(decision.ok, decision.ok ? "" : decision.error);
    assert.equal(decision.prepared.chart.caption, caption);
  }
  const invalid = prepareCodexChart({ question: "Chart those stores", source, state: state(), request: { resultId: source.resultId, purpose: "comparison", caption: "August 2026 gross takings were $2026", chartType: "bar", xKey: category.key, yKey: sales.key } });
  assert.equal(invalid.ok, false);
});

test("Codex compiles an ordered governed trend into the existing Flint chart contract", () => {
  const source = evidence({
    columns: [month, sales],
    rows: [
      { "sales.month": "2026-01-01", "sales.value": 100 },
      { "sales.month": "2026-02-01", "sales.value": 140 },
      { "sales.month": "2026-03-01", "sales.value": 125 },
      { "sales.month": "2026-04-01", "sales.value": 170 },
    ],
  });
  const decision = prepareCodexChart({
    question: "How did sales trend by month?",
    source,
    state: state(),
    request: {
      resultId: source.resultId,
      purpose: "trend",
      caption: "Monthly sales strengthened into April",
      chartType: "auto",
      xKey: month.key,
      yKey: sales.key,
    },
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.prepared.chart.chartType, "line");
  assert.equal(decision.prepared.chart.flint.chart_spec.chartType, "Line Chart");
  assert.equal(decision.prepared.chart.dataRef, decision.prepared.table.resultId);
  assert.deepEqual(decision.prepared.table.rows.map((row) => row[month.key]), [
    "2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01",
  ]);
  assert.equal(decision.prepared.table.provenance.definitions.at(-1)?.metric, "albert.chart_transform");
});

test("Codex derives a governed cumulative running total as a line chart", () => {
  const source = evidence({
    columns: [month, sales],
    rows: [
      { "sales.month": "2026-01-01", "sales.value": 30280.46 },
      { "sales.month": "2026-02-01", "sales.value": 34706.96 },
      { "sales.month": "2026-03-01", "sales.value": 32775.48 },
      { "sales.month": "2026-04-01", "sales.value": 28032.9 },
    ],
  });
  const decision = prepareCodexChart({
    question: "Chart cumulative gross profit for the year so far",
    source,
    state: state(),
    request: {
      resultId: source.resultId,
      purpose: "trend",
      caption: "Cumulative gross takings reached $125,795.80 by April",
      chartType: "auto",
      xKey: month.key,
      yKey: sales.key,
      transform: "cumulative",
    },
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.prepared.chart.chartType, "line");
  assert.deepEqual(decision.prepared.table.rows.map((row) => row[sales.key]), [
    30280.46, 64987.42, 97762.9, 125795.8,
  ]);
  assert.equal(decision.prepared.table.columns.find((column) => column.key === sales.key)?.label, "Cumulative Gross takings");
  assert.equal(decision.prepared.notes.some((note) => /running totals/iu.test(note)), true);

  const categorical = evidence({
    columns: [category, sales],
    rows: [
      { "sales.category": "Bikes", "sales.value": 100 },
      { "sales.category": "Parts", "sales.value": 200 },
      { "sales.category": "Services", "sales.value": 300 },
    ],
  });
  const rejectedCumulative = prepareCodexChart({
    question: "Chart cumulative sales by category",
    source: categorical,
    state: state(),
    request: {
      resultId: categorical.resultId,
      purpose: "comparison",
      caption: "Cumulative sales",
      chartType: "auto",
      xKey: category.key,
      yKey: sales.key,
      transform: "cumulative",
    },
  });
  assert.equal(rejectedCumulative.ok, false);
  if (rejectedCumulative.ok) return;
  assert.equal(rejectedCumulative.error, "cumulative_requires_time");
});

test("Codex uses ranked horizontal bars for category comparisons", () => {
  const source = evidence({
    columns: [category, sales],
    rows: [
      { "sales.category": "Bikes", "sales.value": 100 },
      { "sales.category": "Services", "sales.value": 300 },
      { "sales.category": "Parts", "sales.value": 200 },
      { "sales.category": "Clothing", "sales.value": 50 },
    ],
  });
  const decision = prepareCodexChart({
    question: "Which categories performed best?",
    source,
    state: state(),
    request: {
      resultId: source.resultId,
      purpose: "ranking",
      caption: "Services led category sales",
      chartType: "auto",
      xKey: category.key,
      yKey: sales.key,
    },
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.prepared.chart.chartType, "bar");
  assert.equal(decision.prepared.chart.orientation, "horizontal");
  assert.equal(decision.prepared.chart.flint.chart_spec.chartType, "Bar Chart");
  assert.deepEqual(decision.prepared.table.rows.map((row) => row[category.key]), [
    "Services", "Parts", "Bikes", "Clothing",
  ]);
});

test("Codex recognises natural chart-reformat follow-ups and honours an explicit line", () => {
  const temporal = evidence({
    columns: [month, sales],
    rows: [
      { "sales.month": "2026-03-01", "sales.value": 125 },
      { "sales.month": "2026-01-01", "sales.value": 100 },
      { "sales.month": "2026-02-01", "sales.value": 140 },
    ],
  });
  const line = prepareCodexChart({
    question: "Go back to chronological order and make it a line.",
    source: temporal,
    state: state(),
    request: {
      resultId: temporal.resultId,
      purpose: "trend",
      caption: "Monthly sales in chronological order",
      chartType: "line",
      xKey: month.key,
      yKey: sales.key,
    },
  });
  assert.ok(line.ok, JSON.stringify(line));
  assert.equal(line.prepared.chart.chartType, "line");
  assert.deepEqual(line.prepared.table.rows.map((row) => row[month.key]), [
    "2026-01-01", "2026-02-01", "2026-03-01",
  ]);

  const categorical = evidence({
    columns: [category, sales],
    rows: [
      { "sales.category": "Mon", "sales.value": 100 },
      { "sales.category": "Tue", "sales.value": 130 },
      { "sales.category": "Wed", "sales.value": 115 },
    ],
  });
  const explicitCategoricalLine = prepareCodexChart({
    question: "Make it a line chart.",
    source: categorical,
    state: state(),
    request: {
      resultId: categorical.resultId,
      purpose: "trend",
      caption: "Sales by weekday",
      chartType: "line",
      xKey: category.key,
      yKey: sales.key,
    },
  });
  assert.ok(explicitCategoricalLine.ok, JSON.stringify(explicitCategoricalLine));
  assert.equal(explicitCategoricalLine.prepared.chart.chartType, "line");

  const bars = prepareCodexChart({
    question: "Switch it back to bars and sort by value.",
    source: categorical,
    state: state(),
    request: {
      resultId: categorical.resultId,
      purpose: "ranking",
      caption: "Sales by weekday ranked by value",
      chartType: "bar",
      xKey: category.key,
      yKey: sales.key,
    },
  });
  assert.ok(bars.ok, JSON.stringify(bars));
  assert.equal(bars.prepared.chart.chartType, "bar");
  assert.deepEqual(bars.prepared.table.rows.map((row) => row[category.key]), ["Tue", "Wed", "Mon"]);

  const implicitSort = prepareCodexChart({
    question: "Sort the months from highest to lowest cost.",
    source: temporal,
    state: state(),
    continuationOfChart: true,
    request: {
      resultId: temporal.resultId,
      purpose: "ranking",
      caption: "Monthly sales ranked highest to lowest",
      chartType: "bar",
      xKey: month.key,
      yKey: sales.key,
    },
  });
  assert.ok(implicitSort.ok, JSON.stringify(implicitSort));
  assert.equal(implicitSort.prepared.chart.chartType, "bar");

  assert.equal(codexChartReformatQueryAllowance("Sort the months from highest to lowest cost."), 0);
  assert.equal(codexChartReformatQueryAllowance("Now just show me the totals for each year as bars."), 0);
  assert.equal(codexChartReformatQueryAllowance("Show it weekly instead."), 1);
  assert.equal(codexChartReformatQueryAllowance("Add last year's monthly refunds as a comparison."), 1);
  assert.equal(codexChartReformatQueryAllowance("Chart units sold instead of revenue for those five."), 1);
});

test("Codex overlays like-for-like periods as bounded Flint series", () => {
  const source = evidence({
    columns: [month, period, sales],
    rows: [
      { "sales.month": "2025-01-01", compare_date_range: "2025-01-01T00:00:00.000 - 2025-03-31T23:59:59.999", "sales.value": 80 },
      { "sales.month": "2026-01-01", compare_date_range: "2026-01-01T00:00:00.000 - 2026-03-31T23:59:59.999", "sales.value": 100 },
      { "sales.month": "2025-02-01", compare_date_range: "2025-01-01T00:00:00.000 - 2025-03-31T23:59:59.999", "sales.value": 90 },
      { "sales.month": "2026-02-01", compare_date_range: "2026-01-01T00:00:00.000 - 2026-03-31T23:59:59.999", "sales.value": 120 },
      { "sales.month": "2025-03-01", compare_date_range: "2025-01-01T00:00:00.000 - 2025-03-31T23:59:59.999", "sales.value": 95 },
      { "sales.month": "2026-03-01", compare_date_range: "2026-01-01T00:00:00.000 - 2026-03-31T23:59:59.999", "sales.value": 110 },
    ],
  });
  const decision = prepareCodexChart({
    question: "Compare this year with the previous year by month",
    source,
    state: state(),
    request: {
      resultId: source.resultId,
      purpose: "comparison",
      caption: "This year stayed ahead through March",
      chartType: "auto",
      xKey: month.key,
      yKey: sales.key,
      seriesKey: period.key,
    },
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.prepared.chart.chartType, "line");
  assert.equal(decision.prepared.chart.series?.length, 2);
  assert.deepEqual(decision.prepared.table.rows.map((row) => row[month.key]), ["Jan", "Feb", "Mar"]);
  assert.equal(decision.prepared.chart.flint.chart_spec.chartType, "Line Chart");
  assert.equal(
    decision.prepared.chart.flint.field_display_names.__albert_value,
    "Gross takings",
  );
});

test("Codex chart selection fails closed when a visual would mislead or add nothing", () => {
  const ranked = evidence({
    columns: [category, sales],
    rows: [
      { "sales.category": "Bikes", "sales.value": 100 },
      { "sales.category": "Services", "sales.value": 100 },
      { "sales.category": "Parts", "sales.value": 100 },
    ],
  });
  const base = {
    resultId: ranked.resultId,
    purpose: "ranking" as const,
    caption: "Category sales",
    chartType: "auto" as const,
    xKey: category.key,
    yKey: sales.key,
  };
  const direct = prepareCodexChart({
    question: "What were total sales yesterday?",
    source: ranked,
    state: state(),
    request: base,
  });
  assert.equal(direct.ok, false);
  if (!direct.ok) assert.equal(direct.error, "chart_not_useful_for_question");

  const equal = prepareCodexChart({
    question: "Which categories ranked highest?",
    source: ranked,
    state: state(),
    request: base,
  });
  assert.equal(equal.ok, false);
  if (!equal.ok) assert.equal(equal.error, "equal_values");

  const tooShort = evidence({
    columns: [month, sales],
    rows: [
      { "sales.month": "2026-01-01", "sales.value": 100 },
      { "sales.month": "2026-02-01", "sales.value": 120 },
    ],
  });
  const short = prepareCodexChart({
    question: "Chart the monthly trend",
    source: tooShort,
    state: state(),
    request: { ...base, resultId: tooShort.resultId, purpose: "trend", xKey: month.key },
  });
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.error, "too_few_points");
});

test("the Codex tool surface accepts chart intent and keys, never model-authored plot rows", () => {
  const namespace = CODEX_DYNAMIC_TOOL_SPECS[0];
  const chart = namespace.tools.find((tool) => tool.name === "make_chart");
  assert.ok(chart);
  assert.deepEqual(chart.inputSchema.required, ["resultId", "purpose", "caption", "chartType", "xKey", "yKey"]);
  assert.equal("rows" in chart.inputSchema.properties, false);
  assert.equal("data" in chart.inputSchema.properties, false);
  assert.match(chart.description, /Never chart a scalar/u);
});

test("an identical chart from a cloned result is rejected as a duplicate", () => {
  const rows = [
    { "sales.month": "2026-01-01T00:00:00.000", "sales.value": 100 },
    { "sales.month": "2026-02-01T00:00:00.000", "sales.value": 140 },
    { "sales.month": "2026-03-01T00:00:00.000", "sales.value": 120 },
  ];
  const shared = state();
  const request = {
    resultId: "01J00000000000000000000901",
    purpose: "trend" as const,
    caption: "Monthly gross takings",
    chartType: "line" as const,
    xKey: "sales.month",
    yKey: "sales.value",
  };
  const first = prepareCodexChart({ question: "Chart my monthly takings trend", request, source: evidence({ columns: [month, sales], rows }), state: shared });
  assert.ok(first.ok, JSON.stringify(first));
  shared.emitted += 1;
  shared.signatures.add(first.prepared.signature);

  // Same plotted values from a different resultId (a re-derived clone of the
  // same data) must still count as the same chart the owner already has.
  const clone = { ...evidence({ columns: [month, sales], rows }), resultId: "01J00000000000000000000902" };
  const second = prepareCodexChart({ question: "Chart my monthly takings trend", request: { ...request, resultId: clone.resultId }, source: clone, state: shared });
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.error, "duplicate_chart");

  // Different data is a genuinely different chart and stays allowed.
  const differentRows = rows.map((row) => ({ ...row, "sales.value": (row["sales.value"] as number) + 5 }));
  const third = prepareCodexChart({
    question: "Chart my monthly takings trend",
    request: { ...request, resultId: "01J00000000000000000000903" },
    source: { ...evidence({ columns: [month, sales], rows: differentRows }), resultId: "01J00000000000000000000903" },
    state: shared,
  });
  assert.ok(third.ok, JSON.stringify(third));
});
