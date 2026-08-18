import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { CubeCatalogue } from "../../packages/albert-v3/src/cube/types.js";
import {
  describeCubeQueryProvenance,
  describeDerivedCalculations,
} from "../../packages/albert-v3/src/engine/query-provenance.js";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const catalogue: CubeCatalogue = {
  fetchedAt: "2026-08-18T00:00:00.000Z",
  views: [{
    name: "sales_analytics",
    title: "Sales analytics",
    description: "The main surface for revenue, refunds, discounts and store performance at whole-transaction grain.",
    aiContext: "Default time dimension: completed_at.",
    members: [
      { name: "sales_analytics.gross_takings", kind: "measure", title: "Gross takings (inc tax)", shortTitle: "Gross takings", type: "number", description: "Tax-inclusive revenue across completed, non-voided sales. Refunds subtract." },
      { name: "sales_analytics.transactions", kind: "measure", title: "Transactions", shortTitle: "Transactions", type: "number", aiContext: "Number of completed sales." },
      { name: "sales_analytics.shops_name", kind: "dimension", title: "Store", shortTitle: "Store", type: "string", description: "The store the sale was rung up in." },
      { name: "sales_analytics.completed_at", kind: "dimension", title: "Completed at", shortTitle: "Completed", type: "time", description: "When the sale was finalised at the till." },
      { name: "sales_analytics.sale_type", kind: "dimension", title: "Sale type", shortTitle: "Type", type: "string" },
    ],
  }],
};

test("Cube result provenance carries the view, real member meanings, filters and time window", () => {
  const provenance = describeCubeQueryProvenance({
    query: {
      measures: ["sales_analytics.gross_takings", "sales_analytics.transactions"],
      dimensions: ["sales_analytics.shops_name"],
      timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: "month", dateRange: "last 12 months" }],
      filters: [
        { member: "sales_analytics.shops_name", operator: "equals", values: ["Ashburton Cycles"] },
        { or: [
          { member: "sales_analytics.sale_type", operator: "equals", values: ["sale"] },
          { member: "sales_analytics.sale_type", operator: "equals", values: ["layby"] },
        ] },
      ],
    },
    view: "sales_analytics",
    members: ["sales_analytics.gross_takings", "sales_analytics.transactions", "sales_analytics.shops_name", "sales_analytics.completed_at"],
    catalogue,
  });

  assert.equal(provenance.view?.label, "Sales analytics");
  assert.match(provenance.view?.description ?? "", /whole-transaction grain/u);

  const byMetric = new Map(provenance.definitions.map((definition) => [definition.metric, definition]));
  assert.equal(byMetric.get("sales_analytics.gross_takings")?.definition, "Tax-inclusive revenue across completed, non-voided sales. Refunds subtract.");
  assert.equal(byMetric.get("sales_analytics.gross_takings")?.kind, "measure");
  // ai_context stands in when a member has no description.
  assert.equal(byMetric.get("sales_analytics.transactions")?.definition, "Number of completed sales.");
  assert.equal(byMetric.get("sales_analytics.completed_at")?.kind, "time");
  assert.equal(byMetric.get("sales_analytics.shops_name")?.label, "Store");
  // The old placeholder must be gone.
  assert.equal(provenance.definitions.some((definition) => /^Governed member of the/u.test(definition.definition)), false);

  const texts = (provenance.filters ?? []).map((filter) => filter.text);
  assert.ok(texts.includes("Store is Ashburton Cycles"), texts.join(" | "));
  assert.ok(texts.includes("Sale type is sale (any of)"));
  assert.ok(texts.includes("Sale type is layby (any of)"));
  assert.ok(texts.includes("Completed at in last 12 months by month"));
});

test("composed-table provenance explains calculated columns in words", () => {
  const sources = new Map([[
    "cmp",
    {
      caption: "Like-for-like",
      columns: [{ key: "period", label: "Period" }, { key: "sales", label: "Sales" }],
      rows: [{ period: "1–18 Aug 2026", sales: 15668.34 }, { period: "1–18 Aug 2025", sales: 32197.68 }],
    },
  ]]);
  const calculations = describeDerivedCalculations({
    version: "derived_table_v1",
    sources: [{ tableEventId: "01KZN20VTX2EWW1TQ2AA3MCPW7", resultId: "cmp" }],
    columns: [
      { key: "label", label: "Measure", type: "string" },
      { key: "change", label: "Change %", type: "percent" },
      { key: "delta", label: "Change $", type: "currency", currency: "AUD" },
    ],
    rows: [{ cells: [
      { columnKey: "label", expression: { kind: "literal", value: "Sales" } },
      { columnKey: "change", expression: { kind: "calculation", operator: "percent_change", left: { kind: "source", sourceResultId: "cmp", rowIndex: 0, columnKey: "sales" }, right: { kind: "source", sourceResultId: "cmp", rowIndex: 1, columnKey: "sales" } } },
      { columnKey: "delta", expression: { kind: "calculation", operator: "subtract", left: { kind: "source", sourceResultId: "cmp", rowIndex: 0, columnKey: "sales" }, right: { kind: "source", sourceResultId: "cmp", rowIndex: 1, columnKey: "sales" } } },
    ] }],
  }, sources);
  assert.deepEqual(calculations, [
    { column: "Change %", formula: "(Sales (1–18 Aug 2026) − Sales (1–18 Aug 2025)) ÷ Sales (1–18 Aug 2025) × 100" },
    { column: "Change $", formula: "Sales (1–18 Aug 2026) − Sales (1–18 Aug 2025)" },
  ]);
});

test("query, schema and value-lookup tools emit findings the trace can show, and the UI renders them", () => {
  const tools = read("packages/albert-v3/src/engine/tools.ts");
  assert.match(tools, /describeCubeQueryProvenance\(\{\s*query: validated\.query,/u);
  assert.match(tools, /calculations: describeDerivedCalculations\(/u);
  assert.match(tools, /stage: "field_values",[\s\S]*?label: sanitizeTraceText\(\s*matchCount > 0/u);
  assert.match(tools, /findings: matches\.slice\(0, 5\)\.map/u);
  assert.match(tools, /stage: "definition",\s*label: `Read the definitions for/u);
  assert.doesNotMatch(tools, /definition: `Governed member of the \$\{validated\.view\} Cube view\.`/u);

  const ui = read("app/dash/components/InsightsStyleTrace.tsx");
  assert.match(ui, /function ResearchFindings\(/u);
  assert.match(ui, /function QueryDetails\(/u);
  assert.match(ui, /Nothing matched — trying another way\./u);
  assert.match(ui, /provenance\.calculations/u);
  assert.match(ui, /"How this was worked out"/u);
});
