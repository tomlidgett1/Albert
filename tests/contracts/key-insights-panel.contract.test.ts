import assert from "node:assert/strict";
import test from "node:test";
import type { TraceTableEvent } from "../../packages/shared/src/index.js";
import { deriveKeyInsights } from "../../app/dash/components/key-insights.js";

const baseProvenance: TraceTableEvent["provenance"] = {
  sources: [{
    connector: "lightspeed",
    label: "Cube · product_sales_analytics",
    dataThrough: "2026-08-12T00:00:00.000Z",
  }],
  timeRange: {
    label: "last 12 months",
    start: "2025-08-12",
    end: "2026-08-12",
    timezone: "Australia/Melbourne",
  },
  definitions: [],
  semanticBundleHash: "test-bundle",
  identityGraph: { version: 0, hash: "test" },
};

function table(overrides: Partial<TraceTableEvent> = {}): TraceTableEvent {
  return {
    id: "table-1",
    sequence: 1,
    type: "table",
    status: "complete",
    occurredAt: "2026-08-12T00:00:00.000Z",
    caption: "Lowest gross-profit products",
    columns: [
      { key: "item_id", label: "Item ID", type: "number" },
      { key: "item_name", label: "Item", type: "string" },
      { key: "units_sold", label: "Units sold", type: "number" },
      { key: "gross_profit", label: "Gross profit", type: "currency", currency: "AUD" },
      { key: "gross_margin", label: "Gross margin", type: "percent" },
    ],
    rows: [{
      item_id: 14443,
      item_name: "Dyson Hard Tail Evo",
      units_sold: 0,
      gross_profit: -3250,
      gross_margin: -1,
    }],
    resultId: "result-1",
    provenance: baseProvenance,
    ...overrides,
  };
}

test("Key Insights prioritises commercial measures over technical identifiers", () => {
  const [insight] = deriveKeyInsights([{ id: 1, events: [table()], streaming: false }]);
  assert.ok(insight);
  assert.deepEqual(
    insight.rows[0]?.values.map((value) => value.column.key),
    ["gross_profit", "gross_margin", "units_sold"],
  );
  assert.equal(insight.rows[0]?.label, "Dyson Hard Tail Evo");
});

test("Key Insights uses the recent edge of longer time series", () => {
  const dated = table({
    caption: "Monthly sales trend",
    columns: [
      { key: "month", label: "Month", type: "date" },
      { key: "sales", label: "Sales", type: "currency", currency: "AUD" },
    ],
    rows: [
      { month: "2026-04-01", sales: 10 },
      { month: "2026-05-01", sales: 20 },
      { month: "2026-06-01", sales: 30 },
      { month: "2026-07-01", sales: 40 },
    ],
  });
  const [insight] = deriveKeyInsights([{ id: 1, events: [dated], streaming: false }]);
  assert.deepEqual(insight?.rows.map((row) => row.label), [
    "1 July 2026",
    "1 June 2026",
    "1 May 2026",
  ]);
});

test("Key Insights orders the newest evidence first and removes duplicate sources", () => {
  const first = table({ id: "table-1", resultId: "result-1", caption: "First" });
  const second = table({
    id: "table-2",
    resultId: "result-2",
    caption: "Second",
    provenance: {
      ...baseProvenance,
      sources: [...baseProvenance.sources, ...baseProvenance.sources],
    },
  });
  const insights = deriveKeyInsights([{ id: 1, events: [first, second], streaming: false }]);
  assert.deepEqual(insights.map((insight) => insight.title), ["Second", "First"]);
  assert.equal(insights[0]?.sources.length, 1);
});

test("Key Insights shortens analytical query captions into editorial topics", () => {
  const [insight] = deriveKeyInsights([{
    id: 1,
    events: [table({
      caption: "Lowest gross-profit products in the latest rolling 12 months",
    })],
    streaming: false,
  }]);
  assert.equal(insight?.title, "Lowest gross-profit products");
});
