import { createHash } from "node:crypto";
import { load as loadYaml } from "js-yaml";

import {
  CubeClient,
  cubeQueryReplayDigestMatches,
  cubeSemanticVersionDigest,
  validateCubeQuery,
} from "@/packages/albert-v3/src/cube/client";
import { traceColumnFromCube } from "@/packages/albert-v3/src/cube/presentation";
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

function cell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value.slice(0, 400);
  return JSON.stringify(value).slice(0, 400);
}

function resultDigest(rows: readonly Readonly<Record<string, unknown>>[]): string {
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
  const catalogue = await client.fetchCatalogue(AbortSignal.timeout(20_000));
  const validated = validateCubeQuery(query, catalogue);
  if ("error" in validated) return failure("cube_query_invalid", true);
  if (cubeSemanticVersionDigest(validated, catalogue) !== claim.recipe.semanticVersionDigest) {
    return failure("semantic_version_mismatch", true);
  }
  const { result } = await client.loadQuery(validated.query, { signal: AbortSignal.timeout(100_000) });
  if (!result.ok) {
    const code = /within 90 seconds|cancelled/iu.test(result.error)
      ? "query_timeout"
      : "cube_query_failed";
    return failure(code, false, { executionMs: result.executionMs });
  }

  const columnKeys = result.rows.length > 0
    ? Object.keys(result.rows[0]!)
    : validated.members.filter((member, index, all) => all.indexOf(member) === index);
  const rows = result.rows.slice(0, 50).map((row) => Object.fromEntries(
    columnKeys.map((key) => [key, cell(row[key])]),
  ));
  const digest = resultDigest(result.rows);
  const refreshedAt = new Date().toISOString();
  const sourceWatermarks = currentSourceWatermarks.length > 0
    ? currentSourceWatermarks
    : claim.previousSnapshot?.sourceWatermarks ?? [];
  const snapshot: DashboardSnapshot = {
    columns: columnKeys.map((key) => traceColumnFromCube(key, result.annotation[key], currency)),
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
          Object.entries(row).map(([key, value]) => [key, cell(value)]),
        )),
      })),
      loadAgentConfig().timezone,
    );
  } catch {
    return failure("derived_transform_failed", true);
  }
  const digest = resultDigest(materialized.rows);
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
