import { z } from "zod";

export const SHOPIFYQL_API_VERSION = "2026-07" as const;
export const SHOPIFYQL_MAX_QUERY_BYTES = 8 * 1024;
export const SHOPIFYQL_MAX_RESPONSE_BYTES = 512 * 1024;
export const SHOPIFYQL_MAX_ROWS = 250;
export const SHOPIFYQL_MAX_WINDOW_DAYS = 366;
export const SHOPIFYQL_MAX_QUERIES_PER_TURN = 6;

/** Strict Responses tools require optional fields to also accept null. */
function modelOptional<T extends z.ZodType>(schema: T) {
  return schema.nullable().optional();
}

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/u);
// Static ShopifyQL fields are lower snake_case. Merchant metafield selectors
// additionally contain dots, hyphens, mixed case and Shopify's `$app` namespace.
// No whitespace, quotes, comments, brackets or clause punctuation can enter.
const fieldIdentifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_$-]+)*$/u);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const literal = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
]);

export const shopifyQLFilterOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "between",
  "not_between",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "is_null",
  "is_not_null",
  "is_true",
  "is_not_true",
  "is_false",
  "is_not_false",
]);

export const shopifyQLConditionSchema = z.object({
  field: fieldIdentifier,
  operator: shopifyQLFilterOperatorSchema,
  values: modelOptional(z.array(literal).max(50)),
  join: modelOptional(z.enum(["and", "or"])),
}).strict();

// MATCHES has a deliberately different grammar from boolean WHERE/HAVING:
// parameters are comma separated and each parameter field can occur once.
// Keeping `join` out of this shape makes emitting an accidental AND/OR
// expression inside MATCHES impossible at the trust boundary.
export const shopifyQLMatchConditionSchema = z.object({
  field: fieldIdentifier,
  operator: shopifyQLFilterOperatorSchema,
  values: modelOptional(z.array(literal).max(50)),
}).strict();

export const shopifyQLMatchSchema = z.object({
  expression: fieldIdentifier,
  operator: z.enum(["matches", "not_matches"]),
  conditions: z.array(shopifyQLMatchConditionSchema).min(1).max(12),
  join: modelOptional(z.enum(["and", "or"])),
}).strict();

export const shopifyQLQueryInputSchema = z.object({
  topic: z.string().trim().min(3).max(160),
  schema: identifier,
  fields: z.array(fieldIdentifier).min(1).max(20),
  groupBy: modelOptional(z.array(fieldIdentifier).max(8)),
  where: modelOptional(z.array(shopifyQLConditionSchema).max(20)),
  having: modelOptional(z.array(shopifyQLConditionSchema).max(12)),
  matches: modelOptional(z.array(shopifyQLMatchSchema).max(8)),
  timeWindow: z.object({
    since: isoDate,
    until: isoDate,
  }).strict(),
  timeseries: modelOptional(z.enum([
    "second", "minute", "hour", "day", "week", "month", "quarter", "year",
    "hour_of_day", "day_of_week", "week_of_year", "month_of_year",
  ])),
  compareTo: modelOptional(z.enum([
    "previous_day", "previous_hour", "previous_minute", "previous_month",
    "previous_period", "previous_quarter", "previous_second", "previous_week",
    "previous_year", "previous_year_match_day_of_week",
  ])),
  modifiers: modelOptional(z.array(z.enum([
    "cumulative_values", "group_totals", "percent_change", "totals",
  ])).max(4)),
  attributionModel: modelOptional(z.enum([
    "first_click", "last_click", "last_non_direct_click", "any_click", "linear",
  ])),
  currency: modelOptional(z.string().regex(/^[A-Z]{3}$/u)),
  timezone: modelOptional(z.string().trim().min(1).max(100)),
  orderBy: modelOptional(z.array(z.object({
    field: fieldIdentifier,
    direction: z.enum(["asc", "desc"]),
  }).strict()).max(4)),
  limit: modelOptional(z.number().int().min(1).max(SHOPIFYQL_MAX_ROWS)),
}).strict();

/** V3 tool envelope; connectionId must come from the tenant store catalogue. */
export const shopifyQLToolQueryInputSchema = shopifyQLQueryInputSchema.extend({
  connectionId: modelOptional(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u)),
}).strict();

export const shopifyQLCatalogueInputSchema = z.object({
  query: z.string().trim().min(2).max(160),
  schema: modelOptional(identifier),
  limit: modelOptional(z.number().int().min(1).max(30)),
}).strict();

export type ShopifyQLQueryInput = z.infer<typeof shopifyQLQueryInputSchema>;
export type ShopifyQLCondition = z.infer<typeof shopifyQLConditionSchema>;
export type ShopifyQLMatchCondition = z.infer<typeof shopifyQLMatchConditionSchema>;
export type ShopifyQLMatch = z.infer<typeof shopifyQLMatchSchema>;
export type ShopifyQLCatalogueInput = z.infer<typeof shopifyQLCatalogueInputSchema>;

export const shopifyQLInvocationSchema = z.object({
  requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  tenantId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  actorId: z.string().uuid(),
  role: z.enum(["owner", "manager"]),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  turnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  connectionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u).optional(),
  input: shopifyQLQueryInputSchema,
}).strict();

export const shopifyQLCatalogueInvocationSchema = z.object({
  requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  tenantId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  actorId: z.string().uuid(),
  role: z.enum(["owner", "manager"]),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  turnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  input: shopifyQLCatalogueInputSchema,
}).strict();

export type ShopifyQLInvocation = z.infer<typeof shopifyQLInvocationSchema>;
export type ShopifyQLCatalogueInvocation = z.infer<typeof shopifyQLCatalogueInvocationSchema>;

export type ShopifyQLColumn = Readonly<{
  name: string;
  displayName: string;
  shortDisplayName: string | null;
  dataType: string;
  subType: string | null;
  columnOrigin: string;
  dynamicColumnMetadata: Readonly<{
    aggregatedBy: readonly string[];
    comparisonReference: string | null;
    originalColumnName: string | null;
    type: string;
  }> | null;
}>;

export type ShopifyQLRowMetadata = Readonly<{
  nullCellTranslations: readonly Readonly<{ columnName: string; displayText: string }>[];
  rawResourceIds: readonly (readonly string[])[];
  topNRemainderColumnNames: readonly string[];
}>;

export const shopifyQLServiceResultSchema = z.object({
  requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  apiVersion: z.literal(SHOPIFYQL_API_VERSION),
  registrySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  queryDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  schema: identifier,
  connection: z.object({
    connectionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
    connectionGeneration: z.number().int().positive(),
    displayName: z.string().min(1).max(200),
  }).strict(),
  approvalEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  timeWindow: z.object({ since: isoDate, until: isoDate }).strict(),
  metrics: z.array(fieldIdentifier),
  dimensions: z.array(fieldIdentifier),
  deprecatedFields: z.array(fieldIdentifier),
  definitions: z.array(z.object({
    name: fieldIdentifier,
    kind: z.enum(["metric", "dimension", "metafield"]),
    type: z.string(),
    description: z.string(),
    formula: z.string().nullable(),
    deprecated: z.boolean(),
  }).strict()),
  columns: z.array(z.object({
    name: z.string(),
    displayName: z.string(),
    shortDisplayName: z.string().nullable(),
    dataType: z.string(),
    subType: z.string().nullable(),
    columnOrigin: z.string(),
    dynamicColumnMetadata: z.object({
      aggregatedBy: z.array(z.string()),
      comparisonReference: z.string().nullable(),
      originalColumnName: z.string().nullable(),
      type: z.string(),
    }).strict().nullable(),
  }).strict()),
  rows: z.array(z.record(z.string(), z.unknown())).max(SHOPIFYQL_MAX_ROWS),
  rowMetadata: z.array(z.object({
    nullCellTranslations: z.array(z.object({ columnName: z.string(), displayText: z.string() }).strict()),
    rawResourceIds: z.array(z.array(z.string())),
    topNRemainderColumnNames: z.array(z.string()),
  }).strict()).max(SHOPIFYQL_MAX_ROWS),
  parseErrors: z.array(z.string()),
  executedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  responseDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type ShopifyQLServiceResult = z.infer<typeof shopifyQLServiceResultSchema>;
