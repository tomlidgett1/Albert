import { z } from "zod";
import {
  DashboardRevisionConflict,
  renameDashboard,
} from "@/services/control-plane/src/dashboard-repository";
import { consumeAlbertRateLimit, ControlPlaneError } from "@/services/control-plane/src/web-repository";
import { assertSameOriginMutation, readBoundedJsonBody, rateLimitExceededResponse } from "@/services/control-plane/src/request-security";

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const requestSchema = z.object({
  /** null clears the title back to the default. */
  title: z.string().trim().min(1).max(80).nullable(),
  expectedRevision: z.number().int().nonnegative(),
  dashboardId: ulid.optional(),
}).strict();

export async function PATCH(request: Request) {
  try {
    assertSameOriginMutation(request);
    const limit = await consumeAlbertRateLimit("dashboard.mutation");
    if (!limit.allowed) return rateLimitExceededResponse(limit);
    const parsed = requestSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return Response.json({ error: "A valid dashboard name is required." }, { status: 400 });
    return Response.json({
      dashboard: await renameDashboard(parsed.data.title, parsed.data.expectedRevision, parsed.data.dashboardId),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DashboardRevisionConflict) return Response.json({ error: error.message, dashboard: error.dashboard }, { status: 409 });
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return Response.json({ error: error instanceof Error ? error.message : "The dashboard could not be renamed." }, { status });
  }
}
