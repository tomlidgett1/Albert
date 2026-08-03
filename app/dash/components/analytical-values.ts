import type { TraceCell, TraceTableColumn } from "@/packages/shared/src";

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
  const parsed = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
    ...(dateOnly ? { timeZone: "UTC" } : {}),
  }).format(parsed);
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

export function formatTraceCell(value: TraceCell, column: TraceTableColumn): string {
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
