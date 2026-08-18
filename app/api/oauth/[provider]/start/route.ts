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
    console.error("Albert OAuth start failed", {
      provider,
      errorName: error instanceof Error ? error.name : "UnknownError",
      message,
      status,
    });
    // This route is reached by a full-page navigation from the Connect
    // button, so a JSON body would be the whole screen. Send the owner back
    // to the Connections view with the failure as a notice instead.
    const detail = error instanceof OAuthFlowError && error.detail ? error.detail : message;
    return startFailureRedirect(request, provider, detail);
  }
}

function startFailureRedirect(request: Request, provider: string, detail: string) {
  const requestUrl = new URL(request.url);
  const requestLocal = process.env.NODE_ENV !== "production" && requestUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(requestUrl.hostname);
  const configured = process.env.ALBERT_PUBLIC_ORIGIN?.trim();
  let origin = requestUrl.origin;
  if (configured && !requestLocal) {
    try {
      origin = new URL(configured).origin;
    } catch {
      // fall back to the origin the browser actually hit
    }
  }
  const url = new URL("/dash", origin);
  url.searchParams.set("view", "Connections");
  url.searchParams.set("provider", provider);
  url.searchParams.set("oauth", "start_failed");
  url.searchParams.set("oauth_detail", detail.slice(0, 280));
  return Response.redirect(url, 302);
}
