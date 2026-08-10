import { z } from "zod";

export const queryFilterSchema = z.object({
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "is_null", "is_not_null"]),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).max(100).default([]),
}).strict();

export const timeRangeSchema = z.union([
  z.object({ type: z.literal("absolute"), from: z.string().datetime(), to: z.string().datetime() }).strict(),
  z.object({
    type: z.enum([
      "today",
      "yesterday",
      "week_to_date",
      "month_to_date",
      "quarter_to_date",
      "year_to_date",
      // Whole elapsed periods. "Last week" and "last month" are the units a
      // business actually reports on, and approximating them with a trailing
      // day count answers a different question than the one asked.
      "last_complete_week",
      "last_complete_month",
      "last_complete_quarter",
      "last_complete_year",
    ]),
  }).strict(),
  z.object({ type: z.literal("last_n_days"), days: z.number().int().min(1).max(366) }).strict(),
  /** Trailing window ending last night, excluding today's partial trading. */
  z.object({ type: z.literal("last_n_complete_days"), days: z.number().int().min(1).max(366) }).strict(),
  /**
   * Whole elapsed weeks and months. "The last 6 weeks" means six complete
   * weeks, not the 42 trailing days that straddle seven of them and report two
   * part-weeks as if they were whole.
   */
  z.object({ type: z.literal("last_n_complete_weeks"), weeks: z.number().int().min(1).max(53) }).strict(),
  z.object({ type: z.literal("last_n_complete_months"), months: z.number().int().min(1).max(24) }).strict(),
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
