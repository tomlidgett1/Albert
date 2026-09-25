import { consumeAlbertRateLimit, currentTenantContext, requireUser, ControlPlaneError } from "@/services/control-plane/src/web-repository";
import { finishFivetranOAuthFlow, finishOAuthFlow, isFivetranWebProvider, isOAuthWebProvider, OAuthFlowError } from "@/services/oauth/src/web-flow";
import { verifyShopifyCallbackHmac } from "@/connectors/shopify/index";

function callbackOrigin(request: Request): string | null {
  const configured = process.env.ALBERT_PUBLIC_ORIGIN?.trim();
  if (!configured && process.env.NODE_ENV === "production") return null;
  try {
    const requestUrl = new URL(request.url);
    const candidate = new URL(configured || request.url);
    const localHttp = process.env.NODE_ENV !== "production" && candidate.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(candidate.hostname);
    if (candidate.protocol !== "https:" && !localHttp) return null;
    if (candidate.username || candidate.password) return null;
    if (configured && (candidate.pathname !== "/" || candidate.search || candidate.hash)) return null;
    const requestLocal = process.env.NODE_ENV !== "production" && requestUrl.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(requestUrl.hostname);
    // Prefer the callback host the browser actually hit during local port drift.
    if (configured && localHttp && requestLocal) return requestUrl.origin;
    return candidate.origin;
  } catch {
    return null;
  }
}

function resultRedirect(
  request: Request,
  provider: string,
  status: string,
  detail?: string,
) {
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
  // Vendor error strings are the owner's own connection diagnostics; the UI
  // renders them as plain text. Hiding them in production made OAuth failures
  // undiagnosable.
  if (detail) {
    url.searchParams.set("oauth_detail", detail.slice(0, 280));
  }
  return Response.redirect(url, 302);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (!isOAuthWebProvider(provider)) return resultRedirect(request, provider, "unknown_provider");
  const callback = new URL(request.url);
  const vendorError = callback.searchParams.get("error");
  if (vendorError) {
    // The vendor refused before our flow ran. Surface its actual reason —
    // "cancelled" alone made provider-side misconfiguration undiagnosable.
    const description = callback.searchParams.get("error_description")
      ?? callback.searchParams.get("error_hint") ?? "";
    console.error("oauth.vendor_error", { provider, vendorError, description });
    return resultRedirect(
      request,
      provider,
      "cancelled",
      [vendorError, description].filter(Boolean).join(": ").slice(0, 200),
    );
  }
  if (isFivetranWebProvider(provider)) {
    try {
      const [{ user }, tenant] = await Promise.all([requireUser(), currentTenantContext()]);
      if (!tenant) return resultRedirect(request, provider, "tenant_missing");
      const rateLimit = await consumeAlbertRateLimit("oauth.callback");
      if (!rateLimit.allowed) return resultRedirect(request, provider, "rate_limited");
      const result = await finishFivetranOAuthFlow({
        provider,
        tenantId: tenant.tenant_id,
        userId: user.id,
      });
      return resultRedirect(request, provider, result.status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      const detail = error instanceof OAuthFlowError && error.detail
        ? error.detail
        : message;
      console.error("Albert Fivetran OAuth callback failed", {
        provider,
        errorName: error instanceof Error ? error.name : "UnknownError",
        message,
        status: error instanceof OAuthFlowError || error instanceof ControlPlaneError ? error.status : 503,
      });
      // Fivetran sends the browser back here whenever the Connect Card closes,
      // including when the owner bailed before "Save & Test". That is not a
      // failure of anything Albert did — tell them what is left to do.
      const status = error instanceof OAuthFlowError && error.message === "fivetran_setup_incomplete"
        ? "setup_incomplete"
        : "failed";
      return resultRedirect(request, provider, status, detail);
    }
  }
  const state = callback.searchParams.get("state");
  const code = callback.searchParams.get("code");
  if (!state || !code) return resultRedirect(request, provider, "invalid_callback");
  const domainPrefix = callback.searchParams.get("domain_prefix") ?? undefined;
  const returnedScope = callback.searchParams.get("scope") ?? undefined;
  if (provider === "lightspeed-x" && (!domainPrefix || !returnedScope)) {
    return resultRedirect(request, provider, "invalid_callback");
  }
  // Shopify is the only vendor that signs its redirect, and it is the only one
  // whose authorize host is merchant-supplied. The HMAC is what proves this
  // callback came from Shopify rather than from whoever chose that host.
  if (provider === "shopify") {
    const secret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
    if (!secret || !verifyShopifyCallbackHmac(callback.searchParams, secret)) {
      return resultRedirect(request, provider, "invalid_signature");
    }
  }

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
      domainPrefix,
      returnedScope,
    });
    // A grant taken on Fivetran's behalf (Deputy) reports as the Fivetran
    // provider: Fivetran's sync has started, even though no Albert job exists.
    if (result.provider && result.provider !== provider) {
      return resultRedirect(request, result.provider, result.status);
    }
    // A connected result with no enqueued job means the connector's initial
    // backfill is suppressed; report that rather than promising a sync.
    const status = result.status === "connected" && !result.jobRequestId
      ? "connected_without_sync"
      : result.status;
    return resultRedirect(request, provider, status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    const detail = error instanceof OAuthFlowError && error.detail
      ? error.detail
      : message;
    console.error("Albert OAuth callback failed", {
      provider,
      errorName: error instanceof Error ? error.name : "UnknownError",
      message,
      detail: error instanceof OAuthFlowError ? error.detail : undefined,
      status: error instanceof OAuthFlowError || error instanceof ControlPlaneError ? error.status : 503,
    });
    return resultRedirect(request, provider, "failed", detail);
  }
}
