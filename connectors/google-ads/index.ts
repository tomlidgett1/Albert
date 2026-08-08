import { z } from "zod";

import {
  AuthorizationOnlyConnectorPack,
  ConnectorError,
  ConnectorHttpError,
  requestJson,
  splitOAuthScopes,
  type AuthorizationCodeExchange,
  type AuthorizationRedirect,
  type AuthorizationRequest,
  type ConnectionDiscovery,
  type ConnectionHealth,
  type ConnectorContext,
  type FetchLike,
  type HttpRetryOptions,
  type OAuthConnectorPack,
  type OAuthCredentialSecret,
  type OAuthExchangeResult,
  type VersionedCredential,
  type WorkerCredentialVault,
} from "../../packages/connector-sdk/src";
import {
  GOOGLE_ADS_ALLOWED_SCOPES,
  GOOGLE_ADS_DEFAULT_SCOPES,
  googleAdsManifest,
} from "./manifest";
import { buildGoogleAdsAuthorizationUrl } from "./oauth-public";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().positive(),
  token_type: z.string().default("Bearer"),
  scope: z.string().optional(),
  // Present only on the first consent, or whenever prompt=consent is sent.
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().optional(),
}).passthrough();

const userInfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  hd: z.string().nullable().optional(),
}).passthrough();

export type GoogleAdsConnectorConfig = Readonly<{
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

/**
 * Authorization-only Google Ads pack. Reading campaign data additionally
 * requires an approved developer token, which this pack deliberately does not
 * hold, so a connection grants identity and renewal only.
 */
export class GoogleAdsConnector extends AuthorizationOnlyConnectorPack implements OAuthConnectorPack {
  readonly id = "google-ads" as const;
  readonly manifest = googleAdsManifest;

  protected readonly vault: WorkerCredentialVault;
  protected readonly clock: () => number;
  private readonly config: GoogleAdsConnectorConfig;
  private readonly fetcher: FetchLike;

  constructor(config: GoogleAdsConnectorConfig) {
    super();
    this.config = {
      ...config,
      clientId: required(config.clientId, "Google Ads client ID"),
      clientSecret: required(config.clientSecret, "Google Ads client secret"),
      redirectUri: required(config.redirectUri, "Google Ads redirect URI"),
    };
    this.vault = config.vault;
    this.clock = config.now ?? (() => Date.now());
    this.fetcher = config.fetcher ?? fetch;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    const scopes = request.scopes.length > 0 ? request.scopes : GOOGLE_ADS_DEFAULT_SCOPES;
    const unsupported = scopes.filter(
      (scope) => !GOOGLE_ADS_ALLOWED_SCOPES.includes(scope as (typeof GOOGLE_ADS_ALLOWED_SCOPES)[number]),
    );
    if (unsupported.length > 0) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        `Unsupported Google Ads scope requested: ${unsupported.join(", ")}.`,
      );
    }
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Google Ads redirect URI does not match configured OAuth client.");
    }
    return {
      url: buildGoogleAdsAuthorizationUrl({
        clientId: this.config.clientId,
        state: request.state,
        redirectUri: request.redirectUri,
        scopes,
      }),
      expiresAt: new Date(this.clock() + 10 * 60_000).toISOString(),
    };
  }

  async exchange_authorization_code(request: AuthorizationCodeExchange): Promise<OAuthExchangeResult> {
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Google Ads redirect URI does not match configured OAuth client.");
    }
    const parsed = await this.postToken({
      grant_type: "authorization_code",
      code: required(request.code, "Google Ads authorization code"),
      redirect_uri: request.redirectUri,
    }, request.abortSignal, "Google returned an invalid OAuth token response.");
    if (!parsed.refresh_token) {
      // Without a refresh token the connection dies in an hour and cannot be
      // renewed unattended. Fail the authorization rather than storing it.
      throw new ConnectorError(
        "OAUTH_EXCHANGE_FAILED",
        "Google did not return a refresh token; the grant cannot be renewed unattended.",
      );
    }
    const scopes = splitOAuthScopes(parsed.scope);
    const stored = await this.vault.create({
      provider: this.id,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      tokenType: "Bearer",
      expiresAt: new Date(this.clock() + parsed.expires_in * 1_000).toISOString(),
      scopes: scopes.length > 0 ? scopes : GOOGLE_ADS_DEFAULT_SCOPES,
      metadata: {},
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

  async discover_accounts(context: ConnectorContext): Promise<readonly ConnectionDiscovery[]> {
    return [await this.discover_account(context)];
  }

  async discover_account(context: ConnectorContext): Promise<ConnectionDiscovery> {
    const credential = await this.validCredential(context);
    const { value } = await requestJson<unknown>(
      this.fetcher,
      USERINFO_ENDPOINT,
      {
        method: "GET",
        headers: { authorization: `Bearer ${credential.secret.accessToken}`, accept: "application/json" },
        signal: context.abortSignal,
      },
      this.config.retry,
    );
    const parsed = userInfoSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Google returned an invalid userinfo response.", {
        cause: parsed.error,
      });
    }
    const info = parsed.data;
    return {
      // Enumerating accessible Google Ads customers requires the developer
      // token this pack does not hold, so identity is the authorising account.
      externalAccountId: info.sub,
      displayName: info.email?.trim() || info.name?.trim() || `Google account ${info.sub}`,
      metadata: {
        subject: info.sub,
        email: info.email ?? null,
        hostedDomain: info.hd ?? null,
      },
    };
  }

  async select_account(context: ConnectorContext, externalAccountId: string): Promise<ConnectionDiscovery> {
    const account = await this.discover_account(context);
    if (externalAccountId !== account.externalAccountId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "A Google Ads grant belongs to exactly one Google account.");
    }
    return account;
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    const credential = await this.readCredential(context);
    try {
      await requestJson<unknown>(
        this.fetcher,
        REVOCATION_ENDPOINT,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          // Revoking the refresh token invalidates the whole grant, which is
          // what disconnect means; revoking only the access token would leave
          // a renewable grant behind.
          body: new URLSearchParams({ token: credential.secret.refreshToken ?? credential.secret.accessToken }),
          signal: context.abortSignal,
        },
        this.config.retry,
      );
    } finally {
      await this.vault.destroy(context.credentialRef);
    }
  }

  protected async renewCredential(
    current: VersionedCredential,
    signal?: AbortSignal,
  ): Promise<OAuthCredentialSecret> {
    if (!current.secret.refreshToken) {
      throw new ConnectorError("AUTHENTICATION_REQUIRED", "Google Ads refresh token is missing.");
    }
    const parsed = await this.postToken({
      grant_type: "refresh_token",
      refresh_token: current.secret.refreshToken,
    }, signal, "Google returned an invalid token refresh.");
    const scopes = splitOAuthScopes(parsed.scope);
    return {
      ...current.secret,
      accessToken: parsed.access_token,
      // Google omits refresh_token on refresh; retaining the existing one is
      // correct, and adopting a rotated value stays durable if that changes.
      refreshToken: parsed.refresh_token ?? current.secret.refreshToken,
      expiresAt: new Date(this.clock() + parsed.expires_in * 1_000).toISOString(),
      scopes: scopes.length > 0 ? scopes : current.secret.scopes,
    };
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
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
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
}

export { googleAdsManifest } from "./manifest";
