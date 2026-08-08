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
  MOMENCE_ALLOWED_SCOPES,
  MOMENCE_DEFAULT_SCOPES,
  momenceManifest,
} from "./manifest";
import { buildMomenceAuthorizationUrl } from "./oauth-public";

const API_ORIGIN = "https://api.momence.com";
const TOKEN_ENDPOINT = `${API_ORIGIN}/api/v2/auth/token`;
const ME_ENDPOINT = `${API_ORIGIN}/api/v2/auth/me`;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("Bearer"),
  expires_in: z.coerce.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough();

/**
 * Momence's identity payload is not pinned to a single documented shape, so
 * every field is optional and the host id is resolved from the documented
 * alternatives rather than assuming one.
 */
const meSchema = z.object({
  id: z.union([z.string(), z.number()]).nullable().optional(),
  hostId: z.union([z.string(), z.number()]).nullable().optional(),
  host: z.object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    name: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
}).passthrough();

export type MomenceConnectorConfig = Readonly<{
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

function identityValue(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

/** Authorization-only Momence pack over the documented authorization-code flow. */
export class MomenceConnector extends AuthorizationOnlyConnectorPack implements OAuthConnectorPack {
  readonly id = "momence" as const;
  readonly manifest = momenceManifest;

  protected readonly vault: WorkerCredentialVault;
  protected readonly clock: () => number;
  private readonly config: MomenceConnectorConfig;
  private readonly fetcher: FetchLike;

  constructor(config: MomenceConnectorConfig) {
    super();
    this.config = {
      ...config,
      clientId: required(config.clientId, "Momence client ID"),
      clientSecret: required(config.clientSecret, "Momence client secret"),
      redirectUri: required(config.redirectUri, "Momence redirect URI"),
    };
    this.vault = config.vault;
    this.clock = config.now ?? (() => Date.now());
    this.fetcher = config.fetcher ?? fetch;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    const scopes = request.scopes.length > 0 ? request.scopes : MOMENCE_DEFAULT_SCOPES;
    const unsupported = scopes.filter(
      (scope) => !MOMENCE_ALLOWED_SCOPES.includes(scope as (typeof MOMENCE_ALLOWED_SCOPES)[number]),
    );
    if (unsupported.length > 0) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        `Unsupported Momence scope requested: ${unsupported.join(", ")}.`,
      );
    }
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Momence redirect URI does not match configured OAuth client.");
    }
    return {
      url: buildMomenceAuthorizationUrl({
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
      throw new ConnectorError("CONFIGURATION_INVALID", "Momence redirect URI does not match configured OAuth client.");
    }
    const parsed = await this.postToken({
      grant_type: "authorization_code",
      code: required(request.code, "Momence authorization code"),
      redirect_uri: request.redirectUri,
    }, request.abortSignal, "Momence returned an invalid OAuth token response.");
    if (!parsed.refresh_token) {
      // Momence access tokens expire within hours. Without a refresh token the
      // connection cannot survive unattended, so refuse rather than store it.
      throw new ConnectorError(
        "OAUTH_EXCHANGE_FAILED",
        "Momence did not return a refresh token; a short-lived grant cannot be renewed unattended.",
      );
    }
    const scopes = splitOAuthScopes(parsed.scope);
    const stored = await this.vault.create({
      provider: this.id,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      tokenType: "Bearer",
      expiresAt: new Date(this.clock() + parsed.expires_in * 1_000).toISOString(),
      scopes: scopes.length > 0 ? scopes : MOMENCE_DEFAULT_SCOPES,
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
      ME_ENDPOINT,
      {
        method: "GET",
        headers: { authorization: `Bearer ${credential.secret.accessToken}`, accept: "application/json" },
        signal: context.abortSignal,
      },
      this.config.retry,
    );
    const parsed = meSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Momence returned an invalid identity response.", {
        cause: parsed.error,
      });
    }
    const me = parsed.data;
    const hostId = identityValue(me.hostId) ?? identityValue(me.host?.id) ?? identityValue(me.id);
    if (!hostId) {
      // An account with no resolvable host id cannot be namespaced safely, and
      // a synthetic id would collide across studios.
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Momence returned no host identity for the grant.");
    }
    return {
      externalAccountId: hostId,
      displayName: me.host?.name?.trim() || me.name?.trim() || me.email?.trim() || `Momence host ${hostId}`,
      metadata: {
        hostId,
        email: me.email ?? null,
      },
    };
  }

  async select_account(context: ConnectorContext, externalAccountId: string): Promise<ConnectionDiscovery> {
    const account = await this.discover_account(context);
    if (externalAccountId !== account.externalAccountId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "A Momence grant belongs to exactly one host.");
    }
    return account;
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    // Momence documents no OAuth revocation endpoint. Destroying the encrypted
    // credential prevents reuse; the studio removes the API client in Momence.
    await this.vault.destroy(context.credentialRef);
  }

  protected async renewCredential(
    current: VersionedCredential,
    signal?: AbortSignal,
  ): Promise<OAuthCredentialSecret> {
    if (!current.secret.refreshToken) {
      throw new ConnectorError("AUTHENTICATION_REQUIRED", "Momence refresh token is missing.");
    }
    const parsed = await this.postToken({
      grant_type: "refresh_token",
      refresh_token: current.secret.refreshToken,
    }, signal, "Momence returned an invalid token refresh.");
    const scopes = splitOAuthScopes(parsed.scope);
    return {
      ...current.secret,
      accessToken: parsed.access_token,
      // Momence rotates refresh tokens; persisting the new one is required or
      // the next renewal replays a consumed token.
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
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf8").toString("base64");
    const { value } = await requestJson<unknown>(
      this.fetcher,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          // Momence accepts credentials in the body or as Basic auth; Basic
          // keeps the secret out of the form payload.
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(body),
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

export { momenceManifest } from "./manifest";
