import { z } from "zod";

import {
  AdaptiveLeakyBucket,
  ConnectorError,
  ConnectorHttpError,
  credentialExpiresSoon,
  fetchWithRetry,
  hashPayload,
  requestJson,
  splitOAuthScopes,
  withVendorRateBudget,
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
  type RawSourceRecord,
  type ReconciliationRequest,
  type SyncCursor,
  type SyncPage,
  type SyncRange,
  type VersionedCredential,
  type WebhookDisposition,
  type WebhookEnvelope,
  type WorkerCredentialVault,
} from "../../packages/connector-sdk/src";
import { LIGHTSPEED_R_DEFAULT_SCOPES, lightspeedRManifest } from "./manifest";
import { buildLightspeedRAuthorizationUrl } from "./oauth-public";
import { lightspeedSchemas } from "./schemas";
import { syncStreamPage, type PageFetcher } from "./spec-sync.js";
import { LIGHTSPEED_STREAMS, type LightspeedStream } from "./streams.js";

const TOKEN_ENDPOINT = "https://cloud.lightspeedapp.com/auth/oauth/token";
const REVOCATION_ENDPOINT = "https://cloud.lightspeedapp.com/auth/oauth/revoke";
const API_ORIGIN = "https://api.lightspeedapp.com";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive(),
  token_type: z.string().default("Bearer"),
  scope: z.union([z.string(), z.array(z.string())]).optional(),
});

const accountSchema = z.object({
  accountID: z.union([z.string().min(1), z.number().int()]),
  name: z.string().optional(),
  currency: z.string().optional(),
  timeZone: z.string().optional(),
}).passthrough();

export type LightspeedRConnectorConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  vault: WorkerCredentialVault;
  fetcher?: FetchLike;
  retry?: HttpRetryOptions;
  now?: () => number;
}>;

/**
 * Worker ordering: a stream never outranks what it depends on, and ties keep
 * spec order. Derived from the generated contracts so a new spec table can
 * never be forgotten here.
 */
const streamPriority: ReadonlyMap<string, number> = (() => {
  const byId = new Map(LIGHTSPEED_STREAMS.map((stream) => [stream.id, stream]));
  const depthOf = (id: string, trail: readonly string[] = []): number => {
    if (trail.includes(id)) return trail.length;
    const stream = byId.get(id);
    if (!stream || stream.dependencies.length === 0) return 0;
    return 1 + Math.max(...stream.dependencies.map((dependency) => depthOf(dependency, [...trail, id])));
  };
  return new Map(LIGHTSPEED_STREAMS.map((stream, index) => [stream.id, depthOf(stream.id) * 1000 + index]));
})();

function required(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new ConnectorError("CONFIGURATION_INVALID", `${name} is required.`);
  }
  return value;
}


function asArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? [value] : [];
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}



const DISCOVERED_ACCOUNT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;


export class LightspeedRConnector implements OAuthConnectorPack {
  readonly id = "lightspeed-r" as const;
  readonly version = lightspeedRManifest.packVersion;
  readonly apiVersion = lightspeedRManifest.apiVersion;
  readonly manifest = lightspeedRManifest;

  private readonly config: LightspeedRConnectorConfig;
  private readonly fetcher: FetchLike;
  private readonly buckets = new Map<string, AdaptiveLeakyBucket>();
  private readonly refreshes = new Map<string, Promise<VersionedCredential>>();
  private readonly successfulStreams = new Set<string>();
  private readonly observedStocktakes = new Set<string>();
  private readonly discoveredAccountCache = new Map<string, { account: ConnectionDiscovery; at: number }>();

  constructor(config: LightspeedRConnectorConfig) {
    this.config = {
      ...config,
      clientId: required(config.clientId, "Lightspeed client ID"),
      clientSecret: required(config.clientSecret, "Lightspeed client secret"),
    };
    this.fetcher = config.fetcher ?? fetch;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    const scopes = request.scopes.length > 0 ? request.scopes : LIGHTSPEED_R_DEFAULT_SCOPES;
    const unsupported = scopes.filter(
      (scope) => !LIGHTSPEED_R_DEFAULT_SCOPES.includes(scope as (typeof LIGHTSPEED_R_DEFAULT_SCOPES)[number]),
    );
    if (unsupported.length > 0) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        `Unsupported Lightspeed scope requested: ${unsupported.join(", ")}.`,
      );
    }
    if (!request.codeChallenge) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Lightspeed R-Series PKCE requires a code challenge.");
    }
    return {
      url: buildLightspeedRAuthorizationUrl({
        clientId: this.config.clientId,
        state: request.state,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scopes,
      }),
      expiresAt: new Date((this.config.now?.() ?? Date.now()) + 10 * 60_000).toISOString(),
    };
  }

  async exchange_authorization_code(
    request: AuthorizationCodeExchange,
  ): Promise<OAuthExchangeResult> {
    if (!request.codeVerifier) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Lightspeed R-Series PKCE requires the original code verifier.");
    }
    // Official R-Series examples post multipart form fields (`curl -F`). JSON is
    // also documented, but live exchanges with redirect_uri + PKCE are pinned to
    // the multipart shape from the Authorization Code Grant page.
    const body = new FormData();
    body.set("client_id", this.config.clientId);
    body.set("client_secret", this.config.clientSecret);
    body.set("grant_type", "authorization_code");
    body.set("code", required(request.code, "Lightspeed authorization code"));
    body.set("redirect_uri", required(request.redirectUri, "Lightspeed redirect URI"));
    body.set("code_verifier", request.codeVerifier);
    const { value } = await requestJson<unknown>(
      this.fetcher,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { accept: "application/json" },
        body,
        signal: request.abortSignal,
      },
      this.config.retry,
    );
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError(
        "OAUTH_EXCHANGE_FAILED",
        "Lightspeed returned an invalid OAuth token response.",
        { cause: parsed.error },
      );
    }
    const expiresAt = new Date(
      (this.config.now?.() ?? Date.now()) + parsed.data.expires_in * 1_000,
    ).toISOString();
    const scopes = splitOAuthScopes(parsed.data.scope);
    const stored = await this.config.vault.create({
      provider: this.id,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      tokenType: "Bearer",
      expiresAt,
      scopes: scopes.length > 0 ? scopes : LIGHTSPEED_R_DEFAULT_SCOPES,
      metadata: {},
    });
    return { credentialRef: stored.credentialRef, expiresAt, scopes: stored.secret.scopes };
  }

  async check_connection(context: ConnectorContext): Promise<ConnectionHealth> {
    try {
      const accounts = await this.discover_accounts(context);
      return accounts.length > 0 ? "healthy" : "degraded";
    } catch (error) {
      if (error instanceof ConnectorHttpError && error.status === 401) return "expired";
      if (error instanceof ConnectorHttpError && error.status === 403) return "degraded";
      throw error;
    }
  }

  async discover_accounts(context: ConnectorContext): Promise<readonly ConnectionDiscovery[]> {
    const { value } = await this.apiJson<Record<string, unknown>>(
      context,
      new URL("/API/V3/Account.json", API_ORIGIN),
    );
    return asArray(value.Account).map((raw) => {
      const account = accountSchema.parse(raw);
      const accountId = String(account.accountID);
      return {
        externalAccountId: accountId,
        displayName: account.name?.trim() || `Lightspeed account ${accountId}`,
        baseUrl: `${API_ORIGIN}/API/V3/Account/${encodeURIComponent(accountId)}/`,
        metadata: {
          product: "R-Series",
          currency: account.currency ?? null,
          timezone: account.timeZone ?? null,
        },
      };
    });
  }

  async discover_account(context: ConnectorContext): Promise<ConnectionDiscovery> {
    // Every sync page calls this; without a cache the Account.json lookup
    // consumes half of the shared 1 req/s vendor budget. The account binding
    // is stable for a connection, so cache it briefly per process.
    const cacheKey = `${context.tenantId}:${context.connectionId}`;
    const cached = this.discoveredAccountCache.get(cacheKey);
    if (cached && Date.now() - cached.at < DISCOVERED_ACCOUNT_CACHE_TTL_MS) {
      return cached.account;
    }
    const credential = await this.readCredential(context);
    const selected = credential.secret.metadata.lightspeedAccountId;
    const accounts = await this.discover_accounts(context);
    if (typeof selected === "string") {
      const match = accounts.find((account) => account.externalAccountId === selected);
      if (match) {
        this.discoveredAccountCache.set(cacheKey, { account: match, at: Date.now() });
        return match;
      }
      throw new ConnectorError(
        "AUTHENTICATION_REQUIRED",
        "The selected Lightspeed R-Series account is no longer accessible.",
      );
    }
    if (accounts.length === 1 && accounts[0]) {
      this.discoveredAccountCache.set(cacheKey, { account: accounts[0], at: Date.now() });
      return accounts[0];
    }
    throw new ConnectorError(
      "CONFIGURATION_INVALID",
      accounts.length === 0
        ? "No Lightspeed R-Series account is available for this token."
        : "Select which Lightspeed R-Series account Albert should connect.",
      { details: { accountCount: accounts.length } },
    );
  }

  async select_account(
    context: ConnectorContext,
    externalAccountId: string,
  ): Promise<ConnectionDiscovery> {
    const accounts = await this.discover_accounts(context);
    const selected = accounts.find((account) => account.externalAccountId === externalAccountId);
    if (!selected) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        "That Lightspeed R-Series account is not authorized for this connection.",
      );
    }
    const current = await this.readCredential(context);
    await this.config.vault.compareAndSwap(current.credentialRef, current.revision, {
      ...current.secret,
      metadata: { ...current.secret.metadata, lightspeedAccountId: externalAccountId },
    });
    return selected;
  }

  async list_streams(context: ConnectorContext): Promise<readonly ConnectorStream[]> {
    void context;
    return this.manifest.streams
      .map((stream) => ({
        id: stream.id,
        label: stream.resource,
        domains: stream.productDomains,
        cursorKind: stream.modifiedField ? "high_water_mark" as const : "none" as const,
        backfillStrategy: stream.backfillStrategy,
        lateEditStrategy: stream.lateEditStrategy,
        deletionStrategy: stream.deletionStrategy,
        sourceTotalStrategy: stream.sourceTotalStrategy,
        availability: stream.availability ?? "required",
        dependencies: stream.dependencies,
        productDomains: stream.productDomains,
        priority: streamPriority.get(stream.id) ?? 0,
      }))
      .sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0));
  }

  async initial_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    range: SyncRange,
    cursor?: SyncCursor,
  ): Promise<SyncPage> {
    return this.sync(context, stream, "initial", cursor, range);
  }

  async incremental_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    cursor: SyncCursor,
  ): Promise<SyncPage> {
    return this.sync(context, stream, "incremental", cursor);
  }

  async reconciliation_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    request: ReconciliationRequest,
  ): Promise<SyncPage> {
    if (request.phase === "late_edits" && stream.lateEditStrategy === "append_only") {
      return { records: [], nextCursor: null, hasMore: false, sourceTotal: 0 };
    }
    return this.sync(
      context,
      stream,
      "reconciliation",
      request.cursor,
      request.range,
      request.phase,
    );
  }

  async handle_webhook(
    context: ConnectorContext,
    event: WebhookEnvelope,
  ): Promise<WebhookDisposition> {
    void context;
    void event;
    return {
      accepted: false,
      streams: [],
      reason: "Lightspeed R-Series does not document a webhook contract; polling and reconciliation sweeps remain authoritative.",
    };
  }

  async refresh_credentials(context: ConnectorContext): Promise<{ credentialRef: string }> {
    const current = await this.readCredential(context);
    const refreshed = await this.refreshCredential(current, context.abortSignal);
    return { credentialRef: refreshed.credentialRef };
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    const current = await this.readCredential(context);
    try {
      if (current.secret.refreshToken) {
        const body = new FormData();
        body.set("client_id", this.config.clientId);
        body.set("client_secret", this.config.clientSecret);
        body.set("refresh_token", current.secret.refreshToken);
        const response = await fetchWithRetry(
          this.fetcher,
          REVOCATION_ENDPOINT,
          {
            method: "POST",
            headers: { accept: "application/json" },
            body,
            signal: context.abortSignal,
          },
          withVendorRateBudget(this.config.retry, context.vendorRateBudget),
        );
        await response.body?.cancel().catch(() => undefined);
      }
    } finally {
      await this.config.vault.destroy(context.credentialRef);
    }
  }

  async describe_capabilities(
    context: ConnectorContext,
  ): Promise<readonly ConnectorCapability[]> {
    const credential = await this.readCredential(context);
    const scopes = new Set(credential.secret.scopes);
    const hasScope = (scope: string) => scopes.has("employee:all") || scopes.has(scope);
    const has = (...requiredScopes: string[]) => requiredScopes.every(hasScope);
    const scopeCapability = (
      id: ConnectorCapability["id"],
      requiredScopes: readonly string[],
    ): ConnectorCapability => ({
      id,
      support: requiredScopes.every(hasScope) ? "full" : "unavailable",
      reasonCode: requiredScopes.every(hasScope)
        ? "required_scopes_granted"
        : "required_scope_missing",
      requiredScopes,
    });
    const inventoryLogObserved = this.successfulStreams.has(`${context.connectionId}:ls_inventory_logs`);
    return [
      {
        id: "connector.variant.r_series",
        support: "full",
        reasonCode: "r_series_account_verified",
        notes: "A successful V3 Account discovery is the fail-fast R-Series verification. X-Series uses a different OAuth and API host.",
      },
      scopeCapability("commerce.orders", ["employee:register_read"]),
      scopeCapability("commerce.order_lines", ["employee:register_read"]),
      scopeCapability("commerce.order_lines.discounts", ["employee:register_read"]),
      scopeCapability("commerce.refunds", ["employee:register_read"]),
      scopeCapability("commerce.payments", ["employee:register_read"]),
      scopeCapability("commerce.orders.customer", ["employee:register_read", "employee:customers_read"]),
      scopeCapability("commerce.order_lines.worker_attribution", ["employee:register_read", "employee:admin_employees"]),
      scopeCapability("commerce.order_lines.cost", ["employee:product_cost"]),
      scopeCapability("inventory.balances", ["employee:inventory_read"]),
      scopeCapability("inventory.cost", ["employee:inventory_read", "employee:product_cost"]),
      scopeCapability("inventory.purchase_orders", ["employee:vendors", "employee:purchase_orders"]),
      {
        id: "inventory.movements",
        support: !has("employee:inventory_read", "employee:product_cost")
          ? "unavailable"
          : inventoryLogObserved
            ? "partial"
            : "unknown",
        reasonCode: !has("employee:inventory_read", "employee:product_cost")
          ? "required_scope_missing"
          : inventoryLogObserved ? "live_stream_observed" : "live_probe_required",
        requiredScopes: ["employee:inventory_read", "employee:product_cost"],
        notes: "InventoryLog becomes Partial only after a live extraction succeeds because its documented employee:inventory_log right is absent from the public OAuth scope allow-list and source retention is merchant-dependent.",
      },
      {
        id: "inventory.stocktakes",
        support: this.observedStocktakes.has(context.connectionId) ? "partial" : inventoryLogObserved ? "unavailable" : "unknown",
        reasonCode: this.observedStocktakes.has(context.connectionId)
          ? "stocktake_records_observed"
          : inventoryLogObserved ? "stocktake_records_not_observed" : "live_probe_required",
        notes: "Stocktake variance is gated on live InventoryLog rows with a non-zero inventoryCountID.",
      },
      { id: "source.webhooks", support: "unavailable", reasonCode: "connector_webhooks_unsupported" },
    ];
  }

  /**
   * Every mode routes through the spec walk: one implementation, ninety
   * streams. A bounded per-process page cache keyed on the exact request lets
   * the members of a scan group serve their walks from the leader's pages —
   * the six Sale-derived streams cost one Sale.json walk in HTTP, not six —
   * which is what keeps the widened manifest inside the one-drip-per-second
   * budget. Incremental walks carry per-stream watermarks in their filters,
   * so the cache pays off on backfill and reconciliation, where the volume is.
   *
   * The bounds must span one full group pass or the cache is decorative: the
   * live account's Sale history is ~400 pages over ~17 minutes, and sibling
   * walks run sequentially behind the leader. 40 entries with a 10-minute TTL
   * meant every sibling missed and re-fetched the entire history from the
   * vendor — the observed ~6x request multiplier. 600 entries at ~60KB of
   * payload each is ~35MB, well inside the Machine's memory.
   */
  private static readonly PAGE_CACHE_TTL_MS = 60 * 60 * 1000;
  private static readonly PAGE_CACHE_MAX_ENTRIES = 600;
  private readonly pageCache = new Map<string, { at: number; body: unknown }>();

  private async sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
    reconciliationPhase?: ReconciliationRequest["phase"],
  ): Promise<SyncPage> {
    void reconciliationPhase;
    const contract = LIGHTSPEED_STREAMS.find((candidate) => candidate.id === stream.id);
    if (!contract || !(contract.id in lightspeedSchemas)) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Unknown Lightspeed stream: ${stream.id}.`);
    }
    const account = await this.discover_account(context);
    const basePath = `/API/V3/Account/${encodeURIComponent(account.externalAccountId)}/`;
    const now = this.config.now ?? Date.now;

    const fetchPage: PageFetcher = async (path, params) => {
      const canonicalParams = Object.entries(params)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
      const cacheKey = `${context.connectionId}:${path}?${canonicalParams}`;
      const cached = this.pageCache.get(cacheKey);
      if (cached && now() - cached.at < LightspeedRConnector.PAGE_CACHE_TTL_MS) {
        // Re-insert to keep the entry young: Map preserves insertion order.
        this.pageCache.delete(cacheKey);
        this.pageCache.set(cacheKey, cached);
        return cached.body;
      }
      const url = new URL(basePath + path, API_ORIGIN);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      let value: Record<string, unknown>;
      try {
        ({ value } = await this.apiJson<Record<string, unknown>>(context, url));
      } catch (error) {
        // A 404 on a stream's walk means the documented resource does not
        // exist for this account (plan-gated or absent) — observed live on
        // reports, custom fields and currency denominations. That is an
        // unavailable capability to record, not a transient vendor outage to
        // retry every recovery sweep forever.
        if (error instanceof ConnectorHttpError && error.status === 404) {
          throw new ConnectorError(
            "CAPABILITY_UNAVAILABLE",
            `The vendor endpoint ${path} does not exist for this account.`,
            { retryable: false, cause: error },
          );
        }
        throw error;
      }
      this.pageCache.set(cacheKey, { at: now(), body: value });
      while (this.pageCache.size > LightspeedRConnector.PAGE_CACHE_MAX_ENTRIES) {
        const oldest = this.pageCache.keys().next().value;
        if (oldest === undefined) break;
        this.pageCache.delete(oldest);
      }
      return value;
    };

    const page = await syncStreamPage({
      stream: contract,
      connectorId: this.id,
      ...(cursor ? { cursor } : {}),
      ...(range ? { range } : {}),
      mode,
      fetchPage,
      hash: (payload) => hashPayload(payload),
    });
    const records = page.records.map((record) => this.validateProjectedRecord(contract, record));
    if (contract.id === "ls_inventory_logs" && records.some((record) => {
      const value = record.normalized?.fields.inventoryCountID;
      return value !== undefined && value !== null && String(value) !== "0" && String(value).trim() !== "";
    })) {
      this.observedStocktakes.add(context.connectionId);
    }
    this.successfulStreams.add(`${context.connectionId}:${contract.id}`);
    return { ...page, records };
  }

  /**
   * Validate one projected row against its generated schema and keep only
   * approved coverage fields in the typed projection. A row that fails its
   * schema keeps its raw payload and is quarantined downstream; the evidence
   * is never discarded here.
   */
  private validateProjectedRecord(contract: LightspeedStream, record: RawSourceRecord): RawSourceRecord {
    const schema = lightspeedSchemas[contract.id];
    if (!schema) throw new ConnectorError("CONFIGURATION_INVALID", `Unknown stream ${contract.id}.`);
    const parsed = schema.safeParse(record.payload);
    if (!parsed.success) {
      const { normalized: _normalized, ...rest } = record;
      void _normalized;
      return {
        ...rest,
        validationIssues: parsed.error.issues.map((issue) => ({
          code: "schema_invalid" as const,
          path: issue.path.join("."),
          message: issue.message,
        })),
      };
    }
    const coverage = this.manifest.fieldCoverage.filter((item) => item.stream === contract.id);
    const allowed = new Set(
      coverage.filter((item) => item.disposition !== "unsupported").map((item) => item.field),
    );
    const known = new Set(coverage.map((item) => item.field));
    const payloadFields = record.payload && typeof record.payload === "object"
      ? record.payload as Record<string, unknown>
      : {};
    const drift = Object.keys(payloadFields).filter((field) => !known.has(field));
    const approved = Object.fromEntries(
      Object.entries(payloadFields).filter(([field]) => allowed.has(field)),
    );
    return {
      ...record,
      normalized: { schemaVersion: this.version, fields: approved },
      ...(drift.length > 0
        ? {
          validationIssues: drift.map((field) => ({
            code: "schema_drift" as const,
            path: field,
            message: "The vendor returned a field without an approved coverage disposition.",
          })),
        }
        : {}),
    };
  }

  private async apiJson<T>(
    context: ConnectorContext,
    url: URL,
  ): Promise<Readonly<{ value: T; response: Response }>> {
    const credential = await this.validCredential(context);
    const bucket = this.buckets.get(context.connectionId) ?? new AdaptiveLeakyBucket();
    this.buckets.set(context.connectionId, bucket);
    const coordinatedRetry = withVendorRateBudget(
      this.config.retry,
      context.vendorRateBudget,
    );
    const execute = (accessToken: string) => requestJson<T>(
      this.fetcher,
      url,
      {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal: context.abortSignal,
      },
      {
        ...coordinatedRetry,
        beforeRequest: async (signal) => {
          await coordinatedRetry.beforeRequest?.(signal);
          await bucket.wait(this.config.retry?.sleep, signal);
        },
        observeResponse: async (response) => {
          bucket.observe(response.headers);
          await coordinatedRetry.observeResponse?.(response);
        },
      },
    );
    try {
      return await execute(credential.secret.accessToken);
    } catch (error) {
      if (!(error instanceof ConnectorHttpError) || error.status !== 401 || !credential.secret.refreshToken) {
        throw error;
      }
      const refreshed = await this.refreshCredential(credential, context.abortSignal);
      return execute(refreshed.secret.accessToken);
    }
  }

  private async readCredential(context: ConnectorContext): Promise<VersionedCredential> {
    const credential = await this.config.vault.read(context.credentialRef);
    if (credential.secret.provider !== this.id) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Lightspeed R-Series.");
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
          throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Lightspeed R-Series.");
        }
        // A replica that waited for another holder must consume the rotated
        // credential instead of replaying a now-invalid refresh token.
        if (latest.revision !== current.revision) return latest;
        return this.performRefresh(latest, lease.abortSignal, lease.proof);
      },
      signal,
    ).finally(() => {
      this.refreshes.delete(current.credentialRef);
    });
    this.refreshes.set(current.credentialRef, promise);
    return promise;
  }

  private async performRefresh(
    current: VersionedCredential,
    signal?: AbortSignal,
    refreshLease?: CredentialRefreshLeaseProof,
  ): Promise<VersionedCredential> {
    if (!current.secret.refreshToken) {
      throw new ConnectorError("AUTHENTICATION_REQUIRED", "Lightspeed refresh token is missing.");
    }
    const body = new FormData();
    body.set("client_id", this.config.clientId);
    body.set("client_secret", this.config.clientSecret);
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", current.secret.refreshToken);
    const { value } = await requestJson<unknown>(
      this.fetcher,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { accept: "application/json" },
        body,
        signal,
      },
      this.config.retry,
    );
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("OAUTH_EXCHANGE_FAILED", "Lightspeed returned an invalid refresh response.", {
        cause: parsed.error,
      });
    }
    const next: OAuthCredentialSecret = {
      ...current.secret,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? current.secret.refreshToken,
      expiresAt: new Date(
        (this.config.now?.() ?? Date.now()) + parsed.data.expires_in * 1_000,
      ).toISOString(),
      scopes: splitOAuthScopes(parsed.data.scope).length > 0
        ? splitOAuthScopes(parsed.data.scope)
        : current.secret.scopes,
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
      throw new ConnectorError("CREDENTIAL_CONFLICT", "Concurrent Lightspeed token rotation failed.", {
        cause,
        retryable: true,
      });
    }
  }
}

export { lightspeedRManifest } from "./manifest";
export * from "./schemas";
