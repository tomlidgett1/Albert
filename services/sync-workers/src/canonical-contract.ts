import type {
  DimensionId,
  FactId,
  IdentityEvidenceReference,
  SourceAuthorityConcept,
} from "../../../packages/canonical-schema/src/index.js";
import type { ConnectorId } from "../../../packages/connector-sdk/src/index.js";

export type CanonicalProjectionTable = DimensionId | FactId;
export type CanonicalEntityType =
  | "worker"
  | "location"
  | "product_variant"
  | "customer_account"
  | "supplier";

export type CanonicalScalar = string | number | boolean | null;

/**
 * A source reference is resolved inside the tenant-scoped transform
 * transaction. Entity references first honour an accepted entity_source_link;
 * all other references resolve to the deterministic source-owned canonical id.
 */
export type CanonicalSourceReference = Readonly<{
  sourceRef: Readonly<{
    table: CanonicalProjectionTable;
    sourceObjectType: string;
    sourceRecordId?: string;
    connectionId?: string;
    entityType?: CanonicalEntityType;
    nullable?: boolean;
    lookup?: Readonly<{
      kind: "xero_gl_account_code";
      value: string;
    }>;
  }>;
}>;

export type CanonicalProjectionValue = CanonicalScalar | CanonicalSourceReference;

export type CanonicalStagingRow = Readonly<{
  tenant_id: string;
  namespaced_source_key: string;
  connection_id: string;
  external_account_reference: string;
  source_object_type: string;
  source_record_id: string;
  source_version: string | null;
  source_updated_at: string | Date | null;
  payload_hash: string;
  payload_batch_id: string;
  sync_run_id: string;
  tombstone: boolean;
  mapping_version: string;
  ingested_at?: string | Date;
  [column: string]: unknown;
}>;

export type CanonicalUpsertCommand = Readonly<{
  kind: "dimension" | "fact";
  table: CanonicalProjectionTable;
  sourceObjectType: string;
  sourceRecordId: string;
  values: Readonly<Record<string, CanonicalProjectionValue>>;
  tombstone?: boolean;
  entityType?: CanonicalEntityType;
  authorityConcept?: SourceAuthorityConcept;
}>;

export type CanonicalEventLinkCommand = Readonly<{
  kind: "event_link";
  linkType: "duplicate_of" | "accounting_posting_of" | "reversal_of" | "settlement_of" | "part_of_batch";
  from: Readonly<{
    connectionId?: string;
    sourceObjectType: string;
    sourceRecordId: string;
  }>;
  to: Readonly<{
    connectionId?: string;
    sourceObjectType: string;
    sourceRecordId: string;
  }>;
  evidence: Readonly<Record<string, CanonicalScalar>>;
}>;

export type CanonicalCategoryAssignmentCommand = Readonly<{
  kind: "category_assignment";
  sourceObjectType: string;
  sourceRecordId: string;
  productVariant: CanonicalSourceReference;
  productCategory: CanonicalSourceReference;
  effectiveFrom?: string;
  tombstone?: boolean;
}>;

export type CanonicalIdentityHintCommand = Readonly<{
  kind: "identity_hint";
  entityType: CanonicalEntityType;
  sourceObjectType: string;
  sourceRecordId: string;
  externalId?: string;
  deterministicKeys: Readonly<Record<string, string | undefined>>;
  normalizedName?: string;
  corroboratingScope?: string;
  evidenceRefs?: readonly IdentityEvidenceReference[];
  evidenceOnly?: boolean;
}>;

/** A documented lookup-only stream may publish metadata without a core row. */
export type CanonicalMetadataCommand = Readonly<{
  kind: "metadata";
  sourceObjectType: string;
  sourceRecordId: string;
  classification: "lookup_only" | "identity_evidence";
}>;

export type CanonicalProjectionCommand =
  | CanonicalUpsertCommand
  | CanonicalCategoryAssignmentCommand
  | CanonicalEventLinkCommand
  | CanonicalIdentityHintCommand
  | CanonicalMetadataCommand;

/**
 * Tenant-local interpretation settings supplied by the transform worker.
 * Mappers must never infer these values from the worker host's locale.
 */
export type CanonicalMappingContext = Readonly<{
  timezone: string;
  baseCurrency: string;
  tradingDayCutoff: string;
}>;

/** The vendor-secret-free batch identity carried by the canonical queue. */
export type CanonicalTransformBatch = Readonly<{
  tenantId: string;
  batchId: string;
  syncRunId: string;
  connectionId: string;
  connectorId: ConnectorId;
  mappingVersion: string;
}>;

export type CanonicalStreamMapper = (
  stream: string,
  row: CanonicalStagingRow,
  context: CanonicalMappingContext,
) => readonly CanonicalProjectionCommand[];

export function isCanonicalSourceReference(value: unknown): value is CanonicalSourceReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sourceRef = (value as { sourceRef?: unknown }).sourceRef;
  return Boolean(sourceRef && typeof sourceRef === "object" && !Array.isArray(sourceRef));
}
