import { createHash } from "node:crypto";
import { load as loadYaml } from "js-yaml";

import {
  CubeClient,
  cubeQueryReplayDigestMatches,
  cubeSemanticVersionDigest,
  validateCubeQuery,
} from "@/packages/albert-v3/src/cube/client";
import { alignColumnsToPrevious, cubeResultColumns } from "@/packages/albert-v3/src/cube/presentation";
import type { CubeQuery } from "@/packages/albert-v3/src/cube/types";
import { loadAgentConfig } from "@/packages/albert-v3/src/agent-config/loader";
import {
  derivedTableDigest,
  materializeDerivedTable,
} from "@/packages/albert-v3/src/engine/derived-table";
import type {
  DashboardRefreshClaim,
  DashboardSnapshot,
} from "@/services/control-plane/src/dashboard-repository";
import type { TenantContext } from "@/services/control-plane/src/web-repository";
import { cachedCatalogue } from "./catalogue-cache";
import { applyDashboardQueryOverrides } from "./query-overrides";

export type DashboardRefreshResult = Readonly<{
  outcome: "success" | "empty" | "failure" | "incompatible";
  snapshot: DashboardSnapshot | null;
  resultDigest: string | null;
  rowCount: number | null;
  sourceWatermarks: readonly unknown[];
  dedupeStatus: "executed" | "cache_hit";
  errorCode: string | null;
  metadata: Readonly<Record<string, unknown>>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function snapshotCell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value.slice(0, 400);
  return JSON.stringify(value).slice(0, 400);
}

export function snapshotResultDigest(rows: readonly Readonly<Record<string, unknown>>[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function failure(
  code: string,
  incompatible = false,
  metadata: Readonly<Record<string, unknown>> = {},
): DashboardRefreshResult {
  return {
    outcome: incompatible ? "incompatible" : "failure",
    snapshot: null,
    resultDigest: null,
    rowCount: null,
    sourceWatermarks: [],
    dedupeStatus: "executed",
    errorCode: code,
    metadata,
  };
}

async function refreshCube(
  claim: DashboardRefreshClaim,
  tenant: TenantContext,
  currentSourceWatermarks: readonly unknown[],
  currency?: string,
): Promise<DashboardRefreshResult> {
  if (claim.recipe.kind !== "cube_v3") return failure("invalid_replay_recipe");
  const apiUrl = process.env.CUBE_API_URL?.trim();
  const apiSecret = process.env.CUBEJS_API_SECRET?.trim();
  if (!apiUrl || !apiSecret) return failure("cube_runtime_unavailable");
  let query: CubeQuery;
  try {
    const parsed = loadYaml(claim.recipe.queryYaml);
    if (!isRecord(parsed)) return failure("invalid_replay_recipe");
    query = parsed as CubeQuery;
  } catch {
    return failure("invalid_replay_recipe");
  }
  if (!cubeQueryReplayDigestMatches(query, claim.recipe.queryDigest)) {
    return failure("query_digest_mismatch", true);
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
  const validated = validateCubeQuery(query, catalogue);
  if ("error" in validated) return failure("cube_query_invalid", true);
  if (cubeSemanticVersionDigest(validated, catalogue) !== claim.recipe.semanticVersionDigest) {
    return failure("semantic_version_mismatch", true);
  }
  // The owner's sort/filters/limit (ADR 0134) apply only after the governed
  // recipe has proven itself, and the effective query is validated against
  // the same catalogue so an override can only narrow or reorder the result.
  const overridden = applyDashboardQueryOverrides(validated.query, claim.queryOverrides);
  if (!overridden.ok) return failure("query_overrides_invalid", false, { detail: overridden.error });
  const effective = overridden.query === validated.query
    ? validated
    : validateCubeQuery(overridden.query, catalogue);
  if ("error" in effective) return failure("query_overrides_invalid", false, { detail: effective.error });
  const { result } = await client.loadQuery(effective.query, { signal: AbortSignal.timeout(100_000) });
  if (!result.ok) {
    const code = /within 90 seconds|cancelled/iu.test(result.error)
      ? "query_timeout"
      : "cube_query_failed";
    return failure(code, false, { executionMs: result.executionMs });
  }

  // One canonical column identity (ADR 0134): the same query-ordered,
  // underscore-keyed columns the runtime traced, aligned to the columns the
  // owner already sees so a refresh can never re-order or re-spell them.
  const aligned = alignColumnsToPrevious(
    cubeResultColumns(effective.query, result, currency),
    claim.previousSnapshot?.columns ?? null,
  );
  const rows = result.rows.slice(0, 50).map((row) => Object.fromEntries(
    aligned.members.map((member, index) => [aligned.columns[index]!.key, snapshotCell(row[member])]),
  ));
  const digest = snapshotResultDigest(result.rows);
  const refreshedAt = new Date().toISOString();
  const sourceWatermarks = currentSourceWatermarks.length > 0
    ? currentSourceWatermarks
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
  return {
    outcome: result.rows.length === 0 ? "empty" : "success",
    snapshot,
    resultDigest: digest,
    rowCount: result.rows.length,
    sourceWatermarks,
    dedupeStatus: result.cached ? "cache_hit" : "executed",
    errorCode: null,
    metadata: { executionMs: result.executionMs, view: validated.view },
  };
}

async function refreshDerivedV1(
  claim: DashboardRefreshClaim,
  tenant: TenantContext,
  currentSourceWatermarks: readonly unknown[],
  currency?: string,
): Promise<DashboardRefreshResult> {
  if (claim.recipe.kind !== "derived_v1") return failure("invalid_replay_recipe");
  const recipe = claim.recipe;
  if (derivedTableDigest(recipe.transform) !== recipe.transformDigest) {
    return failure("transform_digest_mismatch", true);
  }
  const declared = recipe.transform.sources;
  if (declared.length !== recipe.sources.length
      || declared.some((source, index) => (
        source.tableEventId !== recipe.sources[index]?.tableEventId
        || source.resultId !== recipe.sources[index]?.resultId
      ))) {
    return failure("derived_source_mismatch", true);
  }

  const snapshots: Array<NonNullable<DashboardRefreshResult["snapshot"]> & { resultId: string }> = [];
  const adapters: string[] = [];
  let allCacheHits = true;
  for (const source of recipe.sources) {
    const sourceClaim: DashboardRefreshClaim = {
      ...claim,
      replayKind: source.recipe.kind,
      recipe: source.recipe,
      source: { ...claim.source, resultId: source.resultId },
      previousSnapshot: null,
    };
    // A composed table's sources replay exactly as sealed: the pivot has no
    // single query for the owner's sort or filters to apply to.
    delete (sourceClaim as { queryOverrides?: unknown }).queryOverrides;
    if (source.recipe.kind !== "cube_v3") return failure("invalid_replay_recipe");
    const refreshed = await refreshCube(sourceClaim, tenant, currentSourceWatermarks, currency);
    adapters.push(source.recipe.kind);
    allCacheHits = allCacheHits && refreshed.dedupeStatus === "cache_hit";
    if (!refreshed.snapshot) {
      return failure(
        `derived_source_${refreshed.errorCode ?? "refresh_failed"}`.slice(0, 80),
        refreshed.outcome === "incompatible",
        { failedAdapter: source.recipe.kind },
      );
    }
    snapshots.push({ ...refreshed.snapshot, resultId: source.resultId });
  }

  let materialized;
  try {
    materialized = materializeDerivedTable(
      recipe.transform,
      snapshots.map((snapshot) => ({
        resultId: snapshot.resultId,
        columns: snapshot.columns,
        rows: snapshot.rows.map((row) => Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, snapshotCell(value)]),
        )),
      })),
      loadAgentConfig().timezone,
    );
  } catch (error) {
    // The reason is evidence, not a secret: it names a column or an operator.
    return failure("derived_transform_failed", true, {
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
  }
  const digest = snapshotResultDigest(materialized.rows);
  const refreshedAt = new Date().toISOString();
  const sourceWatermarks = [...new Map(
    snapshots.flatMap((snapshot) => snapshot.sourceWatermarks)
      .map((watermark) => [JSON.stringify(watermark), watermark]),
  ).values()].slice(0, 40);
  const snapshot: DashboardSnapshot = {
    columns: [...materialized.columns],
    rows: [...materialized.rows],
    totalRowCount: materialized.rows.length,
    resultDigest: digest,
    provenance: claim.previousSnapshot?.provenance ?? null,
    sourceWatermarks,
    queryTime: refreshedAt,
    refreshedAt,
    empty: materialized.rows.length === 0,
  };
  return {
    outcome: materialized.rows.length === 0 ? "empty" : "success",
    snapshot,
    resultDigest: digest,
    rowCount: materialized.rows.length,
    sourceWatermarks,
    dedupeStatus: allCacheHits ? "cache_hit" : "executed",
    errorCode: null,
    metadata: { sourceCount: snapshots.length, adapters },
  };
}

export async function refreshDashboardClaim(
  claim: DashboardRefreshClaim,
  tenant: TenantContext,
  currentSourceWatermarks: readonly unknown[] = [],
  currency?: string,
): Promise<DashboardRefreshResult> {
  try {
    if (claim.replayKind === "cube_v3") {
      return await refreshCube(claim, tenant, currentSourceWatermarks, currency);
    }
    return await refreshDerivedV1(claim, tenant, currentSourceWatermarks, currency);
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    return failure(timeout ? "query_timeout" : "replay_adapter_failed");
  }
}
