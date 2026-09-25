import { signInternalRequest } from "../../../packages/security/src/index.js";
import type { TransactionalPostgres } from "./database.js";
import { deputySubDomain } from "./fivetran-native-credentials.js";

/**
 * Partner-brokered grants (ADR 0151).
 *
 * Lightspeed, Xero and Deputy refresh tokens are single-use and rotating, so a
 * grant may have exactly one refresher. For a tenant a partner provisioned
 * (control_plane.partner_clients with token_broker), that refresher is the
 * partner: Yellow Jersey took the store's grant through its own OAuth app and
 * keeps refreshing it for its own features. Copying the grant into Albert's
 * vault and refreshing it here would revoke the partner's connection, so this
 * bridge never holds a refresh token. It asks the partner's token broker for
 * a current access token (HMAC-signed with the partner's broker secret, the
 * same scheme as Albert's internal requests) and hands it to Fivetran exactly
 * where the native bridge would: the SDK connectors' /v1/fivetran/token and
 * the Deputy relay.
 */
export type PartnerTokenBroker = Readonly<{
  partner: string;
  /** Absolute https URL of the partner's token endpoint. */
  url: string;
  /** HMAC secret shared with the partner (≥ 32 bytes). */
  secret: string;
}>;

export type PartnerGrantProvider = "lightspeed" | "xero" | "deputy";

export type PartnerBinding = Readonly<{ clientId: string; partner: string; accountRef: string }>;

export type PartnerGrantCredential = Readonly<{
  partner: string;
  partnerClientId: string;
  externalAccountReference: string;
  displayName: string;
  accessToken: string;
  expiresAt: string;
  metadata: Readonly<Record<string, unknown>>;
  /** Deputy: the install host and Fivetran's `sub_domain`. */
  endpoint?: string;
  subDomain?: string;
}>;

const PARTNER_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const XERO_TENANT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LIGHTSPEED_ACCOUNT_PATTERN = /^[0-9]{1,20}$/u;
const TOKEN_PATTERN = /^[\x21-\x7e]{16,8192}$/u;

const SERVICE_PROVIDERS: Readonly<Record<string, PartnerGrantProvider>> = Object.freeze({
  light_speed_retail: "lightspeed",
  xero: "xero",
  deputy: "deputy",
});

/** Fivetran service id → the partner's name for the vendor grant. */
export function partnerProviderForService(service: string): PartnerGrantProvider | undefined {
  return Object.prototype.hasOwnProperty.call(SERVICE_PROVIDERS, service) ? SERVICE_PROVIDERS[service] : undefined;
}

/**
 * ALBERT_PARTNER_TOKEN_BROKERS: `[{"partner":"yellow-jersey","url":"https://…","secret":"…"}]`.
 * Empty or unset means no partner brokers grants on this worker.
 */
export function parsePartnerTokenBrokers(raw: string | undefined): ReadonlyMap<string, PartnerTokenBroker> {
  const brokers = new Map<string, PartnerTokenBroker>();
  if (!raw?.trim()) return brokers;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ALBERT_PARTNER_TOKEN_BROKERS must be a JSON array.");
  }
  if (!Array.isArray(parsed)) throw new Error("ALBERT_PARTNER_TOKEN_BROKERS must be a JSON array.");
  parsed.forEach((value, index) => {
    const entry = value as Record<string, unknown> | null;
    const fail = (field: string): never => {
      throw new Error(`ALBERT_PARTNER_TOKEN_BROKERS[${index}].${field} is invalid.`);
    };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("entry");
    const { partner, url, secret } = entry!;
    if (typeof partner !== "string" || !PARTNER_PATTERN.test(partner)) fail("partner");
    if (brokers.has(partner as string)) fail("partner");
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = typeof url === "string" ? new URL(url) : null;
    } catch {
      parsedUrl = null;
    }
    if (
      !parsedUrl
      || parsedUrl.protocol !== "https:"
      || parsedUrl.username
      || parsedUrl.password
      || parsedUrl.search
      || parsedUrl.hash
    ) {
      fail("url");
    }
    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) fail("secret");
    brokers.set(partner as string, Object.freeze({
      partner: partner as string,
      url: parsedUrl!.toString(),
      secret: secret as string,
    }));
  });
  return brokers;
}

/** Error codes follow publicError's families: expired/invalid → 409, not_found → 404, the rest 503. */
function failure(code: string, detail?: string): Error {
  return new Error(detail ? `${code}:${detail.replace(/\s+/gu, " ").slice(0, 200)}` : code);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export class PartnerGrantBridge {
  private readonly fetcher: typeof fetch;

  constructor(private readonly dependencies: Readonly<{
    db: TransactionalPostgres;
    brokers: ReadonlyMap<string, PartnerTokenBroker>;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  }>) {
    this.fetcher = dependencies.fetcher ?? fetch;
  }

  /** The tenant's active, brokered partner client, or null for every other tenant. */
  async binding(tenantId: string): Promise<PartnerBinding | null> {
    const result = await this.dependencies.db.query<{
      client_id: string;
      partner: string;
      partner_account_ref: string;
    }>(
      `select client_id, partner, partner_account_ref
         from control_plane.partner_clients
        where tenant_id = $1
          and status = 'active'
          and token_broker
        limit 1`,
      [tenantId],
    );
    const row = result.rows[0];
    return row ? { clientId: row.client_id, partner: row.partner, accountRef: row.partner_account_ref } : null;
  }

  /**
   * A current access token for the tenant's `service` grant, valid for at
   * least `minValiditySeconds` when the partner can promise it. The partner
   * refreshes through its own single refresher when needed; this worker never
   * sees a refresh token.
   */
  async read(input: Readonly<{
    tenantId: string;
    service: string;
    minValiditySeconds?: number;
    signal?: AbortSignal;
  }>): Promise<PartnerGrantCredential> {
    const provider = partnerProviderForService(input.service);
    if (!provider) throw failure("fivetran_service_unsupported");
    const binding = await this.binding(input.tenantId);
    if (!binding) throw failure("fivetran_partner_binding_not_found");
    const broker = this.dependencies.brokers.get(binding.partner);
    if (!broker) {
      throw failure("fivetran_not_configured", `No token broker is configured for partner ${binding.partner}.`);
    }
    const body = JSON.stringify({
      tenantId: input.tenantId,
      clientId: binding.clientId,
      accountRef: binding.accountRef,
      provider,
      minValiditySeconds: Math.max(0, Math.min(86_400, Math.round(input.minValiditySeconds ?? 300))),
    });
    const url = new URL(broker.url);
    const headers = await signInternalRequest({ method: "POST", path: url.pathname, body, secret: broker.secret });
    const timeout = AbortSignal.timeout(this.dependencies.timeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...headers },
        body,
        redirect: "error",
        signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      });
    } catch (error) {
      throw failure("fivetran_partner_broker_unavailable", error instanceof Error ? error.message : undefined);
    }
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const detail = payload && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403) throw failure("fivetran_partner_broker_invalid", detail);
      // The partner has no usable grant: the owner must reconnect on the partner's side.
      if (response.status === 404 || response.status === 409 || response.status === 410) {
        throw failure("fivetran_partner_grant_expired", detail);
      }
      throw failure("fivetran_partner_broker_unavailable", detail);
    }
    const result = (payload && typeof payload.result === "object" && payload.result !== null
      ? payload.result
      : payload) as Record<string, unknown> | null;
    if (!result) throw failure("fivetran_partner_broker_unavailable", "empty response");
    return this.credential(provider, binding, result);
  }

  private credential(
    provider: PartnerGrantProvider,
    binding: PartnerBinding,
    result: Record<string, unknown>,
  ): PartnerGrantCredential {
    const accessToken = readString(result, "accessToken");
    const expiresAt = readString(result, "expiresAt");
    const account = readString(result, "externalAccountId");
    if (!accessToken || !TOKEN_PATTERN.test(accessToken)) throw failure("fivetran_partner_broker_invalid", "no access token");
    if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) throw failure("fivetran_partner_broker_invalid", "no expiry");
    if (Date.parse(expiresAt) <= Date.now()) throw failure("fivetran_partner_grant_expired", "the partner returned an expired token");
    const displayName = (readString(result, "displayName") ?? "").slice(0, 100);
    const base = {
      partner: binding.partner,
      partnerClientId: binding.clientId,
      displayName,
      accessToken,
      expiresAt: new Date(Date.parse(expiresAt)).toISOString(),
    };
    if (provider === "lightspeed") {
      if (!account || !LIGHTSPEED_ACCOUNT_PATTERN.test(account)) throw failure("fivetran_partner_broker_invalid", "no Lightspeed account");
      return { ...base, externalAccountReference: account, metadata: { partner: binding.partner, lightspeedAccountId: account } };
    }
    if (provider === "xero") {
      if (!account || !XERO_TENANT_PATTERN.test(account)) throw failure("fivetran_partner_broker_invalid", "no Xero organisation");
      return { ...base, externalAccountReference: account.toLowerCase(), metadata: { partner: binding.partner } };
    }
    const endpoint = (readString(result, "endpoint") ?? account ?? "").toLowerCase();
    let subDomain: string;
    try {
      subDomain = deputySubDomain(endpoint);
    } catch {
      throw failure("fivetran_partner_broker_invalid", "no Deputy install");
    }
    return {
      ...base,
      externalAccountReference: endpoint,
      endpoint,
      subDomain,
      metadata: { partner: binding.partner, endpoint },
    };
  }
}
