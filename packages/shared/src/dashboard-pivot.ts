import { z } from "zod";
import Decimal from "decimal.js";
const PivotDecimal = Decimal.clone({ precision: 80 });

/** Presentation over an element's governed result. Never a query or a formula. */
export const PIVOT_VALUES = "__values__";
export const PIVOT_PERIOD = "__period__";
const fieldKey = z.string().min(1).max(160);
export const pivotAggregateSchema = z.enum([
  "none",
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "count_distinct",
]);
export type PivotAggregate = z.infer<typeof pivotAggregateSchema>;
export const PIVOT_AGGREGATE_LABELS: Readonly<Record<PivotAggregate, string>> =
  {
    none: "No aggregation",
    sum: "Sum",
    avg: "Average",
    min: "Min",
    max: "Max",
    count: "Count",
    count_distinct: "Count distinct",
  };
export const pivotValueSchema = z
  .object({
    column: fieldKey,
    aggregate: pivotAggregateSchema,
    label: z.string().trim().min(1).max(160).optional(),
    format: z
      .enum(["number", "currency", "percent", "text", "date", "datetime"])
      .optional(),
    decimals: z.number().int().min(0).max(6).optional(),
  })
  .strict();
export const dashboardPivotSchema = z
  .object({
    source: z.enum(["result", "composed"]),
    rows: z.array(fieldKey).max(5),
    columns: z.array(fieldKey).max(5),
    values: z.array(pivotValueSchema).max(12),
    rowLayout: z.enum(["single", "separate"]).optional(),
    rowTotals: z.boolean().optional(),
    columnTotals: z.boolean().optional(),
    rowSubtotals: z.boolean().optional(),
    repeatRowLabels: z.boolean().optional(),
    showRowHeaders: z.boolean().optional(),
    showColumnHeaders: z.boolean().optional(),
    emptyValue: z.string().max(40).optional(),
    sort: z
      .array(
        z
          .object({ column: fieldKey, direction: z.enum(["asc", "desc"]) })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const axes = [...config.rows, ...config.columns];
    if (new Set(axes).size !== axes.length)
      ctx.addIssue({
        code: "custom",
        message: "A field can occupy only one pivot axis.",
      });
    if (
      new Set(config.values.map((v) => v.column)).size !== config.values.length
    )
      ctx.addIssue({
        code: "custom",
        message: "A value can appear only once.",
      });
    if (config.values.some((v) => v.column === PIVOT_VALUES))
      ctx.addIssue({
        code: "custom",
        message: "Values is a layout field, not a measure.",
      });
  });
export type DashboardPivot = z.infer<typeof dashboardPivotSchema>;
export type PivotValue = z.infer<typeof pivotValueSchema>;

export const dashboardTableStyleSchema = z
  .object({
    preset: z.enum(["spreadsheet", "presentation"]).optional(),
    rowHeight: z.enum(["small", "medium", "large"]).optional(),
    rowNumbers: z.boolean().optional(),
    bandedRows: z.boolean().optional(),
    verticalGrid: z.boolean().optional(),
  })
  .strict();
export type DashboardTableStyle = z.infer<typeof dashboardTableStyleSchema>;

export type PivotField = Readonly<{
  key: string;
  label: string;
  type: "string" | "number" | "currency" | "percent" | "date" | "datetime";
  currency?: string;
  percentScale?: "ratio" | "percent";
}>;
export type PivotSource = Readonly<{
  fields: readonly PivotField[];
  rows: readonly Readonly<Record<string, unknown>>[];
  totalRowCount: number;
  composed: boolean;
}>;
export type PivotAxisEntry = Readonly<{
  id: string;
  path: readonly unknown[];
  depth: number;
  label: string;
  parent: boolean;
  total: boolean;
  valueKey?: string;
}>;
export type PivotCell = Readonly<{
  value: unknown;
  field: PivotField | null;
  valueConfig: PivotValue | null;
  ambiguous: boolean;
}>;
export type PivotModel = Readonly<{
  rowAxis: readonly string[];
  columnAxis: readonly string[];
  rows: readonly PivotAxisEntry[];
  columns: readonly PivotAxisEntry[];
  cell: (row: PivotAxisEntry, column: PivotAxisEntry) => PivotCell;
  partial: boolean;
  missingFields: readonly string[];
}>;

export function isNumericPivotField(field: PivotField): boolean {
  return ["number", "currency", "percent"].includes(field.type);
}

export function defaultPivot(source: PivotSource): DashboardPivot {
  const dimensions = source.fields.filter(
    (field) => !isNumericPivotField(field),
  );
  const measures = source.fields.filter(isNumericPivotField);
  return source.composed
    ? {
        source: "composed",
        rows: [PIVOT_VALUES],
        columns: [PIVOT_PERIOD],
        values: measures
          .slice(0, 12)
          .map((field) => ({ column: field.key, aggregate: "none" })),
        rowTotals: false,
        columnTotals: false,
      }
    : {
        source: "result",
        rows: dimensions.slice(0, 1).map((field) => field.key),
        columns: [
          ...dimensions.slice(1, 2).map((field) => field.key),
          PIVOT_VALUES,
        ],
        // Query measures already carry their governed aggregation. Do not silently
        // sum rates, distinct counts, or balances when a grouping is removed.
        values: measures
          .slice(0, 1)
          .map((field) => ({ column: field.key, aggregate: "none" })),
        rowTotals: false,
        columnTotals: false,
      };
}

/** Stable structured keys distinguish null, the text "null", and numeric text. */
function identity(value: unknown): string {
  return JSON.stringify(value ?? null);
}
function pathId(path: readonly unknown[]): string {
  return JSON.stringify(path.map(identity));
}
export function pivotGroupId(
  axis: "row" | "column",
  path: readonly unknown[],
): string {
  return `${axis}:${pathId(path)}`;
}
function displayLabel(value: unknown): string {
  return value == null ? "(Null)" : String(value);
}

export function pivotValueLabel(
  value: PivotValue,
  fields: readonly PivotField[],
): string {
  if (value.label) return value.label;
  const label =
    fields.find((field) => field.key === value.column)?.label ?? value.column;
  return value.aggregate === "none"
    ? label
    : `${PIVOT_AGGREGATE_LABELS[value.aggregate]} of ${label}`;
}

function aggregate(
  values: readonly unknown[],
  operation: PivotAggregate,
): { value: unknown; ambiguous: boolean } {
  const present = values.filter(
    (value) => value !== null && value !== undefined,
  );
  if (operation === "count") return { value: present.length, ambiguous: false };
  if (operation === "count_distinct")
    return { value: new Set(present.map(identity)).size, ambiguous: false };
  if (!present.length) return { value: null, ambiguous: false };
  if (operation === "none")
    return {
      value: present.length === 1 ? present[0] : null,
      ambiguous: present.length > 1,
    };
  // Decimal source strings must not round through IEEE-754: Cube can return
  // currency and large integers beyond Number's exact range.
  try {
    const numbers = present.map((value) => {
      if (
        (typeof value !== "number" && typeof value !== "string") ||
        !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(String(value).trim())
      )
        throw new Error("Non-numeric value");
      return new PivotDecimal(value);
    });
    if (numbers.some((number) => !number.isFinite()))
      return { value: null, ambiguous: true };
    const result =
      operation === "min"
        ? PivotDecimal.min(...numbers)
        : operation === "max"
          ? PivotDecimal.max(...numbers)
          : numbers
              .reduce((sum, number) => sum.plus(number), new PivotDecimal(0))
              .div(operation === "avg" ? numbers.length : 1);
    return {
      value: result.isFinite() ? result.toString() : null,
      ambiguous: !result.isFinite(),
    };
  } catch {
    return { value: null, ambiguous: true };
  }
}

/** Recompute totals from contributing source rows, never by summing averages. */
export function buildPivotModel(
  source: PivotSource,
  config: DashboardPivot,
  collapsed: ReadonlySet<string> = new Set(),
): PivotModel {
  const fields = new Map(source.fields.map((field) => [field.key, field]));
  const missingFields = [
    ...new Set([
      ...config.rows,
      ...config.columns,
      ...config.values.map((value) => value.column),
    ]),
  ].filter((key) => key !== PIVOT_VALUES && !fields.has(key));
  const values = config.values.filter((value) => fields.has(value.column));
  const rowAxis = config.rows.filter(
    (key) => key === PIVOT_VALUES || fields.has(key),
  );
  const columnAxis = config.columns.filter(
    (key) => key === PIVOT_VALUES || fields.has(key),
  );
  if (!rowAxis.includes(PIVOT_VALUES) && !columnAxis.includes(PIVOT_VALUES))
    columnAxis.push(PIVOT_VALUES);
  const label = (key: string, value: unknown) => {
    if (key !== PIVOT_VALUES) return displayLabel(value);
    const metric = values.find((candidate) => candidate.column === value);
    return metric ? pivotValueLabel(metric, source.fields) : "Values";
  };
  const axisEntries = (
    axis: readonly string[],
    name: "row" | "column",
    totals: boolean,
  ): PivotAxisEntry[] => {
    const output: PivotAxisEntry[] = [];
    const paths = source.rows.flatMap((row) =>
      (values.length ? values : [null]).map((value) =>
        axis.map((key) =>
          key === PIVOT_VALUES ? (value?.column ?? "") : (row[key] ?? null),
        ),
      ),
    );
    const unique = [
      ...new Map(paths.map((path) => [pathId(path), path])).values(),
    ];
    const visit = (
      paths: readonly unknown[][],
      depth: number,
      prefix: readonly unknown[],
    ) => {
      if (depth === axis.length) {
        output.push({
          id: `${name}:${pathId(prefix)}`,
          path: prefix,
          depth: Math.max(0, depth - 1),
          label: depth ? label(axis[depth - 1]!, prefix[depth - 1]) : "Values",
          parent: false,
          total: false,
        });
        return;
      }
      const grouped = new Map<string, { value: unknown; paths: unknown[][] }>();
      for (const path of paths) {
        const key = identity(path[depth]);
        const group = grouped.get(key) ?? { value: path[depth], paths: [] };
        group.paths.push(path);
        grouped.set(key, group);
      }
      const groups = [...grouped.values()];
      const sort = config.sort?.find((sort) => sort.column === axis[depth]);
      if (sort)
        groups.sort((a, b) => {
          const order =
            typeof a.value === "number" && typeof b.value === "number"
              ? a.value - b.value
              : displayLabel(a.value).localeCompare(
                  displayLabel(b.value),
                  "en",
                  { numeric: true },
                );
          return sort.direction === "asc" ? order : -order;
        });
      for (const group of groups) {
        const path = [...prefix, group.value];
        const parent = depth < axis.length - 1;
        const id = `${name}:${pathId(path)}`;
        const closed = collapsed.has(id);
        if (parent && (name === "row" || closed))
          output.push({
            id,
            path,
            depth,
            label: label(axis[depth]!, group.value),
            parent: true,
            total: false,
          });
        if (!closed || !parent) visit(group.paths, depth + 1, path);
      }
    };
    if (unique.length) visit(unique, 0, []);
    if (totals && axis.some((key) => key !== PIVOT_VALUES)) {
      const totalLabel =
        source.totalRowCount > source.rows.length
          ? "Total (loaded rows)"
          : "Grand total";
      if (axis.includes(PIVOT_VALUES) && values.length > 1) {
        for (const value of values)
          output.push({
            id: `${name}:grand-total:${value.column}`,
            path: [],
            depth: 0,
            label: `${totalLabel} · ${pivotValueLabel(value, source.fields)}`,
            parent: false,
            total: true,
            valueKey: value.column,
          });
      } else
        output.push({
          id: `${name}:grand-total`,
          path: [],
          depth: 0,
          label: totalLabel,
          parent: false,
          total: true,
        });
    }
    return output;
  };
  const rows = axisEntries(rowAxis, "row", config.rowTotals === true);
  const columns = axisEntries(
    columnAxis,
    "column",
    config.columnTotals === true,
  );
  const matches = (
    row: Readonly<Record<string, unknown>>,
    axis: readonly string[],
    entry: PivotAxisEntry,
  ) =>
    entry.path.every(
      (value, index) =>
        axis[index] === PIVOT_VALUES ||
        identity(row[axis[index]!]) === identity(value),
    );
  const cell = (row: PivotAxisEntry, column: PivotAxisEntry): PivotCell => {
    const rowValue = row.path[rowAxis.indexOf(PIVOT_VALUES)];
    const colValue = column.path[columnAxis.indexOf(PIVOT_VALUES)];
    const value =
      values.find(
        (candidate) =>
          candidate.column ===
          (row.valueKey ?? column.valueKey ?? rowValue ?? colValue),
      ) ?? (values.length === 1 ? values[0] : undefined);
    // A total spanning several measures has no unit or meaningful arithmetic.
    if (
      !value ||
      (row.parent &&
        (config.rowSubtotals === false || value.aggregate === "none")) ||
      (column.parent && value.aggregate === "none")
    )
      return { value: null, field: null, valueConfig: null, ambiguous: false };
    const field = fields.get(value.column)!;
    const contributing = source.rows.filter(
      (sourceRow) =>
        matches(sourceRow, rowAxis, row) &&
        matches(sourceRow, columnAxis, column),
    );
    const result = aggregate(
      contributing.map((sourceRow) => sourceRow[value.column]),
      value.aggregate,
    );
    return {
      ...result,
      field:
        value.aggregate === "count" || value.aggregate === "count_distinct"
          ? {
              ...field,
              type: "number",
              currency: undefined,
              percentScale: undefined,
            }
          : field,
      valueConfig: value,
    };
  };
  return {
    rowAxis,
    columnAxis,
    rows,
    columns,
    cell,
    partial: source.totalRowCount > source.rows.length,
    missingFields,
  };
}
