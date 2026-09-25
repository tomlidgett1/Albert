import { createHash } from "node:crypto";

import { z } from "zod";

import {
  ConnectorError,
  ConnectorHttpError,
  credentialExpiresSoon,
  fetchWithRetry,
  hashPayload,
  projectSourceRecord,
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
  buildLightspeedXFieldIndex,
  enrichLightspeedXPayload,
  lightspeedXValueAtPath,
  parseLightspeedXJsonLossless,
} from "./field-index.js";
import {
  LIGHTSPEED_X_ALLOWED_SCOPES,
  LIGHTSPEED_X_DEFAULT_SCOPES,
  lightspeedXManifest,
} from "./manifest.js";
import { buildLightspeedXAuthorizationUrl } from "./oauth-public.js";
import {
  advanceLightspeedXPage,
  applyLightspeedXPagination,
  decodeLightspeedXCursor,
  encodeLightspeedXCursor,
  type LightspeedXCursorState,
} from "./pagination.js";
import { LIGHTSPEED_X_CONTRACT_LOCK } from "./spec-lock.js";
import {
  LIGHTSPEED_X_STREAMS,
  LIGHTSPEED_X_STREAM_BY_ID,
  type LightspeedXParentFanout,
  type LightspeedXStream,
} from "./streams.js";

const TOKEN_PATH = "/api/1.0/token";
const DOMAIN_PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const TERMINAL_COVERAGE = Object.freeze({
  boundaryKind: "snapshot_at" as const,
  verification: "exhaustive_vendor_scan" as const,
});

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1).default("Bearer"),
  expires: z.union([z.string(), z.number()]),
  expires_in: z.union([z.string(), z.number()]).optional(),
  refresh_token: z.string().min(1),
  domain_prefix: z.string().min(1),
  scope: z.union([z.string(), z.array(z.string())]),
}).passthrough();

export type LightspeedXConnectorConfig = Readonly<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  vault: WorkerCredentialVault;
  fetcher?: FetchLike;
  retry?: HttpRetryOptions;
  now?: () => number;
  /** Test-only safety bound. Durable workers also cap pages per queue claim. */
  maxParentPages?: number;
  maxParentRecords?: number;
}>;

/**
 * Production, read-only Lightspeed Retail X-Series pack. Its executable
 * traversal is driven entirely by the version-locked stream contracts: adding
 * a documented stream never adds a connector-wide vendor conditional.
 */
export class LightspeedXConnector implements OAuthConnectorPack {
  readonly id = "lightspeed-x" as const;
  readonly version = lightspeedXManifest.packVersion;
  readonly apiVersion = lightspeedXManifest.apiVersion;
  readonly manifest = lightspeedXManifest;

  private readonly config: LightspeedXConnectorConfig;
  private readonly fetcher: FetchLike;
  private readonly clock: () => number;
  private readonly refreshes = new Map<string, Promise<VersionedCredential>>();

  constructor(config: LightspeedXConnectorConfig) {
    this.config = {
      ...config,
      clientId: required(config.clientId, "Lightspeed X-Series client ID"),
      clientSecret: required(config.clientSecret, "Lightspeed X-Series client secret"),
      redirectUri: required(config.redirectUri, "Lightspeed X-Series redirect URI"),
    };
    this.fetcher = config.fetcher ?? fetch;
    this.clock = config.now ?? (() => Date.now());
  }

  rate_limit_options(
    accountMetadata: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, number | undefined>> {
    const registerCount = accountMetadata.registerCount;
    // The official allowance is 300 requests per register plus 50 per
    // five-minute retailer/application window. Account discovery admits no
    // more than 100 registers; invalid or legacy metadata deliberately falls
    // back to the manifest's conservative one-register allowance.
    if (
      typeof registerCount !== "number" ||
      !Number.isSafeInteger(registerCount) ||
      registerCount < 1 ||
      registerCount > 100
    ) return Object.freeze({});
    return Object.freeze({ retailerWindowLimit: 300 * registerCount + 50 });
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Lightspeed X-Series redirect URI does not match the configured OAuth client.");
    }
    const scopes = request.scopes.length > 0 ? request.scopes : LIGHTSPEED_X_DEFAULT_SCOPES;
    const unsupported = scopes.filter((scope) =>
      !LIGHTSPEED_X_ALLOWED_SCOPES.includes(scope as (typeof LIGHTSPEED_X_ALLOWED_SCOPES)[number]));
    if (unsupported.length > 0) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Unsupported Lightspeed X-Series scope requested: ${unsupported.join(", ")}.`);
    }
    return {
      url: buildLightspeedXAuthorizationUrl({
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
      throw new ConnectorError("CONFIGURATION_INVALID", "Lightspeed X-Series redirect URI does not match the configured OAuth client.");
    }
    const domainPrefix = validateDomainPrefix(request.domainPrefix);
    const parsed = await this.postToken(domainPrefix, {
      code: required(request.code, "Lightspeed X-Series authorization code"),
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: request.redirectUri,
    }, request.abortSignal, "Lightspeed X-Series returned an invalid OAuth token response.");
    if (validateDomainPrefix(parsed.domain_prefix) !== domainPrefix) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Lightspeed X-Series changed retailer host identity during OAuth exchange.");
    }
    const scopes = validatedGrantedScopes(parsed.scope);
    const callbackScopes = splitOAuthScopes(request.returnedScope);
    if (callbackScopes.length > 0 && callbackScopes.some((scope) => !scopes.includes(scope))) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Lightspeed X-Series token scopes do not contain the scopes reported by the signed callback.");
    }
    const stored = await this.config.vault.create({
      provider: this.id,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      tokenType: "Bearer",
      expiresAt: tokenExpiry(parsed.expires),
      scopes,
      metadata: { domainPrefix },
    });
    return { credentialRef: stored.credentialRef, expiresAt: stored.secret.expiresAt, scopes: stored.secret.scopes };
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
    const stream = lightspeedXStream("lx_retailer");
    const value = await this.readPage(context, credential, stream, undefined, {}, null);
    const retailer = recordsAt(value, stream.responsePaths)[0];
    if (!isObject(retailer)) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Lightspeed X-Series returned no retailer identity.");
    }
    const retailerId = identifier(retailer.id);
    if (!retailerId) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Lightspeed X-Series retailer identity is missing its stable ID.");
    }
    const domainPrefix = credentialDomainPrefix(credential);
    const returnedDomain = identifier(retailer.domain_prefix);
    if (returnedDomain && returnedDomain !== domainPrefix) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Lightspeed X-Series retailer payload does not match the OAuth host binding.");
    }
    const registerCount = await this.discoverRegisterCount(context, credential);
    return {
      externalAccountId: retailerId,
      displayName: identifier(retailer.name) ?? `Lightspeed X-Series retailer ${retailerId}`,
      baseUrl: apiBaseUrl(domainPrefix),
      metadata: {
        retailerId,
        domainPrefix,
        registerCount,
        currency: identifier(lightspeedXValueAtPath(retailer, "currency.code")),
        timezone: identifier(retailer.timezone),
        country: identifier(retailer.country),
      },
    };
  }

  async select_account(context: ConnectorContext, externalAccountId: string): Promise<ConnectionDiscovery> {
    const account = await this.discover_account(context);
    if (account.externalAccountId !== externalAccountId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "A Lightspeed X-Series OAuth grant belongs to exactly one retailer.");
    }
    return account;
  }

  async list_streams(context: ConnectorContext): Promise<readonly ConnectorStream[]> {
    const credential = await this.readCredential(context);
    const scopes = new Set(credential.secret.scopes);
    return LIGHTSPEED_X_STREAMS
      .filter((stream) => stream.requiredScopes.every((scope) => scopes.has(scope)))
      .map((stream, priority) => ({
        id: stream.id,
        label: stream.label,
        domains: stream.productDomains,
        cursorKind: stream.modifiedField ? "high_water_mark" as const
          : stream.pagination === "offset" ? "offset" as const
          : stream.pagination === "page" ? "page" as const : "none" as const,
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

  async initial_sync(context: ConnectorContext, stream: ConnectorStream, range: SyncRange, cursor?: SyncCursor): Promise<SyncPage> {
    return this.sync(context, stream, "initial", cursor, range);
  }

  async incremental_sync(context: ConnectorContext, stream: ConnectorStream, cursor: SyncCursor): Promise<SyncPage> {
    return this.sync(context, stream, "incremental", cursor);
  }

  async reconciliation_sync(context: ConnectorContext, stream: ConnectorStream, request: ReconciliationRequest): Promise<SyncPage> {
    return this.sync(context, stream, "reconciliation", request.cursor, request.range);
  }

  async handle_webhook(context: ConnectorContext, event: WebhookEnvelope): Promise<WebhookDisposition> {
    void context;
    void event;
    return { accepted: false, streams: [], reason: "lightspeed_x_polling_is_authoritative" };
  }

  async refresh_credentials(context: ConnectorContext): Promise<{ credentialRef: string }> {
    const current = await this.readCredential(context);
    return { credentialRef: (await this.refreshCredential(current, context.abortSignal)).credentialRef };
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    // X-Series documents token issuance and rotation, but not a remote OAuth
    // revocation endpoint. Encrypted local destruction is therefore authoritative.
    await this.config.vault.destroy(context.credentialRef);
  }

  async describe_capabilities(context: ConnectorContext): Promise<readonly ConnectorCapability[]> {
    const credential = await this.readCredential(context);
    const granted = new Set(credential.secret.scopes);
    return Object.entries(this.manifest.capabilities).map(([id, contract]) => {
      const requiredScopes = [...new Set((contract?.streams ?? []).flatMap((streamId) =>
        lightspeedXStream(streamId).requiredScopes))];
      const available = requiredScopes.every((scope) => granted.has(scope));
      return {
        id: id as ConnectorCapability["id"],
        support: available ? contract?.support ?? "unknown" : "unavailable",
        reasonCode: available ? "lightspeed_x_read_scope_granted" : "required_scope_missing",
        requiredScopes,
        ...(!available || !contract?.reason ? {} : { notes: contract.reason }),
      };
    });
  }

  private async sync(
    context: ConnectorContext,
    requested: ConnectorStream,
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
  ): Promise<SyncPage> {
    const stream = lightspeedXStream(requested.id);
    const credential = await this.validCredential(context);
    const missingScopes = stream.requiredScopes.filter((scope) => !credential.secret.scopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new ConnectorError("CAPABILITY_UNAVAILABLE", `Lightspeed X-Series ${stream.label} requires ${missingScopes.join(", ")}.`);
    }
    const state = decodeLightspeedXCursor(cursor?.value);
    const partitions = stream.partitions.length > 0 ? stream.partitions : [{}];
    const partitionIndex = state.partitionIndex ?? 0;
    if (partitionIndex >= partitions.length) {
      throw new ConnectorError("CURSOR_INVALID", `Lightspeed X-Series ${stream.id} partition cursor is out of range.`);
    }
    return stream.parent
      ? this.syncParentStream(context, credential, stream, stream.parent, state, partitionIndex, partitions, mode, range)
      : this.syncDirectStream(context, credential, stream, state, partitionIndex, partitions, mode, range);
  }

  private async syncDirectStream(
    context: ConnectorContext,
    credential: VersionedCredential,
    stream: LightspeedXStream,
    state: LightspeedXCursorState,
    partitionIndex: number,
    partitions: readonly Readonly<Record<string, unknown>>[],
    mode: "initial" | "incremental" | "reconciliation",
    range?: SyncRange,
  ): Promise<SyncPage> {
    const value = await this.readPage(
      context, credential, stream, state.position,
      partitions[partitionIndex] ?? {}, null, range,
    );
    const sources = recordsAt(value, stream.responsePaths);
    const records = sources.map((source, index) => this.sourceRecord(stream, source, null, index));
    const advance = advanceLightspeedXPage(stream.paginator, state.position, value, sources);
    return finishPage({ stream, records, advance, state, partitionIndex, partitionCount: partitions.length, mode, range, now: this.clock() });
  }

  private async syncParentStream(
    context: ConnectorContext,
    credential: VersionedCredential,
    stream: LightspeedXStream,
    parent: LightspeedXParentFanout,
    state: LightspeedXCursorState,
    partitionIndex: number,
    partitions: readonly Readonly<Record<string, unknown>>[],
    mode: "initial" | "incremental" | "reconciliation",
    range?: SyncRange,
  ): Promise<SyncPage> {
    const parentStream = lightspeedXStream(parent.stream);
    const parentContract: LightspeedXStream = {
      ...parentStream,
      endpoint: parent.endpoint,
      responsePaths: [parent.responsePath],
      recordIdPaths: [parent.idPath],
      paginator: parent.pagination,
    };
    const parentValue = await this.readPage(
      context, credential, parentContract, state.parentAfter, {}, null,
    );
    const parents = recordsAt(parentValue, [parent.responsePath]);
    const parentIndex = state.parentIndex ?? 0;
    if (parents.length === 0) {
      return terminalPage(mode, range, this.clock());
    }
    if (parentIndex >= parents.length) {
      throw new ConnectorError("CURSOR_INVALID", `Lightspeed X-Series ${stream.id} parent index is out of range.`);
    }
    const parentIds = parents.map((record) => identifier(lightspeedXValueAtPath(record, parent.idPath)));
    if (parentIds.some((id) => !id)) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", `${parent.stream} returned a parent without ${parent.idPath}.`);
    }
    const parentPageHash = hashPayload(parentIds);
    const selectedId = parentIds[parentIndex]!;
    if (
      (state.parentId && state.parentId !== selectedId) ||
      (state.parentPageHash && state.parentPageHash !== parentPageHash)
    ) {
      return {
        records: [],
        hasMore: true,
        nextCursor: null,
        paginationBlock: {
          code: "pagination_identity_invalid",
          detail: `Lightspeed X-Series ${parent.stream} parent page changed during child traversal.`,
        },
      };
    }
    const selectedContext = Object.freeze({ [parent.contextField]: selectedId });
    const value = await this.readPage(
      context, credential, stream, state.childPosition,
      partitions[partitionIndex] ?? {}, selectedContext, range,
    );
    const sources = recordsAt(value, stream.responsePaths);
    const records = sources.map((source, index) => this.sourceRecord(stream, source, selectedContext, index));
    const advance = advanceLightspeedXPage(stream.paginator, state.childPosition, value, sources);
    if (advance.block) {
      return { records, hasMore: true, nextCursor: null, paginationBlock: advance.block };
    }
    if (advance.hasMore && advance.nextPosition) {
      return {
        records,
        hasMore: true,
        nextCursor: cursorFor({
          ...state,
          partitionIndex,
          parentIndex,
          parentId: selectedId,
          parentPageHash,
          childPosition: advance.nextPosition,
        }, records),
      };
    }
    const nextPartition = partitionIndex + 1;
    if (nextPartition < partitions.length) {
      return {
        records,
        hasMore: true,
        nextCursor: cursorFor({
          ...(state.parentAfter ? { parentAfter: state.parentAfter } : {}),
          parentIndex,
          parentId: selectedId,
          parentPageHash,
          partitionIndex: nextPartition,
        }, records),
      };
    }
    if (parentIndex + 1 < parents.length) {
      return {
        records,
        hasMore: true,
        nextCursor: cursorFor({
          ...(state.parentAfter ? { parentAfter: state.parentAfter } : {}),
          parentIndex: parentIndex + 1,
          parentId: parentIds[parentIndex + 1]!,
          parentPageHash,
          partitionIndex: 0,
        }, records),
      };
    }
    const parentAdvance = advanceLightspeedXPage(
      parent.pagination, state.parentAfter, parentValue, parents,
    );
    if (parentAdvance.block) {
      return { records, hasMore: true, nextCursor: null, paginationBlock: parentAdvance.block };
    }
    if (parentAdvance.hasMore && parentAdvance.nextPosition) {
      return {
        records,
        hasMore: true,
        nextCursor: cursorFor({ parentAfter: parentAdvance.nextPosition, parentIndex: 0, partitionIndex: 0 }, records),
      };
    }
    return { ...terminalPage(mode, range, this.clock()), records };
  }

  private async discoverRegisterCount(context: ConnectorContext, credential: VersionedCredential): Promise<number> {
    const stream = lightspeedXStream("lx_registers");
    let position: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < (this.config.maxParentPages ?? 10_000); page += 1) {
      const value = await this.readPage(context, credential, stream, position, {}, null);
      const rows = recordsAt(value, stream.responsePaths);
      for (const row of rows) {
        const id = identifier(lightspeedXValueAtPath(row, "id"));
        if (id) seen.add(id);
      }
      const advance = advanceLightspeedXPage(stream.paginator, position, value, rows);
      if (advance.block) throw new ConnectorError("REMOTE_RESPONSE_INVALID", advance.block.detail);
      if (!advance.hasMore || !advance.nextPosition) return Math.max(1, seen.size);
      position = advance.nextPosition;
    }
    throw new ConnectorError("CAPABILITY_UNAVAILABLE", "Lightspeed X-Series register discovery exceeded its safety bound.");
  }

  private async readPage(
    context: ConnectorContext,
    credential: VersionedCredential,
    stream: LightspeedXStream,
    position: string | undefined,
    partition: Readonly<Record<string, unknown>>,
    parent: Readonly<Record<string, string>> | null,
    range?: SyncRange,
  ): Promise<unknown> {
    const path = interpolatePath(stream.endpoint, parent);
    const url = new URL(`${apiBaseUrl(credentialDomainPrefix(credential))}${path}`);
    const body: Record<string, unknown> = { ...stream.fixedBody };
    addQuery(url.searchParams, stream.fixedQuery);
    if (stream.id === "lx_audit_log_events" && range) {
      url.searchParams.set("from", range.from);
      url.searchParams.set("to", range.to);
    }
    if (stream.id === "lx_service_agenda" && range) {
      url.searchParams.set("start_date", range.from);
      const days = Math.max(1, Math.min(366, Math.ceil((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000)));
      url.searchParams.set("days", String(days));
    }
    // Resource partitions are endpoint inputs, not paginator inputs. X-Series
    // GET resources (for example custom-field definitions by entity) expect
    // them in the query even when the stream itself is not paginated; the two
    // read-only bulk POST resources expect them in their JSON body.
    if (stream.method === "GET") addQuery(url.searchParams, partition);
    else Object.assign(body, partition);
    applyLightspeedXPagination(stream.paginator, position, url.searchParams, body);
    const response = await fetchWithRetry(
      this.fetcher,
      url,
      {
        method: stream.method,
        headers: {
          authorization: `Bearer ${credential.secret.accessToken}`,
          accept: "application/json",
          ...(stream.method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(stream.method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: context.abortSignal,
      },
      withVendorRateBudget(this.config.retry, context.vendorRateBudget),
    );
    try {
      return parseLightspeedXJsonLossless(await response.text());
    } catch (cause) {
      if (cause instanceof ConnectorError) throw cause;
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Lightspeed X-Series returned malformed JSON for ${stream.id}.`, { cause });
    }
  }

  private sourceRecord(
    stream: LightspeedXStream,
    source: unknown,
    parent: Readonly<Record<string, string>> | null,
    index: number,
  ): RawSourceRecord {
    const enriched = enrichLightspeedXPayload(source, parent);
    const sourceRecordId = recordIdentity(stream, enriched, index);
    const updated = firstTimestamp(stream.sourceUpdatedAtPaths, enriched);
    const tombstone = stream.tombstonePaths.some((path) => tombstoneValue(lightspeedXValueAtPath(enriched, path)));
    return {
      sourceObjectType: stream.resource,
      sourceRecordId,
      ...(updated ? { sourceUpdatedAt: updated } : {}),
      // Raw storage retains the exact vendor entity. Synthetic parent lineage
      // belongs only to the governed staging projection.
      payload: source,
      payloadHash: hashPayload(source),
      normalized: projectSourceRecord({
        schemaVersion: this.version,
        fields: { payload_json: enriched, field_index: buildLightspeedXFieldIndex(enriched) },
        tombstone,
      }),
    };
  }

  private async postToken(
    domainPrefix: string,
    body: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
    failureMessage: string,
  ): Promise<z.infer<typeof tokenSchema>> {
    const response = await fetchWithRetry(
      this.fetcher,
      `${tokenOrigin(domainPrefix)}${TOKEN_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(body).toString(),
        signal,
      },
      this.config.retry,
    );
    let value: unknown;
    try { value = parseLightspeedXJsonLossless(await response.text()); }
    catch (cause) { throw new ConnectorError("OAUTH_EXCHANGE_FAILED", failureMessage, { cause }); }
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) throw new ConnectorError("OAUTH_EXCHANGE_FAILED", failureMessage, { cause: parsed.error });
    return parsed.data;
  }

  private async readCredential(context: ConnectorContext): Promise<VersionedCredential> {
    const credential = await this.config.vault.read(context.credentialRef);
    if (credential.secret.provider !== this.id) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Lightspeed X-Series.");
    }
    credentialDomainPrefix(credential);
    return credential;
  }

  private async validCredential(context: ConnectorContext): Promise<VersionedCredential> {
    const credential = await this.readCredential(context);
    return credentialExpiresSoon(credential.secret, this.clock())
      ? this.refreshCredential(credential, context.abortSignal)
      : credential;
  }

  private async refreshCredential(current: VersionedCredential, signal?: AbortSignal): Promise<VersionedCredential> {
    const existing = this.refreshes.get(current.credentialRef);
    if (existing) return existing;
    const promise = this.config.vault.withRefreshLease(
      current.credentialRef,
      async (lease) => {
        const latest = await this.config.vault.read(current.credentialRef);
        if (latest.secret.provider !== this.id) {
          throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Lightspeed X-Series.");
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
    signal: AbortSignal | undefined,
    proof: CredentialRefreshLeaseProof,
  ): Promise<VersionedCredential> {
    if (!current.secret.refreshToken) {
      throw new ConnectorError("AUTHENTICATION_REQUIRED", "Lightspeed X-Series rotating refresh token is missing.");
    }
    const domainPrefix = credentialDomainPrefix(current);
    const parsed = await this.postToken(domainPrefix, {
      refresh_token: current.secret.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
    }, signal, "Lightspeed X-Series returned an invalid token refresh.");
    if (validateDomainPrefix(parsed.domain_prefix) !== domainPrefix) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Lightspeed X-Series changed retailer host identity during token rotation.");
    }
    const next: OAuthCredentialSecret = {
      ...current.secret,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt: tokenExpiry(parsed.expires),
      scopes: validatedGrantedScopes(parsed.scope),
      metadata: { ...current.secret.metadata, domainPrefix },
    };
    try {
      signal?.throwIfAborted();
      return await this.config.vault.compareAndSwap(current.credentialRef, current.revision, next, proof);
    } catch (cause) {
      const latest = await this.config.vault.read(current.credentialRef);
      if (!credentialExpiresSoon(latest.secret, this.clock())) return latest;
      throw new ConnectorError("CREDENTIAL_CONFLICT", "Concurrent Lightspeed X-Series rotating-token publication failed.", {
        cause, retryable: true,
      });
    }
  }
}

function lightspeedXStream(id: string): LightspeedXStream {
  const stream = LIGHTSPEED_X_STREAM_BY_ID.get(id);
  if (!stream) throw new ConnectorError("CAPABILITY_UNAVAILABLE", `Unknown Lightspeed X-Series stream ${id}.`);
  return stream;
}

function finishPage(input: Readonly<{
  stream: LightspeedXStream;
  records: readonly RawSourceRecord[];
  advance: ReturnType<typeof advanceLightspeedXPage>;
  state: LightspeedXCursorState;
  partitionIndex: number;
  partitionCount: number;
  mode: "initial" | "incremental" | "reconciliation";
  range?: SyncRange;
  now: number;
}>): SyncPage {
  if (input.advance.block) {
    return { records: input.records, hasMore: true, nextCursor: null, paginationBlock: input.advance.block };
  }
  if (input.advance.hasMore && input.advance.nextPosition) {
    return {
      records: input.records,
      hasMore: true,
      nextCursor: cursorFor({ ...input.state, partitionIndex: input.partitionIndex, position: input.advance.nextPosition }, input.records),
    };
  }
  if (input.partitionIndex + 1 < input.partitionCount) {
    return {
      records: input.records,
      hasMore: true,
      nextCursor: cursorFor({ partitionIndex: input.partitionIndex + 1 }, input.records),
    };
  }
  return { ...terminalPage(input.mode, input.range, input.now), records: input.records };
}

function terminalPage(
  mode: "initial" | "incremental" | "reconciliation",
  range: SyncRange | undefined,
  now: number,
): SyncPage {
  const lowerBound = range?.from ?? new Date(now).toISOString();
  return {
    records: [],
    hasMore: false,
    nextCursor: null,
    ...(mode === "initial" ? { coverage: { ...TERMINAL_COVERAGE, lowerBound } } : {}),
  };
}

function cursorFor(state: LightspeedXCursorState, records: readonly RawSourceRecord[]): SyncCursor {
  const sourceUpdatedAt = latestTimestamp(records.map((record) => record.sourceUpdatedAt));
  return { value: encodeLightspeedXCursor(state), ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}) };
}

function recordsAt(value: unknown, paths: readonly string[]): readonly unknown[] {
  const records: unknown[] = [];
  for (const path of paths) {
    const selected = path === "$" ? value : lightspeedXValueAtPath(value, path);
    if (selected === null || selected === undefined) continue;
    if (Array.isArray(selected)) records.push(...selected);
    else if (isObject(selected)) records.push(selected);
    else throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Lightspeed X-Series response path ${path} is not an object or array.`);
  }
  return records;
}

function recordIdentity(stream: LightspeedXStream, value: unknown, index: number): string {
  const parts = stream.recordIdPaths.map((path) => identifier(lightspeedXValueAtPath(value, path))).filter(Boolean);
  if (parts.length > 0) return [...new Set(parts)].join("|");
  if (stream.recordIdPaths.includes("_singleton")) return "singleton";
  // A small number of official responses document no identifier at all. Their
  // stable content digest is deterministic and never depends on page ordering.
  if (isObject(value)) return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  throw new ConnectorError("REMOTE_RESPONSE_INVALID", `${stream.resource} record ${index} has no stable identity.`);
}

function firstTimestamp(paths: readonly string[], value: unknown): string | null {
  for (const path of paths) {
    const selected = lightspeedXValueAtPath(value, path);
    if (typeof selected !== "string") continue;
    const parsed = Date.parse(selected);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function latestTimestamp(values: readonly (string | undefined)[]): string | null {
  return values.filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

function tombstoneValue(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.length > 0);
}

function interpolatePath(path: string, parent: Readonly<Record<string, string>> | null): string {
  return path.replace(/\{([^}]+)\}/gu, (_match, key: string) => {
    const value = parent?.[key] ?? parent?.[camelToSnake(key)] ?? parent?.[snakeToCamel(key)];
    if (!value) throw new ConnectorError("CONFIGURATION_INVALID", `Lightspeed X-Series endpoint requires parent ${key}.`);
    return encodeURIComponent(value);
  });
}

function addQuery(query: URLSearchParams, values: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => query.append(key, String(item)));
    else if (typeof value === "object") throw new ConnectorError("CONFIGURATION_INVALID", `Lightspeed X-Series query ${key} cannot be nested.`);
    else query.set(key, String(value));
  }
}

function credentialDomainPrefix(credential: VersionedCredential): string {
  return validateDomainPrefix(credential.secret.metadata.domainPrefix);
}

function validateDomainPrefix(value: unknown): string {
  if (typeof value !== "string") {
    throw new ConnectorError("CONFIGURATION_INVALID", "Lightspeed X-Series OAuth callback is missing domain_prefix.");
  }
  const normalized = value.trim().toLowerCase();
  if (!DOMAIN_PREFIX.test(normalized)) {
    throw new ConnectorError("CONFIGURATION_INVALID", "Lightspeed X-Series domain_prefix is invalid.");
  }
  return normalized;
}

function validatedGrantedScopes(value: unknown): readonly string[] {
  const scopes = [...new Set(splitOAuthScopes(value))].sort();
  if (scopes.length === 0) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Lightspeed X-Series returned an empty OAuth scope grant.");
  }
  const unsupported = scopes.filter((scope) =>
    !LIGHTSPEED_X_ALLOWED_SCOPES.includes(scope as (typeof LIGHTSPEED_X_ALLOWED_SCOPES)[number]));
  if (unsupported.length > 0) {
    throw new ConnectorError(
      "REMOTE_RESPONSE_INVALID",
      `Lightspeed X-Series returned scopes outside Albert's read-only grant: ${unsupported.join(", ")}.`,
    );
  }
  return scopes;
}

function tokenOrigin(domainPrefix: string): string {
  return `https://${validateDomainPrefix(domainPrefix)}.retail.lightspeed.app`;
}

function apiBaseUrl(domainPrefix: string): string {
  return `${tokenOrigin(domainPrefix)}/api/${LIGHTSPEED_X_CONTRACT_LOCK.apiVersion}`;
}

function tokenExpiry(value: string | number): string {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Lightspeed X-Series token expiry is invalid.");
  }
  return new Date(seconds * 1_000).toISOString();
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new ConnectorError("CONFIGURATION_INVALID", `${label} is required.`);
  return value.trim();
}

function identifier(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function camelToSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

export { lightspeedXManifest } from "./manifest.js";
