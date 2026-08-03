import { z } from "zod";

export const queryFilterSchema = z.object({
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "is_null", "is_not_null"]),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).max(100).default([]),
}).strict();

export const timeRangeSchema = z.union([
  z.object({ type: z.literal("absolute"), from: z.string().datetime(), to: z.string().datetime() }).strict(),
  z.object({ type: z.enum(["today", "month_to_date", "quarter_to_date", "year_to_date"])}).strict(),
  z.object({ type: z.literal("last_n_days"), days: z.number().int().min(1).max(366) }).strict(),
]);

export const timeSelectionSchema = z.object({
  field: z.string().min(1),
  range: timeRangeSchema,
  compare: z.enum(["none", "same_period_prior_week", "same_period_prior_month", "same_period_prior_year"]).default("none"),
}).strict();

export const sortSchema = z.object({
  metric: z.string().min(1),
  dir: z.enum(["asc", "desc"]),
}).strict();

export const singleSemanticQuerySchema = z.object({
  kind: z.literal("single").default("single"),
  topic: z.string().min(1),
  metrics: z.array(z.string().min(1)).min(1).max(20),
  dimensions: z.array(z.string().min(1)).max(8).default([]),
  filters: z.array(queryFilterSchema).max(20).default([]),
  time: timeSelectionSchema,
  sort: z.array(sortSchema).max(5).default([]),
  limit: z.number().int().min(1).max(1000).default(100),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
}).strict();
export type SingleSemanticQuery = z.infer<typeof singleSemanticQuerySchema>;

export const compositeSubquerySchema = singleSemanticQuerySchema.omit({
  kind: true,
  sort: true,
  limit: true,
});
export type CompositeSubquery = z.infer<typeof compositeSubquerySchema>;

export const compositeSemanticQuerySchema = z.object({
  kind: z.literal("composite"),
  topic: z.string().min(1),
  metrics: z.array(z.string().min(1)).min(1).max(10),
  queries: z.array(compositeSubquerySchema).min(2).max(4),
  alignOn: z.array(z.string().min(1)).min(1).max(4),
  sort: z.array(sortSchema).max(5).default([]),
  limit: z.number().int().min(1).max(1000).default(100),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
}).strict();
export type CompositeSemanticQuery = z.infer<typeof compositeSemanticQuerySchema>;

export const semanticQuerySchema = z.discriminatedUnion("kind", [
  singleSemanticQuerySchema,
  compositeSemanticQuerySchema,
]);
export type SemanticQuery = z.infer<typeof semanticQuerySchema>;

export function parseSemanticQuery(input: unknown): SemanticQuery {
  if (input && typeof input === "object" && !("kind" in input)) {
    return semanticQuerySchema.parse({ kind: "single", ...input });
  }
  return semanticQuerySchema.parse(input);
}
