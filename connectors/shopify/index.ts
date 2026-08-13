import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  AuthorizationOnlyConnectorPack,
  ConnectorError,
  ConnectorHttpError,
  fetchWithRetry,
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
  type FetchLike,
  type HttpRetryOptions,
  type OAuthConnectorPack,
  type OAuthCredentialSecret,
  type OAuthExchangeResult,
  type ReconciliationRequest,
  type SyncCursor,
  type SyncPage,
  type SyncRange,
  type VersionedCredential,
  type WebhookDisposition,
  type WebhookEnvelope,
  type WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index.js";
import { extractShopifyPage, type ShopifyGraphqlResult } from "./extract.js";
import {
  SHOPIFY_ALLOWED_SCOPES,
  SHOPIFY_API_VERSION,
  SHOPIFY_DEFAULT_SCOPES,
  normalizeShopifyShopDomain,
  shopifyManifest,
} from "./manifest.js";
import { buildShopifyAuthorizationUrl } from "./oauth-public.js";
import type { ShopifyStreamId } from "./streams.js";
import type { ShopifyQLCompiledQuery } from "./shopifyql-query.js";
import { SHOPIFYQL_MAX_RESPONSE_BYTES } from "../../packages/shopifyql/src/contract.js";
import {
  SHOPIFY_ADMIN_MAX_RESPONSE_BYTES,
} from "../../packages/shopify-admin/src/contract.js";
import {
  compileShopifyAdminQuery,
  type ShopifyAdminCompiledQuery,
} from "./admin-query.js";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().optional(),
  expires_in: z.coerce.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.coerce.number().positive().optional(),
}).passthrough();

const graphQlEnvelopeSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z.array(z.object({
    message: z.string(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  }).passthrough()).default([]),
  extensions: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const shopSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  myshopifyDomain: z.string().min(1),
  email: z.string().nullable().optional(),
  currencyCode: z.string().nullable().optional(),
  ianaTimezone: z.string().nullable().optional(),
  plan: z.object({ displayName: z.string().nullable().optional() }).nullable().optional(),
}).passthrough();

const shopifyQLTableSchema = z.object({
  columns: z.array(z.object({
    columnOrigin: z.string().min(1),
    dataType: z.string().min(1),
    displayName: z.string(),
    dynamicColumnMetadata: z.object({
      aggregatedBy: z.array(z.string()),
      comparisonReference: z.string().nullable(),
      originalColumnName: z.string().nullable(),
      type: z.string().min(1),
    }).strict().nullable(),
    name: z.string().min(1),
    shortDisplayName: z.string().nullable(),
    subType: z.string().nullable(),
  }).strict()),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowMetadata: z.array(z.object({
    nullCellTranslations: z.array(z.object({
      columnName: z.string(),
      displayText: z.string(),
    }).strict()),
    rawResourceIds: z.array(z.array(z.string())),
    topNRemainderColumnNames: z.array(z.string()),
  }).strict()),
}).strict();

const shopifyQLResponseSchema = z.object({
  parseErrors: z.array(z.string()),
  tableData: shopifyQLTableSchema.nullable(),
}).strict();

export type ShopifyQLExecutionResult = z.infer<typeof shopifyQLResponseSchema>;

const shopifyAdminAccessEnvelopeSchema = z.object({
  _albertAccess: z.object({
    accessScopes: z.array(z.object({ handle: z.string().regex(/^read_[a-z0-9_]+$/u) }).strict()).max(500),
  }).strict(),
  result: z.unknown(),
}).passthrough();

export type ShopifyAdminExecutionResult = Readonly<{
  data: unknown;
  liveGrantedScopes: readonly string[];
}>;

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

/** Verifies Shopify's callback HMAC over the exact sorted query string. */
export function verifyShopifyCallbackHmac(
  query: URLSearchParams,
  clientSecret: string,
): boolean {
  const received = query.get("hmac");
  if (!received || !/^[0-9a-f]{64}$/u.test(received)) return false;
  const message = [...query.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .map(([key, value]) => [key, value] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = createHmac("sha256", clientSecret).update(message, "utf8").digest();
  const actual = Buffer.from(received, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Production Shopify Admin GraphQL pack.
 *
 * Credential lease/rotation mechanics are inherited from the SDK's hardened
 * credential base; every authorization-only extraction method is overridden
 * here and backed by the versioned manifest. This keeps token CAS semantics in
 * one place while Shopify becomes a full data connector.
 */
export class ShopifyConnector extends AuthorizationOnlyConnectorPack implements OAuthConnectorPack {
  readonly id = "shopify" as const;
  readonly manifest = shopifyManifest;

  protected readonly vault: WorkerCredentialVault;
  protected readonly clock: () => number;
  private readonly config: ShopifyConnectorConfig;
  private readonly fetcher: FetchLike;
  private readonly shopDomain: string;
  private readonly observedStreams = new Set<string>();

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
      throw new ConnectorError("CONFIGURATION_INVALID", `Unsupported Shopify access scope requested: ${unsupported.join(", ")}.`);
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
    const parsed = await this.tokenRequest({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code: required(request.code, "Shopify authorization code"),
      // Required for public apps created after 2026-04-01 and for all public
      // apps from 2027-01-01. Custom apps can still return the same safe shape.
      expiring: 1,
    }, request.abortSignal, "Shopify returned an invalid OAuth token response.");
    this.assertExpiringOfflineToken(parsed, "authorization exchange");
    const scopes = splitOAuthScopes(parsed.scope?.replaceAll(",", " "));
    const missingScopes = SHOPIFY_DEFAULT_SCOPES.filter((scope) => !scopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new ConnectorError(
        "OAUTH_EXCHANGE_FAILED",
        `Shopify did not grant the required read scopes: ${missingScopes.join(", ")}.`,
      );
    }
    const stored = await this.vault.create(this.credentialSecret(parsed, scopes));
    return { credentialRef: stored.credentialRef, expiresAt: stored.secret.expiresAt, scopes: stored.secret.scopes };
  }

  async check_connection(context: ConnectorContext): Promise<ConnectionHealth> {
    try {
      await this.discover_account(context);
      return "healthy";
    } catch (error) {
      if (error instanceof ConnectorHttpError && error.status === 401) return "expired";
      if (error instanceof ConnectorHttpError && error.status === 403) return "degraded";
      if (error instanceof ConnectorError && error.code === "CAPABILITY_UNAVAILABLE") return "degraded";
      throw error;
    }
  }

  async discover_accounts(context: ConnectorContext): Promise<readonly ConnectionDiscovery[]> {
    return [await this.discover_account(context)];
  }

  async discover_account(context: ConnectorContext): Promise<ConnectionDiscovery> {
    const credential = await this.validCredential(context);
    const result = await this.graphql(context, credential, `query AlbertShopIdentity {
      shop { id name myshopifyDomain email currencyCode ianaTimezone plan { displayName } }
    }`, {});
    const parsed = shopSchema.safeParse(result.data.shop);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Shopify returned an invalid GraphQL shop identity.", { cause: parsed.error });
    }
    const resolved = normalizeShopifyShopDomain(parsed.data.myshopifyDomain);
    const credentialShop = this.credentialShop(credential);
    if (resolved !== credentialShop || resolved !== this.shopDomain) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Shopify returned a shop that does not match the bound grant.");
    }
    return {
      externalAccountId: resolved,
      displayName: parsed.data.name?.trim() || resolved,
      metadata: {
        shopDomain: resolved,
        shopId: parsed.data.id,
        currency: parsed.data.currencyCode ?? null,
        timezone: parsed.data.ianaTimezone ?? null,
        planName: parsed.data.plan?.displayName ?? null,
      },
    };
  }

  /**
   * Executes only a trusted, registry-compiled ShopifyQL document. The access
   * token remains inside this credential-owning connector and never enters the
   * web runtime, Cube, or model context.
   */
  async execute_shopifyql(
    context: ConnectorContext,
    compiled: ShopifyQLCompiledQuery,
  ): Promise<ShopifyQLExecutionResult> {
    if (compiled.apiVersion !== SHOPIFY_API_VERSION) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        `ShopifyQL compiler API ${compiled.apiVersion} does not match connector API ${SHOPIFY_API_VERSION}.`,
      );
    }
    const credential = await this.validCredential(context);
    if (!credential.secret.scopes.includes("read_reports")) {
      throw new ConnectorError(
        "CAPABILITY_UNAVAILABLE",
        "The Shopify grant does not include the required read_reports scope.",
        { details: { apiVersion: SHOPIFY_API_VERSION, requiredScope: "read_reports" } },
      );
    }
    const result = await this.graphql(context, credential, `query AlbertShopifyQL($query: String!) {
      shopifyqlQuery(query: $query) {
        parseErrors
        tableData {
          columns {
            columnOrigin
            dataType
            displayName
            dynamicColumnMetadata {
              aggregatedBy
              comparisonReference
              originalColumnName
              type
            }
            name
            shortDisplayName
            subType
          }
          rows
          rowMetadata {
            nullCellTranslations { columnName displayText }
            rawResourceIds
            topNRemainderColumnNames
          }
        }
      }
    }`, { query: compiled.query }, SHOPIFYQL_MAX_RESPONSE_BYTES);
    const parsed = shopifyQLResponseSchema.safeParse(result.data.shopifyqlQuery);
    if (!parsed.success) {
      throw new ConnectorError(
        "REMOTE_RESPONSE_INVALID",
        "Shopify returned an invalid ShopifyQL response.",
        { cause: parsed.error },
      );
    }
    if (parsed.data.tableData && parsed.data.tableData.rowMetadata.length !== parsed.data.tableData.rows.length) {
      throw new ConnectorError(
        "REMOTE_RESPONSE_INVALID",
        "ShopifyQL row metadata is not aligned with its rows.",
      );
    }
    if (!parsed.data.tableData) return parsed.data;
    // rawResourceIds are Shopify's internal row-linkage identifiers. They are
    // not needed to answer analytical questions and can identify protected
    // customer/order resources, so strip them at the credential boundary.
    return {
      ...parsed.data,
      tableData: {
        ...parsed.data.tableData,
        rowMetadata: parsed.data.tableData.rowMetadata.map((metadata) => ({
          ...metadata,
          rawResourceIds: [],
        })),
      },
    };
  }

  /**
   * Executes a schema-registry-recompiled, read-only Admin query. The compiler
   * injects a live granted-scope proof into the same Shopify operation, so a
   * stale OAuth metadata row cannot authorize a field by itself.
   */
  async execute_admin_query(
    context: ConnectorContext,
    candidate: ShopifyAdminCompiledQuery,
  ): Promise<ShopifyAdminExecutionResult> {
    const compiled = compileShopifyAdminQuery(candidate.normalizedInput);
    if (
      compiled.apiVersion !== SHOPIFY_API_VERSION
      || compiled.registrySha256 !== candidate.registrySha256
      || compiled.queryDigest !== candidate.queryDigest
    ) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        "The Shopify Admin query did not match the pinned registry compiler output.",
      );
    }
    const credential = await this.validCredential(context);
    const metadataScopes = new Set(credential.secret.scopes);
    const missingMetadata = compiled.requiredScopeGroups
      .filter((group) => !group.some((scope) => metadataScopes.has(scope)));
    if (missingMetadata.length > 0) {
      throw new ConnectorError(
        "CAPABILITY_UNAVAILABLE",
        "The stored Shopify grant metadata does not satisfy every scope requirement for the selected fields.",
        { details: { apiVersion: SHOPIFY_API_VERSION, missingScopes: missingMetadata.map((group) => group.join("|")).join(",") } },
      );
    }
    const response = await this.graphql(
      context,
      credential,
      compiled.query,
      compiled.variables,
      SHOPIFY_ADMIN_MAX_RESPONSE_BYTES,
    );
    const parsed = shopifyAdminAccessEnvelopeSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new ConnectorError(
        "REMOTE_RESPONSE_INVALID",
        "Shopify returned an invalid governed Admin query envelope.",
        { cause: parsed.error },
      );
    }
    const liveGrantedScopes = [...new Set(parsed.data._albertAccess.accessScopes.map(({ handle }) => handle))].sort();
    const live = new Set(liveGrantedScopes);
    const missingLive = compiled.requiredScopeGroups
      .filter((group) => !group.some((scope) => live.has(scope)));
    if (missingLive.length > 0) {
      throw new ConnectorError(
        "CAPABILITY_UNAVAILABLE",
        "Shopify's current app installation does not satisfy every scope requirement for the selected fields.",
        { details: { apiVersion: SHOPIFY_API_VERSION, missingScopes: missingLive.map((group) => group.join("|")).join(",") } },
      );
    }
    return Object.freeze({ data: parsed.data.result, liveGrantedScopes });
  }

  async select_account(context: ConnectorContext, externalAccountId: string): Promise<ConnectionDiscovery> {
    const account = await this.discover_account(context);
    if (normalizeShopifyShopDomain(externalAccountId) !== account.externalAccountId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "A Shopify grant belongs to exactly one shop.");
    }
    return account;
  }

  async list_streams(context: ConnectorContext): Promise<readonly ConnectorStream[]> {
    void context;
    return this.manifest.streams.map((stream, priority) => ({
      id: stream.id,
      label: stream.resource,
      domains: stream.productDomains,
      cursorKind: stream.modifiedField ? "high_water_mark" as const
        : stream.pagination === "none" ? "none" as const : "page" as const,
      backfillStrategy: stream.backfillStrategy,
      lateEditStrategy: stream.lateEditStrategy,
      deletionStrategy: stream.deletionStrategy,
      sourceTotalStrategy: stream.sourceTotalStrategy,
      availability: stream.availability ?? "required",
      dependencies: stream.dependencies,
      productDomains: stream.productDomains,
      priority,
    }));
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
      return { records: [], hasMore: false, nextCursor: request.cursor ?? null, sourceTotal: 0 };
    }
    return this.sync(context, stream, "reconciliation", request.cursor, request.range, request.phase);
  }

  async handle_webhook(context: ConnectorContext, event: WebhookEnvelope): Promise<WebhookDisposition> {
    const signature = header(event.headers, "x-shopify-hmac-sha256");
    const receivedShop = header(event.headers, "x-shopify-shop-domain");
    const topic = header(event.headers, "x-shopify-topic")?.toLowerCase();
    const webhookId = header(event.headers, "x-shopify-webhook-id");
    if (!signature || !receivedShop || !topic || !webhookId) {
      throw new ConnectorError("WEBHOOK_SIGNATURE_INVALID", "Shopify webhook identity headers are incomplete.");
    }
    const expected = createHmac("sha256", this.config.clientSecret).update(event.body).digest();
    let actual: Buffer;
    try { actual = Buffer.from(signature, "base64"); } catch { actual = Buffer.alloc(0); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ConnectorError("WEBHOOK_SIGNATURE_INVALID", "Shopify webhook HMAC is invalid.");
    }
    const credential = await this.readCredential(context);
    if (normalizeShopifyShopDomain(receivedShop) !== this.credentialShop(credential)) {
      return { accepted: false, streams: [], reason: "shop_domain_mismatch" };
    }
    const lifecycleTopic = topic === "app/uninstalled"
      || topic === "customers/data_request"
      || topic === "customers/redact"
      || topic === "shop/redact";
    // Mandatory privacy/lifecycle webhooks are accepted for the dedicated
    // compliance boundary, but must never trigger a fresh data extraction.
    const streams = lifecycleTopic ? [] : webhookStreams(topic);
    let payload: Record<string, unknown> = {};
    try {
      const decoded: unknown = JSON.parse(new TextDecoder().decode(event.body));
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) payload = decoded as Record<string, unknown>;
    } catch (cause) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Shopify webhook body is not valid JSON.", { cause });
    }
    const deletion = topic.endsWith("/delete") || topic.endsWith("/deleted");
    const sourceRecordId = typeof payload.admin_graphql_api_id === "string"
      ? payload.admin_graphql_api_id
      : typeof payload.id === "string" || typeof payload.id === "number" ? String(payload.id) : null;
    const deletionObjectType = webhookObjectType(topic);
    const tombstoneStreams = deletion
      ? streams.filter((stream) => this.manifest.streams.some((contract) =>
        contract.id === stream && contract.resource === deletionObjectType
      ))
      : [];
    return {
      accepted: streams.length > 0 || lifecycleTopic,
      dedupeKey: `shopify:${webhookId}`,
      streams,
      externalAccountIds: [this.credentialShop(credential)],
      ...(deletion && sourceRecordId && tombstoneStreams.length > 0 ? {
        // One webhook can fan out to parent/child refresh streams, but it only
        // proves deletion of the object named by the topic. Child identities
        // are removed by their authoritative reconciliation scan, never by a
        // fabricated parent ID at the wrong grain.
        reconciliationSignals: tombstoneStreams.map((stream) => ({
          kind: "tombstone" as const,
          stream,
          sourceObjectType: deletionObjectType,
          sourceRecordId,
          observedAt: event.receivedAt,
        })),
      } : {}),
      ...(lifecycleTopic ? { reason: "compliance_or_lifecycle_topic" } :
        streams.length === 0 ? { reason: "unmapped_topic" } : {}),
    };
  }

  async describe_capabilities(context: ConnectorContext): Promise<readonly ConnectorCapability[]> {
    const credential = await this.readCredential(context);
    const scopes = new Set(credential.secret.scopes);
    const support = (
      id: ConnectorCapability["id"],
      requiredScopes: readonly string[],
      streams: readonly ShopifyStreamId[],
      partial = false,
    ): ConnectorCapability => {
      const granted = requiredScopes.every((scope) => scopes.has(scope));
      const observed = streams.every((stream) => this.observedStreams.has(`${context.connectionId}:${stream}`));
      return {
        id,
        support: !granted ? "unavailable" : observed ? (partial ? "partial" : "full") : "unknown",
        reasonCode: !granted ? "required_scope_missing" : observed ? "live_stream_observed" : "live_probe_required",
        requiredScopes,
      };
    };
    return [
      support("commerce.orders", ["read_orders"], ["shopify_orders"]),
      support("commerce.orders.customer", ["read_orders", "read_customers"], ["shopify_orders", "shopify_customers"], true),
      support("commerce.order_lines", ["read_orders"], ["shopify_order_lines"]),
      support("commerce.order_lines.discounts", ["read_orders"], ["shopify_order_lines"]),
      { id: "commerce.order_lines.cost", support: "unavailable", reasonCode: "historical_cost_not_exposed", notes: "Current inventory cost is not a historical order-line cost; use ShopifyQL profitability when approved." },
      support("commerce.payments", ["read_orders"], ["shopify_transactions"]),
      support("commerce.refunds", ["read_orders"], ["shopify_refund_lines"]),
      support("inventory.balances", ["read_inventory"], ["shopify_inventory_levels"]),
      support("inventory.cost", ["read_inventory"], ["shopify_product_variants"], true),
      { id: "inventory.movements", support: "unavailable", reasonCode: "movement_history_not_materialized", notes: "The current pack reconciles inventory-level states only and never infers historical movements from snapshot deltas." },
      { id: "source.webhooks", support: "unavailable", reasonCode: "operational_subscriptions_not_configured", notes: "Mandatory compliance and uninstall webhooks are isolated from ingestion. No operational data subscriptions are configured; scheduled API polling and reconciliation are authoritative." },
    ];
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    // Shopify documents no OAuth token-revocation endpoint. Local destruction
    // prevents all future Albert use; uninstall is the merchant-side revocation.
    await this.vault.destroy(context.credentialRef);
  }

  protected async renewCredential(current: VersionedCredential, signal?: AbortSignal): Promise<OAuthCredentialSecret> {
    if (!current.secret.refreshToken) {
      throw new ConnectorError("AUTHENTICATION_REQUIRED", "The Shopify offline token cannot be refreshed; reconnect the shop.");
    }
    const parsed = await this.tokenRequest({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: current.secret.refreshToken,
    }, signal, "Shopify returned an invalid refresh-token response.");
    this.assertExpiringOfflineToken(parsed, "refresh exchange");
    const returnedScopes = splitOAuthScopes(parsed.scope?.replaceAll(",", " "));
    return this.credentialSecret(
      parsed,
      returnedScopes.length > 0 ? returnedScopes : current.secret.scopes,
      current.secret.metadata,
      undefined,
    );
  }

  private async sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
    reconciliationPhase?: ReconciliationRequest["phase"],
  ): Promise<SyncPage> {
    if (!this.manifest.streams.some((candidate) => candidate.id === stream.id)) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Unknown Shopify stream: ${stream.id}.`);
    }
    const credential = await this.validCredential(context);
    const page = await extractShopifyPage({
      stream: stream.id as ShopifyStreamId,
      mode,
      range,
      cursor,
      reconciliationPhase,
      now: this.clock,
      readAllOrders: credential.secret.scopes.includes("read_all_orders"),
      call: (query, variables) => this.graphql(context, credential, query, variables),
    });
    this.observedStreams.add(`${context.connectionId}:${stream.id}`);
    return page;
  }

  private async graphql(
    context: ConnectorContext,
    credential: VersionedCredential,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    maxResponseBytes?: number,
  ): Promise<ShopifyGraphqlResult> {
    const shop = this.credentialShop(credential);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const endpoint = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
      const init = {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-shopify-access-token": credential.secret.accessToken,
          },
          body: JSON.stringify({ query, variables }),
          signal: context.abortSignal,
        } satisfies RequestInit;
      const retry = withVendorRateBudget(this.config.retry, context.vendorRateBudget);
      let value: unknown;
      let response: Response;
      if (maxResponseBytes !== undefined) {
        response = await fetchWithRetry(this.fetcher, endpoint, init, retry);
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (Number.isFinite(declared) && declared > maxResponseBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Shopify response exceeded the governed byte limit.");
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > maxResponseBytes) {
          throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Shopify response exceeded the governed byte limit.");
        }
        try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch (cause) {
          throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Shopify returned malformed JSON.", { cause });
        }
      } else {
        ({ value, response } = await requestJson<unknown>(this.fetcher, endpoint, init, retry));
      }
      const servedVersion = response.headers.get("x-shopify-api-version");
      if (servedVersion && servedVersion !== SHOPIFY_API_VERSION) {
        throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Shopify served API ${servedVersion}; the connector is pinned to ${SHOPIFY_API_VERSION}.`);
      }
      const parsed = graphQlEnvelopeSchema.safeParse(value);
      if (!parsed.success) {
        throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Shopify returned an invalid GraphQL response envelope.", { cause: parsed.error });
      }
      const throttled = parsed.data.errors.some((error) => graphQlErrorCode(error.extensions) === "THROTTLED");
      if (throttled && attempt < 4) {
        await delay(graphQlRetryDelay(parsed.data.extensions), context.abortSignal);
        continue;
      }
      if (!parsed.data.data) {
        const message = parsed.data.errors.map((error) => error.message).join("; ") || "Shopify returned no GraphQL data.";
        if (throttled) throw new ConnectorError("RATE_LIMITED", message, { retryable: true, retryAfterMs: graphQlRetryDelay(parsed.data.extensions) });
        if (parsed.data.errors.some((error) => /access denied|permission|scope|not available on this shop/iu.test(error.message))) {
          throw new ConnectorError("CAPABILITY_UNAVAILABLE", message, { details: { shop, apiVersion: SHOPIFY_API_VERSION } });
        }
        throw new ConnectorError("REMOTE_RESPONSE_INVALID", message);
      }
      // GraphQL may return HTTP 200 and partial data together with errors. A
      // partial page cannot satisfy Albert's source-total or field-coverage
      // claims, so never persist it as a successful complete page. Capability
      // failures remain explicit (and therefore answerable) instead of being
      // misrepresented downstream as null or zero.
      if (parsed.data.errors.length > 0) {
        const message = parsed.data.errors.map((error) => error.message).join("; ");
        if (throttled) {
          throw new ConnectorError("RATE_LIMITED", message, {
            retryable: true,
            retryAfterMs: graphQlRetryDelay(parsed.data.extensions),
          });
        }
        if (parsed.data.errors.some((error) =>
          /access denied|permission|scope|not available on this shop/iu.test(error.message)
        )) {
          throw new ConnectorError("CAPABILITY_UNAVAILABLE", message, {
            details: { shop, apiVersion: SHOPIFY_API_VERSION },
          });
        }
        throw new ConnectorError("REMOTE_RESPONSE_INVALID", message);
      }
      return { data: parsed.data.data, errors: parsed.data.errors };
    }
    throw new ConnectorError("RATE_LIMITED", "Shopify GraphQL remained throttled after bounded retries.", { retryable: true });
  }

  private credentialShop(credential: VersionedCredential): string {
    const value = credential.secret.metadata.shopDomain;
    if (typeof value !== "string") throw new ConnectorError("CONFIGURATION_INVALID", "Shopify credential is missing its bound shop domain.");
    const normalized = normalizeShopifyShopDomain(value);
    if (normalized !== this.shopDomain) throw new ConnectorError("CONFIGURATION_INVALID", "Shopify credential shop does not match this connector instance.");
    return normalized;
  }

  private async tokenRequest(
    body: Readonly<Record<string, string | number>>,
    signal: AbortSignal | undefined,
    invalidMessage: string,
  ): Promise<z.infer<typeof tokenSchema>> {
    const { value } = await requestJson<unknown>(
      this.fetcher,
      `https://${this.shopDomain}/admin/oauth/access_token`,
      {
        method: "POST",
        // Shopify's authorization-code and refresh-token contracts require
        // form encoding. Admin GraphQL itself remains JSON encoded.
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])).toString(),
        signal,
      },
      this.config.retry,
    );
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) throw new ConnectorError("OAUTH_EXCHANGE_FAILED", invalidMessage, { cause: parsed.error });
    return parsed.data;
  }

  private credentialSecret(
    token: z.infer<typeof tokenSchema>,
    scopes: readonly string[],
    priorMetadata: OAuthCredentialSecret["metadata"] = {},
    priorRefreshToken?: string,
  ): OAuthCredentialSecret {
    const expiresIn = token.expires_in ?? 3_600;
    const refreshTokenExpiresAt = token.refresh_token_expires_in
      ? new Date(this.clock() + token.refresh_token_expires_in * 1_000).toISOString()
      : priorMetadata.refreshTokenExpiresAt ?? null;
    return {
      provider: this.id,
      accessToken: token.access_token,
      ...(token.refresh_token
        ? { refreshToken: token.refresh_token }
        : priorRefreshToken
          ? { refreshToken: priorRefreshToken }
          : {}),
      tokenType: "Bearer",
      expiresAt: new Date(this.clock() + expiresIn * 1_000).toISOString(),
      scopes: scopes.length > 0 ? scopes : SHOPIFY_DEFAULT_SCOPES,
      metadata: { ...priorMetadata, shopDomain: this.shopDomain, refreshTokenExpiresAt },
    };
  }

  private assertExpiringOfflineToken(
    token: z.infer<typeof tokenSchema>,
    operation: string,
  ): void {
    if (
      !token.refresh_token
      || token.expires_in === undefined
      || token.refresh_token_expires_in === undefined
    ) {
      throw new ConnectorError(
        "OAUTH_EXCHANGE_FAILED",
        `Shopify ${operation} did not return the required expiring offline access and rotated refresh-token lifetimes.`,
      );
    }
  }
}

function graphQlErrorCode(extensions: Readonly<Record<string, unknown>> | undefined): string | null {
  return typeof extensions?.code === "string" ? extensions.code : null;
}

function graphQlRetryDelay(extensions: Readonly<Record<string, unknown>> | undefined): number {
  const cost = record(extensions?.cost);
  const throttle = record(cost?.throttleStatus);
  const requested = number(cost?.requestedQueryCost) ?? 100;
  const available = number(throttle?.currentlyAvailable) ?? 0;
  const restore = number(throttle?.restoreRate) ?? 100;
  return Math.min(30_000, Math.max(500, Math.ceil(((requested - available) / Math.max(1, restore)) * 1_000) + 250));
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | null {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1] ?? null;
}

function webhookStreams(topic: string): readonly string[] {
  if (topic.startsWith("orders/")) return ["shopify_orders", "shopify_order_lines"];
  if (topic.startsWith("order_transactions/")) return ["shopify_transactions"];
  if (topic.startsWith("refunds/") || topic.startsWith("returns/")) return ["shopify_refund_lines", "shopify_returns"];
  if (topic.startsWith("fulfillments/") || topic.startsWith("fulfillment_orders/")) return ["shopify_fulfillments"];
  if (topic.startsWith("products/")) return ["shopify_products", "shopify_product_variants"];
  if (topic.startsWith("customers/")) return ["shopify_customers"];
  if (topic.startsWith("inventory_items/") || topic.startsWith("inventory_levels/")) return ["shopify_inventory_levels"];
  if (topic.startsWith("locations/")) return ["shopify_locations"];
  if (topic.startsWith("discounts/")) return ["shopify_discounts"];
  return [];
}

function webhookObjectType(topic: string): string {
  const subject = topic.split("/", 1)[0] ?? "resource";
  return subject.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("").replace(/s$/u, "");
}

export { shopifyManifest } from "./manifest.js";
