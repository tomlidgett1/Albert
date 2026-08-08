import { consumeAlbertRateLimit, currentTenantContext, requireUser, ControlPlaneError } from "@/services/control-plane/src/web-repository";
import { beginOAuthFlow, isOAuthWebProvider, OAuthFlowError } from "@/services/oauth/src/web-flow";
import {
  assertSameOriginNavigation,
  localHttpsOAuthBootstrapTarget,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (!isOAuthWebProvider(provider)) return Response.json({ error: "Unknown connector." }, { status: 404 });
  try {
    const bootstrapTarget = localHttpsOAuthBootstrapTarget(request);
    if (bootstrapTarget) return Response.redirect(bootstrapTarget, 302);
    assertSameOriginNavigation(request);
    const [{ user }, tenant] = await Promise.all([requireUser(), currentTenantContext()]);
    if (!tenant) return Response.json({ error: "Create an organisation before connecting an app." }, { status: 409 });
    if (!['owner', 'manager'].includes(tenant.role)) return Response.json({ error: "Owner or manager access is required." }, { status: 403 });
    const rateLimit = await consumeAlbertRateLimit("oauth.start");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
    // Shopify hosts its authorize endpoint on the merchant's own shop, so the
    // domain is collected before the redirect. beginOAuthFlow validates it and
    // the worker re-validates before it is ever used as a URL host.
    const shopDomain = new URL(request.url).searchParams.get("shop") ?? undefined;
    const authorizationUrl = await beginOAuthFlow({
      provider,
      tenantId: tenant.tenant_id,
      userId: user.id,
      requestOrigin: new URL(request.url).origin,
      shopDomain,
    });
    return Response.redirect(authorizationUrl, 302);
  } catch (error) {
    const status = error instanceof OAuthFlowError || error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof Error ? error.message : "OAuth could not be started.";
    return Response.json({ error: message }, { status });
  }
}
