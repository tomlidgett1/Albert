import { normalizeTimestamp } from "../../packages/connector-sdk/src/index.js";

export type ShopifyIndexedValue = Readonly<{
  schemaPath: string;
  pointer: string;
  ordinal: number;
  valueKind: "null" | "string" | "number" | "boolean";
  stringValue: string | null;
  numericValue: string | null;
  booleanValue: boolean | null;
  datetimeValue: string | null;
  jsonValue: string | number | boolean | null;
}>;

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;

/**
 * Lossless scalar index used by the exhaustive Shopify field cube.
 *
 * Array positions are removed from schemaPath so one official GraphQL path has
 * one semantic identity, while pointer retains the exact RFC 6901 occurrence.
 * The complete node is still retained in immutable raw storage and rawNode.
 */
export function buildShopifyFieldIndex(value: unknown): readonly ShopifyIndexedValue[] {
  const result: ShopifyIndexedValue[] = [];
  const ordinals = new Map<string, number>();

  const push = (raw: unknown, schemaPath: string, pointer: string): void => {
    const ordinal = ordinals.get(schemaPath) ?? 0;
    ordinals.set(schemaPath, ordinal + 1);
    if (raw === null || raw === undefined) {
      result.push(Object.freeze({
        schemaPath, pointer, ordinal, valueKind: "null", stringValue: null,
        numericValue: null, booleanValue: null, datetimeValue: null, jsonValue: null,
      }));
      return;
    }
    if (typeof raw === "boolean") {
      result.push(Object.freeze({
        schemaPath, pointer, ordinal, valueKind: "boolean", stringValue: String(raw),
        numericValue: null, booleanValue: raw, datetimeValue: null, jsonValue: raw,
      }));
      return;
    }
    if (typeof raw === "number") {
      const stringValue = Number.isFinite(raw) ? String(raw) : null;
      result.push(Object.freeze({
        schemaPath, pointer, ordinal, valueKind: "number", stringValue,
        numericValue: stringValue && DECIMAL.test(stringValue) ? stringValue : null,
        booleanValue: null, datetimeValue: null, jsonValue: Number.isFinite(raw) ? raw : null,
      }));
      return;
    }
    const stringValue = String(raw);
    result.push(Object.freeze({
      schemaPath, pointer, ordinal, valueKind: "string", stringValue,
      numericValue: DECIMAL.test(stringValue.trim()) ? stringValue.trim() : null,
      booleanValue: null,
      datetimeValue: ISO_INSTANT.test(stringValue) ? normalizeTimestamp(stringValue).utc : null,
      jsonValue: stringValue,
    }));
  };

  const visit = (current: unknown, schemaPath: string, pointer: string): void => {
    if (Array.isArray(current)) {
      if (current.length === 0) push(null, `${schemaPath}[]`, pointer);
      current.forEach((item, index) => visit(item, `${schemaPath}[]`, `${pointer}/${index}`));
      return;
    }
    if (isObject(current)) {
      const entries = Object.entries(current);
      if (entries.length === 0) push(null, schemaPath || "$", pointer);
      for (const [key, item] of entries) {
        visit(
          item,
          schemaPath ? `${schemaPath}.${safePathSegment(key)}` : safePathSegment(key),
          `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        );
      }
      return;
    }
    push(current, schemaPath || "$", pointer);
  };

  visit(value, "", "");
  return Object.freeze(result);
}

function safePathSegment(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) ? value : `[${JSON.stringify(value)}]`;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

