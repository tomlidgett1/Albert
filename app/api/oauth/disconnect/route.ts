import { z } from "zod";
import { consumeAlbertRateLimit, ControlPlaneError, currentTenantContext, requireUser } from "@/services/control-plane/src/web-repository";
import { disconnectOAuthConnection } from "@/services/oauth/src/web-flow";
import { assertSameOriginMutation, rateLimitExceededResponse } from "@/services/control-plane/src/request-security";

const schema = z.object({ connectionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "A valid connection is required." }, { status: 400 });
    const [{ user }, tenant] = await Promise.all([requireUser(), currentTenantContext()]);
    if (!tenant) return Response.json({ error: "Organisation context is required." }, { status: 409 });
    if (!['owner', 'manager'].includes(tenant.role)) return Response.json({ error: "Owner or manager access is required." }, { status: 403 });
    const rateLimit = await consumeAlbertRateLimit("oauth.disconnect");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
    const result = await disconnectOAuthConnection({ ...parsed.data, tenantId: tenant.tenant_id, userId: user.id });
    return Response.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "The connection could not be disconnected safely." }, { status: 503 });
  }
}
