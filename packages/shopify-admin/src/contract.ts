import { z } from "zod";

export const SHOPIFY_ADMIN_API_VERSION = "2026-07" as const;
export const SHOPIFY_ADMIN_MAX_SELECTION_DEPTH = 6;
export const SHOPIFY_ADMIN_MAX_SELECTED_FIELDS = 40;
export const SHOPIFY_ADMIN_MAX_NODE_EXPOSURE = 100;
export const SHOPIFY_ADMIN_MAX_RESPONSE_BYTES = 256 * 1024;
export const SHOPIFY_ADMIN_MAX_RESULT_LEAVES = 200;
export const SHOPIFY_ADMIN_MAX_QUERIES_PER_TURN = 4;
export const SHOPIFY_ADMIN_MAX_CATALOGUE_SEARCHES_PER_TURN = 6;

const graphqlName = z.string().regex(/^[_A-Za-z][_0-9A-Za-z]*$/u);
const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

/** Strict Responses tools require optional fields to also accept null. */
function modelOptional<T extends z.ZodType>(schema: T) {
  return schema.nullable().optional();
}

export type ShopifyAdminArgumentValue =
  | Readonly<{ kind: "null" }>
  | Readonly<{ kind: "string"; value: string }>
  | Readonly<{ kind: "id"; value: string }>
  | Readonly<{ kind: "enum"; value: string }>
  | Readonly<{ kind: "int"; value: number }>
  | Readonly<{ kind: "float"; value: number }>
  | Readonly<{ kind: "boolean"; value: boolean }>
  | Readonly<{ kind: "decimal"; value: string }>
  | Readonly<{ kind: "date"; value: string }>
  | Readonly<{ kind: "datetime"; value: string }>
  | Readonly<{ kind: "integer_string"; value: string }>
  | Readonly<{ kind: "json"; value: string }>
  | Readonly<{ kind: "list"; values: readonly ShopifyAdminArgumentValue[] }>
  | Readonly<{
      kind: "object";
      fields: readonly Readonly<{ name: string; value: ShopifyAdminArgumentValue }>[];
    }>;

export const shopifyAdminArgumentValueSchema: z.ZodType<ShopifyAdminArgumentValue> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("null") }).strict(),
    z.object({ kind: z.literal("string"), value: z.string().max(2_000) }).strict(),
    z.object({ kind: z.literal("id"), value: z.string().min(1).max(500) }).strict(),
    z.object({ kind: z.literal("enum"), value: graphqlName }).strict(),
    z.object({ kind: z.literal("int"), value: z.number().int() }).strict(),
    z.object({ kind: z.literal("float"), value: z.number().finite() }).strict(),
    z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
    z.object({ kind: z.literal("decimal"), value: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u).max(200) }).strict(),
    z.object({ kind: z.literal("date"), value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) }).strict(),
    z.object({ kind: z.literal("datetime"), value: z.string().min(10).max(100) }).strict(),
    z.object({ kind: z.literal("integer_string"), value: z.string().regex(/^-?(?:0|[1-9]\d*)$/u).max(100) }).strict(),
    z.object({ kind: z.literal("json"), value: z.string().min(1).max(4_000) }).strict(),
    z.object({ kind: z.literal("list"), values: z.array(shopifyAdminArgumentValueSchema).max(50) }).strict(),
    z.object({
      kind: z.literal("object"),
      fields: z.array(z.object({ name: graphqlName, value: shopifyAdminArgumentValueSchema }).strict()).max(50),
    }).strict(),
  ]),
);

export const shopifyAdminArgumentSchema = z.object({
  name: graphqlName,
  value: shopifyAdminArgumentValueSchema,
}).strict();

export type ShopifyAdminSelection = Readonly<{
  field: string;
  arguments?: readonly z.infer<typeof shopifyAdminArgumentSchema>[] | null;
  select?: readonly ShopifyAdminSelection[] | null;
  on?: readonly Readonly<{ type: string; select: readonly ShopifyAdminSelection[] }>[] | null;
}>;

export const shopifyAdminSelectionSchema: z.ZodType<ShopifyAdminSelection> = z.lazy(() =>
  z.object({
    field: graphqlName,
    arguments: modelOptional(z.array(shopifyAdminArgumentSchema).max(20)),
    select: modelOptional(z.array(shopifyAdminSelectionSchema).max(30)),
    on: modelOptional(z.array(z.object({
      type: graphqlName,
      select: z.array(shopifyAdminSelectionSchema).min(1).max(30),
    }).strict()).max(8)),
  }).strict(),
);

export const shopifyAdminQueryInputSchema = z.object({
  topic: z.string().trim().min(3).max(160),
  rootField: graphqlName,
  arguments: modelOptional(z.array(shopifyAdminArgumentSchema).max(20)),
  select: modelOptional(z.array(shopifyAdminSelectionSchema).max(30)),
  on: modelOptional(z.array(z.object({
    type: graphqlName,
    select: z.array(shopifyAdminSelectionSchema).min(1).max(30),
  }).strict()).max(8)),
}).strict();

/** V3 tool envelope; connectionId selects only a previously catalogued store. */
export const shopifyAdminToolQueryInputSchema = shopifyAdminQueryInputSchema.extend({
  connectionId: modelOptional(ulid),
}).strict();

export const shopifyAdminCatalogueInputSchema = z.object({
  // One-character output fields exist (Vector3.x/y/z). Search remains bounded
  // by `limit`, and exact parent-scoped names rank ahead of fuzzy prose.
  query: z.string().trim().min(1).max(160),
  type: modelOptional(graphqlName),
  rootOnly: modelOptional(z.boolean()),
  limit: modelOptional(z.number().int().min(1).max(30)),
}).strict();

export type ShopifyAdminQueryInput = z.infer<typeof shopifyAdminQueryInputSchema>;
export type ShopifyAdminCatalogueInput = z.infer<typeof shopifyAdminCatalogueInputSchema>;

const invocationIdentity = {
  requestId: ulid,
  tenantId: ulid,
  actorId: z.string().uuid(),
  role: z.enum(["owner", "manager"]),
  conversationId: ulid,
  turnId: ulid,
} as const;

export const shopifyAdminInvocationSchema = z.object({
  ...invocationIdentity,
  connectionId: ulid.optional(),
  input: shopifyAdminQueryInputSchema,
}).strict();

export const shopifyAdminCatalogueInvocationSchema = z.object({
  ...invocationIdentity,
  input: shopifyAdminCatalogueInputSchema,
}).strict();

export const shopifyAdminStoreCatalogueInvocationSchema = z.object({
  ...invocationIdentity,
}).strict();

export type ShopifyAdminInvocation = z.infer<typeof shopifyAdminInvocationSchema>;
export type ShopifyAdminCatalogueInvocation = z.infer<typeof shopifyAdminCatalogueInvocationSchema>;

export const shopifyAdminStoreChoiceSchema = z.object({
  connectionId: ulid,
  connectionGeneration: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(200),
}).strict();

export const shopifyAdminStoreCatalogueResultSchema = z.object({
  stores: z.array(shopifyAdminStoreChoiceSchema).max(50),
}).strict();
export type ShopifyAdminStoreCatalogueResult = z.infer<typeof shopifyAdminStoreCatalogueResultSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const shopifyAdminServiceResultSchema = z.object({
  requestId: ulid,
  apiVersion: z.literal(SHOPIFY_ADMIN_API_VERSION),
  registrySha256: digest,
  queryDigest: digest,
  responseDigest: digest,
  scopeEvidenceDigest: digest,
  connection: z.object({
    connectionId: ulid,
    connectionGeneration: z.number().int().positive(),
    displayName: z.string().min(1).max(200),
  }).strict(),
  approvalEvidenceDigest: digest.nullable(),
  rootField: graphqlName,
  selectedPaths: z.array(z.string().min(3).max(500)).max(SHOPIFY_ADMIN_MAX_SELECTED_FIELDS),
  requiredScopes: z.array(z.string().regex(/^read_[a-z0-9_]+$/u)).max(80),
  accessLimitations: z.array(z.string().min(1).max(1_000)).max(80),
  definitions: z.array(z.object({
    path: z.string().min(3).max(500),
    parentType: graphqlName,
    field: graphqlName,
    type: z.string().min(1).max(300),
    description: z.string().max(4_000).nullable(),
    deprecated: z.boolean(),
    protected: z.boolean(),
    requiredAccess: z.string().max(4_000).nullable(),
  }).strict()).max(SHOPIFY_ADMIN_MAX_SELECTED_FIELDS),
  data: z.unknown(),
  resultLeafCount: z.number().int().min(0).max(SHOPIFY_ADMIN_MAX_RESULT_LEAVES),
  executedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
}).strict();

export type ShopifyAdminServiceResult = z.infer<typeof shopifyAdminServiceResultSchema>;
