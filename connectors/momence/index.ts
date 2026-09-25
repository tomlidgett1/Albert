import { z } from "zod";

import {
  ConnectorError,
  ConnectorHttpError,
  credentialExpiresSoon,
  decodeCursor,
  encodeCursor,
  hashPayload,
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
} from "../../packages/connector-sdk/src/index.js";
import {
  MOMENCE_ALLOWED_SCOPES,
  MOMENCE_DEFAULT_SCOPES,
  momenceManifest,
} from "./manifest.js";
import {
  buildMomenceFieldIndex,
  momenceStringAtPath,
  momenceTimestampAtPath,
  momenceValueAtPath,
} from "./field-index.js";
import { buildMomenceAuthorizationUrl } from "./oauth-public.js";
import { validateMomenceEntity } from "./openapi-validator.js";
import {
  MOMENCE_READ_STREAMS,
  MOMENCE_STREAM_BY_ID,
  momenceDeletionContract,
  momenceSourceTotalContract,
  type MomenceFanoutStream,
  type MomencePageStream,
  type MomenceReadStream,
  type MomenceStreamId,
} from "./streams.js";

const API_ORIGIN = "https://api.momence.com";
const TOKEN_ENDPOINT = `${API_ORIGIN}/api/v2/auth/token`;
const PROFILE_ENDPOINT = "/api/v2/auth/profile";

/** Official AuthTokenDto uses absolute expiries and publishes both token aliases. */
const tokenSchema = z.object({
  accessToken: z.string().min(1).optional(),
  access_token: z.string().min(1).optional(),
  accessTokenExpiresAt: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  refreshTokenExpiresAt: z.string().min(1).optional(),
  scope: z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough().superRefine((value, context) => {
  if (!value.accessToken && !value.access_token) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "access token is missing" });
  }
});

const profileSchema = z.object({
  userId: z.union([z.string(), z.number()]),
  memberId: z.union([z.string(), z.number()]).nullable().optional(),
  email: z.string().min(1),
  firstName: z.string(),
  lastName: z.string(),
}).passthrough();

const pageSchema = z.object({
  pagination: z.object({
    page: z.coerce.number().int().min(0),
    pageSize: z.coerce.number().int().positive(),
    totalCount: z.coerce.number().int().min(0),
    sortBy: z.string().nullable().optional(),
    sortOrder: z.string().nullable().optional(),
  }).passthrough(),
  payload: z.array(z.unknown()),
}).passthrough();

type MomenceToken = Readonly<{
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  scope?: string | readonly string[];
}>;

type PageContinuation = Readonly<{
  kind: "page";
  page: number;
  lastFingerprint?: string;
  rangeFrom?: string;
  rangeTo?: string;
}>;

type FanoutContinuation = Readonly<{
  kind: "fanout";
  parentPage: number;
  parentIndex: number;
  childPage: number;
  observedCount: number;
  lastFingerprint?: string;
  parentFingerprint?: string;
  rangeFrom?: string;
  rangeTo?: string;
}>;

type PaymentContinuation = Readonly<{
  kind: "payment";
  memberPage: number;
  memberIndex: number;
  notePage: number;
  noteIndex: number;
  memberFingerprint?: string;
  noteFingerprint?: string;
}>;

type MomenceContinuation = PageContinuation | FanoutContinuation | PaymentContinuation;

type CachedMomencePage = Readonly<{
  expiresAt: number;
  value: z.infer<typeof pageSchema>;
}>;

type CachedMomencePaymentDetail = Readonly<{
  expiresAt: number;
  found: true;
  value: unknown;
}> | Readonly<{
  expiresAt: number;
  found: false;
}>;

const PAGE_CACHE_TTL_MS = 6 * 60 * 60_000;
const MAX_CACHED_TRAVERSAL_PAGES = 64;
const PAYMENT_DETAIL_CACHE_TTL_MS = 6 * 60 * 60_000;
const MAX_CACHED_PAYMENT_DETAILS = 512;
const MAX_MOMENCE_CONTINUATION_BYTES = 8 * 1_024;

export type MomenceConnectorConfig = Readonly<{
  clientId: string;
  clientSecret: string;
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

function isoOrThrow(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Momence returned an unparseable ${label}.`);
  }
  return new Date(parsed).toISOString();
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function continuation(cursor: SyncCursor | undefined, stream: MomenceReadStream): MomenceContinuation | undefined {
  if (!cursor) return undefined;
  const state = decodeCursor(cursor, { connector: "momence", stream: stream.id });
  if (typeof state.continuation !== "string") return undefined;
  try {
    const continuationBytes = Buffer.from(state.continuation, "base64url");
    if (continuationBytes.byteLength > MAX_MOMENCE_CONTINUATION_BYTES) {
      throw new Error("Momence continuation exceeds its durable size bound.");
    }
    const parsed = JSON.parse(continuationBytes.toString("utf8")) as MomenceContinuation;
    if (
      parsed.kind === "page" && Number.isInteger(parsed.page) && parsed.page >= 0 &&
      validFingerprint(parsed.lastFingerprint) && validFrozenRange(parsed.rangeFrom, parsed.rangeTo)
    ) return parsed;
    if (
      parsed.kind === "fanout" &&
      [parsed.parentPage, parsed.parentIndex, parsed.childPage, parsed.observedCount]
        .every((value) => Number.isInteger(value) && value >= 0) &&
      validFingerprint(parsed.lastFingerprint) && validFingerprint(parsed.parentFingerprint) &&
      validFrozenRange(parsed.rangeFrom, parsed.rangeTo)
    ) return parsed;
    if (
      parsed.kind === "payment" &&
      [parsed.memberPage, parsed.memberIndex, parsed.notePage, parsed.noteIndex]
        .every((value) => Number.isSafeInteger(value) && value >= 0) &&
      validFingerprint(parsed.memberFingerprint) && validFingerprint(parsed.noteFingerprint) &&
      validPaymentContinuation(parsed)
    ) return parsed;
  } catch {
    // Converted below to a connector-scoped cursor error.
  }
  throw new ConnectorError("CURSOR_INVALID", `The Momence ${stream.id} continuation is invalid.`);
}

function validFingerprint(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value));
}

function validFrozenRange(from: unknown, to: unknown): boolean {
  if (from === undefined && to === undefined) return true;
  if (typeof from !== "string" || typeof to !== "string") return false;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  return Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs;
}

function paymentIdentity(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ConnectorError(
      "REMOTE_RESPONSE_INVALID",
      "Momence returned a payment transaction identity that is not a safe JSON integer.",
    );
  }
  return String(value);
}

function validPaymentContinuation(parsed: PaymentContinuation): boolean {
  const allowedKeys = new Set([
    "kind", "memberPage", "memberIndex", "notePage", "noteIndex",
    "memberFingerprint", "noteFingerprint",
  ]);
  return Object.keys(parsed).every((key) => allowedKeys.has(key));
}

function encodeContinuation(value: MomenceContinuation): string {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.byteLength > MAX_MOMENCE_CONTINUATION_BYTES) {
    throw new ConnectorError(
      "CURSOR_INVALID",
      "Momence continuation exceeded its bounded durable size.",
    );
  }
  return bytes.toString("base64url");
}

function pageFingerprint(records: readonly unknown[]): string {
  return hashPayload(records.map((record) =>
    isObject(record) ? record.id ?? record.userId ?? record : record));
}

function addQuery(url: URL, values: Readonly<Record<string, string | number | boolean | undefined>>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
}

/** Production Momence public-API-v2 connector; every vendor request is read-only. */
export class MomenceConnector implements OAuthConnectorPack {
  readonly id = "momence" as const;
  readonly version = momenceManifest.packVersion;
  readonly apiVersion = momenceManifest.apiVersion;
  readonly manifest = momenceManifest;

  private readonly config: MomenceConnectorConfig;
  private readonly fetcher: FetchLike;
  private readonly clock: () => number;
  private readonly refreshes = new Map<string, Promise<VersionedCredential>>();
  private readonly requestLanes = new Map<string, Promise<void>>();
  private readonly traversalPages = new Map<string, CachedMomencePage>();
  private readonly paymentDetails = new Map<string, CachedMomencePaymentDetail>();
  private readonly successfulStreams = new Set<string>();

  constructor(config: MomenceConnectorConfig) {
    this.config = {
      ...config,
      clientId: required(config.clientId, "Momence client ID"),
      clientSecret: required(config.clientSecret, "Momence client secret"),
      redirectUri: required(config.redirectUri, "Momence redirect URI"),
    };
    this.fetcher = config.fetcher ?? fetch;
    this.clock = config.now ?? (() => Date.now());
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    const scopes = request.scopes.length > 0 ? request.scopes : MOMENCE_DEFAULT_SCOPES;
    const unsupported = scopes.filter(
      (scope) => !MOMENCE_ALLOWED_SCOPES.includes(scope as (typeof MOMENCE_ALLOWED_SCOPES)[number]),
    );
    if (unsupported.length > 0) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        `Unsupported Momence scope requested: ${unsupported.join(", ")}.`,
      );
    }
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Momence redirect URI does not match configured OAuth client.");
    }
    return {
      url: buildMomenceAuthorizationUrl({
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
      throw new ConnectorError("CONFIGURATION_INVALID", "Momence redirect URI does not match configured OAuth client.");
    }
    const token = await this.postToken({
      grant_type: "authorization_code",
      code: required(request.code, "Momence authorization code"),
      redirect_uri: request.redirectUri,
    }, request.abortSignal, "Momence returned an invalid OAuth token response.");
    if (!token.refreshToken) {
      throw new ConnectorError(
        "OAUTH_EXCHANGE_FAILED",
        "Momence did not return the refresh token required for unattended ingestion.",
      );
    }
    const scopes = splitOAuthScopes(token.scope);
    const stored = await this.config.vault.create({
      provider: this.id,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      tokenType: "Bearer",
      expiresAt: token.accessTokenExpiresAt,
      scopes: scopes.length > 0 ? scopes : MOMENCE_DEFAULT_SCOPES,
      metadata: {
        refreshTokenExpiresAt: token.refreshTokenExpiresAt ?? "",
      },
    });
    return {
      credentialRef: stored.credentialRef,
      expiresAt: stored.secret.expiresAt,
      scopes: stored.secret.scopes,
    };
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
    const value = await this.apiJson(context, credential, PROFILE_ENDPOINT);
    const parsed = profileSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Momence returned an invalid AuthProfileDto.", {
        cause: parsed.error,
      });
    }
    const profile = parsed.data;
    const userId = String(profile.userId);
    const name = `${profile.firstName} ${profile.lastName}`.trim();
    return {
      // Public API v2 does not expose the selected host id. userId is the only
      // stable documented grant identity; the limitation is fail-visible in
      // the manifest instead of guessing a host id from unrelated records.
      externalAccountId: `user:${userId}`,
      displayName: name || profile.email,
      metadata: {
        userId,
        memberId: profile.memberId == null ? null : String(profile.memberId),
        email: profile.email,
        hostIdentityAvailable: false,
      },
    };
  }

  async select_account(context: ConnectorContext, externalAccountId: string): Promise<ConnectionDiscovery> {
    const account = await this.discover_account(context);
    if (account.externalAccountId !== externalAccountId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "The Momence grant identity changed during account selection.");
    }
    return account;
  }

  async list_streams(context: ConnectorContext): Promise<readonly ConnectorStream[]> {
    void context;
    return MOMENCE_READ_STREAMS.map((stream) => ({
      id: stream.id,
      label: stream.label,
      domains: stream.productDomains,
      cursorKind: stream.kind === "singleton" ? "none" as const : "page" as const,
      backfillStrategy: "timeFilter" in stream && stream.timeFilter ? "time_windowed" as const : "snapshot" as const,
      lateEditStrategy: "full_snapshot" as const,
      deletionStrategy: momenceDeletionContract(stream),
      sourceTotalStrategy: momenceSourceTotalContract(stream),
      availability: stream.availability,
      dependencies: stream.dependencies,
      productDomains: stream.productDomains,
      priority: stream.priority,
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
    return this.sync(context, stream, "reconciliation", request.cursor, request.range);
  }

  async handle_webhook(
    context: ConnectorContext,
    event: WebhookEnvelope,
  ): Promise<WebhookDisposition> {
    void context; void event;
    // Momence webhooks are experimental, support-enabled and dashboard-only;
    // there is no API installation/verification contract complete enough to
    // make them an ingestion authority. Polling plus reconciliation owns truth.
    return { accepted: false, streams: [], reason: "momence_experimental_webhooks_not_configured" };
  }

  async refresh_credentials(context: ConnectorContext): Promise<{ credentialRef: string }> {
    const current = await this.readCredential(context);
    return { credentialRef: (await this.refreshCredential(current, context.abortSignal)).credentialRef };
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    // Momence documents logout for the current access token, not an OAuth grant
    // revocation endpoint. Local encrypted credential destruction is reliable;
    // remote client removal remains a Momence-dashboard action.
    await this.config.vault.destroy(context.credentialRef);
  }

  async describe_capabilities(context: ConnectorContext): Promise<readonly ConnectorCapability[]> {
    const observed = (stream: MomenceStreamId) => this.successfulStreams.has(`${context.connectionId}:${stream}`);
    const salesObserved = observed("momence_sales");
    const paymentsObserved = observed("momence_payment_transactions");
    return [
      {
        id: "commerce.orders", support: salesObserved ? "partial" : "unknown",
        reasonCode: salesObserved ? "live_stream_observed" : "experimental_endpoint_probe_required",
        notes: "Momence host sales is experimental and must be enabled by Momence support.",
      },
      {
        id: "commerce.order_lines", support: salesObserved ? "partial" : "unknown",
        reasonCode: salesObserved ? "live_stream_observed" : "experimental_endpoint_probe_required",
      },
      {
        id: "commerce.payments", support: paymentsObserved ? "partial" : "unknown",
        reasonCode: paymentsObserved ? "live_stream_observed" : "payment_transaction_ids_required",
        notes: "Momence exposes payment transaction detail but no transaction list.",
      },
      {
        id: "commerce.refunds", support: paymentsObserved ? "partial" : "unknown",
        reasonCode: paymentsObserved ? "live_stream_observed" : "payment_transaction_ids_required",
      },
      {
        id: "commerce.orders.customer", support: salesObserved ? "partial" : "unknown",
        reasonCode: salesObserved ? "live_stream_observed" : "experimental_endpoint_probe_required",
      },
      {
        id: "commerce.order_lines.discounts", support: salesObserved ? "partial" : "unknown",
        reasonCode: salesObserved ? "live_stream_observed" : "experimental_endpoint_probe_required",
      },
      {
        id: "source.webhooks", support: "unavailable",
        reasonCode: "experimental_dashboard_only_installation",
        notes: "Webhooks are not required for completeness; scheduled reconciliation remains authoritative.",
      },
    ];
  }

  private async sync(
    context: ConnectorContext,
    requested: ConnectorStream,
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
  ): Promise<SyncPage> {
    const stream = MOMENCE_STREAM_BY_ID.get(requested.id as MomenceStreamId);
    if (!stream) throw new ConnectorError("CONFIGURATION_INVALID", `Unknown Momence stream: ${requested.id}.`);
    try {
      const page = stream.kind === "singleton"
        ? await this.syncSingleton(context, stream, mode, range)
        : stream.kind === "page"
          ? await this.syncPage(context, stream, mode, cursor, range)
          : stream.id === "momence_payment_transactions"
            ? await this.syncPaymentTransactions(context, stream, mode, cursor, range)
            : await this.syncFanout(context, stream, mode, cursor, range);
      if (!page.paginationBlock) this.successfulStreams.add(`${context.connectionId}:${stream.id}`);
      return page;
    } catch (error) {
      if (
        stream.availability === "optional" &&
        error instanceof ConnectorHttpError &&
        [403, 404, 405, 501].includes(error.status)
      ) {
        throw new ConnectorError(
          "CAPABILITY_UNAVAILABLE",
          `Momence does not expose the optional ${stream.label} API for this host or staff role.`,
          { cause: error, details: { stream: stream.id, status: error.status } },
        );
      }
      throw error;
    }
  }

  private async syncSingleton(
    context: ConnectorContext,
    stream: MomenceReadStream,
    mode: "initial" | "incremental" | "reconciliation",
    range?: SyncRange,
  ): Promise<SyncPage> {
    const credential = await this.validCredential(context);
    const raw = await this.apiJson(context, credential, stream.endpoint);
    const record = this.toRawRecord(stream, raw);
    return {
      records: [record],
      nextCursor: this.cursor(stream, mode, undefined, range),
      sourceTotal: 1,
      hasMore: false,
      coverage: this.coverage(stream, range),
    };
  }

  private async syncPage(
    context: ConnectorContext,
    stream: MomencePageStream,
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
  ): Promise<SyncPage> {
    const state = continuation(cursor, stream);
    if (state && state.kind !== "page") {
      throw new ConnectorError("CURSOR_INVALID", `The Momence ${stream.id} cursor has the wrong traversal kind.`);
    }
    const page = state?.page ?? 0;
    const effectiveRange = this.effectiveTimeRange(stream, mode, state, range);
    const url = new URL(stream.endpoint, API_ORIGIN);
    addQuery(url, {
      page,
      pageSize: stream.pageSize ?? 100,
      sortBy: stream.sortBy,
      sortOrder: stream.sortOrder,
      ...stream.fixedQuery,
      ...this.timeQuery(stream, effectiveRange),
    });
    const credential = await this.validCredential(context);
    const value = await this.apiJson(context, credential, url);
    const parsed = pageSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Momence returned an invalid ${stream.label} page.`, {
        cause: parsed.error,
      });
    }
    const response = parsed.data;
    if (response.pagination.page !== page) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Momence returned page ${response.pagination.page} for requested page ${page}.`);
    }
    const fingerprint = pageFingerprint(response.payload);
    const hasMore = (page + 1) * response.pagination.pageSize < response.pagination.totalCount;
    const paginationBlock = state?.lastFingerprint === fingerprint && response.payload.length > 0
      ? {
          code: "pagination_not_advancing" as const,
          detail: `Momence ${stream.id} returned the same identity page at offset ${page}.`,
        }
      : hasMore && response.payload.length === 0
        ? {
            code: "pagination_identity_invalid" as const,
            detail: `Momence ${stream.id} reported more records after an empty page.`,
          }
        : undefined;
    const records = response.payload.map((raw) => this.toRawRecord(stream, raw));
    return {
      records,
      nextCursor: paginationBlock ? null : this.cursor(
        stream,
        mode,
        hasMore ? {
          kind: "page", page: page + 1, lastFingerprint: fingerprint,
          ...(effectiveRange ? { rangeFrom: effectiveRange.from, rangeTo: effectiveRange.to } : {}),
        } : undefined,
        effectiveRange ?? range,
      ),
      sourceTotal: hasMore ? undefined : response.pagination.totalCount,
      // A block describes a vendor page that claimed more data but could not
      // produce a safe successor identity. Keep hasMore=true while withholding
      // the cursor so the worker lands evidence and then fails the run closed.
      hasMore: paginationBlock ? true : hasMore,
      ...(paginationBlock ? { paginationBlock } : {}),
      ...(!hasMore && !paginationBlock
        ? { coverage: this.coverage(stream, effectiveRange ?? range) }
        : {}),
    };
  }

  private async syncFanout(
    context: ConnectorContext,
    stream: MomenceFanoutStream,
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
  ): Promise<SyncPage> {
    const decoded = continuation(cursor, stream);
    if (decoded && decoded.kind !== "fanout") {
      throw new ConnectorError("CURSOR_INVALID", `The Momence ${stream.id} cursor has the wrong traversal kind.`);
    }
    if (!decoded) this.clearTraversalPages(context, stream.id);
    const state: FanoutContinuation = decoded ?? {
      kind: "fanout", parentPage: 0, parentIndex: 0, childPage: 0, observedCount: 0,
    };
    const effectiveRange = this.effectiveTimeRange(stream, mode, state, range);
    const parentUrl = new URL(stream.parent.endpoint, API_ORIGIN);
    addQuery(parentUrl, {
      page: state.parentPage,
      pageSize: stream.parent.pageSize,
      sortBy: stream.parent.sortBy,
      sortOrder: stream.parent.sortOrder,
      ...(stream.parent.endpoint.endsWith("/sessions") ? { includeCancelled: true } : {}),
      ...(stream.timeFilter?.target === "parent" ? this.timeQuery(stream, effectiveRange) : {}),
    });
    const credential = await this.validCredential(context);
    const parentResponse = await this.traversalPage(
      context,
      credential,
      stream.id,
      "parent",
      parentUrl,
      `Momence returned an invalid parent page for ${stream.label}.`,
    );
    if (parentResponse.pagination.page !== state.parentPage) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Momence returned the wrong parent page for ${stream.id}.`);
    }
    const parentFingerprint = pageFingerprint(parentResponse.payload);
    const resumingCurrentParentPage = state.parentIndex > 0 || state.childPage > 0;
    if (
      resumingCurrentParentPage && state.parentFingerprint &&
      state.parentFingerprint !== parentFingerprint
    ) {
      return this.paginationBlocked(
        "pagination_identity_invalid",
        `Momence ${stream.id} parent page changed during child traversal.`,
      );
    }
    if (
      state.parentPage > 0 && state.parentIndex === 0 && state.childPage === 0 &&
      state.parentFingerprint === parentFingerprint && parentResponse.payload.length > 0
    ) {
      return this.paginationBlocked(
        "pagination_not_advancing",
        `Momence ${stream.id} repeated parent page ${state.parentPage}.`,
      );
    }

    let parentIndex = state.parentIndex;
    let parentId: string | null = null;
    while (parentIndex < parentResponse.payload.length && !parentId) {
      parentId = momenceStringAtPath(parentResponse.payload[parentIndex], stream.parent.recordIdPath);
      if (!parentId) parentIndex += 1;
    }

    const parentHasNextPage = (state.parentPage + 1) * parentResponse.pagination.pageSize
      < parentResponse.pagination.totalCount;
    if (!parentId) {
      if (parentHasNextPage) {
        return this.paginationBlocked(
          "pagination_identity_invalid",
          `Momence ${stream.id} reported more parent records after a page without a usable identity.`,
        );
      }
      return {
        records: [], hasMore: false, sourceTotal: state.observedCount,
        nextCursor: this.cursor(stream, mode, undefined, effectiveRange ?? range),
        coverage: this.coverage(stream, effectiveRange ?? range),
      };
    }

    const childPath = stream.endpoint.replace(
      `{${stream.parentPathParameter}}`,
      encodeURIComponent(parentId),
    );
    const childUrl = new URL(childPath, API_ORIGIN);
    if (stream.childPagination === "page") {
      addQuery(childUrl, {
        page: state.childPage,
        pageSize: stream.pageSize ?? 100,
        sortBy: stream.sortBy,
        sortOrder: stream.sortOrder,
        ...stream.fixedQuery,
        ...(stream.timeFilter?.target === "child" ? this.timeQuery(stream, effectiveRange) : {}),
      });
    }

    let childValue: unknown;
    try {
      childValue = await this.apiJson(context, credential, childUrl);
    } catch (error) {
      // A parent can disappear between list and detail requests. That is an
      // expected reconciliation race, not proof the whole optional API is off.
      if (error instanceof ConnectorHttpError && error.status === 404) {
        if (
          stream.availability === "optional" && state.observedCount === 0 &&
          state.parentPage === 0 && parentIndex === 0 && state.childPage === 0
        ) throw error;
        return this.advanceFanout(
          stream, mode, state, parentIndex, parentResponse, [],
          effectiveRange ?? range, parentFingerprint,
        );
      }
      throw error;
    }

    if (stream.childPagination === "singleton") {
      const records = [this.toRawRecord(stream, childValue, parentId)];
      return this.advanceFanout(
        stream, mode, state, parentIndex, parentResponse, records,
        effectiveRange ?? range, parentFingerprint,
      );
    }

    const childParsed = pageSchema.safeParse(childValue);
    if (!childParsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Momence returned an invalid ${stream.label} child page.`, {
        cause: childParsed.error,
      });
    }
    const childResponse = childParsed.data;
    if (childResponse.pagination.page !== state.childPage) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Momence returned the wrong child page for ${stream.id}.`);
    }
    const fingerprint = pageFingerprint(childResponse.payload);
    const childHasMore = (state.childPage + 1) * childResponse.pagination.pageSize
      < childResponse.pagination.totalCount;
    if (state.lastFingerprint === fingerprint && childResponse.payload.length > 0) {
      return this.paginationBlocked(
        "pagination_not_advancing",
        `Momence ${stream.id} repeated child page ${state.childPage} for parent ${parentId}.`,
        childResponse.payload.map((raw) => this.toRawRecord(stream, raw, parentId)),
      );
    }
    if (childHasMore && childResponse.payload.length === 0) {
      return this.paginationBlocked(
        "pagination_identity_invalid",
        `Momence ${stream.id} reported more child records after an empty page for parent ${parentId}.`,
      );
    }
    const records = childResponse.payload.map((raw) => this.toRawRecord(stream, raw, parentId));
    if (childHasMore) {
      return {
        records,
        hasMore: true,
        nextCursor: this.cursor(stream, mode, {
          ...state,
          parentIndex,
          childPage: state.childPage + 1,
          observedCount: state.observedCount + records.length,
          lastFingerprint: fingerprint,
          parentFingerprint,
          ...(effectiveRange ? { rangeFrom: effectiveRange.from, rangeTo: effectiveRange.to } : {}),
        }, effectiveRange ?? range),
      };
    }
    return this.advanceFanout(
      stream, mode, state, parentIndex, parentResponse, records,
      effectiveRange ?? range, parentFingerprint,
    );
  }

  private async syncPaymentTransactions(
    context: ConnectorContext,
    stream: MomenceFanoutStream,
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
  ): Promise<SyncPage> {
    const decoded = continuation(cursor, stream);
    if (decoded && decoded.kind !== "payment") {
      throw new ConnectorError("CURSOR_INVALID", "The Momence payment-transaction cursor has the wrong traversal kind.");
    }
    if (!decoded) {
      this.clearTraversalPages(context, stream.id);
      this.clearPaymentDetails(context, stream.id);
    }
    let state: PaymentContinuation = decoded ?? {
      kind: "payment", memberPage: 0, memberIndex: 0, notePage: 0, noteIndex: 0,
    };
    const credential = await this.validCredential(context);

    // Empty pages and members with no transaction-linked note are traversed in
    // one call. Bound the loop so a pathological sparse account yields durable
    // continuation work instead of holding a worker lease indefinitely.
    for (let traversal = 0; traversal < 25; traversal += 1) {
      const memberUrl = new URL("/api/v2/host/members", API_ORIGIN);
      addQuery(memberUrl, {
        page: state.memberPage, pageSize: 100, sortBy: "email", sortOrder: "ASC",
      });
      const members = await this.traversalPage(
        context,
        credential,
        stream.id,
        "member",
        memberUrl,
        "Momence returned an invalid member page for payment discovery.",
      );
      if (members.pagination.page !== state.memberPage) {
        throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Momence returned the wrong member page for payment discovery.");
      }
      const memberFingerprint = pageFingerprint(members.payload);
      const resumingCurrentMemberPage = state.memberIndex > 0 || state.notePage > 0 || state.noteIndex > 0;
      if (
        resumingCurrentMemberPage && state.memberFingerprint &&
        state.memberFingerprint !== memberFingerprint
      ) {
        return this.paginationBlocked(
          "pagination_identity_invalid",
          "Momence payment discovery member page changed during note traversal.",
        );
      }
      if (
        state.memberPage > 0 && state.memberIndex === 0 && state.notePage === 0 && state.noteIndex === 0 &&
        state.memberFingerprint === memberFingerprint && members.payload.length > 0
      ) {
        return this.paginationBlocked(
          "pagination_not_advancing",
          `Momence payment discovery repeated member page ${state.memberPage}.`,
        );
      }
      const member = members.payload[state.memberIndex];
      const memberId = momenceStringAtPath(member, "id");
      if (!memberId) {
        const memberHasNextPage = (state.memberPage + 1) * members.pagination.pageSize
          < members.pagination.totalCount;
        if (memberHasNextPage && members.payload.length === 0) {
          return this.paginationBlocked(
            "pagination_identity_invalid",
            "Momence payment discovery reported more members after an empty page.",
          );
        }
        if (!memberHasNextPage) {
          return {
            records: [], hasMore: false,
            nextCursor: this.cursor(stream, mode, undefined, range),
            coverage: this.coverage(stream, range),
          };
        }
        state = {
          kind: "payment", memberPage: state.memberPage + 1,
          memberIndex: 0, notePage: 0, noteIndex: 0,
          memberFingerprint,
        };
        continue;
      }

      const noteUrl = new URL(
        `/api/v2/host/members/${encodeURIComponent(memberId)}/notes`,
        API_ORIGIN,
      );
      addQuery(noteUrl, {
        page: state.notePage, pageSize: 100, sortBy: "modifiedAt", sortOrder: "ASC",
      });
      let notes: z.infer<typeof pageSchema>;
      try {
        notes = await this.traversalPage(
          context,
          credential,
          stream.id,
          "note",
          noteUrl,
          "Momence returned an invalid notes page for payment discovery.",
        );
      } catch (error) {
        // 404 can be a member deleted between population and fan-out. A 403 is
        // host/role-wide capability evidence and must surface as unavailable;
        // treating it as an empty payment population would manufacture zero.
        if (error instanceof ConnectorHttpError && error.status === 404) {
          if (
            state.memberPage === 0 &&
            state.memberIndex === 0 && state.notePage === 0 && state.noteIndex === 0
          ) throw error;
          state = this.nextPaymentMember(state, members.payload.length, memberFingerprint);
          continue;
        }
        throw error;
      }
      if (notes.pagination.page !== state.notePage) {
        throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Momence returned the wrong notes page for payment discovery.");
      }
      const noteFingerprint = pageFingerprint(notes.payload);
      if (
        state.noteIndex > 0 && state.noteFingerprint &&
        state.noteFingerprint !== noteFingerprint
      ) {
        return this.paginationBlocked(
          "pagination_identity_invalid",
          `Momence payment discovery note page changed during transaction traversal for member ${memberId}.`,
        );
      }
      if (
        state.notePage > 0 && state.noteIndex === 0 &&
        state.noteFingerprint === noteFingerprint && notes.payload.length > 0
      ) {
        return this.paginationBlocked(
          "pagination_not_advancing",
          `Momence payment discovery repeated note page ${state.notePage} for member ${memberId}.`,
        );
      }
      let noteIndex = state.noteIndex;
      let transactionId: string | undefined;
      while (noteIndex < notes.payload.length && !transactionId) {
        transactionId = paymentIdentity(
          momenceValueAtPath(notes.payload[noteIndex], "paymentTransactionId"),
        );
        noteIndex += 1;
      }
      if (!transactionId) {
        const notesHaveNextPage = (state.notePage + 1) * notes.pagination.pageSize
          < notes.pagination.totalCount;
        if (notesHaveNextPage && notes.payload.length === 0) {
          return this.paginationBlocked(
            "pagination_identity_invalid",
            `Momence payment discovery reported more notes after an empty page for member ${memberId}.`,
          );
        }
        state = notesHaveNextPage
          ? {
              ...state,
              notePage: state.notePage + 1,
              noteIndex: 0,
              memberFingerprint,
              noteFingerprint,
            }
          : this.nextPaymentMember(state, members.payload.length, memberFingerprint);
        continue;
      }

      const afterNote: PaymentContinuation = noteIndex < notes.payload.length
        ? {
            ...state,
            noteIndex,
            memberFingerprint,
            noteFingerprint,
          }
        : (state.notePage + 1) * notes.pagination.pageSize < notes.pagination.totalCount
          ? {
              ...state,
              notePage: state.notePage + 1,
              noteIndex: 0,
              memberFingerprint,
              noteFingerprint,
            }
          : this.nextPaymentMember(state, members.payload.length, memberFingerprint);
      const detail = await this.paymentDetail(context, credential, stream.id, transactionId);
      if (!detail.found) {
        state = afterNote;
        continue;
      }
      // Re-emit cached successes for every discovered reference. This is
      // intentionally at-least-once: suppressing an emission from an
      // in-process cache could lose the record if the earlier landing failed.
      // Durable reconciliation derives the exact distinct identity set.
      return {
        records: [this.toRawRecord(stream, detail.value, memberId)],
        hasMore: true,
        nextCursor: this.cursor(stream, mode, afterNote, range),
      };
    }

    return {
      records: [], hasMore: true,
      nextCursor: this.cursor(stream, mode, state, range),
    };
  }

  private nextPaymentMember(
    state: PaymentContinuation,
    membersOnPage: number,
    memberFingerprint: string,
  ): PaymentContinuation {
    return state.memberIndex + 1 < membersOnPage
      ? {
          ...state,
          memberIndex: state.memberIndex + 1,
          notePage: 0,
          noteIndex: 0,
          memberFingerprint,
          noteFingerprint: undefined,
        }
      : {
          kind: "payment", memberPage: state.memberPage + 1,
          memberIndex: 0, notePage: 0, noteIndex: 0,
          memberFingerprint,
        };
  }

  private advanceFanout(
    stream: MomenceFanoutStream,
    mode: "initial" | "incremental" | "reconciliation",
    state: FanoutContinuation,
    parentIndex: number,
    parentResponse: z.infer<typeof pageSchema>,
    records: readonly RawSourceRecord[],
    range?: SyncRange,
    parentFingerprint = pageFingerprint(parentResponse.payload),
  ): SyncPage {
    const observedCount = state.observedCount + records.length;
    const nextParentIndex = parentIndex + 1;
    const currentParentPageHasMore = nextParentIndex < parentResponse.payload.length;
    const parentHasNextPage = (state.parentPage + 1) * parentResponse.pagination.pageSize
      < parentResponse.pagination.totalCount;
    const hasMore = currentParentPageHasMore || parentHasNextPage;
    const nextState: FanoutContinuation | undefined = currentParentPageHasMore
      ? {
          kind: "fanout", parentPage: state.parentPage, parentIndex: nextParentIndex,
          childPage: 0, observedCount, parentFingerprint,
          ...(range && "timeFilter" in stream && stream.timeFilter
            ? { rangeFrom: range.from, rangeTo: range.to }
            : {}),
        }
      : parentHasNextPage
        ? {
            kind: "fanout", parentPage: state.parentPage + 1, parentIndex: 0,
            childPage: 0, observedCount, parentFingerprint,
            ...(range && "timeFilter" in stream && stream.timeFilter
              ? { rangeFrom: range.from, rangeTo: range.to }
              : {}),
          }
        : undefined;
    return {
      records,
      hasMore,
      nextCursor: this.cursor(stream, mode, nextState, range),
      ...(hasMore ? {} : {
        sourceTotal: observedCount,
        coverage: this.coverage(stream, range),
      }),
    };
  }

  private toRawRecord(stream: MomenceReadStream, raw: unknown, parentId?: string): RawSourceRecord {
    const payloadHash = hashPayload(raw);
    const schemaIssues = validateMomenceEntity(stream.id, raw);
    if (!isObject(raw)) {
      return {
        sourceObjectType: stream.resource,
        sourceRecordId: `invalid:${payloadHash}`,
        payload: raw,
        payloadHash,
        validationIssues: schemaIssues,
      };
    }
    const nativeId = momenceStringAtPath(raw, stream.recordIdPath);
    const sourceRecordId = nativeId
      ? stream.kind === "fanout" && stream.compositeIdentity && parentId
        ? `${parentId}:${nativeId}`
        : nativeId
      : `invalid:${payloadHash}`;
    const occurredAt = momenceTimestampAtPath(
      raw,
      stream.modifiedPath ?? "",
      "modifiedAt", "createdAt", "saleDate", "startsAt", "startDate", "firstSeen",
    );
    const amount = momenceStringAtPath(
      raw,
      "paidInCurrency", "paymentValue", "priceInCurrency", "priceExcludingVatInCurrency",
      "price", "unitPriceExcludingTaxInCurrency", "moneyCreditsLeft",
    );
    const fields = {
      recordId: sourceRecordId,
      parentId: parentId ?? null,
      endpoint: stream.endpoint,
      payloadJson: raw,
      fieldIndex: buildMomenceFieldIndex(raw),
      name: momenceStringAtPath(raw, "name", "label", "itemName", "descriptiveItemName"),
      status: momenceStringAtPath(raw, "status", "paymentStatus", "attendanceStatus", "type"),
      occurredAt,
      memberId: momenceStringAtPath(raw, "memberId", "member.id", "payingMember.id", "targetMember.id") ?? parentId ?? null,
      sessionId: momenceStringAtPath(raw, "sessionId", "session.id"),
      currency: momenceStringAtPath(raw, "currency"),
      amount,
      quantity: momenceStringAtPath(raw, "quantity", "bookingCount", "visits", "ticketsBought"),
      isCancelled: Boolean(
        momenceValueAtPath(raw, "isCancelled") === true || momenceValueAtPath(raw, "cancelledAt"),
      ),
    };
    const identityPath = `$.${stream.recordIdPath}`;
    const issues = [...schemaIssues];
    if (!nativeId && !issues.some(({ code, path }) => code === "schema_invalid" && path === identityPath)) {
      issues.push({
        code: "schema_invalid",
        path: identityPath,
        message: `Momence ${stream.resource} has no documented record identity.`,
      });
    }
    return {
      sourceObjectType: stream.resource,
      sourceRecordId,
      ...(occurredAt ? { sourceUpdatedAt: occurredAt } : {}),
      payload: raw,
      payloadHash,
      normalized: nativeId && issues.length === 0 ? projectSourceRecord({
        schemaVersion: this.version,
        fields,
        money: { amount: [amount, fields.currency] },
        timestamps: { occurredAt: [occurredAt, undefined] },
        // Cancellation is a source lifecycle state, not deletion. True
        // tombstones are produced only by verified deletion/reconciliation
        // evidence, otherwise cancelled classes disappear from analytics.
        tombstone: false,
      }) : undefined,
      ...(issues.length > 0 ? { validationIssues: issues } : {}),
    };
  }

  private effectiveTimeRange(
    stream: MomencePageStream | MomenceFanoutStream,
    mode: "initial" | "incremental" | "reconciliation",
    state: Readonly<{ rangeFrom?: string; rangeTo?: string }> | undefined,
    requested?: SyncRange,
  ): SyncRange | undefined {
    if (!stream.timeFilter) return undefined;
    if (state?.rangeFrom && state.rangeTo) {
      if (requested && (requested.from !== state.rangeFrom || requested.to !== state.rangeTo)) {
        throw new ConnectorError("CURSOR_INVALID", `The Momence ${stream.id} scan range changed between pages.`);
      }
      return { from: state.rangeFrom, to: state.rangeTo };
    }
    if (requested) return requested;
    if (mode !== "incremental") return undefined;
    // Momence publishes no updated-since filter. Freeze this overlap window in
    // the first continuation so a long scan cannot move its own page boundary.
    const observedAt = this.clock();
    return {
      from: new Date(observedAt - 180 * 24 * 60 * 60_000).toISOString(),
      to: new Date(observedAt + 730 * 24 * 60 * 60_000).toISOString(),
    };
  }

  private timeQuery(
    stream: MomencePageStream | MomenceFanoutStream,
    range?: SyncRange,
  ): Readonly<Record<string, string>> {
    if (!stream.timeFilter || !range) return {};
    return {
      [stream.timeFilter.startParameter]: range.from,
      [stream.timeFilter.endParameter]: range.to,
    };
  }

  private paginationBlocked(
    code: NonNullable<SyncPage["paginationBlock"]>["code"],
    detail: string,
    records: readonly RawSourceRecord[] = [],
  ): SyncPage {
    return { records, hasMore: true, nextCursor: null, paginationBlock: { code, detail } };
  }

  private cursor(
    stream: MomenceReadStream,
    mode: "initial" | "incremental" | "reconciliation",
    next: MomenceContinuation | undefined,
    range?: SyncRange,
  ): SyncCursor {
    return encodeCursor({
      v: 1,
      connector: this.id,
      stream: stream.id,
      mode,
      watermark: next ? undefined : new Date(this.clock()).toISOString(),
      ...(next ? { continuation: encodeContinuation(next) } : {}),
      ...(range ? { rangeFrom: range.from, rangeTo: range.to } : {}),
    });
  }

  private coverage(
    stream: MomenceReadStream,
    range?: SyncRange,
  ): NonNullable<SyncPage["coverage"]> {
    if ("timeFilter" in stream && stream.timeFilter && range) {
      return {
        boundaryKind: "window_exhausted",
        lowerBound: range.from,
        verification: stream.kind === "page" ? "vendor_reported" : "exhaustive_vendor_scan",
        detail: stream.kind === "page"
          ? "Momence page traversal completed using pagination.totalCount."
          : "Momence parent and child traversal exhausted the fixed operational window.",
      };
    }
    return {
      boundaryKind: "snapshot_at",
      lowerBound: new Date(this.clock()).toISOString(),
      verification: stream.kind === "singleton" ? "point_in_time" : "vendor_reported",
      detail: "Momence exposes no general updated-since cursor; authoritative snapshots reconcile late edits.",
    };
  }

  private clearTraversalPages(context: ConnectorContext, streamId: MomenceStreamId): void {
    const prefix = `${context.tenantId}\u0000${context.connectionId}\u0000${streamId}\u0000`;
    for (const key of this.traversalPages.keys()) {
      if (key.startsWith(prefix)) this.traversalPages.delete(key);
    }
  }

  private clearPaymentDetails(context: ConnectorContext, streamId: MomenceStreamId): void {
    const prefix = `${context.tenantId}\u0000${context.connectionId}\u0000${streamId}\u0000`;
    for (const key of this.paymentDetails.keys()) {
      if (key.startsWith(prefix)) this.paymentDetails.delete(key);
    }
  }

  /**
   * Cache transaction detail responses, not emission decisions. A duplicate
   * note reference therefore avoids another vendor request but still emits the
   * cached source identity. Cache loss or eviction only costs another GET; it
   * cannot create a false skip. A cached 404 is the sole safe suppression.
   */
  private async paymentDetail(
    context: ConnectorContext,
    credential: VersionedCredential,
    streamId: MomenceStreamId,
    transactionId: string,
  ): Promise<Readonly<{ found: true; value: unknown }> | Readonly<{ found: false }>> {
    const key = [
      context.tenantId,
      context.connectionId,
      streamId,
      credential.credentialRef,
      credential.revision,
      transactionId,
    ].join("\u0000");
    const cached = this.paymentDetails.get(key);
    if (cached && cached.expiresAt > this.clock()) {
      this.paymentDetails.delete(key);
      this.paymentDetails.set(key, cached);
      return cached.found ? { found: true, value: cached.value } : { found: false };
    }
    if (cached) this.paymentDetails.delete(key);

    const detailUrl = new URL(
      `/api/v2/host/payment-transactions/${encodeURIComponent(transactionId)}`,
      API_ORIGIN,
    );
    let entry: CachedMomencePaymentDetail;
    try {
      const value = await this.apiJson(context, credential, detailUrl);
      const detailId = paymentIdentity(momenceValueAtPath(value, "id"));
      if (detailId !== transactionId) {
        throw new ConnectorError(
          "REMOTE_RESPONSE_INVALID",
          `Momence returned payment detail with an identity different from ${transactionId}.`,
        );
      }
      entry = {
        expiresAt: this.clock() + PAYMENT_DETAIL_CACHE_TTL_MS,
        found: true,
        value,
      };
    } catch (error) {
      if (!(error instanceof ConnectorHttpError) || error.status !== 404) throw error;
      entry = {
        expiresAt: this.clock() + PAYMENT_DETAIL_CACHE_TTL_MS,
        found: false,
      };
    }
    this.paymentDetails.set(key, entry);
    while (this.paymentDetails.size > MAX_CACHED_PAYMENT_DETAILS) {
      const oldest = this.paymentDetails.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.paymentDetails.delete(oldest);
    }
    return entry.found ? { found: true, value: entry.value } : { found: false };
  }

  /**
   * A fan-out cursor emits one child page at a time. Cache the immutable parent
   * and discovery pages for that in-flight traversal so 200 children do not
   * cost 200 identical parent requests. A cursorless call clears the stream
   * prefix, so a new sync never inherits a prior scan's population.
   */
  private async traversalPage(
    context: ConnectorContext,
    credential: VersionedCredential,
    streamId: MomenceStreamId,
    role: "parent" | "member" | "note",
    url: URL,
    invalidMessage: string,
  ): Promise<z.infer<typeof pageSchema>> {
    const key = [
      context.tenantId,
      context.connectionId,
      streamId,
      credential.credentialRef,
      credential.revision,
      role,
      url.toString(),
    ].join("\u0000");
    const cached = this.traversalPages.get(key);
    if (cached && cached.expiresAt > this.clock()) {
      this.traversalPages.delete(key);
      this.traversalPages.set(key, cached);
      return cached.value;
    }
    if (cached) this.traversalPages.delete(key);

    const parsed = pageSchema.safeParse(await this.apiJson(context, credential, url));
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", invalidMessage, { cause: parsed.error });
    }
    this.traversalPages.set(key, {
      expiresAt: this.clock() + PAGE_CACHE_TTL_MS,
      value: parsed.data,
    });
    while (this.traversalPages.size > MAX_CACHED_TRAVERSAL_PAGES) {
      const oldest = this.traversalPages.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.traversalPages.delete(oldest);
    }
    return parsed.data;
  }

  private async apiJson(
    context: ConnectorContext,
    credential: VersionedCredential,
    path: string | URL,
  ): Promise<unknown> {
    const url = path instanceof URL ? path : new URL(path, API_ORIGIN);
    return this.inConnectionRequestLane(context, async () => {
      const { value } = await requestJson<unknown>(
        this.fetcher,
        url,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${credential.secret.accessToken}`,
            accept: "application/json",
          },
          signal: context.abortSignal,
        },
        withVendorRateBudget(this.config.retry, context.vendorRateBudget),
      );
      return value;
    });
  }

  /**
   * Momence publishes no general concurrency contract. Keep one active vendor
   * request per connection in this process; the durable vendor-rate budget
   * separately coordinates request starts across worker replicas.
   */
  private async inConnectionRequestLane<T>(
    context: ConnectorContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.requestLanes.get(context.connectionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.requestLanes.set(context.connectionId, tail);
    try {
      await previous;
      context.abortSignal?.throwIfAborted();
      return await operation();
    } finally {
      release();
      if (this.requestLanes.get(context.connectionId) === tail) {
        this.requestLanes.delete(context.connectionId);
      }
    }
  }

  private async postToken(
    body: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
    failureMessage: string,
  ): Promise<MomenceToken> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf8").toString("base64");
    const { value } = await requestJson<unknown>(
      this.fetcher,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
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
    const token = parsed.data;
    return {
      accessToken: token.accessToken ?? token.access_token!,
      accessTokenExpiresAt: isoOrThrow(token.accessTokenExpiresAt, "access-token expiry"),
      ...(token.refreshToken ?? token.refresh_token
        ? { refreshToken: token.refreshToken ?? token.refresh_token }
        : {}),
      ...(token.refreshTokenExpiresAt
        ? { refreshTokenExpiresAt: isoOrThrow(token.refreshTokenExpiresAt, "refresh-token expiry") }
        : {}),
      ...(token.scope ? { scope: token.scope } : {}),
    };
  }

  private async readCredential(context: ConnectorContext): Promise<VersionedCredential> {
    const credential = await this.config.vault.read(context.credentialRef);
    if (credential.secret.provider !== this.id) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Momence.");
    }
    return credential;
  }

  private async validCredential(context: ConnectorContext): Promise<VersionedCredential> {
    const credential = await this.readCredential(context);
    return credentialExpiresSoon(credential.secret, this.clock())
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
          throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Momence.");
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
      throw new ConnectorError("AUTHENTICATION_REQUIRED", "Momence refresh token is missing.");
    }
    const token = await this.postToken({
      grant_type: "refresh_token",
      refresh_token: current.secret.refreshToken,
    }, signal, "Momence returned an invalid token refresh.");
    if (!token.refreshToken) {
      throw new ConnectorError("OAUTH_EXCHANGE_FAILED", "Momence rotated no refresh token.");
    }
    const scopes = splitOAuthScopes(token.scope);
    const next: OAuthCredentialSecret = {
      ...current.secret,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.accessTokenExpiresAt,
      scopes: scopes.length > 0 ? scopes : current.secret.scopes,
      metadata: {
        ...current.secret.metadata,
        refreshTokenExpiresAt: token.refreshTokenExpiresAt ?? "",
      },
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
      if (!credentialExpiresSoon(latest.secret, this.clock())) return latest;
      throw new ConnectorError("CREDENTIAL_CONFLICT", "Concurrent Momence token rotation failed.", {
        cause,
        retryable: true,
      });
    }
  }
}

export { momenceManifest } from "./manifest.js";
