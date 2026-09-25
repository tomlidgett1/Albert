import { normalizeTimestamp } from "../../packages/connector-sdk/src/index.js";

export type LightspeedXIndexedValue = Readonly<{
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

// The complete JSON number grammar. Keeping exponent notation intact matters
// for lossless source-field answers: `1e3` and `1000` are numerically equal,
// but they are not the same vendor wire value.
const EXACT_JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;

/**
 * Lossless governed projection of every runtime leaf. Array ordinals are
 * retained in RFC 6901 pointers and erased in query paths so unknown additive
 * fields are queryable immediately without mutating physical DDL.
 */
export function buildLightspeedXFieldIndex(value: unknown): readonly LightspeedXIndexedValue[] {
  const rows: LightspeedXIndexedValue[] = [];
  const ordinals = new Map<string, number>();
  const push = (raw: unknown, path: string, pointer: string): void => {
    const ordinal = ordinals.get(path) ?? 0;
    ordinals.set(path, ordinal + 1);
    rows.push(Object.freeze({ path, pointer, ordinal, ...scalar(raw) }));
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
        const segment = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)
          ? key
          : `[${JSON.stringify(key)}]`;
        visit(item, `${path}.${segment}`, `${pointer}/${escapePointer(key)}`);
      }
      return;
    }
    push(current, path || "$", pointer);
  };
  visit(value, "$", "");
  return Object.freeze(rows);
}

export function lightspeedXValueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * JSON.parse loses int64 cursor/ID precision and also rewrites decimal wire
 * representations (for example 12.3400). This lexer quotes every JSON number
 * token before parsing so both integers and decimals remain exact. The typed
 * field index exposes those exact strings as numeric values for SQL casting.
 */
export function parseLightspeedXJsonLossless(text: string): unknown {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      index += 1;
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
      if (match) {
        const token = match[0];
        result += JSON.stringify(token);
        index += token.length;
        continue;
      }
    }
    result += char;
    index += 1;
  }
  return JSON.parse(result) as unknown;
}

export function enrichLightspeedXPayload(
  payload: unknown,
  parent: Readonly<Record<string, string>> | null,
): unknown {
  if (!parent || Object.keys(parent).length === 0) return payload;
  if (isObject(payload)) return { ...payload, _albert: { parent: { ...parent } } };
  return { value: payload, _albert: { parent: { ...parent } } };
}

function scalar(raw: unknown): Omit<LightspeedXIndexedValue, "path" | "pointer" | "ordinal"> {
  if (raw === null || raw === undefined) {
    return { kind: "null", textValue: null, numericValue: null, booleanValue: null, timestampValue: null, rawValue: null };
  }
  if (typeof raw === "boolean") {
    return { kind: "boolean", textValue: String(raw), numericValue: null, booleanValue: raw, timestampValue: null, rawValue: raw };
  }
  if (typeof raw === "number") {
    const text = Number.isFinite(raw) ? String(raw) : null;
    return { kind: "number", textValue: text, numericValue: text, booleanValue: null, timestampValue: null, rawValue: Number.isFinite(raw) ? raw : null };
  }
  const text = String(raw);
  return {
    kind: "string",
    textValue: text,
    numericValue: EXACT_JSON_NUMBER.test(text.trim()) ? text.trim() : null,
    booleanValue: null,
    timestampValue: ISO_TIMESTAMP.test(text) ? normalizeTimestamp(text).utc : null,
    rawValue: text,
  };
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
