import type { TraceCell, TraceRowFormat, TraceTableColumn } from "@/packages/shared/src";

const exactDecimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const numericColumnTypes = new Set<TraceTableColumn["type"]>(["number", "currency", "percent"]);

function formatExactDecimal(formatter: Intl.NumberFormat, value: string | number): string {
  // Modern Intl implementations accept a decimal string without first
  // rounding it through a binary float. TypeScript's lib still types this as
  // number | bigint, so keep the wider runtime contract local to this helper.
  const format = formatter.format as unknown as (input: string | number | bigint) => string;
  return format(value);
}

function formatDate(value: string, includeTime: boolean): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const bucketMidnight = /^\d{4}-\d{2}-\d{2}[T ]00:00(?::00)?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/u.test(value);
  // A semantic date bucket is a calendar label, not an instant to shift into
  // the browser timezone. Preserve its YYYY-MM-DD even when Cube adds `Z`.
  const calendarDate = dateOnly || bucketMidnight;
  const parsed = new Date(calendarDate ? `${value.slice(0, 10)}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  // Cube time buckets arrive as naive midnight timestamps; showing "12:00 am"
  // on every monthly or daily bucket is noise, so midnight drops the time.
  const midnight = calendarDate || (parsed.getHours() === 0 && parsed.getMinutes() === 0);
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(includeTime && !midnight ? { hour: "numeric", minute: "2-digit" } : {}),
    ...(calendarDate ? { timeZone: "UTC" } : {}),
  }).format(parsed);
}

const CHART_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

/**
 * Formats an ISO-like axis value for charts, sized to the Cube granularity
 * carried in the member key ("ls_sales.sold_at.month" formats as "Feb 2026").
 * Returns null when the value is not date-shaped so callers can fall back.
 */
export function formatChartDateLabel(value: TraceCell, memberKey: string): string | null {
  if (typeof value !== "string") return null;
  // Nivo's truncateTickAt shortens the raw tick *before* format runs, so a
  // truncated ISO like "2026-06-01T00:00:0..." must still parse.
  const trimmed = value.trim().replace(/\.{2,}$/u, "");
  const match = CHART_DATE_PATTERN.exec(trimmed)
    ?? /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2}))?)?/u.exec(trimmed);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00"] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  if (Number.isNaN(date.getTime())) return null;
  const granularity = memberKey.split(".").at(-1)?.toLowerCase() ?? "";
  if (granularity === "year") return year!;
  if (granularity === "quarter") return `Q${Math.floor((Number(month) - 1) / 3) + 1} ${year}`;
  if (granularity === "month") {
    return new Intl.DateTimeFormat("en-AU", { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
  }
  // Week / day buckets: short calendar label (e.g. "1 Jun 2026").
  if (granularity === "week" || granularity === "day" || granularity === "date") {
    return new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }
  const midnight = hour === "00" && minute === "00";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(midnight ? {} : { hour: "numeric", minute: "2-digit" }),
    timeZone: "UTC",
  }).format(date);
}

export function traceCellNumber(value: TraceCell): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !exactDecimalPattern.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isExplainableTraceCell(value: TraceCell, column: TraceTableColumn): boolean {
  return numericColumnTypes.has(column.type) && traceCellNumber(value) !== null;
}

export function formatTraceCell(value: TraceCell, column: TraceTableColumn, rowFormat?: TraceRowFormat | null): string {
  // A pivoted table stacks measures with different units in the same column,
  // so the row's own format outranks the column type for its numeric cells.
  if (rowFormat && numericColumnTypes.has(column.type)) {
    column = { ...column, type: rowFormat.type, currency: rowFormat.currency };
  }
  if (value === null) return "—";
  if (typeof value === "string" && column.type === "date") return formatDate(value, false);
  if (typeof value === "string" && column.type === "datetime") return formatDate(value, true);
  if (!numericColumnTypes.has(column.type)) return String(value);

  const numericValue = traceCellNumber(value);
  if (numericValue === null) return String(value);
  const exactValue = typeof value === "string" ? value.trim() : value;

  if (column.type === "currency" && column.currency) {
    try {
      return formatExactDecimal(new Intl.NumberFormat("en-AU", {
        style: "currency",
        currency: column.currency,
        currencyDisplay: "code",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }), exactValue);
    } catch {
      // Invalid metadata must not stop an otherwise valid analytical trace.
    }
  }

  if (column.type === "percent") {
    const normalized = Math.abs(numericValue) <= 1 ? numericValue : numericValue / 100;
    return new Intl.NumberFormat("en-AU", {
      style: "percent",
      maximumFractionDigits: 2,
      signDisplay: "exceptZero",
    }).format(normalized);
  }

  return formatExactDecimal(new Intl.NumberFormat("en-AU", {
    minimumFractionDigits: column.type === "currency" ? 2 : 0,
    maximumFractionDigits: 4,
  }), exactValue);
}

export function formatCompactTraceCell(value: TraceCell, column: TraceTableColumn): string {
  const numericValue = traceCellNumber(value);
  if (numericValue === null) return String(value ?? "—");
  if (column.type === "currency" && column.currency) {
    try {
      return new Intl.NumberFormat("en-AU", {
        style: "currency",
        currency: column.currency,
        currencyDisplay: "code",
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(numericValue);
    } catch {
      // Fall back to an unqualified number when metadata is malformed.
    }
  }
  if (column.type === "percent") return formatTraceCell(value, column);
  return new Intl.NumberFormat("en-AU", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(numericValue);
}
