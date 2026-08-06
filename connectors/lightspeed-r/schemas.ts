/**
 * Zod validation for every spec stream's projected rows, generated from the
 * same table spec that generates the streams and the field coverage — one
 * source, three artifacts, no drift. Each schema accepts a projected payload
 * keyed by vendor field names (the api leaf per column): the vendor returns
 * numbers-as-strings and booleans-as-strings freely, so scalar fields accept
 * the union and typed staging owns exact coercion. Unknown keys pass through:
 * schema drift is quarantined downstream by field coverage, not rejected here
 * where it would discard the evidence.
 */
import { z } from "zod";
import { SPEC_TABLES, type SpecColumn, type SpecTable } from "./scan-plan.js";

function fieldSchema(column: SpecColumn): z.ZodType {
  switch (column.type) {
    case "integer":
    case "bigint":
    case "numeric":
    case "real":
      return z.union([z.number(), z.string()]);
    case "boolean":
      return z.union([z.boolean(), z.string(), z.number()]);
    case "timestamp":
    case "date":
      return z.union([z.string(), z.number()]);
    case "jsonb":
      return z.unknown();
    default:
      return z.union([z.string(), z.number(), z.boolean()]);
  }
}

function tableSchema(table: SpecTable): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  const seen = new Set<string>();
  for (const column of table.columns) {
    const leaf = column.api.split(".").pop() ?? column.name;
    if (seen.has(leaf)) continue;
    seen.add(leaf);
    shape[leaf] = fieldSchema(column).nullish() as z.ZodType;
  }
  return z.object(shape).passthrough();
}

export const lightspeedSchemas: Readonly<Record<string, z.ZodType>> = Object.freeze(
  Object.fromEntries(SPEC_TABLES.map((table) => [table.id, tableSchema(table)])),
);

export type LightspeedStreamId = keyof typeof lightspeedSchemas & string;
