/**
 * Result-shape profiling: the deterministic half of the visualisation agent.
 *
 * Omni's workbook makes a "best guess" chart for every new query from the
 * shape of the result (which columns are time, dimensions, measures; how many
 * distinct values each carries) and lets the analyst override it. Albert does
 * the same here: `profileResult` classifies every column of a governed table
 * and `recommendVisual` turns that profile into a default presentation form
 * with the series mapping (x / y / colour) already filled in.
 *
 * The recommendation is advice, not a decision. The visualiser agent reads the
 * profile and the owner's question, then either accepts the recommendation or
 * argues for another form; trusted code in the chart layer validates whatever
 * it picks. Keeping this pure means the eval harness can assert the guess for
 * any result shape without a model in the loop.
 */
import type { TraceCell, TraceTableColumn } from "../../../shared/src/index.js";
import type { StoredTableResult } from "./context.js";

export type ColumnRole = "time" | "period" | "dimension" | "measure";

export type ColumnProfile = Readonly<{
  key: string;
  label: string;
  type: TraceTableColumn["type"];
  role: ColumnRole;
  /** Distinct non-null values across the rows held in memory. */
  distinct: number;
  /** Rows where this column is null / blank. */
  nulls: number;
  /** Up to five distinct example values (as strings) for the model to read. */
  sample: readonly string[];
  /**
   * True when the values look like internal codes (snake_case enums, ids)
   * rather than owner-facing labels — for example items_item_type =
   * "non_inventory". Such columns make poor axis labels; the visualiser is told
   * to prefer a labelled dimension when one exists.
   */
  codeLike: boolean;
  /** Unit group for measures: currency code, "percent" or "number". */
  unit?: string;
}>;

export type ResultGrain =
  | "scalar"          // one row, measures only
  | "single-row"      // one row with dimensions (a record)
  | "time-series"     // time axis, no dimension
  | "time-by-category" // time axis + one dimension
  | "category"        // one dimension, no time
  | "category-by-category" // two dimensions, no time
  | "records";        // wide / high-cardinality rows better read as a table

export type VisualForm = "prose" | "kpi" | "bar" | "grouped_bar" | "stacked_bar" | "line" | "table";

export type VisualRecommendation = Readonly<{
  form: VisualForm;
  xKey?: string;
  yKey?: string;
  extraYKeys?: readonly string[];
  seriesKey?: string;
  sort?: "x" | "y_desc" | "y_asc";
  limit?: number;
  orientation?: "vertical" | "horizontal";
  /** Filter to apply first, e.g. keep only the current comparison period. */
  where?: Readonly<{ key: string; equals: string }>;
  reason: string;
}>;

export type ResultShape = Readonly<{
  resultId: string;
  caption: string;
  rowCount: number;
  rowsHeld: number;
  columns: readonly ColumnProfile[];
  timeKey?: string;
  periodKey?: string;
  dimensionKeys: readonly string[];
  measureKeys: readonly string[];
  grain: ResultGrain;
  recommendation: VisualRecommendation;
  /** Human notes about data quality that affect presentation. */
  notes: readonly string[];
}>;

const TIME_KEY_SUFFIX = /\.(?:hour|day|week|month|quarter|year)$/u;
const ISO_LIKE = /^\d{4}-\d{2}(?:-\d{2})?(?:T|$)/u;
const DATE_RANGE_LIKE = /^\d{4}-\d{2}-\d{2}T[\d:.]+\s*-\s*\d{4}-\d{2}-\d{2}T[\d:.]+$/u;
const CODE_VALUE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/u;
const CODE_COLUMN = /(?:_id|_type|_code|_key|_sku|_status_code)$|\b(?:id|type|code|sku)\b/iu;
const NUMERIC_TYPES = new Set(["number", "currency", "percent"]);

/** Same signal the chart layer uses so the two never disagree. */
export function looksLikeTimeAxis(column: TraceTableColumn | undefined, key: string, sample: readonly TraceCell[]): boolean {
  if (isPeriodColumn(key, sample)) return false;
  if (column && (column.type === "date" || column.type === "datetime")) return true;
  if (TIME_KEY_SUFFIX.test(key)) return true;
  const strings = sample.filter((v): v is string => typeof v === "string");
  return strings.length > 0 && strings.every((v) => ISO_LIKE.test(v));
}

export function isPeriodColumn(key: string, sample: readonly TraceCell[]): boolean {
  if (key === "compareDateRange" || key.endsWith(".compareDateRange")) return true;
  const strings = sample.filter((v): v is string => typeof v === "string");
  return strings.length > 0 && strings.every((v) => DATE_RANGE_LIKE.test(v));
}

function isBlank(value: TraceCell): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function unitOf(column: TraceTableColumn): string {
  if (column.type === "currency") return column.currency ?? "currency";
  if (column.type === "percent") return "percent";
  return "number";
}

export function profileColumn(column: TraceTableColumn, rows: readonly Readonly<Record<string, TraceCell>>[]): ColumnProfile {
  const values = rows.map((row) => row[column.key]);
  const nonBlank = values.filter((v) => !isBlank(v));
  const distinctValues = new Map<string, TraceCell>();
  for (const value of nonBlank) {
    const k = String(value);
    if (!distinctValues.has(k)) distinctValues.set(k, value);
  }
  const sample = [...distinctValues.keys()].slice(0, 5);
  const numeric = NUMERIC_TYPES.has(column.type);
  // A compare-date-range label starts like an ISO date, so test for the
  // period shape before the time-axis shape.
  const period = !numeric && isPeriodColumn(column.key, nonBlank.slice(0, 5));
  const time = !numeric && !period && looksLikeTimeAxis(column, column.key, nonBlank.slice(0, 5));
  const role: ColumnRole = numeric ? "measure" : time ? "time" : period ? "period" : "dimension";
  const codeLike = role === "dimension"
    && sample.length > 0
    && sample.every((v) => CODE_VALUE.test(v))
    && (CODE_COLUMN.test(column.key.split(".").at(-1) ?? column.key) || CODE_COLUMN.test(column.label));
  return {
    key: column.key,
    label: column.label,
    type: column.type,
    role,
    distinct: distinctValues.size,
    nulls: values.length - nonBlank.length,
    sample,
    codeLike,
    ...(numeric ? { unit: unitOf(column) } : {}),
  };
}

/** Prefer time buckets (`.month`) over the raw timestamp twin the table also carries. */
function pickTimeKey(columns: readonly ColumnProfile[]): string | undefined {
  const times = columns.filter((c) => c.role === "time");
  return times.find((c) => TIME_KEY_SUFFIX.test(c.key))?.key ?? times[0]?.key;
}

/** Ranks measures so the "headline" one (revenue, profit, count) leads. */
function rankMeasures(measures: readonly ColumnProfile[]): readonly ColumnProfile[] {
  const score = (c: ColumnProfile): number => {
    const k = c.key.toLowerCase();
    if (/gross_profit|profit/.test(k)) return 0;
    if (/revenue|takings|sales|amount|value|cost/.test(k)) return 1;
    if (/count|units|hours|quantity/.test(k)) return 2;
    if (/pct|percent|margin|rate|avg|average/.test(k)) return 4;
    return 3;
  };
  return [...measures].sort((a, b) => score(a) - score(b));
}

function sameUnit(measures: readonly ColumnProfile[]): boolean {
  return new Set(measures.map((m) => m.unit)).size <= 1;
}

const LINE_SERIES_MAX = 4;
const STACK_SERIES_MAX = 8;
const BAR_CATEGORY_DEFAULT_LIMIT = 12;

/**
 * The best-guess presentation for a result. Rules follow the standard
 * dataviz guidance the visualiser is also briefed with: lines for ordered
 * time with few series, sorted horizontal bars for rankings, stacked bars for
 * composition, grouped bars for a like-for-like period comparison, and prose
 * or a table when a chart would carry less than the figures.
 */
export function recommendVisual(shape: Omit<ResultShape, "recommendation" | "grain"> & { grain: ResultGrain }): VisualRecommendation {
  const measures = rankMeasures(shape.columns.filter((c) => c.role === "measure"));
  const dims = shape.columns.filter((c) => c.role === "dimension");
  const primary = measures[0];
  const labelledDims = dims.filter((d) => !d.codeLike);
  const preferredDim = (labelledDims.length > 0 ? labelledDims : dims)
    .slice()
    .sort((a, b) => b.distinct - a.distinct)[0];

  if (!primary) return { form: "table", reason: "No numeric measure to plot; the rows are the answer." };
  if (shape.grain === "scalar" || shape.grain === "single-row") {
    return { form: shape.grain === "scalar" ? "kpi" : "prose", yKey: primary.key, reason: "One row: state the figure(s) in prose; a chart of one point communicates less than the number." };
  }
  if (shape.grain === "records") return { form: "table", reason: "Wide or high-cardinality rows read better as a table than as bars." };

  const timeKey = shape.timeKey;
  const periodKey = shape.periodKey;

  if (shape.grain === "time-series" && timeKey) {
    const compatible = measures.filter((m) => m.unit === primary.unit).slice(0, LINE_SERIES_MAX);
    if (shape.rowsHeld < 3) return { form: "kpi", yKey: primary.key, reason: "Fewer than three time points: state the figures rather than draw a line." };
    if (periodKey) {
      return {
        form: "line",
        xKey: timeKey,
        yKey: primary.key,
        seriesKey: periodKey,
        sort: "x",
        reason: "Like-for-like periods on a time axis: overlay one line per period on a shared month axis (January under January), never two calendar years end to end.",
      };
    }
    return {
      form: "line",
      xKey: timeKey,
      yKey: primary.key,
      ...(compatible.length > 1 && sameUnit(compatible) ? { extraYKeys: compatible.slice(1).map((m) => m.key) } : {}),
      sort: "x",
      reason: `Ordered time axis (${shape.rowsHeld} points): a line shows trend and inflection.`,
    };
  }

  if (shape.grain === "time-by-category" && timeKey && preferredDim) {
    if (preferredDim.distinct <= LINE_SERIES_MAX) {
      return { form: "line", xKey: timeKey, yKey: primary.key, seriesKey: preferredDim.key, sort: "x", reason: `Time axis with ${preferredDim.distinct} ${preferredDim.label} series: one line per value stays readable.` };
    }
    return {
      form: "stacked_bar",
      xKey: timeKey,
      yKey: primary.key,
      seriesKey: preferredDim.key,
      sort: "x",
      reason: `Time axis with ${preferredDim.distinct} ${preferredDim.label} values: more than ${LINE_SERIES_MAX} lines tangle, so stack the top ${STACK_SERIES_MAX - 1} plus Other as bars per period.`,
    };
  }

  if (shape.grain === "category" && preferredDim) {
    if (periodKey) {
      return {
        form: "grouped_bar",
        xKey: preferredDim.key,
        yKey: primary.key,
        seriesKey: periodKey,
        sort: "y_desc",
        limit: BAR_CATEGORY_DEFAULT_LIMIT,
        orientation: "horizontal",
        reason: `${preferredDim.label} compared across periods: grouped bars put this period beside last, ranked by the current value.`,
      };
    }
    return {
      form: "bar",
      xKey: preferredDim.key,
      yKey: primary.key,
      sort: "y_desc",
      limit: BAR_CATEGORY_DEFAULT_LIMIT,
      orientation: "horizontal",
      reason: `Ranking of ${preferredDim.distinct} ${preferredDim.label} values: sorted horizontal bars read magnitude fastest and fit long labels.`,
    };
  }

  if (shape.grain === "category-by-category" && dims.length >= 2) {
    const [xDim, colourDim] = (labelledDims.length >= 2 ? labelledDims : dims)
      .slice()
      .sort((a, b) => b.distinct - a.distinct);
    return {
      form: "stacked_bar",
      xKey: xDim!.key,
      yKey: primary.key,
      seriesKey: colourDim!.key,
      sort: "y_desc",
      limit: BAR_CATEGORY_DEFAULT_LIMIT,
      orientation: "horizontal",
      reason: `${xDim!.label} split by ${colourDim!.label}: stacked bars show both the ranking and the mix.`,
    };
  }

  return { form: "table", reason: "No dominant axis; the table is the clearest presentation." };
}

function classifyGrain(args: {
  rowsHeld: number;
  timeKey?: string;
  periodKey?: string;
  dimensions: readonly ColumnProfile[];
  measures: readonly ColumnProfile[];
}): ResultGrain {
  const { rowsHeld, timeKey, dimensions, measures } = args;
  if (rowsHeld <= 1) return dimensions.length > 0 ? "single-row" : "scalar";
  if (measures.length === 0) return "records";
  // A dimension that is unique per row (ids, names on record listings) with
  // several string columns is a record set, not a category axis.
  const informative = dimensions.filter((d) => d.distinct > 1);
  if (informative.length >= 3) return "records";
  if (timeKey) return informative.length === 0 ? "time-series" : "time-by-category";
  if (informative.length === 1) return "category";
  if (informative.length === 2) return "category-by-category";
  return "records";
}

export function profileResult(table: StoredTableResult): ResultShape {
  const rows = table.allRows ?? table.rows;
  const columns = table.columns.map((column) => profileColumn(column, rows));
  const timeKey = pickTimeKey(columns);
  const periodKey = columns.find((c) => c.role === "period")?.key;
  // The raw timestamp twin of a `.month` bucket is not a second axis.
  const dimensions = columns.filter((c) => c.role === "dimension");
  const measures = columns.filter((c) => c.role === "measure");
  const grain = classifyGrain({ rowsHeld: rows.length, timeKey, periodKey, dimensions, measures });
  const notes: string[] = [];
  if (table.rowCount > rows.length) notes.push(`${table.rowCount} rows in the result but only ${rows.length} held; charts plot the held rows.`);
  for (const d of dimensions) {
    if (d.nulls > 0) notes.push(`${d.nulls} row${d.nulls === 1 ? "" : "s"} have no ${d.label}; they plot as "(not set)" if used as an axis or series.`);
    if (d.codeLike) notes.push(`${d.label} holds internal codes (${d.sample.slice(0, 3).join(", ")}); prefer a labelled dimension for axis or series labels.`);
  }
  if (periodKey) notes.push("This is a like-for-like period comparison: use the period as the series so the years overlay on the same months, or chart one period (where). Never plot two calendar years end to end.");
  const partial = { resultId: table.resultId, caption: table.caption, rowCount: table.rowCount, rowsHeld: rows.length, columns, timeKey, periodKey, dimensionKeys: dimensions.map((d) => d.key), measureKeys: measures.map((m) => m.key), grain, notes };
  const recommendation = recommendVisual(partial);
  return { ...partial, recommendation };
}

/** Compact, model-facing rendering of a shape profile. */
export function renderResultShape(shape: ResultShape): string {
  const cols = shape.columns
    .map((c) => {
      const extra = c.role === "measure" ? c.unit : `${c.distinct} distinct${c.nulls ? `, ${c.nulls} blank` : ""}${c.codeLike ? ", codes" : ""}${c.sample.length ? `: ${c.sample.slice(0, 3).map((s) => (s.length > 28 ? `${s.slice(0, 27)}…` : s)).join(" | ")}` : ""}`;
      return `    - ${c.key} [${c.role}] "${c.label}" (${extra})`;
    })
    .join("\n");
  const rec = shape.recommendation;
  const mapping = [
    rec.xKey ? `x=${rec.xKey}` : null,
    rec.yKey ? `y=${rec.yKey}` : null,
    rec.extraYKeys?.length ? `extraY=${rec.extraYKeys.join(",")}` : null,
    rec.seriesKey ? `series=${rec.seriesKey}` : null,
    rec.sort ? `sort=${rec.sort}` : null,
    rec.limit ? `limit=${rec.limit}` : null,
    rec.orientation ? `orientation=${rec.orientation}` : null,
    rec.where ? `where=${rec.where.key}=${rec.where.equals}` : null,
  ].filter(Boolean).join(" ");
  return [
    `- resultId ${shape.resultId} — "${shape.caption}" (${shape.rowsHeld} of ${shape.rowCount} rows held; grain: ${shape.grain})`,
    cols,
    `    best guess: ${rec.form}${mapping ? ` (${mapping})` : ""} — ${rec.reason}`,
    ...shape.notes.map((n) => `    note: ${n}`),
  ].join("\n");
}
