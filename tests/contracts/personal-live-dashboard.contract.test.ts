import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load as loadYaml } from "js-yaml";

import {
  cubeQueryDigest,
  cubeQueryReplayDigestMatches,
  cubeQueryToYaml,
  cubeSemanticVersionDigest,
  validateCubeQuery,
} from "../../packages/albert-v3/src/cube/client.js";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.js";
import { traceColumnFromCube } from "../../packages/albert-v3/src/cube/presentation.js";
import type { CubeCatalogue, CubeQuery } from "../../packages/albert-v3/src/cube/types.js";
import type { DashboardReplayRef, TraceTableEvent } from "../../packages/shared/src/index.js";
import { formatDashboardCell } from "../../app/dash/components/dashboard-values.js";
import {
  derivedTableDigest,
  materializeDerivedTable,
} from "../../packages/albert-v3/src/engine/derived-table.js";
import { dashboardColumnPresentationSchema } from "../../services/control-plane/src/dashboard-repository.js";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const migration = read("infra/migrations/control-plane/0117_m6_personal_live_dashboard.sql");
const refreshLeaseMigration = read("infra/migrations/control-plane/0119_m6_dashboard_refresh_analytical_lease.sql");
const columnPresentationMigration = read("infra/migrations/control-plane/0120_m6_dashboard_column_presentation.sql");
const derivedTableMigration = read("infra/migrations/control-plane/0121_m6_dashboard_derived_tables.sql");
const shared = read("packages/shared/src/agent-runtime.ts");
const v3Tools = read("packages/albert-v3/src/engine/tools.ts");
const v2Live = read("services/conversation/src/v2-live.ts");
const refreshRoute = read("app/api/dashboard/refresh/route.ts");
const refreshAdapter = read("services/dashboard/src/refresh.ts");
const cubeConfig = read("cube-playground/cube.js");
const pinRoute = read("app/api/dashboard/tiles/route.ts");
const tileRoute = read("app/api/dashboard/tiles/[tileId]/route.ts");
const layoutRoute = read("app/api/dashboard/layout/route.ts");
const workspace = read("app/dash/components/DashboardWorkspace.tsx");
const workspaceStyles = read("app/dash/components/dashboard-workspace.module.css");
const trace = read("app/dash/components/InsightsStyleTrace.tsx");
const page = read("app/dash/page.tsx");

test("table replay references support trusted direct and deterministic derived adapters", () => {
  assert.match(shared, /export type DashboardReplayRef/u);
  assert.match(shared, /kind: "cube_v3"/u);
  assert.match(shared, /queryEventId: string/u);
  assert.match(shared, /semanticVersionDigest: string/u);
  assert.match(shared, /kind: "semantic_v2"/u);
  assert.match(shared, /publicationHash: string/u);
  assert.match(shared, /kind: "derived_v1"/u);
  assert.match(shared, /sourceTableEventIds: readonly string\[\]/u);
  assert.match(shared, /dashboardDerivation\?: TraceTableDerivationV1/u);
  assert.match(shared, /dashboardReplay\?: DashboardReplayRef/u);

  const legacyCompatible: TraceTableEvent = {
    id: "01KZN20VTX2EWW1TQ2AA3MCPW6",
    type: "table",
    status: "complete",
    sequence: 1,
    occurredAt: new Date(0).toISOString(),
    caption: "Historical",
    columns: [],
    rows: [],
    resultId: "historical",
    provenance: {
      sources: [],
      timeRange: { label: "fixed", start: "2026-01-01", end: "2026-01-31", timezone: "Australia/Melbourne" },
      definitions: [],
      semanticBundleHash: "0".repeat(64),
      identityGraph: { version: 0, hash: "0".repeat(64) },
    },
  };
  assert.equal(legacyCompatible.dashboardReplay, undefined);
  const reference: DashboardReplayRef = {
    kind: "cube_v3",
    queryEventId: legacyCompatible.id,
    queryDigest: "1".repeat(64),
    semanticVersionDigest: "2".repeat(64),
  };
  assert.equal(reference.kind, "cube_v3");
});

test("derived answer tables materialize exact pivots and keep rolling date headings live", () => {
  const sourceEventId = "01KZN20VTX2EWW1TQ2AA3MCPW7";
  const derivation = {
    version: "derived_table_v1" as const,
    sources: [
      { tableEventId: sourceEventId, resultId: "source-result" },
      { tableEventId: "01KZN20VTX2EWW1TQ2AA3MCPW8", resultId: "profit-result" },
    ],
    columns: [
      { key: "metric", label: "Metric", type: "string" as const },
      {
        key: "week_1",
        label: "Week 1",
        type: "currency" as const,
        currency: "AUD",
        labelSource: {
          kind: "source" as const,
          sourceResultId: "source-result",
          rowIndex: 0,
          columnKey: "week",
        },
      },
    ],
    rows: [
      { cells: [
        { columnKey: "metric", expression: { kind: "literal" as const, value: "Sales" } },
        {
          columnKey: "week_1",
          expression: {
            kind: "source" as const,
            sourceResultId: "source-result",
            rowIndex: 0,
            columnKey: "sales",
          },
        },
      ] },
      { cells: [
        { columnKey: "metric", expression: { kind: "literal" as const, value: "Profit" } },
        {
          columnKey: "week_1",
          expression: {
            kind: "matched_source" as const,
            sourceResultId: "profit-result",
            columnKey: "profit",
            matchColumnKey: "week",
            matchValue: {
              kind: "source" as const,
              sourceResultId: "source-result",
              rowIndex: 0,
              columnKey: "week",
            },
          },
        },
      ] },
    ],
  };
  const first = materializeDerivedTable(derivation, [
    {
      resultId: "source-result",
      columns: [
        { key: "week", label: "Week", type: "datetime" },
        { key: "sales", label: "Sales", type: "currency", currency: "AUD" },
      ],
      rows: [{ week: "2026-07-20T00:00:00.000Z", sales: 1234.5 }],
    },
    {
      resultId: "profit-result",
      columns: [
        { key: "week", label: "Week", type: "datetime" },
        { key: "profit", label: "Profit", type: "currency", currency: "AUD" },
      ],
      rows: [
        { week: "2026-07-13T00:00:00.000Z", profit: 999 },
        { week: "2026-07-20T00:00:00.000Z", profit: 400 },
      ],
    },
  ], "Australia/Melbourne");
  assert.equal(first.columns[1]?.label, "20 July 2026");
  assert.deepEqual(first.rows, [
    { metric: "Sales", week_1: 1234.5 },
    { metric: "Profit", week_1: 400 },
  ]);
  assert.match(derivedTableDigest(derivation), /^[0-9a-f]{64}$/u);

  const rolled = materializeDerivedTable(derivation, [
    {
      resultId: "source-result",
      columns: [
        { key: "week", label: "Week", type: "datetime" },
        { key: "sales", label: "Sales", type: "currency", currency: "AUD" },
      ],
      rows: [{ week: "2026-07-27T00:00:00.000Z", sales: 1500 }],
    },
    {
      resultId: "profit-result",
      columns: [
        { key: "week", label: "Week", type: "datetime" },
        { key: "profit", label: "Profit", type: "currency", currency: "AUD" },
      ],
      rows: [
        { week: "2026-07-20T00:00:00.000Z", profit: 123 },
        { week: "2026-07-27T00:00:00.000Z", profit: 500 },
      ],
    },
  ], "Australia/Melbourne");
  assert.equal(rolled.columns[1]?.label, "27 July 2026");
  assert.equal(rolled.rows[0]?.week_1, 1500);
  assert.equal(rolled.rows[1]?.week_1, 500);
});

test("trusted runtimes attach exact immutable replay references and empty V2 results remain visible", () => {
  assert.match(v3Tools, /const queryEvent = await context\.emit\(\{[\s\S]*type: "query"/u);
  assert.match(v3Tools, /queryEventId: queryEvent\.id/u);
  assert.match(v3Tools, /cubeQueryDigest\(validated\.query\)/u);
  assert.match(v3Tools, /cubeSemanticVersionDigest\(validated, catalogue\)/u);
  assert.match(v2Live, /kind: "semantic_v2"/u);
  assert.match(v2Live, /executionId,[\s\S]*resultId: query\.queryId/u);
  assert.match(v2Live, /query\.evidence\.publicationHash/u);
  assert.doesNotMatch(v2Live, /if \(query\.rows\.length > 0\)/u);
});

test("Cube replay preserves rolling strings and fixed date arrays while pinning semantic definitions", () => {
  const relative: CubeQuery = {
    measures: ["sales.revenue"],
    timeDimensions: [{ dimension: "sales.occurred_at", dateRange: "last 30 days" }],
  };
  const fixed: CubeQuery = {
    measures: ["sales.revenue"],
    timeDimensions: [{ dimension: "sales.occurred_at", dateRange: ["2026-07-01", "2026-07-31"] }],
  };
  assert.notEqual(cubeQueryDigest(relative), cubeQueryDigest(fixed));

  const catalogue: CubeCatalogue = {
    fetchedAt: new Date(0).toISOString(),
    views: [{
      name: "sales",
      title: "Sales",
      members: [
        { name: "sales.revenue", kind: "measure", title: "Revenue", shortTitle: "Revenue", type: "number", aliasMember: "facts.revenue" },
        { name: "sales.occurred_at", kind: "dimension", title: "Occurred", shortTitle: "Occurred", type: "time", aliasMember: "facts.occurred_at" },
      ],
    }],
  };
  const validated = validateCubeQuery(relative, catalogue);
  assert.ok(!("error" in validated));
  const first = cubeSemanticVersionDigest(validated, catalogue);
  const changed: CubeCatalogue = {
    ...catalogue,
    views: [{ ...catalogue.views[0]!, members: catalogue.views[0]!.members.map((member) => member.name === "sales.revenue" ? { ...member, description: "Net of refunds" } : member) }],
  };
  assert.notEqual(first, cubeSemanticVersionDigest(validated, changed));
});

test("Cube replay digests survive YAML property ordering and accept legacy engine pins", () => {
  const query: CubeQuery = {
    measures: ["sales.gross_takings"],
    segments: ["sales.completed"],
    timeDimensions: [{ dimension: "sales.completed_at", granularity: "week", dateRange: "last 30 days" }],
    limit: 500,
    timezone: "Australia/Melbourne",
  };
  const replayed = loadYaml(cubeQueryToYaml(query)) as CubeQuery;
  assert.equal(cubeQueryDigest(replayed), cubeQueryDigest(query));

  const legacyDigest = createHash("sha256").update(JSON.stringify(query)).digest("hex");
  assert.equal(cubeQueryReplayDigestMatches(replayed, legacyDigest), true);
  assert.equal(cubeQueryReplayDigestMatches(replayed, "0".repeat(64)), false);
});

test("dashboard Cube refreshes use a fresh tile-bound analytical lease", () => {
  assert.match(refreshLeaseMigration, /ADD COLUMN refresh_lease_id text/u);
  assert.match(refreshLeaseMigration, /refresh_lease_expires_at = clock_timestamp\(\) \+ interval '3 minutes'/u);
  assert.match(refreshLeaseMigration, /'leaseId', updated\.refresh_lease_id/u);
  assert.match(refreshLeaseMigration, /issue_dashboard_analytical_capability/u);
  assert.match(refreshLeaseMigration, /require_exact_runtime_login\([\s\S]*'albert_semantic_control_runtime'/u);
  assert.match(refreshLeaseMigration, /tile\.refresh_lease_id = p_refresh_lease_id/u);
  assert.match(refreshLeaseMigration, /tile\.refresh_lease_expires_at > clock_timestamp\(\)/u);
  assert.match(refreshLeaseMigration, /refresh_claimed_at = p_claimed_at[\s\S]*refresh_lease_id = p_lease_id/u);
  assert.match(refreshLeaseMigration, /GRANT EXECUTE ON FUNCTION control_plane\.issue_dashboard_analytical_capability[\s\S]*TO albert_semantic_control/u);
  assert.doesNotMatch(refreshLeaseMigration, /GRANT EXECUTE ON FUNCTION control_plane\.issue_dashboard_analytical_capability[\s\S]{0,160}TO authenticated/u);
  assert.match(refreshAdapter, /dashboard_tile_id: claim\.tileId/u);
  assert.match(refreshAdapter, /dashboard_refresh_lease_id: claim\.leaseId/u);
  assert.match(cubeConfig, /issue_dashboard_analytical_capability/u);

  const token = signCubeJwt({
    secret: "test-only-secret",
    securityContext: {
      tenant_id: "01KZSD2WFBT2R1WHM3ADWKQK40",
      dashboard_tile_id: "01KZSD2WFBT2R1WHM3ADWKQK41",
      dashboard_refresh_lease_id: "01KZSD2WFBT2R1WHM3ADWKQK42",
    },
  });
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(payload.dashboard_tile_id, "01KZSD2WFBT2R1WHM3ADWKQK41");
  assert.equal(payload.dashboard_refresh_lease_id, "01KZSD2WFBT2R1WHM3ADWKQK42");
  assert.equal("conversation_id" in payload, false);
  assert.equal("turn_id" in payload, false);
});

test("dashboard cells retain governed date and currency presentation with compact precision", () => {
  const currencyColumn = traceColumnFromCube(
    "sales.gross_takings",
    { title: "Gross takings", shortTitle: "Gross takings", type: "number", format: "currency" },
    "AUD",
  );
  assert.deepEqual(currencyColumn, {
    key: "sales.gross_takings",
    label: "Gross takings",
    type: "currency",
    currency: "AUD",
  });
  assert.equal(formatDashboardCell("9444.1000", currencyColumn), "$9,444.10");
  assert.equal(
    formatDashboardCell("9444.1000", { key: "legacy", label: "Legacy currency", type: "currency" }),
    "$9,444.10",
  );
  assert.equal(formatDashboardCell("12.3456", { key: "ratio", label: "Ratio", type: "number" }), "12.35");
  assert.equal(
    formatDashboardCell("12.3456", { key: "ratio", label: "Ratio", type: "number" }, { decimals: 4 }),
    "12.3456",
  );
  assert.equal(
    formatDashboardCell("9444.1000", currencyColumn, { format: "currency", decimals: 0 }),
    "$9,444",
  );
  assert.equal(
    formatDashboardCell("0.12345", { key: "ratio", label: "Ratio", type: "number" }, { format: "percent", decimals: 1 }),
    "+12.3%",
  );
  assert.equal(
    formatDashboardCell("0012.3400", { key: "ratio", label: "Ratio", type: "number" }, { format: "text" }),
    "0012.3400",
  );
  assert.equal(
    formatDashboardCell("2026-07-20T00:00:00.000", {
      key: "sales.completed_at.week",
      label: "Week",
      type: "datetime",
    }),
    "20 July 2026",
  );
  assert.equal(
    formatDashboardCell("2026-07-20T00:00:00.000Z", {
      key: "sales.completed_at.week",
      label: "Week",
      type: "datetime",
    }),
    "20 July 2026",
  );
});

test("column presentation is bounded, known-column-only, and separate from governed snapshots", () => {
  assert.equal(dashboardColumnPresentationSchema.safeParse({
    revenue: { label: "Sales", format: "currency", decimals: 2 },
  }).success, true);
  assert.equal(dashboardColumnPresentationSchema.safeParse({ revenue: { decimals: 7 } }).success, false);
  assert.equal(dashboardColumnPresentationSchema.safeParse({ revenue: { format: "scientific" } }).success, false);
  assert.equal(dashboardColumnPresentationSchema.safeParse({ revenue: {} }).success, false);
  assert.match(columnPresentationMigration, /ADD COLUMN column_presentation jsonb NOT NULL/u);
  assert.match(columnPresentationMigration, /dashboard_column_presentation_valid/u);
  assert.match(columnPresentationMigration, /count\(\*\) FROM jsonb_object_keys\(p_column_presentation\)\) <= 80/u);
  assert.match(columnPresentationMigration, /'number', 'currency', 'percent', 'text', 'date', 'datetime'/u);
  assert.match(columnPresentationMigration, /'\^\[0-6\]\$'/u);
  assert.match(columnPresentationMigration, /dashboard presentation references an unknown column/u);
  assert.match(columnPresentationMigration, /'columnPresentation', tile\.column_presentation/u);
  assert.doesNotMatch(columnPresentationMigration, /latest_snapshot\s*=/u);
  assert.doesNotMatch(columnPresentationMigration, /replay_recipe\s*=/u);
});

test("control plane enforces one owner dashboard, immutable source capture, limits and revision conflicts", () => {
  assert.match(migration, /CREATE TABLE control_plane\.personal_dashboards/u);
  assert.match(migration, /UNIQUE \(tenant_id, owner_user_id\)/u);
  assert.match(migration, /FOREIGN KEY \(tenant_id, owner_user_id\)[\s\S]*REFERENCES control_plane\.memberships\(tenant_id, user_id\) ON DELETE CASCADE/u);
  assert.match(migration, /REFERENCES control_plane\.tenants\(tenant_id\) ON DELETE CASCADE/u);
  assert.match(migration, /CREATE TABLE control_plane\.dashboard_tiles/u);
  assert.match(migration, /CREATE TABLE control_plane\.dashboard_refresh_events/u);
  assert.match(migration, /dashboard revision conflict[\s\S]*ERRCODE = '40001'/u);
  assert.match(migration, />= 24[\s\S]*at most 24 tiles/u);
  assert.match(migration, /jsonb_array_length\(coalesce\(p_snapshot->'rows',[\s\S]*> 50/u);
  assert.match(migration, /source table event was not found/u);
  assert.match(migration, /event\.event->>'id' = replay->>'queryEventId'/u);
  assert.match(migration, /replay->>'kind' NOT IN \('cube_v3', 'semantic_v2'\)/u);
  assert.doesNotMatch(migration, /sql_first|anthropic|cubecore/iu);
});

test("derived dashboard pins resolve every source recipe server-side and refresh without a model", () => {
  assert.match(derivedTableMigration, /replay_kind IN \('cube_v3', 'semantic_v2', 'derived_v1'\)/u);
  assert.match(derivedTableMigration, /dashboard_direct_source_recipe/u);
  assert.match(derivedTableMigration, /source_replay->>'kind' NOT IN \('cube_v3', 'semantic_v2'\)/u);
  assert.match(derivedTableMigration, /jsonb_array_length\(derivation->'sources'\) NOT BETWEEN 1 AND 12/u);
  assert.match(derivedTableMigration, /'transformDigest', replay->>'transformDigest'/u);
  assert.match(derivedTableMigration, /tile\.replay_kind IN \('cube_v3', 'derived_v1'\)/u);
  assert.match(refreshAdapter, /refreshDerivedV1/u);
  assert.match(refreshAdapter, /derivedTableDigest\(recipe\.transform\)/u);
  assert.match(refreshAdapter, /materializeDerivedTable/u);
  assert.doesNotMatch(refreshAdapter, /new Agent|OpenAIProvider|Anthropic/u);
  assert.match(v3Tools, /name: "compose_table"/u);
  assert.match(v3Tools, /presentation: "answer"/u);
});

test("dashboard tables deny direct browser grants and every public function rechecks owner context", () => {
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.match(migration, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated/u);
  assert.doesNotMatch(migration, /GRANT SELECT ON TABLE[\s\S]*dashboard_/u);
  assert.match(migration, /control_plane\.require_current_tenant_id\(\)/g);
  assert.match(migration, /extensions\.albert_auth_uid\(\)/g);
  assert.match(migration, /conversation\.created_by = actor/u);
  assert.match(migration, /owner_user_id = p_actor/u);
  assert.match(migration, /dashboard_refresh_events_no_update/u);
  assert.match(migration, /dashboard refresh evidence is append-only/u);
  const runtimeRls = read(
    "infra/migrations/control-plane/0118_m6_personal_live_dashboard_rls_runtime.sql",
  );
  assert.match(runtimeRls, /FOR ALL TO albert_control_migration_owner[\s\S]*USING \(true\) WITH CHECK \(true\)/u);
  assert.doesNotMatch(runtimeRls, /TO (?:anon|authenticated|service_role)/u);
});

test("authenticated APIs are bounded, same-origin, rate-limited and conflict-aware", () => {
  for (const route of [pinRoute, tileRoute, layoutRoute, refreshRoute]) {
    assert.match(route, /assertSameOriginMutation/u);
    assert.match(route, /readBoundedJsonBody/u);
  }
  assert.match(pinRoute, /dashboard\.mutation/u);
  assert.match(tileRoute, /dashboard\.mutation/u);
  assert.match(tileRoute, /dashboardColumnPresentationSchema/u);
  assert.match(layoutRoute, /dashboard\.mutation/u);
  assert.match(refreshRoute, /dashboard\.refresh/u);
  assert.match(pinRoute, /DashboardRevisionConflict/u);
  assert.match(tileRoute, /DashboardRevisionConflict/u);
  assert.match(layoutRoute, /DashboardRevisionConflict/u);
  assert.match(refreshRoute, /inBatches\(claims, 4/u);
  assert.match(migration, /date_trunc\('minute', now\(\)\)[\s\S]*% 5/u);
});

test("Semantic V2 has a signed, publication-pinned live replay path", () => {
  const service = read("services/semantic-query/src/v2-service.ts");
  const http = read("services/semantic-query/src/http.ts");
  const client = read("services/conversation/src/semantic-client.ts");
  assert.match(http, /\/v2\/dashboard\/replay/u);
  assert.match(http, /verifyInternalRequest/u);
  assert.match(service, /replayDashboardResult/u);
  assert.match(service, /query_workspace_revisions_v2/u);
  assert.match(service, /loadSemanticRegistryV2\(this\.dependencies\.controlPlanePool, input\.publicationHash\)/u);
  assert.match(service, /sourceWatermarks: tenant\.sourceWatermarks/u);
  assert.match(client, /signInternalRequest\(\{ method: "POST", path, body/u);
});

test("dashboard UI follows responsive, accessible and visible-only refresh contracts", () => {
  assert.match(page, />Dashboard<\/span>/u);
  assert.match(page, /activeItem === "Dashboard"/u);
  assert.match(trace, /dashboardReplay/u);
  assert.match(trace, /Add to Dashboard/u);
  assert.match(trace, /tablePinTooltip/u);
  assert.match(trace, /event\.presentation === "answer"/u);
  assert.match(trace, /className=\{styles\.answerTables\}/u);
  assert.match(workspace, /cols=\{\{ desktop: 12, tablet: 8, mobile: 1 \}\}/u);
  assert.match(workspace, /rowHeight=\{28\}/u);
  assert.match(workspace, /desktop: \[10, 10\]/u);
  assert.match(workspace, /minW: columns === 1 \? 1 : 3/u);
  assert.match(workspace, /minH: 5/u);
  assert.match(workspace, /maxH: 16/u);
  assert.match(workspace, /breakpoint !== "mobile"/u);
  assert.match(workspace, /<div key=\{tile\.tileId\} className=\{styles\.gridItem\}>/u);
  assert.match(workspace, /Shift plus Arrow keys resize/u);
  assert.match(workspace, /aria-live="polite"/u);
  assert.match(workspace, /visibilitychange/u);
  assert.match(workspace, /300_000/u);
  assert.match(workspace, /onDragStop/u);
  assert.match(workspace, /onResizeStop/u);
  assert.match(workspace, /window\.queueMicrotask/u);
  assert.match(workspace, /const breakpoint: Breakpoint = width >= 1100/u);
  assert.match(workspace, /useContainerWidth\(\{[\s\S]*measureBeforeMount: true/u);
  assert.match(workspace, /requestAnimationFrame\(measureWidth\)/u);
  assert.match(workspace, /Showing \{snapshot\.rows\.length\} of/u);
  assert.match(workspace, /onDoubleClick=\{\(\) => openRename\(column\)\}/u);
  assert.match(workspace, /aria-label=\{`\$\{presentation\?\.label \?\? column\.label\} column\. Click to select for formatting\. Double-click or press Enter to rename\.`\}/u);
  assert.match(workspace, /event\.key === "Enter" \|\| event\.key === "F2"/u);
  assert.match(workspace, /aria-haspopup="dialog"/u);
  assert.match(workspace, /aria-label="Value format"/u);
  assert.match(workspace, /aria-label="Decimal places"/u);
  assert.match(workspace, /onColumnPresentationChange\(next\)/u);
  assert.match(workspaceStyles, /\.columnFormatPanel/u);
  assert.match(workspaceStyles, /max-width: min\(320px, calc\(100vw - 40px\)\)/u);
  assert.match(workspaceStyles, /\.workspace \{[\s\S]*overflow-x: hidden/u);
  assert.match(workspaceStyles, /\.gridMeasure \{[^}]*max-width: 100%[^}]*overflow: hidden/u);
  assert.match(workspaceStyles, /\.tableScroll \{[\s\S]*max-width: 100%[\s\S]*overflow: auto/u);
  assert.match(workspace, /className=\{styles\.statusBadge\}[\s\S]*statusTooltip\(tile\)/u);
  assert.match(workspace, /Open source analysis for \$\{tile\.title\}/u);
  assert.match(workspace, /dashboard-source-\$\{tile\.tileId\}/u);
  assert.match(workspaceStyles, /\.tooltipWrap:hover \.tooltip/u);
  assert.match(workspaceStyles, /top: calc\(100% \+ 8px\)/u);
  assert.match(workspaceStyles, /opacity 150ms ease-out 80ms/u);
});
