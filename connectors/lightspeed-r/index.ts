import { z } from "zod";

import {
  AdaptiveLeakyBucket,
  ConnectorError,
  ConnectorHttpError,
  credentialExpiresSoon,
  decodeCursor,
  encodeCursor,
  fetchWithRetry,
  hashPayload,
  normalizeDecimal,
  normalizeTimestamp,
  projectSourceRecord,
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
import { lightspeedSchemas, type LightspeedStreamId } from "./schemas";

const TOKEN_ENDPOINT = "https://cloud.lightspeedapp.com/auth/oauth/token";
const REVOCATION_ENDPOINT = "https://cloud.lightspeedapp.com/auth/oauth/access_token";
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

const streamPriority: Readonly<Record<LightspeedStreamId, number>> = {
  shops: 10,
  employees: 20,
  categories: 30,
  items: 31,
  sales: 40,
  item_shops: 50,
  customers: 60,
  vendors: 61,
  payment_types: 70,
  tax_categories: 71,
  orders: 80,
  order_lines: 81,
  inventory_logs: 90,
};

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

function lightspeedTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ConnectorError("CURSOR_INVALID", "Lightspeed sync time is invalid.");
  }
  return new Date(parsed).toISOString().replace(/\.\d{3}Z$/u, "+00:00");
}

function latestTimestamp(values: readonly (string | undefined)[], fallback?: string): string | undefined {
  return values.reduce<string | undefined>((latest, value) => {
    if (!value || !Number.isFinite(Date.parse(value))) return latest;
    if (!latest || Date.parse(value) > Date.parse(latest)) return value;
    return latest;
  }, fallback);
}

function oldestRecordTimestamp(records: readonly RawSourceRecord[], fallback?: string): string | undefined {
  return records.flatMap((record) => [
    record.sourceUpdatedAt,
    ...Object.values(record.normalized?.timestamps ?? {}).map((value) => value.utc ?? undefined),
  ]).reduce<string | undefined>((oldest, value) => {
    if (!value || !Number.isFinite(Date.parse(value))) return oldest;
    return !oldest || Date.parse(value) < Date.parse(oldest) ? value : oldest;
  }, fallback);
}

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
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "authorization_code",
      code: required(request.code, "Lightspeed authorization code"),
      redirect_uri: required(request.redirectUri, "Lightspeed redirect URI"),
      code_verifier: request.codeVerifier,
    });
    const { value } = await requestJson<unknown>(
      this.fetcher,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
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
    const credential = await this.readCredential(context);
    const selected = credential.secret.metadata.lightspeedAccountId;
    const accounts = await this.discover_accounts(context);
    if (typeof selected === "string") {
      const match = accounts.find((account) => account.externalAccountId === selected);
      if (match) return match;
      throw new ConnectorError(
        "AUTHENTICATION_REQUIRED",
        "The selected Lightspeed R-Series account is no longer accessible.",
      );
    }
    if (accounts.length === 1 && accounts[0]) return accounts[0];
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
        priority: streamPriority[stream.id as LightspeedStreamId],
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
        const response = await fetchWithRetry(
          this.fetcher,
          REVOCATION_ENDPOINT,
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              accept: "application/json",
            },
            body: new URLSearchParams({
              client_id: this.config.clientId,
              client_secret: this.config.clientSecret,
              refresh_token: current.secret.refreshToken,
              grant_type: "revoke_refresh_token",
            }),
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
    const has = (...requiredScopes: string[]) => requiredScopes.every((scope) => scopes.has(scope));
    const scopeCapability = (
      id: ConnectorCapability["id"],
      requiredScopes: readonly string[],
    ): ConnectorCapability => ({
      id,
      support: requiredScopes.every((scope) => scopes.has(scope)) ? "full" : "unavailable",
      reasonCode: requiredScopes.every((scope) => scopes.has(scope))
        ? "required_scopes_granted"
        : "required_scope_missing",
      requiredScopes,
    });
    const inventoryLogObserved = this.successfulStreams.has(`${context.connectionId}:inventory_logs`);
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

  private async sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
    reconciliationPhase?: ReconciliationRequest["phase"],
  ): Promise<SyncPage> {
    const contract = this.manifest.streams.find((candidate) => candidate.id === stream.id);
    if (!contract || !(contract.id in lightspeedSchemas)) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Unknown Lightspeed stream: ${stream.id}.`);
    }
    const streamId = contract.id as LightspeedStreamId;
    const account = await this.discover_account(context);
    const state = cursor
      ? decodeCursor(cursor, { connector: this.id, stream: stream.id })
      : undefined;

    let url: URL;
    if (typeof state?.continuation === "string") {
      url = this.validateContinuation(state.continuation, account.externalAccountId, contract.endpoint);
    } else {
      url = new URL(
        `/API/V3/Account/${encodeURIComponent(account.externalAccountId)}/${contract.endpoint}`,
        API_ORIGIN,
      );
      url.searchParams.set("limit", "100");
      url.searchParams.set(
        "sort",
        mode === "reconciliation" && reconciliationPhase !== "late_edits"
          ? contract.recordIdField
          : streamId === "inventory_logs"
          ? contract.recordIdField
          : contract.modifiedField ?? contract.recordIdField,
      );
      if (["shops", "employees", "items", "sales", "customers", "vendors", "orders", "payment_types"].includes(streamId)) {
        url.searchParams.set("archived", "true");
      }
      if (streamId === "shops" || streamId === "employees" || streamId === "customers" || streamId === "vendors") {
        url.searchParams.set("load_relations", JSON.stringify(["Contact"]));
      } else if (streamId === "items") {
        url.searchParams.set("load_relations", JSON.stringify(["ItemPrices"]));
      } else if (streamId === "sales") {
        url.searchParams.set("load_relations", JSON.stringify(["SaleLines", "SalePayments"]));
      } else if (streamId === "orders") {
        url.searchParams.set("load_relations", JSON.stringify(["OrderLines"]));
      } else if (streamId === "tax_categories") {
        url.searchParams.set("load_relations", JSON.stringify(["TaxCategoryClasses"]));
      }
      if (streamId === "inventory_logs" && typeof state?.continuation === "number") {
        url.searchParams.set(contract.recordIdField, `>,${state.continuation}`);
      } else if (
        contract.modifiedField && range &&
        (
          (mode === "initial" && contract.backfillStrategy !== "snapshot") ||
          (mode === "reconciliation" && reconciliationPhase === "late_edits" &&
            contract.lateEditStrategy === "modified_field")
        )
      ) {
        url.searchParams.set(
          contract.modifiedField,
          `><,${lightspeedTime(range.from)},${lightspeedTime(range.to)}`,
        );
      } else if (mode === "incremental" && contract.modifiedField && state?.watermark) {
        // Inclusive boundaries deliberately provide at-least-once delivery.
        url.searchParams.set(contract.modifiedField, `>=,${lightspeedTime(state.watermark)}`);
      }
    }

    const { value } = await this.apiJson<Record<string, unknown>>(context, url);
    const rawRecords = asArray(value[contract.resource]);
    const records = rawRecords.map((raw) => this.toRawRecord(streamId, raw));
    const attributes =
      value["@attributes"] && typeof value["@attributes"] === "object"
        ? value["@attributes"] as Record<string, unknown>
        : {};
    const next = typeof attributes.next === "string" && attributes.next.length > 0
      ? this.validateContinuation(attributes.next, account.externalAccountId, contract.endpoint).toString()
      : undefined;
    const watermark = latestTimestamp(
      records.map((record) => record.sourceUpdatedAt),
      state?.watermark ?? (mode === "initial" && !next ? range?.to : undefined),
    );
    const oldestObservedAt = oldestRecordTimestamp(records, state?.oldestObservedAt);
    const inventoryIds = streamId === "inventory_logs"
      ? records.map((record) => Number(record.sourceRecordId)).filter(Number.isSafeInteger)
      : [];
    if (streamId === "inventory_logs" && records.some((record) => {
      const value = record.normalized?.fields.inventoryCountID;
      return value !== undefined && value !== null && String(value) !== "0" && String(value).trim() !== "";
    })) {
      this.observedStocktakes.add(context.connectionId);
    }
    const inventoryCheckpoint = inventoryIds.length > 0
      ? Math.max(...inventoryIds)
      : streamId === "inventory_logs" && typeof state?.continuation === "number"
        ? state.continuation
        : undefined;
    this.successfulStreams.add(`${context.connectionId}:${streamId}`);
    return {
      records,
      nextCursor: encodeCursor({
        v: 1,
        connector: this.id,
        stream: stream.id,
        mode: mode === "reconciliation" ? "reconciliation" : mode,
        watermark,
        oldestObservedAt,
        continuation: next ?? inventoryCheckpoint,
        rangeFrom: range?.from ?? state?.rangeFrom,
        rangeTo: range?.to ?? state?.rangeTo,
      }),
      hasMore: Boolean(next),
      ...(mode === "initial" && !next && range
        ? { coverage: contract.backfillStrategy === "snapshot"
            ? {
                boundaryKind: "snapshot_at" as const,
                lowerBound: range.to,
                verification: "point_in_time" as const,
              }
            : Date.parse(range.from) <= Date.parse("1970-01-01T00:00:00.000Z")
              ? {
                  boundaryKind: oldestObservedAt ? "verified_oldest" as const : "verified_empty" as const,
                  lowerBound: oldestObservedAt ?? range.to,
                  verification: "exhaustive_vendor_scan" as const,
                }
              : {
                  boundaryKind: "window_exhausted" as const,
                  lowerBound: range.from,
                  verification: "exhaustive_vendor_scan" as const,
                } }
        : {}),
    };
  }

  private toRawRecord(stream: LightspeedStreamId, raw: unknown): RawSourceRecord {
    const payloadHash = hashPayload(raw);
    const schema = lightspeedSchemas[stream];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const candidate = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const idField = this.manifest.streams.find((item) => item.id === stream)?.recordIdField;
      return {
        sourceObjectType: stream,
        sourceRecordId: idField && candidate[idField] != null ? String(candidate[idField]) : `invalid:${payloadHash}`,
        payload: raw,
        payloadHash,
        validationIssues: parsed.error.issues.map((issue) => ({
          code: "schema_invalid" as const,
          path: issue.path.join("."),
          message: issue.message,
        })),
      };
    }
    const fields = parsed.data as Record<string, unknown>;
    const coverage = this.manifest.fieldCoverage.filter((item) => item.stream === stream);
    const known = new Set(coverage.map((item) => item.field));
    const allowed = new Set(
      coverage.filter((item) => item.disposition !== "unsupported").map((item) => item.field),
    );
    const drift = Object.keys(fields).filter((field) => !known.has(field));
    const approvedFields = Object.fromEntries(
      Object.entries(fields).filter(([field]) => allowed.has(field)),
    );
    const config = this.manifest.streams.find((item) => item.id === stream);
    if (!config) throw new ConnectorError("CONFIGURATION_INVALID", `Unknown stream ${stream}.`);
    const timestamp = normalizeTimestamp(fields[config.modifiedField ?? "timeStamp"]);
    const moneyFields: Record<string, readonly [unknown, unknown?]> = {};
    for (const field of [
      "defaultCost", "avgCost", "qoh", "sellable", "backorder", "componentQoh",
      "componentBackorder", "reorderPoint", "reorderLevel", "onLayaway", "onSpecialOrder",
      "onWorkOrder", "onWorkorder", "onTransferOut", "onTransferIn", "averageCost",
      "totalValueFifo", "totalValueAvgCost", "totalValueNegativeInventory", "lastReceivedCost",
      "nextFifoLotCost", "total", "taxTotal", "calcDiscount", "calcTotal", "calcSubtotal",
      "calcTaxable", "calcNonTaxable", "calcAvgCost", "calcFIFOCost", "calcTax1", "calcTax2",
      "calcPayments", "calcTips", "totalDue", "displayableTotal", "balance", "cashRoundingDelta",
      "cashRoundedBalance", "cashRoundedTotal", "shipCost", "shipVendorCost", "otherCost",
      "otherVendorCost", "totalDiscount", "subTotalCost", "totalCost", "discountMoneyValue",
      "discountMoneyVendorValue", "quantity", "price", "originalPrice", "vendorCost", "checkedIn",
      "numReceived", "shippingCost", "shippingVendorCost", "tax1Rate", "tax2Rate", "qohChange",
      "costChange",
    ]) {
      if (field in fields) {
        moneyFields[field] = [fields[field], fields.vendorCurrencyCode ?? fields.currency];
      }
    }
    const normalizationIssues = Object.entries(moneyFields)
      .filter(([, [value, currency]]) => value != null && normalizeDecimal(value, currency).exact === null)
      .map(([field]) => ({
        code: "normalization_invalid" as const,
        path: field,
        message: "The monetary or quantity value is not a valid exact decimal.",
      }));
    const issues = [
      ...drift.map((field) => ({
        code: "schema_drift" as const,
        path: field,
        message: "The vendor returned a field without an approved coverage disposition.",
      })),
      ...normalizationIssues,
    ];
    return {
      sourceObjectType: config.resource,
      sourceRecordId: String(fields[config.recordIdField]),
      sourceUpdatedAt: timestamp.utc ?? undefined,
      payload: raw,
      payloadHash,
      normalized: normalizationIssues.length === 0
        ? projectSourceRecord({
            schemaVersion: this.version,
            fields: approvedFields,
            money: moneyFields,
            timestamps: config.modifiedField
              ? { [config.modifiedField]: [fields[config.modifiedField], undefined] }
              : undefined,
            tombstone: truthy(fields.archived),
          })
        : undefined,
      validationIssues: issues.length > 0 ? issues : undefined,
    };
  }

  private validateContinuation(value: string, accountId: string, endpoint: string): URL {
    const url = new URL(value);
    const prefix = `/API/V3/Account/${encodeURIComponent(accountId)}/`;
    if (
      url.origin !== API_ORIGIN ||
      !url.pathname.startsWith(prefix) ||
      !url.pathname.endsWith(endpoint)
    ) {
      throw new ConnectorError(
        "REMOTE_RESPONSE_INVALID",
        "Lightspeed returned an unsafe pagination URL.",
      );
    }
    return url;
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
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: current.secret.refreshToken,
    });
    const { value } = await requestJson<unknown>(
      this.fetcher,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
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
