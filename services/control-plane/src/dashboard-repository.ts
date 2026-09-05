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
  percentScale: z.enum(["ratio", "percent"]).optional(),
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
    // Mirrors TRACE_DERIVED_CALCULATION_OPERATORS in packages/shared (the
    // control plane deliberately does not import the runtime package); a
    // contract test keeps the two lists identical.
    operator: z.enum(["add", "subtract", "multiply", "divide", "percent_change", "percent_of"]),
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
  /** Sigma's "Hide column": the column stays in the query and the contract, out of the element. */
  hidden: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "A column presentation must change at least one display property.",
});

export const dashboardColumnPresentationSchema = z.record(
  z.string().min(1).max(160),
  dashboardColumnPresentationItemSchema,
).refine((value) => Object.keys(value).length <= 80, {
  message: "A dashboard tile supports at most 80 column presentations.",
});

/**
 * Element-level query overrides (ADR 0134): the owner's sort, filters and
 * row limit on one tile, in the tile's own snapshot column keys. Mirrors
 * control_plane.dashboard_query_overrides_valid (migration 0186). They never
 * touch the governed replay recipe; the refresh adapter applies them after
 * the digest checks and re-validates the effective query.
 */
export const DASHBOARD_QUERY_FILTER_OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "gt",
  "gte",
  "lt",
  "lte",
  "set",
  "notSet",
  "inDateRange",
  "notInDateRange",
  "beforeDate",
  "afterDate",
] as const;

const overrideColumnSchema = z.string().trim().min(1).max(160);

export const dashboardQueryOrderSchema = z.object({
  column: overrideColumnSchema,
  direction: z.enum(["asc", "desc"]),
}).strict();

export const dashboardQueryFilterSchema = z.object({
  column: overrideColumnSchema,
  operator: z.enum(DASHBOARD_QUERY_FILTER_OPERATORS),
  values: z.array(z.string().max(200)).max(50),
}).strict();

export const dashboardQueryOverridesSchema = z.object({
  order: z.array(dashboardQueryOrderSchema).max(3).optional(),
  filters: z.array(dashboardQueryFilterSchema).max(8).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();

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

/**
 * How a tile presents its governed snapshot: the classic table, a KPI card
 * over a single-value (optionally two-period compare) result, or a
 * grounded-flint chart compiled from the snapshot's columns and rows.
 * Column keys are matched tolerantly by the renderer (`sales_gross` ≡
 * `sales.gross`) because runtimes publish underscore keys while refresh
 * snapshots carry raw member keys.
 */
export const dashboardTileDisplaySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("table"),
    note: z.string().max(160).optional(),
  }).strict(),
  z.object({
    mode: z.literal("kpi"),
    valueKey: z.string().min(1).max(160).optional(),
    /** How the KPI presents its comparison (Sigma's KPI chart: "% difference from", "Difference from", "% of", "Absolute"). */
    comparison: z.enum(["percent_difference", "difference", "percent_of", "absolute"]).optional(),
    /** Which direction of change is coloured as good. */
    betterWhen: z.enum(["higher", "lower"]).optional(),
    note: z.string().max(160).optional(),
  }).strict(),
  z.object({
    mode: z.literal("chart"),
    chartType: z.enum(["bar", "line"]),
    xKey: z.string().min(1).max(160),
    yKey: z.string().min(1).max(160),
    series: z.array(z.object({
      key: z.string().min(1).max(160),
      label: z.string().min(1).max(160),
    }).strict()).max(6).optional(),
    stacked: z.boolean().optional(),
    orientation: z.enum(["vertical", "horizontal"]).optional(),
    note: z.string().max(160).optional(),
  }).strict(),
]);

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
  /**
   * The governed query behind a cube_v3 tile, as the user-safe YAML every
   * trace already shows. Optional as well as nullable: documents from a
   * database that predates migration 0186 omit it.
   */
  queryYaml: z.string().max(32_000).nullable().optional(),
  /**
   * Bumped whenever a requery re-mints the governed recipe (migration
   * 0187); a requery names the version it edited so a stale editor cannot
   * overwrite a newer recipe. Optional on documents from a pre-0187 database.
   */
  recipeVersion: z.number().int().positive().optional(),
  recipeOrigin: z.enum(["trace", "edited"]).optional(),
  snapshot: dashboardSnapshotSchema.nullable(),
  columnPresentation: dashboardColumnPresentationSchema,
  display: dashboardTileDisplaySchema,
  queryOverrides: dashboardQueryOverridesSchema.default({}),
  refreshState: z.enum(["current", "refreshing", "stale", "error"]),
  lastErrorCode: z.string().nullable(),
  lastRefreshAttemptAt: z.string().nullable(),
  lastRefreshedAt: z.string().nullable(),
  createdAt: z.string(),
}).strict();

export const dashboardDocumentSchema = z.object({
  dashboardId: ulidSchema,
  // Optional as well as nullable: documents from a database that predates
  // migration 0181 simply omit the field.
  title: z.string().trim().min(1).max(80).nullable().optional(),
  revision: z.number().int().nonnegative(),
  layouts: dashboardLayoutsSchema,
  /** The conversation that last built this dashboard (migration 0186). */
  lastBuildConversationId: ulidSchema.nullable().optional(),
  tiles: z.array(dashboardTileSchema).max(24),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

/** One row of the member's dashboard list. */
export const dashboardSummarySchema = z.object({
  dashboardId: ulidSchema,
  title: z.string().trim().min(1).max(80).nullable().optional(),
  revision: z.number().int().nonnegative(),
  tileCount: z.number().int().nonnegative(),
  lastBuildConversationId: ulidSchema.nullable().optional(),
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
  queryOverrides: dashboardQueryOverridesSchema.optional(),
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
export type DashboardQueryOrder = z.infer<typeof dashboardQueryOrderSchema>;
export type DashboardQueryFilter = z.infer<typeof dashboardQueryFilterSchema>;
export type DashboardQueryOverrides = z.infer<typeof dashboardQueryOverridesSchema>;
export type DashboardTileDisplay = z.infer<typeof dashboardTileDisplaySchema>;
export type DashboardTile = z.infer<typeof dashboardTileSchema>;
export type DashboardDocument = z.infer<typeof dashboardDocumentSchema>;
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;
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

function parseDashboardList(value: unknown): readonly DashboardSummary[] {
  const parsed = z.array(dashboardSummarySchema).max(200).safeParse(value ?? []);
  if (!parsed.success) {
    throw new ControlPlaneError("The dashboard list returned invalid state.", 503);
  }
  return parsed.data;
}

type Supabase = Awaited<ReturnType<typeof requireUser>>["supabase"];

function migrationMissing(error: Readonly<{ code?: string }>): boolean {
  return error.code === "PGRST202" || error.code === "42883";
}

async function currentDashboardWith(
  supabase: Supabase,
  dashboardId?: string,
): Promise<DashboardDocument> {
  const { data, error } = await supabase.rpc("albert_dashboard_get", {
    p_dashboard_id: dashboardId ?? null,
  });
  if (error) {
    if (migrationMissing(error)) {
      throw new ControlPlaneError("The dashboard migration is not deployed.", 503);
    }
    if (error.code === "P0002") throw new ControlPlaneError("That dashboard was not found.", 404);
    throw new ControlPlaneError("The dashboard could not be loaded.", 503);
  }
  return parseDashboard(data);
}

function mutationError(error: Readonly<{ code?: string; message?: string }>): ControlPlaneError {
  if (error.code === "P0002") return new ControlPlaneError("The dashboard item was not found.", 404);
  if (error.code === "22023") return new ControlPlaneError(error.message || "The dashboard change is invalid.", 400);
  if (error.code === "54000") {
    return new ControlPlaneError(
      /dashboards/u.test(error.message ?? "")
        ? "You can keep at most 40 dashboards."
        : "A dashboard supports at most 24 tiles.",
      409,
    );
  }
  if (error.code === "42501") return new ControlPlaneError("Dashboard access is denied.", 403);
  if (migrationMissing(error)) return new ControlPlaneError("The dashboard migration is not deployed.", 503);
  return new ControlPlaneError("The dashboard change could not be saved.", 503);
}

async function resolveMutation(
  supabase: Supabase,
  result: Readonly<{ data: unknown; error: null | Readonly<{ code?: string; message?: string }> }>,
  dashboardId?: string,
): Promise<DashboardDocument> {
  if (result.error?.code === "40001") {
    throw new DashboardRevisionConflict(await currentDashboardWith(supabase, dashboardId));
  }
  if (result.error) throw mutationError(result.error);
  return parseDashboard(result.data);
}

/** The member's dashboards, most recently touched first. */
export async function listDashboards(): Promise<readonly DashboardSummary[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_dashboard_list");
  if (error) {
    if (migrationMissing(error)) throw new ControlPlaneError("The dashboard migration is not deployed.", 503);
    throw new ControlPlaneError("The dashboards could not be listed.", 503);
  }
  return parseDashboardList(data);
}

/**
 * One dashboard by id, or — unnamed — the member's most recently touched
 * dashboard, created on first use (the pre-0186 behaviour hand-pinning
 * from a chat relies on).
 */
export async function loadDashboard(dashboardId?: string): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return currentDashboardWith(supabase, dashboardId);
}

/** A new, empty dashboard the owner then builds in natural language. */
export async function createDashboard(title?: string | null): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  const result = await supabase.rpc("albert_dashboard_create", { p_title: title ?? null });
  if (result.error) throw mutationError(result.error);
  return parseDashboard(result.data);
}

export async function deleteDashboard(dashboardId: string): Promise<readonly DashboardSummary[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_dashboard_delete", { p_dashboard_id: dashboardId });
  if (error) throw mutationError(error);
  return parseDashboardList(data);
}

/** Remembers the conversation whose build last applied to this dashboard. */
export async function linkDashboardConversation(input: Readonly<{
  conversationId: string;
  expectedRevision: number;
  dashboardId?: string;
}>): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return resolveMutation(supabase, await supabase.rpc("albert_dashboard_link_conversation", {
    p_conversation_id: input.conversationId,
    p_expected_revision: input.expectedRevision,
    p_dashboard_id: input.dashboardId ?? null,
  }), input.dashboardId);
}

export async function pinDashboardTile(input: Readonly<{
  conversationId: string;
  turnId: string;
  tableEventId: string;
  resultId: string;
  expectedRevision: number;
  dashboardId?: string;
}>): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return resolveMutation(supabase, await supabase.rpc("albert_dashboard_pin", {
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
    p_table_event_id: input.tableEventId,
    p_result_id: input.resultId,
    p_expected_revision: input.expectedRevision,
    p_dashboard_id: input.dashboardId ?? null,
  }), input.dashboardId);
}

export async function updateDashboardLayouts(
  layouts: DashboardLayouts,
  expectedRevision: number,
  dashboardId?: string,
): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return resolveMutation(supabase, await supabase.rpc("albert_dashboard_layout_update", {
    p_layouts: layouts,
    p_expected_revision: expectedRevision,
    p_dashboard_id: dashboardId ?? null,
  }), dashboardId);
}

export async function renameDashboard(
  title: string | null,
  expectedRevision: number,
  dashboardId?: string,
): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return resolveMutation(supabase, await supabase.rpc("albert_dashboard_rename", {
    p_title: title,
    p_expected_revision: expectedRevision,
    p_dashboard_id: dashboardId ?? null,
  }), dashboardId);
}

export async function updateDashboardTile(input: Readonly<{
  tileId: string;
  expectedRevision: number;
  title?: string;
  columnPresentation?: DashboardColumnPresentation;
  display?: DashboardTileDisplay;
  queryOverrides?: DashboardQueryOverrides;
  /** Authored column order (ADR 0134): rewrites the snapshot's column contract; unnamed columns keep their place after. */
  columnOrder?: readonly string[];
  dashboardId?: string;
}>): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return resolveMutation(supabase, await supabase.rpc("albert_dashboard_tile_update", {
    p_tile_id: input.tileId,
    p_expected_revision: input.expectedRevision,
    p_title: input.title ?? null,
    p_column_presentation: input.columnPresentation ?? null,
    p_display: input.display ?? null,
    p_query_overrides: input.queryOverrides ?? null,
    p_dashboard_id: input.dashboardId ?? null,
    p_column_order: input.columnOrder ? [...input.columnOrder] : null,
  }), input.dashboardId);
}

export type DashboardCubeRecipe = z.infer<typeof cubeReplayRecipeSchema>;

export class DashboardRecipeConflict extends ControlPlaneError {
  constructor(readonly dashboard: DashboardDocument) {
    super("This element was edited in another tab; it has been reloaded.", 409);
    this.name = "DashboardRecipeConflict";
  }
}

/**
 * A deterministic requery (migration 0187): the server-minted governed
 * recipe and the snapshot it produced land on the tile in one transaction,
 * bumping the recipe version and clearing any refresh lease.
 */
export async function requeryDashboardTile(input: Readonly<{
  tileId: string;
  expectedRevision: number;
  recipeVersion: number;
  recipe: DashboardCubeRecipe;
  snapshot: DashboardSnapshot;
  resultDigest: string;
  rowCount: number;
  sourceWatermarks: readonly unknown[];
  startedAt: string;
  latencyMs: number;
  dedupeStatus: "executed" | "cache_hit";
  display?: DashboardTileDisplay;
  queryOverrides?: DashboardQueryOverrides;
  columnPresentation?: DashboardColumnPresentation;
  adapterMetadata?: Readonly<Record<string, unknown>>;
  dashboardId?: string;
}>): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  const result = await supabase.rpc("albert_dashboard_tile_requery", {
    p_tile_id: input.tileId,
    p_expected_revision: input.expectedRevision,
    p_recipe_version: input.recipeVersion,
    p_recipe: input.recipe,
    p_snapshot: input.snapshot,
    p_result_digest: input.resultDigest,
    p_row_count: input.rowCount,
    p_source_watermarks: [...input.sourceWatermarks],
    p_started_at: input.startedAt,
    p_latency_ms: input.latencyMs,
    p_dedupe_status: input.dedupeStatus,
    p_display: input.display ?? null,
    p_query_overrides: input.queryOverrides ?? null,
    p_column_presentation: input.columnPresentation ?? null,
    p_adapter_metadata: input.adapterMetadata ?? {},
    p_dashboard_id: input.dashboardId ?? null,
  });
  if (result.error?.code === "40001") {
    const current = await currentDashboardWith(supabase, input.dashboardId);
    const tile = current.tiles.find((candidate) => candidate.tileId === input.tileId);
    if (tile && tile.recipeVersion !== undefined && tile.recipeVersion !== input.recipeVersion) {
      throw new DashboardRecipeConflict(current);
    }
    throw new DashboardRevisionConflict(current);
  }
  if (result.error) throw mutationError(result.error);
  return parseDashboard(result.data);
}

/** Hands back a refresh lease a requery took but could not use; no outcome is recorded. */
export async function releaseDashboardRefresh(input: Readonly<{
  tileId: string;
  leaseId: string;
  dashboardId?: string;
}>): Promise<void> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("albert_dashboard_refresh_release", {
    p_tile_id: input.tileId,
    p_lease_id: input.leaseId,
    p_dashboard_id: input.dashboardId ?? null,
  });
  if (error) throw mutationError(error);
}

/**
 * Applies a wand edit in one RPC (migration 0187): deletes the edited tile,
 * pins its replacement from the persisted trace, sets title and display,
 * keeps the old slot on both breakpoints and links the build conversation.
 * `layouts` names the replacement as the placeholder id `__replacement__`.
 */
export async function replaceDashboardElement(input: Readonly<{
  dashboardId: string;
  replaceTileId: string;
  conversationId: string;
  turnId: string;
  tableEventId: string;
  resultId: string;
  title: string;
  display: DashboardTileDisplay;
  layouts: Readonly<{ desktop: readonly Readonly<Record<string, unknown>>[]; tablet: readonly Readonly<Record<string, unknown>>[] }>;
  expectedRevision: number;
}>): Promise<Readonly<{ dashboard: DashboardDocument; newTileId: string }>> {
  const { supabase } = await requireUser();
  const result = await supabase.rpc("albert_dashboard_element_replace", {
    p_dashboard_id: input.dashboardId,
    p_replace_tile_id: input.replaceTileId,
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
    p_table_event_id: input.tableEventId,
    p_result_id: input.resultId,
    p_title: input.title,
    p_display: input.display,
    p_layouts: input.layouts,
    p_expected_revision: input.expectedRevision,
  });
  if (result.error?.code === "40001") {
    throw new DashboardRevisionConflict(await currentDashboardWith(supabase, input.dashboardId));
  }
  if (result.error) throw mutationError(result.error);
  const raw = singleton(result.data);
  const newTileId = raw && typeof raw === "object" ? (raw as { newTileId?: unknown }).newTileId : undefined;
  if (typeof newTileId !== "string") throw new ControlPlaneError("The element replacement returned invalid state.", 503);
  const document = { ...(raw as Record<string, unknown>) };
  delete document.replacedTileId;
  delete document.newTileId;
  return { dashboard: parseDashboard(document), newTileId };
}

export async function deleteDashboardTile(
  tileId: string,
  expectedRevision: number,
  dashboardId?: string,
): Promise<DashboardDocument> {
  const { supabase } = await requireUser();
  return resolveMutation(supabase, await supabase.rpc("albert_dashboard_tile_delete", {
    p_tile_id: tileId,
    p_expected_revision: expectedRevision,
    p_dashboard_id: dashboardId ?? null,
  }), dashboardId);
}

export async function claimDashboardRefresh(input: Readonly<{
  tileIds?: readonly string[];
  force: boolean;
  dashboardId?: string;
}>): Promise<readonly DashboardRefreshClaim[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_dashboard_refresh_claim", {
    p_tile_ids: input.tileIds ? [...input.tileIds] : null,
    p_force: input.force,
    p_dashboard_id: input.dashboardId ?? null,
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
