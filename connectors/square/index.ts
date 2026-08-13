import { z } from "zod";

import {
  ConnectorError,
  ConnectorHttpError,
  credentialExpiresSoon,
  decodeCursor,
  encodeCursor,
  fetchWithRetry,
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
  type VendorRateBudget,
  type WebhookDisposition,
  type WebhookEnvelope,
  type WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index.js";
import {
  SQUARE_ALLOWED_SCOPES,
  SQUARE_API_VERSION,
  SQUARE_DEFAULT_SCOPES,
  squareManifest,
} from "./manifest.js";
import { buildSquareFieldIndex, squareStringAtPath, squareTimestampAtPath, squareValueAtPath } from "./field-index.js";
import { buildSquareAuthorizationUrl, squareConnectOrigin } from "./oauth-public.js";
import {
  buildSquareReadRequest,
  SQUARE_READ_STREAMS,
  squareDeletionContract,
  squareSourceTotalContract,
  squareReadStream,
  type SquareReadStream,
} from "./streams.js";


/**
 * Square returns an absolute `expires_at` rather than a relative lifetime, so
 * the pack never derives expiry from local clock arithmetic on a duration.
 */
const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("bearer"),
  expires_at: z.string().min(1),
  merchant_id: z.string().min(1),
  refresh_token: z.string().min(1),
  refresh_token_expires_at: z.string().min(1).optional(),
  short_lived: z.boolean().optional(),
  scopes: z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough();

const merchantSchema = z.object({
  merchant: z.object({
    id: z.string().min(1),
    business_name: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    language_code: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    main_location_id: z.string().nullable().optional(),
  }).passthrough(),
}).passthrough();

const locationsSchema = z.object({
  locations: z.array(z.object({
    id: z.string().min(1),
    name: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  }).passthrough()).optional(),
}).passthrough();

export type SquareConnectorConfig = Readonly<{
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
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Square returned an unparseable ${label}.`);
  }
  return new Date(parsed).toISOString();
}

/**
 * Read-only Square seller connector. OAuth is deliberately independent from
 * ingestion activation: the control plane can keep a healthy grant in
 * awaiting_manual_start until the user explicitly starts its first backfill.
 */
export class SquareConnector implements OAuthConnectorPack {
  readonly id = "square" as const;
  readonly version = squareManifest.packVersion;
  readonly apiVersion = squareManifest.apiVersion;
  readonly manifest = squareManifest;

  private readonly config: SquareConnectorConfig;
  private readonly connectOrigin: string;
  private readonly fetcher: FetchLike;
  private readonly refreshes = new Map<string, Promise<VersionedCredential>>();

  constructor(config: SquareConnectorConfig) {
    this.config = {
      ...config,
      clientId: required(config.clientId, "Square application ID"),
      clientSecret: required(config.clientSecret, "Square application secret"),
      redirectUri: required(config.redirectUri, "Square redirect URI"),
    };
    this.connectOrigin = squareConnectOrigin(this.config.clientId);
    this.fetcher = config.fetcher ?? fetch;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect> {
    const scopes = request.scopes.length > 0 ? request.scopes : SQUARE_DEFAULT_SCOPES;
    const unsupported = scopes.filter(
      (scope) => !SQUARE_ALLOWED_SCOPES.includes(scope as (typeof SQUARE_ALLOWED_SCOPES)[number]),
    );
    if (unsupported.length > 0) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        `Unsupported Square permission requested: ${unsupported.join(", ")}.`,
      );
    }
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Square redirect URI does not match configured OAuth client.");
    }
    return {
      url: buildSquareAuthorizationUrl({
        clientId: this.config.clientId,
        state: request.state,
        redirectUri: request.redirectUri,
        scopes,
      }),
      expiresAt: new Date((this.config.now?.() ?? Date.now()) + 10 * 60_000).toISOString(),
    };
  }

  async exchange_authorization_code(
    request: AuthorizationCodeExchange,
  ): Promise<OAuthExchangeResult> {
    if (request.redirectUri !== this.config.redirectUri) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Square redirect URI does not match configured OAuth client.");
    }
    const parsed = await this.postToken({
      grant_type: "authorization_code",
      code: required(request.code, "Square authorization code"),
      redirect_uri: request.redirectUri,
    }, request.abortSignal, "Square returned an invalid OAuth token response.");
    const scopes = splitOAuthScopes(parsed.scopes);
    const stored = await this.config.vault.create({
      provider: this.id,
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      tokenType: "Bearer",
      expiresAt: isoOrThrow(parsed.expires_at, "token expiry"),
      scopes: scopes.length > 0 ? scopes : SQUARE_DEFAULT_SCOPES,
      metadata: {
        merchantId: parsed.merchant_id,
        // Recorded so an operator can see when a PKCE-style bounded refresh
        // token was issued; the confidential flow leaves this absent.
        refreshTokenExpiresAt: parsed.refresh_token_expires_at ?? "",
      },
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

  /** A Square access token authorises exactly one merchant. */
  async discover_accounts(context: ConnectorContext): Promise<readonly ConnectionDiscovery[]> {
    return [await this.discover_account(context)];
  }

  async discover_account(context: ConnectorContext): Promise<ConnectionDiscovery> {
    const credential = await this.validCredential(context);
    const merchantId = String(credential.secret.metadata.merchantId ?? "");
    if (!merchantId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Square credential is missing its merchant identity.");
    }
    const { value } = await this.apiJson(
      `/v2/merchants/${encodeURIComponent(merchantId)}`,
      credential,
      context.abortSignal,
      context.vendorRateBudget,
    );
    const parsed = merchantSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Square returned an invalid merchant response.", {
        cause: parsed.error,
      });
    }
    const merchant = parsed.data.merchant;
    if (merchant.id !== merchantId) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Square returned a merchant that does not match the grant.");
    }
    const locations = await this.listLocations(credential, context.abortSignal, context.vendorRateBudget);
    return {
      externalAccountId: merchant.id,
      displayName: merchant.business_name?.trim() || `Square merchant ${merchant.id}`,
      metadata: {
        merchantId: merchant.id,
        country: merchant.country ?? null,
        currency: merchant.currency ?? null,
        languageCode: merchant.language_code ?? null,
        status: merchant.status ?? null,
        mainLocationId: merchant.main_location_id ?? null,
        locationCount: locations.length,
        // Identity evidence only. Locations are not a canonical location until
        // Square declares a stream that extracts them.
        locationIds: locations.map((location) => location.id).join(","),
      },
    };
  }

  async select_account(
    context: ConnectorContext,
    externalAccountId: string,
  ): Promise<ConnectionDiscovery> {
    const account = await this.discover_account(context);
    if (externalAccountId !== account.externalAccountId) {
      throw new ConnectorError("CONFIGURATION_INVALID", "A Square OAuth token belongs to exactly one merchant.");
    }
    return account;
  }

  async list_streams(context: ConnectorContext): Promise<readonly ConnectorStream[]> {
    const credential = await this.readCredential(context);
    const scopes = new Set(credential.secret.scopes);
    return SQUARE_READ_STREAMS
      // Square currently documents no seller OAuth permission for Channels.
      // Never use an empty scope list as accidental permission to call it.
      .filter((stream) => stream.availability.sellerOAuth === "documented")
      .filter((stream) => stream.scope.every((scope) => scopes.has(scope)))
      .map((stream) => {
        const deletionStrategy = squareDeletionContract(stream);
        return ({
        id: stream.id,
        label: stream.label,
        domains: stream.productDomains,
        cursorKind: stream.pagination.kind === "cursor" || stream.modifiedPath
          ? "high_water_mark" as const
          : "none" as const,
        backfillStrategy: stream.backfill.mode === "time_windowed" ? "time_windowed" as const : "snapshot" as const,
        lateEditStrategy: deletionStrategy === "immutable_append_only"
          ? "append_only" as const
          : stream.modifiedPath && stream.backfill.mode === "time_windowed"
            ? "modified_field" as const
            : "full_snapshot" as const,
        deletionStrategy,
        sourceTotalStrategy: squareSourceTotalContract(stream),
        availability: stream.priority >= 4 ? "optional" as const : "required" as const,
        dependencies: stream.dependencies,
        productDomains: stream.productDomains,
        priority: stream.priority,
        });
      });
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
    return this.sync(context, stream, "reconciliation", request.cursor, request.range, request.phase);
  }

  async handle_webhook(
    _context: ConnectorContext,
    _event: WebhookEnvelope,
  ): Promise<WebhookDisposition> {
    // Square signs the exact notification URL plus the raw request body with
    // an application-owned subscription key. That key deliberately belongs
    // in the isolated webhook gateway, not the seller OAuth/sync runtime. No
    // Square gateway route exists yet, so fail closed instead of interpreting
    // an attacker-controlled body. Scheduled polling and reconciliation are
    // the completeness authority and remain fully operational.
    return {
      accepted: false,
      streams: [],
      reason: "square_webhook_verification_not_configured",
    };
  }

  async refresh_credentials(context: ConnectorContext): Promise<{ credentialRef: string }> {
    const current = await this.readCredential(context);
    return { credentialRef: (await this.refreshCredential(current, context.abortSignal)).credentialRef };
  }

  async revoke_credentials(context: ConnectorContext): Promise<void> {
    const credential = await this.readCredential(context);
    try {
      await requestJson<unknown>(
        this.fetcher,
        `${this.connectOrigin}/oauth2/revoke`,
        {
          method: "POST",
          headers: {
            // Square authenticates revocation with the application secret under
            // its own `Client` scheme, not Bearer.
            authorization: `Client ${this.config.clientSecret}`,
            "content-type": "application/json",
            accept: "application/json",
            "square-version": SQUARE_API_VERSION,
          },
          body: JSON.stringify({
            client_id: this.config.clientId,
            access_token: credential.secret.accessToken,
            // Without this Square terminates every token the application holds
            // for the merchant, which would silently disconnect another Albert
            // environment authorised against the same seller.
            revoke_only_access_token: true,
          }),
          signal: context.abortSignal,
        },
        this.config.retry,
      );
    } finally {
      // A vendor revocation failure must never strand an encrypted local token.
      await this.config.vault.destroy(context.credentialRef);
    }
  }

  async describe_capabilities(context: ConnectorContext): Promise<readonly ConnectorCapability[]> {
    const credential = await this.readCredential(context);
    const scopes = new Set(credential.secret.scopes);
    return Object.entries(this.manifest.capabilities).map(([id, contract]) => {
      const streams = contract?.streams.map(squareReadStream) ?? [];
      const requiredScopes = [...new Set(streams.flatMap((stream) => stream.scope))];
      if (contract?.support === "unavailable") {
        return {
          id: id as ConnectorCapability["id"],
          support: "unavailable" as const,
          reasonCode: id === "source.webhooks"
            ? "square_webhook_verification_not_configured"
            : "square_source_field_unavailable",
          requiredScopes,
        };
      }
      const available = requiredScopes.every((scope) => scopes.has(scope)) &&
        streams.every((stream) => stream.availability.sellerOAuth === "documented");
      return {
        id: id as ConnectorCapability["id"],
        support: available ? contract?.support ?? "unknown" : "unavailable",
        reasonCode: available ? "square_read_scope_granted" : "required_scope_missing",
        requiredScopes,
        ...(available && contract?.support === "partial"
          ? { notes: "Square exposes this capability with documented source limitations; answer confidence must remain Partial." }
          : {}),
      };
    });
  }

  private async sync(
    context: ConnectorContext,
    requested: ConnectorStream,
    mode: "initial" | "incremental" | "reconciliation",
    cursor?: SyncCursor,
    range?: SyncRange,
    reconciliationPhase?: ReconciliationRequest["phase"],
  ): Promise<SyncPage> {
    const stream = squareReadStream(requested.id);
    const credential = await this.validCredential(context);
    if (stream.availability.sellerOAuth !== "documented") {
      throw new ConnectorError("CAPABILITY_UNAVAILABLE", `${stream.label} has no documented Square seller OAuth permission.`);
    }
    const granted = new Set(credential.secret.scopes);
    const missingScopes = stream.scope.filter((scope) => !granted.has(scope));
    if (missingScopes.length > 0) {
      throw new ConnectorError("CAPABILITY_UNAVAILABLE", `Square ${stream.label} requires ${missingScopes.join(", ")}.`);
    }
    const decoded = cursor ? decodeCursor(cursor, { connector: this.id, stream: stream.id }) : undefined;
    const now = new Date(this.config.now?.() ?? Date.now()).toISOString();
    const decodedTraversal = decodeTraversal(decoded?.continuation);
    // Square cursors expire after roughly five minutes and therefore cannot be
    // trusted as durable checkpoints after a lease loss. Restart the same
    // bounded traversal and rely on immutable/idempotent landing instead.
    const traversal = decodedTraversal.vendorCursor &&
      Date.parse(decodedTraversal.traversalStartedAt ?? "") + 4 * 60_000 <= Date.parse(now)
      ? { workIndex: 0 } satisfies SquareTraversal
      : decodedTraversal;
    const overlapFrom = decoded?.watermark && mode === "incremental"
      ? subtractSeconds(decoded.watermark, stream.lateEdit.overlapSeconds)
      : undefined;
    const effectiveRange = decoded?.continuation && decoded.rangeFrom && decoded.rangeTo
      ? { from: decoded.rangeFrom, to: decoded.rangeTo }
      : range ?? {
          from: overlapFrom ?? "1970-01-01T00:00:00.000Z",
          to: now,
        };
    const locations = await this.locationIdsFor(
      stream,
      credential,
      context.abortSignal,
      context.vendorRateBudget,
    );
    const work = await this.resolveTraversalWork(
      stream,
      credential,
      context,
      effectiveRange,
      locations,
      traversal,
    );
    if (work.workCount === 0) {
      const nextCursor = encodeCursor({
        v: 1,
        connector: this.id,
        stream: stream.id,
        mode,
        watermark: effectiveRange.to,
      });
      const completeSnapshot = stream.backfill.mode !== "time_windowed";
      const coverage = mode === "initial"
        ? completeSnapshot
          ? { boundaryKind: "snapshot_at" as const, lowerBound: effectiveRange.to, verification: "exhaustive_vendor_scan" as const }
          : { boundaryKind: "verified_empty" as const, lowerBound: effectiveRange.from, verification: "exhaustive_vendor_scan" as const }
        : undefined;
      return { records: [], nextCursor, hasMore: false, ...(coverage ? { coverage } : {}) };
    }
    const built = buildSquareReadRequest(stream, {
      ...(traversal.vendorCursor ? { cursor: traversal.vendorCursor } : {}),
      ...(stream.pagination.defaultPageSize ? { pageSize: stream.pagination.defaultPageSize } : {}),
      ...(stream.backfill.mode === "time_windowed" ? { beginTime: effectiveRange.from, endTime: effectiveRange.to } : {}),
      ...(work.locationIds.length ? { locationIds: work.locationIds } : {}),
      ...(work.pathParameters ? { pathParameters: work.pathParameters } : {}),
    });
    const value = await this.readStreamPage(context, credential, built);
    const sourceRows = recordsAt(value, stream.responsePath);
    const records = sourceRows.map((source, index) => this.sourceRecord(
      stream,
      source,
      credential,
      work.pathParameters,
      index,
    ));
    const vendorCursor = stringAt(value, stream.pagination.responsePath);
    const hasNextLocation = !vendorCursor && work.nextWorkIndex < work.workCount;
    const hasMore = Boolean(vendorCursor) || hasNextLocation;
    const nextWorkIndex = vendorCursor ? work.currentWorkIndex : work.nextWorkIndex;
    const observed = latestIso(records.map((record) => record.sourceUpdatedAt), decoded?.observedWatermark);
    const committedWatermark = hasMore ? decoded?.watermark : effectiveRange.to;
    const nextCursor = encodeCursor({
      v: 1,
      connector: this.id,
      stream: stream.id,
      mode,
      ...(committedWatermark ? { watermark: committedWatermark } : {}),
      ...(hasMore && observed ? { observedWatermark: observed } : {}),
      ...(hasMore ? {
        continuation: JSON.stringify({
          workIndex: nextWorkIndex,
          ...(vendorCursor ? { vendorCursor } : {}),
          traversalStartedAt: vendorCursor ? traversal.traversalStartedAt ?? now : now,
        } satisfies SquareTraversal),
        rangeFrom: effectiveRange.from,
        rangeTo: effectiveRange.to,
      } : {}),
    });
    const completeSnapshot = stream.backfill.mode !== "time_windowed";
    const coverage = mode === "initial" && !hasMore
      ? completeSnapshot
        ? { boundaryKind: "snapshot_at" as const, lowerBound: effectiveRange.to, verification: "exhaustive_vendor_scan" as const }
        : effectiveRange.from === "1970-01-01T00:00:00.000Z"
          ? { boundaryKind: records.length === 0 ? "verified_empty" as const : "verified_oldest" as const, lowerBound: effectiveRange.from, verification: "exhaustive_vendor_scan" as const }
          : { boundaryKind: "window_exhausted" as const, lowerBound: effectiveRange.from, verification: "exhaustive_vendor_scan" as const }
      : undefined;
    return {
      records,
      nextCursor,
      hasMore,
      ...(coverage ? { coverage } : {}),
    };
  }

  private async readStreamPage(
    context: ConnectorContext,
    credential: VersionedCredential,
    request: ReturnType<typeof buildSquareReadRequest>,
  ): Promise<unknown> {
    const url = new URL(request.path, this.connectOrigin);
    for (const [key, value] of Object.entries(request.query)) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else if (typeof value === "object") {
        throw new ConnectorError("CONFIGURATION_INVALID", `Square GET query ${key} cannot contain a nested object.`);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    try {
      const response = await fetchWithRetry(
        this.fetcher,
        url,
        {
          method: request.method,
          headers: {
            authorization: `Bearer ${credential.secret.accessToken}`,
            accept: "application/json",
            "content-type": "application/json",
            "square-version": SQUARE_API_VERSION,
          },
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
          signal: context.abortSignal,
        },
        withVendorRateBudget(this.config.retry, context.vendorRateBudget),
      );
      const value = parseSquareJson(await response.text());
      const errors = asObject(value)?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Square returned item-level errors for a read page.", {
          details: { errorCount: errors.length },
        });
      }
      return value;
    } catch (error) {
      if (error instanceof ConnectorHttpError && (error.status === 403 || error.status === 404)) {
        throw new ConnectorError("CAPABILITY_UNAVAILABLE", `Square read surface is unavailable (${error.status}).`, {
          details: { path: request.path, status: error.status },
        });
      }
      throw error;
    }
  }

  private sourceRecord(
    stream: SquareReadStream,
    source: unknown,
    credential: VersionedCredential,
    pathParameters: Readonly<Record<string, string>> | undefined,
    index: number,
  ): RawSourceRecord {
    const merchantId = nonEmpty(credential.secret.metadata.merchantId) ?? "merchant";
    const sourceId = squareIdentity(stream, source, merchantId, pathParameters, index);
    const updated = stream.modifiedPath ? squareTimestampAtPath(source, stream.modifiedPath) : null;
    const tombstoneValue = stream.deletion.tombstonePath
      ? squareValueAtPath(source, stream.deletion.tombstonePath)
      : false;
    return {
      sourceObjectType: stream.resource,
      sourceRecordId: sourceId,
      ...(updated ? { sourceUpdatedAt: updated } : {}),
      payload: source,
      payloadHash: hashPayload(source),
      normalized: projectSourceRecord({
        schemaVersion: squareManifest.packVersion,
        fields: {
          payload_json: source,
          field_index: buildSquareFieldIndex(source),
          // Nested Square list responses do not consistently echo the path
          // parent (for example PayoutEntry and CashDrawerShiftEvent). Keep
          // request context separate from the immutable vendor payload so
          // child-to-parent joins remain exact without fabricating API fields.
          parent_context: Object.freeze({ ...(pathParameters ?? {}) }),
        },
        tombstone: tombstoneValue === true,
      }),
    };
  }

  private async locationIdsFor(
    stream: SquareReadStream,
    credential: VersionedCredential,
    signal?: AbortSignal,
    vendorRateBudget?: VendorRateBudget,
  ): Promise<readonly string[]> {
    if (stream.transport.locationMode === "none") return [];
    const locationIds = [
      ...new Set((await this.listLocations(credential, signal, vendorRateBudget)).map((location) => location.id)),
    ];
    if (locationIds.length === 0) {
      throw new ConnectorError(
        "REMOTE_RESPONSE_INVALID",
        `Square returned no locations for location-sensitive stream ${stream.id}; refusing an implicit main-location read.`,
      );
    }
    return locationIds;
  }

  private async resolveTraversalWork(
    stream: SquareReadStream,
    credential: VersionedCredential,
    context: ConnectorContext,
    range: SyncRange,
    locationIds: readonly string[],
    traversal: SquareTraversal,
  ): Promise<SquareTraversalWork> {
    const locationGroups = stream.transport.locationMode === "body_many_max_10"
      ? chunk(locationIds, 10)
      : stream.transport.locationMode === "query_one" || stream.transport.locationMode === "body_one"
        ? locationIds.map((id) => [id])
        : [[]];
    const pathParameter = stream.transport.pathParameters[0];
    let parentIds: readonly string[] = [];
    if (pathParameter) {
      if (pathParameter === "merchant_id") {
        parentIds = [nonEmpty(credential.secret.metadata.merchantId) ?? ""];
      } else if (pathParameter === "location_id") {
        parentIds = locationIds;
      } else {
        const parent = parentStreamForParameter(stream, pathParameter);
        if (!parent) {
          throw new ConnectorError("CAPABILITY_UNAVAILABLE", `${stream.id} has no declared parent identity source for ${pathParameter}.`);
        }
        parentIds = await this.collectParentIds(parent, credential, context, range);
      }
    }
    const units: readonly SquareWorkUnit[] = pathParameter
      ? parentIds.filter(Boolean).map((id) => ({
          locationIds: stream.transport.locationMode === "path_one" ? [id] : [],
          pathParameters: { [pathParameter]: id },
        }))
      : locationGroups.map((ids) => ({ locationIds: ids }));
    if (units.length === 0) {
      return {
        locationIds: [],
        currentWorkIndex: 0,
        nextWorkIndex: 0,
        workCount: 0,
      };
    }
    const currentWorkIndex = Math.min(traversal.workIndex, units.length - 1);
    const unit = units[currentWorkIndex]!;
    return {
      ...unit,
      currentWorkIndex,
      nextWorkIndex: currentWorkIndex + 1,
      workCount: units.length,
    };
  }

  /**
   * Parent fan-outs are optional, rate-governed surfaces. Resolve their stable
   * IDs from the dependency endpoint at execution time and bound the traversal
   * so a malformed or unexpectedly huge seller account cannot exhaust memory.
   */
  private async collectParentIds(
    parent: SquareReadStream,
    credential: VersionedCredential,
    context: ConnectorContext,
    range: SyncRange,
  ): Promise<readonly string[]> {
    if (parent.transport.pathParameters.length > 0) {
      throw new ConnectorError("CAPABILITY_UNAVAILABLE", `${parent.id} cannot act as a nested fan-out parent.`);
    }
    const locations = await this.locationIdsFor(
      parent,
      credential,
      context.abortSignal,
      context.vendorRateBudget,
    );
    if (parent.transport.locationMode !== "none" && locations.length === 0) {
      return [];
    }
    const locationGroups = parent.transport.locationMode === "body_many_max_10"
      ? chunk(locations, 10)
      : parent.transport.locationMode === "query_one" || parent.transport.locationMode === "body_one"
        ? locations.map((id) => [id])
        : [[]];
    const ids: string[] = [];
    for (const locationGroup of locationGroups.length ? locationGroups : [[]]) {
      let cursor: string | undefined;
      let pages = 0;
      do {
        const built = buildSquareReadRequest(parent, {
          ...(cursor ? { cursor } : {}),
          ...(parent.pagination.defaultPageSize ? { pageSize: parent.pagination.defaultPageSize } : {}),
          ...(parent.backfill.mode === "time_windowed" ? { beginTime: range.from, endTime: range.to } : {}),
          ...(locationGroup.length ? { locationIds: locationGroup } : {}),
        });
        const value = await this.readStreamPage(context, credential, built);
        for (const row of recordsAt(value, parent.responsePath)) {
          const id = identityCandidate(parent, row);
          if (id) ids.push(id);
        }
        cursor = stringAt(value, parent.pagination.responsePath) ?? undefined;
        pages += 1;
        if (pages > 10_000 || ids.length > 100_000) {
          throw new ConnectorError("CAPABILITY_UNAVAILABLE", `${parent.id} fan-out exceeds the production safety bound.`);
        }
      } while (cursor);
    }
    return [...new Set(ids)];
  }

  private async listLocations(
    credential: VersionedCredential,
    signal?: AbortSignal,
    vendorRateBudget?: VendorRateBudget,
  ): Promise<readonly Readonly<{ id: string }>[]> {
    const { value } = await this.apiJson("/v2/locations", credential, signal, vendorRateBudget);
    const parsed = locationsSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Square returned an invalid locations response.", {
        cause: parsed.error,
      });
    }
    return parsed.data.locations ?? [];
  }

  private async apiJson(
    path: string,
    credential: VersionedCredential,
    signal?: AbortSignal,
    vendorRateBudget?: VendorRateBudget,
  ): Promise<{ value: unknown }> {
    return requestJson<unknown>(
      this.fetcher,
      new URL(path, this.connectOrigin).toString(),
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${credential.secret.accessToken}`,
          accept: "application/json",
          "square-version": SQUARE_API_VERSION,
        },
        signal,
      },
      withVendorRateBudget(this.config.retry, vendorRateBudget),
    );
  }

  private async postToken(
    body: Readonly<Record<string, string>>,
    signal: AbortSignal | undefined,
    failureMessage: string,
  ): Promise<z.infer<typeof tokenSchema>> {
    const { value } = await requestJson<unknown>(
      this.fetcher,
      `${this.connectOrigin}/oauth2/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "square-version": SQUARE_API_VERSION,
        },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          ...body,
        }),
        signal,
      },
      this.config.retry,
    );
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) {
      throw new ConnectorError("OAUTH_EXCHANGE_FAILED", failureMessage, { cause: parsed.error });
    }
    return parsed.data;
  }

  private async readCredential(context: ConnectorContext): Promise<VersionedCredential> {
    const credential = await this.config.vault.read(context.credentialRef);
    if (credential.secret.provider !== this.id) {
      throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Square.");
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
          throw new ConnectorError("CONFIGURATION_INVALID", "Credential provider does not match Square.");
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
      throw new ConnectorError("AUTHENTICATION_REQUIRED", "Square refresh token is missing.");
    }
    const merchantId = String(current.secret.metadata.merchantId ?? "");
    const parsed = await this.postToken({
      grant_type: "refresh_token",
      refresh_token: current.secret.refreshToken,
    }, signal, "Square returned an invalid token refresh.");
    if (merchantId && parsed.merchant_id !== merchantId) {
      throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Square changed merchant identity during token refresh.");
    }
    const scopes = splitOAuthScopes(parsed.scopes);
    const next: OAuthCredentialSecret = {
      ...current.secret,
      accessToken: parsed.access_token,
      // Square's confidential flow returns the same long-lived refresh token,
      // but it is re-read rather than assumed so a future rotation is durable.
      refreshToken: parsed.refresh_token,
      expiresAt: isoOrThrow(parsed.expires_at, "token expiry"),
      scopes: scopes.length > 0 ? scopes : current.secret.scopes,
      metadata: {
        ...current.secret.metadata,
        merchantId: parsed.merchant_id,
        refreshTokenExpiresAt: parsed.refresh_token_expires_at ?? "",
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
      if (!credentialExpiresSoon(latest.secret, this.config.now?.() ?? Date.now())) return latest;
      throw new ConnectorError("CREDENTIAL_CONFLICT", "Concurrent Square token rotation failed.", {
        cause,
        retryable: true,
      });
    }
  }
}

type SquareTraversal = Readonly<{
  workIndex: number;
  vendorCursor?: string;
  traversalStartedAt?: string;
}>;

type SquareWorkUnit = Readonly<{
  locationIds: readonly string[];
  pathParameters?: Readonly<Record<string, string>>;
}>;

type SquareTraversalWork = SquareWorkUnit & Readonly<{
  currentWorkIndex: number;
  nextWorkIndex: number;
  workCount: number;
}>;

function decodeTraversal(value: string | number | undefined): SquareTraversal {
  if (value === undefined) return { workIndex: 0 };
  try {
    const parsed = JSON.parse(String(value)) as Partial<SquareTraversal>;
    if (!Number.isSafeInteger(parsed.workIndex) || Number(parsed.workIndex) < 0) throw new Error("workIndex");
    if (parsed.vendorCursor !== undefined && (typeof parsed.vendorCursor !== "string" || !parsed.vendorCursor)) {
      throw new Error("vendorCursor");
    }
    if (parsed.traversalStartedAt !== undefined && !Number.isFinite(Date.parse(parsed.traversalStartedAt))) {
      throw new Error("traversalStartedAt");
    }
    return {
      workIndex: Number(parsed.workIndex),
      ...(parsed.vendorCursor ? { vendorCursor: parsed.vendorCursor } : {}),
      ...(parsed.traversalStartedAt ? { traversalStartedAt: parsed.traversalStartedAt } : {}),
    };
  } catch (cause) {
    throw new ConnectorError("CURSOR_INVALID", "The Square traversal cursor is invalid.", { cause });
  }
}

function recordsAt(value: unknown, path: string): readonly unknown[] {
  const selected = path ? squareValueAtPath(value, path) : value;
  if (selected === undefined || selected === null) return [];
  if (Array.isArray(selected)) return selected;
  if (selected && typeof selected === "object") return [selected];
  throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Square response path ${path} is not an object or array.`);
}

function stringAt(value: unknown, path: string | null): string | null {
  return path ? squareStringAtPath(value, path) : null;
}

function squareIdentity(
  stream: SquareReadStream,
  source: unknown,
  merchantId: string,
  pathParameters: Readonly<Record<string, string>> | undefined,
  index: number,
): string {
  let local: string | null = null;
  const paths = typeof stream.recordIdPath === "string" ? [stream.recordIdPath] : stream.recordIdPath;
  if (stream.identityMode === "singleton") {
    local = merchantId;
  } else if (stream.identityMode === "composite") {
    const parts = paths.map((path) => scalarIdentifier(squareValueAtPath(source, path)));
    if (parts.every(Boolean)) local = parts.join("|");
  } else if (stream.identityMode === "first_present") {
    local = paths.map((path) => scalarIdentifier(squareValueAtPath(source, path))).find(Boolean) ?? null;
  } else {
    local = scalarIdentifier(squareValueAtPath(source, paths[0] ?? "id"));
  }
  if (!local) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Square ${stream.resource} record ${index} has no stable identity.`);
  }
  const parent = stream.transport.pathParameters.map((key) => pathParameters?.[key]).filter(Boolean);
  return parent.length > 0 ? `${parent.join("|")}|${local}` : local;
}

function identityCandidate(stream: SquareReadStream, source: unknown): string | null {
  const paths = typeof stream.recordIdPath === "string" ? [stream.recordIdPath] : stream.recordIdPath;
  if (stream.identityMode === "composite") {
    const parts = paths.map((path) => scalarIdentifier(squareValueAtPath(source, path)));
    return parts.every(Boolean) ? parts.join("|") : null;
  }
  return paths.map((path) => scalarIdentifier(squareValueAtPath(source, path))).find(Boolean) ?? null;
}

function scalarIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : null;
}

function parentStreamForParameter(stream: SquareReadStream, parameter: string): SquareReadStream | null {
  const singular = parameter.replace(/_id$/u, "");
  for (const dependencyId of stream.dependencies) {
    const dependency = squareReadStream(dependencyId);
    const resource = dependency.resource.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
    if (resource === singular || dependency.id.includes(singular)) return dependency;
  }
  return null;
}

function subtractSeconds(value: string, seconds: number): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ConnectorError("CURSOR_INVALID", "Square watermark is invalid.");
  return new Date(Math.max(0, parsed - Math.max(0, seconds) * 1_000)).toISOString();
}

function latestIso(values: readonly (string | undefined)[], prior?: string): string | undefined {
  const candidates = [...values, prior].filter((value): value is string => Boolean(value));
  return candidates.sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function chunk<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * JSON.parse rounds wire-format int64 values above Number.MAX_SAFE_INTEGER.
 * Square uses int64 for Money.amount, versions and several counters, so retain
 * those tokens as exact decimal strings before parsing the rest normally.
 */
function parseSquareJson(source: string): unknown {
  let normalized = "";
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < source.length) {
    const character = source[index]!;
    if (inString) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      normalized += character;
      index += 1;
      continue;
    }
    if (character === "-" || /[0-9]/u.test(character)) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(index));
      if (match) {
        const token = match[0];
        const integer = /^-?(?:0|[1-9][0-9]*)$/u.test(token);
        const unsafe = integer && (() => {
          try { return BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(token) < BigInt(Number.MIN_SAFE_INTEGER); }
          catch { return true; }
        })();
        normalized += unsafe ? JSON.stringify(token) : token;
        index += token.length;
        continue;
      }
    }
    normalized += character;
    index += 1;
  }
  try {
    return JSON.parse(normalized) as unknown;
  } catch (cause) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Square returned malformed JSON.", { cause });
  }
}

export { squareManifest } from "./manifest.js";
