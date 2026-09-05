import type { TraceCell, TraceTableColumn } from "@/packages/shared/src";
import { ALBERT_DEFAULT_CURRENCY } from "@/packages/albert-v3/src/agent-config/defaults";
import { columnKeysEquivalent } from "@/packages/albert-v3/src/cube/presentation";
import type { DashboardColumnPresentationItem } from "@/services/control-plane/src/dashboard-repository";
import { formatTraceCell, traceCellNumber } from "./analytical-values";

function formatExactDecimal(formatter: Intl.NumberFormat, value: string | number): string {
  const format = formatter.format as unknown as (input: string | number | bigint) => string;
  return format(value);
}

/** Compact dashboard presentation without changing the governed stored value. */
export function formatDashboardCell(
  value: unknown,
  column: TraceTableColumn,
  presentation?: DashboardColumnPresentationItem,
): string {
  if (value === null || value === undefined) return "—";
  const displayType = presentation?.format === "text"
    ? "string"
    : presentation?.format ?? column.type;
  const displayColumn: TraceTableColumn = { ...column, type: displayType };
  if (displayType === "date" || displayType === "datetime") {
    return formatTraceCell(
      typeof value === "string" || typeof value === "number" ? value : String(value),
      displayColumn,
    );
  }
  if (displayType !== "number" && displayType !== "currency" && displayType !== "percent") return String(value);

  const traceValue: TraceCell = typeof value === "number" || typeof value === "string" ? value : String(value);
  const numericValue = traceCellNumber(traceValue);
  if (numericValue === null) return String(value);
  const exactValue = typeof traceValue === "string" ? traceValue.trim() : traceValue;
  const decimals = presentation?.decimals;

  if (displayType === "percent") {
    const normalized = column.percentScale === "percent" ? numericValue / 100
      : column.percentScale === "ratio" ? numericValue
        : Math.abs(numericValue) <= 1 ? numericValue : numericValue / 100;
    return new Intl.NumberFormat("en-AU", {
      style: "percent",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals ?? 2,
      signDisplay: "exceptZero",
    }).format(normalized);
  }

  if (displayType === "currency") {
    try {
      return formatExactDecimal(new Intl.NumberFormat("en-AU", {
        style: "currency",
        // Legacy V3 snapshots created before Cube format metadata was retained
        // have no code. Their governed runtime default was AUD.
        currency: column.currency ?? ALBERT_DEFAULT_CURRENCY,
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: decimals ?? 2,
        maximumFractionDigits: decimals ?? 2,
      }), exactValue);
    } catch {
      // Malformed presentation metadata must not hide the governed value.
    }
  }

  return formatExactDecimal(new Intl.NumberFormat("en-AU", {
    minimumFractionDigits: decimals ?? 0,
    maximumFractionDigits: decimals ?? 2,
  }), exactValue);
}

const NUMERIC_DASHBOARD_COLUMN_TYPES = new Set(["number", "currency", "percent"]);

/**
 * One canonical column identity (ADR 0134): an exact key first, then the
 * same member spelled with dots or underscores, then the same member under
 * a different time bucket (a display keyed to `completed_at` still finds
 * `completed_at_month` after Truncate date).
 */
export function resolveDashboardColumn<Column extends Readonly<{ key: string }>>(
  columns: readonly Column[],
  wanted: string | undefined,
): Column | null {
  if (!wanted) return null;
  return columns.find((column) => column.key === wanted)
    ?? columns.find((column) => column.key.replaceAll(".", "_") === wanted.replaceAll(".", "_"))
    ?? columns.find((column) => columnKeysEquivalent(column.key, wanted))
    ?? null;
}

export function firstNumericDashboardColumn<Column extends Readonly<{ key: string; type: string }>>(
  columns: readonly Column[],
): Column | null {
  return columns.find((column) => NUMERIC_DASHBOARD_COLUMN_TYPES.has(column.type)) ?? null;
}

/** Start date of a compare label like "2026-08-01 - 2026-08-30", for ordering. */
function compareRangeStart(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(value.slice(0, 10));
}

export type KpiPresentation = Readonly<{
  value: string;
  direction: "up" | "down" | "flat";
  /** e.g. "12.4%" or "3.1 pts"; null when there is no comparison row. */
  magnitude: string | null;
  /** Whether the change is good news, given which direction the owner prefers. */
  tone: "good" | "bad" | "neutral";
}>;

/**
 * The KPI card's headline value and period-on-period delta, shared by the
 * dashboard tiles and the live build preview so both present identically.
 * Rows may be a single value or a two-period compareDateRange result; the
 * later range start is the current period.
 */
export type KpiComparison = "percent_difference" | "difference" | "percent_of" | "absolute";
export type KpiBetterWhen = "higher" | "lower";

export function computeKpiPresentation(input: Readonly<{
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, unknown>>[];
  valueKey?: string | undefined;
  presentation?: DashboardColumnPresentationItem | undefined;
  /** Sigma's KPI comparison: how the change against the prior value is shown. */
  comparison?: KpiComparison | undefined;
  /** Which direction of change is good; colours the delta. */
  betterWhen?: KpiBetterWhen | undefined;
}>): KpiPresentation | null {
  const { columns, rows, presentation } = input;
  const comparison = input.comparison ?? "percent_difference";
  const betterWhen = input.betterWhen ?? "higher";
  if (rows.length === 0) return null;
  const valueColumn = resolveDashboardColumn(columns, input.valueKey)
    ?? firstNumericDashboardColumn(columns);
  if (!valueColumn) return null;

  const compareColumn = resolveDashboardColumn(columns, "compareDateRange");
  let currentRow = rows[0]!;
  let previousRow: Readonly<Record<string, unknown>> | null = rows.length === 2 ? rows[1]! : null;
  if (compareColumn && rows.length >= 2) {
    const ordered = [...rows].sort((left, right) => (
      compareRangeStart(right[compareColumn.key]) - compareRangeStart(left[compareColumn.key])
    ));
    currentRow = ordered[0]!;
    previousRow = ordered[1] ?? null;
  }

  // A KPI shows a level, not a change: percent values render unsigned here
  // (the shared cell formatter's exceptZero sign is for delta columns).
  const rawValue = currentRow[valueColumn.key];
  const rawNumber = traceCellNumber((rawValue ?? null) as TraceCell);
  const value = (presentation?.format ?? valueColumn.type) === "percent" && rawNumber !== null
    ? new Intl.NumberFormat("en-AU", {
      style: "percent",
      minimumFractionDigits: presentation?.decimals,
      maximumFractionDigits: presentation?.decimals ?? 2,
    }).format(valueColumn.percentScale === "percent" ? rawNumber / 100
      : valueColumn.percentScale === "ratio" ? rawNumber
        : Math.abs(rawNumber) <= 1 ? rawNumber : rawNumber / 100)
    : formatDashboardCell(rawValue, valueColumn, presentation);
  const previousNumber = previousRow
    ? traceCellNumber((previousRow[valueColumn.key] ?? null) as TraceCell)
    : null;
  // Percent measures compare in points; everything else as the owner's
  // chosen comparison (relative change by default).
  const percentColumn = valueColumn.type === "percent";
  let delta: number | null = null;
  let magnitude: string | null = null;
  if (rawNumber !== null && previousNumber !== null) {
    const change = rawNumber - previousNumber;
    if (percentColumn && (comparison === "percent_difference" || comparison === "difference")) {
      const points = valueColumn.percentScale === "ratio" ? change * 100 : change;
      delta = points;
      magnitude = `${formatMagnitude(Math.abs(points))} pts`;
    } else if (comparison === "difference") {
      delta = change;
      magnitude = formatDashboardCell(Math.abs(change), valueColumn, presentation);
    } else if (comparison === "percent_of") {
      delta = change;
      magnitude = previousNumber !== 0 ? `${formatMagnitude(Math.abs((rawNumber / previousNumber) * 100))}% of prior` : null;
    } else if (comparison === "absolute") {
      delta = change;
      magnitude = `${formatDashboardCell(previousNumber, valueColumn, presentation)} prior`;
    } else if (previousNumber !== 0) {
      delta = (change / Math.abs(previousNumber)) * 100;
      magnitude = `${formatMagnitude(Math.abs(delta))}%`;
    }
  }
  const direction = delta === null || Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "up" : "down";
  const tone: KpiPresentation["tone"] = direction === "flat" || magnitude === null
    ? "neutral"
    : (direction === "up") === (betterWhen === "higher") ? "good" : "bad";
  return Object.freeze({ value, direction, magnitude, tone });
}

function formatMagnitude(value: number): string {
  return value >= 100 ? Math.round(value).toLocaleString("en-AU") : value.toFixed(1);
}
