import { z } from "zod";

import {
  ConnectorError,
  ConnectorHttpError,
  credentialExpiresSoon,
  requestJson,
  splitOAuthScopes,
  type AuthorizationCodeExchange,
  type AuthorizationRedirect,
  type AuthorizationRequest,
  type ConnectionDiscovery,
  type ConnectionHealth,
  type ConnectorCapability,
  type ConnectorContext,
  type ConnectorStream,
  type CredentialRefreshLeaseProof,
  type FetchLike,
  type HttpRetryOptions,
  type OAuthConnectorPack,
  type OAuthCredentialSecret,
  type OAuthExchangeResult,
  type ReconciliationRequest,
  type SyncCursor,
  type SyncPage,
  type SyncRange,
  type VersionedCredential,
  type WebhookDisposition,
  type WebhookEnvelope,
  type WorkerCredentialVault,
} from "../../packages/connector-sdk/src";
import {
  SQUARE_ALLOWED_SCOPES,
  SQUARE_API_VERSION,
  SQUARE_DEFAULT_SCOPES,
  squareManifest,
} from "./manifest";
import { buildSquareAuthorizationUrl } from "./oauth-public";

const OAUTH_ORIGIN = "https://connect.squareup.com";
const TOKEN_ENDPOINT = `${OAUTH_ORIGIN}/oauth2/token`;
const REVOCATION_ENDPOINT = `${OAUTH_ORIGIN}/oauth2/revoke`;
const API_ORIGIN = "https://connect.squareup.com";

/**
 * Square returns an absolute `expires_at` rather than a relative lifetime, so
 * the pack never derives expiry from local clock arithmetic on a duration.
 */
const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("bearer"),
  expires_at: z.string().min(1),
  merchant_id: z.string().min(1),
  refresh_token: z.string().min(1),
  refresh_token_expires_at: z.string().min(1).optional(),
  short_lived: z.boolean().optional(),
  scopes: z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough();

const merchantSchema = z.object({
  merchant: z.object({
    id: z.string().min(1),
    business_name: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    language_code: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    main_location_id: z.string().nullable().optional(),
  }).passthrough(),
}).passthrough();

const locationsSchema = z.object({
  locations: z.array(z.object({
    id: z.string().min(1),
    name: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  }).passthrough()).optional(),
}).passthrough();

export type SquareConnectorConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  vault: WorkerCredentialVault;
  fetcher?: FetchLike;
  retry?: HttpRetryOptions;
  now?: () => number;
}>;

function required(value: string, label: string): string {
  if (!value || !value.trim()) throw new ConnectorError("CONFIGURATION_INVALID", `${label} is required.`);
  return value;
}

function isoOrThrow(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Square returned an unparseable ${label}.`);
  }
  return new Date(parsed).toISOString();
}

/**
 * Authorization-only Square pack. It exchanges, refreshes and revokes the
 * seller grant and reads merchant/location identity. Every extraction entry
 * point fails closed: the manifest declares no stream, so a sync request for
 * Square is a routing defect rather than a recoverable condition.
 */
export class SquareConnector implements OAuthConnectorPack {
  readonly id = "square" as const;
  readonly version = squareManifest.packVersion;
  readonly apiVersion = squareManifest.apiVersion;
  readonly manifest = squareManifest;

  private readonly config: SquareConnectorConfig;
  private readonly fetcher: FetchLike;
  private readonly refreshes = new Map<string, Promise<VersionedCredential>>();

  constructor(config: SquareConnectorConfig) {
    this.config = {
      ...config,
      clientId: required(config.clientId, "Square application ID"),
      clientSecret: required(config.clientSecret, "Square application secret"),
      redirectUri: required(config.redirectUri, "Square redirect URI"),
    };
    this.fetcher = config.fetcher ?? fetch;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    const scopes = request.scopes.length > 0 ? request.scopes : SQUARE_DEFAULT_SCOPES;
    const unsupported = scopes.filter(
      (scope) => !SQUARE_ALLOWED_SCOPES.includes(scope as (typeof SQUARE_ALLOWED_SCOPES)[number]),
    );
    if (unsupported.length > 0) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        `Unsupported Square permission requested: ${unsupported.join(", ")}.`,
      );
    }
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Square redirect URI does not match configured OAuth client.");
    }
    return {
      url: buildSquareAuthorizationUrl({
        clientId: this.config.clientId,
        state: request.state,
        redirectUri: request.redirectUri,
        scopes,
      }),
      expiresAt: new Date((this.config.now?.() ?? Date.now()) + 10 * 60_000).toISOString(),
    };
  }

  async exchange_authorization_code(
    request: AuthorizationCodeExchange,
  ): Promise<OAuthExchangeResult> {
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Square redirect URI does not match configured OAuth client.");
    }
    const parsed = await this.postToken({
      grant_type: "authorization_code",
      code: required(request.code, "Square authorization code"),
      redirect_uri: request.redirectUri,
    }, request.abortSignal, "Square returned an invalid OAuth token response.");
    const scopes = splitOAuthScopes(parsed.scopes);
    const stored = await this.config.vault.create({
      provider: this.id,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      tokenType: "Bearer",
      expiresAt: isoOrThrow(parsed.expires_at, "token expiry"),
      scopes: scopes.length > 0 ? scopes : SQUARE_DEFAULT_SCOPES,
      metadata: {
        merchantId: parsed.merchant_id,
        // Recorded so an operator can see when a PKCE-style bounded refresh
        // token was issued; the confidential flow leaves this absent.
        refreshTokenExpiresAt: parsed.refresh_token_expires_at ?? "",
      },
    });
    return { credentialRef: stored.credentialRef, expiresAt: stored.secret.expiresAt, scopes: stored.secret.scopes };
  }

  async check_connection(context: ConnectorContext): Promise<ConnectionHealth> {
    try {
      await this.discover_account(context);
      return "healthy";
    } catch (error) {
      if (error instanceof ConnectorHttpError && error.status === 401) return "expired";
      if (error instanceof ConnectorHttpError && error.status === 403) return "degraded";
      throw error;
    }
  }

  /** A Square access token authorises exactly one merchant. */
  async discover_accounts(context: ConnectorContext): Promise<readonly ConnectionDiscovery[]> {
    return [await this.discover_account(context)];
  }

  async discover_account(context: ConnectorContext): Promise<ConnectionDiscovery> {
    const credential = await this.validCredential(context);
    const merchantId = String(credential.secret.metadata.merchantId ?? "");
    if (!merchantId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Square credential is missing its merchant identity.");
    }
    const { value } = await this.apiJson(
      `/v2/merchants/${encodeURIComponent(merchantId)}`,
      credential,
      context.abortSignal,
    );
    const parsed = merchantSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Square returned an invalid merchant response.", {
        cause: parsed.error,
      });
    }
    const merchant = parsed.data.merchant;
    if (merchant.id !== merchantId) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Square returned a merchant that does not match the grant.");
    }
    const locations = await this.listLocations(credential, context.abortSignal);
    return {
      externalAccountId: merchant.id,
      displayName: merchant.business_name?.trim() || `Square merchant ${merchant.id}`,
      metadata: {
        merchantId: merchant.id,
        country: merchant.country ?? null,
        currency: merchant.currency ?? null,
        languageCode: merchant.language_code ?? null,
        status: merchant.status ?? null,
        mainLocationId: merchant.main_location_id ?? null,
        locationCount: locations.length,
        // Identity evidence only. Locations are not a canonical location until
        // Square declares a stream that extracts them.
        locationIds: locations.map((location) => location.id).join(","),
      },
    };
  }

  async select_account(
    context: ConnectorContext,
    externalAccountId: string,
  ): Promise<ConnectionDiscovery> {
    const account = await this.discover_account(context);
    if (externalAccountId !== account.externalAccountId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "A Square OAuth token belongs to exactly one merchant.");
    }
    return account;
  }

  /** Authorization-only: Square declares no extractable stream. */
  async list_streams(context: ConnectorContext): Promise<readonly ConnectorStream[]> {
    void context;
    return [];
  }

  async initial_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    range: SyncRange,
    cursor?: SyncCursor,
  ): Promise<SyncPage> {
    void context; void range; void cursor;
    return this.noStreams(stream);
  }

  async incremental_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    cursor: SyncCursor,
  ): Promise<SyncPage> {
    void context; void cursor;
    return this.noStreams(stream);
  }

  async reconciliation_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    request: ReconciliationRequest,
  ): Promise<SyncPage> {
    void context; void request;
    return this.noStreams(stream);
  }

  async handle_webhook(
    context: ConnectorContext,
    event: WebhookEnvelope,
  ): Promise<WebhookDisposition> {
    void context; void event;
    // Square publishes webhooks, but with no stream to accelerate an accepted
    // disposition would claim ingestion that cannot happen.
    return { accepted: false, streams: [], reason: "square_authorization_only_pack" };
  }

  async refresh_credentials(context: ConnectorContext): Promise<{ credentialRef: string }> {
    const current = await this.readCredential(context);
    return { credentialRef: (await this.refreshCredential(current, context.abortSignal)).credentialRef };
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    const credential = await this.readCredential(context);
    try {
      await requestJson<unknown>(
        this.fetcher,
        REVOCATION_ENDPOINT,
        {
          method: "POST",
          headers: {
            // Square authenticates revocation with the application secret under
            // its own `Client` scheme, not Bearer.
            authorization: `Client ${this.config.clientSecret}`,
            "content-type": "application/json",
            accept: "application/json",
            "square-version": SQUARE_API_VERSION,
          },
          body: JSON.stringify({
            client_id: this.config.clientId,
            access_token: credential.secret.accessToken,
            // Without this Square terminates every token the application holds
            // for the merchant, which would silently disconnect another Albert
            // environment authorised against the same seller.
            revoke_only_access_token: true,
          }),
          signal: context.abortSignal,
        },
        this.config.retry,
      );
    } finally {
      // A vendor revocation failure must never strand an encrypted local token.
      await this.config.vault.destroy(context.credentialRef);
    }
  }

  async describe_capabilities(context: ConnectorContext): Promise<readonly ConnectorCapability[]> {
    void context;
    // No stream, so no capability may be published. An empty list keeps the
    // readiness surface honest instead of implying unknown-but-coming coverage.
    return [];
  }

  private noStreams(stream: ConnectorStream): never {
    throw new ConnectorError(
      "CAPABILITY_UNAVAILABLE",
      `Square is an authorization-only pack and declares no stream (requested: ${stream.id}).`,
    );
  }

  private async listLocations(
    credential: VersionedCredential,
    signal?: AbortSignal,
  ): Promise<readonly Readonly<{ id: string }>[]> {
    const { value } = await this.apiJson("/v2/locations", credential, signal);
    const parsed = locationsSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Square returned an invalid locations response.", {
        cause: parsed.error,
      });
    }
    return parsed.data.locations ?? [];
  }

  private async apiJson(
    path: string,
    credential: VersionedCredential,
    signal?: AbortSignal,
  ): Promise<{ value: unknown }> {
    return requestJson<unknown>(
      this.fetcher,
      new URL(path, API_ORIGIN).toString(),
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${credential.secret.accessToken}`,
          accept: "application/json",
          "square-version": SQUARE_API_VERSION,
        },
        signal,
      },
      this.config.retry,
    );
  }

  private async postToken(
    body: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
    failureMessage: string,
  ): Promise<z.infer<typeof tokenSchema>> {
    const { value } = await requestJson<unknown>(
      this.fetcher,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "square-version": SQUARE_API_VERSION,
        },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          ...body,
        }),
        signal,
      },
      this.config.retry,
    );
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("OAUTH_EXCHANGE_FAILED", failureMessage, { cause: parsed.error });
    }
    return parsed.data;
  }

  private async readCredential(context: ConnectorContext): Promise<VersionedCredential> {
    const credential = await this.config.vault.read(context.credentialRef);
    if (credential.secret.provider !== this.id) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Square.");
    }
    return credential;
  }

  private async validCredential(context: ConnectorContext): Promise<VersionedCredential> {
    const credential = await this.readCredential(context);
    return credentialExpiresSoon(credential.secret, this.config.now?.() ?? Date.now())
      ? this.refreshCredential(credential, context.abortSignal)
      : credential;
  }

  private async refreshCredential(
    current: VersionedCredential,
    signal?: AbortSignal,
  ): Promise<VersionedCredential> {
    const existing = this.refreshes.get(current.credentialRef);
    if (existing) return existing;
    const promise = this.config.vault.withRefreshLease(
      current.credentialRef,
      async (lease) => {
        const latest = await this.config.vault.read(current.credentialRef);
        if (latest.secret.provider !== this.id) {
          throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Square.");
        }
        if (latest.revision !== current.revision) return latest;
        return this.performRefresh(latest, lease.abortSignal, lease.proof);
      },
      signal,
    ).finally(() => this.refreshes.delete(current.credentialRef));
    this.refreshes.set(current.credentialRef, promise);
    return promise;
  }

  private async performRefresh(
    current: VersionedCredential,
    signal?: AbortSignal,
    refreshLease?: CredentialRefreshLeaseProof,
  ): Promise<VersionedCredential> {
    if (!current.secret.refreshToken) {
      throw new ConnectorError("AUTHENTICATION_REQUIRED", "Square refresh token is missing.");
    }
    const merchantId = String(current.secret.metadata.merchantId ?? "");
    const parsed = await this.postToken({
      grant_type: "refresh_token",
      refresh_token: current.secret.refreshToken,
    }, signal, "Square returned an invalid token refresh.");
    if (merchantId && parsed.merchant_id !== merchantId) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Square changed merchant identity during token refresh.");
    }
    const scopes = splitOAuthScopes(parsed.scopes);
    const next: OAuthCredentialSecret = {
      ...current.secret,
      accessToken: parsed.access_token,
      // Square's confidential flow returns the same long-lived refresh token,
      // but it is re-read rather than assumed so a future rotation is durable.
      refreshToken: parsed.refresh_token,
      expiresAt: isoOrThrow(parsed.expires_at, "token expiry"),
      scopes: scopes.length > 0 ? scopes : current.secret.scopes,
      metadata: {
        ...current.secret.metadata,
        merchantId: parsed.merchant_id,
        refreshTokenExpiresAt: parsed.refresh_token_expires_at ?? "",
      },
    };
    try {
      signal?.throwIfAborted();
      return await this.config.vault.compareAndSwap(
        current.credentialRef,
        current.revision,
        next,
        refreshLease,
      );
    } catch (cause) {
      const latest = await this.config.vault.read(current.credentialRef);
      if (!credentialExpiresSoon(latest.secret, this.config.now?.() ?? Date.now())) return latest;
      throw new ConnectorError("CREDENTIAL_CONFLICT", "Concurrent Square token rotation failed.", {
        cause,
        retryable: true,
      });
    }
  }
}

export { squareManifest } from "./manifest";
