import { normalizeTimestamp } from "../../packages/connector-sdk/src/index.js";

/**
 * Query-safe, lossless-enough index of every leaf in a Square source object.
 *
 * The immutable raw payload remains the byte-for-byte authority. This index is
 * a governed analytical projection: it turns arbitrary nested fields, arrays,
 * maps, future additive properties and enum values into rows that Cube can
 * discover and filter without promoting thousands of unstable JSON paths to
 * physical SQL columns.
 */
export type SquareIndexedValue = Readonly<{
  /** JSONPath-like path with array ordinals erased, for catalogue lookup. */
  path: string;
  /** Exact RFC 6901 pointer to this occurrence in the source object. */
  pointer: string;
  ordinal: number;
  kind: "null" | "string" | "number" | "boolean" | "array" | "object";
  textValue: string | null;
  numericValue: string | null;
  booleanValue: boolean | null;
  timestampValue: string | null;
  /** The unmodified scalar or explicit empty container as JSON-compatible data. */
  rawValue: string | number | boolean | null | readonly [] | Readonly<Record<string, never>>;
}>;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;
const EXACT_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

export function buildSquareFieldIndex(value: unknown): readonly SquareIndexedValue[] {
  const indexed: SquareIndexedValue[] = [];
  const ordinals = new Map<string, number>();

  const visit = (current: unknown, path: string, pointer: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(
        item,
        `${path}[]`,
        `${pointer}/${index}`,
      ));
      // Empty arrays are meaningful source state and remain answerable.
      if (current.length === 0) push(Object.freeze([]), `${path}[]`, pointer);
      return;
    }
    if (isObject(current)) {
      const entries = Object.entries(current);
      // Empty maps are meaningful too. Dynamic metadata/custom-attribute keys
      // otherwise disappear from the analytical projection.
      if (entries.length === 0) push(Object.freeze({}), path || "$", pointer);
      for (const [key, item] of entries) {
        visit(
          item,
          path ? `${path}.${escapePathSegment(key)}` : escapePathSegment(key),
          `${pointer}/${escapePointerSegment(key)}`,
        );
      }
      return;
    }
    push(current, path || "$", pointer);
  };

  const push = (raw: unknown, path: string, pointer: string): void => {
    const ordinal = ordinals.get(path) ?? 0;
    ordinals.set(path, ordinal + 1);
    const scalar = squareScalar(raw);
    indexed.push(Object.freeze({ path, pointer: pointer || "", ordinal, ...scalar }));
  };

  // Census/query paths are rooted at the Square entity itself (`amount_money.amount`),
  // not at an implementation-specific `$` token. A scalar root still receives
  // `$`, but ordinary API objects now line up byte-for-byte with the pinned SDK
  // census and the governed catalogue.
  visit(value, "", "");
  return Object.freeze(indexed);
}

/** Resolve a native snake_case field path without accepting prototype keys. */
export function squareValueAtPath(
  value: unknown,
  path: string,
): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

export function squareStringAtPath(value: unknown, path: string): string | null {
  const current = squareValueAtPath(value, path);
  return typeof current === "string" && current.trim() ? current : null;
}

export function squareTimestampAtPath(value: unknown, path: string): string | null {
  const current = squareValueAtPath(value, path);
  return normalizeTimestamp(current).utc;
}

/**
 * Square Money.amount is an integer in the currency's smallest denomination.
 * Keep it as a decimal string here; display-unit conversion belongs to the
 * semantic layer where the ISO-4217 exponent is explicit.
 */
export function squareMinorUnits(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/u.test(value.trim())) return value.trim();
  return null;
}

function squareScalar(raw: unknown): Omit<SquareIndexedValue, "path" | "pointer" | "ordinal"> {
  if (Array.isArray(raw)) {
    return {
      kind: "array",
      textValue: null,
      numericValue: null,
      booleanValue: null,
      timestampValue: null,
      rawValue: Object.freeze([]) as readonly [],
    };
  }
  if (isObject(raw)) {
    return {
      kind: "object",
      textValue: null,
      numericValue: null,
      booleanValue: null,
      timestampValue: null,
      rawValue: Object.freeze({}),
    };
  }
  if (raw === null || raw === undefined) {
    return {
      kind: "null",
      textValue: null,
      numericValue: null,
      booleanValue: null,
      timestampValue: null,
      rawValue: null,
    };
  }
  if (typeof raw === "boolean") {
    return {
      kind: "boolean",
      textValue: String(raw),
      numericValue: null,
      booleanValue: raw,
      timestampValue: null,
      rawValue: raw,
    };
  }
  if (typeof raw === "number") {
    const text = Number.isFinite(raw) ? String(raw) : null;
    return {
      kind: "number",
      textValue: text,
      numericValue: text && EXACT_DECIMAL.test(text) ? text : null,
      booleanValue: null,
      timestampValue: null,
      rawValue: Number.isFinite(raw) ? raw : null,
    };
  }
  const text = String(raw);
  return {
    kind: "string",
    textValue: text,
    numericValue: EXACT_DECIMAL.test(text.trim()) ? text.trim() : null,
    booleanValue: null,
    timestampValue: ISO_TIMESTAMP.test(text) ? normalizeTimestamp(text).utc : null,
    rawValue: text,
  };
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function escapePathSegment(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
    ? value
    : `[${JSON.stringify(value)}]`;
}
