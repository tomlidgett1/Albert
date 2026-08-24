import { ulid } from "ulid";
import { findUngroundedNumbers } from "../../../services/conversation/src/grounding.js";
import {
  compileGroundedFlint,
  sanitizeTraceText,
  type GroundedFlintSpec,
  type TraceCell,
  type TraceProvenance,
  type TraceTableColumn,
} from "../../shared/src/index.js";
import type { CodexChartToolInput } from "./contracts.js";

const NUMERIC_TYPES = new Set<TraceTableColumn["type"]>(["number", "currency", "percent"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MAX_LINE_POINTS = 60;
const DEFAULT_BAR_POINTS = 12;
const MAX_LINE_SERIES = 4;
const MAX_BAR_SERIES = 8;

export type CodexChartEvidence = Readonly<{
  resultId: string;
  topic: string;
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  provenance: TraceProvenance;
  rowCount: number;
}>;

export type CodexChartState = {
  emitted: number;
  readonly maxCharts: number;
  readonly signatures: Set<string>;
};

export type PreparedCodexChart = Readonly<{
  signature: string;
  notes: readonly string[];
  table: Readonly<{
    caption: string;
    columns: readonly TraceTableColumn[];
    rows: readonly Readonly<Record<string, TraceCell>>[];
    resultId: string;
    provenance: TraceProvenance;
  }>;
  chart: Readonly<{
    caption: string;
    chartType: "bar" | "line";
    dataRef: string;
    xKey: string;
    yKey: string;
    series?: readonly Readonly<{ key: string; label: string }>[];
    orientation?: "vertical" | "horizontal";
    stacked?: boolean;
    flint: GroundedFlintSpec;
  }>;
}>;

export type CodexChartDecision =
  | Readonly<{ ok: true; prepared: PreparedCodexChart }>
  | Readonly<{ ok: false; error: string; guidance: string }>;

function rejected(error: string, guidance: string): CodexChartDecision {
  return { ok: false, error, guidance };
}

function isBlank(value: TraceCell): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function numericValue(value: TraceCell): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[$,%+]/gu, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function columnUnit(column: TraceTableColumn): string {
  return column.type === "currency" ? `currency:${column.currency ?? "unknown"}` : column.type;
}

function looksLikeTimeAxis(
  column: TraceTableColumn,
  key: string,
  rows: readonly Readonly<Record<string, TraceCell>>[],
): boolean {
  if (column.type === "date" || column.type === "datetime") return true;
  if (/\.(?:hour|day|week|month|quarter|year)$/u.test(key)) return true;
  const samples = rows.slice(0, 8).map((row) => row[key]).filter((value): value is string => typeof value === "string");
  return samples.length > 0 && samples.every((value) => /^\d{4}-\d{2}/u.test(value));
}

function chartIntentAllowed(question: string, purpose: CodexChartToolInput["purpose"]): boolean {
  if (/\b(?:chart|graph|plot|visuali[sz]e|visual)\b/iu.test(question)) return true;
  const patterns: Readonly<Record<CodexChartToolInput["purpose"], RegExp>> = {
    trend: /\b(?:trend|over time|changed?|movement|trajectory|season|month(?:ly)?|week(?:ly)?|day(?:ly)?|quarter(?:ly)?|year(?:ly)?|ytd)\b/iu,
    ranking: /\b(?:rank|top|bottom|best|worst|highest|lowest|largest|smallest|leading|concentration)\b/iu,
    comparison: /\b(?:compare|comparison|versus|vs\.?|difference|changed?|year[- ]on[- ]year|prior|previous|before|after)\b/iu,
    composition: /\b(?:mix|share|composition|breakdown|split|proportion|contribution|distribution)\b/iu,
  };
  if (patterns[purpose].test(question)) return true;
  return /\b(?:analyse|analyze|analysis|review|report|health|performance|drivers?|explain|opportunit|investigate)\b/iu.test(question);
}

function seriesLabel(value: TraceCell): string {
  if (isBlank(value)) return "(not set)";
  const text = String(value);
  const range = /^(\d{4})-(\d{2})-(\d{2})[^ ]*\s*-\s*(\d{4})-(\d{2})-(\d{2})/u.exec(text);
  if (range) {
    const [, startYear, startMonth, startDay, endYear, endMonth, endDay] = range;
    const start = `${startDay === "01" ? "" : `${Number(startDay)} `}${MONTHS[Number(startMonth) - 1]} ${startYear}`;
    const end = `${Number(endDay) < 28 ? `${Number(endDay)} ` : ""}${MONTHS[Number(endMonth) - 1]} ${endYear}`;
    return `${start} – ${end}`;
  }
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(text)) {
    const words = text.replaceAll("_", " ");
    return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
  }
  return text.slice(0, 120);
}

function overlayTimeBucket(value: TraceCell): Readonly<{ label: string; order: number }> | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/u.exec(value);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3] ?? "1");
  const monthLabel = MONTHS[month - 1];
  if (!monthLabel) return null;
  return {
    label: day === 1 ? monthLabel : `${day} ${monthLabel}`,
    order: month * 32 + day,
  };
}

function derivedProvenance(source: CodexChartEvidence, detail: string): TraceProvenance {
  const rest = { ...source.provenance };
  delete rest.calculations;
  return {
    ...rest,
    definitions: [
      ...source.provenance.definitions.slice(0, 20),
      {
        metric: "albert.chart_transform",
        label: "Chart data",
        definition: sanitizeTraceText(detail, 400),
      },
    ],
  };
}

function uniqueColumnKeys(columns: readonly TraceTableColumn[]): boolean {
  return new Set(columns.map((column) => column.key)).size === columns.length;
}

export function prepareCodexChart(input: Readonly<{
  question: string;
  request: CodexChartToolInput;
  source: CodexChartEvidence;
  state: CodexChartState;
}>): CodexChartDecision {
  const { request, source, state } = input;
  if (state.emitted >= state.maxCharts) {
    return rejected("chart_limit", "Two charts are already attached. Finish the answer without another chart.");
  }
  if (!chartIntentAllowed(input.question, request.purpose)) {
    return rejected(
      "chart_not_useful_for_question",
      "This question does not ask for or materially benefit from a trend, ranking, comparison, or composition chart. Use prose or a table.",
    );
  }
  if (source.rowCount < 2 || source.rows.length < 2) {
    return rejected(
      "too_few_points",
      "A chart needs at least two governed points. State a scalar in prose instead.",
    );
  }
  const registry = new Map(source.columns.map((column) => [column.key, column]));
  const keys = [request.xKey, request.yKey, ...(request.extraYKeys ?? []), ...(request.seriesKey ? [request.seriesKey] : [])];
  const missing = keys.filter((key) => !registry.has(key));
  if (missing.length > 0) {
    return rejected("unknown_column", `Use only exact column keys returned with the result. Unknown: ${missing.join(", ")}.`);
  }
  const xColumn = registry.get(request.xKey)!;
  const yColumn = registry.get(request.yKey)!;
  if (NUMERIC_TYPES.has(xColumn.type)) {
    return rejected("numeric_x_axis", "The x axis must be a time bucket or labelled dimension, not a measure.");
  }
  if (!NUMERIC_TYPES.has(yColumn.type)) {
    return rejected("non_numeric_y_axis", "The y axis must be a numeric, currency, or percentage column.");
  }
  if (request.seriesKey && request.extraYKeys?.length) {
    return rejected("ambiguous_series", "Use either seriesKey or extraYKeys, not both.");
  }
  const extraColumns = (request.extraYKeys ?? []).map((key) => registry.get(key)!);
  if (extraColumns.some((column) => !NUMERIC_TYPES.has(column.type))) {
    return rejected("non_numeric_series", "Every additional y series must be numeric.");
  }
  if (extraColumns.some((column) => columnUnit(column) !== columnUnit(yColumn))) {
    return rejected("mixed_units", "Currency, percentage, and count measures cannot share one chart axis.");
  }
  const seriesColumn = request.seriesKey ? registry.get(request.seriesKey)! : undefined;
  if (seriesColumn && NUMERIC_TYPES.has(seriesColumn.type)) {
    return rejected("numeric_series_dimension", "seriesKey must be a labelled dimension, not a measure.");
  }
  const caption = sanitizeTraceText(request.caption, 160);
  if (!caption) {
    return rejected("ungrounded_caption", "Provide a short owner-facing caption naming the claim the chart supports.");
  }

  const sourceTimeAxis = looksLikeTimeAxis(xColumn, request.xKey, source.rows);
  let resolved: "bar" | "line" | "stacked_bar";
  if (request.chartType === "auto") {
    resolved = request.purpose === "composition" && seriesColumn
      ? "stacked_bar"
      : sourceTimeAxis && (request.purpose === "trend" || request.purpose === "comparison")
        ? "line"
        : "bar";
  } else {
    resolved = request.chartType;
  }
  const notes: string[] = [];
  if (request.purpose === "ranking" && resolved === "line") {
    resolved = "bar";
    notes.push("A categorical ranking was rendered as bars rather than a line.");
  }
  if (resolved === "line" && !sourceTimeAxis) {
    return rejected("line_requires_time", "Lines require an ordered time axis. Use ranked bars for categories.");
  }
  if (request.purpose === "trend" && !sourceTimeAxis) {
    return rejected("trend_requires_time", "A trend chart requires a governed time bucket in the result.");
  }
  if (resolved === "stacked_bar" && !seriesColumn) {
    return rejected("stack_requires_series", "A stacked bar requires seriesKey to define the composition.");
  }
  if (resolved === "stacked_bar" && request.purpose !== "composition") {
    return rejected("stack_requires_composition", "Stacked bars are reserved for composition or mix, not ordinary rankings.");
  }
  if (request.transform === "cumulative") {
    if (seriesColumn) {
      return rejected("cumulative_with_series", "A running total supports one measure (plus same-unit extraYKeys); drop seriesKey or chart the plain series.");
    }
    if (!sourceTimeAxis) {
      return rejected("cumulative_requires_time", "A running total needs a governed time bucket on the x axis.");
    }
    if (resolved !== "line") {
      resolved = "line";
      notes.push("A running total is drawn as a line accumulated in date order.");
    }
  }

  let columns: TraceTableColumn[];
  let rows: Array<Record<string, TraceCell>>;
  let series: Array<{ key: string; label: string }> | undefined;
  const chartXKey = request.xKey;
  let chartYKey = request.yKey;
  let timeAxis = sourceTimeAxis;

  if (seriesColumn) {
    const triples = source.rows.flatMap((row) => {
      const x = row[request.xKey] ?? null;
      const rawSeries = row[request.seriesKey!] ?? null;
      const y = numericValue(row[request.yKey] ?? null);
      return isBlank(x) || isBlank(rawSeries) || y === null ? [] : [{ x, rawSeries, y }];
    });
    const rawSeriesValues = [...new Map(triples.map((item) => [String(item.rawSeries), item.rawSeries])).values()];
    const maxSeries = resolved === "line" ? MAX_LINE_SERIES : MAX_BAR_SERIES;
    if (rawSeriesValues.length < 2) {
      return rejected("single_series", "The selected series dimension has fewer than two populated values. Omit seriesKey.");
    }
    if (rawSeriesValues.length > maxSeries) {
      return rejected(
        "too_many_series",
        `This would draw ${rawSeriesValues.length} series; the safe maximum is ${maxSeries}. Query or filter to the material series first.`,
      );
    }
    const periodSeries = /(?:^|\.)(?:compare_date_range|compareDateRange)$/u.test(request.seriesKey!);
    const seriesEntries = rawSeriesValues.map((rawSeries, index) => ({
      rawSeries,
      key: `__codex_series_${index + 1}`,
      label: seriesLabel(rawSeries),
    }));
    const byX = new Map<string, { row: Record<string, TraceCell>; order: number | string }>();
    const occupied = new Set<string>();
    for (const item of triples) {
      const overlaid = periodSeries && sourceTimeAxis ? overlayTimeBucket(item.x) : null;
      const xValue = overlaid?.label ?? item.x;
      const xIdentity = String(xValue);
      const seriesEntry = seriesEntries.find((entry) => String(entry.rawSeries) === String(item.rawSeries))!;
      const pointIdentity = `${xIdentity}\u0000${seriesEntry.key}`;
      if (occupied.has(pointIdentity)) {
        return rejected("duplicate_chart_grain", "The selected x and series columns do not identify one value per point. Query at a compatible grain first.");
      }
      occupied.add(pointIdentity);
      const existing = byX.get(xIdentity) ?? {
        row: { [request.xKey]: xValue },
        order: overlaid?.order ?? (sourceTimeAxis ? Date.parse(String(item.x)) : xIdentity),
      };
      existing.row[seriesEntry.key] = item.y;
      byX.set(xIdentity, existing);
    }
    rows = [...byX.values()]
      .sort((left, right) => (
        typeof left.order === "number" && typeof right.order === "number"
          ? left.order - right.order
          : String(left.order).localeCompare(String(right.order), "en-AU", { numeric: true })
      ))
      .map((entry) => entry.row);
    const minimumPoints = resolved === "line" ? 3 : 2;
    if (rows.length < minimumPoints) {
      return rejected("too_few_points", `The selected series produce fewer than ${minimumPoints} distinct x-axis points.`);
    }
    if (rows.length > MAX_LINE_POINTS && resolved === "line") {
      return rejected("too_many_points", "Use a coarser time granularity so the line has at most 60 points.");
    }
    series = seriesEntries.map(({ key, label }) => ({ key, label }));
    columns = [
      {
        ...xColumn,
        ...(periodSeries && sourceTimeAxis ? { type: "string" as const, label: /\.month$/u.test(request.xKey) ? "Month" : xColumn.label } : {}),
      },
      ...seriesEntries.map(({ key, label }) => ({ ...yColumn, key, label })),
    ];
    chartYKey = series[0]!.key;
    timeAxis = periodSeries && sourceTimeAxis ? false : sourceTimeAxis;
    if (resolved !== "line" && !sourceTimeAxis) {
      rows.sort((left, right) => {
        const total = (row: Record<string, TraceCell>) => series!.reduce((sum, item) => sum + Math.abs(numericValue(row[item.key] ?? null) ?? 0), 0);
        return total(right) - total(left);
      });
      const limit = request.limit ?? DEFAULT_BAR_POINTS;
      if (rows.length > limit) {
        rows = rows.slice(0, limit);
        notes.push(`Kept the ${limit} largest categories for readability.`);
      }
    } else if (resolved !== "line" && rows.length > MAX_LINE_POINTS) {
      return rejected("too_many_points", "Use a coarser time granularity so the chart has at most 60 time buckets.");
    }
  } else {
    const yKeys = [request.yKey, ...(request.extraYKeys ?? [])];
    const seenX = new Set<string>();
    rows = source.rows.flatMap((sourceRow) => {
      const x = sourceRow[request.xKey] ?? null;
      const primary = numericValue(sourceRow[request.yKey] ?? null);
      if (isBlank(x) || primary === null) return [];
      const identity = String(x);
      if (seenX.has(identity)) return [];
      seenX.add(identity);
      return [{
        [request.xKey]: x,
        ...Object.fromEntries(yKeys.map((key) => [key, numericValue(sourceRow[key] ?? null)])),
      }];
    });
    if (seenX.size !== rows.length || rows.length < source.rows.filter((row) => !isBlank(row[request.xKey] ?? null) && numericValue(row[request.yKey] ?? null) !== null).length) {
      return rejected("duplicate_chart_grain", "The selected x column repeats. Add a series dimension or query at one row per x value.");
    }
    const minimumPoints = resolved === "line" ? 3 : 2;
    if (rows.length < minimumPoints) {
      return rejected("too_few_points", `The selected columns produce fewer than ${minimumPoints} chartable points.`);
    }
    if (resolved === "line") {
      rows.sort((left, right) => Date.parse(String(left[request.xKey])) - Date.parse(String(right[request.xKey])));
      if (rows.length > MAX_LINE_POINTS) {
        return rejected("too_many_points", "Use a coarser time granularity so the line has at most 60 points.");
      }
    } else {
      rows.sort((left, right) => (numericValue(right[request.yKey] ?? null) ?? 0) - (numericValue(left[request.yKey] ?? null) ?? 0));
      const limit = request.limit ?? DEFAULT_BAR_POINTS;
      if (rows.length > limit) {
        rows = rows.slice(0, limit);
        notes.push(`Kept the ${limit} largest categories for readability.`);
      }
      const values = rows.map((row) => numericValue(row[request.yKey] ?? null)).filter((value): value is number => value !== null);
      if (new Set(values).size <= 1) {
        return rejected("equal_values", "Every bar would be the same height, so the chart adds no comparison.");
      }
    }
    columns = [xColumn, yColumn, ...extraColumns];
    if (request.transform === "cumulative") {
      // Trusted host arithmetic over the chronologically ordered governed
      // cells; the model never authors these totals.
      const totals = new Map<string, number>(yKeys.map((key) => [key, 0]));
      rows = rows.map((row) => {
        const next: Record<string, TraceCell> = { ...row };
        for (const key of yKeys) {
          const value = numericValue(row[key] ?? null) ?? 0;
          const total = Number(((totals.get(key) ?? 0) + value).toFixed(6));
          totals.set(key, total);
          next[key] = total;
        }
        return next;
      });
      columns = columns.map((column) => (
        yKeys.includes(column.key) ? { ...column, label: `Cumulative ${column.label}` } : column
      ));
      notes.push("Values are running totals accumulated in date order from the governed cells.");
    }
    if (yKeys.length > 1) {
      series = yKeys.map((key) => ({
        key,
        label: columns.find((column) => column.key === key)?.label ?? registry.get(key)?.label ?? key,
      }));
    }
  }

  if (!uniqueColumnKeys(columns)) {
    return rejected("duplicate_columns", "The selected chart columns are not unique.");
  }
  // Captions are validated against the governed cells plus the host-derived
  // chart rows, so a caption may cite a running total but never a new figure.
  if (findUngroundedNumbers(caption, [...source.rows, ...rows]).length > 0) {
    return rejected("ungrounded_caption", "Every figure in the chart caption must come from this result (or its host-derived chart rows); otherwise omit the figure.");
  }
  const wireType: "bar" | "line" = resolved === "line" ? "line" : "bar";
  const stacked = resolved === "stacked_bar";
  const orientation = wireType === "bar" && !timeAxis && !stacked ? "horizontal" as const : undefined;
  // The signature identifies the chart the owner would SEE — the plotted
  // values, not the source resultId. Re-deriving an identical result (a second
  // equivalent query or derived table) and charting it again is still the same
  // chart, and shipping it twice reads as a rendering bug.
  const plottedKeys = [chartXKey, chartYKey, ...(series?.map((item) => item.key) ?? [])];
  const signature = JSON.stringify([
    wireType,
    stacked,
    chartXKey,
    chartYKey,
    series?.map((item) => item.key) ?? [],
    request.transform ?? null,
    rows.map((row) => plottedKeys.map((key) => row[key] ?? null)),
  ]);
  if (state.signatures.has(signature)) {
    return rejected("duplicate_chart", "This exact chart is already attached.");
  }
  const resultId = ulid();
  const provenance = derivedProvenance(
    source,
    `Chart data derived from ${source.topic}: ${request.purpose}${notes.length ? `; ${notes.join(" ")}` : ""}.`,
  );
  const flintPlan = compileGroundedFlint({
    caption,
    chartType: wireType,
    stacked,
    orientation,
    xKey: chartXKey,
    yKey: chartYKey,
    series,
    columns,
    rows,
    timeRangeLabel: source.provenance.timeRange.label,
    timeAxis,
    measureLabel: request.transform === "cumulative" ? `Cumulative ${yColumn.label}` : yColumn.label,
  });
  return {
    ok: true,
    prepared: {
      signature,
      notes,
      table: {
        caption: sanitizeTraceText(`${caption} — chart data`, 160),
        columns,
        rows,
        resultId,
        provenance,
      },
      chart: {
        caption,
        chartType: wireType,
        dataRef: resultId,
        xKey: chartXKey,
        yKey: chartYKey,
        ...(series ? { series } : {}),
        ...(orientation ? { orientation } : {}),
        ...(stacked ? { stacked: true } : {}),
        flint: {
          semantic_types: flintPlan.semantic_types,
          field_display_names: flintPlan.field_display_names,
          chart_spec: flintPlan.chart_spec,
        },
      },
    },
  };
}
