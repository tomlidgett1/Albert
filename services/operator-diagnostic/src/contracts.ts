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

export type OperatorDiagnosticGrant = z.infer<typeof operatorDiagnosticGrantSchema>;
export type OperatorDiagnosticSample = z.infer<typeof operatorDiagnosticSampleSchema>;

export function targetMatchesStage(grant: OperatorDiagnosticGrant): boolean {
  return (grant.pipeline_stage === "staging" && [
    "source_lightspeed",
    "source_xero",
    "source_deputy",
  ].includes(grant.schema_name)) ||
    (grant.pipeline_stage === "canonical" && grant.schema_name === "core") ||
    (grant.pipeline_stage === "marts" && grant.schema_name === "mart");
}
