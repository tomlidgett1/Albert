import type { TraceTableColumn } from "../../../shared/src/index.js";
import type { CubeLoadResult } from "./types.js";

type CubeAnnotation = CubeLoadResult["annotation"][string] | undefined;

function validCurrency(currency: string | undefined): string | undefined {
  const normalized = currency?.trim().toUpperCase();
  return normalized && /^[A-Z]{3}$/u.test(normalized) ? normalized : undefined;
}

/** Maps Cube's governed presentation metadata onto the durable trace contract. */
export function traceColumnFromCube(
  key: string,
  annotation: CubeAnnotation,
  currency?: string,
): TraceTableColumn {
  const format = annotation?.format?.trim().toLowerCase();
  const type: TraceTableColumn["type"] = format === "currency"
    ? "currency"
    : format === "percent"
      ? "percent"
      : annotation?.type === "number"
        ? "number"
        : annotation?.type === "time" || /(?:_at|_time|date)(?:\.[a-z]+)?$/u.test(key)
          ? "datetime"
          : "string";
  const currencyCode = type === "currency" ? validCurrency(currency) : undefined;
  return {
    key,
    label: annotation?.shortTitle ?? key.split(".")[1] ?? key,
    type,
    ...(currencyCode ? { currency: currencyCode } : {}),
  };
}
