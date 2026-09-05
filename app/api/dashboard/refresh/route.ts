import { z } from "zod";
import { loadAgentConfig } from "@/packages/albert-v3/src/agent-config/loader";
import {
  claimDashboardRefresh,
  completeDashboardRefresh,
  loadDashboard,
} from "@/services/control-plane/src/dashboard-repository";
import {
  consumeAlbertRateLimit,
  ControlPlaneError,
  currentTenantContext,
  loadConnectionsWorkspace,
} from "@/services/control-plane/src/web-repository";
import { assertSameOriginMutation, readBoundedJsonBody, rateLimitExceededResponse } from "@/services/control-plane/src/request-security";
import { refreshDashboardClaim } from "@/services/dashboard/src/refresh";
import { currentCurrency, currentWatermarks } from "@/services/dashboard/src/workspace-context";

export const maxDuration = 180;

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const requestSchema = z.object({
  tileIds: z.array(ulid).min(1).max(24).optional(),
  force: z.boolean().default(false),
  /** Unnamed: the member's most recently touched dashboard. */
  dashboardId: ulid.optional(),
}).strict();

async function inBatches<T>(items: readonly T[], width: number, task: (item: T) => Promise<void>) {
  for (let index = 0; index < items.length; index += width) {
    await Promise.all(items.slice(index, index + width).map(task));
  }
}

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const tenant = await currentTenantContext();
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409 });
    const limit = await consumeAlbertRateLimit("dashboard.refresh");
    if (!limit.allowed) return rateLimitExceededResponse(limit);
    const parsed = requestSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return Response.json({ error: "A valid refresh request is required." }, { status: 400 });
    const claims = await claimDashboardRefresh(parsed.data);
    if (claims.length === 0) {
      // Nothing eligible (the five-minute window has not passed): answer
      // with the document without paying for the connections lookup.
      return Response.json({ dashboard: await loadDashboard(parsed.data.dashboardId), refreshedTileIds: [] }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const connections = await loadConnectionsWorkspace().catch(() => null);
    await inBatches(claims, 8, async (claim) => {
      const startedAt = new Date().toISOString();
      const started = Date.now();
      const result = await refreshDashboardClaim(
        claim,
        tenant,
        currentWatermarks(connections, claim.recipe.kind === "cube_v3" ? claim.recipe.connector : null),
        currentCurrency(connections) ?? loadAgentConfig().currency,
      );
      await completeDashboardRefresh({
        tileId: claim.tileId,
        claimedAt: claim.claimedAt,
        leaseId: claim.leaseId,
        outcome: result.outcome,
        startedAt,
        latencyMs: Date.now() - started,
        snapshot: result.snapshot,
        resultDigest: result.resultDigest,
        rowCount: result.rowCount,
        sourceWatermarks: result.sourceWatermarks,
        adapter: claim.replayKind,
        dedupeStatus: result.dedupeStatus,
        errorCode: result.errorCode,
        adapterMetadata: result.metadata,
      });
    });
    return Response.json({
      dashboard: await loadDashboard(parsed.data.dashboardId),
      refreshedTileIds: claims.map(({ tileId }) => tileId),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "The dashboard could not be refreshed.";
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
