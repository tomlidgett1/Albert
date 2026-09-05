/**
 * Dashboard mode's live-view contracts: how a build turn's trace becomes the
 * panel's preview tiles (drafts while designing, the composed plan once it
 * lands), and the dashboard-flavoured thinking states the chat narrates
 * ("Determining the best elements", "Creating element: …").
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { TraceEvent } from "../../packages/shared/src/index.js";
import {
  buildDashboardBuildView,
  dashboardActivityLabel,
  isDashboardBuildTurn,
} from "../../app/dash/lib/dashboard-build-view.js";

const stamp = "2026-09-01T00:00:00.000Z";

function queryEvent(sequence: number, name: string, resultId: string): TraceEvent {
  return {
    id: `q${sequence}`,
    sequence,
    type: "query",
    status: "complete",
    occurredAt: stamp,
    topic: "Sales analytics",
    name,
    metrics: ["sales_analytics.gross_takings"],
    dimensions: [],
    timeRange: { label: "last 30 days", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
    lens: "Cube view: sales_analytics",
    view: "sales_analytics",
    cubesUsed: ["sales_analytics"],
    queryYaml: "measures:\n  - sales_analytics.gross_takings",
    rowCount: 2,
    executionMs: 500,
    connector: "lightspeed",
    resultId,
  } as unknown as TraceEvent;
}

function tableEvent(
  sequence: number,
  resultId: string,
  caption: string,
  columns: readonly Record<string, unknown>[],
  rows: readonly Record<string, unknown>[],
  replay = true,
): TraceEvent {
  return {
    id: `t${sequence}`,
    sequence,
    type: "table",
    status: "complete",
    occurredAt: stamp,
    caption,
    columns,
    rows,
    resultId,
    provenance: { sources: [], timeRange: { label: "last 30 days", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" }, definitions: [] },
    presentation: "evidence",
    ...(replay ? {
      dashboardReplay: {
        kind: "cube_v3",
        queryEventId: `q${sequence - 1}`,
        queryDigest: "ab".repeat(32),
        semanticVersionDigest: "cd".repeat(32),
      },
    } : {}),
  } as unknown as TraceEvent;
}

const kpiColumns = [
  { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
  { key: "compareDateRange", label: "Date range", type: "string" },
];
const kpiRows = [
  { sales_analytics_gross_takings: 41230.55, compareDateRange: "2026-08-01 - 2026-08-30" },
  { sales_analytics_gross_takings: 36780.1, compareDateRange: "2026-07-02 - 2026-07-31" },
];
const trendColumns = [
  { key: "sales_analytics_completed_at", label: "Week", type: "date" },
  { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
];
const trendRows = [
  { sales_analytics_completed_at: "2026-08-03", sales_analytics_gross_takings: 9000 },
  { sales_analytics_completed_at: "2026-08-10", sales_analytics_gross_takings: 10250 },
  { sales_analytics_completed_at: "2026-08-17", sales_analytics_gross_takings: 11400 },
];

test("governed results stream in as typed draft tiles before the plan lands", () => {
  const view = buildDashboardBuildView([
    queryEvent(1, "Revenue vs previous 30 days", "01KZZZZZZZZZZZZZZZZZZZZR01"),
    tableEvent(2, "01KZZZZZZZZZZZZZZZZZZZZR01", "Revenue vs previous 30 days", kpiColumns, kpiRows),
    queryEvent(3, "Revenue by week", "01KZZZZZZZZZZZZZZZZZZZZR02"),
    tableEvent(4, "01KZZZZZZZZZZZZZZZZZZZZR02", "Revenue by week", trendColumns, trendRows),
    queryEvent(5, "Refunds by day", "01KZZZZZZZZZZZZZZZZZZZZR03"),
  ] as readonly TraceEvent[], true, true);

  assert.equal(view.isBuildTurn, true);
  assert.equal(view.plan, null);
  assert.equal(view.tiles.length, 2);
  const [kpi, chart] = view.tiles;
  assert.equal(kpi!.kind, "kpi");
  assert.equal(kpi!.drafting, true);
  assert.equal(kpi!.span, 3);
  assert.equal(chart!.kind, "chart");
  assert.equal(chart!.chartType, "line");
  assert.equal(chart!.xKey, "sales_analytics_completed_at");
  // The third query has no table yet: the panel shows it as the element
  // being created right now.
  assert.equal(view.pendingQueryName, "Refunds by day");
  assert.equal(view.activity, "Creating element: Refunds by day");
});

test("a composed plan replaces the drafts with the real layout", () => {
  const events = [
    queryEvent(1, "Revenue vs previous 30 days", "01KZZZZZZZZZZZZZZZZZZZZR01"),
    tableEvent(2, "01KZZZZZZZZZZZZZZZZZZZZR01", "Revenue vs previous 30 days", kpiColumns, kpiRows),
    queryEvent(3, "Revenue by week", "01KZZZZZZZZZZZZZZZZZZZZR02"),
    tableEvent(4, "01KZZZZZZZZZZZZZZZZZZZZR02", "Revenue by week", trendColumns, trendRows),
    {
      id: "plan1",
      sequence: 5,
      type: "dashboard_plan",
      status: "complete",
      occurredAt: stamp,
      dashboardTitle: "Ashburton at a glance",
      timeframe: "Last 30 days vs the previous 30",
      tiles: [
        { resultId: "01KZZZZZZZZZZZZZZZZZZZZR01", kind: "kpi", title: "Revenue", note: "vs previous 30 days", width: "quarter", valueKey: "sales_analytics_gross_takings" },
        { resultId: "01KZZZZZZZZZZZZZZZZZZZZR02", kind: "chart", title: "Revenue by week", width: "twoThirds", chartType: "line", xKey: "sales_analytics_completed_at", yKey: "sales_analytics_gross_takings" },
      ],
    } as unknown as TraceEvent,
  ] as readonly TraceEvent[];
  const view = buildDashboardBuildView(events, true);

  assert.equal(view.plan?.dashboardTitle, "Ashburton at a glance");
  assert.equal(view.tiles.length, 2);
  assert.equal(view.tiles[0]!.title, "Revenue");
  assert.equal(view.tiles[0]!.drafting, undefined);
  assert.equal(view.tiles[0]!.span, 3);
  assert.equal(view.tiles[1]!.span, 8);
  assert.equal(view.activity, "Composing the dashboard");
});

test("thinking states narrate the build as design work", () => {
  const progress = (label: string): TraceEvent => ({
    id: `p-${label}`,
    sequence: 1,
    type: "progress",
    status: "running",
    stage: "planning",
    occurredAt: stamp,
    label,
  } as unknown as TraceEvent);

  assert.equal(dashboardActivityLabel(progress("Reading the semantic model")), "Reading your data model");
  assert.equal(
    dashboardActivityLabel(progress("Running query: Revenue vs previous 30 days")),
    "Creating element: Revenue vs previous 30 days",
  );
  assert.equal(
    dashboardActivityLabel(progress("Query failed: Refund rate")),
    "Reworking element: Refund rate",
  );
  assert.equal(dashboardActivityLabel(progress("Writing the answer")), "Composing the dashboard");
  assert.equal(
    dashboardActivityLabel({
      id: "r1", sequence: 2, type: "research", status: "complete", occurredAt: stamp,
      tool: "search_model", label: "Sales analytics",
    } as unknown as TraceEvent),
    "Determining the best elements",
  );
});

test("only dashboard-architect turns are detected as build turns", () => {
  const ordinary = [
    queryEvent(1, "Revenue by week", "01KZZZZZZZZZZZZZZZZZZZZR09"),
    tableEvent(2, "01KZZZZZZZZZZZZZZZZZZZZR09", "Revenue by week", trendColumns, trendRows, false),
  ] as readonly TraceEvent[];
  assert.equal(isDashboardBuildTurn(ordinary), false);
  // Every governed table carries a pinning replay reference; that alone must
  // never read as a dashboard build (it put ordinary answers into build chrome).
  const pinnable = [
    queryEvent(1, "Revenue by week", "01KZZZZZZZZZZZZZZZZZZZZR09"),
    tableEvent(2, "01KZZZZZZZZZZZZZZZZZZZZR09", "Revenue by week", trendColumns, trendRows, true),
  ] as readonly TraceEvent[];
  assert.equal(isDashboardBuildTurn(pinnable), false);
  const build = [
    tableEvent(2, "01KZZZZZZZZZZZZZZZZZZZZR09", "Revenue by week", trendColumns, trendRows, true),
    {
      id: "p3",
      sequence: 3,
      type: "dashboard_plan",
      status: "complete",
      occurredAt: stamp,
      dashboardTitle: "Trading overview",
      timeframe: "Last 30 days",
      tiles: [{ resultId: "01KZZZZZZZZZZZZZZZZZZZZR09", kind: "chart", title: "Revenue by week", width: "full" }],
    },
  ] as unknown as readonly TraceEvent[];
  assert.equal(isDashboardBuildTurn(build), true);
});
