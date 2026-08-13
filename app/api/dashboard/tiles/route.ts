import { z } from "zod";
import {
  DashboardRevisionConflict,
  pinDashboardTile,
} from "@/services/control-plane/src/dashboard-repository";
import {
  consumeAlbertRateLimit,
  ControlPlaneError,
  currentTenantContext,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const requestSchema = z.object({
  conversationId: ulid,
  turnId: ulid,
  tableEventId: ulid,
  resultId: z.string().min(1).max(160),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const tenant = await currentTenantContext();
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409 });
    const rateLimit = await consumeAlbertRateLimit("dashboard.mutation");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
    const parsed = requestSchema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return Response.json({ error: "A valid governed table reference is required." }, { status: 400 });
    return Response.json({ dashboard: await pinDashboardTile(parsed.data) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DashboardRevisionConflict) {
      return Response.json({ error: error.message, dashboard: error.dashboard }, { status: 409 });
    }
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError ? error.message : "The table could not be added.";
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}

