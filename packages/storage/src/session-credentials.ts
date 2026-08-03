import type { RawStorageS3Config } from "./s3.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REFRESH_SKEW_MS = 60_000;

type TokenSession = Readonly<{
  accessToken: string;
  refreshToken: string;
  userId: string;
  sessionId: string;
  tokenExpiresAt: number;
}>;

type AuthorizedSession = TokenSession & Readonly<{ expiresAt: number }>;

type AuthTokenDocument = Readonly<{
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
  user?: unknown;
}>;

export type S3SessionCredentials = Readonly<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}>;

export type MachineSessionIdentity = Readonly<{
  userId: string;
  sessionId: string;
  tokenExpiresAt: Date;
}>;

export type MachineSessionAuthorization = Readonly<{
  expiresAt: Date;
}>;

type SessionRequestOptions = Readonly<{
  fetch?: typeof fetch;
  now?: () => number;
}>;

export type SupabaseMachineCredentialProviderOptions = SessionRequestOptions & Readonly<{
  sessionPool?: SupabaseMachineSessionPool;
  authorizeSession?: (
    identity: MachineSessionIdentity,
  ) => Promise<MachineSessionAuthorization>;
}>;

function decodeAccessToken(token: string): Readonly<Record<string, unknown>> {
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("Raw Storage Auth returned an invalid access token.");
  try {
    const parsed = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    throw new Error("Raw Storage Auth returned an invalid access token.");
  }
}

function validateSession(
  document: AuthTokenDocument,
  config: RawStorageS3Config,
  now: number,
): TokenSession {
  if (
    typeof document.access_token !== "string" || document.access_token.length > 16_384 ||
    typeof document.refresh_token !== "string" || document.refresh_token.length > 16_384
  ) {
    throw new Error("Raw Storage Auth returned an incomplete session.");
  }
  const user = document.user;
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    throw new Error("Raw Storage Auth returned no machine user.");
  }
  const userId = (user as Readonly<Record<string, unknown>>).id;
  if (typeof userId !== "string" || !UUID.test(userId)) {
    throw new Error("Raw Storage Auth returned an invalid machine user.");
  }
  const claims = decodeAccessToken(document.access_token);
  const audience = claims.aud;
  const authenticatedAudience = audience === "authenticated" ||
    (Array.isArray(audience) && audience.includes("authenticated"));
  const appMetadata = claims.app_metadata;
  const sessionId = claims.session_id;
  if (
    claims.sub !== userId || claims.role !== "authenticated" || !authenticatedAudience ||
    typeof sessionId !== "string" || !UUID.test(sessionId) ||
    !appMetadata || typeof appMetadata !== "object" || Array.isArray(appMetadata) ||
    (appMetadata as Readonly<Record<string, unknown>>).albert_raw_storage_purpose !==
      config.machinePurpose ||
    (appMetadata as Readonly<Record<string, unknown>>).albert_machine_principal !== true
  ) {
    throw new Error("Raw Storage Auth session is not bound to the expected machine purpose.");
  }
  const claimExpiry = Number(claims.exp) * 1_000;
  const responseExpiry = typeof document.expires_at === "number"
    ? document.expires_at * 1_000
    : now + Number(document.expires_in) * 1_000;
  const tokenExpiresAt = Math.min(claimExpiry, responseExpiry);
  if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= now + 5_000) {
    throw new Error("Raw Storage Auth returned an expired machine session.");
  }
  return Object.freeze({
    accessToken: document.access_token,
    refreshToken: document.refresh_token,
    userId,
    sessionId,
    tokenExpiresAt,
  });
}

/**
 * One reusable Supabase Auth session per machine purpose/replica. Scoped S3
 * clients share this cache, while each client independently obtains and
 * revokes its exact control-plane grant. Concurrent scopes therefore amortize
 * password login without sharing authorization state.
 */
export class SupabaseMachineSessionPool {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private session: TokenSession | undefined;
  private pending: Promise<TokenSession> | undefined;

  constructor(
    private readonly config: RawStorageS3Config,
    options: SessionRequestOptions = {},
  ) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async tokenRequest(
    grantType: "password" | "refresh_token",
    body: Readonly<Record<string, string>>,
  ): Promise<AuthTokenDocument> {
    const response = await this.request(
      `${this.config.authUrl}/auth/v1/token?grant_type=${grantType}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: this.config.legacyAnonKey,
          authorization: `Bearer ${this.config.legacyAnonKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Raw Storage Auth session request failed (http_${response.status}).`);
    }
    const document = await response.json() as unknown;
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("Raw Storage Auth returned an invalid session document.");
    }
    return document as AuthTokenDocument;
  }

  private async renew(): Promise<TokenSession> {
    const now = this.now();
    if (this.session?.refreshToken) {
      try {
        return validateSession(await this.tokenRequest("refresh_token", {
          refresh_token: this.session.refreshToken,
        }), this.config, now);
      } catch {
        // A revoked/expired refresh token is recoverable with the protected
        // machine password. No token or provider response is ever logged.
        this.session = undefined;
      }
    }
    return validateSession(await this.tokenRequest("password", {
      email: this.config.machineEmail,
      password: this.config.machinePassword,
    }), this.config, now);
  }

  async getSession(): Promise<TokenSession> {
    const now = this.now();
    if (this.session && this.session.tokenExpiresAt-now>REFRESH_SKEW_MS) return this.session;
    this.pending ??= this.renew().finally(() => {
      this.pending = undefined;
    });
    this.session = await this.pending;
    return this.session;
  }
}

/**
 * Supplies AWS session credentials backed by a reusable Supabase machine Auth
 * session. The legacy anon key signs only the S3 request envelope; Storage
 * validates the short-lived JWT and its exact control-plane grant through RLS.
 */
export class SupabaseMachineSessionCredentialProvider {
  private readonly now: () => number;
  private readonly sessionPool: SupabaseMachineSessionPool;
  private readonly authorizeSession: SupabaseMachineCredentialProviderOptions["authorizeSession"];
  private session: AuthorizedSession | undefined;
  private pending: Promise<AuthorizedSession> | undefined;

  constructor(
    private readonly config: RawStorageS3Config,
    options: SupabaseMachineCredentialProviderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sessionPool = options.sessionPool ?? new SupabaseMachineSessionPool(config, options);
    this.authorizeSession = options.authorizeSession;
  }

  private async authorize(): Promise<AuthorizedSession> {
    const tokenSession = await this.sessionPool.getSession();
    if (!this.authorizeSession) {
      return Object.freeze({ ...tokenSession, expiresAt: tokenSession.tokenExpiresAt });
    }
    const authorization = await this.authorizeSession(Object.freeze({
      userId: tokenSession.userId,
      sessionId: tokenSession.sessionId,
      tokenExpiresAt: new Date(tokenSession.tokenExpiresAt),
    }));
    const authorizedUntil = authorization.expiresAt.valueOf();
    const now = this.now();
    if (
      !Number.isFinite(authorizedUntil) ||
      authorizedUntil <= now+5_000 ||
      authorizedUntil > tokenSession.tokenExpiresAt
    ) {
      throw new Error("Raw Storage session authority returned an invalid expiry.");
    }
    return Object.freeze({ ...tokenSession, expiresAt: authorizedUntil });
  }

  async getCredentials(): Promise<S3SessionCredentials> {
    const now = this.now();
    if (this.session && this.session.expiresAt-now>REFRESH_SKEW_MS) {
      return this.credentials(this.session);
    }
    this.pending ??= this.authorize().finally(() => {
      this.pending = undefined;
    });
    this.session = await this.pending;
    return this.credentials(this.session);
  }

  private credentials(session: AuthorizedSession): S3SessionCredentials {
    return Object.freeze({
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.legacyAnonKey,
      sessionToken: session.accessToken,
      expiration: new Date(session.expiresAt),
    });
  }
}
