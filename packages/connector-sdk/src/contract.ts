import type { ConnectorId } from "./index.js";
import type { CapabilityId, CapabilitySupport } from "./capabilities.js";

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
  field: string;
  disposition: FieldDisposition;
  stagingType: StagingFieldType;
  target?: string;
  reason?: string;
  pii: PiiClass;
}>;

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
    | "immutable_append_only";
  /** How terminal reconciliation proves the source population observed by the scan. */
  sourceTotalStrategy: "provider_reported" | "count_distinct_complete_scan";
  /** Optional streams may be durably unavailable without retrying forever. */
  availability?: "required" | "optional";
  /**
   * Streams whose complete current phase must be durably transformed before
   * this stream may materialise canonical rows. Dependencies are connector
   * local, immutable for a connection generation, and must form a DAG.
   */
  dependencies: readonly string[];
  /** Product-facing readiness domains; canonicalTargets remain data-plane tables. */
  productDomains: readonly ("sales" | "inventory" | "customers" | "products" | "accounting" | "workforce")[];
  canonicalTargets: readonly string[];
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
  "immutable_append_only",
]);
const SOURCE_TOTAL_STRATEGIES = new Set([
  "provider_reported",
  "count_distinct_complete_scan",
]);

export type RateLimitContract = Readonly<{
  algorithm: string;
  concurrency?: number;
  budgets?: Readonly<Record<string, number | string>>;
  responseHeaders: readonly string[];
}>;

export type ConnectorManifest = Readonly<{
  id: ConnectorId;
  displayName: string;
  packVersion: string;
  apiVersion: string;
  releasedAt: string;
  documentation: readonly string[];
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
  rateLimit: RateLimitContract;
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
      .map((entry) => entry.field),
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
    if (stream.lateEditStrategy === "modified_field" && !stream.modifiedField) {
      throw new Error(`${manifest.id}.${stream.id} declares modified_field without modifiedField.`);
    }
    if (
      stream.deletionStrategy === "immutable_append_only" &&
      stream.lateEditStrategy !== "append_only"
    ) {
      throw new Error(`${manifest.id}.${stream.id} immutable deletion policy requires append_only late edits.`);
    }
    if (!stream.productDomains.length || new Set(stream.productDomains).size !== stream.productDomains.length) {
      throw new Error(`${manifest.id}.${stream.id} must declare unique product readiness domains.`);
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
}
