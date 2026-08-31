/**
 * Natural-language dashboard builder contracts (ADR 0129): the service-turn
 * flag, the compose-tool schema and its evidence validation, the plan →
 * display mapping, the deterministic layout packer, the brief composer, and
 * the persisted-plan revalidation the apply route trusts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ulid } from "ulid";

import {
  omniComposeDashboardInputSchema,
  omniConversationRequestSchema,
  omniServiceTurnSchema,
  type OmniComposeDashboardInput,
} from "../../packages/albert-omni/src/contracts.js";
import { validateOmniDashboardPlan } from "../../packages/albert-omni/src/runtime.js";
import {
  buildDashboardBriefMessage,
  dashboardPlanEventSchema,
  displayFromPlanTile,
  packDashboardLayouts,
} from "../../services/dashboard-build/src/contracts.js";
import {
  dashboardTileDisplaySchema,
  dashboardLayoutsSchema,
  type DashboardTile,
} from "../../services/control-plane/src/dashboard-repository.js";

const baseTurn = {
  protocolVersion: 1,
  requestId: ulid(),
  tenantId: ulid(),
  actorId: "6f4f27cd-4f9c-4b8f-9a5e-0d6a0d1b2c3d",
  role: "owner",
  conversationId: ulid(),
  turnId: ulid(),
  message: "Design and build my dashboard.",
  priorConversation: [],
  activeConnectors: ["lightspeed-r"],
  connectorFreshness: [],
  cubeBearer: "a.b.c",
  model: "gpt-5.6-luna",
  effort: "max",
  fastMode: false,
} as const;

test("omni service turn accepts dashboardBuild and stays strict", () => {
  assert.equal(omniServiceTurnSchema.safeParse(baseTurn).success, true);
  const withBuild = omniServiceTurnSchema.safeParse({ ...baseTurn, dashboardBuild: true });
  assert.equal(withBuild.success, true);
  assert.equal(withBuild.success && withBuild.data.dashboardBuild, true);
  assert.equal(
    omniServiceTurnSchema.safeParse({ ...baseTurn, dashboardBuilder: true }).success,
    false,
    "unknown fields must still be rejected",
  );
});

test("omni web request accepts dashboardBuild and stays strict", () => {
  assert.equal(
    omniConversationRequestSchema.safeParse({ message: "build it", dashboardBuild: true }).success,
    true,
  );
  assert.equal(
    omniConversationRequestSchema.safeParse({ message: "build it", buildDashboard: true }).success,
    false,
  );
});

const kpiResult = ulid();
const chartResult = ulid();
const tableResult = ulid();
const emptyResult = ulid();

const evidence = [
  {
    resultId: kpiResult,
    topic: "Sales Analytics",
    rowCount: 2,
    columns: [
      { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency" as const },
      { key: "compareDateRange", label: "Date range", type: "string" as const },
    ],
  },
  {
    resultId: chartResult,
    topic: "Sales Analytics",
    rowCount: 30,
    columns: [
      { key: "sales_analytics_completed_at", label: "Completed", type: "date" as const },
      { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency" as const },
    ],
  },
  {
    resultId: tableResult,
    topic: "Sales Analytics",
    rowCount: 10,
    columns: [
      { key: "sales_analytics_product", label: "Product", type: "string" as const },
      { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency" as const },
    ],
  },
  {
    resultId: emptyResult,
    topic: "Refunds Analytics",
    rowCount: 0,
    columns: [
      { key: "refunds_analytics_refund_total", label: "Refund total", type: "currency" as const },
    ],
  },
];

const nullTile = {
  note: null,
  valueKey: null,
  chartType: null,
  xKey: null,
  yKey: null,
  series: null,
  stacked: null,
  orientation: null,
} as const;

const goodPlan: OmniComposeDashboardInput = {
  dashboardTitle: "Ashburton at a glance",
  timeframe: "Last 30 days vs the previous 30",
  tiles: [
    {
      ...nullTile,
      resultId: kpiResult,
      kind: "kpi",
      title: "Revenue",
      note: "vs previous 30 days",
      width: "quarter",
      valueKey: "sales_analytics_gross_takings",
    },
    {
      ...nullTile,
      resultId: chartResult,
      kind: "chart",
      title: "Revenue by day",
      width: "half",
      chartType: "line",
      xKey: "sales_analytics_completed_at",
      yKey: "sales_analytics_gross_takings",
    },
    {
      ...nullTile,
      resultId: tableResult,
      kind: "table",
      title: "Top products",
      width: "half",
    },
  ],
};

test("compose schema parses a full plan and enforces tile bounds", () => {
  assert.equal(omniComposeDashboardInputSchema.safeParse(goodPlan).success, true);
  assert.equal(
    omniComposeDashboardInputSchema.safeParse({ ...goodPlan, tiles: goodPlan.tiles.slice(0, 2) }).success,
    false,
    "a dashboard needs at least three tiles",
  );
});

test("plan validation grounds every tile in executed evidence", () => {
  assert.deepEqual(validateOmniDashboardPlan(goodPlan, evidence), []);

  const unknownResult = validateOmniDashboardPlan({
    ...goodPlan,
    tiles: [{ ...goodPlan.tiles[0]!, resultId: ulid() }, ...goodPlan.tiles.slice(1)],
  }, evidence);
  assert.equal(unknownResult.length, 1);
  assert.match(unknownResult[0]!, /unknown resultId/u);

  const emptyTile = validateOmniDashboardPlan({
    ...goodPlan,
    tiles: [{ ...goodPlan.tiles[2]!, resultId: emptyResult }, ...goodPlan.tiles.slice(0, 2)],
  }, evidence);
  assert.match(emptyTile[0]!, /returned no rows/u);

  const duplicate = validateOmniDashboardPlan({
    ...goodPlan,
    tiles: [goodPlan.tiles[0]!, { ...goodPlan.tiles[1]!, resultId: kpiResult, xKey: "compareDateRange" }, goodPlan.tiles[2]!],
  }, evidence);
  assert.ok(duplicate.some((issue) => /already used/u.test(issue)));

  const badColumn = validateOmniDashboardPlan({
    ...goodPlan,
    tiles: [
      { ...goodPlan.tiles[0]!, valueKey: "compareDateRange" },
      ...goodPlan.tiles.slice(1),
    ],
  }, evidence);
  assert.ok(badColumn.some((issue) => /numeric column is required/u.test(issue)));

  const wideKpi = validateOmniDashboardPlan({
    ...goodPlan,
    tiles: [{ ...goodPlan.tiles[0]!, width: "full" }, ...goodPlan.tiles.slice(1)],
  }, evidence);
  assert.ok(wideKpi.some((issue) => /quarter or third width/u.test(issue)));
});

test("plan tiles map onto tile display configs", () => {
  assert.deepEqual(displayFromPlanTile({
    resultId: kpiResult,
    kind: "kpi",
    title: "Revenue",
    note: "vs previous 30 days",
    width: "quarter",
    valueKey: "sales_analytics_gross_takings",
  }), { mode: "kpi", valueKey: "sales_analytics_gross_takings", note: "vs previous 30 days" });

  const chart = displayFromPlanTile({
    resultId: chartResult,
    kind: "chart",
    title: "Revenue by day",
    width: "half",
    chartType: "line",
    xKey: "x",
    yKey: "y",
    stacked: false,
  });
  assert.deepEqual(chart, { mode: "chart", chartType: "line", xKey: "x", yKey: "y", stacked: false });
  assert.equal(dashboardTileDisplaySchema.safeParse(chart).success, true);

  // A chart tile with a broken config degrades to a table, never an error.
  assert.deepEqual(
    displayFromPlanTile({ resultId: chartResult, kind: "chart", title: "Broken", width: "half" }),
    { mode: "table" },
  );
});

test("layout packer fills rows in reading order on both breakpoints", () => {
  const layouts = packDashboardLayouts([
    { tileId: "A", kind: "kpi", width: "quarter" },
    { tileId: "B", kind: "kpi", width: "quarter" },
    { tileId: "C", kind: "kpi", width: "quarter" },
    { tileId: "D", kind: "kpi", width: "quarter" },
    { tileId: "E", kind: "chart", width: "half" },
    { tileId: "F", kind: "chart", width: "half" },
    { tileId: "G", kind: "table", width: "full" },
  ]);
  // Desktop: four quarter KPIs share row 0; charts share the next row; the
  // table takes a full row beneath them.
  assert.deepEqual(layouts.desktop.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })), [
    { i: "A", x: 0, y: 0, w: 3, h: 5 },
    { i: "B", x: 3, y: 0, w: 3, h: 5 },
    { i: "C", x: 6, y: 0, w: 3, h: 5 },
    { i: "D", x: 9, y: 0, w: 3, h: 5 },
    { i: "E", x: 0, y: 5, w: 6, h: 8 },
    { i: "F", x: 6, y: 5, w: 6, h: 8 },
    { i: "G", x: 0, y: 13, w: 12, h: 7 },
  ]);
  // Tablet: quarters become halves of an 8-column grid (two per row).
  assert.deepEqual(layouts.tablet.slice(0, 2).map(({ x, y, w }) => ({ x, y, w })), [
    { x: 0, y: 0, w: 4 },
    { x: 4, y: 0, w: 4 },
  ]);
  // The packed layouts satisfy the persisted schema bounds.
  assert.equal(dashboardLayoutsSchema.safeParse({
    desktop: layouts.desktop.map((item) => ({ ...item, i: ulid() })),
    tablet: layouts.tablet.map((item) => ({ ...item, i: ulid() })),
  }).success, true);
});

test("a mixed row inherits its tallest tile's height for the next row", () => {
  const layouts = packDashboardLayouts([
    { tileId: "A", kind: "kpi", width: "third" },
    { tileId: "B", kind: "chart", width: "twoThirds" },
    { tileId: "C", kind: "table", width: "full" },
  ]);
  assert.equal(layouts.desktop[2]!.y, 8, "the table starts below the chart, not the shorter KPI");
});

test("the brief carries the instruction and the current tiles", () => {
  const tile = {
    title: "Revenue",
    display: { mode: "kpi" },
    snapshot: { empty: false },
  } as unknown as DashboardTile;
  const brief = buildDashboardBriefMessage({
    instruction: "I need a dashboard that shows top level metrics",
    currentTiles: [tile],
  });
  assert.match(brief, /top level metrics/u);
  assert.match(brief, /"Revenue" \(kpi\)/u);
  assert.match(brief, /replacing my current dashboard/u);
  const fresh = buildDashboardBriefMessage({ instruction: "Cash overview", currentTiles: [] });
  assert.doesNotMatch(fresh, /replacing/u);
});

test("the persisted plan event revalidates before apply", () => {
  const event = {
    type: "dashboard_plan",
    id: ulid(),
    sequence: 9,
    occurredAt: new Date("2026-08-30T00:00:00Z").toISOString(),
    status: "complete",
    dashboardTitle: "Ashburton at a glance",
    timeframe: "Last 30 days vs the previous 30",
    tiles: [{
      resultId: kpiResult,
      kind: "kpi",
      title: "Revenue",
      width: "quarter",
      valueKey: "sales_analytics_gross_takings",
    }],
  };
  assert.equal(dashboardPlanEventSchema.safeParse(event).success, true);
  assert.equal(
    dashboardPlanEventSchema.safeParse({ ...event, tiles: [] }).success,
    false,
  );
  assert.equal(
    dashboardPlanEventSchema.safeParse({ ...event, tiles: [{ ...event.tiles[0], resultId: "not-a-ulid" }] }).success,
    false,
  );
});

test("tile display schema rejects malformed configs", () => {
  assert.equal(dashboardTileDisplaySchema.safeParse({ mode: "table" }).success, true);
  assert.equal(dashboardTileDisplaySchema.safeParse({ mode: "kpi" }).success, true);
  assert.equal(
    dashboardTileDisplaySchema.safeParse({ mode: "chart", chartType: "line", xKey: "x", yKey: "y" }).success,
    true,
  );
  assert.equal(
    dashboardTileDisplaySchema.safeParse({ mode: "chart", chartType: "pie", xKey: "x", yKey: "y" }).success,
    false,
  );
  assert.equal(dashboardTileDisplaySchema.safeParse({ mode: "sparkline" }).success, false);
  assert.equal(
    dashboardTileDisplaySchema.safeParse({ mode: "kpi", valueKey: "v", extra: true }).success,
    false,
  );
});
