import { consumeAlbertRateLimit, currentTenantContext, requireUser, ControlPlaneError } from "@/services/control-plane/src/web-repository";
import { finishOAuthFlow, isOAuthWebProvider, OAuthFlowError } from "@/services/oauth/src/web-flow";

function callbackOrigin(request: Request): string | null {
  const configured = process.env.ALBERT_PUBLIC_ORIGIN?.trim();
  if (!configured && process.env.NODE_ENV === "production") return null;
  try {
    const candidate = new URL(configured || request.url);
    const localHttp = process.env.NODE_ENV !== "production" && candidate.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(candidate.hostname);
    if (candidate.protocol !== "https:" && !localHttp) return null;
    if (candidate.username || candidate.password) return null;
    if (configured && (candidate.pathname !== "/" || candidate.search || candidate.hash)) return null;
    return candidate.origin;
  } catch {
    return null;
  }
}

function resultRedirect(request: Request, provider: string, status: string) {
  const origin = callbackOrigin(request);
  if (!origin) {
    return Response.json({ error: "OAuth callback routing is not configured." }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
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
  if (!isOAuthWebProvider(provider)) return resultRedirect(request, provider, "unknown_provider");
  const callback = new URL(request.url);
  if (callback.searchParams.get("error")) return resultRedirect(request, provider, "cancelled");
  const state = callback.searchParams.get("state");
  const code = callback.searchParams.get("code");
  if (!state || !code) return resultRedirect(request, provider, "invalid_callback");

  try {
    const [{ user }, tenant] = await Promise.all([requireUser(), currentTenantContext()]);
    if (!tenant) return resultRedirect(request, provider, "tenant_missing");
    const rateLimit = await consumeAlbertRateLimit("oauth.callback");
    if (!rateLimit.allowed) return resultRedirect(request, provider, "rate_limited");
    const result = await finishOAuthFlow({
      provider,
      state,
      code,
      tenantId: tenant.tenant_id,
      userId: user.id,
    });
    return resultRedirect(request, provider, result.status);
  } catch (error) {
    console.error("Albert OAuth callback failed", {
      provider,
      errorName: error instanceof Error ? error.name : "UnknownError",
      status: error instanceof OAuthFlowError || error instanceof ControlPlaneError ? error.status : 503,
    });
    return resultRedirect(request, provider, "failed");
  }
}
