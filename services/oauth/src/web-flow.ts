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
import { buildXeroAuthorizationUrl, XERO_OAUTH_SCOPE_LIMIT, xeroAuthorizeScopes } from "../../../connectors/xero/oauth-public.js";
import {
  createNonce,
  signPayload,
  verifySignedPayload,
  bytesToBase64Url,
} from "../../../packages/security/src/index.js";
import {
  callWorker,
  disconnectFivetranXero,
  OAuthFlowError,
  syncFivetranXero,
} from "./worker-rpc.js";

export { disconnectFivetranXero, OAuthFlowError, syncFivetranXero };

export const oauthProviders = [
  "lightspeed", "lightspeed-x", "xero", "deputy", "square",
  "shopify", "stripe", "momence", "meta-ads", "google-ads",
  "fivetran-xero", "fivetran-lightspeed", "fivetran-deputy", "fivetran-stripe",
] as const;
export type OAuthWebProvider = (typeof oauthProviders)[number];

/**
 * Providers whose ingestion Fivetran runs. The value is Fivetran's service id,
 * which is also the path segment on the worker (`/v1/fivetran/{service}/…`).
 * Xero and Lightspeed authorise inside Fivetran's Connect Card; Deputy is
 * authorised by Albert's own Deputy OAuth and handed to Fivetran via API.
 */
export const fivetranProviders = {
  "fivetran-xero": "xero",
  "fivetran-lightspeed": "light_speed_retail",
  "fivetran-deputy": "deputy",
  "fivetran-stripe": "stripe",
} as const;
export type FivetranWebProvider = keyof typeof fivetranProviders;
export function isFivetranWebProvider(value: string): value is FivetranWebProvider {
  return Object.prototype.hasOwnProperty.call(fivetranProviders, value);
}

type OAuthState = Readonly<{
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  oauthSessionId: string;
  tenantId: string;
  userId: string;
  provider: OAuthWebProvider;
  redirectUri: string;
  /**
   * "fivetran" when Albert's own grant is being obtained on Fivetran's behalf
   * (Deputy): the credential is stored as usual, native ingestion stays off,
   * and the callback hands the token to Fivetran instead.
   */
  managedBy?: "fivetran";
}>;

type OAuthCookie = Readonly<{
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  provider: OAuthWebProvider;
  oauthSessionId?: string;
  codeVerifier?: string;
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
  // Deputy, Xero and Lightspeed R-Series via Fivetran ride Albert's own OAuth
  // apps: same connector, same registered redirect URI, but the grant is
  // handed to Fivetran (Deputy as config; Xero and Lightspeed through Albert's
  // SDK connectors + token broker).
  "fivetran-deputy": "deputy",
  "fivetran-xero": "xero",
  "fivetran-lightspeed": "lightspeed-r",
  "fivetran-stripe": "stripe",
} as const;

/** Fivetran providers whose grant Albert takes itself (no Connect Card). */
const NATIVE_GRANT_FIVETRAN: Readonly<Partial<Record<FivetranWebProvider, "deputy" | "xero" | "lightspeed" | "stripe">>> = {
  "fivetran-deputy": "deputy",
  "fivetran-xero": "xero",
  "fivetran-lightspeed": "lightspeed",
  "fivetran-stripe": "stripe",
};

/** The browser-facing provider whose cookie + callback route a flow uses. */
function browserProvider(provider: OAuthWebProvider): OAuthWebProvider {
  return (isFivetranWebProvider(provider) && NATIVE_GRANT_FIVETRAN[provider]) || provider;
}

function fivetranProviderForNative(native: OAuthWebProvider): FivetranWebProvider | null {
  const entry = Object.entries(NATIVE_GRANT_FIVETRAN).find(([, value]) => value === native);
  return entry ? entry[0] as FivetranWebProvider : null;
}

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

/** Xero AUTH is 44+ scopes. The old 30-scope cap rejected a valid worker response. */
const MAX_WORKER_SCOPES = XERO_OAUTH_SCOPE_LIMIT;

function assertWorkerScopes(scopes: unknown, label: string): asserts scopes is string[] {
  if (
    !Array.isArray(scopes)
    || scopes.length === 0
    || scopes.length > MAX_WORKER_SCOPES
    || scopes.some((scope) => typeof scope !== "string" || !scope.trim() || scope.length > 160)
  ) {
    throw new OAuthFlowError(`The ${label} returned invalid requested scopes.`, 502);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
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
    `/api/oauth/${browserProvider(input.provider)}/callback`,
    publicOrigin(input.requestOrigin),
  ).toString();
  if (isFivetranWebProvider(input.provider) && !NATIVE_GRANT_FIVETRAN[input.provider]) {
    return beginFivetranFlow({
      provider: input.provider,
      tenantId: input.tenantId,
      userId: input.userId,
      nonce,
      now,
      expiresAt,
      redirectUri,
    });
  }
  const connector = providerToConnector[input.provider as keyof typeof providerToConnector];
  // Vendor branches below key off the native provider: a Fivetran-managed
  // provider (fivetran-xero) rides its native app (xero).
  const nativeProvider = browserProvider(input.provider);
  // Normalised before it leaves the browser boundary so an invalid shop fails
  // here with a clear message rather than as an opaque worker rejection. The
  // worker re-validates: this is convenience, not the trust boundary.
  let vendorAccountHint: string | undefined;
  if (nativeProvider === "shopify") {
    if (!input.shopDomain?.trim()) {
      throw new OAuthFlowError("Enter your myshopify.com store domain to connect Shopify.", 400);
    }
    try {
      vendorAccountHint = normalizeShopifyShopDomain(input.shopDomain);
    } catch {
      throw new OAuthFlowError("That does not look like a myshopify.com store domain.", 400);
    }
  }
  const result = await callWorker<{ oauthSessionId: string; scopes: string[]; clientId?: string }>("/v1/oauth/start", {
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
  assertWorkerScopes(result.scopes, "OAuth worker");

  // The worker (credential owner) hands back the exact public client id its
  // token exchange will use; the env var is only a fallback. This guarantees
  // the authorize URL and the exchange target the same OAuth app.
  const clientId = (name: string): string =>
    (result.clientId && result.clientId.trim()) || requiredEnvironment(name);
  const managedBy = isFivetranWebProvider(input.provider) && NATIVE_GRANT_FIVETRAN[input.provider]
    ? "fivetran" as const
    : undefined;
  const state = await signPayload<OAuthState>({
    issuedAt: now,
    expiresAt,
    nonce,
    oauthSessionId: result.oauthSessionId,
    tenantId: input.tenantId,
    userId: input.userId,
    provider: browserProvider(input.provider),
    redirectUri,
    ...(managedBy ? { managedBy } : {}),
  }, requiredEnvironment("ALBERT_OAUTH_STATE_SECRET"));
  const cookie = await signPayload<OAuthCookie>({
    issuedAt: now,
    expiresAt,
    nonce,
    provider: browserProvider(input.provider),
  }, requiredEnvironment("ALBERT_OAUTH_STATE_SECRET"));
  const cookieStore = await cookies();
  cookieStore.set(cookieName(browserProvider(input.provider)), cookie, {
    httpOnly: true,
    // Local HTTPS tunnels (Cloudflare quick tunnel) must mark the cookie Secure
    // or browsers may drop it on the Lightspeed return navigation.
    secure: process.env.NODE_ENV === "production" ||
      requiredEnvironment("ALBERT_PUBLIC_ORIGIN").startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });

  if (nativeProvider === "lightspeed") {
    // Confidential server client: omit PKCE and request employee:all to match
    // bike-dashboard's working Lightspeed authorize URL. Scope comes from the
    // local pack default so a lagged OAuth worker cannot reintroduce the
    // granular+PKCE shape that loops on merchantos.com in Safari.
    void result.scopes;
    return buildLightspeedRAuthorizationUrl({
      clientId: clientId("LIGHTSPEED_CLIENT_ID"),
      state,
      redirectUri,
      scopes: LIGHTSPEED_R_DEFAULT_SCOPES,
    });
  }
  if (nativeProvider === "lightspeed-x") {
    return buildLightspeedXAuthorizationUrl({
      clientId: clientId("LIGHTSPEED_X_CLIENT_ID"),
      state,
      redirectUri,
      scopes: result.scopes,
    });
  }
  if (nativeProvider === "xero") {
    return buildXeroAuthorizationUrl({
      clientId: clientId("XERO_CLIENT_ID"),
      state,
      redirectUri,
      codeChallenge: await pkceChallenge(codeVerifier),
      // Always request the current Xero AUTH set. The worker can still add
      // Advanced Journals; it cannot drop report or write scopes.
      scopes: xeroAuthorizeScopes(result.scopes),
    });
  }
  if (nativeProvider === "square") {
    return buildSquareAuthorizationUrl({
      clientId: clientId("SQUARE_CLIENT_ID"),
      state,
      redirectUri,
      // The credential-owning worker is the source of truth for the permission
      // set, exactly as for Xero. Square's confidential code flow carries no
      // code_challenge; the application secret authenticates the exchange.
      scopes: result.scopes,
    });
  }
  if (nativeProvider === "shopify") {
    return buildShopifyAuthorizationUrl({
      clientId: clientId("SHOPIFY_CLIENT_ID"),
      state,
      redirectUri,
      shopDomain: vendorAccountHint!,
      scopes: result.scopes,
    });
  }
  if (nativeProvider === "stripe") {
    const stripeClientId = (result.clientId && result.clientId.trim()) || process.env.STRIPE_CLIENT_ID?.trim();
    if (!stripeClientId) {
      throw new OAuthFlowError(
        "Stripe Connect is not configured on the sync worker yet. Add STRIPE_CLIENT_ID and STRIPE_SECRET_KEY, then try again.",
        503,
      );
    }
    return buildStripeAuthorizationUrl({
      clientId: stripeClientId,
      state,
      redirectUri,
      scopes: result.scopes,
    });
  }
  if (nativeProvider === "momence") {
    return buildMomenceAuthorizationUrl({
      clientId: clientId("MOMENCE_CLIENT_ID"),
      state,
      redirectUri,
      scopes: result.scopes,
    });
  }
  if (nativeProvider === "meta-ads") {
    return buildMetaAdsAuthorizationUrl({
      clientId: clientId("META_ADS_CLIENT_ID"),
      state,
      redirectUri,
      scopes: result.scopes,
    });
  }
  if (nativeProvider === "google-ads") {
    return buildGoogleAdsAuthorizationUrl({
      clientId: clientId("GOOGLE_ADS_CLIENT_ID"),
      state,
      redirectUri,
      scopes: result.scopes,
    });
  }
  if (result.scopes.length !== 1 || result.scopes[0] !== "longlife_refresh_token") {
    throw new OAuthFlowError("The OAuth worker returned invalid Deputy scopes.", 502);
  }
  return buildDeputyAuthorizationUrl({
    clientId: clientId("DEPUTY_CLIENT_ID"),
    state,
    redirectUri,
  });
}

export type OAuthCallbackResult = Readonly<{
  status: "connected" | "selection_required" | "setup_incomplete";
  oauthSessionId: string;
  connectionId?: string;
  connectCardUri?: string;
  /** Set when the grant was taken on behalf of a Fivetran-managed provider. */
  provider?: OAuthWebProvider;
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
      provider: providerToConnector[state.provider as keyof typeof providerToConnector],
      redirectUri: state.redirectUri,
      stateNonceHash: await sha256(state.nonce),
      code: input.code,
      ...(input.domainPrefix ? { domainPrefix: input.domainPrefix } : {}),
      ...(input.returnedScope ? { returnedScope: input.returnedScope } : {}),
      ...(state.managedBy ? { managedBy: state.managedBy } : {}),
    });
    // Consume the cookie only after the durable worker completed. A transport
    // failure or 5xx can then retry the same bounded callback safely.
    cookieStore.delete(cookieName(input.provider));
    const fivetranProvider = state.managedBy === "fivetran" ? fivetranProviderForNative(state.provider) : null;
    if (fivetranProvider) {
      if (result.status === "selection_required") {
        // Xero with several organisations: remember that this session is
        // Fivetran-managed so the account choice can finish the hand-off.
        await rememberFivetranHandoff(result.oauthSessionId, fivetranProvider);
        return { ...result, provider: fivetranProvider };
      }
      if (result.status !== "connected" || !result.connectionId) {
        throw new OAuthFlowError("Authorisation did not finish, so nothing was handed to Fivetran.", 409);
      }
      return handToFivetran({
        provider: fivetranProvider,
        tenantId: state.tenantId,
        userId: state.userId,
        nativeConnectionId: result.connectionId,
        oauthSessionId: result.oauthSessionId,
      });
    }
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
}>): Promise<{ connectionId: string; provider?: FivetranWebProvider }> {
  const handoff = await recallFivetranHandoff(input.oauthSessionId);
  const result = await callWorker<{ connectionId: string }>("/v1/oauth/select", {
    ...input,
    ...(handoff ? { managedBy: "fivetran" } : {}),
  });
  if (!handoff) return result;
  const handed = await handToFivetran({
    provider: handoff,
    tenantId: input.tenantId,
    userId: input.userId,
    nativeConnectionId: result.connectionId,
    oauthSessionId: input.oauthSessionId,
  });
  return { connectionId: handed.connectionId ?? result.connectionId, provider: handoff };
}

/**
 * The credential is stored and native ingestion is off; hand the grant to
 * Fivetran, which owns extraction from here (Deputy: config; Xero: Albert's
 * SDK connector deployed by the worker).
 */
async function handToFivetran(input: Readonly<{
  provider: FivetranWebProvider;
  tenantId: string;
  userId: string;
  nativeConnectionId: string;
  oauthSessionId: string;
}>): Promise<OAuthCallbackResult> {
  const handed = await callWorker<{ connectionId: string; fivetranConnectionId: string }>(
    `/v1/fivetran/${fivetranProviders[input.provider]}/start`,
    {
      tenantId: input.tenantId,
      userId: input.userId,
      nativeConnectionId: input.nativeConnectionId,
    },
  );
  await forgetFivetranHandoff(input.oauthSessionId);
  return {
    status: "connected",
    oauthSessionId: input.oauthSessionId,
    connectionId: handed.connectionId,
    provider: input.provider,
    jobRequestId: null,
  };
}

const HANDOFF_COOKIE_TTL_MS = 15 * 60_000;

function handoffCookieName(oauthSessionId: string): string {
  return `albert-oauth-fivetran-handoff-${oauthSessionId}`;
}

async function rememberFivetranHandoff(oauthSessionId: string, provider: FivetranWebProvider): Promise<void> {
  const now = Date.now();
  const cookie = await signPayload<{ provider: FivetranWebProvider; issuedAt: number; expiresAt: number; nonce: string }>({
    provider,
    issuedAt: now,
    expiresAt: now + HANDOFF_COOKIE_TTL_MS,
    nonce: oauthSessionId,
  }, requiredEnvironment("ALBERT_OAUTH_STATE_SECRET"));
  const cookieStore = await cookies();
  cookieStore.set(handoffCookieName(oauthSessionId), cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" ||
      requiredEnvironment("ALBERT_PUBLIC_ORIGIN").startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge: HANDOFF_COOKIE_TTL_MS / 1000,
  });
}

async function recallFivetranHandoff(oauthSessionId: string): Promise<FivetranWebProvider | null> {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(oauthSessionId)) return null;
  const cookieStore = await cookies();
  const token = cookieStore.get(handoffCookieName(oauthSessionId))?.value;
  if (!token) return null;
  try {
    const payload = await verifySignedPayload<{ provider: string; issuedAt: number; expiresAt: number; nonce: string }>(
      token,
      requiredEnvironment("ALBERT_OAUTH_STATE_SECRET"),
      { expectedNonce: oauthSessionId },
    );
    if (payload.expiresAt < Date.now() || !isFivetranWebProvider(payload.provider)) return null;
    return payload.provider;
  } catch {
    return null;
  }
}

async function forgetFivetranHandoff(oauthSessionId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(handoffCookieName(oauthSessionId));
}

async function beginFivetranFlow(input: Readonly<{
  provider: FivetranWebProvider;
  tenantId: string;
  userId: string;
  nonce: string;
  now: number;
  expiresAt: number;
  redirectUri: string;
}>): Promise<string> {
  const service = fivetranProviders[input.provider];
  const result = await callWorker<{
    oauthSessionId: string;
    connectCardUri: string;
  }>(`/v1/fivetran/${service}/start`, {
    tenantId: input.tenantId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    stateNonceHash: await sha256(input.nonce),
    expiresAt: new Date(input.expiresAt).toISOString(),
  });
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(result.oauthSessionId)) {
    throw new OAuthFlowError("The Fivetran worker returned an invalid session.", 502);
  }
  if (
    typeof result.connectCardUri !== "string"
    || !result.connectCardUri.startsWith("https://fivetran.com/")
  ) {
    throw new OAuthFlowError("The Fivetran worker did not return a Connect Card.", 502);
  }
  const cookie = await signPayload<OAuthCookie>({
    issuedAt: input.now,
    expiresAt: input.expiresAt,
    nonce: input.nonce,
    provider: input.provider,
    oauthSessionId: result.oauthSessionId,
  }, requiredEnvironment("ALBERT_OAUTH_STATE_SECRET"));
  const cookieStore = await cookies();
  cookieStore.set(cookieName(input.provider), cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" ||
      requiredEnvironment("ALBERT_PUBLIC_ORIGIN").startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return result.connectCardUri;
}

export async function finishFivetranOAuthFlow(input: Readonly<{
  provider?: FivetranWebProvider;
  tenantId: string;
  userId: string;
}>): Promise<OAuthCallbackResult> {
  const provider = input.provider ?? "fivetran-xero";
  const service = fivetranProviders[provider];
  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(cookieName(provider))?.value;
  if (!cookieToken) throw new OAuthFlowError("The OAuth browser session is missing or expired.", 400);
  let cookie: OAuthCookie;
  try {
    cookie = await verifySignedPayload<OAuthCookie>(
      cookieToken,
      requiredEnvironment("ALBERT_OAUTH_STATE_SECRET"),
    );
    if (
      cookie.provider !== provider
      || !cookie.oauthSessionId
      || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(cookie.oauthSessionId)
    ) {
      throw new OAuthFlowError("The OAuth callback does not match the initiating user.", 403);
    }
  } catch (error) {
    cookieStore.delete(cookieName(provider));
    throw error;
  }
  try {
    const result = await callWorker<OAuthCallbackResult>(`/v1/fivetran/${service}/callback`, {
      oauthSessionId: cookie.oauthSessionId,
      tenantId: input.tenantId,
      userId: input.userId,
      stateNonceHash: await sha256(cookie.nonce),
    });
    cookieStore.delete(cookieName(provider));
    return result;
  } catch (error) {
    if (error instanceof OAuthFlowError && error.status < 500) {
      cookieStore.delete(cookieName(provider));
    }
    throw error;
  }
}

