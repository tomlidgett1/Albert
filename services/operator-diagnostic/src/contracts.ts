import { z } from "zod";

export const operatorDiagnosticStageSchema = z.enum(["staging", "canonical", "marts"]);
export const operatorDiagnosticSchemaNameSchema = z.enum([
  "source_lightspeed",
  "source_xero",
  "source_deputy",
  "core",
  "mart",
]);

export const operatorDiagnosticRequestSchema = z.object({
  revealId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
}).strict();

const shopifyReferenceSchema = z.string().regex(/^(0|[1-9][0-9]{0,29})$/u);
const fivetranIdentifierSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/u);
const fivetranSchemaNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);

export const shopifyPrivacyExportRequestSchema = z.object({
  exportId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
}).strict();

export const shopifyPrivacyExportGrantSchema = z.object({
  export_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  case_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  tenant_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  connection_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  customer_reference: shopifyReferenceSchema.nullable(),
  order_references: z.array(shopifyReferenceSchema).max(5_000),
  data_request_reference: shopifyReferenceSchema,
  expires_at: z.string().min(1),
  analytical_capability: z.string().min(100).max(4_096),
}).strict();

const shopifyPrivacyRecordSchema = z.record(z.string(), z.unknown());
const shopifyPrivacyCollectionSchema = z.object({
  name: z.enum([
    "customers","orders","order_lines","transactions","refund_lines",
    "fulfillments","returns","metafield_values","long_tail_fields",
    "normalized_source_records",
  ]),
  records: z.array(shopifyPrivacyRecordSchema),
}).strict();

export const shopifyPrivacyArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  exportId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  caseId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  generatedAt: z.string().datetime({ offset: true }),
  source: z.literal("albert_shopify_customer_data"),
  customerReference: shopifyReferenceSchema.nullable(),
  orderReferences: z.array(shopifyReferenceSchema).max(5_000),
  dataRequestReference: shopifyReferenceSchema,
  collections: z.array(shopifyPrivacyCollectionSchema).length(10),
  recordCount: z.number().int().nonnegative(),
}).strict();

export const operatorDiagnosticGrantSchema = z.object({
  reveal_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  tenant_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  pipeline_stage: operatorDiagnosticStageSchema,
  schema_name: operatorDiagnosticSchemaNameSchema,
  table_name: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/u),
  row_limit: z.coerce.number().int().min(1).max(5),
  expires_at: z.string().min(1),
  analytical_capability: z.string().min(100).max(4096),
}).strict();

export const operatorDiagnosticSampleSchema = z.object({
  revealId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  stage: operatorDiagnosticStageSchema,
  schemaName: operatorDiagnosticSchemaNameSchema,
  tableName: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/u),
  columns: z.array(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/u)).max(32),
  rows: z.array(z.record(z.string(), z.string().nullable())).max(5),
  rowCount: z.number().int().min(0).max(5),
  excludedColumnCount: z.number().int().nonnegative(),
  cellCharacterLimit: z.literal(500),
}).strict();

export const fivetranMyDataRequestSchema = z.object({
  requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
}).strict();

const fivetranMyDataSourceGrantSchema = z.object({
  connection_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  destination_schema: fivetranSchemaNameSchema,
  service: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  display_name: z.string().trim().min(1).max(160),
  status: z.enum(["connected", "degraded", "blocked"]),
  last_sync_state: z.string().trim().min(1).max(80).nullable(),
  updated_at: z.string().min(1),
}).strict();

export const fivetranMyDataGrantSchema = z.object({
  request_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  tenant_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  request_kind: z.enum(["catalogue", "rows"]),
  schema_name: fivetranSchemaNameSchema.nullable(),
  table_name: fivetranIdentifierSchema.nullable(),
  row_offset: z.coerce.number().int().min(0).max(10_000_000),
  row_limit: z.coerce.number().int().min(1).max(50),
  sources: z.array(fivetranMyDataSourceGrantSchema).max(20),
  expires_at: z.string().min(1),
  analytical_capability: z.string().min(100).max(4_096),
}).strict().superRefine((grant, context) => {
  if (grant.request_kind === "catalogue") {
    if (grant.schema_name !== null || grant.table_name !== null || grant.row_offset !== 0) {
      context.addIssue({ code: "custom", message: "Catalogue grant contains a row target." });
    }
    return;
  }
  if (grant.schema_name === null || grant.table_name === null || grant.sources.length !== 1 ||
      grant.sources[0]?.destination_schema !== grant.schema_name) {
    context.addIssue({ code: "custom", message: "Row grant does not match one connected schema." });
  }
});

const fivetranMyDataTableSummarySchema = z.object({
  name: fivetranIdentifierSchema,
  approximateRows: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
  available: z.boolean(),
}).strict();

export const fivetranMyDataCatalogueSchema = z.object({
  requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  checkedAt: z.string().datetime({ offset: true }),
  totalRows: z.number().int().nonnegative(),
  sources: z.array(z.object({
    connectionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
    schemaName: fivetranSchemaNameSchema,
    service: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    displayName: z.string().trim().min(1).max(160),
    status: z.enum(["connected", "degraded", "blocked"]),
    lastSyncState: z.string().trim().min(1).max(80).nullable(),
    updatedAt: z.string().min(1),
    tables: z.array(fivetranMyDataTableSummarySchema).max(400),
  }).strict()).max(20),
}).strict();

export const fivetranMyDataTableSchema = z.object({
  requestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  schemaName: fivetranSchemaNameSchema,
  tableName: fivetranIdentifierSchema,
  columns: z.array(z.object({
    name: fivetranIdentifierSchema,
    dataType: z.string().trim().min(1).max(120),
  }).strict()).max(64),
  rows: z.array(z.record(z.string(), z.string().nullable())).max(50),
  offset: z.number().int().min(0).max(10_000_000),
  limit: z.number().int().min(1).max(50),
  hasMore: z.boolean(),
  approximateRows: z.number().int().nonnegative(),
  excludedColumnCount: z.number().int().nonnegative(),
  additionalColumnCount: z.number().int().nonnegative(),
  cellCharacterLimit: z.literal(500),
}).strict();

export const fivetranMyDataResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalogue"), catalogue: fivetranMyDataCatalogueSchema }).strict(),
  z.object({ kind: z.literal("rows"), table: fivetranMyDataTableSchema }).strict(),
]);

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const candidateShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const deploymentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u);

export const protectedDogfoodOnboardingReceiptRequestSchema = z.object({
  journeyId: ulidSchema,
  userId: z.string().uuid(),
  tenantId: ulidSchema,
  browserNonceHash: sha256Schema,
  userAgentHash: sha256Schema,
}).strict();

export const protectedDogfoodOnboardingReceiptSchema = z.object({
  journeyId: ulidSchema,
  receiptId: ulidSchema,
  receiptDigest: sha256Schema,
  authProofDigest: sha256Schema,
  candidateSha: candidateShaSchema,
  deploymentId: deploymentIdSchema,
  tenantId: ulidSchema,
  completedAt: z.string().datetime({ offset: true }),
}).strict();

export type OperatorDiagnosticGrant = z.infer<typeof operatorDiagnosticGrantSchema>;
export type OperatorDiagnosticSample = z.infer<typeof operatorDiagnosticSampleSchema>;
export type FivetranMyDataGrant = z.infer<typeof fivetranMyDataGrantSchema>;
export type FivetranMyDataCatalogue = z.infer<typeof fivetranMyDataCatalogueSchema>;
export type FivetranMyDataTable = z.infer<typeof fivetranMyDataTableSchema>;
export type FivetranMyDataResult = z.infer<typeof fivetranMyDataResultSchema>;
export type ShopifyPrivacyExportGrant = z.infer<typeof shopifyPrivacyExportGrantSchema>;
export type ShopifyPrivacyArtifact = z.infer<typeof shopifyPrivacyArtifactSchema>;
export type ProtectedDogfoodOnboardingReceiptRequest = z.infer<
  typeof protectedDogfoodOnboardingReceiptRequestSchema
>;
export type ProtectedDogfoodOnboardingReceipt = z.infer<
  typeof protectedDogfoodOnboardingReceiptSchema
>;

export function targetMatchesStage(grant: OperatorDiagnosticGrant): boolean {
  return (grant.pipeline_stage === "staging" && [
    "source_lightspeed",
    "source_xero",
    "source_deputy",
  ].includes(grant.schema_name)) ||
    (grant.pipeline_stage === "canonical" && grant.schema_name === "core") ||
    (grant.pipeline_stage === "marts" && grant.schema_name === "mart");
}
