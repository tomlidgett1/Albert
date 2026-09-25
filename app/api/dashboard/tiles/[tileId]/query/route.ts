/**
 * The requery lane (ADR 0134, migration 0187): one deterministic edit to an
 * element's governed query — Truncate date, the date range or comparison,
 * a column or calculation added or removed, the row limit — run on the
 * server and stored as a re-minted digest-locked recipe with its snapshot.
 * The browser never sends a query, only the edit.
 */
import { z } from "zod";
import { loadAgentConfig } from "@/packages/albert-v3/src/agent-config/loader";
import {
  DashboardRecipeConflict,
  DashboardRevisionConflict,
  dashboardTileDisplaySchema,
} from "@/services/control-plane/src/dashboard-repository";
import {
  consumeAlbertRateLimit,
  ControlPlaneError,
  currentTenantContext,
  loadConnectionsWorkspace,
} from "@/services/control-plane/src/web-repository";
import { assertSameOriginMutation, readBoundedJsonBody, rateLimitExceededResponse } from "@/services/control-plane/src/request-security";
import { dashboardQueryEditsSchema } from "@/services/dashboard/src/query-edits";
import { DashboardRequeryError, requeryDashboardElement } from "@/services/dashboard/src/requery";
import { currentCurrency, currentWatermarks } from "@/services/dashboard/src/workspace-context";

export const maxDuration = 120;

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const requestSchema = z.object({
  edits: dashboardQueryEditsSchema,
  expectedRevision: z.number().int().nonnegative(),
  recipeVersion: z.number().int().positive(),
  display: dashboardTileDisplaySchema.optional(),
  dashboardId: ulid.optional(),
}).strict();

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request, context: { params: Promise<{ tileId: string }> }) {
  try {
    assertSameOriginMutation(request);
    const tileId = ulid.parse((await context.params).tileId);
    const tenant = await currentTenantContext();
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409, headers: NO_STORE });
    if (tenant.role !== "owner" && tenant.role !== "manager") {
      return Response.json({ error: "Only owners and managers can edit dashboard elements." }, { status: 403, headers: NO_STORE });
    }
    const limit = await consumeAlbertRateLimit("dashboard.requery");
    if (!limit.allowed) return rateLimitExceededResponse(limit);
    const body = requestSchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) return Response.json({ error: "A valid element edit and dashboard revision are required." }, { status: 400, headers: NO_STORE });
    const connections = await loadConnectionsWorkspace().catch(() => null);
    const result = await requeryDashboardElement({ tileId, ...body.data }, tenant, {
      currency: currentCurrency(connections) ?? loadAgentConfig().currency,
      sourceWatermarks: currentWatermarks(connections, null),
    });
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof DashboardRecipeConflict || error instanceof DashboardRevisionConflict) {
      return Response.json({ error: error.message, dashboard: error.dashboard }, { status: 409, headers: NO_STORE });
    }
    if (error instanceof DashboardRequeryError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: NO_STORE });
    }
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return Response.json({
      error: error instanceof ControlPlaneError ? error.message : "The element could not be edited.",
    }, { status, headers: NO_STORE });
  }
}
