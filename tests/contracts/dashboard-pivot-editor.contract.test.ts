import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPivotModel,
  dashboardPivotSchema,
  defaultPivot,
  PIVOT_VALUES,
  pivotGroupId,
  type DashboardPivot,
  type PivotSource,
} from "../../packages/shared/src/dashboard-pivot";
import { composedPivotSource } from "../../app/dash/lib/dashboard-pivot-view";
import { dashboardTileDisplaySchema } from "../../services/control-plane/src/dashboard-repository";

const source: PivotSource = {
  fields: [
    { key: "region", label: "Region", type: "string" },
    { key: "product", label: "Product", type: "string" },
    { key: "sales", label: "Sales", type: "currency", currency: "AUD" },
    { key: "orders", label: "Orders", type: "number" },
  ],
  rows: [
    { region: "East", product: "Bikes", sales: "10.10", orders: 1 },
    { region: "East", product: "Bikes", sales: "20.20", orders: 2 },
    { region: "West", product: "Bikes", sales: "90.90", orders: 3 },
    { region: "East", product: "Parts", sales: 0, orders: 0 },
    { region: "West", product: "Parts", sales: null, orders: null },
  ],
  totalRowCount: 5,
  composed: false,
};
const config: DashboardPivot = {
  source: "result",
  rows: ["product"],
  columns: ["region", PIVOT_VALUES],
  values: [{ column: "sales", aggregate: "sum" }],
  rowTotals: true,
  columnTotals: true,
};
const cell = (
  model: ReturnType<typeof buildPivotModel>,
  row: string,
  column: string,
) =>
  model.cell(
    model.rows.find((entry) => entry.label === row)!,
    model.columns.find(
      (entry) => entry.path[0] === column || entry.label === column,
    )!,
  );

test("pivot sums exact source decimals, preserves zero and leaves missing intersections empty", () => {
  const model = buildPivotModel(source, config);
  assert.equal(cell(model, "Bikes", "East").value, "30.3");
  assert.equal(cell(model, "Parts", "East").value, "0");
  assert.equal(cell(model, "Parts", "West").value, null);
  assert.equal(cell(model, "Grand total", "Grand total").value, "121.2");
  const large = buildPivotModel(
    {
      ...source,
      rows: [
        { region: "East", product: "Bikes", sales: "9007199254740993.01" },
        { region: "East", product: "Bikes", sales: "0.02" },
      ],
    },
    config,
  );
  assert.equal(cell(large, "Bikes", "East").value, "9007199254740993.03");
});

test("average totals use contributing rows, not averages of the displayed groups", () => {
  const model = buildPivotModel(source, {
    ...config,
    values: [{ column: "sales", aggregate: "avg" }],
  });
  assert.equal(cell(model, "Bikes", "East").value, "15.15");
  assert.equal(cell(model, "Grand total", "Grand total").value, "30.3");
});

test("query measures are never silently reaggregated after removing a grouping", () => {
  assert.equal(defaultPivot(source).values[0]?.aggregate, "none");
  const model = buildPivotModel(source, {
    ...config,
    values: [{ column: "sales", aggregate: "none" }],
  });
  assert.equal(cell(model, "Bikes", "East").ambiguous, true);
  assert.equal(cell(model, "Bikes", "East").value, null);
  assert.equal(cell(model, "Bikes", "West").value, "90.90");
});

test("swapping axes transposes the result without mutating its source", () => {
  const before = JSON.stringify(source);
  const original = buildPivotModel(source, config);
  const transposed = buildPivotModel(source, {
    ...config,
    rows: config.columns,
    columns: config.rows,
  });
  const east = transposed.rows.find(
    (entry) => entry.path[0] === "East" && entry.path[1] === "sales",
  )!;
  const bikes = transposed.columns.find((entry) => entry.path[0] === "Bikes")!;
  assert.equal(
    transposed.cell(east, bikes).value,
    cell(original, "Bikes", "East").value,
  );
  assert.equal(JSON.stringify(source), before);
});

test("multiple value totals preserve their measure instead of combining currencies and counts", () => {
  const model = buildPivotModel(source, {
    ...config,
    values: [
      { column: "sales", aggregate: "sum" },
      { column: "orders", aggregate: "sum" },
    ],
  });
  const total = model.rows.find((entry) => entry.total)!;
  const sales = model.columns.find(
    (entry) => entry.total && entry.valueKey === "sales",
  )!;
  const orders = model.columns.find(
    (entry) => entry.total && entry.valueKey === "orders",
  )!;
  assert.equal(model.cell(total, sales).value, "121.2");
  assert.equal(model.cell(total, sales).field?.type, "currency");
  assert.equal(model.cell(total, orders).value, "6");
  assert.equal(model.cell(total, orders).field?.type, "number");
});

test("the composed Omni scorecard preserves each metric's units through every Values position", () => {
  const composed = composedPivotSource(
    {
      columns: [
        { key: "metric", label: "Metric", type: "string" },
        { key: "a", label: "Week 1", type: "number" },
        { key: "b", label: "Week 2", type: "number" },
      ],
      rows: [
        { metric: "Sales", a: "120.50", b: "180.75" },
        { metric: "Margin", a: 0.25, b: 0.3 },
        { metric: "Orders", a: 3, b: 5 },
      ],
    },
    [
      { type: "currency", currency: "AUD" },
      { type: "percent", percentScale: "ratio" },
      { type: "number" },
    ],
  );
  const defaults = defaultPivot(composed);
  for (const [rows, columns] of [
    [defaults.rows, defaults.columns],
    [defaults.columns, defaults.rows],
    [[], [PIVOT_VALUES, ...defaults.columns]],
    [[], [...defaults.columns, PIVOT_VALUES]],
  ] as const) {
    const model = buildPivotModel(composed, {
      ...defaults,
      rows: [...rows],
      columns: [...columns],
    });
    const cells = model.rows.flatMap((row) =>
      model.columns.map((column) => model.cell(row, column)),
    );
    assert.ok(
      cells.some(
        (cell) => cell.value === "120.50" && cell.field?.currency === "AUD",
      ),
    );
    assert.ok(
      cells.some(
        (cell) => cell.value === 0.25 && cell.field?.percentScale === "ratio",
      ),
    );
    assert.ok(
      cells.some((cell) => cell.value === 3 && cell.field?.type === "number"),
    );
  }
});

test("row hierarchy collapse, explicit order, and incomplete sources retain honest scope", () => {
  const hierarchy = {
    ...config,
    rows: ["region", "product"],
    columns: [PIVOT_VALUES],
  };
  const model = buildPivotModel(
    source,
    hierarchy,
    new Set([pivotGroupId("row", ["East"])]),
  );
  assert.equal(
    model.rows.filter((entry) => entry.path[0] === "East").length,
    1,
  );
  assert.ok(
    model.rows.some(
      (entry) => entry.path[0] === "West" && entry.path[1] === "Parts",
    ),
  );
  const sorted = buildPivotModel(source, {
    ...config,
    sort: [{ column: "product", direction: "desc" }],
  });
  assert.equal(sorted.rows[0]?.label, "Parts");
  const partial = buildPivotModel({ ...source, totalRowCount: 100 }, config);
  assert.equal(partial.partial, true);
  assert.equal(
    partial.rows.find((row) => row.total)?.label,
    "Total (loaded rows)",
  );
});

test("count distinct separates typed values and count excludes null without treating zero as absent", () => {
  const counts: PivotSource = {
    ...source,
    rows: [{ sales: 0 }, { sales: 0 }, { sales: "0" }, { sales: null }],
  };
  for (const [aggregate, expected] of [
    ["count", 3],
    ["count_distinct", 2],
  ] as const) {
    const model = buildPivotModel(counts, {
      source: "result",
      rows: [],
      columns: [],
      values: [{ column: "sales", aggregate }],
    });
    assert.equal(model.cell(model.rows[0]!, model.columns[0]!).value, expected);
    assert.equal(
      model.cell(model.rows[0]!, model.columns[0]!).field?.type,
      "number",
    );
  }
});

test("an empty pivot is editable and missing fields are identified without substituting data", () => {
  const empty = buildPivotModel(source, {
    source: "result",
    rows: [],
    columns: [],
    values: [],
  });
  assert.equal(empty.cell(empty.rows[0]!, empty.columns[0]!).value, null);
  const missing = buildPivotModel(source, {
    ...config,
    values: [{ column: "missing", aggregate: "sum" }],
  });
  assert.deepEqual(missing.missingFields, ["missing"]);
});

test("persistent pivot settings reject duplicate shelves, invalid aggregates and executable input", () => {
  assert.ok(
    dashboardTileDisplaySchema.safeParse({
      mode: "table",
      pivot: config,
      tableStyle: { rowHeight: "small", verticalGrid: true },
    }).success,
  );
  assert.ok(
    dashboardTileDisplaySchema.safeParse({ mode: "table", pivot: null })
      .success,
  );
  assert.ok(
    !dashboardPivotSchema.safeParse({
      ...config,
      rows: ["region"],
      columns: ["region"],
    }).success,
  );
  assert.ok(
    !dashboardPivotSchema.safeParse({
      ...config,
      values: [{ column: "sales", aggregate: "eval" }],
    }).success,
  );
  assert.ok(
    !dashboardPivotSchema.safeParse({ ...config, sql: "select *" }).success,
  );
  assert.ok(
    !dashboardPivotSchema.safeParse({
      ...config,
      values: Array(13).fill({ column: "sales", aggregate: "sum" }),
    }).success,
  );
});
