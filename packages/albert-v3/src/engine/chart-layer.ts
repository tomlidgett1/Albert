/**
 * The chart layer: data-shape-driven chart preparation.
 *
 * `make_chart` is the only path that produces a chart event. It accepts a
 * governed result, a small transform vocabulary (filter, pivot a series
 * column into wide series, sort, top-N, orientation) and a chart form, and
 * validates the request against the actual result before anything reaches the
 * public trace. Transforms produce a derived table event so the client renders
 * the chart against rows it has seen and the model can verify what was plotted.
 *
 * The presentation rules enforced here are the same ones the visualiser agent
 * is briefed with (see visualise-lane.ts and result-shape.ts):
 *
 * - a line needs an ordered time axis and at most four series; more series are
 *   folded into "Other" (line) or stacked as bars (stacked_bar);
 * - a categorical bar is ranked (sorted by value) unless the axis is time, and
 *   long category lists are trimmed to the top N with a note;
 * - series and axis labels are derived from the result: blank values become
 *   "(not set)", snake_case codes are title-cased, date ranges are humanised;
 * - a like-for-like period comparison is either filtered to one period or
 *   plotted with the period as the series; a time axis is overlaid on shared
 *   months, never two calendar years end to end;
 * - transforms run over every held row (`allRows`), not the 50-row client
 *   slice, so a pivot never silently drops months.
 */
import { ulid } from "ulid";
import { z } from "zod";
import { tool, type Tool } from "@openai/agents";
import { compileGroundedFlint, sanitizeTraceText, type TraceCell, type TraceProvenance, type TraceTableColumn } from "../../../shared/src/index.js";
import type { StoredTableResult, V3TurnContext } from "./context.js";
import { resolveTableResult } from "./prior-results.js";
import { isPeriodColumn, looksLikeTimeAxis, profileResult, renderResultShape } from "./result-shape.js";

export { looksLikeTimeAxis } from "./result-shape.js";

function modelOptional<T extends z.ZodType>(schema: T) {
  return schema.nullable().optional();
}

export const chartInputSchema = z.object({
  resultId: z.string().min(10).max(40).describe("A result from this turn or an earlier turn (see the prior-results block)."),
  chartType: z.enum(["bar", "stacked_bar", "line", "auto"]).describe(
    "bar = comparison/ranking across categories (grouped bars when seriesKey is set); stacked_bar = composition, one stack per x value; "
    + "line = an ordered time axis with at most four series; auto = the shape-driven best guess. Prefer auto unless the owner asked for a type.",
  ),
  caption: z.string().trim().min(3).max(160).describe("Owner-facing caption naming the claim the chart supports, e.g. 'General services carry two-thirds of workshop profit'."),
  xKey: z.string().min(1).max(120).describe("Column key for the x axis (a time bucket or a category)."),
  yKey: z.string().min(1).max(120).describe("Numeric column key to plot."),
  seriesKey: modelOptional(z.string().min(1).max(120)).describe(
    "Optional dimension column whose values become separate series (for example staff member, category, or the compareDateRange period column). Long rows are pivoted into one series per value; lines keep the top 3 + Other, bars the top 7 + Other.",
  ),
  extraYKeys: modelOptional(z.array(z.string().min(1).max(120)).max(5)).describe(
    "Optional additional numeric columns of the same result to plot as further series (for example money in and money out). Same unit as yKey.",
  ),
  where: modelOptional(z.object({
    key: z.string().min(1).max(120),
    equals: z.string().min(1).max(200),
  }).strict()).describe("Optional row filter applied first: keep rows whose column equals the value (e.g. one compareDateRange period, one item type)."),
  sort: modelOptional(z.enum(["x", "y_desc", "y_asc"])).describe("Order of the points: by x (chronological, the default for time) or by the plotted value (the default for categories: ranked bars)."),
  limit: modelOptional(z.number().int().min(1).max(60)).describe("Keep only N points after sorting: the first N (top-N) or, with take=last, the last N (e.g. the last 7 days)."),
  take: modelOptional(z.enum(["first", "last"])).describe("Which end of the sorted points `limit` keeps. Default first."),
  orientation: modelOptional(z.enum(["vertical", "horizontal"])).describe("Bar orientation. horizontal puts the x labels (for example names) on the vertical axis; the default for ranked category bars."),
}).strict();

export type ChartToolInput = z.infer<typeof chartInputSchema>;

/** Series caps: lines tangle beyond four; stacks stay legible to about eight. */
export const LINE_MAX_SERIES = 4;
export const BAR_MAX_SERIES = 8;
/** A ranked category bar keeps the top N unless the caller limits explicitly. */
export const BAR_AUTO_LIMIT = 15;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_RANGE = /^(\d{4})-(\d{2})-(\d{2})T[\d:.]*\s*-\s*(\d{4})-(\d{2})-(\d{2})T[\d:.]*$/u;
const ISO_BUCKET = /^(\d{4})-(\d{2})(?:-(\d{2}))?/u;
const CODE_VALUE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

function slug(value: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 40);
  return s.length > 0 ? s : "value";
}

function toNumber(value: TraceCell): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function isBlank(value: TraceCell): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/**
 * Strip the year from a calendar bucket so two compare periods can share an
 * axis: 2025-03 and 2026-03 both become "Mar". Daily values keep the day
 * ("15 Mar"). Returns null when the value is not a date.
 */
export function yearAgnosticTimeBucket(value: TraceCell, keepDay = false): string | null {
  if (isBlank(value)) return null;
  const match = ISO_BUCKET.exec(String(value));
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return null;
  const day = match[3] ? Number(match[3]) : 0;
  return !keepDay && (!match[3] || day === 1) ? month : `${day || 1} ${month}`;
}

function sampleKeepsDay(rows: readonly Readonly<Record<string, TraceCell>>[], xKey: string): boolean {
  return rows.some((row) => {
    const match = ISO_BUCKET.exec(String(row[xKey] ?? ""));
    return Boolean(match?.[3] && Number(match[3]) !== 1);
  });
}

/**
 * Owner-facing label for a series value: date ranges become "Aug 2024 – Jul
 * 2025", snake_case codes become "Non inventory", blanks become "(not set)".
 */
export function humaniseSeriesLabel(value: TraceCell): string {
  if (isBlank(value)) return "(not set)";
  const text = String(value);
  const range = DATE_RANGE.exec(text);
  if (range) {
    const [, y1, m1, d1, y2, m2, d2] = range;
    const start = `${d1 === "01" ? "" : `${Number(d1)} `}${MONTHS[Number(m1) - 1]} ${y1}`;
    const end = `${d2 && Number(d2) < 28 ? `${Number(d2)} ` : ""}${MONTHS[Number(m2) - 1]} ${y2}`;
    return `${start} – ${end}`;
  }
  if (CODE_VALUE.test(text)) {
    const words = text.split("_").join(" ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return text;
}

type PreparedRows = Readonly<{
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  seriesKeys: readonly string[];
  transformed: boolean;
  notes: string[];
  timeAxis: boolean;
}>;

/**
 * Applies filter / pivot / sort / limit to the source rows. Pure and
 * deterministic so it is unit-testable and its result can be replayed.
 */
export function prepareChartRows(table: StoredTableResult, input: ChartToolInput, resolved: "bar" | "stacked_bar" | "line"): PreparedRows {
  const notes: string[] = [];
  const yColumn = table.columns.find((c) => c.key === input.yKey)!;
  const xColumn = table.columns.find((c) => c.key === input.xKey);
  let columns: TraceTableColumn[] = [...table.columns];
  const source = table.allRows ?? table.rows;
  let rows: Array<Record<string, TraceCell>> = source.map((row) => ({ ...row }));
  let seriesKeys: string[] = [input.yKey, ...(input.extraYKeys ?? []).filter((k) => k !== input.yKey)];
  let transformed = false;

  if (input.where) {
    const { key, equals } = input.where;
    const before = rows.length;
    rows = rows.filter((row) => String(row[key] ?? "") === equals || humaniseSeriesLabel(row[key] ?? null) === equals);
    if (rows.length !== before) {
      transformed = true;
      notes.push(`Filtered to ${key.split(".").at(-1)} = ${equals} (${rows.length} of ${before} rows).`);
    }
  }

  let timeAxis = looksLikeTimeAxis(xColumn, input.xKey, rows.slice(0, 5).map((r) => r[input.xKey] ?? null));

  if (
    input.seriesKey
    && timeAxis
    && isPeriodColumn(input.seriesKey, rows.slice(0, 5).map((row) => row[input.seriesKey!] ?? null))
  ) {
    const keepDay = sampleKeepsDay(rows, input.xKey);
    const aligned = rows.map((row) => {
      const bucket = yearAgnosticTimeBucket(row[input.xKey], keepDay);
      return bucket ? { ...row, [input.xKey]: bucket } : null;
    });
    if (aligned.every((row): row is Record<string, TraceCell> => row !== null)) {
      rows = aligned;
      timeAxis = false;
      transformed = true;
      notes.push("Periods share a month axis so this year sits on last year, not end to end.");
      columns = columns.map((column) => (
        column.key === input.xKey
          ? { ...column, type: "string", label: keepDay ? "Day" : /\.month$/u.test(input.xKey) ? "Month" : column.label }
          : column
      ));
    }
  }

  // Rows whose x is blank cannot be placed on an axis; say so rather than
  // letting them collapse into one anonymous point.
  const blankX = rows.filter((r) => isBlank(r[input.xKey])).length;
  if (blankX > 0) {
    rows = rows.filter((r) => !isBlank(r[input.xKey]));
    transformed = true;
    notes.push(`${blankX} row${blankX === 1 ? "" : "s"} with no ${xColumn?.label ?? input.xKey} were left off the axis.`);
  }

  if (input.seriesKey) {
    // Long → wide pivot: one row per x, one numeric column per series value.
    const maxSeries = resolved === "line" ? LINE_MAX_SERIES : BAR_MAX_SERIES;
    const totals = new Map<string, number>();
    const rawBySeries = new Map<string, TraceCell>();
    for (const row of rows) {
      const raw = row[input.seriesKey] ?? null;
      const s = humaniseSeriesLabel(raw);
      rawBySeries.set(s, raw);
      totals.set(s, (totals.get(s) ?? 0) + (toNumber(row[input.yKey]) ?? 0));
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
    // Blank series values are real rows but a poor series: keep them last so
    // they fall into Other whenever the cap is reached.
    ranked.sort((a, b) => Number(a === "(not set)") - Number(b === "(not set)"));
    const grouped = ranked.length > maxSeries;
    const kept = grouped ? ranked.slice(0, maxSeries - 1) : ranked;
    if (grouped) notes.push(`${ranked.length - kept.length} smaller ${input.seriesKey.split(".").at(-1)} values were grouped as "Other" (${resolved === "line" ? "a line chart carries at most four series" : "a stack carries at most eight"}).`);
    if (ranked.includes("(not set)") && kept.includes("(not set)")) notes.push(`Rows with no ${input.seriesKey.split(".").at(-1)} plot as "(not set)".`);
    const keyFor = new Map<string, string>();
    for (const s of kept) {
      let k = `series_${slug(s)}`;
      while ([...keyFor.values()].includes(k)) k = `${k}_`;
      keyFor.set(s, k);
    }
    const otherKey = "series_other";
    const byX = new Map<string, Record<string, TraceCell>>();
    const xOrder: string[] = [];
    for (const row of rows) {
      const x = row[input.xKey];
      const xk = String(x ?? "");
      if (!byX.has(xk)) { byX.set(xk, { [input.xKey]: x ?? null }); xOrder.push(xk); }
      const target = byX.get(xk)!;
      const seriesValue = humaniseSeriesLabel(row[input.seriesKey] ?? null);
      const key = keyFor.get(seriesValue) ?? otherKey;
      target[key] = (toNumber(target[key]) ?? 0) + (toNumber(row[input.yKey]) ?? 0);
    }
    const seriesColumns: TraceTableColumn[] = [
      ...kept.map((s) => ({ key: keyFor.get(s)!, label: s, type: yColumn.type, ...(yColumn.currency ? { currency: yColumn.currency } : {}) })),
      ...(grouped ? [{ key: otherKey, label: "Other", type: yColumn.type, ...(yColumn.currency ? { currency: yColumn.currency } : {}) }] : []),
    ];
    const axisColumn = columns.find((column) => column.key === input.xKey) ?? xColumn!;
    columns = [axisColumn, ...seriesColumns];
    rows = xOrder.map((xk) => {
      const row = byX.get(xk)!;
      for (const c of seriesColumns) if (row[c.key] === undefined) row[c.key] = null;
      return row;
    });
    seriesKeys = seriesColumns.map((c) => c.key);
    transformed = true;
  }

  // Ranked bars are the default for categories; time stays chronological.
  const sortMode = input.sort ?? (timeAxis || resolved === "line" ? "x" : "y_desc");
  if (sortMode === "y_desc" || sortMode === "y_asc") {
    const primary = seriesKeys[0]!;
    // With several series, rank by the total across series so a stack or a
    // group is ordered by what the eye compares: the whole bar.
    const magnitude = (row: Record<string, TraceCell>) => seriesKeys.reduce((sum, k) => sum + (toNumber(row[k]) ?? 0), 0);
    const before = rows.map((r) => String(r[input.xKey] ?? "")).join("|");
    rows.sort((a, b) => ((seriesKeys.length > 1 ? magnitude(b) - magnitude(a) : (toNumber(b[primary]) ?? -Infinity) - (toNumber(a[primary]) ?? -Infinity)) * (sortMode === "y_desc" ? 1 : -1)));
    if (rows.map((r) => String(r[input.xKey] ?? "")).join("|") !== before) transformed = true;
  } else if (timeAxis) {
    const before = rows.map((r) => String(r[input.xKey] ?? "")).join("|");
    rows.sort((a, b) => String(a[input.xKey] ?? "").localeCompare(String(b[input.xKey] ?? "")));
    if (rows.map((r) => String(r[input.xKey] ?? "")).join("|") !== before) transformed = true;
  }

  const limit = input.limit ?? (resolved !== "line" && !timeAxis && rows.length > BAR_AUTO_LIMIT ? BAR_AUTO_LIMIT : undefined);
  if (limit && rows.length > limit) {
    const dropped = rows.length - limit;
    rows = input.take === "last" ? rows.slice(-limit) : rows.slice(0, limit);
    transformed = true;
    if (!input.limit) notes.push(`Showing the top ${limit} of ${limit + dropped} ${xColumn?.label ?? input.xKey} values; the rest are in the source table.`);
  }
  return { columns, rows, seriesKeys, transformed, notes, timeAxis };
}

/**
 * Turns the requested chart form into the rendered one. `auto` follows the
 * shape rules; explicit requests are honoured unless they would mislead (a
 * line over categories, a stack of one series), in which case the nearest
 * honest form is used and the caller is told why.
 */
export function resolveChartType(
  input: ChartToolInput,
  table: StoredTableResult,
): { chartType: "bar" | "stacked_bar" | "line"; note?: string } {
  const source = table.allRows ?? table.rows;
  const xColumn = table.columns.find((c) => c.key === input.xKey);
  const timeAxis = looksLikeTimeAxis(xColumn, input.xKey, source.slice(0, 5).map((r) => r[input.xKey] ?? null));
  const distinctX = new Set(source.map((r) => String(r[input.xKey] ?? ""))).size;
  const distinctSeries = input.seriesKey ? new Set(source.map((r) => humaniseSeriesLabel(r[input.seriesKey!] ?? null))).size : 1;
  const chronological = (input.sort ?? "x") === "x";
  if (input.chartType === "auto") {
    if (timeAxis && distinctX >= 3 && chronological) {
      if (distinctSeries > LINE_MAX_SERIES) return { chartType: "stacked_bar", note: `${distinctSeries} series over time: stacked bars instead of ${distinctSeries} tangled lines.` };
      return { chartType: "line" };
    }
    if (input.seriesKey && distinctSeries > 1 && !isPeriodColumn(input.seriesKey, source.slice(0, 5).map((r) => r[input.seriesKey!] ?? null))) {
      return { chartType: "stacked_bar" };
    }
    return { chartType: "bar" };
  }
  if (input.chartType === "line") {
    if (!timeAxis) return { chartType: "bar", note: "The x axis is categorical, so a line would imply an order that is not there; drawn as bars." };
    if (!chronological) return { chartType: "bar", note: "A line sorted by value is a ranking, not a trend; drawn as bars." };
    if (distinctSeries > LINE_MAX_SERIES) return { chartType: "line", note: `Only the top ${LINE_MAX_SERIES - 1} series are drawn as lines; the rest are folded into Other. Use stacked_bar to keep every value visible.` };
    return { chartType: "line" };
  }
  if (input.chartType === "stacked_bar") {
    if (!input.seriesKey && !(input.extraYKeys?.length)) return { chartType: "bar", note: "A stack needs a seriesKey or extraYKeys; drawn as plain bars." };
    return { chartType: "stacked_bar" };
  }
  return { chartType: "bar" };
}

function derivedProvenance(source: StoredTableResult, description: string): TraceProvenance {
  const { calculations: _calculations, ...rest } = source.provenance;
  return {
    ...rest,
    definitions: [
      ...source.provenance.definitions.slice(0, 20),
      { metric: "albert.chart_transform", label: "Chart data", definition: description },
    ],
  };
}

/** The tool factory. */
export function createMakeChartTool(): Tool<V3TurnContext> {
  return tool({
    name: "make_chart",
    description:
      "Attach a chart to a result. Works on results from this turn AND on results retrieved in earlier turns (see the prior-results block) — re-charting, re-sorting, top-N, coarser series or flipping orientation never needs a new query. "
      + "chartType auto follows the result's shape: a line for a time axis (≤4 series), ranked horizontal bars for categories, stacked bars for composition. Use seriesKey to split one measure by a dimension, extraYKeys for several same-unit measures, where to keep one period or category. "
      + "Every chart must support a specific claim in the answer; the caption names that claim. The chart is placed with the answer automatically; do not describe it as a table.",
    parameters: chartInputSchema,
    strict: true,
    execute: async (input, runContext) => {
      const context = runContext?.context as V3TurnContext | undefined;
      if (!context) throw new Error("The Albert v3 tool context is missing.");
      const table = await resolveTableResult(context, input.resultId);
      if (!table) return { ok: false, error: "Unknown resultId. Chart an existing result (this turn or a listed earlier result)." };
      const keys = [input.xKey, input.yKey, ...(input.extraYKeys ?? []), ...(input.seriesKey ? [input.seriesKey] : []), ...(input.where ? [input.where.key] : [])];
      const missing = keys.filter((k) => !table.columnKeys.includes(k));
      if (missing.length > 0) return { ok: false, error: `Unknown column key ${missing.join(", ")}. Columns must be among: ${table.columnKeys.join(", ")}` };
      for (const yk of [input.yKey, ...(input.extraYKeys ?? [])]) {
        if (!table.numericColumnKeys.includes(yk)) return { ok: false, error: `${yk} is not a numeric column.` };
      }
      if (input.seriesKey && (input.extraYKeys?.length ?? 0) > 0) return { ok: false, error: "Use either seriesKey (pivot one measure) or extraYKeys (several measures), not both." };
      if (table.numericColumnKeys.includes(input.xKey)) return { ok: false, error: `${input.xKey} is a measure; the x axis must be a time bucket or a dimension.` };
      if (input.seriesKey && table.numericColumnKeys.includes(input.seriesKey)) return { ok: false, error: `${input.seriesKey} is a measure; seriesKey must be a dimension (use extraYKeys for several measures).` };
      const yColumn = table.columns.find((c) => c.key === input.yKey)!;
      for (const extra of input.extraYKeys ?? []) {
        const column = table.columns.find((c) => c.key === extra)!;
        const unitOf = (c: TraceTableColumn) => (c.type === "currency" ? c.currency ?? "currency" : c.type);
        if (unitOf(column) !== unitOf(yColumn)) return { ok: false, error: `${extra} (${unitOf(column)}) and ${input.yKey} (${unitOf(yColumn)}) have different units and cannot share an axis. Chart them separately.` };
      }

      const shape = profileResult(table);
      const periodKey = shape.periodKey;
      if (periodKey && !input.where && input.seriesKey !== periodKey && input.xKey !== periodKey) {
        // A compare-date-range result holds both periods; squashing them onto
        // one axis double-counts months / categories.
        return {
          ok: false,
          error: `This result compares two periods (${periodKey}). Either chart one period with where={key:"${periodKey}", equals:<period label>} or use seriesKey="${periodKey}" so this period sits beside the last.`,
          periods: [...new Set((table.allRows ?? table.rows).map((r) => String(r[periodKey] ?? "")))].slice(0, 4),
          shape: renderResultShape(shape),
        };
      }

      const { chartType, note } = resolveChartType(input, table);
      const prepared = prepareChartRows(table, input, chartType);
      const notes = [...prepared.notes, ...(note ? [note] : [])];
      const minimumPoints = chartType === "line" ? 3 : 2;
      if (prepared.rows.length < minimumPoints) {
        return { ok: false, error: `This result has ${prepared.rows.length} data point${prepared.rows.length === 1 ? "" : "s"}: a chart of fewer than ${minimumPoints} points communicates less than the figures themselves. State them in prose or use a table.`, shape: renderResultShape(shape) };
      }
      const plotted = prepared.rows.map((r) => toNumber(r[prepared.seriesKeys[0]!] ?? null)).filter((v): v is number => v !== null);
      if (chartType !== "line" && prepared.seriesKeys.length === 1 && plotted.length > 0 && new Set(plotted).size === 1) {
        return { ok: false, error: "Every bar would be the same height, so the chart carries no comparison. State the shared value in prose instead." };
      }
      if (prepared.seriesKeys.length > 1) {
        const live = prepared.seriesKeys.filter((k) => prepared.rows.some((r) => toNumber(r[k] ?? null) !== null));
        if (live.length < 2 && chartType === "stacked_bar") notes.push("Only one series has values, so the stack reads as plain bars.");
      }

      // A transformed view of the data becomes its own evidence table so the
      // client renders exactly what was plotted and the model can check it.
      let dataRef = table.resultId;
      let heldRows = prepared.rows;
      if (prepared.transformed || (table.allRows && table.allRows.length > table.rows.length)) {
        const resultId = ulid();
        const description = [
          input.where ? `filtered ${input.where.key} = ${input.where.equals}` : null,
          input.seriesKey ? `pivoted ${input.yKey} by ${input.seriesKey}` : null,
          input.sort && input.sort !== "x" ? `sorted ${input.sort}` : null,
          input.limit ? `${input.take === "last" ? "last" : "first"} ${input.limit}` : null,
        ].filter(Boolean).join(", ") || "chart view";
        const provenance = derivedProvenance(table, `Chart data derived from ${table.caption}: ${description}.`);
        heldRows = prepared.rows.slice(0, 120);
        const tableEvent = await context.emit({
          type: "table",
          status: "complete",
          caption: sanitizeTraceText(`${input.caption} — chart data`, 160),
          columns: prepared.columns,
          rows: heldRows,
          resultId,
          provenance,
          presentation: "evidence",
        });
        context.tableResults.set(resultId, {
          tableEventId: tableEvent.id,
          resultId,
          caption: `${input.caption} — chart data`,
          columns: prepared.columns,
          rows: heldRows,
          columnKeys: prepared.columns.map((c) => c.key),
          numericColumnKeys: prepared.columns.filter((c) => c.type === "number" || c.type === "currency" || c.type === "percent").map((c) => c.key),
          rowCount: prepared.rows.length,
          provenance,
          presentation: "evidence",
        });
        dataRef = resultId;
      }
      const stacked = chartType === "stacked_bar";
      const wireType: "bar" | "line" = chartType === "line" ? "line" : "bar";
      const signature = JSON.stringify([dataRef, wireType, stacked, input.xKey, prepared.seriesKeys, input.orientation ?? null]);
      if (context.chartedResultIds.has(signature)) return { ok: false, error: "This exact chart is already attached." };
      context.chartedResultIds.add(signature);
      const series = prepared.seriesKeys.length > 1
        ? prepared.seriesKeys.map((key) => ({ key, label: prepared.columns.find((c) => c.key === key)?.label ?? key }))
        : undefined;
      const orientation = input.orientation
        ?? (wireType === "bar" && !prepared.timeAxis ? "horizontal" : undefined);
      const plotColumns = prepared.transformed
        ? prepared.columns
        : table.columns;
      const flintPlan = compileGroundedFlint({
        caption: sanitizeTraceText(input.caption, 160),
        chartType: wireType,
        stacked,
        orientation,
        xKey: input.xKey,
        yKey: prepared.seriesKeys[0]!,
        series,
        columns: plotColumns,
        rows: heldRows,
        timeRangeLabel: table.provenance.timeRange.label,
        timeAxis: prepared.timeAxis,
        measureLabel: yColumn.label,
      });
      await context.emit({
        type: "chart",
        status: "complete",
        caption: sanitizeTraceText(input.caption, 160),
        chartType: wireType,
        dataRef,
        xKey: input.xKey,
        yKey: prepared.seriesKeys[0]!,
        ...(series ? { series } : {}),
        ...(stacked ? { stacked: true } : {}),
        ...(orientation ? { orientation } : {}),
        flint: {
          semantic_types: flintPlan.semantic_types,
          field_display_names: flintPlan.field_display_names,
          chart_spec: flintPlan.chart_spec,
        },
      });
      return {
        ok: true,
        chartType,
        points: heldRows.length,
        series: prepared.seriesKeys.length,
        seriesLabels: series?.map((s) => s.label),
        ...(prepared.transformed ? { chartDataResultId: dataRef } : {}),
        ...(notes.length ? { notes } : {}),
        guidance: "The chart is attached to the answer. Mention it in one short clause at most; do not restate its points in prose.",
      };
    },
  });
}
