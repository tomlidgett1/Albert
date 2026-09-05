/**
 * The element editor (ADR 0134, migration 0187): Sigma's Properties | Format
 * editor over three edit lanes — presentation changes apply instantly,
 * query-shape edits are one deterministic server requery each that re-mints
 * the governed recipe, and the wand replaces the element in one RPC. The
 * column contract survives every lane: a re-spelled time column carries its
 * presentation, display keys and overrides across.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { alignColumnsForRequery } from "../../packages/albert-v3/src/cube/presentation.js";
import { validateCubeQuery } from "../../packages/albert-v3/src/cube/client.js";
import type { CubeCatalogue, CubeQuery } from "../../packages/albert-v3/src/cube/types.js";
import {
  DASHBOARD_RELATIVE_DATE_RANGE,
  applyDashboardQueryEdits,
  dashboardQueryEditsSchema,
  granularityAllowed,
} from "../../services/dashboard/src/query-edits.js";
import {
  dashboardColumnPresentationSchema,
  dashboardTileDisplaySchema,
  dashboardTileSchema,
} from "../../services/control-plane/src/dashboard-repository.js";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const catalogue: CubeCatalogue = {
  fetchedAt: "2026-09-04T00:00:00.000Z",
  views: [{
    name: "sales_analytics",
    title: "Sales analytics",
    members: [
      { name: "sales_analytics.gross_takings", kind: "measure", title: "Gross takings", shortTitle: "Gross takings", type: "number" },
      { name: "sales_analytics.net_takings", kind: "measure", title: "Net takings", shortTitle: "Net takings", type: "number" },
      { name: "sales_analytics.product", kind: "dimension", title: "Product", shortTitle: "Product", type: "string" },
      { name: "sales_analytics.completed_at", kind: "dimension", title: "Completed", shortTitle: "Completed", type: "time" },
      { name: "sales_analytics.refunded_at", kind: "dimension", title: "Refunded", shortTitle: "Refunded", type: "time" },
    ],
  }, {
    name: "refunds_analytics",
    title: "Refunds",
    members: [
      { name: "refunds_analytics.refund_total", kind: "measure", title: "Refund total", shortTitle: "Refund total", type: "number" },
    ],
  }],
};

const weekly: CubeQuery = {
  measures: ["sales_analytics.gross_takings"],
  timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: "week", dateRange: "last 12 weeks" }],
  order: { "sales_analytics.completed_at": "asc" },
  limit: 50,
};

test("Truncate date re-buckets the time dimension and the edited query still validates on the same view", () => {
  const edited = applyDashboardQueryEdits(weekly, [{ op: "set_granularity", dimension: "sales_analytics.completed_at", granularity: "month" }], catalogue, "sales_analytics");
  assert.ok(edited.ok);
  assert.equal(edited.query.timeDimensions?.[0]?.granularity, "month");
  assert.equal(edited.query.timeDimensions?.[0]?.dateRange, "last 12 weeks", "the window is untouched");
  const validated = validateCubeQuery(edited.query, catalogue);
  assert.ok(!("error" in validated));
  assert.equal(validated.view, "sales_analytics");
});

test("Date range and comparison edits are exclusive on a time dimension, and a window can be filter-only", () => {
  const compared = applyDashboardQueryEdits(weekly, [
    { op: "set_compare", dimension: "sales_analytics.completed_at", compareDateRange: [["2026-08-01", "2026-08-30"], ["2026-07-02", "2026-07-31"]] },
  ], catalogue, "sales_analytics");
  assert.ok(compared.ok);
  assert.equal(compared.query.timeDimensions?.[0]?.dateRange, undefined, "Cube takes a window or a comparison, never both");
  assert.equal(compared.query.timeDimensions?.[0]?.compareDateRange?.length, 2);

  const windowed = applyDashboardQueryEdits(compared.query, [
    { op: "set_compare", dimension: "sales_analytics.completed_at", compareDateRange: null },
    { op: "set_date_range", dimension: "sales_analytics.completed_at", dateRange: "last 30 days" },
  ], catalogue, "sales_analytics");
  assert.ok(windowed.ok);
  assert.deepEqual(windowed.query.timeDimensions?.[0], { dimension: "sales_analytics.completed_at", granularity: "week", dateRange: "last 30 days" });

  const filterOnly = applyDashboardQueryEdits({ measures: ["sales_analytics.gross_takings"] }, [
    { op: "set_date_range", dimension: "sales_analytics.refunded_at", dateRange: ["2026-01-01", "2026-03-31"] },
  ], catalogue, "sales_analytics");
  assert.ok(filterOnly.ok);
  assert.deepEqual(filterOnly.query.timeDimensions, [{ dimension: "sales_analytics.refunded_at", dateRange: ["2026-01-01", "2026-03-31"] }]);

  const cleared = applyDashboardQueryEdits(filterOnly.query, [
    { op: "set_date_range", dimension: "sales_analytics.refunded_at", dateRange: null },
  ], catalogue, "sales_analytics");
  assert.ok(cleared.ok);
  assert.equal(cleared.query.timeDimensions, undefined, "a filter-only entry with no window disappears");
});

test("Columns and calculations are added on the recipe's view and removed with their sort", () => {
  const added = applyDashboardQueryEdits(weekly, [
    { op: "add_measure", member: "sales_analytics.net_takings" },
    { op: "add_dimension", member: "sales_analytics.product" },
    { op: "add_dimension", member: "sales_analytics.refunded_at", granularity: "month" },
  ], catalogue, "sales_analytics");
  assert.ok(added.ok);
  assert.deepEqual(added.query.measures, ["sales_analytics.gross_takings", "sales_analytics.net_takings"]);
  assert.deepEqual(added.query.dimensions, ["sales_analytics.product"]);
  assert.equal(added.query.timeDimensions?.length, 2, "a time-typed dimension joins timeDimensions with its bucket");
  assert.equal(added.query.timeDimensions?.[1]?.granularity, "month");

  const removed = applyDashboardQueryEdits(added.query, [
    { op: "remove_dimension", member: "sales_analytics.completed_at" },
    { op: "remove_measure", member: "sales_analytics.gross_takings" },
  ], catalogue, "sales_analytics");
  assert.ok(removed.ok);
  assert.deepEqual(removed.query.measures, ["sales_analytics.net_takings"]);
  assert.equal(removed.query.order, undefined, "the removed time dimension's sort goes with it");
  assert.equal(removed.query.timeDimensions?.length, 1);

  const foreign = applyDashboardQueryEdits(weekly, [{ op: "add_measure", member: "refunds_analytics.refund_total" }], catalogue, "sales_analytics");
  assert.ok(!foreign.ok);
  assert.match(foreign.error, /not a calculation of this element's topic/u);
  const wrongKind = applyDashboardQueryEdits(weekly, [{ op: "add_measure", member: "sales_analytics.product" }], catalogue, "sales_analytics");
  assert.ok(!wrongKind.ok);
  const lastOne = applyDashboardQueryEdits(
    { measures: ["sales_analytics.gross_takings"] },
    [{ op: "remove_measure", member: "sales_analytics.gross_takings" }],
    catalogue,
    "sales_analytics",
  );
  assert.ok(!lastOne.ok);
  assert.match(lastOne.error, /at least one column or calculation/u);
  const noTime = applyDashboardQueryEdits({ measures: ["sales_analytics.gross_takings"] }, [
    { op: "set_granularity", dimension: "sales_analytics.completed_at", granularity: "day" },
  ], catalogue, "sales_analytics");
  assert.ok(!noTime.ok);
  assert.match(noTime.error, /needs a date column/u);
  const limited = applyDashboardQueryEdits(weekly, [{ op: "set_limit", limit: 25 }], catalogue, "sales_analytics");
  assert.ok(limited.ok && limited.query.limit === 25);
});

test("The edit schema only admits the eight deterministic ops with fully qualified members", () => {
  assert.ok(dashboardQueryEditsSchema.safeParse([{ op: "set_granularity", dimension: "sales_analytics.completed_at", granularity: "month" }]).success);
  assert.ok(!dashboardQueryEditsSchema.safeParse([{ op: "set_granularity", dimension: "completed_at", granularity: "month" }]).success, "unqualified member");
  assert.ok(!dashboardQueryEditsSchema.safeParse([{ op: "set_granularity", dimension: "sales_analytics.completed_at", granularity: "hour" }]).success, "hour is not an editor bucket");
  assert.ok(!dashboardQueryEditsSchema.safeParse([{ op: "run_sql", sql: "select 1" }]).success);
  assert.ok(!dashboardQueryEditsSchema.safeParse([]).success);
  assert.ok(!dashboardQueryEditsSchema.safeParse(Array.from({ length: 9 }, () => ({ op: "set_limit", limit: 10 }))).success);
  assert.ok(!dashboardQueryEditsSchema.safeParse([{ op: "set_date_range", dimension: "sales_analytics.completed_at", dateRange: "last 0 days" }]).success);
  for (const range of ["today", "last 7 days", "last 12 months", "this quarter", "last year", "last 1 week"]) {
    assert.ok(DASHBOARD_RELATIVE_DATE_RANGE.test(range), range);
  }
  assert.ok(!DASHBOARD_RELATIVE_DATE_RANGE.test("since forever"));
  const aggregateOnly: CubeCatalogue = {
    ...catalogue,
    views: [{ ...catalogue.views[0]!, queryPolicy: "aggregate_only", minimumTimeGranularity: "week" }],
  };
  assert.equal(granularityAllowed(aggregateOnly, "sales_analytics", "day"), false);
  assert.equal(granularityAllowed(aggregateOnly, "sales_analytics", "month"), true);
  assert.equal(granularityAllowed(catalogue, "sales_analytics", "day"), true);
});

test("A requery keeps the owner's column order and carries a re-spelled time column across", () => {
  const previous = [
    { key: "sales_analytics_completed_at_week", label: "Week" },
    { key: "sales_analytics_gross_takings", label: "Takings" },
  ];
  const fresh = {
    columns: [
      { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency" as const, currency: "AUD" },
      { key: "sales_analytics_net_takings", label: "Net takings", type: "currency" as const, currency: "AUD" },
      { key: "sales_analytics_completed_at_month", label: "Completed (month)", type: "date" as const },
    ],
    members: ["sales_analytics.gross_takings", "sales_analytics.net_takings", "sales_analytics.completed_at"],
  };
  const aligned = alignColumnsForRequery(fresh, previous);
  assert.deepEqual(aligned.columns.map(({ key }) => key), [
    "sales_analytics_completed_at_month",
    "sales_analytics_gross_takings",
    "sales_analytics_net_takings",
  ], "previous order first, the new member appended");
  assert.equal(aligned.columns[0]!.label, "Completed (month)", "a re-bucketed column takes its fresh label");
  assert.equal(aligned.columns[1]!.label, "Takings", "an unchanged column keeps the owner's label");
  assert.deepEqual(aligned.members, ["sales_analytics.completed_at", "sales_analytics.gross_takings", "sales_analytics.net_takings"]);
  assert.equal(aligned.renamed.get("sales_analytics_completed_at_week"), "sales_analytics_completed_at_month");
  assert.equal(aligned.renamed.get("sales_analytics_gross_takings"), "sales_analytics_gross_takings");
});

test("Hidden columns, KPI comparison and recipe provenance are part of the tile contract", () => {
  assert.ok(dashboardColumnPresentationSchema.safeParse({ sales_analytics_product: { hidden: true } }).success);
  assert.ok(!dashboardColumnPresentationSchema.safeParse({ sales_analytics_product: { hidden: "yes" } }).success);
  assert.ok(dashboardTileDisplaySchema.safeParse({ mode: "kpi", comparison: "difference", betterWhen: "lower" }).success);
  assert.ok(!dashboardTileDisplaySchema.safeParse({ mode: "kpi", comparison: "ratio" }).success);
  const tile = dashboardTileSchema.shape;
  assert.ok("recipeVersion" in tile && "recipeOrigin" in tile);
});

test("Migration 0187 mints the requery, replace and release RPCs, the authored column order and the requery rate policy", () => {
  const migration = read("infra/migrations/control-plane/0187_m6_dashboard_element_editor.sql");
  for (const needle of [
    "recipe_version integer NOT NULL DEFAULT 1",
    "recipe_origin IN ('trace', 'edited')",
    "FUNCTION public.albert_dashboard_tile_requery(",
    "FUNCTION public.albert_dashboard_element_replace(",
    "FUNCTION public.albert_dashboard_refresh_release(",
    "FUNCTION control_plane.dashboard_reorder_snapshot_columns(",
    "p_column_order text[] DEFAULT NULL",
    "p_column_presentation jsonb DEFAULT NULL",
    "'dashboard requery recipe is invalid'",
    "'dashboard recipe version conflict' USING ERRCODE = '40001'",
    "'recipeVersion', tile.recipe_version",
    "entry.config ? 'hidden'",
    "'percent_difference', 'difference', 'percent_of', 'absolute'",
    "VALUES ('dashboard.requery', 240, 3600, false)",
    "NOTIFY pgrst, 'reload schema';",
  ]) {
    assert.ok(migration.includes(needle), needle);
  }
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.albert_dashboard_tile_update\(text, bigint, text, jsonb, jsonb, jsonb, text\);/u);
  const policies = read("services/control-plane/src/web-repository.ts");
  assert.match(policies, /"dashboard\.requery": Object\.freeze\(\{ limit: 240, windowSeconds: 3_600 \}\)/u);
});

test("The requery lane claims the lease, writes against the current revision and hands the lease back on failure", () => {
  const requery = read("services/dashboard/src/requery.ts");
  assert.match(requery, /claimDashboardRefresh\(\{ tileIds: \[input\.tileId\], force: true/u);
  assert.match(requery, /applyDashboardQueryEdits\(base, input\.edits, catalogue, claim\.recipe\.view\)/u);
  assert.match(requery, /if \(validated\.view !== claim\.recipe\.view\)/u);
  assert.match(requery, /const latest = await loadDashboard\(dashboard\.dashboardId\);/u);
  assert.match(requery, /expectedRevision: latest\.revision/u);
  assert.match(requery, /alignColumnsForRequery\(/u);
  assert.match(requery, /releaseDashboardRefresh\(\{ tileId: claim\.tileId, leaseId: claim\.leaseId/u);
  assert.match(requery, /queryDigest: cubeQueryDigest\(recipeQuery\)/u);
  assert.match(requery, /semanticVersionDigest: cubeSemanticVersionDigest\(validated, catalogue\)/u);
  const route = read("app/api/dashboard/tiles/[tileId]/query/route.ts");
  assert.match(route, /consumeAlbertRateLimit\("dashboard\.requery"\)/u);
  assert.match(route, /edits: dashboardQueryEditsSchema/u);
  assert.match(route, /export const maxDuration = 120;/u);
  const fields = read("app/api/dashboard/tiles/[tileId]/fields/route.ts");
  assert.match(fields, /securityContext: \{ tenant_id: tenant\.tenant_id \}/u);
  assert.match(fields, /!member\.aiHidden/u);
  const apply = read("app/api/dashboard/build/apply/route.ts");
  assert.match(apply, /replaceDashboardElement\(\{/u);
  assert.match(apply, /tileId: "__replacement__"/u);
  const refresh = read("services/dashboard/src/refresh.ts");
  assert.match(refresh, /import \{ cachedCatalogue \} from "\.\/catalogue-cache";/u);
});

test("The editor is Sigma's — Properties | Format on the element toolbar, requeries in order, stale-while-revalidate", () => {
  const workspace = read("app/dash/components/DashboardWorkspace.tsx");
  assert.match(workspace, /aria-label=\{`Properties for \$\{tile\.title\}`\}/u);
  assert.match(workspace, /requeryChainRef/u);
  assert.match(workspace, /mutationChainRef/u);
  assert.match(workspace, /className=\{styles\.tileProgress\} role="progressbar"/u);
  assert.match(workspace, /data-busy=\{busy \? "true" : undefined\}/u);
  assert.match(workspace, /recipeVersion: tile\.recipeVersion \?\? 1/u);
  assert.match(workspace, /columnPresentation\[column\.key\]\?\.hidden !== true/u);
  for (const item of ["Hide column</button>", "Delete column</button>", '"Refresh data"']) {
    assert.ok(workspace.includes(item), item);
  }
  const editor = read("app/dash/components/ElementProperties.tsx");
  for (const label of ["Truncate date", "Date range", "Add column", "Show as", "Chart type", "Orientation", "Comparison", "Better when", "Value format", "Decimal places", "Note"]) {
    assert.ok(editor.includes(`aria-label="${label}"`), label);
  }
  assert.match(editor, /role="tab"/u);
  assert.match(editor, /op: "set_granularity"/u);
  assert.match(editor, /op: "set_date_range"/u);
  assert.match(editor, /op: "add_measure"/u);
  assert.match(editor, /op: "remove_dimension"/u);
  assert.match(editor, /op: "set_limit"/u);
  const values = read("app/dash/components/dashboard-values.ts");
  assert.match(values, /tone: "good" \| "bad" \| "neutral"/u);
  const css = read("app/dash/components/dashboard-workspace.module.css");
  assert.match(css, /\.tileProgress/u);
  assert.match(css, /prefers-reduced-motion/u);
});
