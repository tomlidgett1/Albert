/**
 * The chart layer: data-shape-driven chart preparation.
 *
 * `make_chart` used to be a thin pass-through (one numeric column against one
 * x column of a single result, bar or line as the model said, refused for
 * anything else). Three consequences showed up in the evaluation: long-format
 * results (staff × month) were charted as one tangled line, follow-ups that
 * asked to sort/limit/re-bucket had to re-run queries because the chart could
 * not transform what was already retrieved, and the chart type depended purely
 * on model judgement.
 *
 * This module gives the tool a small deterministic transform vocabulary that
 * generalises to any result table (from any connector): pivot a series column
 * into wide series, sort, top-N, orientation, and an "auto" chart type resolved
 * from the shape of the x column (time → line, categories → bar). Transforms
 * produce a derived table event so the client renders the chart against rows
 * it has seen and the model can verify what was plotted.
 */
import { ulid } from "ulid";
import { z } from "zod";
import { tool, type Tool } from "@openai/agents";
import { sanitizeTraceText, type TraceCell, type TraceProvenance, type TraceTableColumn } from "../../../shared/src/index.js";
import type { StoredTableResult, V3TurnContext } from "./context.js";
import { resolveTableResult } from "./prior-results.js";

function modelOptional<T extends z.ZodType>(schema: T) {
  return schema.nullable().optional();
}

export const chartInputSchema = z.object({
  resultId: z.string().min(10).max(40).describe("A result from this turn or an earlier turn (see the prior-results block)."),
  chartType: z.enum(["bar", "line", "auto"]).describe("auto = line for a time axis, bar for categories. Prefer auto unless the owner asked for a type."),
  caption: z.string().trim().min(3).max(160),
  xKey: z.string().min(1).max(120).describe("Column key for the x axis (a time bucket or a category)."),
  yKey: z.string().min(1).max(120).describe("Numeric column key to plot."),
  seriesKey: modelOptional(z.string().min(1).max(120)).describe(
    "Optional dimension column whose values become separate series (for example staff member, category). Long rows are pivoted into one series per value (up to 8; the rest are grouped as Other).",
  ),
  extraYKeys: modelOptional(z.array(z.string().min(1).max(120)).max(5)).describe(
    "Optional additional numeric columns of the same result to plot as further series (for example money in and money out).",
  ),
  sort: modelOptional(z.enum(["x", "y_desc", "y_asc"])).describe("Order of the points: by x (chronological/natural, the default for time), or by the plotted value."),
  limit: modelOptional(z.number().int().min(1).max(60)).describe("Keep only N points after sorting: the first N (top-N) or, with take=last, the last N (e.g. the last 7 days)."),
  take: modelOptional(z.enum(["first", "last"])).describe("Which end of the sorted points `limit` keeps. Default first."),
  orientation: modelOptional(z.enum(["vertical", "horizontal"])).describe("Bar orientation. horizontal puts the x labels (for example dates or names) on the vertical axis."),
}).strict();

export type ChartToolInput = z.infer<typeof chartInputSchema>;

const TIME_KEY_SUFFIX = /\.(?:hour|day|week|month|quarter|year)$/u;
const ISO_LIKE = /^\d{4}-\d{2}(?:-\d{2})?(?:T|$)/u;

export function looksLikeTimeAxis(column: TraceTableColumn | undefined, key: string, sample: readonly TraceCell[]): boolean {
  if (column && (column.type === "date" || column.type === "datetime")) return true;
  if (TIME_KEY_SUFFIX.test(key)) return true;
  const strings = sample.filter((v): v is string => typeof v === "string");
  return strings.length > 0 && strings.every((v) => ISO_LIKE.test(v));
}

function slug(value: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 40);
  return s.length > 0 ? s : "value";
}

function toNumber(value: TraceCell): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

type PreparedRows = Readonly<{
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  seriesKeys: readonly string[];
  transformed: boolean;
  notes: string[];
}>;

const MAX_SERIES = 8;

/**
 * Applies pivot / sort / limit to the source rows. Pure and deterministic so it
 * is unit-testable and its result can be replayed.
 */
export function prepareChartRows(table: StoredTableResult, input: ChartToolInput): PreparedRows {
  const notes: string[] = [];
  const yColumn = table.columns.find((c) => c.key === input.yKey)!;
  let columns: TraceTableColumn[] = [...table.columns];
  let rows: Array<Record<string, TraceCell>> = table.rows.map((row) => ({ ...row }));
  let seriesKeys: string[] = [input.yKey, ...(input.extraYKeys ?? []).filter((k) => k !== input.yKey)];
  let transformed = false;

  if (input.seriesKey) {
    // Long → wide pivot: one row per x, one numeric column per series value.
    const totals = new Map<string, number>();
    for (const row of rows) {
      const s: string = String(row[input.seriesKey] ?? "");
      totals.set(s, (totals.get(s) ?? 0) + (toNumber(row[input.yKey]) ?? 0));
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
    const kept = ranked.slice(0, MAX_SERIES);
    const grouped = ranked.length > MAX_SERIES;
    if (grouped) notes.push(`${ranked.length - MAX_SERIES} smaller ${input.seriesKey.split(".").at(-1)} values were grouped as "Other".`);
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
      const seriesValue: string = String(row[input.seriesKey] ?? "");
      const key = keyFor.get(seriesValue) ?? otherKey;
      target[key] = (toNumber(target[key]) ?? 0) + (toNumber(row[input.yKey]) ?? 0);
    }
    const seriesColumns: TraceTableColumn[] = [
      ...kept.map((s) => ({ key: keyFor.get(s)!, label: s || "(blank)", type: yColumn.type, ...(yColumn.currency ? { currency: yColumn.currency } : {}) })),
      ...(grouped ? [{ key: otherKey, label: "Other", type: yColumn.type, ...(yColumn.currency ? { currency: yColumn.currency } : {}) }] : []),
    ];
    const xColumn = table.columns.find((c) => c.key === input.xKey)!;
    columns = [xColumn, ...seriesColumns];
    rows = xOrder.map((xk) => {
      const row = byX.get(xk)!;
      for (const c of seriesColumns) if (row[c.key] === undefined) row[c.key] = null;
      return row;
    });
    seriesKeys = seriesColumns.map((c) => c.key);
    transformed = true;
  }

  const sortMode = input.sort ?? "x";
  if (sortMode === "y_desc" || sortMode === "y_asc") {
    const primary = seriesKeys[0]!;
    rows.sort((a, b) => ((toNumber(b[primary]) ?? -Infinity) - (toNumber(a[primary]) ?? -Infinity)) * (sortMode === "y_desc" ? 1 : -1));
    transformed = true;
  } else if (input.sort === "x") {
    const xColumn = table.columns.find((c) => c.key === input.xKey);
    const timeAxis = looksLikeTimeAxis(xColumn, input.xKey, rows.slice(0, 5).map((r) => r[input.xKey] ?? null));
    if (timeAxis) {
      const before = rows.map((r) => String(r[input.xKey] ?? "")).join("|");
      rows.sort((a, b) => String(a[input.xKey] ?? "").localeCompare(String(b[input.xKey] ?? "")));
      if (rows.map((r) => String(r[input.xKey] ?? "")).join("|") !== before) transformed = true;
    }
  }
  if (input.limit && rows.length > input.limit) {
    rows = input.take === "last" ? rows.slice(-input.limit) : rows.slice(0, input.limit);
    transformed = true;
  }
  return { columns, rows, seriesKeys, transformed, notes };
}

export function resolveChartType(input: ChartToolInput, table: StoredTableResult, rows: readonly Readonly<Record<string, TraceCell>>[]): { chartType: "bar" | "line"; note?: string } {
  const xColumn = table.columns.find((c) => c.key === input.xKey);
  const timeAxis = looksLikeTimeAxis(xColumn, input.xKey, rows.slice(0, 5).map((r) => r[input.xKey] ?? null));
  if (input.chartType === "auto") {
    if (timeAxis && rows.length >= 3 && (input.sort ?? "x") === "x") return { chartType: "line" };
    return { chartType: "bar" };
  }
  if (input.chartType === "line" && !timeAxis) {
    return { chartType: "line", note: "The x axis is categorical, so a line implies an order that is not there; a bar chart usually reads better." };
  }
  return { chartType: input.chartType };
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
      + "chartType auto picks line for a time axis and bar for categories. Use seriesKey to split one measure by a dimension (one series per value), extraYKeys for several numeric columns. "
      + "Use sort=y_desc + limit for a top-N bar chart. The chart is placed with the answer automatically; do not describe it as a table.",
    parameters: chartInputSchema,
    strict: true,
    execute: async (input, runContext) => {
      const context = runContext?.context as V3TurnContext | undefined;
      if (!context) throw new Error("The Albert v3 tool context is missing.");
      const table = await resolveTableResult(context, input.resultId);
      if (!table) return { ok: false, error: "Unknown resultId. Chart an existing result (this turn or a listed earlier result)." };
      const keys = [input.xKey, input.yKey, ...(input.extraYKeys ?? []), ...(input.seriesKey ? [input.seriesKey] : [])];
      const missing = keys.filter((k) => !table.columnKeys.includes(k));
      if (missing.length > 0) return { ok: false, error: `Unknown column key ${missing.join(", ")}. Columns must be among: ${table.columnKeys.join(", ")}` };
      for (const yk of [input.yKey, ...(input.extraYKeys ?? [])]) {
        if (!table.numericColumnKeys.includes(yk)) return { ok: false, error: `${yk} is not a numeric column.` };
      }
      if (input.seriesKey && (input.extraYKeys?.length ?? 0) > 0) return { ok: false, error: "Use either seriesKey (pivot one measure) or extraYKeys (several measures), not both." };

      const prepared = prepareChartRows(table, input);
      const { chartType, note } = resolveChartType(input, table, prepared.rows);
      const notes = [...prepared.notes, ...(note ? [note] : [])];
      const minimumPoints = chartType === "line" ? 3 : 2;
      if (prepared.rows.length < minimumPoints) {
        return { ok: false, error: `This result has ${prepared.rows.length} data point${prepared.rows.length === 1 ? "" : "s"}: a chart of fewer than ${minimumPoints} points communicates less than the figures themselves. State them in prose or use a table.` };
      }
      const plotted = prepared.rows.map((r) => toNumber(r[prepared.seriesKeys[0]!] ?? null)).filter((v): v is number => v !== null);
      if (chartType === "bar" && prepared.seriesKeys.length === 1 && plotted.length > 0 && new Set(plotted).size === 1) {
        return { ok: false, error: "Every bar would be the same height, so the chart carries no comparison. State the shared value in prose instead." };
      }

      // A transformed view of the data becomes its own evidence table so the
      // client renders exactly what was plotted and the model can check it.
      let dataRef = table.resultId;
      if (prepared.transformed) {
        const resultId = ulid();
        const description = [
          input.seriesKey ? `pivoted ${input.yKey} by ${input.seriesKey}` : null,
          input.sort && input.sort !== "x" ? `sorted ${input.sort}` : null,
          input.limit ? `${input.take === "last" ? "last" : "first"} ${input.limit}` : null,
        ].filter(Boolean).join(", ") || "chart view";
        const provenance = derivedProvenance(table, `Chart data derived from ${table.caption}: ${description}.`);
        const tableEvent = await context.emit({
          type: "table",
          status: "complete",
          caption: sanitizeTraceText(`${input.caption} — chart data`, 160),
          columns: prepared.columns,
          rows: prepared.rows.slice(0, 60),
          resultId,
          provenance,
          presentation: "evidence",
        });
        context.tableResults.set(resultId, {
          tableEventId: tableEvent.id,
          resultId,
          caption: `${input.caption} — chart data`,
          columns: prepared.columns,
          rows: prepared.rows.slice(0, 60),
          columnKeys: prepared.columns.map((c) => c.key),
          numericColumnKeys: prepared.columns.filter((c) => c.type === "number" || c.type === "currency" || c.type === "percent").map((c) => c.key),
          rowCount: prepared.rows.length,
          provenance,
          presentation: "evidence",
        });
        dataRef = resultId;
      }
      const signature = JSON.stringify([dataRef, chartType, input.xKey, prepared.seriesKeys, input.orientation ?? null]);
      if (context.chartedResultIds.has(signature)) return { ok: false, error: "This exact chart is already attached." };
      context.chartedResultIds.add(signature);
      const series = prepared.seriesKeys.length > 1
        ? prepared.seriesKeys.map((key) => ({ key, label: prepared.columns.find((c) => c.key === key)?.label ?? key }))
        : undefined;
      await context.emit({
        type: "chart",
        status: "complete",
        caption: sanitizeTraceText(input.caption, 160),
        chartType,
        dataRef,
        xKey: input.xKey,
        yKey: prepared.seriesKeys[0]!,
        ...(series ? { series } : {}),
        ...(input.orientation ? { orientation: input.orientation } : {}),
      } as never);
      return {
        ok: true,
        chartType,
        points: prepared.rows.length,
        series: prepared.seriesKeys.length,
        ...(prepared.transformed ? { chartDataResultId: dataRef } : {}),
        ...(notes.length ? { notes } : {}),
        guidance: "The chart is attached to the answer. Mention it in one short clause at most; do not restate its points in prose.",
      };
    },
  });
}
