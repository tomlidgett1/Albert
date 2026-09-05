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
import { readFileSync } from "node:fs";
import {
  DASHBOARD_EDIT_EFFORT,
  DASHBOARD_EDIT_FAST_MODE,
  buildDashboardBriefMessage,
  dashboardBriefDisplayText,
  queryYamlTopic,
  dashboardPlanEventSchema,
  displayFromPlanTile,
  packDashboardLayouts,
  parseDashboardBriefMessage,
  replaceTileInLayouts,
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

test("the lean element-edit mode travels on the turn with its topic, and the brief route picks it", () => {
  const edit = omniServiceTurnSchema.safeParse({
    ...baseTurn,
    dashboardBuild: true,
    dashboardEdit: true,
    dashboardEditTopic: "workshop_analytics",
  });
  assert.equal(edit.success, true);
  assert.equal(omniServiceTurnSchema.safeParse({ ...baseTurn, dashboardEditTopic: "Bad Topic!" }).success, false);
  assert.equal(
    omniConversationRequestSchema.safeParse({ message: "edit it", dashboardBuild: true, dashboardEdit: true, dashboardEditTopic: "sales_analytics" }).success,
    true,
  );
  assert.equal(queryYamlTopic("measures:\n  - workshop_analytics.workorder_count\ntimeDimensions:\n  - dimension: workshop_analytics.checked_in_at"), "workshop_analytics");
  assert.equal(queryYamlTopic("timeDimensions:\n  - dimension: sales_analytics.completed_at\n    granularity: day"), "sales_analytics");
  assert.equal(queryYamlTopic(null), null);
  assert.equal(DASHBOARD_EDIT_EFFORT, "low");
  assert.equal(DASHBOARD_EDIT_FAST_MODE, true);
  const buildRoute = readFileSync(new URL("../../app/api/dashboard/build/route.ts", import.meta.url), "utf8");
  assert.match(buildRoute, /preferences: editTile\s*\?\s*\{\s*model: DASHBOARD_EDIT_MODEL/u);
  assert.match(buildRoute, /queryYamlTopic\(editTile\.queryYaml\)/u);
  const runtime = readFileSync(new URL("../../packages/albert-omni/src/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /const dashboardEditMode = dashboardMode && turn\.dashboardEdit === true;/u);
  assert.match(runtime, /if \(editTopicView\) inspectedTopics\.add\(editTopicView\.name\);/u, "the inlined topic passes the query guard");
  assert.match(runtime, /tools: dashboardEditMode\s*\?\s*\[\s*searchSemanticModel,\s*fetchFieldValues,\s*generateSemanticQuery,\s*composeDashboard,\s*getCurrentTime,\s*\]/u, "no task list, derive or pivot tools in edit mode");
  const prompts = readFileSync(new URL("../../packages/albert-omni/src/prompts.ts", import.meta.url), "utf8");
  assert.match(prompts, /Call GenerateSemanticQuery ONCE/u);
  assert.match(prompts, /Call ComposeDashboard with exactly ONE tile/u);
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
    omniComposeDashboardInputSchema.safeParse({ ...goodPlan, tiles: [] }).success,
    false,
    "a plan needs at least one tile",
  );
  // An element edit (ADR 0134) composes exactly the one replacement tile.
  assert.equal(
    omniComposeDashboardInputSchema.safeParse({ ...goodPlan, tiles: goodPlan.tiles.slice(0, 1) }).success,
    true,
    "a single-tile plan is an element edit",
  );
  assert.equal(
    omniComposeDashboardInputSchema.safeParse({
      ...goodPlan,
      tiles: Array.from({ length: 13 }, (_, index) => ({ ...goodPlan.tiles[0]!, resultId: ulid(), title: `Tile ${index}` })),
    }).success,
    false,
    "at most twelve tiles",
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

  // A derived result that cannot refresh (an aggregate, say) is refused as a
  // tile, with the replayable results named so the plan can self-repair.
  const unreplayable = validateOmniDashboardPlan(goodPlan, evidence, {
    unreplayableResultIds: new Set([tableResult]),
  });
  assert.equal(unreplayable.length, 1);
  assert.match(unreplayable[0]!, /cannot refresh on a dashboard/u);
  assert.ok(unreplayable[0]!.includes(kpiResult), "names the replayable results");
  assert.ok(!unreplayable[0]!.includes(`${tableResult} (`), "does not offer the unreplayable one");
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
    { i: "E", x: 0, y: 5, w: 6, h: 9 },
    { i: "F", x: 6, y: 5, w: 6, h: 9 },
    { i: "G", x: 0, y: 14, w: 12, h: 7 },
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
  assert.equal(layouts.desktop[2]!.y, 9, "the table starts below the chart, not the shorter KPI");
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

test("the brief names its target dashboard and the chat reads the owner's words back", () => {
  const dashboardId = ulid();
  const brief = buildDashboardBriefMessage({
    instruction: "Cash overview",
    currentTiles: [],
    dashboardId,
    dashboardTitle: "Ops cockpit",
  });
  assert.match(brief, /Dashboard name today: "Ops cockpit"/u);
  assert.match(brief, new RegExp(`Target dashboard: ${dashboardId}\\s*$`, "u"));
  assert.deepEqual(parseDashboardBriefMessage(brief), { kind: "build", instruction: "Cash overview", dashboardId });
  assert.equal(dashboardBriefDisplayText(brief), "Cash overview");
  // A pre-0133 brief (no target line) still parses.
  const legacy = "Design and build my dashboard.\n\nWhat I want: Top level metrics\n\nYou are replacing my current dashboard. Its tiles, for context — keep what still serves the request, improve or drop the rest:\n- \"Revenue\" (kpi)";
  assert.deepEqual(parseDashboardBriefMessage(legacy), { kind: "build", instruction: "Top level metrics", dashboardId: null });
  assert.equal(parseDashboardBriefMessage("What were sales last week?"), null);
  assert.equal(dashboardBriefDisplayText("What were sales last week?"), "What were sales last week?");
});

test("an element-edit brief carries the one element, its governed query and the rules", () => {
  const dashboardId = ulid();
  const tileId = ulid();
  const tile = {
    tileId,
    title: "Revenue by week",
    display: { mode: "chart", chartType: "line", xKey: "sales_analytics_completed_at", yKey: "sales_analytics_gross_takings" },
    queryYaml: "measures:\n  - sales_analytics.gross_takings\ntimeDimensions:\n  - dimension: sales_analytics.completed_at\n    granularity: week\n    dateRange: last 12 weeks",
    snapshot: {
      empty: false,
      columns: [
        { key: "sales_analytics.completed_at.week", label: "Week", type: "datetime" },
        { key: "sales_analytics.gross_takings", label: "Gross takings", type: "currency" },
      ],
    },
  } as unknown as DashboardTile;
  const brief = buildDashboardBriefMessage({
    instruction: "make it daily and only the last 30 days",
    currentTiles: [tile],
    dashboardId,
    dashboardTitle: "Ashburton at a glance",
    editTile: { tile, span: 6 },
  });
  assert.match(brief, /^Edit one element of my dashboard\./u);
  assert.match(brief, /Element: "Revenue by week" \(chart\)/u);
  assert.match(brief, /What I want changed: make it daily and only the last 30 days/u);
  assert.match(brief, /granularity: week/u, "the governed query travels with the brief");
  assert.match(brief, /Display today: line chart, x sales_analytics_completed_at, y sales_analytics_gross_takings/u);
  assert.match(brief, /Width today: half/u);
  assert.match(brief, /exactly ONE tile/u);
  assert.match(brief, /dashboardTitle "Ashburton at a glance"/u);
  assert.doesNotMatch(brief, /replacing my current dashboard/u);
  assert.match(brief, new RegExp(`Target element: ${tileId}\\s*$`, "u"));
  assert.deepEqual(parseDashboardBriefMessage(brief), {
    kind: "edit",
    instruction: "make it daily and only the last 30 days",
    dashboardId,
    tileId,
    elementTitle: "Revenue by week",
  });
  assert.equal(dashboardBriefDisplayText(brief), "Edit “Revenue by week”: make it daily and only the last 30 days");
});

test("an element edit takes the edited tile's slot on both breakpoints", () => {
  const previousId = ulid();
  const otherId = ulid();
  const newId = ulid();
  const layouts = {
    desktop: [
      { i: otherId, x: 0, y: 0, w: 3, h: 5 },
      { i: previousId, x: 3, y: 0, w: 6, h: 9 },
    ],
    tablet: [
      { i: otherId, x: 0, y: 0, w: 4, h: 5 },
      { i: previousId, x: 4, y: 0, w: 4, h: 9 },
    ],
  };
  const sameKind = replaceTileInLayouts(
    layouts,
    { tileId: previousId, display: { mode: "chart", chartType: "line", xKey: "x", yKey: "y" } },
    { tileId: newId, kind: "chart", width: "half" },
  );
  assert.deepEqual(sameKind.desktop, [
    { i: otherId, x: 0, y: 0, w: 3, h: 5 },
    { i: newId, x: 3, y: 0, w: 6, h: 9 },
  ]);
  assert.deepEqual(sameKind.tablet[1], { i: newId, x: 4, y: 0, w: 4, h: 9 });
  // A kind change takes the new kind's default height in the same place.
  const kindChange = replaceTileInLayouts(
    layouts,
    { tileId: previousId, display: { mode: "chart", chartType: "line", xKey: "x", yKey: "y" } },
    { tileId: newId, kind: "table", width: "half" },
  );
  assert.deepEqual(kindChange.desktop[1], { i: newId, x: 3, y: 0, w: 6, h: 7 });
  // A tile the layout never placed lands beneath everything else.
  const unplaced = replaceTileInLayouts(
    { desktop: layouts.desktop.slice(0, 1), tablet: layouts.tablet.slice(0, 1) },
    { tileId: previousId, display: { mode: "table" } },
    { tileId: newId, kind: "kpi", width: "quarter" },
  );
  assert.deepEqual(unplaced.desktop[1], { i: newId, x: 0, y: 5, w: 3, h: 5 });
  assert.equal(dashboardLayoutsSchema.safeParse(unplaced).success, true);
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
