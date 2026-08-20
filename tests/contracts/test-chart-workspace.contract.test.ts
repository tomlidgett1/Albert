import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assembleFlintSpec } from "../../app/dash/lib/flint-assemble.ts";
import {
  classifyTestChartQuestion,
  extractJsonObject,
  inventFallbackPlan,
  matchSuiteCase,
  parseInventedPlan,
  parseInventedPlanOrNull,
  parseTestChartResult,
  suiteVerdict,
  TEST_CHART_PLANNER_INSTRUCTIONS,
  TEST_CHART_SUITE,
  validateFlintPlan,
} from "../../app/dash/lib/test-chart.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const page = read("app/dash/page.tsx");
const workspace = read("app/dash/components/TestChartWorkspace.tsx");
const styles = read("app/dash/components/test-chart-workspace.module.css");
const lib = read("app/dash/lib/test-chart.ts");
const route = read("app/api/test-chart/route.ts");
const limits = read("services/control-plane/src/web-repository.ts");
const migration = read("infra/migrations/control-plane/0155_m1_test_chart_rate_limit.sql");

test("Test chart is a first-class dash view that posts invented questions to Flint", () => {
  assert.match(page, /import TestChartWorkspace from "\.\/components\/TestChartWorkspace"/u);
  assert.match(page, /type ActiveItem =[^;]*"Test chart"/su);
  assert.match(page, /requestedView === "TestChart"[\s\S]*setActiveItem\("Test chart"\)/u);
  assert.match(page, /aria-label="Test chart"[\s\S]*aria-current=\{activeItem === "Test chart" \? "page"/u);
  assert.match(page, /activeItem === "Test chart"[\s\S]*<TestChartWorkspace/u);

  assert.match(workspace, /aria-label="Test chart"/u);
  assert.match(workspace, /Ask a made-up question/u);
  assert.match(workspace, /Run suite/u);
  assert.match(workspace, /TEST_CHART_SUITE/u);
  assert.match(workspace, /Flint spec/u);
  assert.match(workspace, /dynamic\(\(\) => import\("\.\/FlintChartView"\),\s*\{\s*ssr:\s*false/u);
  assert.match(workspace, /fetch\("\/api\/test-chart",\s*\{[\s\S]*method: "POST"/u);
  assert.match(workspace, /credentials: "same-origin"/u);
  assert.match(workspace, /cache: "no-store"/u);
  assert.match(workspace, /requestId !== requestIdRef\.current/u);
  assert.doesNotMatch(workspace, /tenantId|tenant_id/u);
  assert.doesNotMatch(workspace, /dangerouslySetInnerHTML/u);
  assert.doesNotMatch(workspace, /antv|nivo|@nivo/iu);

  assert.match(styles, /var\(--dash-control-height\)/u);
  assert.match(styles, /var\(--dash-surface-page\)/u);
  assert.match(styles, /overflow-y:\s*auto/u);
  assert.match(styles, /max-width:\s*100%/u);
  assert.match(styles, /object-fit:\s*contain/u);
  assert.match(styles, /prefers-reduced-motion: reduce/u);
});

test("the test-chart route always uses Luna Max Fast and compiles Flint, not AntV", () => {
  assert.match(route, /assertSameOriginMutation\(request\)/u);
  assert.match(route, /requireUser\(\)/u);
  assert.match(route, /consumeAlbertRateLimit\("test-chart\.generate"\)/u);
  assert.match(route, /readBoundedJsonBody\(request, 2_048\)/u);
  assert.match(route, /"Cache-Control": "private, no-store"/u);
  assert.match(route, /model: "gpt-5\.6-luna"/u);
  assert.match(route, /reasoning: \{ effort: "max" \}/u);
  assert.match(route, /service_tier: "fast"/u);
  assert.match(route, /inventFallbackPlan/u);
  assert.doesNotMatch(route, /vega|vega-embed|vega-lite|vega-interpreter|flint-chart|renderFlintChartSvg/u);
  assert.doesNotMatch(lib, /from ["']vega|from ["']vega-lite|from ["']vega-embed|from ["']vega-interpreter|from ["']flint-chart/u);
  assert.match(read("app/dash/components/FlintChartView.tsx"), /import\("vega-embed"\)/u);
  assert.match(read("app/dash/components/FlintChartView.tsx"), /ast:\s*true/u);
  assert.match(read("app/dash/components/FlintChartView.tsx"), /containDrawnChart/u);
  assert.match(read("app/dash/lib/flint-assemble.ts"), /assembleVegaLite/u);
  assert.doesNotMatch(route, /antv-studio|mcp-server-chart|buildAntvMcpPayload/u);
  assert.doesNotMatch(route, /request\.json\(\)/u);
  assert.match(limits, /"test-chart\.generate": Object\.freeze\(\{ limit: 20, windowSeconds: 60 \}\)/u);
  assert.match(migration, /'test-chart\.generate', 20, 60, false/u);
  assert.match(read("next.config.ts"), /img-src 'self' data: blob:/u);
  assert.match(read("package.json"), /"flint-chart":/u);
  assert.match(read("package.json"), /"vega-embed":/u);
});

test("the planner brief is Flint's authoring contract, not a backend spec", () => {
  assert.match(TEST_CHART_PLANNER_INSTRUCTIONS, /Flint ChartAssemblyInput/u);
  assert.match(TEST_CHART_PLANNER_INSTRUCTIONS, /never write Vega-Lite/u);
  assert.match(TEST_CHART_PLANNER_INSTRUCTIONS, /Grouped Bar Chart, second category on group/u);
  assert.match(TEST_CHART_PLANNER_INSTRUCTIONS, /Waterfall Chart; omit color/u);
  assert.match(TEST_CHART_PLANNER_INSTRUCTIONS, /Pie Chart \(innerRadius 55/u);
  assert.match(TEST_CHART_PLANNER_INSTRUCTIONS, /Do not ask for Funnel, Sankey/u);
  assert.match(TEST_CHART_PLANNER_INSTRUCTIONS, /semantic_types/u);
  assert.doesNotMatch(lib, /generate_line_chart|mcp-server-chart/u);
});

test("the suite covers the chart-choice claims Flint is built to answer", () => {
  assert.equal(TEST_CHART_SUITE.length, 14);
  assert.equal(matchSuiteCase("Which workshop services make the most revenue?")?.id, "rank");
  assert.deepEqual(
    suiteVerdict("Bar Chart", "Which workshop services make the most revenue?"),
    { verdict: "pass", expectedChartTypes: ["Bar Chart", "Lollipop Chart"], suiteId: "rank" },
  );
  assert.equal(suiteVerdict("Pie Chart", "Which workshop services make the most revenue?").verdict, "miss");
  assert.equal(suiteVerdict("Line Chart", "Made-up free question").verdict, "open");
  assert.ok(TEST_CHART_SUITE.some((item) => item.expected.includes("Grouped Bar Chart")));
  assert.ok(TEST_CHART_SUITE.some((item) => item.expected.includes("Waterfall Chart")));
  assert.ok(TEST_CHART_SUITE.some((item) => item.expected.includes("Bullet Chart")));
});

test("question shape picks the Flint form that can answer it", () => {
  assert.equal(classifyTestChartQuestion("How did coffee sales change each month last year?"), "Line Chart");
  assert.equal(classifyTestChartQuestion("Which workshop services make the most revenue?"), "Bar Chart");
  assert.equal(
    classifyTestChartQuestion("What share of bookings come from walk-ins, repeats and referrals?"),
    "Pie Chart",
  );
  assert.equal(classifyTestChartQuestion("How does the checkout funnel drop off?"), "Bar Chart");
  assert.equal(
    classifyTestChartQuestion("Is there a link between ticket size and return visits?"),
    "Scatter Plot",
  );
  assert.equal(classifyTestChartQuestion("Show the histogram of repair times"), "Histogram");
  assert.equal(
    classifyTestChartQuestion("Compare this year's monthly revenue with last year, side by side."),
    "Grouped Bar Chart",
  );
  assert.equal(
    classifyTestChartQuestion("Walk from opening cash to closing cash through the month's movements."),
    "Waterfall Chart",
  );
});

test("fallback plans invent Flint rows that compile", () => {
  const line = inventFallbackPlan("How did coffee sales change each month last year?");
  assert.equal(line.chart_spec.chartType, "Line Chart");
  assert.equal(validateFlintPlan(line), null);
  assert.ok(line.data[0] && "month" in line.data[0]);
  const spec = assembleFlintSpec(line, "light");
  assert.ok(spec.data || spec.datasets || spec.encoding);

  const pie = inventFallbackPlan("What share of bookings come from walk-ins?");
  assert.equal(pie.chart_spec.chartType, "Pie Chart");
  assert.equal(validateFlintPlan(pie), null);
  assembleFlintSpec(pie, "light");

  const grouped = inventFallbackPlan("Compare this year's monthly revenue with last year, side by side.");
  assert.equal(grouped.chart_spec.chartType, "Grouped Bar Chart");
  assert.ok("group" in grouped.chart_spec.encodings);
  assembleFlintSpec(grouped, "light");

  for (const item of TEST_CHART_SUITE) {
    const plan = inventFallbackPlan(item.question);
    assert.equal(validateFlintPlan(plan), null, item.id);
    const spec = assembleFlintSpec(plan, "light");
    assert.ok(spec.mark || spec.layer || spec.spec || spec.hconcat || spec.vconcat, item.id);
  }
});

test("invented model JSON is accepted only when it is a valid Flint spec", () => {
  const parsed = parseInventedPlan({
    rationale: "A ranked bar compares named services.",
    semantic_types: { service: "Category", revenue: "Price" },
    chart_spec: {
      chartType: "Bar Chart",
      title: "Servicing still leads the shop",
      subtitle: "Invented workshop revenue, AUD.",
      encodings: {
        y: { field: "service", sortBy: "x", sortOrder: "descending" },
        x: { field: "revenue" },
      },
    },
    data: [
      { service: "Servicing", revenue: 42 },
      { service: "Tyres", revenue: 31 },
      { service: "Brakes", revenue: 18 },
    ],
  }, "Which workshop services make the most revenue?");
  assert.equal(parsed.chart_spec.chartType, "Bar Chart");
  assert.equal(parsed.chart_spec.title, "Servicing still leads the shop");

  const fallback = parseInventedPlan({
    chartType: "Line Chart",
    data: [{ category: "wrong", value: 1 }],
  }, "How did coffee sales change each month last year?");
  assert.equal(fallback.chart_spec.chartType, "Line Chart");
  assert.ok(fallback.data[0] && "month" in fallback.data[0]);
  assert.equal(parseInventedPlanOrNull({ chartType: "Line Chart", data: [] }), null);

  assert.deepEqual(extractJsonObject('```json\n{"chartType":"Pie Chart"}\n```'), { chartType: "Pie Chart" });
});

test("chart results accept a Flint plan and invented rows, not a remote image", () => {
  const result = parseTestChartResult({
    question: "How did coffee sales change each month last year?",
    invented: true,
    source: "luna",
    chartType: "Line Chart",
    title: "Coffee sales rose into winter",
    subtitle: "Invented monthly revenue, AUD.",
    rationale: "A line chart shows the monthly trend.",
    appearance: "light",
    verdict: "pass",
    expectedChartTypes: ["Line Chart", "Area Chart"],
    suiteId: "trend",
    warnings: [],
    flint: {
      semantic_types: { month: "YearMonth", revenue: "Price" },
      chart_spec: {
        chartType: "Line Chart",
        title: "Coffee sales rose into winter",
        subtitle: "Invented monthly revenue, AUD.",
        encodings: { x: { field: "month" }, y: { field: "revenue" } },
      },
    },
    data: [
      { month: "2026-01", revenue: 12 },
      { month: "2026-02", revenue: 18 },
      { month: "2026-03", revenue: 15 },
    ],
  });
  assert.equal(result?.chartType, "Line Chart");
  assert.equal(result?.source, "luna");
  assert.equal(result && "imageUrl" in result, false);
  assert.equal(
    parseTestChartResult({
      question: "x",
      invented: true,
      source: "luna",
      chartType: "Line Chart",
      title: "x",
      rationale: "x",
      appearance: "light",
      verdict: "open",
      expectedChartTypes: [],
      suiteId: null,
      warnings: [],
      flint: {
        semantic_types: {},
        chart_spec: { chartType: "Line Chart", encodings: {} },
      },
      data: [{ month: "2026-01", revenue: 1 }, { month: "2026-02", revenue: 2 }, { month: "2026-03", revenue: 3 }],
    }),
    null,
  );
});
