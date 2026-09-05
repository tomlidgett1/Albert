/**
 * Canonical column identity (ADR 0134): a governed result's columns are
 * minted one way — query order, deduplicated, underscore keys — by the
 * runtime trace and the dashboard refresh alike; a refresh keeps the columns
 * where the owner last saw them; sealed derivations replay against sources
 * spelled either way. This is what stops "columns shifted positions".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  alignColumnsToPrevious,
  canonicalColumnKey,
  columnKeysEquivalent,
  cubeResultColumns,
  publicColumnKey,
} from "../../packages/albert-v3/src/cube/presentation.js";
import { validateCubeQuery } from "../../packages/albert-v3/src/cube/client.js";
import { materializeDerivedTable } from "../../packages/albert-v3/src/engine/derived-table.js";
import type { CubeCatalogue, CubeQuery } from "../../packages/albert-v3/src/cube/types.js";
import type { TraceTableDerivationV1 } from "../../packages/shared/src/index.js";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const runtime = read("packages/albert-omni/src/runtime.ts");
const refreshAdapter = read("services/dashboard/src/refresh.ts");
const vercel = read("vercel.json");
const webRepository = readFileSync(new URL("../../services/control-plane/src/web-repository.ts", import.meta.url), "latin1");

test("canonical keys make every spelling of a member equal, buckets included", () => {
  assert.equal(publicColumnKey("sales_analytics.gross_takings"), "sales_analytics_gross_takings");
  assert.equal(canonicalColumnKey("sales_analytics.completed_at.week"), "sales_analytics_completed_at");
  assert.equal(canonicalColumnKey("sales_analytics_completed_at_day"), "sales_analytics_completed_at");
  assert.equal(canonicalColumnKey("sales_analytics.completed_at"), "sales_analytics_completed_at");
  assert.ok(columnKeysEquivalent("sales_analytics.gross_takings", "sales_analytics_gross_takings"));
  assert.ok(columnKeysEquivalent("workshop_analytics.checked_in_at.day", "workshop_analytics_checked_in_at"));
  assert.ok(!columnKeysEquivalent("sales_analytics.gross_takings", "sales_analytics.net_takings"));
  // A member that merely ends in a granularity word is not truncated.
  assert.equal(canonicalColumnKey("staff.hours_per_week_target"), "staff_hours_per_week_target");
});

test("result columns follow the query, once each, never Cube's row-key order or the order/filter members", () => {
  // The prod tile that shifted: one measure, a bucketed time dimension that
  // is also ordered on. Cube returns dimension-first rows with a bucket key.
  const query: CubeQuery = {
    measures: ["workshop_analytics.workorder_count"],
    timeDimensions: [{ dimension: "workshop_analytics.checked_in_at", granularity: "day", dateRange: "last 30 days" }],
    order: { "workshop_analytics.checked_in_at": "asc" },
    filters: [{ member: "workshop_analytics.status", operator: "equals", values: ["open"] }],
    limit: 50,
  };
  const result = {
    rows: [{
      "workshop_analytics.checked_in_at.day": "2026-08-05T00:00:00.000",
      "workshop_analytics.workorder_count": 12,
      "workshop_analytics.checked_in_at": "2026-08-05T00:00:00.000",
    }],
    annotation: {
      "workshop_analytics.workorder_count": { title: "Work orders", shortTitle: "Work orders", type: "number" },
      "workshop_analytics.checked_in_at.day": { title: "Checked in", shortTitle: "Checked in", type: "time" },
    },
  };
  const columns = cubeResultColumns(query, result, "AUD");
  assert.deepEqual(columns.members, ["workshop_analytics.workorder_count", "workshop_analytics.checked_in_at"]);
  assert.deepEqual(columns.columns.map((column) => column.key), ["workshop_analytics_workorder_count", "workshop_analytics_checked_in_at"]);
  // The bucketed time dimension keeps Cube's bucket annotation and type.
  assert.equal(columns.columns[1]?.label, "Checked in");
  assert.equal(columns.columns[1]?.type, "datetime");
  // A compare query grows the synthetic label column, but its ungrouped
  // date filter is not a projected result column.
  const compared = cubeResultColumns(
    { measures: ["sales.gross"], timeDimensions: [{ dimension: "sales.at", compareDateRange: ["2026-08-01 to 2026-08-30", "2026-07-02 to 2026-07-31"] }] },
    { rows: [{ "sales.gross": 1, "sales.at": null, compareDateRange: "2026-08-01 - 2026-08-30" }], annotation: {} },
  );
  assert.deepEqual(compared.columns.map((column) => column.key), ["sales_gross", "compareDateRange"]);
  assert.equal(compared.members.at(-1), "compareDateRange");
});

test("validated members are deduplicated so an ordered or filtered member is one column", () => {
  const catalogue: CubeCatalogue = {
    fetchedAt: new Date(0).toISOString(),
    views: [{
      name: "workshop_analytics",
      title: "Workshop",
      members: [
        { name: "workshop_analytics.workorder_count", kind: "measure", title: "Work orders", shortTitle: "Work orders", type: "number", aliasMember: "w.count" },
        { name: "workshop_analytics.checked_in_at", kind: "dimension", title: "Checked in", shortTitle: "Checked in", type: "time", aliasMember: "w.at" },
      ],
    }],
  };
  const validated = validateCubeQuery({
    measures: ["workshop_analytics.workorder_count"],
    timeDimensions: [{ dimension: "workshop_analytics.checked_in_at", granularity: "day", dateRange: "last 30 days" }],
    order: { "workshop_analytics.checked_in_at": "asc" },
  }, catalogue);
  assert.ok(!("error" in validated));
  assert.deepEqual(validated.members, ["workshop_analytics.workorder_count", "workshop_analytics.checked_in_at"]);
});

test("a refresh keeps the pinned columns' keys, labels and order, heals a doubled column, and appends new ones", () => {
  const fresh = cubeResultColumns(
    {
      measures: ["workshop_analytics.workorder_count", "workshop_analytics.labour_hours"],
      timeDimensions: [{ dimension: "workshop_analytics.checked_in_at", granularity: "day" }],
    },
    { rows: [{ "workshop_analytics.workorder_count": 1, "workshop_analytics.labour_hours": 2, "workshop_analytics.checked_in_at": "2026-08-05" }], annotation: {} },
  );
  // The pinned (trace) columns, exactly as the prod tile had them: measure
  // first, then the time dimension twice (the order-member duplicate).
  const previous = [
    { key: "workshop_analytics_workorder_count", label: "Work orders" },
    { key: "workshop_analytics_checked_in_at", label: "Checked in" },
    { key: "workshop_analytics_checked_in_at", label: "Checked in" },
  ];
  const aligned = alignColumnsToPrevious(fresh, previous);
  assert.deepEqual(aligned.columns.map((column) => column.key), [
    "workshop_analytics_workorder_count",
    "workshop_analytics_checked_in_at",
    "workshop_analytics_labour_hours",
  ]);
  assert.deepEqual(aligned.members, [
    "workshop_analytics.workorder_count",
    "workshop_analytics.checked_in_at",
    "workshop_analytics.labour_hours",
  ]);
  assert.equal(aligned.columns[0]?.label, "Work orders");
  // A legacy dot-keyed snapshot keeps its dot keys and its order.
  const legacy = alignColumnsToPrevious(fresh, [
    { key: "workshop_analytics.checked_in_at.day", label: "Day" },
    { key: "workshop_analytics.workorder_count", label: "Work orders" },
  ]);
  assert.deepEqual(legacy.columns.map((column) => column.key), [
    "workshop_analytics.checked_in_at.day",
    "workshop_analytics.workorder_count",
    "workshop_analytics_labour_hours",
  ]);
  assert.deepEqual(alignColumnsToPrevious(fresh, null), fresh);
});

test("a sealed derivation replays against dot-keyed, bucketed refresh sources", () => {
  // Sealed by the runtime over underscore-keyed evidence; refreshed sources
  // (pre-fix snapshots) carry Cube's dot keys plus a `.day` bucket column.
  const derivation: TraceTableDerivationV1 = {
    version: "derived_table_v1",
    sources: [
      { tableEventId: "01JOBSTABLEEVENT0000000000", resultId: "jobs" },
      { tableEventId: "01TAKETABLEEVENT0000000000", resultId: "takings" },
    ],
    columns: [
      { key: "workshop_analytics_checked_in_at", label: "Day", type: "datetime" },
      { key: "workshop_analytics_workorder_count", label: "Jobs", type: "number" },
      { key: "sales_analytics_gross_takings", label: "Takings", type: "currency", currency: "AUD" },
    ],
    rows: [0, 1].map((rowIndex) => ({
      cells: [
        { columnKey: "workshop_analytics_checked_in_at", expression: { kind: "source", sourceResultId: "jobs", rowIndex, columnKey: "workshop_analytics_checked_in_at" } },
        { columnKey: "workshop_analytics_workorder_count", expression: { kind: "source", sourceResultId: "jobs", rowIndex, columnKey: "workshop_analytics_workorder_count" } },
        {
          columnKey: "sales_analytics_gross_takings",
          expression: {
            kind: "matched_source",
            sourceResultId: "takings",
            columnKey: "sales_analytics_gross_takings",
            matchColumnKey: "sales_analytics_completed_at",
            matchValue: { kind: "source", sourceResultId: "jobs", rowIndex, columnKey: "workshop_analytics_checked_in_at" },
          },
        },
      ],
    })),
  };
  const replayed = materializeDerivedTable(derivation, [
    {
      resultId: "jobs",
      columns: [
        { key: "workshop_analytics.checked_in_at.day", label: "Day", type: "datetime" },
        { key: "workshop_analytics.workorder_count", label: "Jobs", type: "number" },
        { key: "workshop_analytics.checked_in_at", label: "Checked in", type: "datetime" },
      ],
      rows: [
        { "workshop_analytics.checked_in_at.day": "2026-08-05T00:00:00.000", "workshop_analytics.workorder_count": 12, "workshop_analytics.checked_in_at": "2026-08-05T00:00:00.000" },
        { "workshop_analytics.checked_in_at.day": "2026-08-06T00:00:00.000", "workshop_analytics.workorder_count": 9, "workshop_analytics.checked_in_at": "2026-08-06T00:00:00.000" },
      ],
    },
    {
      resultId: "takings",
      columns: [
        { key: "sales_analytics.completed_at.day", label: "Day", type: "datetime" },
        { key: "sales_analytics.gross_takings", label: "Takings", type: "currency", currency: "AUD" },
        { key: "sales_analytics.completed_at", label: "Completed", type: "datetime" },
      ],
      rows: [
        { "sales_analytics.completed_at.day": "2026-08-06T00:00:00.000", "sales_analytics.gross_takings": 1800, "sales_analytics.completed_at": "2026-08-06T00:00:00.000" },
        { "sales_analytics.completed_at.day": "2026-08-05T00:00:00.000", "sales_analytics.gross_takings": 2400, "sales_analytics.completed_at": "2026-08-05T00:00:00.000" },
      ],
    },
  ], "Australia/Melbourne");
  assert.deepEqual(replayed.rows, [
    { workshop_analytics_checked_in_at: "2026-08-05T00:00:00.000", workshop_analytics_workorder_count: 12, sales_analytics_gross_takings: 2400 },
    { workshop_analytics_checked_in_at: "2026-08-06T00:00:00.000", workshop_analytics_workorder_count: 9, sales_analytics_gross_takings: 1800 },
  ]);
});

test("runtime and refresh share the helper, refresh aligns to the previous snapshot, and the routes run beside the data", () => {
  assert.match(runtime, /cubeResultColumns\(validated\.query, loaded\.result, config\.currency\)/u);
  assert.doesNotMatch(runtime, /\.\.\.validated\.members,\s*\.\.\.\(hasCompareColumn/u, "no more raw validated.members columns");
  assert.match(refreshAdapter, /alignColumnsToPrevious\(\s*cubeResultColumns\(effective\.query, result, currency\),\s*claim\.previousSnapshot\?\.columns \?\? null,\s*\)/u);
  assert.doesNotMatch(refreshAdapter, /Object\.keys\(result\.rows\[0\]!\)/u, "column order never comes from Cube's row keys");
  // The catalogue cache moved into its own module (0187) so refresh, requery
  // and the field list share one five-minute copy per Cube origin.
  const catalogueCache = read("services/dashboard/src/catalogue-cache.ts");
  assert.match(catalogueCache, /export const CATALOGUE_TTL_MS = 5 \* 60_000/u);
  assert.match(refreshAdapter, /import \{ cachedCatalogue \} from "\.\/catalogue-cache";/u);
  assert.match(refreshAdapter, /cachedCatalogue\(apiUrl, client\)/u);
  assert.match(vercel, /"regions": \["syd1"\]/u);
  assert.match(webRepository, /export const requireUser = cache\(async \(\) =>/u);
  assert.match(webRepository, /export const currentTenantContext = cache\(async \(\)/u);
});
