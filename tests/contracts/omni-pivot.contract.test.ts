/**
 * ComposePivotTable contracts: the cross-source pivot (metric rows × period
 * columns) composes a valid derived_table_v1 transform, materializes exactly
 * as a dashboard refresh will, carries per-row formats for mixed units, and
 * the web relay's pairing completes the recipe with real table event ids and
 * a digest the refresh path can verify.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ulid } from "ulid";

import { composePivotTable, pairDerivedTableEvent } from "../../packages/albert-omni/src/pivot.js";
import type { PivotSourceResult } from "../../packages/albert-omni/src/pivot.js";
import {
  derivedTableDigest,
  materializeDerivedTable,
} from "../../packages/albert-v3/src/engine/derived-table.js";
import { dashboardDerivationSchema } from "../../services/control-plane/src/dashboard-repository.js";
import type { TraceProvenance } from "../../packages/shared/src/index.js";

const provenance: TraceProvenance = {
  sources: [{ connector: "lightspeed", label: "Cube semantic layer · lightspeed", dataThrough: "2026-08-30" }],
  timeRange: { label: "last 12 weeks", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
  definitions: [],
  semanticBundleHash: "test",
  identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
};

const weeks = ["2026-08-10T00:00:00.000", "2026-08-17T00:00:00.000", "2026-08-24T00:00:00.000"];

function salesResult(resultId: string): PivotSourceResult {
  return {
    resultId,
    topic: "Sales analytics",
    columns: [
      { key: "sales_analytics_completed_at", label: "Week", type: "date" },
      { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
      { key: "sales_analytics_transactions", label: "Transactions", type: "number" },
    ],
    rows: weeks.map((week, index) => ({
      sales_analytics_completed_at: week,
      sales_analytics_gross_takings: 1000 + index * 100,
      sales_analytics_transactions: 40 + index,
    })),
    provenance,
  };
}

function hoursResult(resultId: string): PivotSourceResult {
  return {
    resultId,
    topic: "Workforce analytics",
    columns: [
      { key: "workforce_analytics_rostered_date", label: "Week", type: "date" },
      { key: "workforce_analytics_rostered_hours", label: "Rostered hours", type: "number" },
    ],
    // Reversed row order: matching is by label, not by index.
    rows: [...weeks].reverse().map((week, index) => ({
      workforce_analytics_rostered_date: week,
      workforce_analytics_rostered_hours: 90 - index * 5,
    })),
    provenance,
  };
}

test("a cross-source pivot materializes metric rows against period columns", () => {
  const sales = salesResult(ulid());
  const hours = hoursResult(ulid());
  const sources = new Map([[sales.resultId, sales], [hours.resultId, hours]]);
  const outcome = composePivotTable({
    caption: "Weekly scorecard",
    columnsFromResultId: sales.resultId,
    labelKey: "sales_analytics_completed_at",
    metrics: [
      { resultId: sales.resultId, valueKey: "sales_analytics_gross_takings", labelKey: null, label: "Sales" },
      { resultId: sales.resultId, valueKey: "sales_analytics_transactions", labelKey: null, label: "Transactions" },
      { resultId: hours.resultId, valueKey: "workforce_analytics_rostered_hours", labelKey: "workforce_analytics_rostered_date", label: "Rostered hours" },
    ],
  }, sources, "Australia/Melbourne");

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const { pivot } = outcome;
  // Metric column + one column per week, headings formatted as dates.
  assert.equal(pivot.columns.length, 1 + weeks.length);
  assert.equal(pivot.columns[0]!.key, "metric");
  assert.match(String(pivot.columns[1]!.label), /Aug 2026/u);
  // Three metric rows in declaration order; label-matched values, so the
  // reversed hours result still lands under the right weeks.
  assert.equal(pivot.rows.length, 3);
  assert.equal(pivot.rows[0]!.metric, "Sales");
  const weekKeys = pivot.columns.slice(1).map((column) => column.key);
  assert.deepEqual(weekKeys.map((key) => pivot.rows[0]![key]), [1000, 1100, 1200]);
  assert.deepEqual(weekKeys.map((key) => pivot.rows[2]![key]), [80, 85, 90]);
  // Mixed units (currency + number) → per-row formats.
  assert.ok(pivot.rowFormats);
  assert.deepEqual(pivot.rowFormats![0], { type: "currency", currency: "AUD" });
  assert.deepEqual(pivot.rowFormats![1], { type: "number" });
});

test("the derivation replays through the dashboard refresh materializer", () => {
  const sales = salesResult(ulid());
  const hours = hoursResult(ulid());
  const sources = new Map([[sales.resultId, sales], [hours.resultId, hours]]);
  const outcome = composePivotTable({
    caption: "Weekly scorecard",
    columnsFromResultId: sales.resultId,
    labelKey: "sales_analytics_completed_at",
    metrics: [
      { resultId: sales.resultId, valueKey: "sales_analytics_gross_takings", labelKey: null, label: "Sales" },
      { resultId: hours.resultId, valueKey: "workforce_analytics_rostered_hours", labelKey: "workforce_analytics_rostered_date", label: "Rostered hours" },
    ],
  }, sources, "Australia/Melbourne");
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  // What the refresh path does: re-run sources, re-apply the exact transform.
  const replayed = materializeDerivedTable(outcome.pivot.derivation, [
    { resultId: sales.resultId, columns: sales.columns, rows: sales.rows },
    { resultId: hours.resultId, columns: hours.columns, rows: hours.rows },
  ], "Australia/Melbourne");
  assert.deepEqual(replayed.rows, outcome.pivot.rows);
  assert.deepEqual(replayed.columns, outcome.pivot.columns);
});

test("relay pairing completes the recipe and the control plane accepts it", () => {
  const sales = salesResult(ulid());
  const hours = hoursResult(ulid());
  const sources = new Map([[sales.resultId, sales], [hours.resultId, hours]]);
  const outcome = composePivotTable({
    caption: "Weekly scorecard",
    columnsFromResultId: sales.resultId,
    labelKey: "sales_analytics_completed_at",
    metrics: [
      { resultId: hours.resultId, valueKey: "workforce_analytics_rostered_hours", labelKey: "workforce_analytics_rostered_date", label: "Rostered hours" },
    ],
  }, sources, "Australia/Melbourne");
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const salesTableEventId = ulid();
  const hoursTableEventId = ulid();
  const paired = pairDerivedTableEvent(
    {
      dashboardDerivation: outcome.pivot.derivation,
      dashboardReplay: { kind: "derived_v1", sourceTableEventIds: [], transformDigest: "0".repeat(64) },
    },
    new Map([[sales.resultId, salesTableEventId], [hours.resultId, hoursTableEventId]]),
  );
  assert.ok(paired);
  // Ordinal agreement between the replay ref and the derivation — the pin RPC
  // checks these element-wise.
  assert.deepEqual(paired!.dashboardReplay.sourceTableEventIds, [salesTableEventId, hoursTableEventId]);
  assert.deepEqual(
    paired!.dashboardDerivation.sources.map((source) => source.tableEventId),
    [salesTableEventId, hoursTableEventId],
  );
  assert.equal(paired!.dashboardReplay.transformDigest, derivedTableDigest(paired!.dashboardDerivation));
  // The persisted derivation passes the control plane's own schema.
  const parsed = dashboardDerivationSchema.safeParse(paired!.dashboardDerivation);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));

  // An unknown source strips the recipe instead of persisting a broken one.
  const unpaired = pairDerivedTableEvent(
    {
      dashboardDerivation: outcome.pivot.derivation,
      dashboardReplay: { kind: "derived_v1", sourceTableEventIds: [], transformDigest: "0".repeat(64) },
    },
    new Map([[sales.resultId, salesTableEventId]]),
  );
  assert.equal(unpaired, null);
});

test("duplicate period labels are rejected with actionable guidance", () => {
  const sales = salesResult(ulid());
  const doubled: PivotSourceResult = {
    ...sales,
    rows: [...sales.rows, sales.rows[0]!],
  };
  const sources = new Map([[doubled.resultId, doubled]]);
  const outcome = composePivotTable({
    caption: "Weekly scorecard",
    columnsFromResultId: doubled.resultId,
    labelKey: "sales_analytics_completed_at",
    metrics: [
      { resultId: doubled.resultId, valueKey: "sales_analytics_gross_takings", labelKey: null, label: "Sales" },
    ],
  }, sources, "Australia/Melbourne");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /appears more than once/u);
});

test("a change column compares the latest period with the one before, in points on a rate", () => {
  const sales = salesResult(ulid());
  // Newest week first: the change still runs from the week before to the latest.
  const hours = hoursResult(ulid());
  const margin: PivotSourceResult = {
    resultId: ulid(),
    topic: "Sales analytics",
    columns: [
      { key: "sales_analytics_completed_at", label: "Week", type: "date" },
      { key: "sales_analytics_margin", label: "Gross margin", type: "percent", percentScale: "percent" },
    ],
    rows: weeks.map((week, index) => ({ sales_analytics_completed_at: week, sales_analytics_margin: [50, 52.5, 49][index] })),
    provenance,
  };
  const sources = new Map([[sales.resultId, sales], [hours.resultId, hours], [margin.resultId, margin]]);
  const outcome = composePivotTable({
    caption: "Weekly scorecard",
    columnsFromResultId: hours.resultId,
    labelKey: "workforce_analytics_rostered_date",
    change: true,
    metrics: [
      { resultId: sales.resultId, valueKey: "sales_analytics_gross_takings", labelKey: "sales_analytics_completed_at", label: "**Sales**" },
      { resultId: margin.resultId, valueKey: "sales_analytics_margin", labelKey: "sales_analytics_completed_at", label: "Gross margin" },
    ],
  }, sources, "Australia/Melbourne");
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error);
  const { pivot } = outcome;
  const change = pivot.columns.at(-1)!;
  assert.deepEqual({ key: change.key, label: change.label, type: change.type, percentScale: change.percentScale }, { key: "change", label: "Change", type: "percent", percentScale: "percent" });
  // Emphasis typed into a metric name is not part of the label.
  assert.equal(pivot.rows[0]!.metric, "Sales");
  // 1,100 → 1,200 is a 9.1% rise; a margin of 52.5% → 49% is 3.5 points down.
  assert.ok(Math.abs(Number(pivot.rows[0]!.change) - 9.0909) < 0.001, String(pivot.rows[0]!.change));
  assert.equal(pivot.rows[1]!.change, -3.5);
  assert.match(pivot.notes.join(" "), /Change compares 24 Aug 2026 with 17 Aug 2026/u);
  // A dashboard refresh recomputes the change from the same governed cells.
  const replayed = materializeDerivedTable(pivot.derivation, [...sources.values()].map((source) => ({ resultId: source.resultId, columns: source.columns, rows: source.rows })), "Australia/Melbourne");
  assert.deepEqual(replayed.rows, pivot.rows);

  // A change's unit depends on its row, so even a single-unit pivot carries row formats.
  const salesOnly = composePivotTable({
    caption: "Weekly takings",
    columnsFromResultId: sales.resultId,
    labelKey: "sales_analytics_completed_at",
    change: true,
    metrics: [{ resultId: sales.resultId, valueKey: "sales_analytics_gross_takings", labelKey: null, label: "Sales" }],
  }, sources, "Australia/Melbourne");
  assert.ok(salesOnly.ok);
  assert.deepEqual(salesOnly.pivot.rowFormats, [{ type: "currency", currency: "AUD" }]);

  // One period has nothing to compare with: no change column, and the model is told why.
  const single: PivotSourceResult = { ...sales, resultId: ulid(), rows: sales.rows.slice(0, 1) };
  const lone = composePivotTable({
    caption: "One week",
    columnsFromResultId: single.resultId,
    labelKey: "sales_analytics_completed_at",
    change: true,
    metrics: [{ resultId: single.resultId, valueKey: "sales_analytics_gross_takings", labelKey: null, label: "Sales" }],
  }, new Map([[single.resultId, single]]), "Australia/Melbourne");
  assert.ok(lone.ok);
  assert.equal(lone.pivot.columns.some((column) => column.key === "change"), false);
  assert.match(lone.pivot.notes.join(" "), /needs at least two periods/u);
});
