import { z } from "zod";

import {
  ConcurrencyLimiter,
  ConnectorError,
  ConnectorHttpError,
  credentialExpiresSoon,
  decodeCursor,
  encodeCursor,
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
import { DEPUTY_DEFAULT_SCOPES, deputyManifest } from "./manifest";
import { buildDeputyAuthorizationUrl } from "./oauth-public";
import { deputySchemas, type DeputyStreamId } from "./schemas";
import {
  parseDeputyWebhook,
  type DeputyWebhookVerificationMaterial,
} from "./webhooks";

const TOKEN_ENDPOINT = "https://once.deputy.com/my/oauth/access_token";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number().positive(),
  scope: z.string().optional(),
  endpoint: z.string().min(1),
});

export type DeputyConnectorConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  vault: WorkerCredentialVault;
  fetcher?: FetchLike;
  retry?: HttpRetryOptions;
  now?: () => number;
  /** Per-connection verifier used only by a bound webhook-ingress instance. */
  webhookVerification?: Readonly<{
    material: DeputyWebhookVerificationMaterial;
    callbackUrl: string;
    maxClockSkewMs?: number;
  }>;
}>;

const streamPriority: Readonly<Record<DeputyStreamId, number>> = {
  companies: 10,
  operational_units: 11,
  employees: 20,
  rosters: 40,
  timesheets: 41,
  leave: 42,
  contacts: 60,
};

function required(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new ConnectorError("CONFIGURATION_INVALID", `${name} is required.`);
  }
  return value;
}

function normalizeEndpoint(value: string): string {
  let hostname: string;
  try {
    const candidate = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    if (candidate.protocol !== "https:") throw new Error("Deputy endpoint must use HTTPS.");
    hostname = candidate.hostname.toLowerCase();
  } catch (cause) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Deputy returned an invalid install endpoint.", {
      cause,
    });
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:au|eu|uk|us)\.deputy\.com$/u.test(hostname)) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Deputy install endpoint is outside an allowed region host.");
  }
  return hostname;
}

function canonicalDeputyPaginationId(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,39})$/u.test(value)) {
    return undefined;
  }
  try {
    return BigInt(value).toString(10);
  } catch {
    return undefined;
  }
}

function deputyPaginationIdFromRaw(raw: unknown): string | undefined {
  return raw && typeof raw === "object"
    ? canonicalDeputyPaginationId((raw as Record<string, unknown>).Id)
    : undefined;
}

function maximumDeputyPaginationId(values: readonly string[]): string | undefined {
  return values.reduce<string | undefined>((maximum, value) =>
    maximum === undefined || BigInt(value) > BigInt(maximum) ? value : maximum, undefined);
}

function deputyPaginationQueryValue(value: string): string | number {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : value;
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

function activeIsFalse(value: unknown): boolean {
  return value === false || value === 0 || value === "0" || value === "false";
}

export class DeputyConnector implements OAuthConnectorPack {
  readonly id = "deputy" as const;
  readonly version = deputyManifest.packVersion;
  readonly apiVersion = deputyManifest.apiVersion;
  readonly manifest = deputyManifest;

  private readonly config: DeputyConnectorConfig;
  private readonly fetcher: FetchLike;
  private readonly concurrency = new ConcurrencyLimiter(4);
  private readonly refreshes = new Map<string, Promise<VersionedCredential>>();
  private readonly successfulStreams = new Set<string>();
  private readonly observedTimesheetCost = new Set<string>();

  constructor(config: DeputyConnectorConfig) {
    this.config = {
      ...config,
      clientId: required(config.clientId, "Deputy client ID"),
      clientSecret: required(config.clientSecret, "Deputy client secret"),
      redirectUri: required(config.redirectUri, "Deputy redirect URI"),
    };
    this.fetcher = config.fetcher ?? fetch;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    const scopes = request.scopes.length > 0 ? request.scopes : DEPUTY_DEFAULT_SCOPES;
    if (scopes.length !== 1 || scopes[0] !== "longlife_refresh_token") {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        "Deputy OAuth supports the documented longlife_refresh_token scope.",
      );
    }
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Deputy redirect URI does not match configured OAuth client.");
    }
    return {
      url: buildDeputyAuthorizationUrl({
        clientId: this.config.clientId,
        state: request.state,
        redirectUri: request.redirectUri,
      }),
      expiresAt: new Date((this.config.now?.() ?? Date.now()) + 10 * 60_000).toISOString(),
    };
  }

  async exchange_authorization_code(
    request: AuthorizationCodeExchange,
  ): Promise<OAuthExchangeResult> {
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Deputy redirect URI does not match configured OAuth client.");
    }
    const { value } = await requestJson<unknown>(
      this.fetcher,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: request.redirectUri,
          grant_type: "authorization_code",
          code: required(request.code, "Deputy authorization code"),
          scope: "longlife_refresh_token",
        }),
        signal: request.abortSignal,
      },
      this.config.retry,
    );
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("OAUTH_EXCHANGE_FAILED", "Deputy returned an invalid OAuth token response.", {
        cause: parsed.error,
      });
    }
    const endpoint = normalizeEndpoint(parsed.data.endpoint);
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
      scopes: scopes.length > 0 ? scopes : DEPUTY_DEFAULT_SCOPES,
      metadata: { endpoint },
    });
    return { credentialRef: stored.credentialRef, expiresAt, scopes: stored.secret.scopes };
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
    const endpoint = normalizeEndpoint(String(credential.secret.metadata.endpoint ?? ""));
    const { value } = await this.apiJson<Record<string, unknown>>(
      context,
      credential,
      new URL(`https://${endpoint}/api/v1/me`),
      { method: "GET" },
    );
    const display = [value.DisplayName, value.Name, value.CompanyName]
      .find((item): item is string => typeof item === "string" && item.trim().length > 0);
    return {
      externalAccountId: endpoint,
      displayName: display ?? endpoint.split(".")[0] ?? endpoint,
      baseUrl: `https://${endpoint}/api/v1/`,
      metadata: {
        region: endpoint.split(".")[1]?.toUpperCase() ?? null,
        userId: typeof value.Id === "number" || typeof value.Id === "string" ? String(value.Id) : null,
      },
    };
  }

  async select_account(
    context: ConnectorContext,
    externalAccountId: string,
  ): Promise<ConnectionDiscovery> {
    const account = await this.discover_account(context);
    if (normalizeEndpoint(externalAccountId) !== account.externalAccountId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "A Deputy OAuth token belongs to exactly one install.");
    }
    return account;
  }

  async list_streams(context: ConnectorContext): Promise<readonly ConnectorStream[]> {
    void context;
    return this.manifest.streams
      .map((stream) => ({
        id: stream.id,
        label: stream.id.replaceAll("_", " "),
        domains: stream.productDomains,
        cursorKind: "high_water_mark" as const,
        backfillStrategy: stream.backfillStrategy,
        lateEditStrategy: stream.lateEditStrategy,
        deletionStrategy: stream.deletionStrategy,
        sourceTotalStrategy: stream.sourceTotalStrategy,
        availability: stream.availability ?? "required",
        dependencies: stream.dependencies,
        productDomains: stream.productDomains,
        priority: streamPriority[stream.id as DeputyStreamId],
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
    const verification = this.config.webhookVerification;
    if (!verification) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        "Deputy webhook handling requires connection-bound verification material.",
      );
    }
    const disposition = parseDeputyWebhook({
      event,
      material: verification.material,
      expectedCallbackUrl: verification.callbackUrl,
      maxClockSkewMs: verification.maxClockSkewMs,
      nowMs: this.config.now?.(),
    });
    const endpoint = String((await this.readCredential(context)).secret.metadata.endpoint ?? "");
    return {
      ...disposition,
      externalAccountIds: endpoint ? [endpoint] : [],
    };
  }

  async refresh_credentials(context: ConnectorContext): Promise<{ credentialRef: string }> {
    const current = await this.readCredential(context);
    return { credentialRef: (await this.refreshCredential(current, context.abortSignal)).credentialRef };
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    // Deputy documents user-managed consent removal but no remote OAuth
    // revocation endpoint. Destroying the encrypted token prevents reuse.
    await this.config.vault.destroy(context.credentialRef);
  }

  async describe_capabilities(
    context: ConnectorContext,
  ): Promise<readonly ConnectorCapability[]> {
    const success = (stream: DeputyStreamId) => this.successfulStreams.has(`${context.connectionId}:${stream}`);
    return [
      {
        id: "workforce.shifts",
        support: success("rosters") ? "full" : "unknown",
        reasonCode: success("rosters") ? "live_stream_observed" : "live_probe_required",
        notes: "Confirmed after the first successful live Resource query.",
      },
      {
        id: "workforce.time_entries",
        support: success("timesheets") ? "full" : "unknown",
        reasonCode: success("timesheets") ? "live_stream_observed" : "live_probe_required",
        notes: "Confirmed after the first successful live Resource query.",
      },
      {
        id: "workforce.time_entries.cost",
        support: this.observedTimesheetCost.has(context.connectionId)
          ? "full"
          : success("timesheets") ? "partial" : "unknown",
        reasonCode: this.observedTimesheetCost.has(context.connectionId)
          ? "cost_fields_observed"
          : success("timesheets") ? "cost_fields_not_observed" : "live_probe_required",
        notes: "Cost availability depends on payroll visibility and data state; answers must disclose coverage.",
      },
      {
        id: "workforce.time_entries.overtime",
        support: "unavailable",
        reasonCode: "overtime_duration_not_projected",
        notes: "The pinned Timesheet projection does not expose governed overtime duration; Albert never treats a synthetic zero as observed overtime.",
      },
      {
        id: "workforce.leave",
        support: success("leave") ? "full" : "unknown",
        reasonCode: success("leave") ? "live_stream_observed" : "live_probe_required",
      },
      {
        id: "source.webhooks",
        support: "partial",
        reasonCode: "optional_operator_installation_required",
        notes: "Albert never creates or updates Deputy Webhook resources. Optional connection-bound ingress requires explicit owner or operator installation; polling and reconciliation provide completeness without it.",
      },
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
    if (!contract || !(contract.id in deputySchemas)) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Unknown Deputy stream: ${stream.id}.`);
    }
    const streamId = contract.id as DeputyStreamId;
    const state = cursor ? decodeCursor(cursor, { connector: this.id, stream: stream.id }) : undefined;
    const syncUpperBound = mode === "incremental"
      ? state?.rangeTo ?? new Date(this.config.now?.() ?? Date.now()).toISOString()
      : undefined;
    const query: Record<string, unknown> = {
      max: 500,
      sort: { Id: "asc" },
      ...(contract.queryJoins?.length ? { join: [...contract.queryJoins] } : {}),
    };
    const search: Record<string, unknown> = {};
    let searchIndex = 0;
    const addSearch = (field: string, data: unknown, type: string) => {
      searchIndex += 1;
      search[`s${searchIndex}`] = { field, data, type };
    };
    if (
      (mode === "incremental" && state?.watermark) ||
      (mode === "reconciliation" && reconciliationPhase === "late_edits" && range)
    ) {
      // Modified, not Date/StartTime/DateStart, is the late-edit authority.
      addSearch("Modified", mode === "incremental" ? state!.watermark : range!.from, "ge");
      addSearch("Modified", mode === "incremental" ? syncUpperBound : range!.to, "lt");
    } else if (mode === "initial" && range) {
      if (streamId === "rosters") {
        addSearch("Date", range.from.slice(0, 10), "ge");
        addSearch("Date", range.to.slice(0, 10), "lt");
      } else if (streamId === "timesheets") {
        addSearch("StartTime", Math.floor(Date.parse(range.from) / 1_000), "ge");
        addSearch("StartTime", Math.floor(Date.parse(range.to) / 1_000), "lt");
      } else if (streamId === "leave") {
        addSearch("DateStart", range.from.slice(0, 10), "ge");
        addSearch("DateStart", range.to.slice(0, 10), "lt");
      }
    }
    const priorPaginationId = state?.continuation === undefined
      ? undefined
      : canonicalDeputyPaginationId(state.continuation);
    if (state?.continuation !== undefined && priorPaginationId === undefined) {
      throw new ConnectorError("CURSOR_INVALID", "The stored Deputy pagination identity is invalid.");
    }
    if (priorPaginationId !== undefined) {
      addSearch(
        "Id",
        deputyPaginationQueryValue(priorPaginationId),
        "gt",
      );
    }
    if (Object.keys(search).length > 0) query.search = search;

    const credential = await this.validCredential(context);
    const endpoint = normalizeEndpoint(String(credential.secret.metadata.endpoint ?? ""));
    const url = new URL(`https://${endpoint}/api/v1/resource/${contract.endpoint}`);
    let value: unknown;
    try {
      ({ value } = await this.apiJson<unknown>(context, credential, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query),
      }));
    } catch (error) {
      if (streamId === "contacts" && error instanceof ConnectorHttpError && error.status === 403) {
        throw new ConnectorError(
          "CAPABILITY_UNAVAILABLE",
          "Deputy Contact Resource access is unavailable on this plan or role.",
          { details: { stream: "contacts", documentedPlans: "Premium, Enterprise" } },
        );
      }
      throw error;
    }
    const array = z.array(z.unknown()).safeParse(value);
    if (!array.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Deputy Resource query did not return an array.", {
        cause: array.error,
      });
    }
    const records = array.data.map((raw) => this.toRawRecord(streamId, raw));
    if (streamId === "timesheets" && records.some((record) => {
      const fields = record.normalized?.fields;
      return fields && fields.Cost !== null && fields.Cost !== undefined;
    })) {
      this.observedTimesheetCost.add(context.connectionId);
    }
    const hasMore = array.data.length === 500;
    const maximumSourceId = maximumDeputyPaginationId(
      array.data.flatMap((raw) => {
        const value = deputyPaginationIdFromRaw(raw);
        return value === undefined ? [] : [value];
      }),
    );
    let paginationBlock: SyncPage["paginationBlock"];
    if (hasMore && maximumSourceId === undefined) {
      paginationBlock = {
        code: "pagination_identity_invalid",
        detail: "Deputy returned a full Resource page without a valid numeric Id.",
      };
    } else if (
      hasMore &&
      maximumSourceId !== undefined &&
      priorPaginationId !== undefined &&
      BigInt(maximumSourceId) <= BigInt(priorPaginationId)
    ) {
      paginationBlock = {
        code: "pagination_not_advancing",
        detail: "Deputy returned a Resource page that did not advance beyond the requested Id.",
      };
    }
    const observedWatermark = latestTimestamp(
      records.map((record) => record.sourceUpdatedAt),
      state?.observedWatermark ?? state?.watermark,
    );
    const oldestObservedAt = oldestRecordTimestamp(records, state?.oldestObservedAt);
    if (!paginationBlock) this.successfulStreams.add(`${context.connectionId}:${streamId}`);
    const continuation = maximumSourceId === undefined
      ? undefined
      : deputyPaginationQueryValue(maximumSourceId);
    return {
      records,
      nextCursor: paginationBlock ? null : encodeCursor({
        v: 1,
        connector: this.id,
        stream: stream.id,
        mode: mode === "reconciliation" ? "reconciliation" : mode,
        watermark: hasMore
          ? state?.watermark
          : mode === "initial"
            ? range?.to ?? observedWatermark
            : syncUpperBound,
        observedWatermark: hasMore ? observedWatermark : undefined,
        oldestObservedAt,
        continuation: hasMore ? continuation : undefined,
        rangeFrom: range?.from ?? state?.rangeFrom,
        rangeTo: mode === "incremental"
          ? hasMore ? syncUpperBound : undefined
          : range?.to ?? state?.rangeTo,
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

  private toRawRecord(stream: DeputyStreamId, raw: unknown): RawSourceRecord {
    const payloadHash = hashPayload(raw);
    const schema = deputySchemas[stream];
    const parsed = schema.safeParse(raw);
    const contract = this.manifest.streams.find((item) => item.id === stream);
    if (!contract) throw new ConnectorError("CONFIGURATION_INVALID", `Unknown Deputy stream ${stream}.`);
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
    const fields = normalizeDeputyFieldAliases(parsed.data as Record<string, unknown>);
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
    for (const field of ["TotalTime", "Cost", "OnCost", "Days", "TotalHours"]) {
      if (field in fields) moneyFields[field] = [fields[field], null];
    }
    const normalizationIssues = Object.entries(moneyFields)
      .filter(([, [value, currency]]) => value != null && normalizeDecimal(value, currency).exact === null)
      .map(([field]) => ({
        code: "normalization_invalid" as const,
        path: field,
        message: "The Deputy amount or duration is not a valid exact decimal.",
      }));
    const issues = [
      ...drift.map((field) => ({
        code: "schema_drift" as const,
        path: field,
        message: "The vendor returned a field without an approved coverage disposition.",
      })),
      ...normalizationIssues,
    ];
    const updated = normalizeTimestamp(fields.Modified);
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
              Modified: [fields.Modified, undefined],
              Created: [fields.Created, undefined],
              StartTime: [fields.StartTime, { unixUnit: "seconds" }],
              EndTime: [fields.EndTime, { unixUnit: "seconds" }],
              Start: [fields.Start, { unixUnit: "seconds" }],
              End: [fields.End, { unixUnit: "seconds" }],
              DateStart: [fields.DateStart, undefined],
              DateEnd: [fields.DateEnd, undefined],
            },
            tombstone: activeIsFalse(fields.Active),
          })
        : undefined,
      validationIssues: issues.length > 0 ? issues : undefined,
    };
  }

  private async apiJson<T>(
    context: ConnectorContext,
    credential: VersionedCredential,
    url: URL,
    init: RequestInit,
  ): Promise<Readonly<{ value: T; response: Response }>> {
    const execute = (accessToken: string) => this.concurrency.run(() => requestJson<T>(
      this.fetcher,
      url,
      {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
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
      throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Deputy.");
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
          throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Deputy.");
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
      throw new ConnectorError("AUTHENTICATION_REQUIRED", "Deputy refresh token is missing.");
    }
    const endpoint = normalizeEndpoint(String(current.secret.metadata.endpoint ?? ""));
    const { value } = await requestJson<unknown>(
      this.fetcher,
      `https://${endpoint}/oauth/access_token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: this.config.redirectUri,
          grant_type: "refresh_token",
          refresh_token: current.secret.refreshToken,
          scope: "longlife_refresh_token",
        }),
        signal,
      },
      this.config.retry,
    );
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("OAUTH_EXCHANGE_FAILED", "Deputy returned an invalid token refresh.", {
        cause: parsed.error,
      });
    }
    const nextEndpoint = normalizeEndpoint(parsed.data.endpoint);
    if (nextEndpoint !== endpoint) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Deputy changed install host during token refresh.");
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
      metadata: { ...current.secret.metadata, endpoint: nextEndpoint },
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
      throw new ConnectorError("CREDENTIAL_CONFLICT", "Concurrent Deputy token rotation failed.", {
        cause,
        retryable: true,
      });
    }
  }
}

function normalizeDeputyFieldAliases(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fields = { ...input };
  if (!("ExternalID" in fields) && "ExternalId" in fields) fields.ExternalID = fields.ExternalId;
  if (!("TimeZone" in fields) && "Timezone" in fields) fields.TimeZone = fields.Timezone;
  delete fields.ExternalId;
  delete fields.Timezone;
  return fields;
}

export { deputyManifest } from "./manifest";
export * from "./schemas";
export * from "./webhooks";
