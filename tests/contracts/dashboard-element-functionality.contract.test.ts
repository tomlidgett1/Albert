import assert from "node:assert/strict";
import test from "node:test";
import { dashboardElementFields } from "../../services/dashboard/src/element-fields";
import { applyDashboardQueryEdits } from "../../services/dashboard/src/query-edits";
import { compileGroundedFlint } from "../../packages/shared/src/flint-grounded";
import { assembleFlintChart, formatPointValue } from "../../app/dash/lib/flint-assemble";
import { computeKpiPresentation } from "../../app/dash/components/dashboard-values";
import type { CubeCatalogue } from "../../packages/albert-v3/src/cube/types";

const catalogue: CubeCatalogue = { fetchedAt: "2026-09-05", views: [{ name: "sales", title: "Sales", members: [
  { name: "sales.revenue", title: "Revenue", shortTitle: "Revenue", kind: "measure", type: "number" },
  { name: "sales.date", title: "Date", shortTitle: "Date", kind: "dimension", type: "time" },
  { name: "sales.private", title: "Private", shortTitle: "Private", kind: "dimension", type: "string", aiHidden: true },
] }] };

test("the field list includes every visible member beyond the old 400-field cap", () => {
  const fields = dashboardElementFields({ ...catalogue.views[0]!, members: [
    ...catalogue.views[0]!.members,
    ...Array.from({ length: 650 }, (_, index) => ({ name: "sales.field_" + index, title: "Field " + index, shortTitle: "Field " + index, kind: "dimension" as const, type: "string" as const })),
  ] });
  assert.equal(fields.length, 652);
  assert.equal(fields.at(-1)?.name, "sales.field_649");
  assert.ok(!fields.some(field => field.name === "sales.private"));
});

test("adding a date that already filters the query makes it a grouping without losing its range", () => {
  const result = applyDashboardQueryEdits({ measures: ["sales.revenue"], timeDimensions: [{ dimension: "sales.date", dateRange: "last 30 days" }] }, [{ op: "add_dimension", member: "sales.date", granularity: "week" }], catalogue, "sales");
  assert.ok(result.ok);
  assert.deepEqual(result.query.timeDimensions, [{ dimension: "sales.date", dateRange: "last 30 days", granularity: "week" }]);
});

test("hidden fields cannot be added by guessing a member key in a dashboard edit", () => {
  const result = applyDashboardQueryEdits({ measures: ["sales.revenue"] }, [{ op: "add_dimension", member: "sales.private" }], catalogue, "sales");
  assert.equal(result.ok, false);
});

function chart(type: "currency" | "percent", chartType: "bar" | "line") {
  return compileGroundedFlint({ caption: "QA", chartType, xKey: "day", yKey: "value", columns: [
    { key: "day", label: "Day", type: "date" },
    { key: "value", label: "Value", type, ...(type === "currency" ? { currency: "AUD" } : { percentScale: "percent" as const }) },
  ], rows: [{ day: "2026-08-01", value: 0.5 }, { day: "2026-08-02", value: 25 }], valueDecimals: { value: 2 } });
}

test("bars and lines retain explicit percent units, including values below one", () => {
  for (const type of ["bar", "line"] as const) {
    const plan = chart("percent", type);
    assert.equal(formatPointValue(0.5, plan.semantic_types.value), "0.50%");
    assert.equal(formatPointValue(25, plan.semantic_types.value), "25.00%");
    const { spec } = assembleFlintChart(plan, "light");
    assert.ok(JSON.stringify(spec).includes("datum.value / 100"));
  }
  assert.equal(formatPointValue(0.005, { semanticType: "Percentage", percentScale: "ratio", decimals: 2 }), "0.50%");
});

test("currency ticks contain one prefix and honor authored decimal places", () => {
  const plan = chart("currency", "line");
  const { spec } = assembleFlintChart(plan, "dark");
  assert.ok(!JSON.stringify(spec).includes("datum.index === 1"));
  assert.equal(formatPointValue(1234.567, { semanticType: "Price", unit: "AUD", decimals: 1 }), "A$1,234.6");
  assert.equal(formatPointValue(1234.567, { semanticType: "Quantity", decimals: 0 }), "1,235");
});

test("percentage metric cards honor comparison choice and number-format overrides", () => {
  const input = { columns: [{ key: "margin", label: "Margin", type: "percent" as const, percentScale: "ratio" as const }], rows: [{ margin: .25 }, { margin: .2 }], valueKey: "margin" };
  assert.equal(computeKpiPresentation(input)?.magnitude, "5.0 pts");
  assert.equal(computeKpiPresentation({ ...input, comparison: "percent_of" })?.magnitude, "125% of prior");
  assert.match(computeKpiPresentation({ ...input, comparison: "absolute" })?.magnitude ?? "", /20% prior/);
  assert.equal(computeKpiPresentation({ ...input, presentation: { format: "number", decimals: 2 } })?.value, "0.25");
});

test("business-date charts preserve calendar dates without mutating governed rows", () => {
  const plan = chart("currency", "line");
  const { spec } = assembleFlintChart(plan, "light");
  const encoding = spec.encoding as { x: { scale: { type: string } } };
  assert.equal(encoding.x.scale.type, "utc");
  const data = spec.data as { values: { day: string }[] };
  assert.equal(data.values[0]?.day, "2026-08-01T00:00:00.000Z");
  assert.equal(plan.data[0]?.day, "2026-08-01");
});

test("explicit horizontal orientation works for stacked bars", () => {
  const plan = compileGroundedFlint({
    caption: "QA", chartType: "bar", stacked: true, orientation: "horizontal",
    xKey: "category", yKey: "sales", series: [{ key: "sales", label: "Sales" }, { key: "cost", label: "Cost" }],
    columns: [{ key: "category", label: "Category", type: "string" }, { key: "sales", label: "Sales", type: "number" }, { key: "cost", label: "Cost", type: "number" }],
    rows: [{ category: "A", sales: 5, cost: 2 }],
  });
  assert.equal(plan.chart_spec.encodings.y?.field, "category");
  assert.equal(plan.chart_spec.encodings.x?.field, "__albert_value");
});
