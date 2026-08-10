import type { TraceCell, TraceTableColumn } from "../../shared/src/index.js";
import type {
  GovernedResult,
  SemanticToolInputMap,
} from "./semantic-tools.js";

const NUMERIC_COLUMN_TYPES = new Set<TraceTableColumn["type"]>([
  "number",
  "currency",
  "percent",
]);
const TEMPORAL_KEY_PATTERN = /(?:^|_)(?:date|day|week|month|quarter|year|period|time)(?:_|$)/u;
const NUMERIC_SEQUENCE_KEY_PATTERN = /(?:^|_)(?:hour|age|band|sequence|step)(?:_|$)/u;
const IDENTIFIER_KEY_PATTERN = /(?:^|_)(?:id|number|code)(?:_|$)/u;
const ISO_LIKE_TEMPORAL_VALUE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?(?:[T ]\d{2}:\d{2})?/u;

export const MAX_BAR_CHART_POINTS = 40;
export const MAX_LINE_CHART_POINTS = 120;

export class InvalidChartSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChartSpecError";
  }
}

export type ValidatedChartSpec = Readonly<{
  pointCount: number;
  xColumn: TraceTableColumn;
  xKind: "categorical" | "ordered";
  series: readonly Readonly<{
    key: string;
    label: string;
    column: TraceTableColumn;
  }>[];
}>;

function numericValue(value: TraceCell): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isOrderedXColumn(
  column: TraceTableColumn,
  values: readonly TraceCell[],
): boolean {
  if (column.type === "date" || column.type === "datetime") return true;
  if (TEMPORAL_KEY_PATTERN.test(column.key.toLowerCase())) return true;
  if (
    column.type === "number"
    && NUMERIC_SEQUENCE_KEY_PATTERN.test(column.key.toLowerCase())
    && !IDENTIFIER_KEY_PATTERN.test(column.key.toLowerCase())
  ) {
    return true;
  }

  const strings = values.filter((value): value is string => typeof value === "string");
  return strings.length === values.length
    && strings.length > 0
    && strings.every((value) => ISO_LIKE_TEMPORAL_VALUE.test(value.trim()));
}

function orderedValue(value: TraceCell): number | null {
  const numeric = numericValue(value);
  if (numeric !== null) return numeric;
  if (typeof value !== "string") return null;

  const normalized = value.trim();
  const quarter = /^(\d{4})\s*(?:-|\s)?Q([1-4])$/iu.exec(normalized);
  if (quarter) return Number(quarter[1]) * 4 + Number(quarter[2]);
  const week = /^(\d{4})\s*(?:-|\s)?W(\d{1,2})$/iu.exec(normalized);
  if (week) return Number(week[1]) * 53 + Number(week[2]);

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isStrictlyAscending(values: readonly TraceCell[]): boolean {
  const ordered = values.map(orderedValue);
  return ordered.every((value) => value !== null)
    && ordered.every((value, index) => index === 0 || value! > ordered[index - 1]!);
}

function unitSignature(column: TraceTableColumn): string {
  return column.type === "currency"
    ? `${column.type}:${column.currency ?? "unknown"}`
    : column.type;
}

/**
 * Validates a model-selected presentation against the governed result itself.
 * The model may choose whether a chart helps and which of the two supported
 * forms communicates best; trusted code still prevents a visually plausible
 * but semantically invalid chart from entering the public trace.
 */
export function validateChartSpec(
  result: GovernedResult,
  input: SemanticToolInputMap["make_chart"],
): ValidatedChartSpec {
  const columns = new Map(result.columns.map((column) => [column.key, column]));
  const xColumn = columns.get(input.xKey);
  const primaryColumn = columns.get(input.yKey);
  if (!xColumn || !primaryColumn) {
    throw new InvalidChartSpecError(
      "Chart fields must reference columns in the governed result.",
    );
  }
  if (!NUMERIC_COLUMN_TYPES.has(primaryColumn.type)) {
    throw new InvalidChartSpecError("The chart value axis must use a numeric measure.");
  }

  const requestedSeries = input.series?.length
    ? input.series
    : [{ key: input.yKey, label: primaryColumn.label }];
  if (requestedSeries[0]?.key !== input.yKey) {
    throw new InvalidChartSpecError(
      "The primary yKey must be the first plotted series.",
    );
  }

  const seriesKeys = new Set<string>();
  const resolvedSeries = requestedSeries.map((item) => {
    if (seriesKeys.has(item.key)) {
      throw new InvalidChartSpecError(`Chart series ${item.key} is duplicated.`);
    }
    seriesKeys.add(item.key);
    const column = columns.get(item.key);
    if (!column || !NUMERIC_COLUMN_TYPES.has(column.type)) {
      throw new InvalidChartSpecError(
        `Chart series ${item.key} must reference a numeric result column.`,
      );
    }
    return { key: item.key, label: column.label, column };
  });

  const labelCounts = new Map<string, number>();
  for (const item of resolvedSeries) {
    labelCounts.set(item.label, (labelCounts.get(item.label) ?? 0) + 1);
  }
  const series = resolvedSeries.map((item) => ({
    ...item,
    label: labelCounts.get(item.label) === 1
      ? item.label
      : `${item.label} (${item.key})`,
  }));

  const expectedUnit = unitSignature(series[0]!.column);
  if (series.some((item) => unitSignature(item.column) !== expectedUnit)) {
    throw new InvalidChartSpecError(
      "One chart cannot mix measures with different units or currencies.",
    );
  }

  const xValues: TraceCell[] = [];
  const xIdentities = new Set<string>();
  let pointCount = 0;
  for (const row of result.rows) {
    const xValue = row[input.xKey] ?? null;
    if (xValue === null) continue;

    const values = series.map((item) => row[item.key] ?? null);
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (value !== null && numericValue(value) === null) {
        throw new InvalidChartSpecError(
          `Chart series ${series[index]!.key} contains a non-numeric value.`,
        );
      }
    }
    if (!values.some((value) => value !== null)) continue;

    const identity = `${typeof xValue}:${String(xValue)}`;
    if (xIdentities.has(identity)) {
      throw new InvalidChartSpecError(
        "The selected x-axis repeats values. Query one row per x-axis value before charting it.",
      );
    }
    xIdentities.add(identity);
    xValues.push(xValue);
    pointCount += 1;
  }

  const minimumPoints = input.chartType === "line" ? 2 : 1;
  if (pointCount < minimumPoints) {
    throw new InvalidChartSpecError(
      input.chartType === "line"
        ? "A line chart needs at least two governed data points."
        : "A bar chart needs at least one governed category.",
    );
  }

  const xKind = isOrderedXColumn(xColumn, xValues) ? "ordered" : "categorical";
  if (input.chartType === "line" && xKind !== "ordered") {
    throw new InvalidChartSpecError(
      "Line charts require an ordered numeric or time axis. Use a bar chart for category comparisons.",
    );
  }
  if (input.chartType === "line" && !isStrictlyAscending(xValues)) {
    throw new InvalidChartSpecError(
      "Line-chart rows must be ordered from the earliest or lowest x-axis value to the latest or highest.",
    );
  }
  const maxPoints = input.chartType === "line"
    ? MAX_LINE_CHART_POINTS
    : MAX_BAR_CHART_POINTS;
  if (pointCount > maxPoints) {
    throw new InvalidChartSpecError(
      `This ${input.chartType} chart has ${pointCount} points; aggregate it to ${maxPoints} or fewer first.`,
    );
  }

  return Object.freeze({
    pointCount,
    xColumn,
    xKind,
    series: Object.freeze(series.map((item) => Object.freeze(item))),
  });
}
