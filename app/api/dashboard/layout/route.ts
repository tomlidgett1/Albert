import { z } from "zod";
import {
  dashboardLayoutsSchema,
  DashboardRevisionConflict,
  updateDashboardLayouts,
} from "@/services/control-plane/src/dashboard-repository";
import { consumeAlbertRateLimit, ControlPlaneError } from "@/services/control-plane/src/web-repository";
import { assertSameOriginMutation, readBoundedJsonBody, rateLimitExceededResponse } from "@/services/control-plane/src/request-security";

const requestSchema = z.object({
  layouts: dashboardLayoutsSchema,
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export async function PATCH(request: Request) {
  try {
    assertSameOriginMutation(request);
    const limit = await consumeAlbertRateLimit("dashboard.mutation");
    if (!limit.allowed) return rateLimitExceededResponse(limit);
    const parsed = requestSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return Response.json({ error: "A valid dashboard layout is required." }, { status: 400 });
    return Response.json({ dashboard: await updateDashboardLayouts(parsed.data.layouts, parsed.data.expectedRevision) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DashboardRevisionConflict) return Response.json({ error: error.message, dashboard: error.dashboard }, { status: 409 });
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : "The layout could not be saved." }, { status });
  }
}

