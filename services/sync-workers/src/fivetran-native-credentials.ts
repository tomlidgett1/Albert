import { isStripeFivetranSecret } from "../../../connectors/stripe/index.js";
import type { ConnectorContext, WorkerCredentialVault } from "../../../packages/connector-sdk/src/index.js";
import type { TransactionalPostgres } from "./database.js";

/**
 * Bridge from an Albert-native OAuth grant to a Fivetran-managed connection.
 *
 * Fivetran needs a credential Albert obtained itself: Deputy's connector takes
 * a `sub_domain` + access token in its config; Albert's own Xero SDK connector
 * asks this worker's token broker for a short-lived access token on every
 * sync. Either way the grant stays in Albert's vault (rotating refresh token,
 * lease-guarded refresh through the connector), and this bridge reads the
 * current access token — refreshing when it is close to expiry — from the
 * tenant's *native* connection for the connector key.
 *
 * Only reads/refreshes; token bodies leave the worker solely in the Fivetran
 * config PATCH (Deputy) or the broker response (Xero).
 */
export type NativeFivetranCredential = Readonly<{
  nativeConnectionId: string;
  externalAccountReference: string;
  displayName: string;
  accessToken: string;
  expiresAt: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type DeputyFivetranCredential = NativeFivetranCredential & Readonly<{ endpoint: string; subDomain: string }>;

type Refresher = Readonly<{
  refresh_credentials(context: ConnectorContext): Promise<{ credentialRef: string }>;
}>;

const DEPUTY_HOST = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:au|eu|uk|us))\.deputy\.com$/u;

export function deputySubDomain(endpoint: string): string {
  const match = DEPUTY_HOST.exec(endpoint.trim().toLowerCase());
  if (!match) throw new Error("fivetran_deputy_endpoint_invalid");
  return match[1]!;
}

/** Native grants a Fivetran path can ride: Deputy (token relay), Stripe (Restricted key), Xero and Lightspeed R-Series (SDK token broker). */
export type NativeFivetranConnectorKey = "deputy" | "xero" | "lightspeed-r" | "stripe";

/** Fivetran Stripe accepts a Restricted Key or a Connect OAuth secret key. */
export function stripeFivetranAccessToken(
  metadata: Readonly<Record<string, unknown>>,
): string {
  const candidates = [metadata.stripeAccessToken, metadata.access_token];
  for (const value of candidates) {
    if (typeof value === "string" && isStripeFivetranSecret(value)) {
      return value.trim();
    }
  }
  throw new Error("fivetran_stripe_token_missing");
}

export class NativeFivetranCredentialBridge {
  constructor(private readonly dependencies: Readonly<{
    db: TransactionalPostgres;
    vault: WorkerCredentialVault;
    connectorKey: NativeFivetranConnectorKey;
    /** Resolves the connector lazily so an unconfigured app fails at use, not boot. */
    connector: () => Refresher;
    /** Refresh when the token has less than this long left. */
    refreshWithinMs?: number;
  }>) {}

  get connectorKey(): NativeFivetranConnectorKey {
    return this.dependencies.connectorKey;
  }

  async read(input: Readonly<{
    tenantId: string;
    nativeConnectionId: string;
    signal?: AbortSignal;
  }>): Promise<NativeFivetranCredential> {
    const found = await this.dependencies.db.query<{
      connection_id: string;
      display_name: string;
      external_account_reference: string | null;
      secret_reference: string;
    }>(
      `select connection.connection_id,
              connection.display_name,
              connection.external_account_reference,
              token.secret_reference
         from control_plane.connections connection
         join lateral (
           select secret_reference
             from control_plane.oauth_token_refs
            where tenant_id = connection.tenant_id
              and connection_id = connection.connection_id
            order by updated_at desc
            limit 1
         ) token on true
        where connection.tenant_id = $1
          and connection.connection_id = $2
          and connection.connector_key = $3
          and connection.status in ('connected', 'degraded')`,
      [input.tenantId, input.nativeConnectionId, this.dependencies.connectorKey],
    );
    const row = found.rows[0];
    if (!row) throw new Error(`fivetran_${this.dependencies.connectorKey}_connection_not_found`);
    const context: ConnectorContext = {
      tenantId: input.tenantId,
      connectionId: row.connection_id,
      credentialRef: row.secret_reference,
      abortSignal: input.signal,
    };
    let credential = await this.dependencies.vault.read(row.secret_reference);
    // Xero and Lightspeed R-Series issue short-lived access tokens (30–60
    // minutes) behind rotating refresh tokens; Deputy's live for ~24 h.
    const refreshWithin = this.dependencies.refreshWithinMs
      ?? (this.dependencies.connectorKey === "deputy" ? 8 * 60 * 60_000 : 5 * 60_000);
    if (Date.parse(credential.secret.expiresAt) < Date.now() + refreshWithin) {
      const refreshed = await this.dependencies.connector().refresh_credentials(context);
      credential = await this.dependencies.vault.read(refreshed.credentialRef);
    }
    const accessToken = credential.secret.accessToken.trim();
    if (!accessToken) throw new Error(`fivetran_${this.dependencies.connectorKey}_token_missing`);
    return {
      nativeConnectionId: row.connection_id,
      externalAccountReference: row.external_account_reference ?? "",
      displayName: row.display_name,
      accessToken,
      expiresAt: credential.secret.expiresAt,
      metadata: (credential.secret.metadata ?? {}) as Record<string, unknown>,
    };
  }
}

/** Deputy flavour: derives Fivetran's `sub_domain` from the pinned install host. */
export class DeputyFivetranCredentialBridge {
  private readonly bridge: NativeFivetranCredentialBridge;

  constructor(dependencies: Readonly<{
    db: TransactionalPostgres;
    vault: WorkerCredentialVault;
    connector: () => Refresher;
    refreshWithinMs?: number;
  }>) {
    this.bridge = new NativeFivetranCredentialBridge({ ...dependencies, connectorKey: "deputy" });
  }

  async read(input: Readonly<{ tenantId: string; nativeConnectionId: string; signal?: AbortSignal }>): Promise<DeputyFivetranCredential> {
    const credential = await this.bridge.read(input);
    const endpoint = typeof credential.metadata.endpoint === "string"
      ? credential.metadata.endpoint
      : credential.externalAccountReference;
    return {
      ...credential,
      externalAccountReference: credential.externalAccountReference || endpoint,
      endpoint,
      subDomain: deputySubDomain(endpoint),
    };
  }
}

/**
 * Stripe flavour: Fivetran needs the Connect OAuth secret / Restricted key,
 * not the account id. Secret keys do not expire, so this path never refreshes
 * and does not need Albert's Stripe Connect app on the worker.
 */
export class StripeFivetranCredentialBridge {
  constructor(private readonly dependencies: Readonly<{
    db: TransactionalPostgres;
    vault: WorkerCredentialVault;
  }>) {}

  async read(input: Readonly<{ tenantId: string; nativeConnectionId: string; signal?: AbortSignal }>): Promise<NativeFivetranCredential> {
    const found = await this.dependencies.db.query<{
      connection_id: string;
      display_name: string;
      external_account_reference: string | null;
      secret_reference: string;
    }>(
      `select connection.connection_id,
              connection.display_name,
              connection.external_account_reference,
              token.secret_reference
         from control_plane.connections connection
         join lateral (
           select secret_reference
             from control_plane.oauth_token_refs
            where tenant_id = connection.tenant_id
              and connection_id = connection.connection_id
            order by updated_at desc
            limit 1
         ) token on true
        where connection.tenant_id = $1
          and connection.connection_id = $2
          and connection.connector_key = 'stripe'
          and connection.status in ('connected', 'degraded')`,
      [input.tenantId, input.nativeConnectionId],
    );
    const row = found.rows[0];
    if (!row) throw new Error("fivetran_stripe_connection_not_found");
    const credential = await this.dependencies.vault.read(row.secret_reference);
    const accessToken = stripeFivetranAccessToken(
      (credential.secret.metadata ?? {}) as Record<string, unknown>,
    );
    const accountId = typeof credential.secret.metadata?.stripeUserId === "string"
      ? credential.secret.metadata.stripeUserId
      : row.external_account_reference || credential.secret.accessToken;
    return {
      nativeConnectionId: row.connection_id,
      externalAccountReference: accountId,
      displayName: row.display_name,
      accessToken,
      expiresAt: credential.secret.expiresAt,
      metadata: (credential.secret.metadata ?? {}) as Record<string, unknown>,
    };
  }
}
