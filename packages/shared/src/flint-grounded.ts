/**
 * Grounded Flint compile target. Worker-safe: no flint-chart or Vega imports.
 *
 * The visualiser still calls make_chart. Trusted code here turns a validated
 * chart event plus its governed table into a Flint ChartAssemblyInput. The
 * browser assembles and draws. The model never writes Vega-Lite and never
 * invents plot rows.
 */
import type { TraceCell, TraceChartEvent, TraceTableColumn, TraceTableEvent } from "./agent-runtime.js";

export const GROUNDED_FLINT_CHART_TYPES = [
  "Line Chart",
  "Bar Chart",
  "Grouped Bar Chart",
  "Stacked Bar Chart",
] as const;

export type GroundedFlintChartType = (typeof GROUNDED_FLINT_CHART_TYPES)[number];

export const ALBERT_SERIES_FIELD = "__albert_series";
export const ALBERT_VALUE_FIELD = "__albert_value";

export type GroundedFlintSemantic =
  | "DateTime"
  | "Date"
  | "YearMonth"
  | "Amount"
  | "Price"
  | "Quantity"
  | "Count"
  | "Percentage"
  | "Category"
  | "Name";

export type GroundedFlintAnnotation = Readonly<{
  semanticType: GroundedFlintSemantic;
  unit?: string;
}>;

export type GroundedFlintEncoding = Readonly<{
  field: string;
  sortBy?: string;
  sortOrder?: "ascending" | "descending";
}>;

export type GroundedFlintSpec = Readonly<{
  semantic_types: Readonly<Record<string, GroundedFlintSemantic | GroundedFlintAnnotation>>;
  field_display_names: Readonly<Record<string, string>>;
  chart_spec: Readonly<{
    chartType: GroundedFlintChartType;
    title: string;
    subtitle: string;
    encodings: Readonly<Record<string, GroundedFlintEncoding>>;
  }>;
}>;

export type GroundedFlintPlan = Readonly<{
  rationale: string;
  semantic_types: GroundedFlintSpec["semantic_types"];
  field_display_names: GroundedFlintSpec["field_display_names"];
  chart_spec: GroundedFlintSpec["chart_spec"];
  data: readonly Readonly<Record<string, unknown>>[];
}>;

export type GroundedFlintCompileInput = Readonly<{
  caption: string;
  chartType: "bar" | "line";
  stacked?: boolean;
  orientation?: "vertical" | "horizontal";
  xKey: string;
  yKey: string;
  series?: readonly Readonly<{ key: string; label: string }>[];
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  timeRangeLabel?: string;
  timeAxis?: boolean;
  /** Owner-facing measure name. Required when yKey is a pivoted series column. */
  measureLabel?: string;
}>;

function isBlank(value: TraceCell): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function cellValue(value: TraceCell): string | number | null {
  if (value === null || value === undefined) return null;
  return value;
}

function looksLikeTimeKey(column: TraceTableColumn | undefined, key: string, sample: readonly TraceCell[]): boolean {
  const strings = sample.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (strings.length > 0) return strings.every((item) => /^\d{4}-\d{2}/u.test(item));
  if (column && (column.type === "date" || column.type === "datetime")) return true;
  return /\.(?:hour|day|week|month|quarter|year)$/u.test(key);
}

export function semanticFromColumn(
  column: TraceTableColumn | undefined,
  role: "time" | "category" | "measure",
): GroundedFlintSemantic | GroundedFlintAnnotation {
  if (role === "measure") {
    if (column?.type === "percent") return "Percentage";
    if (column?.type === "currency") {
      return { semanticType: "Price", unit: column.currency ?? "AUD" };
    }
    return column?.type === "number" && /count|qty|quantity/iu.test(column.label) ? "Count" : "Quantity";
  }
  if (role === "time") {
    if (column?.type === "datetime") return "DateTime";
    if (column && /\.month$/u.test(column.key)) return "YearMonth";
    return "Date";
  }
  return /name|advisor|staff|customer|service/iu.test(column?.label ?? column?.key ?? "") ? "Name" : "Category";
}

function displayName(column: TraceTableColumn | undefined, key: string): string {
  return column?.label?.trim() || key.split(".").at(-1)?.replaceAll("_", " ") || key;
}

function subtitleFor(
  xLabel: string,
  yLabel: string,
  seriesCount: number,
  timeRangeLabel?: string,
): string {
  const seriesNote = seriesCount > 1 ? `, ${seriesCount} series` : "";
  const range = timeRangeLabel?.trim() ? `, ${timeRangeLabel.trim()}` : "";
  return `${yLabel} by ${xLabel}${seriesNote}${range}.`;
}

export function resolveGroundedFlintChartType(input: GroundedFlintCompileInput): GroundedFlintChartType {
  if (input.chartType === "line") return "Line Chart";
  const seriesCount = input.series?.length ?? 1;
  if (seriesCount > 1) return input.stacked ? "Stacked Bar Chart" : "Grouped Bar Chart";
  return "Bar Chart";
}

export function shouldDrawHorizontalBars(input: GroundedFlintCompileInput): boolean {
  if (input.chartType === "line" || input.stacked) return false;
  if (input.orientation === "horizontal") return true;
  if (input.orientation === "vertical") return false;
  if (input.timeAxis) return false;
  const longest = input.rows.reduce((max, row) => {
    const label = String(row[input.xKey] ?? "");
    return Math.max(max, label.length);
  }, 0);
  return input.rows.length >= 8 || longest > 14;
}

function unpivotRows(
  input: GroundedFlintCompileInput,
  series: readonly Readonly<{ key: string; label: string }>[],
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const row of input.rows) {
    const x = cellValue(row[input.xKey] ?? null);
    if (x === null || x === "") continue;
    for (const item of series) {
      const value = cellValue(row[item.key] ?? null);
      if (value === null) continue;
      rows.push({
        [input.xKey]: x,
        [ALBERT_SERIES_FIELD]: item.label,
        [ALBERT_VALUE_FIELD]: value,
      });
    }
  }
  return rows;
}

export function compileGroundedFlint(input: GroundedFlintCompileInput): GroundedFlintPlan {
  const xColumn = input.columns.find((column) => column.key === input.xKey);
  const yColumn = input.columns.find((column) => column.key === input.yKey);
  const series = input.series?.length
    ? input.series
    : [{ key: input.yKey, label: displayName(yColumn, input.yKey) }];
  const multi = series.length > 1;
  const timeAxis = input.timeAxis ?? looksLikeTimeKey(
    xColumn,
    input.xKey,
    input.rows.slice(0, 5).map((row) => row[input.xKey] ?? null),
  );
  const chartType = resolveGroundedFlintChartType(input);
  const horizontal = shouldDrawHorizontalBars({ ...input, timeAxis });
  const xLabel = displayName(xColumn, input.xKey);
  const yLabel = input.measureLabel?.trim() || displayName(yColumn, input.yKey);
  const xRole = timeAxis ? "time" : "category";
  const measureColumn = yColumn ?? input.columns.find((column) => column.key === series[0]!.key);

  const semantic_types: Record<string, GroundedFlintSemantic | GroundedFlintAnnotation> = {
    [input.xKey]: semanticFromColumn(xColumn, xRole),
  };
  const field_display_names: Record<string, string> = {
    [input.xKey]: xLabel,
  };

  let encodings: Record<string, GroundedFlintEncoding>;
  let data: Array<Record<string, unknown>>;

  if (multi) {
    semantic_types[ALBERT_SERIES_FIELD] = "Category";
    semantic_types[ALBERT_VALUE_FIELD] = semanticFromColumn(measureColumn, "measure");
    field_display_names[ALBERT_SERIES_FIELD] = "Series";
    field_display_names[ALBERT_VALUE_FIELD] = yLabel;
    data = unpivotRows(input, series);
    if (chartType === "Line Chart") {
      encodings = {
        x: { field: input.xKey },
        y: { field: ALBERT_VALUE_FIELD },
        color: { field: ALBERT_SERIES_FIELD },
      };
    } else if (chartType === "Stacked Bar Chart") {
      encodings = horizontal
        ? {
          y: { field: input.xKey },
          x: { field: ALBERT_VALUE_FIELD },
          color: { field: ALBERT_SERIES_FIELD },
        }
        : {
          x: { field: input.xKey },
          y: { field: ALBERT_VALUE_FIELD },
          color: { field: ALBERT_SERIES_FIELD },
        };
    } else {
      encodings = horizontal
        ? {
          y: { field: input.xKey },
          x: { field: ALBERT_VALUE_FIELD },
          group: { field: ALBERT_SERIES_FIELD },
        }
        : {
          x: { field: input.xKey },
          y: { field: ALBERT_VALUE_FIELD },
          group: { field: ALBERT_SERIES_FIELD },
        };
    }
  } else {
    semantic_types[input.yKey] = semanticFromColumn(yColumn, "measure");
    field_display_names[input.yKey] = yLabel;
    data = input.rows.flatMap((row) => {
      const x = cellValue(row[input.xKey] ?? null);
      const y = cellValue(row[input.yKey] ?? null);
      if (x === null || x === "" || y === null) return [];
      return [{ [input.xKey]: x, [input.yKey]: y }];
    });
    if (chartType === "Line Chart") {
      encodings = { x: { field: input.xKey }, y: { field: input.yKey } };
    } else if (horizontal) {
      encodings = {
        y: { field: input.xKey },
        x: { field: input.yKey },
      };
    } else {
      encodings = { x: { field: input.xKey }, y: { field: input.yKey } };
    }
  }

  const title = input.caption.trim().slice(0, 160);
  return {
    rationale: title,
    semantic_types,
    field_display_names,
    chart_spec: {
      chartType,
      title,
      subtitle: subtitleFor(xLabel, yLabel, series.length, input.timeRangeLabel),
      encodings,
    },
    data,
  };
}

export function compileInputFromChartEvent(
  event: Pick<TraceChartEvent, "caption" | "chartType" | "xKey" | "yKey" | "series" | "orientation" | "stacked">,
  table: Pick<TraceTableEvent, "columns" | "rows" | "provenance">,
): GroundedFlintCompileInput {
  const xColumn = table.columns.find((column) => column.key === event.xKey);
  return {
    caption: event.caption,
    chartType: event.chartType,
    stacked: event.stacked,
    orientation: event.orientation,
    xKey: event.xKey,
    yKey: event.yKey,
    series: event.series,
    columns: table.columns,
    rows: table.rows,
    timeRangeLabel: table.provenance.timeRange.label,
    timeAxis: looksLikeTimeKey(xColumn, event.xKey, table.rows.slice(0, 5).map((row) => row[event.xKey] ?? null)),
  };
}

export function groundedFlintPlanForChart(
  event: Pick<TraceChartEvent, "caption" | "chartType" | "xKey" | "yKey" | "series" | "orientation" | "stacked" | "flint">,
  table: Pick<TraceTableEvent, "columns" | "rows" | "provenance">,
): GroundedFlintPlan {
  const compiled = compileGroundedFlint(compileInputFromChartEvent(event, table));
  if (!event.flint) return compiled;
  return {
    ...compiled,
    rationale: event.flint.chart_spec.title,
    semantic_types: event.flint.semantic_types,
    field_display_names: event.flint.field_display_names,
    chart_spec: event.flint.chart_spec,
  };
}

export function isGroundedFlintSpec(value: unknown): value is GroundedFlintSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as Partial<GroundedFlintSpec>;
  const chartType = spec.chart_spec?.chartType;
  return Boolean(
    spec.semantic_types
    && spec.field_display_names
    && spec.chart_spec
    && chartType
    && (GROUNDED_FLINT_CHART_TYPES as readonly string[]).includes(chartType),
  );
}
