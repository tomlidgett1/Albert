import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "vega-lite";
import * as vega from "vega";
import { assembleFlintChart, flintThemeTokens } from "../../app/dash/lib/flint-assemble";
import { compileGroundedFlint } from "../../packages/shared/src/flint-grounded";

test("browser-computed theme colors retain their channels and alpha for Flint contrast calculations", () => {
  assert.deepEqual(flintThemeTokens("dark", {
    canvas: "rgb(27, 29, 32)", ink: "rgb(245, 246, 248)", muted: "rgb(168, 171, 180)",
    grid: "rgba(231, 233, 238, 0.09)", palette: ["rgb(184, 227, 90)", "#79c5f2"],
  }), {
    canvas: "#1b1d20", ink: "#f5f6f8", muted: "#a8abb4", grid: "#e7e9ee17",
    palette: ["#b8e35a", "#79c5f2"],
  });
  assert.equal(flintThemeTokens("light").grid, "#23242614");
});

const formats = [
  { type: "currency" as const, value: 1234.5, expected: "A$1,234.50" },
  { type: "percent" as const, percentScale: "percent" as const, value: 0.5, expected: "0.50%" },
  { type: "percent" as const, percentScale: "ratio" as const, value: 0.005, expected: "0.50%" },
];

test("narrow vertical bars reduce crowded value labels and restore them when widened", async () => {
  const plan = compileGroundedFlint({
    caption: "Dense labels", chartType: "bar", orientation: "vertical", xKey: "category", yKey: "revenue",
    columns: [{ key: "category", label: "Category", type: "string" }, { key: "revenue", label: "Revenue", type: "currency" }],
    rows: Array.from({ length: 10 }, (_, i) => ({ category: `Category ${i}`, revenue: 1500 + i * 100 })),
    valueDecimals: { revenue: 2 },
  });
  const original = structuredClone(plan);
  const labels: number[] = [];
  for (const width of [400, 960]) {
    const { spec } = assembleFlintChart(plan, "light", { width, height: 320 });
    const view = new vega.View(vega.parse(compile(spec).spec), { renderer: "none" });
    try {
      const svg = await view.toSVG();
      assert.equal((svg.match(/aria-roledescription="bar"/gu) ?? []).length, 10);
      labels.push((svg.match(/aria-roledescription="text mark"[^>]*>[^<]+<\/text>/gu) ?? []).length);
    } finally { view.finalize(); }
  }
  assert.ok(labels[0]! > 0 && labels[0]! < labels[1]!, "Narrow charts need fewer labels");
  assert.equal(labels[1], 10);
  assert.deepEqual(plan, original);
});

for (const appearance of ["light", "dark"] as const) {
  for (const orientation of ["horizontal", "vertical"] as const) {
    for (const format of formats) {
      test(`${appearance} ${orientation} bar labels render ${format.type} ${"percentScale" in format ? format.percentScale : "AUD"} with authored precision`, async () => {
        const plan = compileGroundedFlint({
          caption: "Formatting QA", chartType: "bar", orientation,
          xKey: "sales.category", yKey: "sales.value",
          columns: [
            { key: "sales.category", label: "Category", type: "string" },
            { key: "sales.value", label: "Value", type: format.type, currency: "AUD", ...("percentScale" in format ? { percentScale: format.percentScale } : {}) },
          ],
          rows: [{ "sales.category": "A", "sales.value": format.value }, { "sales.category": "B", "sales.value": 0 }],
          valueDecimals: { "sales.value": 2 },
        });
        const original = structuredClone(plan);
        const { spec } = assembleFlintChart(plan, appearance, { width: 900, height: 420 });
        const view = new vega.View(vega.parse(compile(spec).spec), { renderer: "none" });
        try {
          const svg = await view.toSVG();
          assert.ok(svg.includes(`>${format.expected}</text>`), `Missing visible ${format.expected} label`);
          assert.doesNotMatch(svg, />NaN<|>undefined</u);
          assert.deepEqual(plan, original, "Presentation must not mutate the governed values");
        } finally {
          view.finalize();
        }
      });
    }
    for (const stacked of [false, true]) {
      for (const width of [240, 960]) {
        test(`${appearance} ${orientation} ${stacked ? "stacked" : "grouped"} chart compiles at ${width}px with all series and signed values`, async () => {
          const plan = compileGroundedFlint({
            caption: "Series QA", chartType: "bar", orientation, stacked,
            xKey: "category", yKey: "sales",
            series: [{ key: "sales", label: "Sales" }, { key: "profit", label: "Profit" }],
            columns: [{ key: "category", label: "Category", type: "string" }, { key: "sales", label: "Sales", type: "currency" }, { key: "profit", label: "Profit", type: "currency" }],
            rows: [{ category: "A long category name", sales: 25, profit: -2 }, { category: "B", sales: 0, profit: 4 }],
          });
          const { spec } = assembleFlintChart(plan, appearance, { width, height: 320 });
          const view = new vega.View(vega.parse(compile(spec).spec), { renderer: "none" });
          try {
            const svg = await view.toSVG();
            assert.equal((svg.match(/aria-roledescription="bar"/gu) ?? []).length, 4);
            assert.match(svg, /Series: Profit/u);
            assert.match(svg, /Series: Sales/u);
            assert.match(svg, /[−-]2/u);
            assert.doesNotMatch(svg, />NaN<|>undefined</u);
          } finally {
            view.finalize();
          }
        });
      }
    }
  }
}
