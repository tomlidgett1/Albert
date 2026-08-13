import type { TraceCell, TraceTableColumn } from "@/packages/shared/src";
import { ALBERT_DEFAULT_CURRENCY } from "@/packages/albert-v3/src/agent-config/defaults";
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
    const normalized = Math.abs(numericValue) <= 1 ? numericValue : numericValue / 100;
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
