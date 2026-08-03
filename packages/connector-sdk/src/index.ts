/** Stable IDs for the first connector set. Connector-specific logic stays in its pack. */
export const CONNECTOR_IDS = ["lightspeed-r", "xero", "deputy"] as const;

export type ConnectorId = (typeof CONNECTOR_IDS)[number];

export type ConnectionHealth = "healthy" | "degraded" | "expired" | "revoked";

export type ReadinessState =
  | "not_started"
  | "syncing"
  | "transforming"
  | "validating"
  | "ready_partial"
  | "ready_complete"
  | "degraded"
  | "blocked";

export type SyncJobType = "InitialBackfill" | "IncrementalSync" | "ReconciliationSweep";

/** Durable, cross-replica request coordination for one vendor connection. */
export interface VendorRateBudget {
  beforeRequest(signal?: AbortSignal): Promise<void>;
  observeResponse(response: Response): Promise<void>;
}

export type ConnectorContext = Readonly<{
  tenantId: string;
  connectionId: string;
  /** An opaque vault reference. Connector code never receives browser credentials. */
  credentialRef: string;
  abortSignal?: AbortSignal;
  vendorRateBudget?: VendorRateBudget;
}>;

export type ConnectorStream = Readonly<{
  id: string;
  label: string;
  domains: readonly string[];
  cursorKind: "high_water_mark" | "offset" | "page" | "none";
  /** Lower values are pulled first during a progressive initial backfill. */
  priority?: number;
}>;

export type ConnectorCapability = Readonly<{
  id: string;
  support: "full" | "partial" | "unavailable" | "unknown";
  notes?: string;
  requiredScopes?: readonly string[];
}>;

export type AuthorizationRequest = Readonly<{
  redirectUri: string;
  state: string;
  codeChallenge?: string;
  scopes: readonly string[];
}>;

export type AuthorizationRedirect = Readonly<{
  url: string;
  expiresAt: string;
}>;

export type ConnectionDiscovery = Readonly<{
  externalAccountId: string;
  displayName: string;
  baseUrl?: string;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type SyncRange = Readonly<{
  from: string;
  to: string;
}>;

export type SyncCursor = Readonly<{
  value: string;
  sourceUpdatedAt?: string;
}>;

export type RawSourceRecord = Readonly<{
  sourceObjectType: string;
  sourceRecordId: string;
  sourceUpdatedAt?: string;
  /** Exact vendor payload. This value is written to immutable raw storage. */
  payload: unknown;
  /** Typed staging projection. Raw values remain available in `payload`. */
  normalized?: SourceRecordProjection;
  /**
   * Validation findings are always persisted with the immutable raw payload.
   * `schema_invalid` and `normalization_invalid` block staging. Additive
   * `schema_drift` is fail-visible but may retain a projection containing only
   * fields with an explicit manifest disposition.
   */
  validationIssues?: readonly Readonly<{
    code: "schema_invalid" | "schema_drift" | "normalization_invalid";
    path: string;
    message: string;
  }>[];
  payloadHash: string;
}>;

export type NormalizedDecimal = Readonly<{
  raw: string | number | null;
  /** A base-10 representation safe for Postgres numeric(19,4), or null. */
  exact: string | null;
  currency: string | null;
}>;

export type NormalizedTimestamp = Readonly<{
  raw: string | number | null;
  utc: string | null;
}>;

export type SourceRecordProjection = Readonly<{
  schemaVersion: string;
  fields: Readonly<Record<string, unknown>>;
  money?: Readonly<Record<string, NormalizedDecimal>>;
  timestamps?: Readonly<Record<string, NormalizedTimestamp>>;
  tombstone?: boolean;
}>;

export type SyncPage = Readonly<{
  records: readonly RawSourceRecord[];
  nextCursor: SyncCursor | null;
  sourceTotal?: number;
  hasMore: boolean;
}>;

export type WebhookEnvelope = Readonly<{
  id: string;
  receivedAt: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

export type WebhookDisposition = Readonly<{
  accepted: boolean;
  dedupeKey?: string;
  streams: readonly string[];
  externalAccountIds?: readonly string[];
  reason?: string;
}>;

/**
 * The pack boundary mirrors the v1 specification. Cross-system matching and
 * authority logic are deliberately absent from this interface.
 */
export interface ConnectorPack {
  readonly id: ConnectorId;
  readonly version: string;
  readonly apiVersion: string;

  authorize(request: AuthorizationRequest): Promise<AuthorizationRedirect>;
  check_connection(context: ConnectorContext): Promise<ConnectionHealth>;
  discover_account(context: ConnectorContext): Promise<ConnectionDiscovery>;
  list_streams(context: ConnectorContext): Promise<readonly ConnectorStream[]>;
  initial_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    range: SyncRange,
    cursor?: SyncCursor,
  ): Promise<SyncPage>;
  incremental_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    cursor: SyncCursor,
  ): Promise<SyncPage>;
  handle_webhook(
    context: ConnectorContext,
    event: WebhookEnvelope,
  ): Promise<WebhookDisposition>;
  refresh_credentials(context: ConnectorContext): Promise<{ credentialRef: string }>;
  describe_capabilities(
    context: ConnectorContext,
  ): Promise<readonly ConnectorCapability[]>;
}

export function makeNamespacedSourceKey(
  connectorId: ConnectorId,
  externalAccountId: string,
  sourceObjectType: string,
  sourceRecordId: string,
): string {
  const parts = [connectorId, externalAccountId, sourceObjectType, sourceRecordId];
  if (parts.some((part) => part.trim().length === 0)) {
    throw new Error("A namespaced source key cannot contain an empty component.");
  }
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

export * from "./contract.js";
export * from "./cursor.js";
export * from "./errors.js";
export * from "./http.js";
export * from "./normalization.js";
export * from "./oauth.js";
export * from "./staging.js";
