import { z } from "zod";

export const roleSchema = z.enum(["owner", "manager", "bookkeeper", "internal_operator"]);
export type SemanticRole = z.infer<typeof roleSchema>;

const fieldRefSchema = z.object({ op: z.literal("field"), field: z.string().min(1) }).strict();
const literalSchema = z.object({ op: z.literal("literal"), value: z.string() }).strict();
const aggregateSchema = z.object({
  op: z.enum(["sum", "avg", "count", "count_distinct", "last_value", "min", "max"]),
  field: z.string().min(1).optional(),
  distinct: z.boolean().optional(),
  filter: z.lazy(() => filterContractSchema).optional(),
}).strict();

export type Calculation =
  | z.infer<typeof fieldRefSchema>
  | z.infer<typeof literalSchema>
  | z.infer<typeof aggregateSchema>
  | { op: "add" | "subtract" | "multiply" | "divide"; left: Calculation; right: Calculation }
  | { op: "metric"; metric: string }
  | { op: "conditional"; condition: FilterContract; value: Calculation; otherwise: Calculation };

export const filterContractSchema = z.object({
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "is_null", "is_not_null"]),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).default([]),
}).strict();
export type FilterContract = z.infer<typeof filterContractSchema>;

export const calculationSchema: z.ZodType<Calculation> = z.lazy(() =>
  z.union([
    fieldRefSchema,
    literalSchema,
    aggregateSchema,
    z.object({
      op: z.enum(["add", "subtract", "multiply", "divide"]),
      left: calculationSchema,
      right: calculationSchema,
    }).strict(),
    z.object({ op: z.literal("metric"), metric: z.string().min(1) }).strict(),
    z.object({
      op: z.literal("conditional"),
      condition: filterContractSchema,
      value: calculationSchema,
      otherwise: calculationSchema,
    }).strict(),
  ]),
);

export const metricContractSchema = z.object({
  id: z.string().regex(/^[a-z_]+\.[a-z0-9_]+$/),
  version: z.number().int().positive(),
  label: z.string().min(1),
  synonyms: z.array(z.string()),
  description: z.string().min(1),
  aiContext: z.string().min(1),
  baseFact: z.string().min(1),
  grain: z.string().min(1),
  expression: z.string().min(1),
  calculation: calculationSchema,
  defaultTime: z.string().min(1),
  filters: z.array(filterContractSchema),
  refundHandling: z.enum(["subtract", "exclude", "not_applicable"]),
  aggregation: z.enum(["sum", "count", "count_distinct", "average", "ratio", "last_value", "derived"]),
  unit: z.enum(["currency", "units", "count", "percent", "hours", "days", "currency_per_unit"]),
  authority: z.string().min(1),
  allowedDimensions: z.array(z.string().min(1)).min(1),
  requiredCapabilities: z.array(z.string().min(1)),
  tenantParameters: z.array(z.string().min(1)),
  tests: z.array(z.object({ kind: z.string(), target: z.string().optional(), tolerance: z.string().optional() }).strict()),
}).strict();
export type MetricContract = z.infer<typeof metricContractSchema>;

export const joinContractSchema = z.object({
  dimension: z.string().min(1),
  table: z.string().regex(/^core\.[a-z_]+$/),
  factKey: z.string().regex(/^[a-z_]+$/),
  dimensionKey: z.string().regex(/^[a-z_]+$/),
  identityType: z.enum(["worker", "location", "product_variant", "customer_account", "supplier"]).optional(),
  cardinality: z.enum(["many_to_one", "one_to_one"]),
  fields: z.record(z.string(), z.string().regex(/^[a-z_]+$/)),
}).strict();
export type JoinContract = z.infer<typeof joinContractSchema>;

export const factModelSchema = z.object({
  id: z.string().min(1),
  table: z.string().regex(/^(?:core|mart)\.[a-z_]+$/),
  fields: z.array(z.string().regex(/^[a-z_]+$/)).min(1),
  timeFields: z.array(z.string().regex(/^[a-z_]+$/)).min(1),
  joins: z.array(joinContractSchema),
  snapshotFields: z.array(z.string().regex(/^[a-z_]+$/)),
  snapshotEntityKeys: z.array(z.string().regex(/^[a-z_]+$/)).default([]),
}).strict();
export type FactModel = z.infer<typeof factModelSchema>;

export const topicSchema = z.object({
  id: z.string().regex(/^[a-z_]+$/),
  version: z.number().int().positive(),
  label: z.string().min(1),
  description: z.string().min(1),
  aiContext: z.string().min(1),
  baseFacts: z.array(z.string().min(1)).min(1),
  approvedDimensions: z.array(z.string().min(1)).min(1),
  metrics: z.array(z.string().min(1)).min(1),
  defaultFilters: z.array(filterContractSchema),
  requiredCapabilities: z.array(z.string().min(1)),
  freshnessMinutes: z.number().int().positive(),
  roles: z.array(roleSchema).min(1),
  composite: z.boolean(),
  alignOn: z.array(z.string().min(1)),
  sampleQuestions: z.array(z.string().min(1)).min(1),
}).strict();
export type TopicContract = z.infer<typeof topicSchema>;

export const registryDocumentSchema = z.object({
  registryVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  metrics: z.array(metricContractSchema),
  topics: z.array(topicSchema),
  facts: z.array(factModelSchema),
}).strict();
export type RegistryDocument = z.infer<typeof registryDocumentSchema>;

export type SemanticRegistry = Readonly<{
  version: string;
  metrics: ReadonlyMap<string, MetricContract>;
  topics: ReadonlyMap<string, TopicContract>;
  facts: ReadonlyMap<string, FactModel>;
}>;
