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
  STRIPE_ALLOWED_SCOPES,
  STRIPE_DEFAULT_SCOPES,
  stripeManifest,
} from "./manifest";
import { buildStripeAuthorizationUrl } from "./oauth-public";

const TOKEN_ENDPOINT = "https://connect.stripe.com/oauth/token";
const DEAUTHORIZE_ENDPOINT = "https://connect.stripe.com/oauth/deauthorize";
const API_ORIGIN = "https://api.stripe.com";

/**
 * Stripe marks `access_token` and `refresh_token` deprecated for Albert's own
 * API calls (`Stripe-Account` + the platform secret). Fivetran's native Stripe
 * connector still needs that secret or Restricted key, so the exchange keeps
 * it when present and fails closed when Stripe omits it.
 */
export const STRIPE_FIVETRAN_SECRET = /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]+$/u;
export const STRIPE_LIVE_FIVETRAN_SECRET = /^(?:sk|rk)_live_[A-Za-z0-9_]+$/u;

export function isStripeFivetranSecret(value: string): boolean {
  return STRIPE_FIVETRAN_SECRET.test(value.trim());
}

/** Fivetran's `stripe` connector is live mode. Test keys belong on `stripe_test_mode`, which Albert does not create. */
export function isStripeLiveFivetranSecret(value: string): boolean {
  return STRIPE_LIVE_FIVETRAN_SECRET.test(value.trim());
}

const tokenSchema = z.object({
  stripe_user_id: z.string().min(1),
  scope: z.string().optional(),
  livemode: z.boolean().optional(),
  token_type: z.string().optional(),
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
}).passthrough();

const accountSchema = z.object({
  id: z.string().min(1),
  business_profile: z.object({
    name: z.string().nullable().optional(),
  }).passthrough().nullable().optional(),
  email: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  default_currency: z.string().nullable().optional(),
  charges_enabled: z.boolean().optional(),
}).passthrough();

export type StripeConnectorConfig = Readonly<{
  clientId: string;
  /** The platform's own Stripe secret key. Never a per-connection token. */
  secretKey: string;
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
 * Authorization-only Stripe Connect pack.
 *
 * Stripe's per-connection tokens are deprecated: platform requests are made
 * with the platform secret key plus a `Stripe-Account` header. The connection
 * therefore stores the connected account id as its credential, and there is
 * nothing to refresh — `renewCredential` extends the recorded expiry after
 * re-verifying the account is still reachable, rather than exchanging a token
 * that Stripe no longer honours.
 */
export class StripeConnector extends AuthorizationOnlyConnectorPack implements OAuthConnectorPack {
  readonly id = "stripe" as const;
  readonly manifest = stripeManifest;

  protected readonly vault: WorkerCredentialVault;
  protected readonly clock: () => number;
  private readonly config: StripeConnectorConfig;
  private readonly fetcher: FetchLike;

  constructor(config: StripeConnectorConfig) {
    super();
    this.config = {
      ...config,
      clientId: required(config.clientId, "Stripe Connect client ID"),
      secretKey: required(config.secretKey, "Stripe secret key"),
      redirectUri: required(config.redirectUri, "Stripe redirect URI"),
    };
    this.vault = config.vault;
    this.clock = config.now ?? (() => Date.now());
    this.fetcher = config.fetcher ?? fetch;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    const scopes = request.scopes.length > 0 ? request.scopes : STRIPE_DEFAULT_SCOPES;
    const unsupported = scopes.filter(
      (scope) => !STRIPE_ALLOWED_SCOPES.includes(scope as (typeof STRIPE_ALLOWED_SCOPES)[number]),
    );
    if (unsupported.length > 0) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        `Unsupported Stripe scope requested: ${unsupported.join(", ")}.`,
      );
    }
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Stripe redirect URI does not match configured OAuth client.");
    }
    return {
      url: buildStripeAuthorizationUrl({
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
      throw new ConnectorError("CONFIGURATION_INVALID", "Stripe redirect URI does not match configured OAuth client.");
    }
    // Stripe authorization codes are single use and consuming one twice
    // revokes the connection, so this exchange must never be retried.
    const parsed = await this.postToken({
      grant_type: "authorization_code",
      code: required(request.code, "Stripe authorization code"),
    }, request.abortSignal, "Stripe returned an invalid OAuth token response.");
    const scopes = splitOAuthScopes(parsed.scope);
    const expiresAt = this.nextVerification();
    const fivetranSecret = parsed.access_token?.trim() ?? "";
    if (!isStripeFivetranSecret(fivetranSecret)) {
      throw new ConnectorError(
        "OAUTH_EXCHANGE_FAILED",
        "Stripe Connect did not return a secret or Restricted key. Fivetran needs that key to land the official Stripe ERD.",
      );
    }
    if (!isStripeLiveFivetranSecret(fivetranSecret)) {
      throw new ConnectorError(
        "OAUTH_EXCHANGE_FAILED",
        "Stripe Connect returned a test-mode key. Albert's Fivetran Stripe connector is live mode only.",
      );
    }
    const stored = await this.vault.create({
      provider: this.id,
      // The connected account id stays the durable Albert credential. The
      // Connect secret is kept only so Fivetran can authenticate as that
      // account; Albert never calls the Stripe Admin API with it.
      accessToken: parsed.stripe_user_id,
      tokenType: "StripeAccount",
      expiresAt,
      scopes: scopes.length > 0 ? scopes : STRIPE_DEFAULT_SCOPES,
      metadata: {
        stripeUserId: parsed.stripe_user_id,
        livemode: parsed.livemode ?? null,
        stripeAccessToken: fivetranSecret,
        ...(parsed.refresh_token ? { stripeRefreshToken: parsed.refresh_token } : {}),
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

  async discover_accounts(context: ConnectorContext): Promise<readonly ConnectionDiscovery[]> {
    return [await this.discover_account(context)];
  }

  async discover_account(context: ConnectorContext): Promise<ConnectionDiscovery> {
    const credential = await this.validCredential(context);
    const accountId = this.accountId(credential);
    const { value } = await requestJson<unknown>(
      this.fetcher,
      `${API_ORIGIN}/v1/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.config.secretKey}`,
          accept: "application/json",
        },
        signal: context.abortSignal,
      },
      this.config.retry,
    );
    const parsed = accountSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Stripe returned an invalid account response.", {
        cause: parsed.error,
      });
    }
    const account = parsed.data;
    if (account.id !== accountId) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Stripe returned an account that does not match the grant.");
    }
    return {
      externalAccountId: account.id,
      displayName: account.business_profile?.name?.trim() || account.email?.trim() || `Stripe account ${account.id}`,
      metadata: {
        stripeUserId: account.id,
        country: account.country ?? null,
        defaultCurrency: account.default_currency ?? null,
        chargesEnabled: account.charges_enabled ?? null,
      },
    };
  }

  async select_account(context: ConnectorContext, externalAccountId: string): Promise<ConnectionDiscovery> {
    const account = await this.discover_account(context);
    if (externalAccountId !== account.externalAccountId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "A Stripe grant belongs to exactly one connected account.");
    }
    return account;
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    const credential = await this.readCredential(context);
    const accountId = this.accountId(credential);
    try {
      await requestJson<unknown>(
        this.fetcher,
        DEAUTHORIZE_ENDPOINT,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.secretKey}`,
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            client_id: this.config.clientId,
            stripe_user_id: accountId,
          }),
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
    // There is no token to exchange. Re-verify that the platform can still act
    // for the account, then extend the verification horizon. A revoked
    // connection surfaces as an HTTP error here rather than silently renewing.
    const accountId = this.accountId(current);
    await requestJson<unknown>(
      this.fetcher,
      `${API_ORIGIN}/v1/accounts/${encodeURIComponent(accountId)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${this.config.secretKey}`, accept: "application/json" },
        signal,
      },
      this.config.retry,
    );
    return { ...current.secret, expiresAt: this.nextVerification() };
  }

  /**
   * Stripe grants do not expire, but the vault requires an expiry. Recording a
   * bounded horizon turns renewal into a periodic liveness check instead of
   * letting a revoked connection look healthy forever.
   */
  private nextVerification(): string {
    return new Date(this.clock() + 24 * 60 * 60 * 1_000).toISOString();
  }

  private accountId(credential: VersionedCredential): string {
    const accountId = String(credential.secret.metadata.stripeUserId ?? credential.secret.accessToken ?? "");
    if (!accountId.startsWith("acct_")) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Stripe credential is missing its connected account id.");
    }
    return accountId;
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
          // Stripe authenticates the token call with the platform secret key.
          authorization: `Bearer ${this.config.secretKey}`,
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

export { stripeManifest } from "./manifest";
