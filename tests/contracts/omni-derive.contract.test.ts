import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResultSemantics, TraceProvenance } from "../../packages/shared/src/index.js";
import { deriveResult } from "../../packages/albert-omni/src/derive.js";
import type { PivotSourceResult } from "../../packages/albert-omni/src/pivot.js";

const provenance = (label: string): TraceProvenance => ({
  sources: [{ connector: "lightspeed", label, dataThrough: "2026-09-01" }],
  timeRange: { label: "Last 180 days", start: "2026-03-05", end: "2026-09-01", timezone: "Australia/Melbourne" },
  definitions: [{ metric: `${label}.metric`, label, definition: `${label} definition` }],
  semanticBundleHash: "bundle",
  identityGraph: { version: 1, hash: "hash" },
});

const completeSemantics = (key: string, rows: number, period = false): ResultSemantics => ({
  version: 1, completeness: "complete", returnedRows: rows, rowLimit: 500,
  grain: [key], keys: { [key]: { kind: period ? "period" : "identifier", domain: period ? "time:Australia/Melbourne:day" : "fixture:product" } },
  window: "fixture-window", queryDigest: "fixture", semanticVersionDigest: "fixture",
});

const stock: PivotSourceResult = {
  resultId: "01STOCK0000000000000000000",
  topic: "Inventory analytics",
  columns: [
    { key: "item_id", label: "Product ID", type: "string" },
    { key: "units_on_hand", label: "Units on hand", type: "number" },
    { key: "stock_value", label: "Stock value", type: "currency", currency: "AUD" },
  ],
  rows: [
    { item_id: "sku-001", units_on_hand: 1, stock_value: "6293.00" },
    { item_id: "sku-002", units_on_hand: 1, stock_value: 4894 },
    { item_id: "sku-003", units_on_hand: 40, stock_value: 400 },
    { item_id: "sku-004", units_on_hand: 56, stock_value: 112 },
  ],
  provenance: provenance("Stock on hand"),
  semantics: completeSemantics("item_id", 4),
};

const sold: PivotSourceResult = {
  resultId: "01SOLD00000000000000000000",
  topic: "Product sales analytics",
  columns: [
    { key: "item_id", label: "Product ID", type: "string" },
    { key: "units_sold", label: "Units sold", type: "number" },
  ],
  rows: [
    { item_id: "sku-003", units_sold: 31 },
    { item_id: "sku-004", units_sold: 56 },
    { item_id: "sku-005", units_sold: 3 },
  ],
  provenance: provenance("Items sold"),
  semantics: completeSemantics("item_id", 3),
};

const sources = new Map([[stock.resultId, stock], [sold.resultId, sold]]);

const base = {
  caption: "test",
  secondResultId: null,
  leftKey: null,
  rightKey: null,
  joinMode: null,
  includeColumns: null,
  groupBy: null,
  metrics: null,
  expressions: null,
} as const;

test("anti join answers 'in stock but never sold' from two results, matching declared fixture identity keys", () => {
  const outcome = deriveResult({
    ...base,
    caption: "Dead stock",
    operation: "join",
    resultId: stock.resultId,
    secondResultId: sold.resultId,
    leftKey: "item_id",
    rightKey: "item_id",
    joinMode: "anti",
  }, sources);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.deepEqual(outcome.result.rows.map((row) => row.item_id), ["sku-001", "sku-002"]);
  assert.deepEqual(outcome.result.columns.map((column) => column.key), ["item_id", "units_on_hand", "stock_value"]);
  assert.equal(outcome.result.provenance.sources.length, 2);
  assert.match(outcome.result.notes.join(" "), /2 of 4 left rows matched/u);
});

test("left join brings the second result's numeric columns and leaves unmatched rows blank", () => {
  const outcome = deriveResult({
    ...base,
    operation: "join",
    resultId: stock.resultId,
    secondResultId: sold.resultId,
    leftKey: "item_id",
    joinMode: "left",
  }, sources);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const byItem = new Map(outcome.result.rows.map((row) => [row.item_id, row.units_sold]));
  assert.equal(byItem.get("sku-003"), 31);
  assert.equal(byItem.get("sku-004"), 56);
  assert.equal(byItem.get("sku-001"), null);
  assert.equal(outcome.result.rows.length, 4);
});

test("aggregate sums and counts a result as a whole and by a group column", () => {
  const whole = deriveResult({
    ...base,
    operation: "aggregate",
    resultId: stock.resultId,
    metrics: [
      { valueKey: "stock_value", fn: "sum", label: "Total stock value" },
      { valueKey: "item_id", fn: "count", label: "Items" },
      { valueKey: "units_on_hand", fn: "avg", label: "Average units" },
    ],
  }, sources);
  assert.ok(whole.ok, JSON.stringify(whole));
  assert.equal(whole.result.rows.length, 1);
  const row = whole.result.rows[0]!;
  assert.equal(row.total_stock_value, 11699);
  assert.equal(row.items, 4);
  assert.equal(row.average_units, 24.5);
  assert.equal(whole.result.columns.find((column) => column.key === "total_stock_value")?.currency, "AUD");

  const grouped = deriveResult({
    ...base,
    operation: "aggregate",
    resultId: sold.resultId,
    groupBy: "item_id",
    metrics: [{ valueKey: "units_sold", fn: "sum", label: "Units" }],
  }, sources);
  assert.ok(grouped.ok);
  assert.equal(grouped.result.rows.length, 3);
});

test("compute adds ratio, percent and difference columns and blanks divisions by zero", () => {
  const outcome = deriveResult({
    ...base,
    operation: "compute",
    resultId: stock.resultId,
    expressions: [
      { label: "Value per unit", kind: "ratio", leftKey: "stock_value", rightKey: "units_on_hand" },
      { label: "Units share", kind: "percent_of", leftKey: "units_on_hand", rightKey: "units_on_hand" },
    ],
  }, sources);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const first = outcome.result.rows[0]!;
  assert.equal(first.value_per_unit, 6293);
  assert.equal(first.units_share, 100);
  assert.equal(outcome.result.columns.find((column) => column.key === "units_share")?.type, "percent");
  assert.deepEqual(outcome.result.provenance.calculations?.map((calc) => calc.column), ["value_per_unit", "units_share"]);
});

test("derive refuses unknown results, missing keys and non-numeric metrics with actionable guidance", () => {
  const unknown = deriveResult({ ...base, operation: "aggregate", resultId: "01NOPE00000000000000000000", metrics: [{ valueKey: "x", fn: "sum", label: "X" }] }, sources);
  assert.equal(unknown.ok, false);
  const missingKey = deriveResult({ ...base, operation: "join", resultId: stock.resultId, secondResultId: sold.resultId, leftKey: "nope", joinMode: "inner" }, sources);
  assert.equal(missingKey.ok, false);
  assert.match(missingKey.ok ? "" : missingKey.guidance, /Columns: item_id/u);
  const textMetric = deriveResult({ ...base, operation: "aggregate", resultId: stock.resultId, metrics: [{ valueKey: "item_id", fn: "sum", label: "Names" }] }, sources);
  assert.equal(textMetric.ok, false);
});

// ---- Replayable derivations (ADR 0134) ------------------------------------

import { derivedTableDigest, materializeDerivedTable } from "../../packages/albert-v3/src/engine/derived-table.js";
import { pairDerivedTableEvent } from "../../packages/albert-omni/src/pivot.js";

const jobs: PivotSourceResult = {
  resultId: "01JOBS00000000000000000000",
  topic: "Workshop jobs",
  columns: [
    { key: "day", label: "Day", type: "date" },
    { key: "jobs_completed", label: "Jobs completed", type: "number" },
  ],
  rows: [
    { day: "2026-08-28", jobs_completed: 12 },
    { day: "2026-08-29", jobs_completed: 9 },
    { day: "2026-08-30", jobs_completed: 14 },
  ],
  provenance: provenance("Jobs"),
  semantics: completeSemantics("day", 3, true),
};

const takings: PivotSourceResult = {
  resultId: "01TAKE00000000000000000000",
  topic: "Sales analytics",
  columns: [
    { key: "day", label: "Day", type: "date" },
    { key: "gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
    { key: "gross_profit", label: "Gross profit", type: "currency", currency: "AUD" },
  ],
  rows: [
    { day: "2026-08-28", gross_takings: 2400, gross_profit: 900 },
    { day: "2026-08-29", gross_takings: 1800, gross_profit: 640 },
    { day: "2026-08-30", gross_takings: 3100, gross_profit: 1210 },
  ],
  provenance: provenance("Takings"),
  semantics: completeSemantics("day", 3, true),
};

const dailySources = new Map([[jobs.resultId, jobs], [takings.resultId, takings]]);

test("an inner join over two governed results seals a derivation a dashboard refresh reproduces", () => {
  const outcome = deriveResult({
    ...base,
    caption: "Daily workshop summary",
    operation: "join",
    resultId: jobs.resultId,
    secondResultId: takings.resultId,
    leftKey: "day",
    rightKey: "day",
    joinMode: "inner",
  }, dailySources);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const { derivation } = outcome.result;
  assert.ok(derivation, outcome.result.notes.join(" "));
  assert.deepEqual(derivation.sources.map((source) => source.resultId), [jobs.resultId, takings.resultId]);
  assert.equal(derivation.rows.length, 3);
  // Left cells are direct references; right cells are looked up by the join key.
  const first = derivation.rows[0]!.cells;
  assert.deepEqual(first.find((cell) => cell.columnKey === "jobs_completed")?.expression, {
    kind: "source", sourceResultId: jobs.resultId, rowIndex: 0, columnKey: "jobs_completed",
  });
  assert.deepEqual(first.find((cell) => cell.columnKey === "gross_takings")?.expression, {
    kind: "matched_source",
    sourceResultId: takings.resultId,
    columnKey: "gross_takings",
    matchColumnKey: "day",
    matchValue: { kind: "source", sourceResultId: jobs.resultId, rowIndex: 0, columnKey: "day" },
  });
  // A refresh materialises the same rows from the same sources.
  const replayed = materializeDerivedTable(derivation, [
    { resultId: jobs.resultId, columns: jobs.columns, rows: jobs.rows },
    { resultId: takings.resultId, columns: takings.columns, rows: takings.rows },
  ], "Australia/Melbourne");
  assert.deepEqual(replayed.rows, outcome.result.rows);
  // The relay pairs table event ids and stamps the digest, as it does for pivots.
  const paired = pairDerivedTableEvent({
    dashboardDerivation: derivation,
    dashboardReplay: { kind: "derived_v1", sourceTableEventIds: [], transformDigest: "0".repeat(64) },
  }, new Map([[jobs.resultId, "01JOBSTABLEEVENT0000000000"], [takings.resultId, "01TAKETABLEEVENT0000000000"]]));
  assert.ok(paired);
  assert.deepEqual(paired.dashboardReplay.sourceTableEventIds, ["01JOBSTABLEEVENT0000000000", "01TAKETABLEEVENT0000000000"]);
  assert.equal(paired.dashboardReplay.transformDigest, derivedTableDigest(paired.dashboardDerivation));
});

test("a compute over a sealed join folds through to the governed leaves", () => {
  const joined = deriveResult({
    ...base,
    caption: "Daily workshop summary",
    operation: "join",
    resultId: jobs.resultId,
    secondResultId: takings.resultId,
    leftKey: "day",
    rightKey: "day",
    joinMode: "inner",
  }, dailySources);
  assert.ok(joined.ok && joined.result.derivation);
  const joinedResult: PivotSourceResult = {
    resultId: "01JOIN00000000000000000000",
    topic: "Daily workshop summary",
    columns: joined.result.columns,
    rows: joined.result.rows,
    provenance: joined.result.provenance,
    derivation: joined.result.derivation,
  };
  const computed = deriveResult({
    ...base,
    caption: "Takings per job",
    operation: "compute",
    resultId: joinedResult.resultId,
    expressions: [
      { label: "Takings per job", kind: "ratio", leftKey: "gross_takings", rightKey: "jobs_completed" },
      { label: "Margin %", kind: "percent_of", leftKey: "gross_profit", rightKey: "gross_takings" },
    ],
  }, new Map([...dailySources, [joinedResult.resultId, joinedResult]]));
  assert.ok(computed.ok, JSON.stringify(computed));
  const { derivation } = computed.result;
  assert.ok(derivation, computed.result.notes.join(" "));
  // Only governed leaves are sources; the join's own id never appears.
  assert.deepEqual(derivation.sources.map((source) => source.resultId), [jobs.resultId, takings.resultId]);
  const ratio = derivation.rows[0]!.cells.find((cell) => cell.columnKey === "takings_per_job")?.expression;
  assert.equal(ratio?.kind, "calculation");
  assert.equal(ratio?.kind === "calculation" ? ratio.operator : null, "divide");
  const replayed = materializeDerivedTable(derivation, [
    { resultId: jobs.resultId, columns: jobs.columns, rows: jobs.rows },
    { resultId: takings.resultId, columns: takings.columns, rows: takings.rows },
  ], "Australia/Melbourne");
  assert.equal(replayed.rows[0]?.takings_per_job, computed.result.rows[0]?.takings_per_job);
  assert.equal(replayed.rows[2]?.margin, computed.result.rows[2]?.margin);
});

test("aggregates, anti-joins, unmatched left rows and oversized sources stay unreplayable, with a reason", () => {
  const aggregate = deriveResult({
    ...base,
    caption: "Total jobs",
    operation: "aggregate",
    resultId: jobs.resultId,
    metrics: [{ valueKey: "jobs_completed", fn: "sum", label: "Jobs" }],
  }, dailySources);
  assert.ok(aggregate.ok);
  assert.equal(aggregate.result.derivation, null);
  assert.match(aggregate.result.notes.join(" "), /Not refreshable on a dashboard: an aggregate/u);

  const anti = deriveResult({
    ...base, caption: "Never sold", operation: "join", resultId: stock.resultId, secondResultId: sold.resultId,
    leftKey: "item_id", rightKey: "item_id", joinMode: "anti",
  }, sources);
  assert.ok(anti.ok);
  assert.equal(anti.result.derivation, null);

  const left = deriveResult({
    ...base, caption: "Stock with sales", operation: "join", resultId: stock.resultId, secondResultId: sold.resultId,
    leftKey: "item_id", rightKey: "item_id", joinMode: "left",
  }, sources);
  assert.ok(left.ok);
  assert.equal(left.result.derivation, null);
  assert.match(left.result.notes.join(" "), /some rows had no match/u);

  // Exact declared identifiers use the same matcher in chat and on refresh.
  const inner = deriveResult({
    ...base, caption: "Stock with sales", operation: "join", resultId: stock.resultId, secondResultId: sold.resultId,
    leftKey: "item_id", rightKey: "item_id", joinMode: "inner",
  }, sources);
  assert.ok(inner.ok);
  assert.ok(inner.result.derivation);

  const big: PivotSourceResult = {
    ...takings,
    resultId: "01BIG000000000000000000000",
    rows: Array.from({ length: 60 }, (_, index) => ({ day: `2026-06-${String((index % 30) + 1).padStart(2, "0")}`, gross_takings: index, gross_profit: index })),
  };
  const oversized = deriveResult({
    ...base, caption: "Margin", operation: "compute", resultId: big.resultId,
    expressions: [{ label: "Margin %", kind: "percent_of", leftKey: "gross_profit", rightKey: "gross_takings" }],
  }, new Map([[big.resultId, big]]));
  assert.ok(oversized.ok);
  assert.equal(oversized.result.derivation, null);
  assert.match(oversized.result.notes.join(" "), /more than 50 rows/u);
});

test("percent change runs from the right (earlier) column to the left and blanks a zero base", () => {
  const categories: PivotSourceResult = {
    resultId: "01CATS00000000000000000000",
    topic: "Category sales",
    columns: [
      { key: "category", label: "Category", type: "string" },
      { key: "this_month", label: "September", type: "currency", currency: "AUD" },
      { key: "last_month", label: "August", type: "currency", currency: "AUD" },
      { key: "units", label: "Units", type: "number" },
    ],
    rows: [
      { category: "Bikes", this_month: "12000.00", last_month: 10000, units: 4 },
      { category: "Parts", this_month: 450, last_month: 600, units: 30 },
      { category: "Service", this_month: 800, last_month: 0, units: 9 },
      // A loss that turned into a profit is a rise, whatever the base's sign.
      { category: "Hire", this_month: 300, last_month: -200, units: 2 },
    ],
    provenance: provenance("Category sales"),
    semantics: completeSemantics("category", 4),
  };
  const catSources = new Map([[categories.resultId, categories]]);
  const outcome = deriveResult({
    ...base,
    operation: "compute",
    resultId: categories.resultId,
    expressions: [{ label: "Change", kind: "percent_change", leftKey: "this_month", rightKey: "last_month" }],
  }, catSources);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.deepEqual(outcome.result.rows.map((row) => row.change), [20, -25, null, 250]);
  assert.deepEqual(outcome.result.columns.find((column) => column.key === "change"), { key: "change", label: "Change", type: "percent", percentScale: "percent" });
  assert.match(outcome.result.provenance.calculations?.[0]?.formula ?? "", /^\(this_month − last_month\) ÷ \|last_month\| × 100$/u);
  // The sealed transform reproduces the same figures on refresh.
  const { derivation } = outcome.result;
  assert.ok(derivation, outcome.result.notes.join(" "));
  const replayed = materializeDerivedTable(derivation, [{ resultId: categories.resultId, columns: categories.columns, rows: categories.rows }], "Australia/Melbourne");
  assert.deepEqual(replayed.rows.map((row) => row.change), [20, -25, null, 250]);
  // A change between an amount and a count is refused, like a difference.
  const mixed = deriveResult({
    ...base,
    operation: "compute",
    resultId: categories.resultId,
    expressions: [{ label: "Nonsense", kind: "percent_change", leftKey: "this_month", rightKey: "units" }],
  }, catSources);
  assert.equal(mixed.ok, false);
});

test("a join sets two periods side by side, labelled by window, and adds the change in the same call", () => {
  const month = (resultId: string, window: string, label: string, rows: { category_id: string; category: string; sales: number }[]): PivotSourceResult => ({
    resultId,
    topic: "Category sales",
    columns: [
      { key: "category_id", label: "Category ID", type: "string" },
      { key: "category", label: "Category", type: "string" },
      { key: "sales", label: "Sales", type: "currency", currency: "AUD" },
    ],
    rows,
    provenance: { ...provenance("Category sales"), timeRange: { label, start: "unknown", end: "unknown", timezone: "Australia/Melbourne" } },
    semantics: { ...completeSemantics("category_id", rows.length), window: `{"ranges":["${window}"]}` },
  });
  const sep = month("01SEPT00000000000000000000", "sep", "2026-09-01 to 2026-09-19", [
    { category_id: "c1", category: "Services", sales: 7137 },
    { category_id: "c2", category: "Kids bikes", sales: 660 },
    { category_id: "c3", category: "Computers", sales: 685 },
  ]);
  const aug = month("01AUGU00000000000000000000", "aug", "2026-08-01 to 2026-08-19", [
    { category_id: "c1", category: "Services", sales: 3475 },
    { category_id: "c2", category: "Kids bikes", sales: 1320 },
    { category_id: "c4", category: "Helmets", sales: 710 },
  ]);
  const periods = new Map([[sep.resultId, sep], [aug.resultId, aug]]);
  const compared = deriveResult({
    ...base,
    caption: "Category sales, September against August",
    operation: "join",
    resultId: sep.resultId,
    secondResultId: aug.resultId,
    leftKey: "category_id",
    rightKey: "category_id",
    joinMode: "left",
    includeColumns: ["sales"],
    expressions: [{ label: "Change", kind: "percent_change", leftKey: "sales", rightKey: "matched_sales" }],
  }, periods);
  assert.ok(compared.ok, JSON.stringify(compared));
  const { columns, rows, notes } = compared.result;
  assert.deepEqual(columns.map((column) => column.key), ["category_id", "category", "sales", "matched_sales", "change"]);
  // Each side's figures say which window they cover, so neither reads as the other.
  assert.match(columns.find((column) => column.key === "sales")!.label, /^Sales \(1 Sept? 2026–19 Sept? 2026\)$/u);
  assert.match(columns.find((column) => column.key === "matched_sales")!.label, /^Sales \(1 Aug 2026–19 Aug 2026\)$/u);
  assert.ok(Math.abs(Number(rows[0]!.change) - 105.3813) < 0.001);
  assert.deepEqual(rows.slice(1).map((row) => row.change === null ? null : Number(row.change)), [-50, null]);
  assert.match(notes.join(" "), /Two periods side by side/u);
  assert.equal(compared.result.provenance.calculations?.find((calculation) => calculation.column === "change")?.operator, "percent_change");

  // "What dropped": the earlier period on the left keeps a category with no later sales, at zero when asked.
  const dropped = deriveResult({
    ...base,
    caption: "What fell",
    operation: "join",
    resultId: aug.resultId,
    secondResultId: sep.resultId,
    leftKey: "category_id",
    rightKey: "category_id",
    joinMode: "left",
    unmatchedAsZero: true,
    includeColumns: ["sales"],
    expressions: [{ label: "Drop", kind: "difference", leftKey: "matched_sales", rightKey: "sales" }],
  }, periods);
  assert.ok(dropped.ok, JSON.stringify(dropped));
  assert.deepEqual(dropped.result.rows.map((row) => [row.category, Number(row.matched_sales), Number(row.drop)]), [["Services", 7137, 3662], ["Kids bikes", 660, -660], ["Helmets", 0, -710]]);
  assert.match(dropped.result.notes.join(" "), /1 unmatched row reads 0/u);
  // Without it the missing figure stays blank.
  const blank = deriveResult({ ...base, caption: "What fell", operation: "join", resultId: aug.resultId, secondResultId: sep.resultId, leftKey: "category_id", rightKey: "category_id", joinMode: "left", includeColumns: ["sales"] }, periods);
  assert.ok(blank.ok);
  assert.equal(blank.result.rows[2]!.matched_sales, null);
});
