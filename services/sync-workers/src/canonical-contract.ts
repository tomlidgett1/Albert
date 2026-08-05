import type {
  DimensionId,
  FactId,
  IdentityEvidenceReference,
  SourceAuthorityConcept,
} from "../../../packages/canonical-schema/src/index.js";
import type { ConnectorId } from "../../../packages/connector-sdk/src/index.js";

export type CanonicalHookDatabaseValue = string | number | boolean | null;
declare const canonicalReplayCandidateBrand: unique symbol;

/** Runtime-minted capability; connector code cannot inspect or forge its row. */
export type CanonicalReplayCandidateHandle = Readonly<{
  readonly [canonicalReplayCandidateBrand]: true;
}>;

/**
 * A connector hook can invoke only an operation registered by the composition
 * root. It never receives a transform_rw client or caller-authored SQL.
 */
export type CanonicalHookDatabase = Readonly<{
  run<Row extends Readonly<Record<string, unknown>>>(
    operation: string,
    values: readonly CanonicalHookDatabaseValue[],
  ): Promise<readonly Row[]>;
  replayCandidates(
    operation: string,
    values: readonly CanonicalHookDatabaseValue[],
  ): Promise<readonly CanonicalReplayCandidateHandle[]>;
}>;

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
export type CanonicalConnectorNaturalKeyLookup = Readonly<{
  kind: "connector_natural_key";
  key: string;
  value: string;
}>;

export type CanonicalSourceReferenceDescriptor = Readonly<{
  table: CanonicalProjectionTable;
  sourceObjectType: string;
  sourceRecordId?: string;
  connectionId?: string;
  entityType?: CanonicalEntityType;
  nullable?: boolean;
  lookup?: CanonicalConnectorNaturalKeyLookup | Readonly<{
    kind: "employment_episode_on";
    workerSourceObjectType: string;
    workerSourceRecordId: string;
    businessDate: string;
  }>;
}>;

export type CanonicalSourceReference = Readonly<{
  sourceRef: CanonicalSourceReferenceDescriptor;
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
  /** Apply a verified identity-only deletion only when the canonical row exists. */
  updateOnly?: boolean;
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
  corroboratingScopeRef?: IdentityEvidenceReference;
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

/**
 * A row the connector observed and deliberately does not project.
 *
 * A mapper returning no commands stays a defect (`canonical_mapper_empty`):
 * silently dropping a record must never look like success. This is the
 * explicit, named alternative for a vendor row that carries no economic event
 * of its own — a roll-up the vendor derives from rows Albert already holds.
 * The row is consumed, heals any prior quarantine, and projects nothing.
 */
export class CanonicalRowNotApplicable extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`canonical_row_not_applicable:${reason}`);
    this.name = "CanonicalRowNotApplicable";
    this.reason = reason;
  }
}

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
  connectionGeneration: number;
  connectorId: ConnectorId;
  mappingVersion: string;
}>;

export type CanonicalStreamMapper = (
  stream: string,
  row: CanonicalStagingRow,
  context: CanonicalMappingContext,
) => readonly CanonicalProjectionCommand[];

export type CanonicalCompatibilityReplaySelection = Readonly<{
  eligible: boolean;
  candidates: readonly CanonicalReplayCandidateHandle[];
}>;

export type CanonicalCompatibilityReplayHook = Readonly<{
  databaseRegistrationId: string;
  sourceStream: string;
  candidateLimit: number;
  commandLimit: number;
  handles(job: CanonicalTransformBatch, stream: string): boolean;
  selectChunk(input: Readonly<{
    database: CanonicalHookDatabase;
    job: CanonicalTransformBatch;
  }>): Promise<CanonicalCompatibilityReplaySelection>;
}>;

export type CanonicalReferenceLookupResolution =
  | Readonly<{
      status: "matched";
      sourceObjectType: string;
      sourceRecordId: string;
    }>
  | Readonly<{ status: "missing" | "ambiguous" }>;

/** Connector-owned source-schema lookup; canonical identity and existence stay generic. */
export type CanonicalReferenceLookupHook = Readonly<{
  databaseRegistrationId: string;
  resolve(input: Readonly<{
    database: CanonicalHookDatabase;
    job: CanonicalTransformBatch;
    reference: CanonicalSourceReferenceDescriptor;
    lookup: CanonicalConnectorNaturalKeyLookup;
  }>): Promise<CanonicalReferenceLookupResolution>;
}>;

export type CanonicalDossierFactContribution = Readonly<{
  key: string;
  value: string | readonly string[] | null;
  source: string;
  observedAt: string | Date | null;
  confidence: number;
  confirmationState: "source_reported" | "inferred";
  merge: "replace" | "fill";
}>;

export type CanonicalDossierContext = Readonly<{
  legalEntityName: string | null;
  baseCurrency: string | null;
  entityObservedAt: string | Date | null;
}>;

/** Connector-owned dossier evidence collector, called inside the transform transaction. */
export type CanonicalDossierContributorHook = Readonly<{
  connectorId: ConnectorId;
  databaseRegistrationId: string;
  ownedKeys: readonly string[];
  collect(input: Readonly<{
    database: CanonicalHookDatabase;
    tenantId: string;
    connection: Readonly<{connectionId:string;connectionGeneration:number}>;
    context: CanonicalDossierContext;
  }>): Promise<readonly CanonicalDossierFactContribution[]>;
}>;

export function isCanonicalSourceReference(value: unknown): value is CanonicalSourceReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sourceRef = (value as { sourceRef?: unknown }).sourceRef;
  return Boolean(sourceRef && typeof sourceRef === "object" && !Array.isArray(sourceRef));
}
