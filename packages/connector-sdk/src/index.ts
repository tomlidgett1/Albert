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
  backfillStrategy: import("./contract.js").StreamContract["backfillStrategy"];
  lateEditStrategy: import("./contract.js").StreamContract["lateEditStrategy"];
  deletionStrategy: import("./contract.js").StreamContract["deletionStrategy"];
  sourceTotalStrategy: import("./contract.js").StreamContract["sourceTotalStrategy"];
  availability: "required" | "optional";
  dependencies: readonly string[];
  productDomains: import("./contract.js").StreamContract["productDomains"];
  /** Lower values are pulled first during a progressive initial backfill. */
  priority?: number;
}>;

export type ConnectorCapability = Readonly<{
  id: import("./capabilities.js").CapabilityId;
  support: import("./capabilities.js").CapabilitySupport;
  reasonCode: string;
  notes?: string;
  requiredScopes?: readonly string[];
  coverage?: import("./capabilities.js").CapabilityCoverage;
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

export type ReconciliationExtractionPhase =
  | "late_edits"
  | "identity_snapshot"
  | "verify_snapshot";

export type ReconciliationRequest = Readonly<{
  phase: ReconciliationExtractionPhase;
  range: SyncRange;
  cursor?: SyncCursor;
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
   * Marks an identity-only tombstone derived from a verified source webhook.
   * The referenced webhook receipt retains the exact vendor payload; staging
   * preserves prior source fields while applying this newer deletion state.
   */
  deletionSignal?: Readonly<{
    kind: "verified_webhook_tombstone" | "reconciliation_tombstone";
    webhookReceiptId?: string;
    reconciliationSweepId?: string;
    evidenceBatchIds?: readonly string[];
    /** Compare-and-swap fence captured when an absence candidate was selected. */
    expectedPayloadHash?: string;
    expectedSourceUpdatedAt?: string | null;
    expectedIngestedAt?: string;
  }>;
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
  /**
   * The vendor returned a non-terminal page whose pagination identity cannot
   * advance safely. Workers persist and quarantine the page, but must not
   * commit a cursor or enqueue a successor. This is deliberately structured
   * data rather than an exception so the malformed source rows are retained
   * as governed remediation evidence before the run is blocked.
   */
  paginationBlock?: Readonly<{
    code: "pagination_identity_invalid" | "pagination_not_advancing";
    detail: string;
  }>;
  /** Required on the terminal page of a one-pass stream or oldest-history phase. */
  coverage?: Readonly<{
    boundaryKind:
      | "verified_oldest"
      | "verified_empty"
      | "account_start"
      | "vendor_retention"
      | "snapshot_at"
      | "window_exhausted";
    lowerBound: string;
    verification:
      | "exhaustive_vendor_scan"
      | "vendor_reported"
      | "account_metadata"
      | "point_in_time";
    detail?: string;
  }>;
}>;

export type WebhookEnvelope = Readonly<{
  id: string;
  receivedAt: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

/**
 * A source-owned deletion identity carried by a verified webhook. The signal
 * is not treated as a replacement for polling; it lets ingestion materialise
 * a tombstone when a subsequently queried Resource no longer exists.
 */
export type WebhookTombstoneSignal = Readonly<{
  kind: "tombstone";
  stream: string;
  sourceObjectType: string;
  sourceRecordId: string;
  observedAt: string;
}>;

export type WebhookDisposition = Readonly<{
  accepted: boolean;
  dedupeKey?: string;
  streams: readonly string[];
  externalAccountIds?: readonly string[];
  reconciliationSignals?: readonly WebhookTombstoneSignal[];
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
  readonly manifest: import("./contract.js").ConnectorManifest;

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
  /** Unfiltered identity scans and late-edit extraction; never a vendor write path. */
  reconciliation_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    request: ReconciliationRequest,
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
export * from "./capabilities.js";
export * from "./cursor.js";
export * from "./errors.js";
export * from "./http.js";
export * from "./normalization.js";
export * from "./oauth.js";
export * from "./staging.js";
