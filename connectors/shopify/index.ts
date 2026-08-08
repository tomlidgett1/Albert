import { createHmac, timingSafeEqual } from "node:crypto";

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
  SHOPIFY_ALLOWED_SCOPES,
  SHOPIFY_API_VERSION,
  SHOPIFY_DEFAULT_SCOPES,
  normalizeShopifyShopDomain,
  shopifyManifest,
} from "./manifest";
import { buildShopifyAuthorizationUrl } from "./oauth-public";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().optional(),
  // Present only for expiring offline tokens, which Albert does not request.
  expires_in: z.coerce.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
}).passthrough();

const shopSchema = z.object({
  shop: z.object({
    id: z.union([z.string(), z.number()]),
    name: z.string().nullable().optional(),
    myshopify_domain: z.string().min(1),
    email: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    country_code: z.string().nullable().optional(),
    plan_name: z.string().nullable().optional(),
  }).passthrough(),
}).passthrough();

export type ShopifyConnectorConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Bound at session creation; a Shopify grant is scoped to one shop. */
  shopDomain: string;
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
 * Verifies Shopify's callback HMAC over the sorted query string.
 *
 * Shopify is the only connector whose redirect carries a vendor signature, and
 * it matters here more than elsewhere: the authorize host is merchant-supplied,
 * so the signature is what proves the callback really came from Shopify.
 */
export function verifyShopifyCallbackHmac(
  query: URLSearchParams,
  clientSecret: string,
): boolean {
  const received = query.get("hmac");
  if (!received || !/^[0-9a-f]{64}$/u.test(received)) return false;
  const message = [...query.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .map(([key, value]) => [key, value] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = createHmac("sha256", clientSecret).update(message, "utf8").digest();
  const actual = Buffer.from(received, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Authorization-only Shopify pack over the offline access-token grant. */
export class ShopifyConnector extends AuthorizationOnlyConnectorPack implements OAuthConnectorPack {
  readonly id = "shopify" as const;
  readonly manifest = shopifyManifest;

  protected readonly vault: WorkerCredentialVault;
  protected readonly clock: () => number;
  private readonly config: ShopifyConnectorConfig;
  private readonly fetcher: FetchLike;
  private readonly shopDomain: string;

  constructor(config: ShopifyConnectorConfig) {
    super();
    this.config = {
      ...config,
      clientId: required(config.clientId, "Shopify client ID"),
      clientSecret: required(config.clientSecret, "Shopify client secret"),
      redirectUri: required(config.redirectUri, "Shopify redirect URI"),
    };
    this.shopDomain = normalizeShopifyShopDomain(required(config.shopDomain, "Shopify shop domain"));
    this.vault = config.vault;
    this.clock = config.now ?? (() => Date.now());
    this.fetcher = config.fetcher ?? fetch;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    const scopes = request.scopes.length > 0 ? request.scopes : SHOPIFY_DEFAULT_SCOPES;
    const unsupported = scopes.filter(
      (scope) => !SHOPIFY_ALLOWED_SCOPES.includes(scope as (typeof SHOPIFY_ALLOWED_SCOPES)[number]),
    );
    if (unsupported.length > 0) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        `Unsupported Shopify access scope requested: ${unsupported.join(", ")}.`,
      );
    }
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Shopify redirect URI does not match configured OAuth client.");
    }
    return {
      url: buildShopifyAuthorizationUrl({
        clientId: this.config.clientId,
        state: request.state,
        redirectUri: request.redirectUri,
        shopDomain: this.shopDomain,
        scopes,
      }),
      expiresAt: new Date(this.clock() + 10 * 60_000).toISOString(),
    };
  }

  async exchange_authorization_code(request: AuthorizationCodeExchange): Promise<OAuthExchangeResult> {
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Shopify redirect URI does not match configured OAuth client.");
    }
    const { value } = await requestJson<unknown>(
      this.fetcher,
      `https://${this.shopDomain}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code: required(request.code, "Shopify authorization code"),
        }),
        signal: request.abortSignal,
      },
      this.config.retry,
    );
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("OAUTH_EXCHANGE_FAILED", "Shopify returned an invalid OAuth token response.", {
        cause: parsed.error,
      });
    }
    const scopes = splitOAuthScopes(parsed.data.scope?.replaceAll(",", " "));
    const stored = await this.vault.create({
      provider: this.id,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      tokenType: "Bearer",
      expiresAt: this.expiryFrom(parsed.data.expires_in),
      scopes: scopes.length > 0 ? scopes : SHOPIFY_DEFAULT_SCOPES,
      metadata: { shopDomain: this.shopDomain },
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
    const shop = normalizeShopifyShopDomain(String(credential.secret.metadata.shopDomain ?? this.shopDomain));
    const { value } = await requestJson<unknown>(
      this.fetcher,
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
      {
        method: "GET",
        headers: {
          // Shopify authenticates with its own header, not Authorization.
          "x-shopify-access-token": credential.secret.accessToken,
          accept: "application/json",
        },
        signal: context.abortSignal,
      },
      this.config.retry,
    );
    const parsed = shopSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Shopify returned an invalid shop response.", {
        cause: parsed.error,
      });
    }
    const details = parsed.data.shop;
    const resolved = normalizeShopifyShopDomain(details.myshopify_domain);
    if (resolved !== shop) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Shopify returned a shop that does not match the grant.");
    }
    return {
      externalAccountId: resolved,
      displayName: details.name?.trim() || resolved,
      metadata: {
        shopDomain: resolved,
        shopId: String(details.id),
        country: details.country_code ?? null,
        currency: details.currency ?? null,
        planName: details.plan_name ?? null,
      },
    };
  }

  async select_account(context: ConnectorContext, externalAccountId: string): Promise<ConnectionDiscovery> {
    const account = await this.discover_account(context);
    if (normalizeShopifyShopDomain(externalAccountId) !== account.externalAccountId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "A Shopify grant belongs to exactly one shop.");
    }
    return account;
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    // Shopify documents no OAuth revocation endpoint; uninstalling the app is
    // the merchant-side action. Destroying the token prevents further use.
    await this.vault.destroy(context.credentialRef);
  }

  protected async renewCredential(
    current: VersionedCredential,
    signal?: AbortSignal,
  ): Promise<OAuthCredentialSecret> {
    // Albert requests non-expiring offline tokens, so there is nothing to
    // refresh. Reaching here means the token really did expire, which only
    // happens for expiring grants this pack never asks for.
    void signal;
    throw new ConnectorError(
      "AUTHENTICATION_REQUIRED",
      "The Shopify offline token is no longer valid; the merchant must reconnect the shop.",
    );
  }

  private expiryFrom(expiresIn: number | undefined): string {
    // Non-expiring offline tokens carry no expiry. The vault requires one, so
    // record a far horizon rather than a synthetic soon-to-expire value that
    // would trigger a pointless refresh the vendor cannot service.
    const seconds = expiresIn ?? 10 * 365 * 24 * 60 * 60;
    return new Date(this.clock() + seconds * 1_000).toISOString();
  }
}

export { shopifyManifest } from "./manifest";
