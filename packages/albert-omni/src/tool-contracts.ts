import { z } from "zod";
import type { CubeFilter, CubeQuery } from "../../albert-v3/src/cube/types.js";

export const memberNameSchema = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u);
export const filterOperatorSchema = z.enum([
  "equals", "notEquals", "contains", "notContains", "startsWith", "notStartsWith",
  "endsWith", "notEndsWith", "gt", "gte", "lt", "lte", "set", "notSet",
  "inDateRange", "notInDateRange", "beforeDate", "afterDate",
]);
const leafFilterSchema = z.object({
  member: memberNameSchema,
  operator: filterOperatorSchema,
  values: z.array(z.string().max(240)).max(40).nullable(),
}).strict();
export const omniToolFilterSchema = z.object({
  member: memberNameSchema.nullable(),
  operator: filterOperatorSchema.nullable(),
  values: z.array(z.string().max(240)).max(40).nullable(),
  and: z.array(leafFilterSchema).min(1).max(10).nullable(),
  or: z.array(leafFilterSchema).min(1).max(10).nullable(),
}).strict().superRefine((filter, context) => {
  const leaf = filter.member !== null || filter.operator !== null || filter.values !== null;
  if (Number(leaf) + Number(filter.and !== null) + Number(filter.or !== null) !== 1) {
    context.addIssue({ code: "custom", message: "Choose exactly one filter form: member+operator+values, and, or or. Set every unused field to null." });
  }
  if (leaf && (!filter.member || !filter.operator)) {
    context.addIssue({ code: "custom", message: "A leaf filter requires both member and operator; incomplete filters are never discarded." });
  }
});

export const omniQueryToolSchema = z.object({
  name: z.string().min(3).max(160),
  topic: z.string().min(1).max(160),
  query: z.object({
    measures: z.array(memberNameSchema).max(12).nullable(),
    dimensions: z.array(memberNameSchema).max(12).nullable(),
    segments: z.array(memberNameSchema).max(8).nullable(),
    timeDimensions: z.array(z.object({
      dimension: memberNameSchema,
      granularity: z.enum(["hour", "day", "week", "month", "quarter", "year"]).nullable(),
      dateRange: z.string().min(1).max(80).nullable(),
      compareDateRange: z.array(z.string().min(1).max(80)).min(1).max(4).nullable(),
    }).strict()).max(4).nullable(),
    filters: z.array(omniToolFilterSchema).max(20).nullable(),
    order: z.array(z.object({ field: memberNameSchema, direction: z.enum(["asc", "desc"]) }).strict()).max(8).nullable(),
    limit: z.number().int().min(1).max(500).nullable(),
  }).strict(),
}).strict();
export type OmniQueryToolInput = z.infer<typeof omniQueryToolSchema>;

function leafFilter(leaf: z.infer<typeof leafFilterSchema>): CubeFilter {
  if (!["set", "notSet"].includes(leaf.operator) && !leaf.values?.length) {
    throw new Error(`Filter ${leaf.member} ${leaf.operator} requires values.`);
  }
  return { member: leaf.member, operator: leaf.operator, ...(leaf.values?.length ? { values: leaf.values } : {}) };
}

export function cubeQueryFromTool(input: OmniQueryToolInput): CubeQuery {
  // Revalidate at this boundary for callers other than the SDK as well.
  const { query } = omniQueryToolSchema.parse(input);
  const parseRange = (raw: string): string | readonly [string, string] => {
    const match = /^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/u.exec(raw.trim());
    return match ? [match[1]!, match[2]!] : raw.trim();
  };
  const filters = (query.filters ?? []).map((filter): CubeFilter => {
    if (filter.and) return { and: filter.and.map(leafFilter) };
    if (filter.or) return { or: filter.or.map(leafFilter) };
    return leafFilter({ member: filter.member!, operator: filter.operator!, values: filter.values });
  });
  const order = Object.fromEntries((query.order ?? []).map((entry) => [entry.field, entry.direction]));
  return {
    ...(query.measures?.length ? { measures: query.measures } : {}),
    ...(query.dimensions?.length ? { dimensions: query.dimensions } : {}),
    ...(query.segments?.length ? { segments: query.segments } : {}),
    ...(query.timeDimensions?.length ? { timeDimensions: query.timeDimensions.map((time) => ({
      dimension: time.dimension,
      ...(time.granularity ? { granularity: time.granularity } : {}),
      ...(time.dateRange ? { dateRange: parseRange(time.dateRange) } : {}),
      ...(time.compareDateRange ? { compareDateRange: time.compareDateRange.map(parseRange) } : {}),
    })) } : {}),
    ...(filters.length ? { filters } : {}),
    ...(Object.keys(order).length ? { order } : {}),
    limit: query.limit ?? 500,
  };
}
