/**
 * The dashboard document (ADR 0134 — dashboards, plural):
 *   GET    ?dashboardId=…   one dashboard (unnamed: the most recently touched)
 *   POST   { title? }       create an empty dashboard to build in natural language
 *   DELETE { dashboardId }  remove a dashboard and everything on it
 * The list lives at /api/dashboard/list.
 */
import { z } from "zod";
import {
  ControlPlaneError,
  consumeAlbertRateLimit,
  currentTenantContext,
} from "@/services/control-plane/src/web-repository";
import {
  createDashboard,
  deleteDashboard,
  loadDashboard,
} from "@/services/control-plane/src/dashboard-repository";
import {
  assertSameOriginMutation,
  rateLimitExceededResponse,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const createSchema = z.object({
  title: z.string().trim().min(1).max(80).nullable().optional(),
}).strict();
const deleteSchema = z.object({ dashboardId: ulid }).strict();

function errorResponse(error: unknown, fallback: string): Response {
  const status = error instanceof ControlPlaneError ? error.status : 503;
  const message = error instanceof ControlPlaneError ? error.message : fallback;
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    const tenant = await currentTenantContext();
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409 });
    const requested = new URL(request.url).searchParams.get("dashboardId");
    const dashboardId = requested ? ulid.safeParse(requested) : null;
    if (dashboardId && !dashboardId.success) {
      return Response.json({ error: "A valid dashboard id is required." }, { status: 400 });
    }
    return Response.json({ dashboard: await loadDashboard(dashboardId?.data) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, "The dashboard is unavailable.");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const tenant = await currentTenantContext();
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409 });
    const limit = await consumeAlbertRateLimit("dashboard.mutation");
    if (!limit.allowed) return rateLimitExceededResponse(limit);
    const parsed = createSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return Response.json({ error: "A valid dashboard name is required." }, { status: 400 });
    return Response.json({ dashboard: await createDashboard(parsed.data.title ?? null) }, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, "The dashboard could not be created.");
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOriginMutation(request);
    const tenant = await currentTenantContext();
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409 });
    const limit = await consumeAlbertRateLimit("dashboard.mutation");
    if (!limit.allowed) return rateLimitExceededResponse(limit);
    const parsed = deleteSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return Response.json({ error: "A valid dashboard id is required." }, { status: 400 });
    return Response.json({ dashboards: await deleteDashboard(parsed.data.dashboardId) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, "The dashboard could not be deleted.");
  }
}
