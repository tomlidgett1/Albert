import { normalizeTimestamp } from "../../packages/connector-sdk/src/index.js";

/**
 * One query-safe occurrence of a scalar in an exact Momence response object.
 *
 * `path` erases array positions so it has one stable semantic identity across
 * records. `pointer` retains the exact RFC 6901 occurrence. The immutable raw
 * payload remains authoritative; this index exists so every documented nested
 * field (and every future additive field after review) can be filtered and
 * aggregated without manufacturing hundreds of brittle SQL columns.
 */
export type MomenceIndexedValue = Readonly<{
  path: string;
  pointer: string;
  ordinal: number;
  kind: "null" | "string" | "number" | "boolean";
  textValue: string | null;
  numericValue: string | null;
  booleanValue: boolean | null;
  timestampValue: string | null;
  rawValue: string | number | boolean | null;
}>;

const EXACT_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const ISO_TEMPORAL = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?/u;

export function buildMomenceFieldIndex(value: unknown): readonly MomenceIndexedValue[] {
  const indexed: MomenceIndexedValue[] = [];
  const ordinals = new Map<string, number>();

  const push = (raw: unknown, path: string, pointer: string): void => {
    const ordinal = ordinals.get(path) ?? 0;
    ordinals.set(path, ordinal + 1);
    indexed.push(Object.freeze({
      path,
      pointer,
      ordinal,
      ...scalar(raw),
    }));
  };

  const visit = (current: unknown, path: string, pointer: string): void => {
    if (Array.isArray(current)) {
      if (current.length === 0) push(null, `${path}[]`, pointer);
      current.forEach((item, index) => visit(item, `${path}[]`, `${pointer}/${index}`));
      return;
    }
    if (isObject(current)) {
      const entries = Object.entries(current);
      if (entries.length === 0) push(null, path || "$", pointer);
      for (const [key, item] of entries) {
        const segment = safePathSegment(key);
        visit(
          item,
          segment.startsWith("[") ? `${path}${segment}` : `${path}.${segment}`,
          `${pointer}/${escapePointerSegment(key)}`,
        );
      }
      return;
    }
    push(current, path || "$", pointer);
  };

  visit(value, "$", "");
  return Object.freeze(indexed);
}

export function momenceValueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

export function momenceStringAtPath(value: unknown, ...paths: readonly string[]): string | null {
  for (const path of paths) {
    const candidate = momenceValueAtPath(value, path);
    if ((typeof candidate === "string" || typeof candidate === "number") && String(candidate).trim()) {
      return String(candidate).trim();
    }
  }
  return null;
}

export function momenceTimestampAtPath(value: unknown, ...paths: readonly string[]): string | null {
  for (const path of paths) {
    const normalized = normalizeTimestamp(momenceValueAtPath(value, path)).utc;
    if (normalized) return normalized;
  }
  return null;
}

function scalar(raw: unknown): Omit<MomenceIndexedValue, "path" | "pointer" | "ordinal"> {
  if (raw === null || raw === undefined) {
    return {
      kind: "null", textValue: null, numericValue: null,
      booleanValue: null, timestampValue: null, rawValue: null,
    };
  }
  if (typeof raw === "boolean") {
    return {
      kind: "boolean", textValue: String(raw), numericValue: null,
      booleanValue: raw, timestampValue: null, rawValue: raw,
    };
  }
  if (typeof raw === "number") {
    const textValue = Number.isFinite(raw) ? String(raw) : null;
    return {
      kind: "number",
      textValue,
      numericValue: textValue && EXACT_DECIMAL.test(textValue) ? textValue : null,
      booleanValue: null,
      timestampValue: null,
      rawValue: Number.isFinite(raw) ? raw : null,
    };
  }
  const textValue = String(raw);
  return {
    kind: "string",
    textValue,
    numericValue: EXACT_DECIMAL.test(textValue.trim()) ? textValue.trim() : null,
    booleanValue: null,
    timestampValue: ISO_TEMPORAL.test(textValue) ? normalizeTimestamp(textValue).utc : null,
    rawValue: textValue,
  };
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function safePathSegment(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
    ? value
    : `[${JSON.stringify(value)}]`;
}
