import { createHmac, timingSafeEqual } from "node:crypto";
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
import { xeroSchemas, type XeroStreamId } from "./schemas";

const TOKEN_ENDPOINT = "https://identity.xero.com/connect/token";
const REVOCATION_ENDPOINT = "https://identity.xero.com/connect/revocation";
const CONNECTIONS_ENDPOINT = "https://api.xero.com/connections";
const ACCOUNTING_ORIGIN = "https://api.xero.com";
const PAGE_SIZE = 1_000;

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

const streamPriority: Readonly<Record<XeroStreamId, number>> = {
  organisation: 10,
  accounts: 20,
  contacts: 60,
  invoices: 40,
  credit_notes: 41,
  payments: 42,
  bank_transactions: 50,
  manual_journals: 51,
  journals: 52,
  tax_rates: 30,
  tracking_categories: 31,
};

const eventDateField: Partial<Record<XeroStreamId, string>> = {
  invoices: "Date",
  credit_notes: "Date",
  payments: "Date",
  bank_transactions: "Date",
  manual_journals: "Date",
};

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

function xeroDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ConnectorError("CURSOR_INVALID", "Xero sync time is invalid.");
  }
  return `DateTime(${date.getUTCFullYear()},${date.getUTCMonth() + 1},${date.getUTCDate()},${date.getUTCHours()},${date.getUTCMinutes()},${date.getUTCSeconds()})`;
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
    const { value } = await this.concurrency.run(() => requestJson<unknown>(
      this.fetcher,
      CONNECTIONS_ENDPOINT,
      {
        method: "GET",
        headers: { authorization: `Bearer ${credential.secret.accessToken}`, accept: "application/json" },
        signal: context.abortSignal,
      },
      withVendorRateBudget(this.config.retry, context.vendorRateBudget),
    ));
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
    const accounts = await this.discover_accounts(context);
    if (typeof selected === "string") {
      const account = accounts.find((candidate) => candidate.externalAccountId === selected);
      if (account) return account;
      throw new ConnectorError("AUTHENTICATION_REQUIRED", "The selected Xero organisation is disconnected.");
    }
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
        domains: stream.canonicalTargets,
        cursorKind: stream.pagination === "offset" ? "offset" as const : "high_water_mark" as const,
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
      CONTACT: "contacts",
      INVOICE: "invoices",
      CREDITNOTE: "credit_notes",
      "CREDIT NOTE": "credit_notes",
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
    const ledgerKey = `${context.connectionId}:journals`;
    return [
      capability("finance.settings", has("accounting.settings.read"), ["accounting.settings.read"]),
      capability("finance.invoices", has("accounting.invoices.read"), ["accounting.invoices.read"]),
      capability("finance.payments", has("accounting.payments.read"), ["accounting.payments.read"]),
      capability("finance.bank_transactions", has("accounting.banktransactions.read"), ["accounting.banktransactions.read"]),
      {
        id: "finance.general_ledger",
        support: !has("accounting.journals.read")
          ? "unavailable"
          : this.successfulStreams.has(ledgerKey) ? "full" : "unknown",
        requiredScopes: ["accounting.journals.read"],
        notes: "Journals require an Advanced-tier, certified Xero app. Until a live endpoint probe succeeds, ledger-backed answers must remain Unavailable rather than silently partial.",
      },
      { id: "source.webhooks.contacts", support: "full" },
      { id: "source.webhooks.invoices", support: "full" },
      { id: "source.webhooks.credit_notes", support: "full" },
    ];
  }

  private async sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    mode: "initial" | "incremental",
    cursor?: SyncCursor,
    range?: SyncRange,
  ): Promise<SyncPage> {
    const contract = this.manifest.streams.find((candidate) => candidate.id === stream.id);
    if (!contract || !(contract.id in xeroSchemas)) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Unknown Xero stream: ${stream.id}.`);
    }
    const streamId = contract.id as XeroStreamId;
    const account = await this.discover_account(context);
    const state = cursor ? decodeCursor(cursor, { connector: this.id, stream: stream.id }) : undefined;
    const url = new URL(`/api.xro/2.0/${contract.endpoint}`, ACCOUNTING_ORIGIN);
    const headers: Record<string, string> = {
      accept: "application/json",
      "xero-tenant-id": account.externalAccountId,
    };
    let page = 1;
    let offset = 0;
    if (contract.pagination === "page") {
      page = typeof state?.continuation === "number" ? state.continuation : 1;
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(PAGE_SIZE));
    } else if (contract.pagination === "offset") {
      offset = typeof state?.continuation === "number" ? state.continuation : 0;
      url.searchParams.set("offset", String(offset));
    }
    if (mode === "incremental" && state?.watermark && streamId !== "journals") {
      headers["if-modified-since"] = new Date(state.watermark).toUTCString();
    } else if (mode === "initial" && range && eventDateField[streamId]) {
      const field = eventDateField[streamId];
      url.searchParams.set(
        "where",
        `${field}>=${xeroDateTime(range.from)}&&${field}<${xeroDateTime(range.to)}`,
      );
    }

    let value: Record<string, unknown>;
    try {
      ({ value } = await this.accountingJson<Record<string, unknown>>(context, url, headers));
    } catch (error) {
      if (error instanceof ConnectorHttpError && error.status === 304) {
        value = { [contract.resource]: [] };
      } else if (
        streamId === "journals" &&
        error instanceof ConnectorHttpError &&
        error.status === 403
      ) {
        throw new ConnectorError(
          "CAPABILITY_UNAVAILABLE",
          "Xero general-ledger access is unavailable. The app needs Advanced tier, certification, and accounting.journals.read.",
          { details: { stream: "journals", requiredScope: "accounting.journals.read" } },
        );
      } else {
        throw error;
      }
    }
    const rawRecords = Array.isArray(value[contract.resource]) ? value[contract.resource] as unknown[] : [];
    const records = rawRecords.map((raw) => this.toRawRecord(streamId, raw));
    const observedWatermark = latestTimestamp(
      records.map((record) => record.sourceUpdatedAt),
      state?.observedWatermark ?? state?.watermark,
    );

    let hasMore = false;
    let continuation: number | undefined;
    if (contract.pagination === "page") {
      // Xero recommends requesting pages until an empty page is observed.
      hasMore = records.length > 0;
      continuation = hasMore ? page + 1 : undefined;
    } else if (contract.pagination === "offset") {
      const journalNumbers = rawRecords
        .map((raw) => raw && typeof raw === "object" ? Number((raw as Record<string, unknown>).JournalNumber) : Number.NaN)
        .filter(Number.isFinite);
      const maxJournal = journalNumbers.length > 0 ? Math.max(...journalNumbers) : offset;
      // Xero explicitly warns that a partial Journals page is not an end signal.
      hasMore = records.length > 0;
      // Persist the high journal number even on the last page for the next incremental.
      continuation = maxJournal;
    }
    this.successfulStreams.add(`${context.connectionId}:${streamId}`);
    return {
      records,
      nextCursor: encodeCursor({
        v: 1,
        connector: this.id,
        stream: stream.id,
        mode,
        watermark: hasMore
          ? state?.watermark
          : mode === "initial"
            ? range?.to ?? observedWatermark
            : observedWatermark,
        observedWatermark: hasMore ? observedWatermark : undefined,
        continuation,
        rangeFrom: range?.from ?? state?.rangeFrom,
        rangeTo: range?.to ?? state?.rangeTo,
      }),
      hasMore,
    };
  }

  private toRawRecord(stream: XeroStreamId, raw: unknown): RawSourceRecord {
    const payloadHash = hashPayload(raw);
    const schema = xeroSchemas[stream];
    const parsed = schema.safeParse(raw);
    const contract = this.manifest.streams.find((item) => item.id === stream);
    if (!contract) throw new ConnectorError("CONFIGURATION_INVALID", `Unknown Xero stream ${stream}.`);
    if (!parsed.success) {
      const candidate = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return {
        sourceObjectType: contract.resource,
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
    const moneyFields: Record<string, readonly [unknown, unknown?]> = {};
    for (const field of [
      "SubTotal", "TotalTax", "Total", "AmountDue", "AmountPaid", "RemainingCredit",
      "Amount", "BankAmount", "CurrencyRate", "DisplayTaxRate", "EffectiveRate",
    ]) {
      if (field in fields) moneyFields[field] = [fields[field], fields.CurrencyCode];
    }
    const normalizationIssues = Object.entries(moneyFields)
      .filter(([, [value, currency]]) => value != null && normalizeDecimal(value, currency).exact === null)
      .map(([field]) => ({
        code: "normalization_invalid" as const,
        path: field,
        message: "The Xero amount is not a valid exact decimal.",
      }));
    const issues = [
      ...drift.map((field) => ({
        code: "schema_drift" as const,
        path: field,
        message: "The vendor returned a field without an approved coverage disposition.",
      })),
      ...normalizationIssues,
    ];
    const updatedRaw = fields.UpdatedDateUTCString ?? fields[contract.modifiedField ?? ""];
    const updated = normalizeTimestamp(updatedRaw);
    const status = typeof fields.Status === "string" ? fields.Status.toUpperCase() : "";
    return {
      sourceObjectType: contract.resource,
      sourceRecordId: String(fields[contract.recordIdField]),
      sourceUpdatedAt: updated.utc ?? undefined,
      payload: raw,
      payloadHash,
      normalized: normalizationIssues.length === 0
        ? projectSourceRecord({
            schemaVersion: this.version,
            fields: approvedFields,
            money: moneyFields,
            timestamps: {
              source_updated_at: [updatedRaw, undefined],
              event_date: [fields.Date ?? fields.JournalDate, undefined],
            },
            tombstone: status === "ARCHIVED" || status === "DELETED",
          })
        : undefined,
      validationIssues: issues.length > 0 ? issues : undefined,
    };
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
  id: string,
  available: boolean,
  requiredScopes: readonly string[],
): ConnectorCapability {
  return { id, support: available ? "full" : "unavailable", requiredScopes };
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
