import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  InvalidChartSpecError,
  validateChartSpec,
} from "../../packages/agent/src/chart-policy.js";
import type { GovernedResult } from "../../packages/agent/src/semantic-tools.js";
import type { TraceTableColumn } from "../../packages/shared/src/agent-runtime.js";

const provenance = Object.freeze({
  sources: Object.freeze([]),
  timeRange: Object.freeze({
    label: "Last 12 months",
    start: "2025-08-01T00:00:00.000Z",
    end: "2026-08-01T00:00:00.000Z",
    timezone: "Australia/Melbourne",
  }),
  definitions: Object.freeze([]),
  semanticBundleHash: "a".repeat(64),
  identityGraph: Object.freeze({ version: 1, hash: "b".repeat(32) }),
});

function result(
  columns: readonly TraceTableColumn[],
  rows: GovernedResult["rows"],
): GovernedResult {
  return Object.freeze({
    resultId: "semantic:chart-test",
    columns,
    rows,
    provenance,
    validations: Object.freeze([]),
  });
}

const monthColumn = Object.freeze({ key: "month", label: "Month", type: "date" as const });
const categoryColumn = Object.freeze({ key: "category", label: "Category", type: "string" as const });
const salesColumn = Object.freeze({
  key: "net_sales",
  label: "Net sales",
  type: "currency" as const,
  currency: "AUD",
});
const priorSalesColumn = Object.freeze({
  key: "prior_sales",
  label: "Prior net sales",
  type: "currency" as const,
  currency: "AUD",
});

test("line charts require and accept a real ordered result axis", () => {
  const governed = result(
    [monthColumn, salesColumn, priorSalesColumn],
    [
      { month: "2026-05-01", net_sales: "1200.2500", prior_sales: "1000.0000" },
      { month: "2026-06-01", net_sales: "1400.0000", prior_sales: "1100.0000" },
      { month: "2026-07-01", net_sales: "1325.5000", prior_sales: "1250.0000" },
    ],
  );
  const validated = validateChartSpec(governed, {
    dataRef: governed.resultId,
    chartType: "line",
    xKey: "month",
    yKey: "net_sales",
    series: [
      { key: "net_sales", label: "Sales" },
      { key: "prior_sales", label: "Prior" },
    ],
  });

  assert.equal(validated.xKind, "ordered");
  assert.equal(validated.pointCount, 3);
  assert.deepEqual(validated.series.map(({ key }) => key), ["net_sales", "prior_sales"]);
});

test("line charts reject a time axis returned out of chronological order", () => {
  const governed = result(
    [monthColumn, salesColumn],
    [
      { month: "2026-06-01", net_sales: "1400.0000" },
      { month: "2026-05-01", net_sales: "1200.2500" },
    ],
  );

  assert.throws(
    () => validateChartSpec(governed, {
      dataRef: governed.resultId,
      chartType: "line",
      xKey: "month",
      yKey: "net_sales",
    }),
    /earliest or lowest x-axis value/u,
  );
});

test("categorical comparisons are bars and cannot be connected as a line", () => {
  const governed = result(
    [categoryColumn, salesColumn],
    [
      { category: "Bikes", net_sales: "84240.0000" },
      { category: "Workshop", net_sales: "31800.0000" },
    ],
  );

  assert.equal(validateChartSpec(governed, {
    dataRef: governed.resultId,
    chartType: "bar",
    xKey: "category",
    yKey: "net_sales",
  }).xKind, "categorical");
  assert.throws(
    () => validateChartSpec(governed, {
      dataRef: governed.resultId,
      chartType: "line",
      xKey: "category",
      yKey: "net_sales",
    }),
    (error) => error instanceof InvalidChartSpecError && /ordered numeric or time axis/u.test(error.message),
  );
});

test("the chart gate rejects duplicate x-values and mixed units", () => {
  const duplicate = result(
    [categoryColumn, salesColumn],
    [
      { category: "Bikes", net_sales: "100" },
      { category: "Bikes", net_sales: "200" },
    ],
  );
  assert.throws(
    () => validateChartSpec(duplicate, {
      dataRef: duplicate.resultId,
      chartType: "bar",
      xKey: "category",
      yKey: "net_sales",
    }),
    /one row per x-axis value/u,
  );

  const marginColumn = Object.freeze({ key: "margin_rate", label: "Margin", type: "percent" as const });
  const mixed = result(
    [categoryColumn, salesColumn, marginColumn],
    [
      { category: "Bikes", net_sales: "100", margin_rate: "0.35" },
      { category: "Workshop", net_sales: "200", margin_rate: "0.70" },
    ],
  );
  assert.throws(
    () => validateChartSpec(mixed, {
      dataRef: mixed.resultId,
      chartType: "bar",
      xKey: "category",
      yKey: "net_sales",
      series: [
        { key: "net_sales", label: "Net sales" },
        { key: "margin_rate", label: "Margin" },
      ],
    }),
    /different units or currencies/u,
  );
});

test("the response surface uses Nivo bar and line renderers with governed table references", () => {
  const renderer = readFileSync(new URL("../../app/dash/components/AnalyticalTrace.tsx", import.meta.url), "utf8");
  const responseSurface = readFileSync(new URL("../../app/dash/components/InsightsStyleTrace.tsx", import.meta.url), "utf8");
  const liveRuntime = readFileSync(new URL("../../services/conversation/src/live.ts", import.meta.url), "utf8");

  assert.match(renderer, /from "@nivo\/bar"/u);
  assert.match(renderer, /from "@nivo\/line"/u);
  assert.match(renderer, /<ResponsiveBar/u);
  assert.match(renderer, /<ResponsiveLine/u);
  assert.match(renderer, /enablePoints=\{rows\.length <= 36\}/u);
  assert.match(renderer, /Exact values are available in the governed source table/u);
  assert.match(responseSurface, /lazy\(\(\) => import\("\.\/AnalyticalTrace"\)/u);
  assert.match(responseSurface, /<Suspense/u);
  assert.match(responseSurface, /model\.charts\.map/u);
  assert.match(responseSurface, /<ResultChart/u);
  assert.match(liveRuntime, /validateChartSpec\(result, input\)/u);
  assert.match(liveRuntime, /A category comparison or ranking with up to 40 distinct categories is a bar chart/u);
});
