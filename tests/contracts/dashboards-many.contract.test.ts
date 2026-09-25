/**
 * Dashboards, plural (ADR 0134 — the Sigma model): the 0186 migration that
 * lets a member own many dashboards and gives every element owner-authored
 * sort, filters and a row limit; the override contract the refresh adapter
 * applies after the governed digest checks; and the routes that address a
 * dashboard by id while keeping the unnamed legacy call working.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { CubeQuery } from "../../packages/albert-v3/src/cube/types.js";
import {
  dashboardDocumentSchema,
  dashboardQueryOverridesSchema,
  dashboardSummarySchema,
  dashboardTileSchema,
} from "../../services/control-plane/src/dashboard-repository.js";
import {
  applyDashboardQueryOverrides,
  dashboardQueryOverridesEmpty,
  resolveOverrideMember,
} from "../../services/dashboard/src/query-overrides.js";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const migration = read("infra/migrations/control-plane/0186_m6_dashboards_many_and_element_overrides.sql");
const refreshAdapter = read("services/dashboard/src/refresh.ts");
const documentRoute = read("app/api/dashboard/route.ts");
const listRoute = read("app/api/dashboard/list/route.ts");
const tileRoute = read("app/api/dashboard/tiles/[tileId]/route.ts");
const buildRoute = read("app/api/dashboard/build/route.ts");
const applyRoute = read("app/api/dashboard/build/apply/route.ts");

test("0186 lets a member own many dashboards and keeps unnamed callers on the legacy behaviour", () => {
  assert.match(migration, /^BEGIN;$/mu);
  assert.match(migration, /^COMMIT;\s*$/mu);
  // The one-per-member key goes, found by its columns rather than a guessed name.
  assert.match(migration, /ARRAY\['owner_user_id', 'tenant_id'\]/u);
  assert.match(migration, /DROP CONSTRAINT %I/u);
  assert.match(migration, /personal_dashboards_owner_recent_idx[\s\S]*\(tenant_id, owner_user_id, updated_at DESC\)/u);
  // Ownership is resolved once, in one helper every RPC calls.
  assert.match(migration, /FUNCTION control_plane\.require_owned_dashboard\(\s*p_tenant_id text,\s*p_actor uuid,\s*p_dashboard_id text\s*\)/u);
  assert.match(migration, /AND owner_user_id = p_actor;\s*IF resolved_dashboard_id IS NULL THEN\s*RAISE EXCEPTION 'dashboard was not found' USING ERRCODE = 'P0002'/u);
  assert.match(migration, /ORDER BY updated_at DESC, dashboard_id DESC\s*LIMIT 1/u, "unnamed: most recently touched");
  assert.match(migration, /pg_advisory_xact_lock\(hashtext\('dashboard:'/u, "first-use creation is serialised per member");
  assert.match(migration, /RETURN control_plane\.require_owned_dashboard\(p_tenant_id, p_actor, NULL\)/u, "the 0117 helper delegates");
  for (const signature of [
    "albert_dashboard_get(\n  p_dashboard_id text DEFAULT NULL\n)",
    "p_expected_revision bigint,\n  p_dashboard_id text DEFAULT NULL\n)",
    "p_force boolean DEFAULT false,\n  p_dashboard_id text DEFAULT NULL\n)",
    "p_query_overrides jsonb DEFAULT NULL,\n  p_dashboard_id text DEFAULT NULL\n)",
  ]) {
    assert.ok(migration.includes(signature), signature);
  }
  for (const dropped of [
    "DROP FUNCTION IF EXISTS public.albert_dashboard_get();",
    "DROP FUNCTION IF EXISTS public.albert_dashboard_pin(text, text, text, text, bigint);",
    "DROP FUNCTION IF EXISTS public.albert_dashboard_tile_update(text, bigint, text, jsonb, jsonb);",
    "DROP FUNCTION IF EXISTS public.albert_dashboard_refresh_claim(text[], boolean);",
  ]) {
    assert.ok(migration.includes(dropped), `${dropped} — the old overload must go or PostgREST cannot pick one`);
  }
  // Completion resolves the dashboard from the tile's own lease, not "the" dashboard.
  assert.match(migration, /SELECT tile\.dashboard_id INTO selected_dashboard[\s\S]*AND dashboard\.owner_user_id = actor;/u);
  // New surface.
  for (const name of [
    "albert_dashboard_list()",
    "albert_dashboard_create(\n  p_title text DEFAULT NULL\n)",
    "albert_dashboard_delete(\n  p_dashboard_id text\n)",
    "albert_dashboard_link_conversation(",
  ]) {
    assert.ok(migration.includes(`CREATE OR REPLACE FUNCTION public.${name}`), name);
  }
  assert.match(migration, /at most 40 dashboards/u);
  assert.match(migration, /conversation\.created_by = actor/u, "only the member's own conversation can be linked");
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.albert_dashboard_list\(\) TO authenticated;/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION control_plane\.require_owned_dashboard\(text, uuid, text\) FROM PUBLIC;/u);
  assert.doesNotMatch(migration, /GRANT SELECT ON TABLE/u);
  assert.match(migration, /NOTIFY pgrst, 'reload schema';/u);
});

test("0186 bounds element query overrides and keeps them off the governed recipe", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS query_overrides jsonb NOT NULL DEFAULT '\{\}'::jsonb/u);
  assert.match(migration, /CHECK \(control_plane\.dashboard_query_overrides_valid\(query_overrides\)\)/u);
  assert.match(migration, /\(p_overrides - 'order' - 'filters' - 'limit'\) <> '\{\}'::jsonb/u);
  assert.match(migration, /jsonb_array_length\(p_overrides -> 'order'\) > 3/u);
  assert.match(migration, /jsonb_array_length\(p_overrides -> 'filters'\) > 8/u);
  assert.match(migration, /jsonb_array_length\(entry -> 'values'\) > 50/u);
  assert.match(migration, /NOT BETWEEN 1 AND 500/u);
  assert.match(migration, /'equals', 'notEquals', 'contains', 'notContains',\s*'gt', 'gte', 'lt', 'lte', 'set', 'notSet',\s*'inDateRange', 'notInDateRange', 'beforeDate', 'afterDate'/u);
  // Overrides need a governed query behind the element, and only its own columns.
  assert.match(migration, /tile_replay_kind <> 'cube_v3'[\s\S]*sorting and filters need a governed query behind the element/u);
  assert.match(migration, /dashboard query overrides reference an unknown column/u);
  assert.match(migration, /replace\(column_value\.value->>'key', '\.', '_'\) = replace\(referenced\.column_key, '\.', '_'\)/u);
  // A change flags the snapshot stale (the next claim re-runs it) but never rewrites the recipe.
  assert.match(migration, /WHEN overrides_changed AND refresh_state <> 'refreshing' THEN 'stale'/u);
  assert.match(migration, /OR tile\.refresh_state = 'stale'/u);
  assert.doesNotMatch(migration, /replay_recipe\s*=/u);
  assert.match(migration, /'queryOverrides', updated\.query_overrides/u, "claims carry the overrides");
  assert.match(migration, /'queryYaml', CASE\s*WHEN tile\.replay_kind = 'cube_v3' THEN tile\.replay_recipe ->> 'queryYaml'/u);
  assert.match(migration, /'lastBuildConversationId', dashboard\.last_build_conversation_id/u);
});

test("the override schema mirrors the SQL bounds and documents default to none", () => {
  assert.equal(dashboardQueryOverridesSchema.safeParse({}).success, true);
  assert.equal(dashboardQueryOverridesSchema.safeParse({
    order: [{ column: "sales.gross_takings", direction: "desc" }],
    filters: [{ column: "sales.product", operator: "equals", values: ["Gravel bike hire"] }],
    limit: 10,
  }).success, true);
  assert.equal(dashboardQueryOverridesSchema.safeParse({ order: [{ column: "a", direction: "up" }] }).success, false);
  assert.equal(dashboardQueryOverridesSchema.safeParse({ filters: [{ column: "a", operator: "between", values: [] }] }).success, false);
  assert.equal(dashboardQueryOverridesSchema.safeParse({ limit: 0 }).success, false);
  assert.equal(dashboardQueryOverridesSchema.safeParse({ limit: 501 }).success, false);
  assert.equal(dashboardQueryOverridesSchema.safeParse({ sort: [] }).success, false, "strict");
  assert.equal(dashboardQueryOverridesEmpty({}), true);
  assert.equal(dashboardQueryOverridesEmpty({ order: [] }), true);
  assert.equal(dashboardQueryOverridesEmpty({ limit: 5 }), false);

  // A pre-0186 document (no overrides, no query yaml) still parses; a new one carries both.
  const tile = {
    tileId: "01J00000000000000000DBT101",
    title: "Revenue",
    source: {
      conversationId: "01J00000000000000000DBCV01",
      turnId: "01J00000000000000000DBTN01",
      tableEventId: "01J00000000000000000DBE101",
      resultId: "01J00000000000000000DBR101",
    },
    replayKind: "cube_v3",
    snapshot: null,
    columnPresentation: {},
    display: { mode: "table" },
    refreshState: "current",
    lastErrorCode: null,
    lastRefreshAttemptAt: null,
    lastRefreshedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
  const legacy = dashboardTileSchema.safeParse(tile);
  assert.equal(legacy.success, true);
  assert.deepEqual(legacy.success && legacy.data.queryOverrides, {});
  assert.equal(dashboardTileSchema.safeParse({
    ...tile,
    queryYaml: "measures:\n  - sales.gross_takings",
    queryOverrides: { order: [{ column: "sales.gross_takings", direction: "desc" }] },
  }).success, true);
  assert.equal(dashboardDocumentSchema.safeParse({
    dashboardId: "01J00000000000000000DBRD01",
    title: null,
    revision: 0,
    layouts: { desktop: [], tablet: [] },
    lastBuildConversationId: null,
    tiles: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  }).success, true);
  assert.equal(dashboardSummarySchema.safeParse({
    dashboardId: "01J00000000000000000DBRD01",
    title: "Ops cockpit",
    revision: 3,
    tileCount: 5,
    lastBuildConversationId: "01J00000000000000000DBCV01",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  }).success, true);
});

test("overrides resolve snapshot column keys to query members and apply after validation", () => {
  const base: CubeQuery = {
    measures: ["sales_analytics.gross_takings", "sales_analytics.net_takings"],
    dimensions: ["sales_analytics.product"],
    timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: "week", dateRange: "last 12 weeks" }],
    filters: [{ member: "sales_analytics.channel", operator: "equals", values: ["store"] }],
    order: { "sales_analytics.gross_takings": "desc" },
    limit: 50,
    timezone: "Australia/Melbourne",
  };
  // Raw member keys, underscore spellings and bucketed time keys all resolve.
  assert.equal(resolveOverrideMember(base, "sales_analytics.gross_takings"), "sales_analytics.gross_takings");
  assert.equal(resolveOverrideMember(base, "sales_analytics_gross_takings"), "sales_analytics.gross_takings");
  assert.equal(resolveOverrideMember(base, "sales_analytics.completed_at.week"), "sales_analytics.completed_at");
  assert.equal(resolveOverrideMember(base, "sales_analytics_completed_at_week"), "sales_analytics.completed_at");
  assert.equal(resolveOverrideMember(base, "compareDateRange"), null);

  const applied = applyDashboardQueryOverrides(base, {
    order: [{ column: "sales_analytics_product", direction: "asc" }],
    filters: [
      { column: "sales_analytics.product", operator: "notEquals", values: ["Gift card"] },
      { column: "sales_analytics_gross_takings", operator: "gte", values: ["100"] },
      { column: "sales_analytics.product", operator: "set", values: [] },
    ],
    limit: 10,
  });
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  // The owner's sort replaces the base order; filters append with AND; the
  // limit only ever narrows; nothing else moves.
  assert.deepEqual(applied.query.order, { "sales_analytics.product": "asc" });
  assert.deepEqual(applied.query.filters, [
    { member: "sales_analytics.channel", operator: "equals", values: ["store"] },
    { member: "sales_analytics.product", operator: "notEquals", values: ["Gift card"] },
    { member: "sales_analytics.gross_takings", operator: "gte", values: ["100"] },
    { member: "sales_analytics.product", operator: "set" },
  ]);
  assert.equal(applied.query.limit, 10);
  assert.deepEqual(applied.query.measures, base.measures);
  assert.deepEqual(applied.query.timeDimensions, base.timeDimensions);
  assert.equal(applyDashboardQueryOverrides(base, { limit: 400 }).ok && (applyDashboardQueryOverrides(base, { limit: 400 }) as { query: CubeQuery }).query.limit, 50, "a wider limit never widens");
  assert.equal(applyDashboardQueryOverrides(base, {}).ok && (applyDashboardQueryOverrides(base, {}) as { query: CubeQuery }).query, base, "no overrides: the base query object itself");

  const unknown = applyDashboardQueryOverrides(base, { order: [{ column: "compareDateRange", direction: "asc" }] });
  assert.equal(unknown.ok, false);
  assert.match(!unknown.ok ? unknown.error : "", /not part of this element's query/u);
  const empty = applyDashboardQueryOverrides(base, { filters: [{ column: "sales_analytics.product", operator: "equals", values: ["  "] }] });
  assert.equal(empty.ok, false);

  // The adapter applies overrides only after the digest checks, re-validates, and
  // strips them from a composed table's sources.
  assert.match(refreshAdapter, /cubeSemanticVersionDigest\(validated, catalogue\) !== claim\.recipe\.semanticVersionDigest[\s\S]*applyDashboardQueryOverrides\(validated\.query, claim\.queryOverrides\)/u);
  assert.match(refreshAdapter, /validateCubeQuery\(overridden\.query, catalogue\)/u);
  assert.match(refreshAdapter, /failure\("query_overrides_invalid"/u);
  assert.match(refreshAdapter, /client\.loadQuery\(effective\.query/u);
  assert.match(refreshAdapter, /delete \(sourceClaim as \{ queryOverrides\?: unknown \}\)\.queryOverrides/u);
});

test("routes address a dashboard by id, expose the list, and edit one element in place", () => {
  assert.match(documentRoute, /searchParams\.get\("dashboardId"\)/u);
  assert.match(documentRoute, /export async function POST/u);
  assert.match(documentRoute, /export async function DELETE/u);
  assert.match(documentRoute, /createDashboard\(parsed\.data\.title \?\? null\)/u);
  assert.match(documentRoute, /deleteDashboard\(parsed\.data\.dashboardId\)/u);
  for (const route of [documentRoute, tileRoute]) {
    assert.match(route, /assertSameOriginMutation/u);
    assert.match(route, /readBoundedJsonBody/u);
    assert.match(route, /dashboard\.mutation/u);
  }
  assert.match(listRoute, /listDashboards\(\)/u);
  assert.match(tileRoute, /queryOverrides: dashboardQueryOverridesSchema\.optional\(\)/u);
  assert.match(tileRoute, /dashboardId: ulid\.optional\(\)/u);
  assert.match(buildRoute, /loadDashboard\(parsed\.dashboardId\)/u);
  assert.match(buildRoute, /That element is no longer on the dashboard\./u);
  assert.match(buildRoute, /editTile: \{[\s\S]*span: tileDesktopSpan\(dashboard, editTile\.tileId\)/u);
  assert.match(applyRoute, /parsed\.replaceTileId/u);
  assert.match(applyRoute, /replaceTileInLayouts\(/u);
  assert.match(applyRoute, /only the edited element was replaced/u);
  assert.match(applyRoute, /linkDashboardConversation\(/u);
  assert.match(applyRoute, /loadDashboardBuildArtifacts\(parsed\)/u, "the plan still comes from the persisted trace, never the client");
});
