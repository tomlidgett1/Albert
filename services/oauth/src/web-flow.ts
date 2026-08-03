import { cookies } from "next/headers";
import { buildDeputyAuthorizationUrl } from "../../../connectors/deputy/oauth-public.js";
import { buildLightspeedRAuthorizationUrl } from "../../../connectors/lightspeed-r/oauth-public.js";
import { buildXeroAuthorizationUrl } from "../../../connectors/xero/oauth-public.js";
import { xeroRequestedScopes } from "../../../connectors/xero/manifest.js";
import {
  createNonce,
  signInternalRequest,
  signPayload,
  verifySignedPayload,
  bytesToBase64Url,
} from "../../../packages/security/src/index.js";

export const oauthProviders = ["lightspeed", "xero", "deputy"] as const;
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
  xero: "xero",
  deputy: "deputy",
} as const;

export function isOAuthWebProvider(value: string): value is OAuthWebProvider {
  return (oauthProviders as readonly string[]).includes(value);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new OAuthFlowError(`OAuth is not configured (${name}).`, 503);
  return value;
}

function publicOrigin(): URL {
  const origin = new URL(requiredEnvironment("ALBERT_PUBLIC_ORIGIN"));
  const localHttp = origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !localHttp) throw new OAuthFlowError("The public OAuth origin must use HTTPS.", 503);
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
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
  const payload = await response.json().catch(() => null) as { result?: T; error?: string } | null;
  if (!response.ok) throw new OAuthFlowError(payload?.error || "The OAuth worker rejected the request.", response.status);
  if (!payload || !("result" in payload)) throw new OAuthFlowError("The OAuth worker returned an invalid response.", 502);
  return payload.result as T;
}

export async function beginOAuthFlow(input: Readonly<{
  provider: OAuthWebProvider;
  tenantId: string;
  userId: string;
}>): Promise<string> {
  const now = Date.now();
  const expiresAt = now + 10 * 60_000;
  const nonce = createNonce();
  const codeVerifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const redirectUri = new URL(`/api/oauth/${input.provider}/callback`, publicOrigin()).toString();
  const connector = providerToConnector[input.provider];
  const result = await callWorker<{ oauthSessionId: string }>("/v1/oauth/start", {
    tenantId: input.tenantId,
    userId: input.userId,
    provider: connector,
    redirectUri,
    stateNonceHash: await sha256(nonce),
    codeVerifier,
    expiresAt: new Date(expiresAt).toISOString(),
  });
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(result.oauthSessionId)) {
    throw new OAuthFlowError("The OAuth worker returned an invalid session.", 502);
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
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });

  if (input.provider === "lightspeed") {
    return buildLightspeedRAuthorizationUrl({
      clientId: requiredEnvironment("LIGHTSPEED_CLIENT_ID"),
      state,
      redirectUri,
      codeChallenge: await pkceChallenge(codeVerifier),
    });
  }
  if (input.provider === "xero") {
    return buildXeroAuthorizationUrl({
      clientId: requiredEnvironment("XERO_CLIENT_ID"),
      state,
      redirectUri,
      codeChallenge: await pkceChallenge(codeVerifier),
      scopes: xeroRequestedScopes(process.env.XERO_ENABLE_ADVANCED_JOURNALS === "true"),
    });
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
}>;

export async function finishOAuthFlow(input: Readonly<{
  provider: OAuthWebProvider;
  state: string;
  code: string;
  tenantId: string;
  userId: string;
}>): Promise<OAuthCallbackResult> {
  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(cookieName(input.provider))?.value;
  cookieStore.delete(cookieName(input.provider));
  if (!cookieToken) throw new OAuthFlowError("The OAuth browser session is missing or expired.", 400);
  const cookie = await verifySignedPayload<OAuthCookie>(
    cookieToken,
    requiredEnvironment("ALBERT_OAUTH_STATE_SECRET"),
  );
  const state = await verifySignedPayload<OAuthState>(
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
  return callWorker<OAuthCallbackResult>("/v1/oauth/callback", {
    oauthSessionId: state.oauthSessionId,
    tenantId: state.tenantId,
    userId: state.userId,
    provider: providerToConnector[state.provider],
    redirectUri: state.redirectUri,
    stateNonceHash: await sha256(state.nonce),
    code: input.code,
  });
}

export async function selectOAuthAccount(input: Readonly<{
  oauthSessionId: string;
  externalAccountId: string;
  tenantId: string;
  userId: string;
}>): Promise<{ connectionId: string }> {
  return callWorker("/v1/oauth/select", input);
}

export async function disconnectOAuthConnection(input: Readonly<{
  connectionId: string;
  tenantId: string;
  userId: string;
}>): Promise<{ deletionRequestId: string }> {
  return callWorker("/v1/oauth/disconnect", input);
}

export class OAuthFlowError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OAuthFlowError";
  }
}
