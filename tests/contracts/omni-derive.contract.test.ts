import assert from "node:assert/strict";
import { test } from "node:test";
import type { TraceProvenance } from "../../packages/shared/src/index.js";
import { deriveResult } from "../../packages/albert-omni/src/derive.js";
import type { PivotSourceResult } from "../../packages/albert-omni/src/pivot.js";

const provenance = (label: string): TraceProvenance => ({
  sources: [{ connector: "lightspeed", label, dataThrough: "2026-09-01" }],
  timeRange: { label: "Last 180 days", start: "2026-03-05", end: "2026-09-01", timezone: "Australia/Melbourne" },
  definitions: [{ metric: `${label}.metric`, label, definition: `${label} definition` }],
  semanticBundleHash: "bundle",
  identityGraph: { version: 1, hash: "hash" },
});

const stock: PivotSourceResult = {
  resultId: "01STOCK0000000000000000000",
  topic: "Inventory analytics",
  columns: [
    { key: "items_name", label: "Item", type: "string" },
    { key: "units_on_hand", label: "Units on hand", type: "number" },
    { key: "stock_value", label: "Stock value", type: "currency", currency: "AUD" },
  ],
  rows: [
    { items_name: "Izalco Max", units_on_hand: 1, stock_value: "6293.00" },
    { items_name: "Focus Jam2", units_on_hand: 1, stock_value: 4894 },
    { items_name: "Brake pads", units_on_hand: 40, stock_value: 400 },
    { items_name: "Gear cable", units_on_hand: 56, stock_value: 112 },
  ],
  provenance: provenance("Stock on hand"),
};

const sold: PivotSourceResult = {
  resultId: "01SOLD00000000000000000000",
  topic: "Product sales analytics",
  columns: [
    { key: "items_name", label: "Item", type: "string" },
    { key: "units_sold", label: "Units sold", type: "number" },
  ],
  rows: [
    { items_name: "brake pads", units_sold: 31 },
    { items_name: "Gear Cable ", units_sold: 56 },
    { items_name: "Helmet", units_sold: 3 },
  ],
  provenance: provenance("Items sold"),
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

test("anti join answers 'in stock but never sold' from two results, matching labels case-insensitively", () => {
  const outcome = deriveResult({
    ...base,
    caption: "Dead stock",
    operation: "join",
    resultId: stock.resultId,
    secondResultId: sold.resultId,
    leftKey: "items_name",
    rightKey: "items_name",
    joinMode: "anti",
  }, sources);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.deepEqual(outcome.result.rows.map((row) => row.items_name), ["Izalco Max", "Focus Jam2"]);
  assert.deepEqual(outcome.result.columns.map((column) => column.key), ["items_name", "units_on_hand", "stock_value"]);
  assert.equal(outcome.result.provenance.sources.length, 2);
  assert.match(outcome.result.notes.join(" "), /2 of 4 left rows matched/u);
});

test("left join brings the second result's numeric columns and leaves unmatched rows blank", () => {
  const outcome = deriveResult({
    ...base,
    operation: "join",
    resultId: stock.resultId,
    secondResultId: sold.resultId,
    leftKey: "items_name",
    joinMode: "left",
  }, sources);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  const byItem = new Map(outcome.result.rows.map((row) => [row.items_name, row.units_sold]));
  assert.equal(byItem.get("Brake pads"), 31);
  assert.equal(byItem.get("Gear cable"), 56);
  assert.equal(byItem.get("Izalco Max"), null);
  assert.equal(outcome.result.rows.length, 4);
});

test("aggregate sums and counts a result as a whole and by a group column", () => {
  const whole = deriveResult({
    ...base,
    operation: "aggregate",
    resultId: stock.resultId,
    metrics: [
      { valueKey: "stock_value", fn: "sum", label: "Total stock value" },
      { valueKey: "items_name", fn: "count", label: "Items" },
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
    groupBy: "items_name",
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
  assert.match(missingKey.ok ? "" : missingKey.guidance, /Columns: items_name/u);
  const textMetric = deriveResult({ ...base, operation: "aggregate", resultId: stock.resultId, metrics: [{ valueKey: "items_name", fn: "sum", label: "Names" }] }, sources);
  assert.equal(textMetric.ok, false);
});
