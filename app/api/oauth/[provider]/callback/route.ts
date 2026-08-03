import { consumeAlbertRateLimit, currentTenantContext, requireUser, ControlPlaneError } from "@/services/control-plane/src/web-repository";
import { finishOAuthFlow, isOAuthWebProvider, OAuthFlowError } from "@/services/oauth/src/web-flow";

function resultRedirect(provider: string, status: string) {
  const origin = process.env.ALBERT_PUBLIC_ORIGIN || "http://localhost:3000";
  const url = new URL("/dash", origin);
  url.searchParams.set("view", "Connections");
  url.searchParams.set("provider", provider);
  url.searchParams.set("oauth", status);
  return Response.redirect(url, 302);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (!isOAuthWebProvider(provider)) return resultRedirect(provider, "unknown_provider");
  const callback = new URL(request.url);
  if (callback.searchParams.get("error")) return resultRedirect(provider, "cancelled");
  const state = callback.searchParams.get("state");
  const code = callback.searchParams.get("code");
  if (!state || !code) return resultRedirect(provider, "invalid_callback");

  try {
    const [{ user }, tenant] = await Promise.all([requireUser(), currentTenantContext()]);
    if (!tenant) return resultRedirect(provider, "tenant_missing");
    const rateLimit = await consumeAlbertRateLimit("oauth.callback");
    if (!rateLimit.allowed) return resultRedirect(provider, "rate_limited");
    const result = await finishOAuthFlow({
      provider,
      state,
      code,
      tenantId: tenant.tenant_id,
      userId: user.id,
    });
    return resultRedirect(provider, result.status);
  } catch (error) {
    console.error("Albert OAuth callback failed", {
      provider,
      errorName: error instanceof Error ? error.name : "UnknownError",
      status: error instanceof OAuthFlowError || error instanceof ControlPlaneError ? error.status : 503,
    });
    return resultRedirect(provider, "failed");
  }
}
