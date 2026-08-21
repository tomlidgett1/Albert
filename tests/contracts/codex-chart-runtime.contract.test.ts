import assert from "node:assert/strict";
import test from "node:test";
import {
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
