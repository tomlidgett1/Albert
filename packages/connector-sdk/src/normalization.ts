import { createHash } from "node:crypto";
import type {
  NormalizedDecimal,
  NormalizedTimestamp,
  SourceRecordProjection,
} from "./index.js";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function expandExponent(value: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/u.exec(value);
  if (!match) return value;
  const [, sign, integer, fraction = "", exponentText] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  const unsigned =
    decimalIndex <= 0
      ? `0.${"0".repeat(-decimalIndex)}${digits}`
      : decimalIndex >= digits.length
        ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
        : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return `${sign === "-" ? "-" : ""}${unsigned}`;
}

export function normalizeDecimal(
  raw: unknown,
  currency: unknown = null,
): NormalizedDecimal {
  const rawValue = typeof raw === "string" || typeof raw === "number" ? raw : null;
  const candidate = rawValue === null ? null : expandExponent(String(rawValue).trim());
  const exact =
    candidate !== null && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(candidate)
      ? candidate.replace(/^-0(?:\.0+)?$/u, "0")
      : null;
  const normalizedCurrency =
    typeof currency === "string" && /^[A-Za-z]{3}$/u.test(currency)
      ? currency.toUpperCase()
      : null;
  return { raw: rawValue, exact, currency: normalizedCurrency };
}

export function normalizeTimestamp(
  raw: unknown,
  options: Readonly<{ unixUnit?: "seconds" | "milliseconds" }> = {},
): NormalizedTimestamp {
  const rawValue = typeof raw === "string" || typeof raw === "number" ? raw : null;
  if (rawValue === null) return { raw: null, utc: null };

  let timestamp: number;
  if (typeof rawValue === "number") {
    timestamp = options.unixUnit === "seconds" ? rawValue * 1_000 : rawValue;
  } else {
    const xeroDate = /^\/Date\(([-+]?\d+)(?:[+-]\d{4})?\)\/$/u.exec(rawValue);
    timestamp = xeroDate ? Number(xeroDate[1]) : Date.parse(rawValue);
  }
  return {
    raw: rawValue,
    utc: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
  };
}

export function projectSourceRecord(input: Readonly<{
  schemaVersion: string;
  fields: Readonly<Record<string, unknown>>;
  money?: Readonly<Record<string, readonly [unknown, unknown?]>>;
  timestamps?: Readonly<
    Record<string, readonly [unknown, Readonly<{ unixUnit?: "seconds" | "milliseconds" }> | undefined]>
  >;
  tombstone?: boolean;
}>): SourceRecordProjection {
  return {
    schemaVersion: input.schemaVersion,
    fields: input.fields,
    money: input.money
      ? Object.fromEntries(
          Object.entries(input.money).map(([key, [value, currency]]) => [
            key,
            normalizeDecimal(value, currency),
          ]),
        )
      : undefined,
    timestamps: input.timestamps
      ? Object.fromEntries(
          Object.entries(input.timestamps).map(([key, [value, options]]) => [
            key,
            normalizeTimestamp(value, options),
          ]),
        )
      : undefined,
    tombstone: input.tombstone,
  };
}
