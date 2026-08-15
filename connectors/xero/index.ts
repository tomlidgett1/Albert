import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  ConcurrencyLimiter,
  ConnectorError,
  ConnectorHttpError,
  credentialExpiresSoon,
  decodeCursor,
  encodeCursor,
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
import { XERO_ALLOWED_SCOPES, XERO_DEFAULT_SCOPES, xeroManifest } from "./manifest";
import { buildXeroAuthorizationUrl } from "./oauth-public";
import { xeroEnvelopeSchemas, xeroSchemas, type XeroStreamId } from "./schemas";
import {
  XERO_API_PROFILES,
  baseParams,
  endpointPath,
  extraParamPasses,
  fanOutAncestry,
  fanOutCarrying,
  fanOutSkippable,
  fillFanOutPath,
  projectStreamRows,
  resolveFanOutIds,
  scanGroupFor,
  specTableFor,
  templatedParents,
  unwrapEnvelope,
  type XeroTemplatedParent,
} from "./spec-sync.js";
import { xeroSourceField, type XeroSpecTable } from "./scan-plan.js";
import { XERO_STREAMS, type XeroStream } from "./streams.js";

const TOKEN_ENDPOINT = "https://identity.xero.com/connect/token";
const REVOCATION_ENDPOINT = "https://identity.xero.com/connect/revocation";
const CONNECTIONS_ENDPOINT = "https://api.xero.com/connections";
const ACCOUNTING_ORIGIN = "https://api.xero.com";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number().positive(),
  token_type: z.string().default("Bearer"),
  scope: z.union([z.string(), z.array(z.string())]).optional(),
});

const connectionSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  tenantType: z.string(),
  // Xero documents tenantName as null for non-organisation connections (for
  // example PRACTICEMANAGER). Parse the complete connection list before
  // filtering to organisations without rejecting an otherwise valid grant.
  tenantName: z.string().nullable(),
  createdDateUtc: z.string().optional(),
  updatedDateUtc: z.string().optional(),
}).passthrough();

const webhookSchema = z.object({
  events: z.array(z.object({
    resourceUrl: z.string().url(),
    resourceId: z.string().min(1),
    eventDateUtc: z.string(),
    eventType: z.string(),
    eventCategory: z.string(),
    tenantId: z.string().min(1),
    tenantType: z.string(),
  }).passthrough()),
  firstEventSequence: z.number().int().nonnegative(),
  lastEventSequence: z.number().int().nonnegative(),
  entropy: z.string(),
}).passthrough();

export type XeroConnectorConfig = Readonly<{
  clientId: string;
  /** Kept as an explicit pin; Albert V1 does not support hybrid/confidential mode. */
  oauthMode?: "pkce";
  /** Required only by a process that accepts Xero webhooks. */
  webhookSigningKey?: string;
  vault: WorkerCredentialVault;
  fetcher?: FetchLike;
  retry?: HttpRetryOptions;
  now?: () => number;
}>;

/**
 * Scan ordering: reference configuration first, then document walks, then
 * derived and fan-out streams behind whatever they ride. Computed from the
 * spec so a new stream can never be silently unordered.
 */
const streamPriority: Readonly<Record<string, number>> = (() => {
  const priorities: Record<string, number> = {};
  const CORE_FIRST = [
    "xero_organisations", "xero_connections", "xero_accounts", "xero_tax_rates",
    "xero_currencies", "xero_tracking_categories", "xero_branding_themes", "xero_items",
    "xero_contacts",
  ];
  CORE_FIRST.forEach((id, index) => { priorities[id] = 10 + index; });
  let next = 40;
  for (const stream of XERO_STREAMS) {
    if (priorities[stream.id] !== undefined) continue;
    if (stream.isScanLeader) priorities[stream.id] = next++;
  }
  for (const stream of XERO_STREAMS) {
    if (priorities[stream.id] !== undefined) continue;
    const anchor = stream.dependencies[0];
    priorities[stream.id] = (anchor !== undefined ? (priorities[anchor] ?? next) : next) + 200;
  }
  return priorities;
})();

/**
 * Business-date field used to slice deep initial history into windows, for
 * every time-windowed stream (the spec guarantees a `Date` column on them).
 */
const eventDateField: Readonly<Record<string, string>> = Object.fromEntries(
  XERO_STREAMS.filter((stream) => stream.backfillStrategy === "time_windowed")
    .map((stream) => [stream.id, "Date"]),
);

function required(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new ConnectorError("CONFIGURATION_INVALID", `${name} is required.`);
  }
  return value;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1];
}

function latestTimestamp(values: readonly (string | undefined)[], fallback?: string): string | undefined {
  return values.reduce<string | undefined>((latest, value) => {
    if (!value || !Number.isFinite(Date.parse(value))) return latest;
    return !latest || Date.parse(value) > Date.parse(latest) ? value : latest;
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

function xeroDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ConnectorError("CURSOR_INVALID", "Xero sync time is invalid.");
  }
  return `DateTime(${date.getUTCFullYear()},${date.getUTCMonth() + 1},${date.getUTCDate()},${date.getUTCHours()},${date.getUTCMinutes()},${date.getUTCSeconds()})`;
}

function extendXeroScanDigest(
  priorDigest: string | undefined,
  records: readonly RawSourceRecord[],
): string {
  const hash=createHash("sha256");
  hash.update(priorDigest ?? "xero-bounded-page-scan-v1");
  for (const record of records) {
    for (const value of [record.sourceObjectType,record.sourceRecordId,record.payloadHash]) {
      hash.update(String(Buffer.byteLength(value,"utf8")));
      hash.update(":");
      hash.update(value);
      hash.update(";");
    }
  }
  return hash.digest("hex");
}

/**
 * The value of a fan-out parameter, taken from the nearest ancestor record that
 * carries it. Sub-resources are addressed by ids that may live several links up
 * the chain (a working week is reached through its pattern and its employee).
 */
function readFanOutParam(ancestors: readonly unknown[], param: string): string | null {
  if (!param) return null;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const record = ancestors[index];
    if (record === null || record === undefined || typeof record !== "object") continue;
    const value = (record as Record<string, unknown>)[param];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text.length > 0) return text;
  }
  return null;
}

function basicAuth(clientId: string, clientSecret = ""): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

export class XeroConnector implements OAuthConnectorPack {
  readonly id = "xero" as const;
  readonly version = xeroManifest.packVersion;
  readonly apiVersion = xeroManifest.apiVersion;
  readonly manifest = xeroManifest;

  private readonly config: XeroConnectorConfig;
  private readonly fetcher: FetchLike;
  private readonly concurrency = new ConcurrencyLimiter(5);
  private readonly refreshes = new Map<string, Promise<VersionedCredential>>();
  private readonly successfulStreams = new Set<string>();

  constructor(config: XeroConnectorConfig) {
    if ((config as Readonly<{ oauthMode?: unknown }>).oauthMode && config.oauthMode !== "pkce") {
      throw new ConnectorError("CONFIGURATION_INVALID", "Albert's Xero pack is pinned to PKCE OAuth.");
    }
    this.config = {
      ...config,
      clientId: required(config.clientId, "Xero client ID"),
      ...(config.webhookSigningKey
        ? { webhookSigningKey: required(config.webhookSigningKey, "Xero webhook signing key") }
        : {}),
      oauthMode: "pkce",
    };
    this.fetcher = config.fetcher ?? fetch;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    const scopes = request.scopes.length > 0 ? request.scopes : XERO_DEFAULT_SCOPES;
    const unsupported = scopes.filter(
      (scope) => !XERO_ALLOWED_SCOPES.includes(scope as (typeof XERO_ALLOWED_SCOPES)[number]),
    );
    if (unsupported.length > 0) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        `Unsupported Xero scope requested: ${unsupported.join(", ")}.`,
      );
    }
    if (!request.codeChallenge) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Xero PKCE requires a code challenge.");
    }
    return {
      url: buildXeroAuthorizationUrl({
        clientId: this.config.clientId,
        state: request.state,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge ?? "",
        scopes,
      }),
      expiresAt: new Date((this.config.now?.() ?? Date.now()) + 5 * 60_000).toISOString(),
    };
  }

  async exchange_authorization_code(
    request: AuthorizationCodeExchange,
  ): Promise<OAuthExchangeResult> {
    if (!request.codeVerifier) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Xero PKCE requires the original code verifier.");
    }
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      code: required(request.code, "Xero authorization code"),
      redirect_uri: request.redirectUri,
    });
    if (request.codeVerifier) body.set("code_verifier", request.codeVerifier);
    const { value } = await requestJson<unknown>(
      this.fetcher,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          authorization: basicAuth(this.config.clientId),
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
        signal: request.abortSignal,
      },
      this.config.retry,
    );
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("OAUTH_EXCHANGE_FAILED", "Xero returned an invalid OAuth token response.", {
        cause: parsed.error,
      });
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
      scopes: scopes.length > 0 ? scopes : XERO_DEFAULT_SCOPES,
      metadata: {},
    });
    return { credentialRef: stored.credentialRef, expiresAt, scopes: stored.secret.scopes };
  }

  async check_connection(context: ConnectorContext): Promise<ConnectionHealth> {
    try {
      const accounts = await this.discover_accounts(context);
      const selected = (await this.readCredential(context)).secret.metadata.xeroTenantId;
      if (typeof selected !== "string") return accounts.length === 1 ? "healthy" : "degraded";
      return accounts.some((account) => account.externalAccountId === selected) ? "healthy" : "revoked";
    } catch (error) {
      if (error instanceof ConnectorHttpError && error.status === 401) return "expired";
      if (error instanceof ConnectorHttpError && error.status === 403) return "degraded";
      throw error;
    }
  }

  async discover_accounts(context: ConnectorContext): Promise<readonly ConnectionDiscovery[]> {
    const credential = await this.validCredential(context);
    const execute = (accessToken: string) => this.concurrency.run(() => requestJson<unknown>(
      this.fetcher,
      CONNECTIONS_ENDPOINT,
      {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal: context.abortSignal,
      },
      withVendorRateBudget(this.config.retry, context.vendorRateBudget),
    ));
    let value: unknown;
    try {
      ({ value } = await execute(credential.secret.accessToken));
    } catch (error) {
      if (!(error instanceof ConnectorHttpError) || error.status !== 401) throw error;
      // Access tokens can be revoked before their advertised expiry. Route the
      // recovery through the same durable, fenced refresh lease as all other
      // Xero calls so multiple worker replicas cannot spend one rotating
      // refresh token concurrently.
      const refreshed = await this.refreshCredential(credential, context.abortSignal);
      ({ value } = await execute(refreshed.secret.accessToken));
    }
    const parsed = z.array(connectionSchema).safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Xero returned invalid connection metadata.", {
        cause: parsed.error,
      });
    }
    return parsed.data
      .filter((connection) => connection.tenantType.toUpperCase() === "ORGANISATION")
      .map((connection) => ({
        externalAccountId: connection.tenantId,
        displayName: connection.tenantName?.trim() || `Xero organisation ${connection.tenantId}`,
        baseUrl: `${ACCOUNTING_ORIGIN}/api.xro/2.0/`,
        metadata: {
          xeroConnectionId: connection.id,
          tenantType: connection.tenantType,
          updatedAt: connection.updatedDateUtc ?? null,
        },
      }));
  }

  async discover_account(context: ConnectorContext): Promise<ConnectionDiscovery> {
    const credential = await this.readCredential(context);
    const selected = credential.secret.metadata.xeroTenantId;
    // Every data walk needs the organisation only for its xero-tenant-id
    // header. select_account bound it into the credential at connect time, so
    // re-fetching /connections here spent one budgeted call per page — half of
    // a 1,000-call day — and under daily pacing starved every stream before
    // its first data call. A revoked organisation still fails closed: the
    // data request itself returns 401/403 and routes through refresh/health.
    if (typeof selected === "string") {
      const boundConnectionId = credential.secret.metadata.xeroConnectionId;
      return {
        externalAccountId: selected,
        displayName: selected,
        metadata: {
          xeroConnectionId: typeof boundConnectionId === "string" ? boundConnectionId : null,
        },
      };
    }
    const accounts = await this.discover_accounts(context);
    if (accounts.length === 1 && accounts[0]) return accounts[0];
    throw new ConnectorError(
      "CONFIGURATION_INVALID",
      accounts.length === 0
        ? "No Xero organisation is authorized for this connection."
        : "Select which Xero organisation Albert should connect.",
      { details: { organisationCount: accounts.length } },
    );
  }

  async select_account(
    context: ConnectorContext,
    externalAccountId: string,
  ): Promise<ConnectionDiscovery> {
    const accounts = await this.discover_accounts(context);
    const selected = accounts.find((account) => account.externalAccountId === externalAccountId);
    if (!selected) {
      throw new ConnectorError("CONFIGURATION_INVALID", "That Xero organisation is not authorized.");
    }
    const current = await this.readCredential(context);
    await this.config.vault.compareAndSwap(current.credentialRef, current.revision, {
      ...current.secret,
      metadata: {
        ...current.secret.metadata,
        xeroTenantId: externalAccountId,
        xeroConnectionId: selected.metadata.xeroConnectionId ?? null,
      },
    });
    return selected;
  }

  async list_streams(context: ConnectorContext): Promise<readonly ConnectorStream[]> {
    void context;
    return this.manifest.streams
      .map((stream) => ({
        id: stream.id,
        label: stream.id.replaceAll("_", " "),
        domains: stream.productDomains,
        cursorKind: stream.pagination === "offset" ? "offset" as const : "high_water_mark" as const,
        backfillStrategy: stream.backfillStrategy,
        lateEditStrategy: stream.lateEditStrategy,
        deletionStrategy: stream.deletionStrategy,
        sourceTotalStrategy: stream.sourceTotalStrategy,
        availability: stream.availability ?? "required",
        dependencies: stream.dependencies,
        productDomains: stream.productDomains,
        priority: streamPriority[stream.id as XeroStreamId],
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
    if (!this.config.webhookSigningKey) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        "Xero webhook verification is not configured for this process.",
      );
    }
    const signature = header(event.headers, "x-xero-signature");
    const expected = createHmac("sha256", this.config.webhookSigningKey)
      .update(event.body)
      .digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature ?? "", "base64");
    } catch {
      received = Buffer.alloc(0);
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new ConnectorError(
        "WEBHOOK_SIGNATURE_INVALID",
        "Xero webhook signature is invalid.",
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(event.body));
    } catch (cause) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Xero webhook JSON is invalid.", { cause });
    }
    const parsed = webhookSchema.safeParse(json);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Xero webhook payload is invalid.", {
        cause: parsed.error,
      });
    }
    const selected = (await this.readCredential(context)).secret.metadata.xeroTenantId;
    const tenantIds = [...new Set(parsed.data.events.map((item) => item.tenantId))];
    if (typeof selected === "string" && tenantIds.some((tenantId) => tenantId !== selected)) {
      return {
        accepted: false,
        streams: [],
        externalAccountIds: tenantIds,
        reason: "Webhook does not belong to the selected Xero organisation.",
      };
    }
    const categoryToStream: Readonly<Record<string, XeroStreamId | undefined>> = {
      CONTACT: "xero_contacts",
      INVOICE: "xero_invoices",
      CREDITNOTE: "xero_credit_notes",
      "CREDIT NOTE": "xero_credit_notes",
    };
    const streams = [...new Set(parsed.data.events
      .map((item) => categoryToStream[item.eventCategory.toUpperCase()])
      .filter((item): item is XeroStreamId => Boolean(item)))];
    return {
      accepted: true,
      dedupeKey: `xero:${parsed.data.firstEventSequence}:${parsed.data.lastEventSequence}:${hashPayload(json)}`,
      streams,
      externalAccountIds: tenantIds,
    };
  }

  async refresh_credentials(context: ConnectorContext): Promise<{ credentialRef: string }> {
    const current = await this.readCredential(context);
    return { credentialRef: (await this.refreshCredential(current, context.abortSignal)).credentialRef };
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    try {
      const current = await this.validCredential(context);
      const connectionId = current.secret.metadata.xeroConnectionId;
      const refreshToken = current.secret.refreshToken;
      if (typeof connectionId === "string" && connectionId.length > 0) {
        try {
          await this.concurrency.run(() => requestJsonOrEmpty(
            this.fetcher,
            `${CONNECTIONS_ENDPOINT}/${encodeURIComponent(connectionId)}`,
            {
              method: "DELETE",
              headers: { authorization: `Bearer ${current.secret.accessToken}` },
              signal: context.abortSignal,
            },
            withVendorRateBudget(this.config.retry, context.vendorRateBudget),
          ));
        } catch (error) {
          if (!(error instanceof ConnectorHttpError) || error.status !== 404) throw error;
        }
      } else if (refreshToken) {
        await this.concurrency.run(() => requestJsonOrEmpty(
          this.fetcher,
          REVOCATION_ENDPOINT,
          {
            method: "POST",
            headers: {
              authorization: basicAuth(this.config.clientId),
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ token: refreshToken }),
            signal: context.abortSignal,
          },
          withVendorRateBudget(this.config.retry, context.vendorRateBudget),
        ));
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
    const ledgerKey = `${context.connectionId}:xero_journals`;
    return [
      capability("finance.settings", has("accounting.settings.read"), ["accounting.settings.read"]),
      capability("finance.invoices", has("accounting.invoices.read"), ["accounting.invoices.read"]),
      capability("finance.payments", has("accounting.payments.read"), ["accounting.payments.read"]),
      capability("finance.bank_transactions", has("accounting.banktransactions.read"), ["accounting.banktransactions.read"]),
      {
        id: "finance.journals",
        support: !has("accounting.journals.read")
          ? "unavailable"
          : this.successfulStreams.has(ledgerKey) ? "full" : "unknown",
        reasonCode: !has("accounting.journals.read")
          ? "required_scope_missing"
          : this.successfulStreams.has(ledgerKey) ? "live_stream_observed" : "live_probe_required",
        requiredScopes: ["accounting.journals.read"],
        notes: "Journals require an Advanced-tier, certified Xero app. Until a live endpoint probe succeeds, ledger-backed answers must remain Unavailable rather than silently partial.",
      },
      {
        id: "finance.journals.tax",
        support: !has("accounting.journals.read")
          ? "unavailable"
          : this.successfulStreams.has(ledgerKey) ? "full" : "unknown",
        reasonCode: !has("accounting.journals.read")
          ? "required_scope_missing"
          : this.successfulStreams.has(ledgerKey) ? "live_stream_observed" : "live_probe_required",
        requiredScopes: ["accounting.journals.read"],
        notes: "Journal line TaxAmount and TaxType are projected only after the live Advanced Journals probe succeeds.",
      },
      { id: "source.webhooks.contacts", support: "full", reasonCode: "vendor_webhook_documented" },
      { id: "source.webhooks.invoices", support: "full", reasonCode: "vendor_webhook_documented" },
      { id: "source.webhooks.credit_notes", support: "full", reasonCode: "vendor_webhook_documented" },
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
    const contract = XERO_STREAMS.find((candidate) => candidate.id === stream.id);
    if (!contract || !(contract.id in xeroSchemas)) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Unknown Xero stream: ${stream.id}.`);
    }
    const table = specTableFor(contract);
    await this.assertRegionAvailable(context, table);
    const fanOut = fanOutCarrying(table);
    if (fanOut) return this.syncFanOut(context, contract, table, fanOut, mode, cursor, range);
    return this.syncWalk(context, contract, table, mode, cursor, range, reconciliationPhase);
  }

  /**
   * UK and NZ payroll share one base path and are told apart only by the
   * organisation's region, so a mismatched walk would stage another region's
   * records into the wrong tables. The organisation's country is fetched once
   * per connection and every payroll stream is gated on it.
   */
  private readonly orgCountryByConnection = new Map<string, Promise<string | null>>();

  private async assertRegionAvailable(context: ConnectorContext, table: XeroSpecTable): Promise<void> {
    const api = table.source.api;
    if (!api.startsWith("payroll_")) return;
    let pending = this.orgCountryByConnection.get(context.connectionId);
    if (!pending) {
      pending = (async () => {
        const account = await this.discover_account(context);
        const url = new URL("/api.xro/2.0/Organisation", ACCOUNTING_ORIGIN);
        const { value } = await this.accountingJson<Record<string, unknown>>(context, url, {
          accept: "application/json",
          "xero-tenant-id": account.externalAccountId,
        });
        const organisations = Array.isArray(value.Organisations) ? value.Organisations : [];
        const first = organisations[0];
        const country = first && typeof first === "object"
          ? (first as Record<string, unknown>).CountryCode
          : null;
        return typeof country === "string" ? country.toUpperCase() : null;
      })().catch((error) => {
        this.orgCountryByConnection.delete(context.connectionId);
        throw error;
      });
      this.orgCountryByConnection.set(context.connectionId, pending);
    }
    const country = await pending;
    const wanted = api === "payroll_au" ? "AU" : api === "payroll_nz" ? "NZ" : "GB";
    if (country !== wanted) {
      throw new ConnectorError(
        "CAPABILITY_UNAVAILABLE",
        `Xero ${wanted} payroll is not available for this organisation (region ${country ?? "unknown"}).`,
        { details: { stream: table.id, region: country ?? "unknown" } },
      );
    }
  }

  /** Continuation state for walk streams; a plain number remains a bare page. */
  private decodeWalkContinuation(continuation: unknown): { page: number; pass: number } {
    if (typeof continuation === "number") return { page: continuation, pass: 0 };
    if (typeof continuation === "string") {
      try {
        const parsed = JSON.parse(continuation) as { page?: unknown; pass?: unknown };
        const page = typeof parsed.page === "number" && Number.isSafeInteger(parsed.page) ? parsed.page : 1;
        const pass = typeof parsed.pass === "number" && Number.isSafeInteger(parsed.pass) ? parsed.pass : 0;
        return { page, pass };
      } catch {
        throw new ConnectorError("CURSOR_INVALID", "The Xero walk continuation is invalid.");
      }
    }
    return { page: 1, pass: 0 };
  }

  private async syncWalk(
    context: ConnectorContext,
    contract: XeroStream,
    table: XeroSpecTable,
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
    reconciliationPhase?: ReconciliationRequest["phase"],
  ): Promise<SyncPage> {
    const group = scanGroupFor(table);
    if (!group) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Stream ${contract.id} has no scan group.`);
    }
    const leader = group.leader;
    const profile = XERO_API_PROFILES[leader.source.api];
    const state = cursor ? decodeCursor(cursor, { connector: this.id, stream: contract.id }) : undefined;
    const currentSecond = new Date(
      Math.floor((this.config.now?.() ?? Date.now()) / 1_000) * 1_000,
    ).toISOString();
    const scanUpperBound = mode === "reconciliation" && reconciliationPhase === "late_edits"
      ? range?.to ?? currentSecond
      : state?.scanUpperBound ?? currentSecond;

    const isIdentity = leader.source.api === "identity";
    const url = new URL(endpointPath(leader), ACCOUNTING_ORIGIN);
    const headers: Record<string, string> = { accept: "application/json" };
    if (!isIdentity) {
      const account = await this.discover_account(context);
      headers["xero-tenant-id"] = account.externalAccountId;
    }

    const passes = extraParamPasses(leader, currentSecond);
    const walk = this.decodeWalkContinuation(state?.continuation);
    let page = 1;
    let offset = 0;
    if (group.pagination === "page" && profile.pageParam) {
      page = walk.page;
      url.searchParams.set(profile.pageParam, String(page));
      if (profile.pageSizeParam) url.searchParams.set(profile.pageSizeParam, String(profile.pageSize));
      if (profile.supportsOrder && group.modifiedField && leader.recordIdField) {
        // A total source-time/native-ID order plus an immutable run-start upper
        // bound prevents mutable page membership from skipping records.
        url.searchParams.set("order", `${group.modifiedField} ASC,${leader.recordIdField} ASC`);
      }
    } else if (group.pagination === "offset") {
      offset = typeof state?.continuation === "number" ? state.continuation : 0;
      url.searchParams.set("offset", String(offset));
    }
    for (const [key, value] of Object.entries(baseParams(leader))) url.searchParams.set(key, value);
    if (passes.length > 0) {
      const pass = passes[Math.min(walk.pass, passes.length - 1)];
      for (const [key, value] of Object.entries(pass)) url.searchParams.set(key, value);
    }

    const modifiedField = group.modifiedField;
    if (
      group.pagination !== "offset" &&
      profile.supportsIfModifiedSince &&
      modifiedField &&
      (
        (mode === "incremental" && state?.watermark) ||
        (mode === "reconciliation" && reconciliationPhase === "late_edits" &&
          contract.lateEditStrategy === "modified_field" && range)
      )
    ) {
      headers["if-modified-since"] = new Date(
        mode === "incremental" ? state!.watermark! : range!.from,
      ).toUTCString();
      if (profile.supportsWhere && group.whereFilterable) {
        url.searchParams.set("where", `${modifiedField}<${xeroDateTime(scanUpperBound)}`);
      }
    } else if (
      mode === "initial" && range && eventDateField[contract.id] &&
      profile.supportsWhere && group.whereFilterable
    ) {
      const field = eventDateField[contract.id];
      url.searchParams.set(
        "where",
        `${field}>=${xeroDateTime(range.from)}&&${field}<${xeroDateTime(range.to)}` +
          (group.pagination === "page" && modifiedField
            ? `&&${modifiedField}<${xeroDateTime(scanUpperBound)}`
            : ""),
      );
    } else if (
      mode === "initial" && group.pagination === "page" && modifiedField &&
      profile.supportsWhere && group.whereFilterable
    ) {
      url.searchParams.set("where", `${modifiedField}<${xeroDateTime(scanUpperBound)}`);
    }

    let value: unknown;
    try {
      ({ value } = await this.accountingJson<unknown>(context, url, headers));
    } catch (error) {
      if (error instanceof ConnectorHttpError && error.status === 304) {
        value = {};
      } else if (
        error instanceof ConnectorHttpError &&
        (error.status === 403 || error.status === 404) &&
        (contract.availability ?? "required") === "optional"
      ) {
        throw new ConnectorError(
          "CAPABILITY_UNAVAILABLE",
          `Xero ${contract.id} is unavailable for this organisation (${error.status}).`,
          { details: { stream: contract.id, status: error.status } },
        );
      } else {
        throw error;
      }
    }

    const rawRecords = unwrapEnvelope(value, leader);
    // Leader records failing the founding envelope validation are quarantined
    // as schema_invalid on the leader stream; members project from valid ones.
    const envelopeSchema = leader.source.api === "accounting"
      ? xeroEnvelopeSchemas[group.resource]
      : undefined;
    const invalidRecords: RawSourceRecord[] = [];
    const validRaw: unknown[] = [];
    for (const raw of rawRecords) {
      const parsed = envelopeSchema?.safeParse(raw);
      if (parsed && !parsed.success) {
        if (contract.isScanLeader) {
          const payloadHash = hashPayload(raw);
          const candidate = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
          invalidRecords.push({
            sourceObjectType: group.resource,
            sourceRecordId: candidate[contract.recordIdField] != null
              ? String(candidate[contract.recordIdField])
              : `invalid:${payloadHash}`,
            payload: raw,
            payloadHash,
            validationIssues: parsed.error.issues.map((issue) => ({
              code: "schema_invalid" as const,
              path: issue.path.join("."),
              message: issue.message,
            })),
          });
        }
        continue;
      }
      validRaw.push(raw);
    }

    const projected = projectStreamRows({
      table,
      leaderTable: leader,
      resource: group.resource,
      records: validRaw,
      recordIdField: contract.recordIdField,
    });
    const drifted = contract.isScanLeader
      ? projected.map((record) => this.withDrift(table, record))
      : projected;
    const records = [...invalidRecords, ...drifted];

    const observedWatermark = latestTimestamp(
      records.map((record) => record.sourceUpdatedAt),
      state?.observedWatermark ?? state?.watermark,
    );
    const oldestObservedAt = oldestRecordTimestamp(records, state?.oldestObservedAt);

    let hasMore = false;
    let vendorHasMore = false;
    let verificationRestart = false;
    let continuation: number | string | undefined;
    let paginationBlock: SyncPage["paginationBlock"];
    let scanDigest: string | undefined;
    let scanCount: number | undefined;
    let verificationDigest: string | undefined;
    let verificationCount: number | undefined;

    if (group.pagination === "page") {
      if (
        (state?.scanDigest !== undefined && !/^[0-9a-f]{64}$/u.test(state.scanDigest)) ||
        (state?.verificationDigest !== undefined && !/^[0-9a-f]{64}$/u.test(state.verificationDigest)) ||
        (state?.scanCount !== undefined && (!Number.isSafeInteger(state.scanCount) || state.scanCount < 0)) ||
        (state?.verificationCount !== undefined &&
          (!Number.isSafeInteger(state.verificationCount) || state.verificationCount < 0))
      ) {
        throw new ConnectorError("CURSOR_INVALID", "The Xero page verification cursor is invalid.");
      }
      // Xero recommends requesting pages until an empty page is observed.
      const pageExhausted = rawRecords.length === 0;
      const morePasses = walk.pass + 1 < passes.length;
      vendorHasMore = !pageExhausted;

      if (passes.length > 0) {
        // Hidden-population passes are bounded snapshot sets; each pass pages
        // to exhaustion, then the walk moves to the next pass.
        hasMore = vendorHasMore || morePasses;
        continuation = vendorHasMore
          ? JSON.stringify({ page: page + 1, pass: walk.pass })
          : morePasses
            ? JSON.stringify({ page: 1, pass: walk.pass + 1 })
            : undefined;
      } else {
        scanDigest = extendXeroScanDigest(state?.scanDigest, records);
        scanCount = (state?.scanCount ?? 0) + records.length;
        verificationDigest = state?.verificationDigest;
        verificationCount = state?.verificationCount;
        if (!vendorHasMore && (scanCount > 0 || verificationDigest !== undefined)) {
          const consecutivePassMatches = verificationDigest !== undefined &&
            verificationCount === scanCount && verificationDigest === scanDigest;
          if (!consecutivePassMatches) {
            // Page-number result sets are mutable even under a stable order.
            // Require two identical ordered passes before advancing the lower
            // watermark; the restart cursor is durable across worker crashes.
            verificationRestart = true;
            verificationDigest = scanDigest;
            verificationCount = scanCount;
          }
        }
        hasMore = vendorHasMore || verificationRestart;
        continuation = vendorHasMore ? page + 1 : undefined;
      }
    } else if (group.pagination === "offset") {
      const journalNumbers = validRaw
        .map((raw) => raw && typeof raw === "object" ? Number((raw as Record<string, unknown>).JournalNumber) : Number.NaN)
        .filter((candidate) => Number.isSafeInteger(candidate) && candidate >= 0);
      const maxJournal = journalNumbers.length > 0 ? Math.max(...journalNumbers) : undefined;
      // Xero explicitly warns that a partial Journals page is not an end signal.
      hasMore = rawRecords.length > 0;
      if (hasMore && maxJournal === undefined) {
        paginationBlock = {
          code: "pagination_identity_invalid",
          detail: "Xero returned a non-empty Journals page without a valid JournalNumber.",
        };
      } else if (hasMore && maxJournal !== undefined && maxJournal <= offset) {
        paginationBlock = {
          code: "pagination_not_advancing",
          detail: "Xero returned a Journals page that did not advance beyond the requested offset.",
        };
      } else {
        // Persist the high journal number even on the last page for the next incremental.
        continuation = maxJournal ?? offset;
      }
      vendorHasMore = hasMore;
    }

    if (!paginationBlock) this.successfulStreams.add(`${context.connectionId}:${contract.id}`);
    return {
      records,
      nextCursor: paginationBlock ? null : encodeCursor({
        v: 1,
        connector: this.id,
        stream: contract.id,
        mode: mode === "reconciliation" ? "reconciliation" : mode,
        watermark: hasMore
          ? state?.watermark
          : mode === "initial"
            ? range?.to ?? observedWatermark
            : scanUpperBound ?? observedWatermark,
        observedWatermark: hasMore ? observedWatermark : undefined,
        oldestObservedAt,
        continuation,
        scanUpperBound: hasMore && group.pagination === "page" ? scanUpperBound : undefined,
        scanDigest: group.pagination === "page" && vendorHasMore ? scanDigest : undefined,
        scanCount: group.pagination === "page" && vendorHasMore ? scanCount : undefined,
        verificationDigest: group.pagination === "page" && hasMore ? verificationDigest : undefined,
        verificationCount: group.pagination === "page" && hasMore ? verificationCount : undefined,
        rangeFrom: range?.from ?? state?.rangeFrom,
        rangeTo: mode === "incremental" ? undefined : range?.to ?? state?.rangeTo,
      }),
      hasMore,
      ...(paginationBlock ? { paginationBlock } : {}),
      ...(mode === "initial" && !hasMore && range
        ? { coverage: contract.backfillStrategy === "snapshot"
            ? {
                boundaryKind: "snapshot_at" as const,
                lowerBound: range.to,
                verification: "point_in_time" as const,
              }
            : contract.backfillStrategy === "exhaustive_offset" ||
                Date.parse(range.from) <= Date.parse("1970-01-01T00:00:00.000Z")
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

  /** Vendor fields on a leader payload with no spec column anywhere in its group. */
  private withDrift(table: XeroSpecTable, record: RawSourceRecord): RawSourceRecord {
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return record;
    const known = new Set<string>();
    const group = scanGroupFor(table);
    for (const member of group?.members ?? []) {
      for (const column of member.table.columns) {
        const api = column.api;
        if (api.startsWith("synthetic:")) continue;
        const body = api.slice(api.indexOf(":") + 1).replace(/\[\]( index)?$/u, "");
        const segments = body.split(".");
        if (segments.length > 1) known.add(segments[1]);
      }
      if (member.projectFrom) known.add(member.projectFrom.split(".")[0]);
    }
    const drift = Object.keys(payload as Record<string, unknown>).filter((key) => !known.has(key));
    if (drift.length === 0) return record;
    return {
      ...record,
      validationIssues: [
        ...(record.validationIssues ?? []),
        ...drift.map((field) => ({
          code: "schema_drift" as const,
          path: field,
          message: "The vendor returned a field without an approved coverage disposition.",
        })),
      ],
    };
  }

  /**
   * One page of a parent-scoped stream: page the parent endpoint, then issue a
   * bounded number of sub-requests under the org's budget. The cursor carries
   * the parent page and the index of the next unprocessed parent, so a crash
   * resumes mid-page instead of replaying every sub-request.
   */
  /**
   * One page of a parent-scoped stream.
   *
   * The chain can be more than one link deep — working weeks hang off a working
   * pattern, which hangs off an employee — so the walk descends the whole
   * ancestry, spending a bounded number of sub-requests per claim and recording
   * exactly where it stopped. The cursor carries the root page plus the index
   * at every level, so a crash resumes at the next unvisited parent instead of
   * replaying the traversal (which, under a 1,000/day org budget, would mean
   * never finishing).
   */
  private async syncFanOut(
    context: ConnectorContext,
    contract: XeroStream,
    table: XeroSpecTable,
    fanOut: NonNullable<ReturnType<typeof fanOutCarrying>>,
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
  ): Promise<SyncPage> {
    const SUB_REQUESTS_PER_PAGE = 25;
    const templated = templatedParents(fanOut);
    if (templated) {
      return this.syncTemplatedFanOut(context, contract, table, fanOut, templated, mode, cursor, range);
    }

    const ancestry = fanOutAncestry(fanOut);
    const rootTable = ancestry[0];
    if (!rootTable || rootTable.source.fanOutParam) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Fan-out ${contract.id} has no walkable root.`);
    }
    const rootGroup = scanGroupFor(rootTable);
    if (!rootGroup) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Fan-out ${contract.id} root has no scan group.`);
    }
    const rootProfile = XERO_API_PROFILES[rootGroup.leader.source.api];
    const account = await this.discover_account(context);
    const headers: Record<string, string> = {
      accept: "application/json",
      "xero-tenant-id": account.externalAccountId,
    };

    const state = cursor ? decodeCursor(cursor, { connector: this.id, stream: contract.id }) : undefined;
    let rootPage = 1;
    let resume: number[] = [];
    if (typeof state?.continuation === "string") {
      try {
        const parsed = JSON.parse(state.continuation) as { page?: unknown; at?: unknown };
        if (typeof parsed.page === "number" && Number.isSafeInteger(parsed.page)) rootPage = parsed.page;
        if (Array.isArray(parsed.at) && parsed.at.every((value) => Number.isSafeInteger(value))) {
          resume = parsed.at as number[];
        }
      } catch {
        throw new ConnectorError("CURSOR_INVALID", "The Xero fan-out continuation is invalid.");
      }
    }

    const rootUrl = new URL(endpointPath(rootGroup.leader), ACCOUNTING_ORIGIN);
    if (rootGroup.pagination === "page" && rootProfile.pageParam) {
      rootUrl.searchParams.set(rootProfile.pageParam, String(rootPage));
      if (rootProfile.pageSizeParam) {
        rootUrl.searchParams.set(rootProfile.pageSizeParam, String(rootProfile.pageSize));
      }
    }
    for (const [key, value] of Object.entries(baseParams(rootGroup.leader))) {
      rootUrl.searchParams.set(key, value);
    }

    let rootBody: unknown = {};
    try {
      ({ value: rootBody } = await this.accountingJson<unknown>(context, rootUrl, headers));
    } catch (error) {
      if (error instanceof ConnectorHttpError && (error.status === 403 || error.status === 404)) {
        throw new ConnectorError(
          "CAPABILITY_UNAVAILABLE",
          `Xero ${contract.id} parent walk is unavailable for this organisation (${error.status}).`,
          { details: { stream: contract.id, status: error.status } },
        );
      }
      throw error;
    }
    const rootRecords = unwrapEnvelope(rootBody, rootGroup.leader);

    const rows: RawSourceRecord[] = [];
    let issued = 0;
    let stoppedAt: number[] | null = null;

    /**
     * Descend one link of the ancestry. `position` is the index path taken so
     * far; `resumePath` is where the previous claim stopped, so earlier
     * siblings are skipped without re-requesting them.
     */
    const descend = async (
      level: number,
      parents: readonly unknown[],
      ancestors: readonly unknown[],
      position: readonly number[],
      resumePath: readonly number[],
    ): Promise<void> => {
      const startIndex = resumePath[position.length] ?? 0;
      for (let index = startIndex; index < parents.length; index += 1) {
        if (stoppedAt) return;
        const parent = parents[index];
        if (parent === null || typeof parent !== "object") continue;
        const here = [...position, index];
        const stack = [...ancestors, parent];
        const child = ancestry[level];
        if (!child) continue;

        if (issued >= SUB_REQUESTS_PER_PAGE) {
          stoppedAt = here;
          return;
        }
        if (fanOutSkippable(fanOut, parent) && child.id === fanOut.table.id) continue;

        const template = endpointPath(child);
        const param = child.source.fanOutParam ?? "";
        // Resolve the sub-resource id through the shared chain: a pay run
        // carries its payslip ids as stubs, not as a top-level field, and an
        // exact-name lookup skips those parents entirely.
        const [resolvedId] = resolveFanOutIds(param, parent, ancestry[level - 1] ?? rootTable);
        const { path, missing } = fillFanOutPath(
          template,
          resolvedId ? [...stack, { [param]: resolvedId }] : stack,
        );
        if (missing.length > 0) continue; // this parent cannot address the sub-resource
        const subUrl = new URL(path, ACCOUNTING_ORIGIN);
        if (!template.includes(`{${param}}`) && param) {
          const id = resolvedId ?? readFanOutParam(stack, param);
          if (!id) continue;
          subUrl.searchParams.set(param, id);
        }

        issued += 1;
        let subBody: unknown;
        try {
          ({ value: subBody } = await this.accountingJson<unknown>(context, subUrl, headers));
        } catch (error) {
          if (error instanceof ConnectorHttpError && (error.status === 403 || error.status === 404)) {
            // An absent sub-resource for one parent is normal, not capability
            // evidence: the next parent may well have one.
            continue;
          }
          throw error;
        }
        const subRecords = unwrapEnvelope(subBody, child);

        if (level === ancestry.length - 1) {
          const projected = projectStreamRows({
            table,
            leaderTable: child,
            resource: contract.resource,
            records: subRecords,
            recordIdField: contract.recordIdField,
            fanOutParent: { record: parent, table: ancestry[level - 1] ?? rootTable },
          });
          const parentId = readFanOutParam(stack, child.source.fanOutParam ?? "") ?? here.join(".");
          for (const row of projected) {
            rows.push(this.withFanOutKeys(row, table, rootGroup.resource, parentId, rows.length));
          }
        } else {
          await descend(level + 1, subRecords, stack, here, resumePath);
        }
      }
    };

    await descend(1, rootRecords, [], [], resume);

    const pageExhausted = stoppedAt === null;
    const moreRootPages = rootGroup.pagination === "page" && rootRecords.length > 0 && pageExhausted;
    const nextContinuation = stoppedAt !== null
      ? JSON.stringify({ page: rootPage, at: stoppedAt })
      : moreRootPages
        ? JSON.stringify({ page: rootPage + 1, at: [] })
        : undefined;

    this.successfulStreams.add(`${context.connectionId}:${contract.id}`);
    return {
      records: rows,
      nextCursor: encodeCursor({
        v: 1,
        connector: this.id,
        stream: contract.id,
        mode: mode === "reconciliation" ? "reconciliation" : mode,
        watermark: nextContinuation ? state?.watermark : range?.to ?? state?.watermark,
        continuation: nextContinuation,
        rangeFrom: range?.from ?? state?.rangeFrom,
        rangeTo: mode === "incremental" ? undefined : range?.to ?? state?.rangeTo,
      }),
      hasMore: nextContinuation !== undefined,
      ...(mode === "initial" && nextContinuation === undefined && range
        ? {
            coverage: {
              boundaryKind: rows.length > 0 ? ("verified_oldest" as const) : ("verified_empty" as const),
              lowerBound: range.from,
              verification: "exhaustive_vendor_scan" as const,
            },
          }
        : {}),
    };
  }

  /**
   * Cross-parent fan-out (attachments, history): iterate the spec-derived
   * parent endpoint set, page each parent walk, and issue bounded
   * sub-requests. The cursor carries the parent-set index, parent page and
   * mid-page position, so the whole traversal is resumable at any point.
   */
  private async syncTemplatedFanOut(
    context: ConnectorContext,
    contract: XeroStream,
    table: XeroSpecTable,
    fanOut: NonNullable<ReturnType<typeof fanOutCarrying>>,
    parents: readonly XeroTemplatedParent[],
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
  ): Promise<SyncPage> {
    const SUB_REQUESTS_PER_PAGE = 25;
    const isAttachments = /\/Attachments$/u.test(fanOut.endpointOp);
    const account = await this.discover_account(context);
    const headers: Record<string, string> = {
      accept: "application/json",
      "xero-tenant-id": account.externalAccountId,
    };
    const state = cursor ? decodeCursor(cursor, { connector: this.id, stream: contract.id }) : undefined;
    let parentIndex = 0;
    let parentPage = 1;
    let startIndex = 0;
    if (typeof state?.continuation === "string") {
      try {
        const parsed = JSON.parse(state.continuation) as { pi?: unknown; page?: unknown; idx?: unknown };
        if (typeof parsed.pi === "number" && Number.isSafeInteger(parsed.pi)) parentIndex = parsed.pi;
        if (typeof parsed.page === "number" && Number.isSafeInteger(parsed.page)) parentPage = parsed.page;
        if (typeof parsed.idx === "number" && Number.isSafeInteger(parsed.idx)) startIndex = parsed.idx;
      } catch {
        throw new ConnectorError("CURSOR_INVALID", "The Xero templated fan-out continuation is invalid.");
      }
    }
    if (parentIndex >= parents.length) parentIndex = parents.length - 1;
    const parentDef = parents[parentIndex];
    const parentStream = XERO_STREAMS.find((candidate) =>
      candidate.endpointOp === parentDef.endpointOp &&
      candidate.isScanLeader &&
      specTableFor(candidate).source.api === "accounting");
    const parentSpec = parentStream ? specTableFor(parentStream) : null;
    if (!parentStream || !parentSpec) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Templated fan-out ${contract.id} has no leader for ${parentDef.endpointOp}.`);
    }
    const parentGroup = scanGroupFor(parentSpec)!;
    const parentProfile = XERO_API_PROFILES[parentGroup.leader.source.api];

    const parentUrl = new URL(endpointPath(parentGroup.leader), ACCOUNTING_ORIGIN);
    if (parentGroup.pagination === "page" && parentProfile.pageParam) {
      parentUrl.searchParams.set(parentProfile.pageParam, String(parentPage));
      if (parentProfile.pageSizeParam) {
        parentUrl.searchParams.set(parentProfile.pageSizeParam, String(parentProfile.pageSize));
      }
    }
    for (const [key, value] of Object.entries(baseParams(parentGroup.leader))) {
      parentUrl.searchParams.set(key, value);
    }

    let parentBody: unknown = {};
    let parentUnavailable = false;
    try {
      ({ value: parentBody } = await this.accountingJson<unknown>(context, parentUrl, headers));
    } catch (error) {
      if (error instanceof ConnectorHttpError && (error.status === 403 || error.status === 404)) {
        // This parent family is not reachable for the org (scope tier); the
        // remaining families still are.
        parentUnavailable = true;
      } else {
        throw error;
      }
    }
    const parentRecords = parentUnavailable ? [] : unwrapEnvelope(parentBody, parentGroup.leader);

    const rows: RawSourceRecord[] = [];
    let consumed = 0;
    let issued = 0;
    for (let index = startIndex; index < parentRecords.length; index += 1) {
      if (issued >= SUB_REQUESTS_PER_PAGE) break;
      const parent = parentRecords[index];
      consumed += 1;
      if (parent === null || typeof parent !== "object") continue;
      if (isAttachments && (parent as Record<string, unknown>).HasAttachments === false) continue;
      const parentId = (parent as Record<string, unknown>)[parentDef.idParam];
      const id = parentId === null || parentId === undefined ? "" : String(parentId).trim();
      if (!id) continue;
      issued += 1;
      const subUrl = new URL(
        `/api.xro/2.0${parentDef.pathTemplate.replace(`{${parentDef.idParam}}`, encodeURIComponent(id))}`,
        ACCOUNTING_ORIGIN,
      );
      let subBody: unknown;
      try {
        ({ value: subBody } = await this.accountingJson<unknown>(context, subUrl, headers));
      } catch (error) {
        if (error instanceof ConnectorHttpError && (error.status === 403 || error.status === 404)) continue;
        throw error;
      }
      const subRecords = unwrapEnvelope(subBody, fanOut.table);
      const projected = projectStreamRows({
        table,
        leaderTable: table.id === fanOut.table.id ? parentSpec : fanOut.table,
        resource: contract.resource,
        records: subRecords,
        recordIdField: contract.recordIdField,
        fanOutParent: { record: parent, table: parentSpec },
      });
      for (const row of projected) {
        rows.push(this.withFanOutKeys(row, table, parentGroup.resource, id, rows.length));
      }
    }

    const pageExhausted = startIndex + consumed >= parentRecords.length;
    const moreParentPages = !parentUnavailable && parentGroup.pagination === "page" && parentRecords.length > 0;
    const moreFamilies = parentIndex + 1 < parents.length;
    const nextContinuation = !pageExhausted
      ? JSON.stringify({ pi: parentIndex, page: parentPage, idx: startIndex + consumed })
      : moreParentPages
        ? JSON.stringify({ pi: parentIndex, page: parentPage + 1, idx: 0 })
        : moreFamilies
          ? JSON.stringify({ pi: parentIndex + 1, page: 1, idx: 0 })
          : undefined;

    this.successfulStreams.add(`${context.connectionId}:${contract.id}`);
    return {
      records: rows,
      nextCursor: encodeCursor({
        v: 1,
        connector: this.id,
        stream: contract.id,
        mode: mode === "reconciliation" ? "reconciliation" : mode,
        watermark: nextContinuation ? state?.watermark : range?.to ?? state?.watermark,
        continuation: nextContinuation,
        rangeFrom: range?.from ?? state?.rangeFrom,
        rangeTo: mode === "incremental" ? undefined : range?.to ?? state?.rangeTo,
      }),
      hasMore: nextContinuation !== undefined,
      ...(mode === "initial" && nextContinuation === undefined && range
        ? {
            coverage: {
              boundaryKind: rows.length > 0 ? ("verified_oldest" as const) : ("verified_empty" as const),
              lowerBound: range.from,
              verification: "exhaustive_vendor_scan" as const,
            },
          }
        : {}),
    };
  }

  /** Fill synthetic parent-linkage columns on fan-out rows from the request. */
  private withFanOutKeys(
    row: RawSourceRecord,
    table: XeroSpecTable,
    parentResource: string,
    parentId: string,
    ordinal: number,
  ): RawSourceRecord {
    const normalized = row.normalized;
    if (!normalized) return row;
    const fields = { ...normalized.fields } as Record<string, unknown>;
    for (const column of table.columns) {
      if (!column.api.startsWith("synthetic:")) continue;
      const field = xeroSourceField(column);
      if (fields[field] !== undefined) continue;
      if (/parent_endpoint|parent_type|parent_resource/u.test(column.name)) fields[field] = parentResource;
      else if (/parent(_record)?_id/u.test(column.name)) fields[field] = parentId;
      else if (/(_index|_ordinal|position)$/u.test(column.name)) fields[field] = ordinal;
    }
    const sourceRecordId = row.sourceRecordId.startsWith(`${table.id}:`)
      ? `${parentId}:${row.sourceRecordId.slice(table.id.length + 1)}`
      : row.sourceRecordId;
    return { ...row, sourceRecordId, normalized: { ...normalized, fields } };
  }

  private async accountingJson<T>(
    context: ConnectorContext,
    url: URL,
    headers: Readonly<Record<string, string>>,
  ): Promise<Readonly<{ value: T; response: Response }>> {
    const credential = await this.validCredential(context);
    const execute = (accessToken: string) => this.concurrency.run(() => requestJson<T>(
      this.fetcher,
      url,
      {
        method: "GET",
        headers: { ...headers, authorization: `Bearer ${accessToken}` },
        signal: context.abortSignal,
      },
      withVendorRateBudget(this.config.retry, context.vendorRateBudget),
    ));
    try {
      return await execute(credential.secret.accessToken);
    } catch (error) {
      if (!(error instanceof ConnectorHttpError) || error.status !== 401) throw error;
      const refreshed = await this.refreshCredential(credential, context.abortSignal);
      return execute(refreshed.secret.accessToken);
    }
  }

  private async readCredential(context: ConnectorContext): Promise<VersionedCredential> {
    const credential = await this.config.vault.read(context.credentialRef);
    if (credential.secret.provider !== this.id) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Xero.");
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
          throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Xero.");
        }
        if (latest.revision !== current.revision) return latest;
        return this.performRefresh(latest, lease.abortSignal, lease.proof);
      },
      signal,
    ).finally(() => this.refreshes.delete(current.credentialRef));
    this.refreshes.set(current.credentialRef, promise);
    return promise;
  }

  private async performRefresh(
    current: VersionedCredential,
    signal?: AbortSignal,
    refreshLease?: CredentialRefreshLeaseProof,
  ): Promise<VersionedCredential> {
    if (!current.secret.refreshToken) {
      throw new ConnectorError("AUTHENTICATION_REQUIRED", "Xero refresh token is missing.");
    }
    const { value } = await requestJson<unknown>(
      this.fetcher,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          authorization: basicAuth(this.config.clientId),
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.config.clientId,
          refresh_token: current.secret.refreshToken,
        }),
        signal,
      },
      this.config.retry,
    );
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("OAUTH_EXCHANGE_FAILED", "Xero returned an invalid token refresh.", {
        cause: parsed.error,
      });
    }
    const scopes = splitOAuthScopes(parsed.data.scope);
    const next: OAuthCredentialSecret = {
      ...current.secret,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt: new Date(
        (this.config.now?.() ?? Date.now()) + parsed.data.expires_in * 1_000,
      ).toISOString(),
      scopes: scopes.length > 0 ? scopes : current.secret.scopes,
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
      throw new ConnectorError("CREDENTIAL_CONFLICT", "Concurrent Xero token rotation failed.", {
        cause,
        retryable: true,
      });
    }
  }
}

function capability(
  id: ConnectorCapability["id"],
  available: boolean,
  requiredScopes: readonly string[],
): ConnectorCapability {
  return {
    id,
    support: available ? "full" : "unavailable",
    reasonCode: available ? "required_scopes_granted" : "required_scope_missing",
    requiredScopes,
  };
}

async function requestJsonOrEmpty(
  fetcher: FetchLike,
  input: string,
  init: RequestInit,
  retry?: HttpRetryOptions,
): Promise<void> {
  const response = await fetchWithRetry(fetcher, input, init, retry);
  await response.body?.cancel().catch(() => undefined);
}

export { xeroManifest } from "./manifest";
export * from "./schemas";
