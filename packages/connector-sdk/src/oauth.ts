import type {
  ConnectionDiscovery,
  ConnectorContext,
  ConnectorPack,
} from "./index.js";

export type OAuthCredentialSecret = Readonly<{
  provider: string;
  accessToken: string;
  refreshToken?: string;
  /**
   * `StripeAccount` marks a credential whose `accessToken` is an account
   * identifier rather than a bearer token: Stripe deprecated per-connection
   * tokens in favour of the platform key plus a `Stripe-Account` header. It is
   * distinguished from `Bearer` so no caller can put it in an Authorization
   * header and expect it to authenticate.
   */
  tokenType: "Bearer" | "StripeAccount";
  expiresAt: string;
  scopes: readonly string[];
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type VersionedCredential = Readonly<{
  credentialRef: string;
  revision: string;
  secret: OAuthCredentialSecret;
}>;

/**
 * Opaque fencing evidence issued by the control-plane refresh lease store.
 * Vault implementations must validate it in the same transaction as a token
 * rotation so a worker that has lost its lease cannot publish stale tokens.
 */
export type CredentialRefreshLeaseProof = Readonly<{
  leaseId: string;
  fencingToken: string;
}>;

export type CredentialRefreshLeaseContext = Readonly<{
  abortSignal: AbortSignal;
  proof: CredentialRefreshLeaseProof;
}>;

/**
 * Worker-only boundary around the encrypted token store. Implementations must
 * envelope-encrypt at rest and use compare-and-swap for rotating refresh
 * tokens. Browser and model processes must never receive this interface.
 */
export interface WorkerCredentialVault {
  create(secret: OAuthCredentialSecret): Promise<VersionedCredential>;
  read(credentialRef: string): Promise<VersionedCredential>;
  compareAndSwap(
    credentialRef: string,
    expectedRevision: string,
    secret: OAuthCredentialSecret,
    refreshLease?: CredentialRefreshLeaseProof,
  ): Promise<VersionedCredential>;
  withRefreshLease<T>(
    credentialRef: string,
    operation: (lease: CredentialRefreshLeaseContext) => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T>;
  destroy(credentialRef: string): Promise<void>;
}

export type AuthorizationCodeExchange = Readonly<{
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  /**
   * Lightspeed X-Series returns the retailer's host prefix only on the OAuth
   * callback. This is an identity component, never an arbitrary URL: the
   * connector validates it and constructs the fixed retail.lightspeed.app
   * host before exchanging the code.
   */
  domainPrefix?: string;
  /** Vendor-reported callback scope; the token response remains authoritative. */
  returnedScope?: string;
  abortSignal?: AbortSignal;
}>;

export type OAuthExchangeResult = Readonly<{
  credentialRef: string;
  expiresAt: string;
  scopes: readonly string[];
}>;

export interface OAuthConnectorPack extends ConnectorPack {
  exchange_authorization_code(
    request: AuthorizationCodeExchange,
  ): Promise<OAuthExchangeResult>;
  discover_accounts(context: ConnectorContext): Promise<readonly ConnectionDiscovery[]>;
  select_account(
    context: ConnectorContext,
    externalAccountId: string,
  ): Promise<ConnectionDiscovery>;
  revoke_credentials(context: ConnectorContext): Promise<void>;
}

export function credentialExpiresSoon(
  secret: OAuthCredentialSecret,
  nowMs = Date.now(),
  skewMs = 60_000,
): boolean {
  const expiry = Date.parse(secret.expiresAt);
  return !Number.isFinite(expiry) || expiry <= nowMs + skewMs;
}

export function splitOAuthScopes(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") return [];
  return value.split(/[ +]/u).map((scope) => scope.trim()).filter(Boolean);
}
