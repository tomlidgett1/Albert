import {
  DIMENSION_IDS,
  FACT_IDS,
  SOURCE_AUTHORITY_CONCEPTS,
  type DimensionId,
  type FactId,
  type SourceAuthorityConcept,
} from "../../canonical-schema/src/index.js";
import type { CapabilityId, CapabilitySupport } from "./capabilities.js";
import type { ConnectorId } from "./index.js";

export type FieldDisposition = "canonical" | "governed_extension" | "unsupported";
export type StagingFieldType =
  | "text"
  | "numeric"
  | "boolean"
  | "date"
  | "timestamptz"
  | "jsonb";
export type PiiClass =
  | "none"
  | "business_contact"
  | "customer_contact"
  | "employee_contact"
  | "payroll_sensitive"
  | "free_text_untrusted";

export type FieldCoverage = Readonly<{
  stream: string;
  /** Native field name or complete native JSON path represented by this entry. */
  field: string;
  disposition: FieldDisposition;
  /** Logical leaf type exposed through the governed catalogue. */
  stagingType: StagingFieldType;
  /**
   * Physical projection field when many native paths share one typed index.
   * This keeps exhaustive, evolving APIs queryable without manufacturing a
   * fragile SQL column for every nested array/map leaf.
   */
  storageField?: string;
  /** Physical type of storageField; required when it differs from the leaf. */
  storageType?: StagingFieldType;
  /** Path within storageField used by semantic discovery and query planning. */
  queryPath?: string;
  /** Explicitly override whether this governed source field can be queried. */
  queryable?: boolean;
  target?: string;
  reason?: string;
  pii: PiiClass;
}>;

/**
 * Every durable output a connector mapper can emit. This is deliberately a
 * closed data-plane vocabulary: product domains are readiness metadata and
 * must never be accepted as canonical write authority.
 */
export const CONNECTOR_EMITTED_TARGETS = Object.freeze([
  ...DIMENSION_IDS.filter((target) => target !== "calendar_day"),
  ...FACT_IDS,
  "category_assignment",
  "event_link",
  "identity_hint",
  "metadata",
] as const satisfies readonly ConnectorEmittedTarget[]);

export type ConnectorEmittedTarget =
  | Exclude<DimensionId,"calendar_day">
  | FactId
  | "category_assignment"
  | "event_link"
  | "identity_hint"
  | "metadata";

export type StreamContract = Readonly<{
  id: string;
  resource: string;
  endpoint: string;
  recordIdField: string;
  modifiedField?: string;
  /** Source-declared Resource API joins needed to materialize reviewed evidence. */
  queryJoins?: readonly string[];
  pagination:
    | "vendor_cursor"
    | "page"
    | "offset"
    | "resource_start"
    | "resource_id_keyset"
    | "none";
  /**
   * Declares how InitialBackfill covers the source. Time-windowed streams run
   * recent, thirteen-month and oldest-history windows. Snapshot and exhaustive
   * offset streams are scanned once and must publish explicit completion
   * evidence; they are never restarted for each date phase.
   */
  backfillStrategy: "time_windowed" | "snapshot" | "exhaustive_offset";
  /** How a reconciliation sweep finds source records edited outside business-date windows. */
  lateEditStrategy: "modified_field" | "full_snapshot" | "append_only";
  /** The only evidence from which this stream may retire a previously landed identity. */
  deletionStrategy:
    | "soft_delete"
    | "verified_delete_feed"
    | "authoritative_identity_scan"
    /** Mutable source state is reconciled, but absence from a scan never proves deletion. */
    | "no_absence_deletes"
    | "immutable_append_only";
  /** How terminal reconciliation proves the source population observed by the scan. */
  sourceTotalStrategy:
    | "provider_reported"
    | "count_distinct_complete_scan"
    /** A distinct count for a declared bounded scan population, never assumed to be all history. */
    | "count_distinct_bounded_scan";
  /** Optional streams may be durably unavailable without retrying forever. */
  availability?: "required" | "optional";
  /**
   * Streams whose extraction cost is a call per source record (attachments,
   * history, per-contact detail) are declared but not walked by backfill or
   * scheduled sync; they wait for an explicit operator request. Under a daily
   * vendor allowance a per-record fan-out would consume the whole budget for
   * data no product surface reads.
   */
  ingestionMode?: "backfill" | "on_demand";
  /**
   * Streams whose complete current phase must be durably transformed before
   * this stream may materialise canonical rows. Dependencies are connector
   * local, immutable for a connection generation, and must form a DAG.
   */
  dependencies: readonly string[];
  /** Product-facing readiness domains; canonicalTargets remain data-plane tables. */
  productDomains: readonly ("sales" | "inventory" | "customers" | "products" | "accounting" | "workforce")[];
  canonicalTargets: readonly ConnectorEmittedTarget[];
  /** Concept governing this stream's canonical and governed-extension observations. */
  authorityConcept: SourceAuthorityConcept;
  /**
   * Re-land an unchanged projection when a new immutable batch is itself a
   * meaningful observation (for example a point-in-time balance snapshot).
   */
  reprocessIdenticalPayloadOnNewBatch?: boolean;
}>;

const LATE_EDIT_STRATEGIES = new Set([
  "modified_field",
  "full_snapshot",
  "append_only",
]);
const DELETION_STRATEGIES = new Set([
  "soft_delete",
  "verified_delete_feed",
  "authoritative_identity_scan",
  "no_absence_deletes",
  "immutable_append_only",
]);
const SOURCE_TOTAL_STRATEGIES = new Set([
  "provider_reported",
  "count_distinct_complete_scan",
  "count_distinct_bounded_scan",
]);
const SOURCE_AUTHORITY_CONCEPT_SET = new Set<string>(SOURCE_AUTHORITY_CONCEPTS);
const CONNECTOR_EMITTED_TARGET_SET = new Set<string>(CONNECTOR_EMITTED_TARGETS);

const connectorPackVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function isConnectorPackVersion(value:unknown):value is string{
  return typeof value==="string"&&value.length<=120&&connectorPackVersionPattern.test(value);
}

export type RateLimitReservationPolicy = Readonly<{
  key: string;
  burstCapacity: number;
  interval:
    | Readonly<{ kind: "fixed"; milliseconds: number }>
    | Readonly<{
      kind: "window_budget";
      windowMilliseconds: number;
      option: string;
      defaultLimit: number;
      allowedLimits: readonly number[];
      /** Requests deliberately left unused in each vendor window. */
      headroomRequests?: number;
    }>;
}>;

export type RateLimitResponseCooldownPolicy = Readonly<{
  kind: "token_bucket_headers";
  levelHeader: string;
  dripRateHeader: string;
  headroom: number;
}>;

export type RateLimitContract = Readonly<{
  algorithm: string;
  concurrency?: number;
  budgets?: Readonly<Record<string, number | string>>;
  responseHeaders: readonly string[];
  /** Durable GCRA reservations evaluated before every source request. */
  reservations: readonly RateLimitReservationPolicy[];
  /** Declarative vendor-header cooldowns evaluated after each response. */
  cooldowns?: readonly RateLimitResponseCooldownPolicy[];
}>;

export type SourceAuthorityDefaultPolicy = Readonly<{
  concepts: readonly SourceAuthorityConcept[];
  scope:
    | Readonly<{ kind: "connection_account" }>
    | Readonly<{
      kind: "canonical_dimension";
      table: string;
      scopeType: "legal_entity" | "location";
    }>;
}>;

export type VerifiedWebhookTombstonePolicy = Readonly<{
  jobReason: "webhook";
  requireReceipt: boolean;
  payloadSignalType: string;
}>;

export type ConnectorManifest = Readonly<{
  id: ConnectorId;
  displayName: string;
  packVersion: string;
  apiVersion: string;
  releasedAt: string;
  documentation: readonly string[];
  /**
   * Connection-level ingestion policy owned by the connector pack. OAuth can
   * establish and refresh a grant without implying that data movement started.
   */
  ingestion: Readonly<{
    initialStart: "automatic" | "manual";
  }>;
  oauth: Readonly<{
    scopes: readonly string[];
    /**
     * Vendor scope-model limitations that prevent a narrower grant. These are
     * never permission for the connector to issue a vendor write request.
     */
    leastPrivilegeNotes: readonly string[];
    refreshTokenRotation: boolean;
    remoteRevocation: "supported" | "not_documented";
  }>;
  streams: readonly StreamContract[];
  sourceAuthority: Readonly<{
    defaults: readonly SourceAuthorityDefaultPolicy[];
  }>;
  rateLimit: RateLimitContract;
  webhook?: Readonly<{
    verifiedTombstones?: VerifiedWebhookTombstonePolicy;
  }>;
  capabilities: Readonly<Partial<Record<CapabilityId, Readonly<{
    support: CapabilitySupport;
    /** Streams whose successful extraction can publish this capability. */
    streams: readonly string[];
    /** Direct source fields used to measure optional-data coverage. */
    coverageFields?: readonly string[];
    /** Do not expose the capability until at least one declared field is present. */
    requiresObservedCoverage?: boolean;
    /** Require a non-zero value in one coverage field before publishing. */
    nonZeroCoverage?: boolean;
    reason: string;
  }>>>>;
  identityRules: readonly string[];
  topology: readonly string[];
  fieldCoverage: readonly FieldCoverage[];
  qualityAssertions: readonly string[];
  limitations: readonly string[];
  unknownFieldPolicy: "quarantine_schema_drift";
}>;

export function assertFixtureFieldCoverage(
  manifest: ConnectorManifest,
  stream: string,
  records: readonly Readonly<Record<string, unknown>>[],
): void {
  const covered = new Set(
    manifest.fieldCoverage
      .filter((entry) => entry.stream === stream)
      .flatMap((entry) => [entry.field, entry.storageField].filter((field): field is string => Boolean(field))),
  );
  for (const record of records) {
    for (const field of Object.keys(record)) {
      if (!covered.has(field)) {
        throw new Error(
          `${manifest.id}.${stream} field ${field} has no coverage disposition.`,
        );
      }
    }
  }
}

/** Runtime registry guard: structural policy omissions must fail before any source request. */
export function assertConnectorManifestReconciliationPolicy(manifest: ConnectorManifest): void {
  if (!isConnectorPackVersion(manifest.packVersion)) {
    throw new Error(`${manifest.id} packVersion must be a release-grade semantic version.`);
  }
  if (manifest.ingestion.initialStart !== "automatic" && manifest.ingestion.initialStart !== "manual") {
    throw new Error(`${manifest.id} has an invalid initial ingestion policy.`);
  }
  const ids = new Set<string>();
  for (const stream of manifest.streams) {
    if (ids.has(stream.id)) throw new Error(`${manifest.id} has duplicate stream ${stream.id}.`);
    ids.add(stream.id);
    if (!LATE_EDIT_STRATEGIES.has(stream.lateEditStrategy)) {
      throw new Error(`${manifest.id}.${stream.id} is missing a valid lateEditStrategy.`);
    }
    if (!DELETION_STRATEGIES.has(stream.deletionStrategy)) {
      throw new Error(`${manifest.id}.${stream.id} is missing a valid deletionStrategy.`);
    }
    if (!SOURCE_TOTAL_STRATEGIES.has(stream.sourceTotalStrategy)) {
      throw new Error(`${manifest.id}.${stream.id} is missing a valid sourceTotalStrategy.`);
    }
    if (!SOURCE_AUTHORITY_CONCEPT_SET.has(stream.authorityConcept)) {
      throw new Error(`${manifest.id}.${stream.id} is missing a valid authorityConcept.`);
    }
    if (stream.lateEditStrategy === "modified_field" && !stream.modifiedField) {
      throw new Error(`${manifest.id}.${stream.id} declares modified_field without modifiedField.`);
    }
    if (
      stream.deletionStrategy === "immutable_append_only" &&
      stream.lateEditStrategy !== "append_only"
    ) {
      throw new Error(`${manifest.id}.${stream.id} immutable deletion policy requires append_only late edits.`);
    }
    if (
      stream.deletionStrategy === "authoritative_identity_scan" &&
      stream.sourceTotalStrategy === "count_distinct_bounded_scan"
    ) {
      throw new Error(`${manifest.id}.${stream.id} cannot infer deletion from a bounded source population.`);
    }
    if (!stream.productDomains.length || new Set(stream.productDomains).size !== stream.productDomains.length) {
      throw new Error(`${manifest.id}.${stream.id} must declare unique product readiness domains.`);
    }
    if (!stream.canonicalTargets.length ||
        new Set(stream.canonicalTargets).size !== stream.canonicalTargets.length ||
        stream.canonicalTargets.some((target) => !CONNECTOR_EMITTED_TARGET_SET.has(target))) {
      throw new Error(`${manifest.id}.${stream.id} must declare unique, known canonical targets.`);
    }
    if (new Set(stream.dependencies).size !== stream.dependencies.length || stream.dependencies.includes(stream.id)) {
      throw new Error(`${manifest.id}.${stream.id} has invalid stream dependencies.`);
    }
  }
  for (const stream of manifest.streams) {
    const missing = stream.dependencies.filter((dependency) => !ids.has(dependency));
    if (missing.length) {
      throw new Error(`${manifest.id}.${stream.id} references unknown dependencies: ${missing.join(", ")}.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(manifest.streams.map((stream) => [stream.id, stream]));
  const visit = (streamId: string): void => {
    if (visited.has(streamId)) return;
    if (visiting.has(streamId)) throw new Error(`${manifest.id} stream dependencies contain a cycle at ${streamId}.`);
    visiting.add(streamId);
    for (const dependency of byId.get(streamId)?.dependencies ?? []) visit(dependency);
    visiting.delete(streamId);
    visited.add(streamId);
  };
  for (const stream of manifest.streams) visit(stream.id);

  const defaultConcepts = new Set<string>();
  // Source authority is a claim that this connector can be believed about a
  // concept. An authorization-only pack extracts nothing, so it must claim
  // none — asserting authority without a stream to back it is the defect the
  // non-empty rule below exists to prevent, inverted.
  if (manifest.streams.length === 0) {
    if (manifest.sourceAuthority.defaults.length > 0) {
      throw new Error(`${manifest.id} declares no stream and cannot claim source authority.`);
    }
    return;
  }
  if (manifest.sourceAuthority.defaults.length === 0) {
    throw new Error(`${manifest.id} must declare source-authority defaults.`);
  }
  for (const policy of manifest.sourceAuthority.defaults) {
    if (policy.concepts.length === 0) {
      throw new Error(`${manifest.id} source-authority defaults cannot be empty.`);
    }
    if (policy.scope.kind === "canonical_dimension") {
      const canonicalTable = policy.scope.table;
      if (!/^[a-z_][a-z0-9_]*$/u.test(canonicalTable) ||
          !manifest.streams.some((stream) =>
            stream.canonicalTargets.some((target) => target === canonicalTable))) {
        throw new Error(`${manifest.id} source-authority canonical dimension is invalid.`);
      }
    }
    for (const concept of policy.concepts) {
      if (!SOURCE_AUTHORITY_CONCEPT_SET.has(concept) || defaultConcepts.has(concept)) {
        throw new Error(`${manifest.id} source-authority default ${concept} is invalid or duplicated.`);
      }
      defaultConcepts.add(concept);
    }
  }
  const streamConcepts = new Set(manifest.streams.map((stream) => stream.authorityConcept));
  for (const concept of streamConcepts) {
    if (!defaultConcepts.has(concept)) {
      throw new Error(`${manifest.id} stream authority ${concept} has no default policy.`);
    }
  }

  const reservationKeys = new Set<string>();
  if (manifest.rateLimit.reservations.length === 0) {
    throw new Error(`${manifest.id} must declare at least one rate-limit reservation.`);
  }
  for (const reservation of manifest.rateLimit.reservations) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,119}$/u.test(reservation.key) ||
        reservationKeys.has(reservation.key) ||
        !Number.isSafeInteger(reservation.burstCapacity) || reservation.burstCapacity < 1) {
      throw new Error(`${manifest.id} has an invalid rate-limit reservation.`);
    }
    reservationKeys.add(reservation.key);
    if (reservation.interval.kind === "fixed") {
      if (!Number.isSafeInteger(reservation.interval.milliseconds) ||
          reservation.interval.milliseconds < 1) {
        throw new Error(`${manifest.id} has an invalid fixed rate-limit interval.`);
      }
      continue;
    }
    const { interval } = reservation;
    if (!/^[a-z][A-Za-z0-9]{0,79}$/u.test(interval.option) ||
        !Number.isSafeInteger(interval.windowMilliseconds) || interval.windowMilliseconds < 1 ||
        !Number.isSafeInteger(interval.defaultLimit) || interval.defaultLimit < 1 ||
        interval.allowedLimits.length === 0 ||
        !interval.allowedLimits.includes(interval.defaultLimit) ||
        new Set(interval.allowedLimits).size !== interval.allowedLimits.length ||
        interval.allowedLimits.some((limit) => !Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error(`${manifest.id} has an invalid window rate-limit interval.`);
    }
  }
  const responseHeaders = new Set(manifest.rateLimit.responseHeaders.map((header) =>
    header.toLowerCase()
  ));
  if (manifest.rateLimit.responseHeaders.some((header) =>
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u.test(header)
  )) {
    throw new Error(`${manifest.id} has an invalid rate-limit response header.`);
  }
  for (const cooldown of manifest.rateLimit.cooldowns ?? []) {
    if (cooldown.kind !== "token_bucket_headers" ||
        !Number.isFinite(cooldown.headroom) || cooldown.headroom < 0 ||
        !responseHeaders.has(cooldown.levelHeader.toLowerCase()) ||
        !responseHeaders.has(cooldown.dripRateHeader.toLowerCase())) {
      throw new Error(`${manifest.id} has an invalid response cooldown policy.`);
    }
  }
  const tombstones = manifest.webhook?.verifiedTombstones;
  if (tombstones && (
    tombstones.jobReason !== "webhook" || !tombstones.requireReceipt ||
    !/^[a-z][a-z0-9_]{2,119}$/u.test(tombstones.payloadSignalType)
  )) {
    throw new Error(`${manifest.id} has an invalid verified-webhook tombstone policy.`);
  }
}
