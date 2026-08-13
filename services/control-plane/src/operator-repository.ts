import { z } from "zod";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { signInternalRequest } from "../../../packages/security/src/index.js";
import {
  operatorDiagnosticSampleSchema,
  shopifyPrivacyArtifactSchema,
  type ShopifyPrivacyArtifact,
} from "../../operator-diagnostic/src/contracts.js";
import { ControlPlaneError, requireUser } from "./web-repository.js";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const timestampSchema = z.string().min(1).nullable();

const readinessSummarySchema = z.object({
  state: z.string().min(1),
  progress: z.coerce.number().min(0).max(1).nullable(),
  ready_through: timestampSchema,
  backfill_complete: z.boolean(),
  reason_code: z.string().nullable(),
}).strict();

const streamSummarySchema = z.object({
  stream: z.string().min(1),
  last_successful_sync_at: timestampSchema,
  source_watermark: timestampSchema,
  backfill_complete: z.boolean(),
}).strict();

const qualityFailureSchema = z.object({
  check_id: z.string().min(1),
  status: z.enum(["warning", "failed", "blocked"]),
}).strict();

const vendorBudgetSummarySchema = z.object({
  budget_key: z.string().min(1),
  request_limit: z.coerce.number().nonnegative().nullable(),
  requests_used: z.coerce.number().nonnegative(),
  remaining: z.coerce.number().nonnegative().nullable(),
  window_ends_at: z.string().min(1),
  vendor_reset_at: timestampSchema,
  blocked_until: timestampSchema,
}).strict();

const fleetConnectionSchema = z.object({
  tenant_id: ulidSchema,
  tenant_name: z.string().min(1),
  connection_id: ulidSchema,
  connector_key: z.string().min(1),
  display_name: z.string().min(1),
  status: z.string().min(1),
  auth_health: z.string().min(1),
  last_checked_at: timestampSchema,
  token_expires_at: timestampSchema,
  last_rotated_at: timestampSchema,
  granted_scope_count: z.coerce.number().int().nonnegative(),
  last_successful_sync_at: timestampSchema,
  streams: z.array(streamSummarySchema),
  backfill_progress: z.coerce.number().min(0).max(1),
  readiness: z.record(z.string(), readinessSummarySchema),
  open_quarantine_count: z.coerce.number().int().nonnegative(),
  webhook: z.object({
    last_received_at: timestampSchema,
    latest_status: z.string().nullable(),
    failed_count_24h: z.coerce.number().int().nonnegative(),
    gap_recovery_status: z.enum(["not_observed", "clear", "recovered", "gap_detected"]),
  }).strict(),
  quality_failures: z.array(qualityFailureSchema),
  vendor_budgets: z.array(vendorBudgetSummarySchema),
}).strict();

const fleetSchema = z.object({
  generated_at: z.string().min(1),
  queues: z.array(z.record(z.string(), z.unknown())),
  workers: z.array(z.object({
    worker_id: z.string().min(1),
    service_version: z.string().min(1),
    deployment_id: z.string().nullable(),
    started_at: z.string().min(1),
    last_seen_at: z.string().min(1),
    active_job_count: z.coerce.number().int().nonnegative(),
    healthy: z.boolean(),
  }).strict()),
  connections: z.array(fleetConnectionSchema),
}).strict();

const countRecordSchema = z.record(
  z.string(),
  z.coerce.number().int().nonnegative(),
);

const pipelineSchema = z.object({
  generated_at: z.string().min(1),
  tenant: z.object({
    tenant_id: ulidSchema,
    name: z.string().min(1),
    status: z.string().min(1),
    timezone: z.string().min(1),
  }).strict(),
  health: z.enum(["healthy", "degraded", "blocked"]),
  latest_pipeline_snapshot_at: timestampSchema,
  stage_counts: countRecordSchema,
  operation_counts: countRecordSchema,
}).strict();

const pipelineDetailSchema = z.object({
  stage: z.string().min(1),
  generated_at: z.string().min(1),
  groups: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1),
    rows: z.array(z.record(z.string(), z.unknown())),
  }).strict()),
}).strict();

const semanticInboxProjectionSchema = pipelineDetailSchema.extend({
  stage: z.literal("semantic_inbox"),
  summary: z.object({
    candidate_count: z.coerce.number().int().nonnegative(),
    occurrence_count: z.coerce.number().int().nonnegative(),
    last_scanned_at: timestampSchema,
    last_error_code: z.string().nullable(),
  }).strict(),
}).strict();

export const OPERATOR_PIPELINE_STAGES = Object.freeze([
  "connections",
  "streams",
  "raw",
  "staging",
  "quality",
  "readiness",
  "runs",
  "jobs",
  "quarantine",
  "budgets",
  "semantic_inbox",
] as const);

export type OperatorPipelineStage = (typeof OPERATOR_PIPELINE_STAGES)[number];
export type OperatorFleet = z.infer<typeof fleetSchema>;
export type OperatorFleetConnection = z.infer<typeof fleetConnectionSchema>;
export type OperatorPipeline = z.infer<typeof pipelineSchema>;
export type OperatorPipelineDetail = z.infer<typeof pipelineDetailSchema>;
export type OperatorRowSample = z.infer<typeof operatorDiagnosticSampleSchema>;

export function isOperatorPipelineStage(value: string): value is OperatorPipelineStage {
  return (OPERATOR_PIPELINE_STAGES as readonly string[]).includes(value);
}

function operatorError(
  error: Readonly<{ code?: string }> | null,
  fallback: string,
): ControlPlaneError {
  if (error?.code === "42501") return new ControlPlaneError("Internal operator access is required.", 403);
  if (error?.code === "P0002") return new ControlPlaneError("The tenant was not found.", 404);
  if (error?.code === "22023") return new ControlPlaneError("The operator request is invalid.", 400);
  if (error?.code === "PGRST202" || error?.code === "42883") {
    return new ControlPlaneError("The operator console migration is not deployed.", 503);
  }
  return new ControlPlaneError(fallback, 503);
}

export async function isInternalOperator(): Promise<boolean> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_operator_status");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") return false;
    throw new ControlPlaneError("Operator access could not be verified.", 503);
  }
  return data === true;
}

export async function loadOperatorFleet(): Promise<OperatorFleet> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_operator_fleet");
  if (error) throw operatorError(error, "Fleet status could not be loaded.");
  const parsed = fleetSchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Fleet status returned invalid operational metadata.", 503);
  return parsed.data;
}

export async function loadOperatorPipeline(tenantId: string): Promise<OperatorPipeline> {
  const { supabase } = await requireUser();
  const [pipelineResult,semanticInboxResult] = await Promise.all([
    supabase.rpc("albert_operator_pipeline", { p_tenant_id: tenantId }),
    supabase.rpc("albert_operator_semantic_inbox", { p_tenant_id: tenantId, p_limit: 1 }),
  ]);
  if (pipelineResult.error) throw operatorError(pipelineResult.error, "The tenant pipeline could not be loaded.");
  if (semanticInboxResult.error) throw operatorError(semanticInboxResult.error, "The semantic inbox could not be loaded.");
  const parsed = pipelineSchema.safeParse(pipelineResult.data);
  if (!parsed.success) throw new ControlPlaneError("The tenant pipeline returned invalid operational metadata.", 503);
  const inbox = semanticInboxProjectionSchema.safeParse(semanticInboxResult.data);
  if (!inbox.success) throw new ControlPlaneError("The semantic inbox returned invalid operational metadata.", 503);
  return {
    ...parsed.data,
    operation_counts: {
      ...parsed.data.operation_counts,
      semantic_inbox: inbox.data.summary.candidate_count,
    },
  };
}

export async function loadOperatorPipelineStage(
  tenantId: string,
  stage: OperatorPipelineStage,
): Promise<OperatorPipelineDetail> {
  const { supabase } = await requireUser();
  if (stage === "semantic_inbox") {
    const { data, error } = await supabase.rpc("albert_operator_semantic_inbox", {
      p_tenant_id: tenantId,
      p_limit: 200,
    });
    if (error) throw operatorError(error, "The semantic inbox could not be loaded.");
    const parsed = semanticInboxProjectionSchema.safeParse(data);
    if (!parsed.success) throw new ControlPlaneError("The semantic inbox returned invalid operational metadata.", 503);
    return {
      stage: parsed.data.stage,
      generated_at: parsed.data.generated_at,
      groups: parsed.data.groups,
    };
  }
  const { data, error } = await supabase.rpc("albert_operator_pipeline_stage", {
    p_tenant_id: tenantId,
    p_stage: stage,
  });
  if (error) throw operatorError(error, "The pipeline detail could not be loaded.");
  const parsed = pipelineDetailSchema.safeParse(data);
  if (!parsed.success || parsed.data.stage !== stage) {
    throw new ControlPlaneError("The pipeline detail returned invalid operational metadata.", 503);
  }
  return parsed.data;
}

const rowRevealGrantSchema = z.object({
  reveal_id: ulidSchema,
  expires_at: z.string().min(1),
}).strict();

function operatorDiagnosticServiceUrl(path = "/v1/row-samples"): URL {
  const value = process.env.OPERATOR_DIAGNOSTIC_SERVICE_URL?.trim();
  if (!value) throw new ControlPlaneError("The operator diagnostic service is not configured.", 503);
  try {
    const url = new URL(value);
    const local = process.env.NODE_ENV !== "production" && url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new Error("unsafe operator diagnostic URL");
    }
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}${path}`;
    return url;
  } catch {
    throw new ControlPlaneError("The operator diagnostic service URL is invalid.", 503);
  }
}

const shopifyPrivacyCaseSchema = z.object({
  case_id: ulidSchema,
  topic: z.enum(["customers/data_request", "customers/redact"]),
  status: z.enum([
    "queued","redaction_dispatched","awaiting_operator_export",
    "export_in_progress","awaiting_delivery","attention_required","completed",
  ]),
  target_tenant_id: ulidSchema,
  target_connection_id: ulidSchema,
  customer_reference: z.string().regex(/^(0|[1-9][0-9]{0,29})$/u).nullable(),
  order_references: z.array(z.string().regex(/^(0|[1-9][0-9]{0,29})$/u)).max(5_000),
  data_request_reference: z.string().regex(/^(0|[1-9][0-9]{0,29})$/u).nullable(),
  complete_by: z.string().min(1),
  overdue: z.boolean(),
  last_error_code: z.string().nullable(),
}).strict();

export type OperatorShopifyPrivacyCase = z.infer<typeof shopifyPrivacyCaseSchema>;

export async function loadShopifyPrivacyCases(): Promise<readonly OperatorShopifyPrivacyCase[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_shopify_privacy_cases");
  if (error) throw operatorError(error, "Shopify privacy cases could not be loaded.");
  const parsed = z.array(shopifyPrivacyCaseSchema).safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("Shopify privacy cases returned invalid metadata.", 503);
  }
  return Object.freeze(parsed.data);
}

const shopifyPrivacyExportGrantSchema = z.object({
  case_id: ulidSchema,
  export_id: ulidSchema,
  expires_at: z.string().min(1),
}).strict();

export async function createShopifyPrivacyExport(
  caseId: string,
): Promise<Readonly<{ artifact: ShopifyPrivacyArtifact; artifactSha256: string }>> {
  const { supabase } = await requireUser();
  const exportId = ulid();
  const { data, error } = await supabase.rpc("begin_albert_shopify_privacy_export", {
    p_case_id: caseId,
    p_export_id: exportId,
  });
  if (error) {
    if (error.code === "P0001") {
      throw new ControlPlaneError("Too many privacy exports. Wait and retry.", 429);
    }
    throw operatorError(error, "The Shopify privacy export could not be authorised.");
  }
  const grant = shopifyPrivacyExportGrantSchema.safeParse(data);
  if (!grant.success || grant.data.case_id !== caseId || grant.data.export_id !== exportId) {
    throw new ControlPlaneError("The Shopify privacy export grant returned invalid metadata.", 503);
  }
  const body = JSON.stringify({ exportId });
  const url = operatorDiagnosticServiceUrl("/v1/shopify-privacy-exports");
  const headers = await signInternalRequest({
    method: "POST",
    path: "/v1/shopify-privacy-exports",
    body,
    secret: operatorDiagnosticSecret(),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new ControlPlaneError("The Shopify privacy export service is unavailable.", 503);
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => null) as Readonly<{
    artifact?: unknown;
    artifactSha256?: unknown;
  }> | null;
  if (!response.ok) {
    throw new ControlPlaneError("The Shopify privacy export could not be produced.", 503);
  }
  const artifact = shopifyPrivacyArtifactSchema.safeParse(payload?.artifact);
  if (!artifact.success || artifact.data.caseId !== caseId || artifact.data.exportId !== exportId ||
      typeof payload?.artifactSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(payload.artifactSha256)) {
    throw new ControlPlaneError("The Shopify privacy export returned invalid content.", 503);
  }
  const receivedDigest = createHash("sha256")
    .update(JSON.stringify(artifact.data), "utf8")
    .digest("hex");
  if (receivedDigest !== payload.artifactSha256) {
    throw new ControlPlaneError("The Shopify privacy export digest does not match its content.", 503);
  }
  return Object.freeze({ artifact: artifact.data, artifactSha256: payload.artifactSha256 });
}

export async function recordShopifyPrivacyDelivery(input: Readonly<{
  caseId: string;
  exportId: string;
  deliveryChannel: "direct_to_shop_owner" | "approved_secure_portal";
  deliveredAt: string;
}>): Promise<void> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("complete_albert_shopify_privacy_delivery", {
    p_case_id: input.caseId,
    p_export_id: input.exportId,
    p_delivery_channel: input.deliveryChannel,
    p_delivered_at: input.deliveredAt,
  });
  if (error) throw operatorError(error, "Shopify privacy delivery evidence could not be recorded.");
  const parsed = z.object({ case_id: ulidSchema, status: z.literal("completed") }).strict().safeParse(data);
  if (!parsed.success || parsed.data.case_id !== input.caseId) {
    throw new ControlPlaneError("Shopify privacy delivery returned invalid metadata.", 503);
  }
}

function operatorDiagnosticSecret(): string {
  const secret = process.env.ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET?.trim() ?? "";
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new ControlPlaneError("The operator diagnostic trust boundary is not configured.", 503);
  }
  return secret;
}

export async function revealOperatorRowSample(input: Readonly<{
  tenantId: string;
  stage: "staging";
  schemaName: "source_lightspeed" | "source_xero" | "source_deputy";
  tableName: string;
}>): Promise<OperatorRowSample> {
  const { supabase } = await requireUser();
  const revealId = ulid();
  const { data, error } = await supabase.rpc("begin_albert_operator_row_reveal", {
    p_reveal_id: revealId,
    p_tenant_id: input.tenantId,
    p_pipeline_stage: input.stage,
    p_schema_name: input.schemaName,
    p_table_name: input.tableName,
    p_row_limit: 3,
  });
  if (error) {
    if (error.code === "P0001") throw new ControlPlaneError("Too many diagnostic reveals. Wait a minute and try again.", 429);
    throw operatorError(error, "The audited row reveal could not be authorised.");
  }
  const grant = rowRevealGrantSchema.safeParse(data);
  if (!grant.success || grant.data.reveal_id !== revealId) {
    throw new ControlPlaneError("The row reveal grant returned invalid metadata.", 503);
  }
  const body = JSON.stringify({ revealId });
  const url = operatorDiagnosticServiceUrl();
  const headers = await signInternalRequest({
    method: "POST",
    path: "/v1/row-samples",
    body,
    secret: operatorDiagnosticSecret(),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new ControlPlaneError("The audited row sample service is unavailable.", 503);
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => null) as Readonly<{ sample?: unknown }> | null;
  if (!response.ok) throw new ControlPlaneError("The audited row sample could not be revealed.", 503);
  const sample = operatorDiagnosticSampleSchema.safeParse(payload?.sample);
  if (!sample.success || sample.data.revealId !== revealId ||
      sample.data.stage !== input.stage || sample.data.schemaName !== input.schemaName ||
      sample.data.tableName !== input.tableName) {
    throw new ControlPlaneError("The diagnostic service returned an invalid row sample.", 503);
  }
  return sample.data;
}
