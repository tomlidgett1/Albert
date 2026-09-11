import { tool as sdkTool, type ToolOptions } from "@openai/agents";
import { z } from "zod";

type Schema = Record<string, unknown>;
const resultKeys = new Set(["resultId", "secondResultId", "citedResultIds", "resultIds", "dataRef"]);

function nullable(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const value = schema as Schema;
  return value.type === "null" || (Array.isArray(value.type) && value.type.includes("null"))
    || (Array.isArray(value.anyOf) && value.anyOf.some(nullable));
}

/** Native functions need no Responses-SDK requirement to spell every unused field null. */
export function nativeParameterSchema(schema: Schema, key = ""): Schema {
  const result: Schema = { ...schema };
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const properties = schema.properties as Record<string, Schema>;
    result.properties = Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, nativeParameterSchema(value, name)]));
    if (Array.isArray(schema.required)) result.required = schema.required.filter((name) => typeof name === "string" && !nullable(properties[name]));
  }
  for (const union of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[union])) result[union] = schema[union].map((entry) => nativeParameterSchema(entry as Schema, key));
  }
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) result.items = nativeParameterSchema(schema.items as Schema, key);
  if (resultKeys.has(key) && schema.type === "string") result.pattern = "^r[1-9][0-9]{0,5}$";
  return result;
}

/** Fill only declared nullable fields. Unknown keys and all real constraints still fail. */
export function fillNullableArguments(schema: Schema, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  let selected = schema;
  if (Array.isArray(schema.anyOf)) {
    const kind = Array.isArray(value) ? "array" : typeof value;
    selected = (schema.anyOf.find((entry) => entry && typeof entry === "object" && (entry as Schema).type === kind) as Schema | undefined) ?? schema;
  }
  if (Array.isArray(value)) {
    const item = selected.items;
    return item && typeof item === "object" && !Array.isArray(item) ? value.map((entry) => fillNullableArguments(item as Schema, entry)) : value;
  }
  if (typeof value !== "object") return value;
  const properties = selected.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return value;
  const result: Record<string, unknown> = { ...value };
  for (const [name, child] of Object.entries(properties as Record<string, Schema>)) {
    if (!(name in result) && nullable(child)) result[name] = null;
    else if (name in result) result[name] = fillNullableArguments(child, result[name]);
  }
  return result;
}

export type NativeTool = Readonly<{
  name: string;
  description: string;
  parameters: Schema;
  invokeNative: (argumentsValue: unknown) => Promise<unknown>;
}>;

export class NativeToolInputError extends Error {
  constructor(readonly issues: readonly Readonly<{ path: string; message: string }>[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "NativeToolInputError";
  }
}

/** Reuse the same trusted executors with native parsing, without the SDK's redacted error wrapper. */
export function createGovernedToolRegistry() {
  const native = new Map<string, NativeTool>();
  const define = <S extends z.ZodObject>(definition: Readonly<{
    name: string;
    description: string;
    parameters: S;
    strict: true;
    errorFunction?: (_context: unknown, error: unknown) => Promise<string>;
    execute: (input: z.output<S>) => Promise<string>;
  }>) => {
    // The SDK's conditional Extract<S, ...> cannot reduce a generic ZodObject.
    // This bridge preserves the original schema and executor without a data cast.
    const legacy = sdkTool<S>(definition as ToolOptions<S, unknown, undefined>);
    native.set(definition.name, {
      name: definition.name,
      description: definition.description,
      parameters: nativeParameterSchema(legacy.parameters),
      invokeNative: async (value) => {
        const parsed = definition.parameters.safeParse(fillNullableArguments(legacy.parameters, value));
        if (!parsed.success) throw new NativeToolInputError(parsed.error.issues.slice(0, 8).map((issue) => ({
          path: issue.path.map(String).join(".") || "input", message: issue.message,
        })));
        return definition.execute(parsed.data);
      },
    });
    return legacy;
  };
  return { define, get: (names: readonly string[]) => names.flatMap((name) => native.get(name) ? [native.get(name)!] : []) };
}
