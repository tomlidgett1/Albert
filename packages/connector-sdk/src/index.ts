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

export type ConnectorContext = Readonly<{
  tenantId: string;
  connectionId: string;
  /** An opaque vault reference. Connector code never receives browser credentials. */
  credentialRef: string;
  abortSignal?: AbortSignal;
}>;

export type ConnectorStream = Readonly<{
  id: string;
  label: string;
  domains: readonly string[];
  cursorKind: "high_water_mark" | "offset" | "page" | "none";
}>;

export type ConnectorCapability = Readonly<{
  id: string;
  support: "full" | "partial" | "unavailable" | "unknown";
  notes?: string;
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
  payload: unknown;
  payloadHash: string;
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
