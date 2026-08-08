import { z } from "zod";

import {
  AuthorizationOnlyConnectorPack,
  ConnectorError,
  ConnectorHttpError,
  requestJson,
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
  META_ADS_ALLOWED_SCOPES,
  META_ADS_DEFAULT_SCOPES,
  META_GRAPH_VERSION,
  metaAdsManifest,
} from "./manifest";
import { buildMetaAdsAuthorizationUrl } from "./oauth-public";

const GRAPH_ORIGIN = "https://graph.facebook.com";
const TOKEN_ENDPOINT = `${GRAPH_ORIGIN}/${META_GRAPH_VERSION}/oauth/access_token`;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("bearer"),
  // Absent on some short-lived responses; the long-lived exchange always sets it.
  expires_in: z.coerce.number().positive().optional(),
}).passthrough();

const meSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
}).passthrough();

const adAccountsSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    account_id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  }).passthrough()).optional(),
}).passthrough();

const permissionsSchema = z.object({
  data: z.array(z.object({
    permission: z.string().min(1),
    status: z.string().min(1),
  }).passthrough()).optional(),
}).passthrough();

export type MetaAdsConnectorConfig = Readonly<{
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
 * Authorization-only Meta Ads pack.
 *
 * Meta issues no refresh token. Renewal re-exchanges an unexpired long-lived
 * token for a fresh 60-day one, so `renewCredential` fails closed once the
 * current token has already lapsed rather than pretending a silent renewal is
 * possible.
 */
export class MetaAdsConnector extends AuthorizationOnlyConnectorPack implements OAuthConnectorPack {
  readonly id = "meta-ads" as const;
  readonly manifest = metaAdsManifest;

  protected readonly vault: WorkerCredentialVault;
  protected readonly clock: () => number;
  private readonly config: MetaAdsConnectorConfig;
  private readonly fetcher: FetchLike;

  constructor(config: MetaAdsConnectorConfig) {
    super();
    this.config = {
      ...config,
      clientId: required(config.clientId, "Meta app ID"),
      clientSecret: required(config.clientSecret, "Meta app secret"),
      redirectUri: required(config.redirectUri, "Meta redirect URI"),
    };
    this.vault = config.vault;
    this.clock = config.now ?? (() => Date.now());
    this.fetcher = config.fetcher ?? fetch;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    const scopes = request.scopes.length > 0 ? request.scopes : META_ADS_DEFAULT_SCOPES;
    const unsupported = scopes.filter(
      (scope) => !META_ADS_ALLOWED_SCOPES.includes(scope as (typeof META_ADS_ALLOWED_SCOPES)[number]),
    );
    if (unsupported.length > 0) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        `Unsupported Meta Ads permission requested: ${unsupported.join(", ")}.`,
      );
    }
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Meta redirect URI does not match configured OAuth client.");
    }
    return {
      url: buildMetaAdsAuthorizationUrl({
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
      throw new ConnectorError("CONFIGURATION_INVALID", "Meta redirect URI does not match configured OAuth client.");
    }
    const shortLived = await this.getToken({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: request.redirectUri,
      code: required(request.code, "Meta authorization code"),
    }, request.abortSignal, "Meta returned an invalid OAuth token response.");
    // Immediately upgrade: the code-exchange token lives only hours, and a
    // stored short-lived token would strand the connection before first use.
    const longLived = await this.exchangeForLongLived(shortLived.access_token, request.abortSignal);
    const granted = await this.grantedPermissions(longLived.access_token, request.abortSignal);
    const stored = await this.vault.create({
      provider: this.id,
      accessToken: longLived.access_token,
      tokenType: "Bearer",
      expiresAt: this.expiryFrom(longLived.expires_in),
      scopes: granted.length > 0 ? granted : [...META_ADS_DEFAULT_SCOPES],
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
    const token = credential.secret.accessToken;
    const { value } = await this.graphGet("/me", { fields: "id,name" }, token, context.abortSignal);
    const parsed = meSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Meta returned an invalid user response.", {
        cause: parsed.error,
      });
    }
    const accounts = await this.adAccounts(token, context.abortSignal);
    return {
      externalAccountId: parsed.data.id,
      displayName: parsed.data.name?.trim() || `Meta user ${parsed.data.id}`,
      metadata: {
        userId: parsed.data.id,
        adAccountCount: accounts.length,
        // Identity evidence only; no ad account is promoted to a canonical
        // entity because no stream extracts one.
        adAccountIds: accounts.map((account) => account.id).join(","),
      },
    };
  }

  async select_account(context: ConnectorContext, externalAccountId: string): Promise<ConnectionDiscovery> {
    const account = await this.discover_account(context);
    if (externalAccountId !== account.externalAccountId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "A Meta grant belongs to exactly one Meta user.");
    }
    return account;
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    const credential = await this.readCredential(context);
    const userId = String(credential.secret.metadata.userId ?? "me");
    try {
      await requestJson<unknown>(
        this.fetcher,
        `${GRAPH_ORIGIN}/${META_GRAPH_VERSION}/${encodeURIComponent(userId)}/permissions`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${credential.secret.accessToken}`,
            accept: "application/json",
          },
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
    // Meta has no refresh grant: renewal re-exchanges a token that is still
    // valid. Once it has expired there is nothing to exchange, so surface the
    // re-authorization requirement instead of retrying a doomed call.
    if (Date.parse(current.secret.expiresAt) <= this.clock()) {
      throw new ConnectorError(
        "AUTHENTICATION_REQUIRED",
        "The Meta long-lived token has expired and Meta issues no refresh token; the account must re-authorize.",
      );
    }
    const refreshed = await this.exchangeForLongLived(current.secret.accessToken, signal);
    return {
      ...current.secret,
      accessToken: refreshed.access_token,
      expiresAt: this.expiryFrom(refreshed.expires_in),
    };
  }

  private expiryFrom(expiresIn: number | undefined): string {
    // Meta documents ~60 days but may omit expires_in. Assuming "never" would
    // let a dead token look healthy, so fall back to the documented lifetime.
    const seconds = expiresIn ?? 60 * 24 * 60 * 60;
    return new Date(this.clock() + seconds * 1_000).toISOString();
  }

  private async exchangeForLongLived(
    token: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof tokenSchema>> {
    return this.getToken({
      grant_type: "fb_exchange_token",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      fb_exchange_token: token,
    }, signal, "Meta returned an invalid long-lived token exchange.");
  }

  private async grantedPermissions(token: string, signal?: AbortSignal): Promise<readonly string[]> {
    const { value } = await this.graphGet("/me/permissions", {}, token, signal);
    const parsed = permissionsSchema.safeParse(value);
    if (!parsed.success) return [];
    return (parsed.data.data ?? [])
      .filter((entry) => entry.status === "granted")
      .map((entry) => entry.permission);
  }

  private async adAccounts(
    token: string,
    signal?: AbortSignal,
  ): Promise<readonly Readonly<{ id: string }>[]> {
    try {
      const { value } = await this.graphGet("/me/adaccounts", { fields: "id,account_id,name" }, token, signal);
      const parsed = adAccountsSchema.safeParse(value);
      return parsed.success ? parsed.data.data ?? [] : [];
    } catch (error) {
      // Without Advanced Access Meta returns 403 here. That is a permission
      // state, not a broken connection, so identity still resolves.
      if (error instanceof ConnectorHttpError && error.status === 403) return [];
      throw error;
    }
  }

  private async graphGet(
    path: string,
    query: Readonly<Record<string, string>>,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ value: unknown }> {
    const url = new URL(`${GRAPH_ORIGIN}/${META_GRAPH_VERSION}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return requestJson<unknown>(
      this.fetcher,
      url.toString(),
      {
        method: "GET",
        // Bearer keeps the token out of the URL, so it cannot leak into logs.
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal,
      },
      this.config.retry,
    );
  }

  private async getToken(
    query: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
    failureMessage: string,
  ): Promise<z.infer<typeof tokenSchema>> {
    const url = new URL(TOKEN_ENDPOINT);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const { value } = await requestJson<unknown>(
      this.fetcher,
      url.toString(),
      { method: "GET", headers: { accept: "application/json" }, signal },
      this.config.retry,
    );
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("OAUTH_EXCHANGE_FAILED", failureMessage, { cause: parsed.error });
    }
    return parsed.data;
  }
}

export { metaAdsManifest } from "./manifest";
