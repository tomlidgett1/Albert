import { consumeAlbertRateLimit, currentTenantContext, requireUser, ControlPlaneError } from "@/services/control-plane/src/web-repository";
import { beginOAuthFlow, isOAuthWebProvider, OAuthFlowError } from "@/services/oauth/src/web-flow";
import { assertSameOriginNavigation, rateLimitExceededResponse } from "@/services/control-plane/src/request-security";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (!isOAuthWebProvider(provider)) return Response.json({ error: "Unknown connector." }, { status: 404 });
  try {
    assertSameOriginNavigation(request);
    const [{ user }, tenant] = await Promise.all([requireUser(), currentTenantContext()]);
    if (!tenant) return Response.json({ error: "Create an organisation before connecting an app." }, { status: 409 });
    if (!['owner', 'manager'].includes(tenant.role)) return Response.json({ error: "Owner or manager access is required." }, { status: 403 });
    const rateLimit = await consumeAlbertRateLimit("oauth.start");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
    const authorizationUrl = await beginOAuthFlow({ provider, tenantId: tenant.tenant_id, userId: user.id });
    return Response.redirect(authorizationUrl, 302);
  } catch (error) {
    const status = error instanceof OAuthFlowError || error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof Error ? error.message : "OAuth could not be started.";
    return Response.json({ error: message }, { status });
  }
}
