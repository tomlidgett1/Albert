import { z } from "zod";

import { ControlPlaneError, requireUser } from "./web-repository.js";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const dashboardLayoutItemSchema = z.object({
  i: ulidSchema,
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(10_000),
  w: z.number().int().min(3).max(12),
  h: z.number().int().min(5).max(16),
}).strict();

export const dashboardLayoutsSchema = z.object({
  desktop: z.array(dashboardLayoutItemSchema).max(24),
  tablet: z.array(dashboardLayoutItemSchema).max(24),
}).strict();

const dashboardColumnSchema = z.object({
  key: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
  type: z.enum(["string", "number", "currency", "percent", "date", "datetime"]),
  currency: z.string().length(3).optional(),
}).passthrough();

const derivedIndexedSourceCellSchema = z.object({
  kind: z.literal("source"),
  sourceResultId: z.string().min(1).max(160),
  rowIndex: z.number().int().min(0).max(49),
  columnKey: z.string().min(1).max(160),
}).strict();

const derivedMatchedSourceCellSchema = z.object({
  kind: z.literal("matched_source"),
  sourceResultId: z.string().min(1).max(160),
  columnKey: z.string().min(1).max(160),
  matchColumnKey: z.string().min(1).max(160),
  matchValue: derivedIndexedSourceCellSchema,
}).strict();

const derivedSourceCellSchema = z.discriminatedUnion("kind", [
  derivedIndexedSourceCellSchema,
  derivedMatchedSourceCellSchema,
]);

const derivedNumericOperandSchema = z.discriminatedUnion("kind", [
  derivedIndexedSourceCellSchema,
  derivedMatchedSourceCellSchema,
  z.object({ kind: z.literal("number"), value: z.number().finite() }).strict(),
]);

const derivedExpressionSchema = z.discriminatedUnion("kind", [
  derivedIndexedSourceCellSchema,
  derivedMatchedSourceCellSchema,
  z.object({
    kind: z.literal("literal"),
    value: z.union([z.string().max(400), z.number().finite(), z.null()]),
  }).strict(),
  z.object({
    kind: z.literal("calculation"),
    operator: z.enum(["add", "subtract", "multiply", "divide"]),
    left: derivedNumericOperandSchema,
    right: derivedNumericOperandSchema,
  }).strict(),
]);

export const dashboardDerivationSchema = z.object({
  version: z.literal("derived_table_v1"),
  sources: z.array(z.object({
    tableEventId: ulidSchema,
    resultId: z.string().min(1).max(160),
  }).strict()).min(1).max(12),
  columns: z.array(dashboardColumnSchema.extend({
    labelSource: derivedSourceCellSchema.optional(),
  }).strict()).min(1).max(80),
  rows: z.array(z.object({
    cells: z.array(z.object({
      columnKey: z.string().min(1).max(160),
      expression: derivedExpressionSchema,
    }).strict()).min(1).max(80),
  }).strict()).max(50),
}).strict();

export const dashboardColumnFormatSchema = z.enum([
  "number",
  "currency",
  "percent",
  "text",
  "date",
  "datetime",
]);

export const dashboardColumnPresentationItemSchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  format: dashboardColumnFormatSchema.optional(),
  decimals: z.number().int().min(0).max(6).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "A column presentation must change at least one display property.",
});

export const dashboardColumnPresentationSchema = z.record(
  z.string().min(1).max(160),
  dashboardColumnPresentationItemSchema,
).refine((value) => Object.keys(value).length <= 80, {
  message: "A dashboard tile supports at most 80 column presentations.",
});

export const dashboardSnapshotSchema = z.object({
  columns: z.array(dashboardColumnSchema).max(80),
  rows: z.array(z.record(z.string(), z.unknown())).max(50),
  totalRowCount: z.number().int().nonnegative(),
  resultDigest: digestSchema,
  provenance: z.record(z.string(), z.unknown()).nullable().optional(),
  sourceWatermarks: z.array(z.unknown()).max(40),
  queryTime: z.string(),
  refreshedAt: z.string(),
  empty: z.boolean(),
}).strict();

export const dashboardTileSchema = z.object({
  tileId: ulidSchema,
  title: z.string().min(1).max(120),
  source: z.object({
    conversationId: ulidSchema,
    turnId: ulidSchema,
    tableEventId: ulidSchema,
    resultId: z.string().min(1).max(160),
  }).strict(),
  replayKind: z.enum(["cube_v3", "semantic_v2", "derived_v1"]),
  snapshot: dashboardSnapshotSchema.nullable(),
  columnPresentation: dashboardColumnPresentationSchema,
  refreshState: z.enum(["current", "refreshing", "stale", "error"]),
  lastErrorCode: z.string().nullable(),
  lastRefreshAttemptAt: z.string().nullable(),
  lastRefreshedAt: z.string().nullable(),
  createdAt: z.string(),
}).strict();

export const dashboardDocumentSchema = z.object({
  dashboardId: ulidSchema,
  revision: z.number().int().nonnegative(),
  layouts: dashboardLayoutsSchema,
  tiles: z.array(dashboardTileSchema).max(24),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

const cubeReplayRecipeSchema = z.object({
  kind: z.literal("cube_v3"),
  queryYaml: z.string().min(1).max(32_000),
  queryDigest: digestSchema,
  semanticVersionDigest: digestSchema,
  view: z.string().min(1).max(160),
  connector: z.string().min(1).max(80).nullable().optional(),
}).strict();

const semanticReplayRecipeSchema = z.object({
  kind: z.literal("semantic_v2"),
  executionId: z.string().min(1).max(160),
  resultId: z.string().min(1).max(160),
  publicationHash: digestSchema,
}).strict();

const refreshClaimSchema = z.object({
  tileId: ulidSchema,
  replayKind: z.enum(["cube_v3", "semantic_v2", "derived_v1"]),
  recipe: z.discriminatedUnion("kind", [
    cubeReplayRecipeSchema,
    semanticReplayRecipeSchema,
    z.object({
      kind: z.literal("derived_v1"),
      transform: dashboardDerivationSchema,
      transformDigest: digestSchema,
      sources: z.array(z.object({
        tableEventId: ulidSchema,
        resultId: z.string().min(1).max(160),
        recipe: z.discriminatedUnion("kind", [
          cubeReplayRecipeSchema,
          semanticReplayRecipeSchema,
        ]),
      }).strict()).min(1).max(12),
    }).strict(),
  ]),
  source: z.object({
    conversationId: ulidSchema,
    turnId: ulidSchema,
    resultId: z.string().min(1).max(160),
  }).strict(),
  previousSnapshot: dashboardSnapshotSchema.nullable(),
  claimedAt: z.string(),
  leaseId: ulidSchema,
}).strict();

export type DashboardLayoutItem = z.infer<typeof dashboardLayoutItemSchema>;
export type DashboardLayouts = z.infer<typeof dashboardLayoutsSchema>;
export type DashboardSnapshot = z.infer<typeof dashboardSnapshotSchema>;
export type DashboardColumnFormat = z.infer<typeof dashboardColumnFormatSchema>;
export type DashboardColumnPresentationItem = z.infer<typeof dashboardColumnPresentationItemSchema>;
export type DashboardColumnPresentation = z.infer<typeof dashboardColumnPresentationSchema>;
export type DashboardTile = z.infer<typeof dashboardTileSchema>;
export type DashboardDocument = z.infer<typeof dashboardDocumentSchema>;
export type DashboardRefreshClaim = z.infer<typeof refreshClaimSchema>;

export class DashboardRevisionConflict extends ControlPlaneError {
  constructor(readonly dashboard: DashboardDocument) {
    super("The dashboard changed in another tab.", 409);
    this.name = "DashboardRevisionConflict";
  }
}

function singleton(value: unknown): unknown {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function parseDashboard(value: unknown): DashboardDocument {
  const parsed = dashboardDocumentSchema.safeParse(singleton(value));
  if (!parsed.success) {
    throw new ControlPlaneError("The dashboard returned invalid state.", 503);
  }
  return parsed.data;
}

async function currentDashboardWith(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
): Promise<DashboardDocument> {
  const { data, error } = await supabase.rpc("albert_dashboard_get");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ControlPlaneError("The dashboard migration is not deployed.", 503);
    }
    throw new ControlPlaneError("The dashboard could not be loaded.", 503);
  }
  return parseDashboard(data);
}

function mutationError(error: Readonly<{ code?: string; message?: string }>): ControlPlaneError {
  if (error.code === "P0002") return new ControlPlaneError("The dashboard item was not found.", 404);
  if (error.code === "22023") return new ControlPlaneError(error.message || "The dashboard change is invalid.", 400);
  if (error.code === "54000") return new ControlPlaneError("A dashboard supports at most 24 tiles.", 409);
  if (error.code === "42501") return new ControlPlaneError("Dashboard access is denied.", 403);
  return new ControlPlaneError("The dashboard change could not be saved.", 503);
}

async function resolveMutation(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  result: Readonly<{ data: unknown; error: null | Readonly<{ code?: string; message?: string }> }>,
): Promise<DashboardDocument> {
  if (result.error?.code === "40001") {
    throw new DashboardRevisionConflict(await currentDashboardWith(supabase));
  }
  if (result.error) throw mutationError(result.error);
  return parseDashboard(result.data);
}

export async function loadDashboard(): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return currentDashboardWith(supabase);
}

export async function pinDashboardTile(input: Readonly<{
  conversationId: string;
  turnId: string;
  tableEventId: string;
  resultId: string;
  expectedRevision: number;
}>): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return resolveMutation(supabase, await supabase.rpc("albert_dashboard_pin", {
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
    p_table_event_id: input.tableEventId,
    p_result_id: input.resultId,
    p_expected_revision: input.expectedRevision,
  }));
}

export async function updateDashboardLayouts(
  layouts: DashboardLayouts,
  expectedRevision: number,
): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return resolveMutation(supabase, await supabase.rpc("albert_dashboard_layout_update", {
    p_layouts: layouts,
    p_expected_revision: expectedRevision,
  }));
}

export async function updateDashboardTile(input: Readonly<{
  tileId: string;
  expectedRevision: number;
  title?: string;
  columnPresentation?: DashboardColumnPresentation;
}>): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return resolveMutation(supabase, await supabase.rpc("albert_dashboard_tile_update", {
    p_tile_id: input.tileId,
    p_expected_revision: input.expectedRevision,
    p_title: input.title ?? null,
    p_column_presentation: input.columnPresentation ?? null,
  }));
}

export async function deleteDashboardTile(
  tileId: string,
  expectedRevision: number,
): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return resolveMutation(supabase, await supabase.rpc("albert_dashboard_tile_delete", {
    p_tile_id: tileId,
    p_expected_revision: expectedRevision,
  }));
}

export async function claimDashboardRefresh(input: Readonly<{
  tileIds?: readonly string[];
  force: boolean;
}>): Promise<readonly DashboardRefreshClaim[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_dashboard_refresh_claim", {
    p_tile_ids: input.tileIds ? [...input.tileIds] : null,
    p_force: input.force,
  });
  if (error) throw mutationError(error);
  const parsed = z.array(refreshClaimSchema).max(24).safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Dashboard refresh returned invalid claims.", 503);
  return parsed.data;
}

export async function completeDashboardRefresh(input: Readonly<{
  tileId: string;
  claimedAt: string;
  leaseId: string;
  outcome: "success" | "empty" | "failure" | "incompatible";
  startedAt: string;
  latencyMs: number;
  snapshot: DashboardSnapshot | null;
  resultDigest: string | null;
  rowCount: number | null;
  sourceWatermarks: readonly unknown[];
  adapter: "cube_v3" | "semantic_v2" | "derived_v1";
  dedupeStatus: "executed" | "cache_hit";
  errorCode: string | null;
  adapterMetadata?: Readonly<Record<string, unknown>>;
}>): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  const result = await supabase.rpc("albert_dashboard_refresh_complete", {
    p_tile_id: input.tileId,
    p_claimed_at: input.claimedAt,
    p_lease_id: input.leaseId,
    p_outcome: input.outcome,
    p_started_at: input.startedAt,
    p_latency_ms: input.latencyMs,
    p_snapshot: input.snapshot,
    p_result_digest: input.resultDigest,
    p_row_count: input.rowCount,
    p_source_watermarks: [...input.sourceWatermarks],
    p_adapter: input.adapter,
    p_dedupe_status: input.dedupeStatus,
    p_error_code: input.errorCode,
    p_adapter_metadata: input.adapterMetadata ?? {},
  });
  return resolveMutation(supabase, result);
}
