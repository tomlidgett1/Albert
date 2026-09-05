import { z } from "zod";
import {
  dashboardColumnPresentationSchema,
  dashboardQueryOverridesSchema,
  dashboardTileDisplaySchema,
  DashboardRevisionConflict,
  deleteDashboardTile,
  updateDashboardTile,
} from "@/services/control-plane/src/dashboard-repository";
import { consumeAlbertRateLimit, ControlPlaneError } from "@/services/control-plane/src/web-repository";
import { assertSameOriginMutation, readBoundedJsonBody, rateLimitExceededResponse } from "@/services/control-plane/src/request-security";

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const updateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  columnPresentation: dashboardColumnPresentationSchema.optional(),
  display: dashboardTileDisplaySchema.optional(),
  /** The element's own sort, filters and row limit (ADR 0134). */
  queryOverrides: dashboardQueryOverridesSchema.optional(),
  /** Authored column order (ADR 0134): named columns first in this order, the rest after. */
  columnOrder: z.array(z.string().trim().min(1).max(160)).min(1).max(80).optional(),
  expectedRevision: z.number().int().nonnegative(),
  dashboardId: ulid.optional(),
}).strict().refine((value) => (
  value.title !== undefined
  || value.columnPresentation !== undefined
  || value.display !== undefined
  || value.queryOverrides !== undefined
  || value.columnOrder !== undefined
));
const deleteSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  dashboardId: ulid.optional(),
}).strict();

function responseError(error: unknown) {
  if (error instanceof DashboardRevisionConflict) return Response.json({ error: error.message, dashboard: error.dashboard }, { status: 409 });
  const status = error instanceof ControlPlaneError ? error.status : 503;
  return Response.json({ error: error instanceof Error ? error.message : "The dashboard tile could not be changed." }, { status });
}

export async function PATCH(request: Request, context: { params: Promise<{ tileId: string }> }) {
  try {
    assertSameOriginMutation(request);
    const tileId = ulid.parse((await context.params).tileId);
    const limit = await consumeAlbertRateLimit("dashboard.mutation");
    if (!limit.allowed) return rateLimitExceededResponse(limit);
    const body = updateSchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) return Response.json({ error: "A valid tile display change and dashboard revision are required." }, { status: 400 });
    return Response.json({
      dashboard: await updateDashboardTile({ tileId, ...body.data }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ tileId: string }> }) {
  try {
    assertSameOriginMutation(request);
    const tileId = ulid.parse((await context.params).tileId);
    const limit = await consumeAlbertRateLimit("dashboard.mutation");
    if (!limit.allowed) return rateLimitExceededResponse(limit);
    const body = deleteSchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) return Response.json({ error: "The current dashboard revision is required." }, { status: 400 });
    return Response.json({
      dashboard: await deleteDashboardTile(tileId, body.data.expectedRevision, body.data.dashboardId),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return responseError(error);
  }
}
