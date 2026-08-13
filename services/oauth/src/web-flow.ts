import { cookies } from "next/headers";
import { buildDeputyAuthorizationUrl } from "../../../connectors/deputy/oauth-public.js";
import { LIGHTSPEED_R_DEFAULT_SCOPES } from "../../../connectors/lightspeed-r/manifest.js";
import { buildLightspeedRAuthorizationUrl } from "../../../connectors/lightspeed-r/oauth-public.js";
import { buildLightspeedXAuthorizationUrl } from "../../../connectors/lightspeed-x/oauth-public.js";
import { buildGoogleAdsAuthorizationUrl } from "../../../connectors/google-ads/oauth-public.js";
import { buildMetaAdsAuthorizationUrl } from "../../../connectors/meta-ads/oauth-public.js";
import { buildMomenceAuthorizationUrl } from "../../../connectors/momence/oauth-public.js";
import { normalizeShopifyShopDomain } from "../../../connectors/shopify/manifest.js";
import { buildShopifyAuthorizationUrl } from "../../../connectors/shopify/oauth-public.js";
import { buildSquareAuthorizationUrl } from "../../../connectors/square/oauth-public.js";
import { buildStripeAuthorizationUrl } from "../../../connectors/stripe/oauth-public.js";
import { buildXeroAuthorizationUrl } from "../../../connectors/xero/oauth-public.js";
import {
  createNonce,
  signInternalRequest,
  signPayload,
  verifySignedPayload,
  bytesToBase64Url,
} from "../../../packages/security/src/index.js";

export const oauthProviders = [
  "lightspeed", "lightspeed-x", "xero", "deputy", "square",
  "shopify", "stripe", "momence", "meta-ads", "google-ads",
] as const;
export type OAuthWebProvider = (typeof oauthProviders)[number];

type OAuthState = Readonly<{
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  oauthSessionId: string;
  tenantId: string;
  userId: string;
  provider: OAuthWebProvider;
  redirectUri: string;
}>;

type OAuthCookie = Readonly<{
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  provider: OAuthWebProvider;
}>;

const providerToConnector = {
  lightspeed: "lightspeed-r",
  "lightspeed-x": "lightspeed-x",
  xero: "xero",
  deputy: "deputy",
  square: "square",
  shopify: "shopify",
  stripe: "stripe",
  momence: "momence",
  "meta-ads": "meta-ads",
  "google-ads": "google-ads",
} as const;

export function isOAuthWebProvider(value: string): value is OAuthWebProvider {
  return (oauthProviders as readonly string[]).includes(value);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new OAuthFlowError(`OAuth is not configured (${name}).`, 503);
  return value;
}

function isLocalLoopbackHttp(url: URL): boolean {
  return process.env.NODE_ENV !== "production" && url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
}

function publicOrigin(requestOrigin?: string): URL {
  const origin = new URL(requiredEnvironment("ALBERT_PUBLIC_ORIGIN"));
  const localHttp = isLocalLoopbackHttp(origin);
  if (origin.protocol !== "https:" && !localHttp) throw new OAuthFlowError("The public OAuth origin must use HTTPS.", 503);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new OAuthFlowError("The public OAuth origin must be a clean origin.", 503);
  }
  // Local vinext ports drift; bind the OAuth session callback to the browser's
  // actual loopback origin so Connect from :3001 does not require env churn.
  if (requestOrigin && localHttp) {
    try {
      const request = new URL(requestOrigin);
      if (isLocalLoopbackHttp(request) && request.pathname === "/" && !request.search && !request.hash) {
        return new URL(request.origin);
      }
    } catch {
      throw new OAuthFlowError("The OAuth request origin is invalid.", 400);
    }
  }
  return origin;
}

function cookieName(provider: OAuthWebProvider) {
  return `albert-oauth-${provider}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function callWorker<T>(path: string, bodyValue: unknown): Promise<T> {
  const baseUrl = requiredEnvironment("SYNC_WORKER_INTERNAL_URL");
  const secret = requiredEnvironment("ALBERT_OAUTH_WORKER_SIGNING_SECRET");
  const body = JSON.stringify(bodyValue);
  const headers = await signInternalRequest({ method: "POST", path, body, secret });
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(45_000),
  });
  const payload = await response.json().catch(() => null) as {
    result?: T;
    error?: string;
    detail?: string;
  } | null;
  if (!response.ok) {
    throw new OAuthFlowError(
      payload?.error || "The OAuth worker rejected the request.",
      response.status,
      typeof payload?.detail === "string" ? payload.detail : undefined,
    );
  }
  if (!payload || !("result" in payload)) throw new OAuthFlowError("The OAuth worker returned an invalid response.", 502);
  return payload.result as T;
}

export async function beginOAuthFlow(input: Readonly<{
  provider: OAuthWebProvider;
  tenantId: string;
  userId: string;
  requestOrigin?: string;
  /** Required for Shopify, whose authorize host is the merchant's own shop. */
  shopDomain?: string;
}>): Promise<string> {
  const now = Date.now();
  const expiresAt = now + 10 * 60_000;
  const nonce = createNonce();
  const codeVerifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const redirectUri = new URL(
    `/api/oauth/${input.provider}/callback`,
    publicOrigin(input.requestOrigin),
  ).toString();
  const connector = providerToConnector[input.provider];
  // Normalised before it leaves the browser boundary so an invalid shop fails
  // here with a clear message rather than as an opaque worker rejection. The
  // worker re-validates: this is convenience, not the trust boundary.
  let vendorAccountHint: string | undefined;
  if (input.provider === "shopify") {
    if (!input.shopDomain?.trim()) {
      throw new OAuthFlowError("Enter your myshopify.com store domain to connect Shopify.", 400);
    }
    try {
      vendorAccountHint = normalizeShopifyShopDomain(input.shopDomain);
    } catch {
      throw new OAuthFlowError("That does not look like a myshopify.com store domain.", 400);
    }
  }
  const result = await callWorker<{ oauthSessionId: string; scopes: string[] }>("/v1/oauth/start", {
    tenantId: input.tenantId,
    userId: input.userId,
    provider: connector,
    redirectUri,
    ...(vendorAccountHint ? { vendorAccountHint } : {}),
    stateNonceHash: await sha256(nonce),
    codeVerifier,
    expiresAt: new Date(expiresAt).toISOString(),
  });
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(result.oauthSessionId)) {
    throw new OAuthFlowError("The OAuth worker returned an invalid session.", 502);
  }
  if (
    !Array.isArray(result.scopes) || result.scopes.length === 0 || result.scopes.length > 30 ||
    result.scopes.some((scope) => typeof scope !== "string" || !scope.trim() || scope.length > 160)
  ) {
    throw new OAuthFlowError("The OAuth worker returned invalid requested scopes.", 502);
  }

  const state = await signPayload<OAuthState>({
    issuedAt: now,
    expiresAt,
    nonce,
    oauthSessionId: result.oauthSessionId,
    tenantId: input.tenantId,
    userId: input.userId,
    provider: input.provider,
    redirectUri,
  }, requiredEnvironment("ALBERT_OAUTH_STATE_SECRET"));
  const cookie = await signPayload<OAuthCookie>({
    issuedAt: now,
    expiresAt,
    nonce,
    provider: input.provider,
  }, requiredEnvironment("ALBERT_OAUTH_STATE_SECRET"));
  const cookieStore = await cookies();
  cookieStore.set(cookieName(input.provider), cookie, {
    httpOnly: true,
    // Local HTTPS tunnels (Cloudflare quick tunnel) must mark the cookie Secure
    // or browsers may drop it on the Lightspeed return navigation.
    secure: process.env.NODE_ENV === "production" ||
      requiredEnvironment("ALBERT_PUBLIC_ORIGIN").startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });

  if (input.provider === "lightspeed") {
    // Confidential server client: omit PKCE and request employee:all to match
    // bike-dashboard's working Lightspeed authorize URL. Scope comes from the
    // local pack default so a lagged OAuth worker cannot reintroduce the
    // granular+PKCE shape that loops on merchantos.com in Safari.
    void result.scopes;
    return buildLightspeedRAuthorizationUrl({
      clientId: requiredEnvironment("LIGHTSPEED_CLIENT_ID"),
      state,
      redirectUri,
      scopes: LIGHTSPEED_R_DEFAULT_SCOPES,
    });
  }
  if (input.provider === "lightspeed-x") {
    return buildLightspeedXAuthorizationUrl({
      clientId: requiredEnvironment("LIGHTSPEED_X_CLIENT_ID"),
      state,
      redirectUri,
      scopes: result.scopes,
    });
  }
  if (input.provider === "xero") {
    return buildXeroAuthorizationUrl({
      clientId: requiredEnvironment("XERO_CLIENT_ID"),
      state,
      redirectUri,
      codeChallenge: await pkceChallenge(codeVerifier),
      // The credential-owning worker is the source of truth for optional
      // connector capabilities. This prevents a Sites/Fly configuration drift
      // from authorising scopes the worker did not record for the session.
      scopes: result.scopes,
    });
  }
  if (input.provider === "square") {
    return buildSquareAuthorizationUrl({
      clientId: requiredEnvironment("SQUARE_CLIENT_ID"),
      state,
      redirectUri,
      // The credential-owning worker is the source of truth for the permission
      // set, exactly as for Xero. Square's confidential code flow carries no
      // code_challenge; the application secret authenticates the exchange.
      scopes: result.scopes,
    });
  }
  if (input.provider === "shopify") {
    return buildShopifyAuthorizationUrl({
      clientId: requiredEnvironment("SHOPIFY_CLIENT_ID"),
      state,
      redirectUri,
      shopDomain: vendorAccountHint!,
      scopes: result.scopes,
    });
  }
  if (input.provider === "stripe") {
    return buildStripeAuthorizationUrl({
      clientId: requiredEnvironment("STRIPE_CLIENT_ID"),
      state,
      redirectUri,
      scopes: result.scopes,
    });
  }
  if (input.provider === "momence") {
    return buildMomenceAuthorizationUrl({
      clientId: requiredEnvironment("MOMENCE_CLIENT_ID"),
      state,
      redirectUri,
      scopes: result.scopes,
    });
  }
  if (input.provider === "meta-ads") {
    return buildMetaAdsAuthorizationUrl({
      clientId: requiredEnvironment("META_ADS_CLIENT_ID"),
      state,
      redirectUri,
      scopes: result.scopes,
    });
  }
  if (input.provider === "google-ads") {
    return buildGoogleAdsAuthorizationUrl({
      clientId: requiredEnvironment("GOOGLE_ADS_CLIENT_ID"),
      state,
      redirectUri,
      scopes: result.scopes,
    });
  }
  if (result.scopes.length !== 1 || result.scopes[0] !== "longlife_refresh_token") {
    throw new OAuthFlowError("The OAuth worker returned invalid Deputy scopes.", 502);
  }
  return buildDeputyAuthorizationUrl({
    clientId: requiredEnvironment("DEPUTY_CLIENT_ID"),
    state,
    redirectUri,
  });
}

export type OAuthCallbackResult = Readonly<{
  status: "connected" | "selection_required";
  oauthSessionId: string;
  connectionId?: string;
  /**
   * Null when the connector's initial backfill is suppressed, so the browser
   * never claims a sync started that was deliberately not enqueued.
   */
  jobRequestId?: string | null;
}>;

export async function finishOAuthFlow(input: Readonly<{
  provider: OAuthWebProvider;
  state: string;
  code: string;
  tenantId: string;
  userId: string;
  /** X-Series callback retailer identity; absent for central-host vendors. */
  domainPrefix?: string;
  /** X-Series callback scope echo; token-exchange scope remains authoritative. */
  returnedScope?: string;
}>): Promise<OAuthCallbackResult> {
  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(cookieName(input.provider))?.value;
  if (!cookieToken) throw new OAuthFlowError("The OAuth browser session is missing or expired.", 400);
  let cookie: OAuthCookie;
  let state: OAuthState;
  try {
    cookie = await verifySignedPayload<OAuthCookie>(
      cookieToken,
      requiredEnvironment("ALBERT_OAUTH_STATE_SECRET"),
    );
    state = await verifySignedPayload<OAuthState>(
      input.state,
      requiredEnvironment("ALBERT_OAUTH_STATE_SECRET"),
      { expectedNonce: cookie.nonce },
    );
    if (
      state.provider !== input.provider ||
      cookie.provider !== input.provider ||
      state.tenantId !== input.tenantId ||
      state.userId !== input.userId
    ) {
      throw new OAuthFlowError("The OAuth callback does not match the initiating user.", 403);
    }
  } catch (error) {
    // Invalid state must not leave reusable browser-side authorization state.
    cookieStore.delete(cookieName(input.provider));
    throw error;
  }

  try {
    const result = await callWorker<OAuthCallbackResult>("/v1/oauth/callback", {
      oauthSessionId: state.oauthSessionId,
      tenantId: state.tenantId,
      userId: state.userId,
      provider: providerToConnector[state.provider],
      redirectUri: state.redirectUri,
      stateNonceHash: await sha256(state.nonce),
      code: input.code,
      ...(input.domainPrefix ? { domainPrefix: input.domainPrefix } : {}),
      ...(input.returnedScope ? { returnedScope: input.returnedScope } : {}),
    });
    // Consume the cookie only after the durable worker completed. A transport
    // failure or 5xx can then retry the same bounded callback safely.
    cookieStore.delete(cookieName(input.provider));
    return result;
  } catch (error) {
    if (error instanceof OAuthFlowError && error.status < 500) {
      cookieStore.delete(cookieName(input.provider));
    }
    throw error;
  }
}

export async function selectOAuthAccount(input: Readonly<{
  oauthSessionId: string;
  externalAccountId: string;
  tenantId: string;
  userId: string;
}>): Promise<{ connectionId: string }> {
  return callWorker("/v1/oauth/select", input);
}

export class OAuthFlowError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "OAuthFlowError";
  }
}
