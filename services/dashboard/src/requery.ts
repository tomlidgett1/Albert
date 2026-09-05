/**
 * The requery lane (ADR 0134, migration 0187): one deterministic edit to an
 * element's governed query, run server-side and stored as a re-minted,
 * digest-locked recipe with its snapshot in a single transaction.
 *
 * The lane claims the tile's refresh lease (the Cube capability needs a
 * live lease), patches the recipe's CubeQuery with the owner's edit, keeps
 * the query on the recipe's view, validates it against the live catalogue,
 * applies the element's own sort/filters/limit for the run, and hands the
 * new recipe and snapshot to `albert_dashboard_tile_requery`. Presentation,
 * display keys and overrides are carried across a re-spelled time column.
 * If anything fails after the claim, the lease is released without an
 * outcome so the element keeps its data and shows the edit's own message.
 */
import { load as loadYaml } from "js-yaml";

import {
  CubeClient,
  cubeQueryDigest,
  cubeQueryReplayDigestMatches,
  cubeQueryToYaml,
  cubeSemanticVersionDigest,
  validateCubeQuery,
} from "@/packages/albert-v3/src/cube/client";
import { alignColumnsForRequery, cubeResultColumns } from "@/packages/albert-v3/src/cube/presentation";
import type { CubeQuery } from "@/packages/albert-v3/src/cube/types";
import {
  claimDashboardRefresh,
  DashboardRecipeConflict,
  loadDashboard,
  releaseDashboardRefresh,
  requeryDashboardTile,
  type DashboardColumnPresentation,
  type DashboardDocument,
  type DashboardQueryOverrides,
  type DashboardRefreshClaim,
  type DashboardSnapshot,
  type DashboardTile,
  type DashboardTileDisplay,
} from "@/services/control-plane/src/dashboard-repository";
import { ControlPlaneError, type TenantContext } from "@/services/control-plane/src/web-repository";
import { cachedCatalogue } from "./catalogue-cache";
import { applyDashboardQueryEdits, type DashboardQueryEdit } from "./query-edits";
import { applyDashboardQueryOverrides } from "./query-overrides";
import { snapshotCell, snapshotResultDigest } from "./refresh";

export type DashboardRequeryInput = Readonly<{
  tileId: string;
  dashboardId?: string;
  expectedRevision: number;
  recipeVersion: number;
  edits: readonly DashboardQueryEdit[];
  /** Display to apply with the new snapshot (keys in the current column spelling). */
  display?: DashboardTileDisplay;
}>;

export type DashboardRequeryResult = Readonly<{
  dashboard: DashboardDocument;
  tile: DashboardTile;
  executionMs: number;
}>;

/** A failure the owner can act on; the element keeps its data. */
export class DashboardRequeryError extends ControlPlaneError {
  constructor(message: string, readonly code: string, status = 400) {
    super(message, status);
    this.name = "DashboardRequeryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CLAIM_ATTEMPTS = 4;
const CLAIM_RETRY_MS = 1_500;

async function claimTile(input: DashboardRequeryInput): Promise<DashboardRefreshClaim> {
  for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
    const claims = await claimDashboardRefresh({ tileIds: [input.tileId], force: true, dashboardId: input.dashboardId });
    const claim = claims.find((candidate) => candidate.tileId === input.tileId);
    if (claim) return claim;
    // A background refresh holds the lease for a few seconds; wait it out.
    if (attempt < CLAIM_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_MS));
  }
  throw new DashboardRequeryError("This element is refreshing right now; try again in a moment.", "element_busy", 409);
}

function remapKeys<T extends Record<string, unknown>>(value: T, renamed: ReadonlyMap<string, string>): T {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [renamed.get(key) ?? key, entry])) as T;
}

function remapDisplay(display: DashboardTileDisplay, renamed: ReadonlyMap<string, string>): DashboardTileDisplay {
  const rename = (key: string) => renamed.get(key) ?? key;
  switch (display.mode) {
    case "kpi":
      return display.valueKey ? { ...display, valueKey: rename(display.valueKey) } : display;
    case "chart":
      return {
        ...display,
        xKey: rename(display.xKey),
        yKey: rename(display.yKey),
        ...(display.series ? { series: display.series.map((entry) => ({ ...entry, key: rename(entry.key) })) } : {}),
      };
    default:
      return display;
  }
}

function remapOverrides(overrides: DashboardQueryOverrides, renamed: ReadonlyMap<string, string>): DashboardQueryOverrides {
  const rename = (key: string) => renamed.get(key) ?? key;
  return {
    ...(overrides.order ? { order: overrides.order.map((entry) => ({ ...entry, column: rename(entry.column) })) } : {}),
    ...(overrides.filters ? { filters: overrides.filters.map((entry) => ({ ...entry, column: rename(entry.column) })) } : {}),
    ...(overrides.limit !== undefined ? { limit: overrides.limit } : {}),
  };
}

/** Keeps only entries whose column survives in the new contract. */
function pruneToColumns<T extends { column: string }>(entries: readonly T[] | undefined, keys: ReadonlySet<string>): T[] | undefined {
  if (!entries) return undefined;
  const kept = entries.filter((entry) => keys.has(entry.column));
  return kept.length > 0 ? kept : undefined;
}

export async function requeryDashboardElement(
  input: DashboardRequeryInput,
  tenant: TenantContext,
  options: Readonly<{ currency?: string; sourceWatermarks?: readonly unknown[] }> = {},
): Promise<DashboardRequeryResult> {
  const apiUrl = process.env.CUBE_API_URL?.trim();
  const apiSecret = process.env.CUBEJS_API_SECRET?.trim();
  if (!apiUrl || !apiSecret) throw new DashboardRequeryError("The governed query runtime is unavailable.", "cube_runtime_unavailable", 503);

  const dashboard = await loadDashboard(input.dashboardId);
  const tile = dashboard.tiles.find((candidate) => candidate.tileId === input.tileId);
  if (!tile) throw new ControlPlaneError("That element is no longer on the dashboard.", 404);
  if (tile.replayKind !== "cube_v3" || !tile.queryYaml) {
    throw new DashboardRequeryError("Only an element with a governed query behind it can be edited this way; use the Albert wand.", "not_requeryable", 409);
  }
  if (tile.recipeVersion !== undefined && tile.recipeVersion !== input.recipeVersion) {
    throw new DashboardRecipeConflict(dashboard);
  }

  const claim = await claimTile(input);
  const startedAt = new Date();
  try {
    if (claim.recipe.kind !== "cube_v3") {
      throw new DashboardRequeryError("Only an element with a governed query behind it can be edited this way.", "not_requeryable", 409);
    }
    let base: CubeQuery;
    try {
      const parsed = loadYaml(claim.recipe.queryYaml);
      if (!isRecord(parsed)) throw new Error("not a query");
      base = parsed as CubeQuery;
    } catch {
      throw new DashboardRequeryError("This element's governed query could not be read.", "invalid_replay_recipe", 409);
    }
    if (!cubeQueryReplayDigestMatches(base, claim.recipe.queryDigest)) {
      throw new DashboardRequeryError("This element's governed query no longer matches its seal.", "query_digest_mismatch", 409);
    }

    const client = new CubeClient({
      apiUrl,
      apiSecret,
      securityContext: {
        tenant_id: tenant.tenant_id,
        dashboard_tile_id: claim.tileId,
        dashboard_refresh_lease_id: claim.leaseId,
      },
    });
    const catalogue = await cachedCatalogue(apiUrl, client);
    const edited = applyDashboardQueryEdits(base, input.edits, catalogue, claim.recipe.view);
    if (!edited.ok) throw new DashboardRequeryError(edited.error, "edit_invalid");
    // The re-minted recipe is the edited base query without timezone/limit
    // defaults the validator adds, so its YAML stays as lean as the trace's.
    const validated = validateCubeQuery(edited.query, catalogue);
    if ("error" in validated) throw new DashboardRequeryError(validated.error, "cube_query_invalid");
    if (validated.view !== claim.recipe.view) {
      throw new DashboardRequeryError("An element stays on the topic it was built from.", "view_changed");
    }

    const overrides = tile.queryOverrides ?? {};
    const overridden = applyDashboardQueryOverrides(validated.query, overrides);
    // An override that no longer applies (its column was removed) is dropped
    // below rather than blocking the edit.
    const effective = overridden.ok && overridden.query !== validated.query
      ? validateCubeQuery(overridden.query, catalogue)
      : validated;
    const runQuery = "error" in effective ? validated : effective;
    const { result } = await client.loadQuery(runQuery.query, { signal: AbortSignal.timeout(100_000) });
    if (!result.ok) {
      const timeout = /within 90 seconds|cancelled/iu.test(result.error);
      throw new DashboardRequeryError(
        timeout ? "The governed query took too long; try a narrower window." : "The governed query could not run for this edit.",
        timeout ? "query_timeout" : "cube_query_failed",
        timeout ? 504 : 502,
      );
    }

    const aligned = alignColumnsForRequery(
      cubeResultColumns(runQuery.query, result, options.currency),
      claim.previousSnapshot?.columns ?? null,
    );
    const rows = result.rows.slice(0, 50).map((row) => Object.fromEntries(
      aligned.members.map((member, index) => [aligned.columns[index]!.key, snapshotCell(row[member])]),
    ));
    const digest = snapshotResultDigest(result.rows);
    const refreshedAt = new Date().toISOString();
    const sourceWatermarks = options.sourceWatermarks?.length
      ? options.sourceWatermarks
      : claim.previousSnapshot?.sourceWatermarks ?? [];
    const snapshot: DashboardSnapshot = {
      columns: [...aligned.columns],
      rows,
      totalRowCount: result.rows.length,
      resultDigest: digest,
      provenance: claim.previousSnapshot?.provenance ?? null,
      sourceWatermarks: [...sourceWatermarks],
      queryTime: refreshedAt,
      refreshedAt,
      empty: result.rows.length === 0,
    };

    // The write is checked against the dashboard as it is NOW, not as it was
    // when the edit began: a title or layout change made while the query ran
    // must not fail the edit, and the tile's latest presentation, display and
    // overrides are what get carried across. The recipe version is the guard
    // against two edits of the same element.
    const latest = await loadDashboard(dashboard.dashboardId);
    const latestTile = latest.tiles.find((candidate) => candidate.tileId === input.tileId);
    if (!latestTile) throw new ControlPlaneError("That element is no longer on the dashboard.", 404);
    if (latestTile.recipeVersion !== undefined && latestTile.recipeVersion !== input.recipeVersion) {
      throw new DashboardRecipeConflict(latest);
    }
    const keys = new Set(aligned.columns.map((column) => column.key));
    const presentation: DashboardColumnPresentation = Object.fromEntries(
      Object.entries(remapKeys(latestTile.columnPresentation, aligned.renamed)).filter(([key]) => keys.has(key)),
    );
    const remappedOverrides = remapOverrides(latestTile.queryOverrides ?? overrides, aligned.renamed);
    const nextOverrides: DashboardQueryOverrides = {
      ...(pruneToColumns(remappedOverrides.order, keys) ? { order: pruneToColumns(remappedOverrides.order, keys) } : {}),
      ...(pruneToColumns(remappedOverrides.filters, keys) ? { filters: pruneToColumns(remappedOverrides.filters, keys) } : {}),
      ...(remappedOverrides.limit !== undefined ? { limit: remappedOverrides.limit } : {}),
    };
    const display = remapDisplay(input.display ?? latestTile.display, aligned.renamed);

    // The recipe seals the edited base query: the trace-style YAML and the
    // digests a refresh re-verifies, on the recipe's own view.
    const recipeQuery: CubeQuery = edited.query;
    const recipe = {
      kind: "cube_v3" as const,
      queryYaml: cubeQueryToYaml(recipeQuery),
      queryDigest: cubeQueryDigest(recipeQuery),
      semanticVersionDigest: cubeSemanticVersionDigest(validated, catalogue),
      view: validated.view,
      ...(claim.recipe.connector ? { connector: claim.recipe.connector } : { connector: null }),
    };

    const next = await requeryDashboardTile({
      tileId: input.tileId,
      expectedRevision: latest.revision,
      recipeVersion: input.recipeVersion,
      recipe,
      snapshot,
      resultDigest: digest,
      rowCount: result.rows.length,
      sourceWatermarks,
      startedAt: startedAt.toISOString(),
      latencyMs: Math.min(600_000, Date.now() - startedAt.getTime()),
      dedupeStatus: result.cached ? "cache_hit" : "executed",
      display,
      queryOverrides: nextOverrides,
      columnPresentation: presentation,
      adapterMetadata: { executionMs: result.executionMs, view: validated.view, edits: input.edits.map((edit) => edit.op) },
      dashboardId: dashboard.dashboardId,
    });
    const nextTile = next.tiles.find((candidate) => candidate.tileId === input.tileId);
    if (!nextTile) throw new ControlPlaneError("The element could not be reloaded after the edit.", 503);
    return { dashboard: next, tile: nextTile, executionMs: result.executionMs };
  } catch (error) {
    // The requery RPC clears the lease itself on success; every other exit
    // hands it back so the element is not stuck "refreshing".
    await releaseDashboardRefresh({ tileId: claim.tileId, leaseId: claim.leaseId, dashboardId: dashboard.dashboardId }).catch(() => undefined);
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new DashboardRequeryError("The governed query took too long; try a narrower window.", "query_timeout", 504);
    }
    throw error;
  }
}
