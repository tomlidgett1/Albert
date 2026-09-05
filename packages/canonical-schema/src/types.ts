export const DIMENSION_IDS = [
  "calendar_day",
  "location",
  "register",
  "channel",
  "legal_entity",
  "person",
  "customer_account",
  "worker",
  "employment_episode",
  "supplier",
  "product",
  "product_variant",
  "product_category",
  "gl_account",
  "tax_code",
  "stock_location",
] as const;

export type DimensionId = (typeof DIMENSION_IDS)[number];

export const FACT_IDS = [
  "commerce_order",
  "commerce_order_line",
  "commerce_payment",
  "commerce_refund",
  "commerce_refund_line",
  "commerce_payment_fee",
  "inventory_movement",
  "inventory_balance_snapshot",
  "purchase_order_line",
  "finance_journal_line",
  "finance_invoice_line",
  "finance_bank_transaction",
  "finance_settlement",
  "finance_settlement_line",
  "workforce_shift",
  "workforce_time_entry",
  "workforce_leave",
] as const;

export type FactId = (typeof FACT_IDS)[number];

export type RelationshipCardinality = "many_to_one" | "one_to_one";
export type Additivity =
  | "additive"
  | "non_additive"
  | "last_value_over_time"
  | "duration_additive";
export type RefundBehaviour = "not_applicable" | "separate_reversal_fact" | "subtract";
export type VoidBehaviour = "exclude" | "retain_with_status" | "not_applicable";
export type ReversalBehaviour = "event_link" | "signed_amount" | "not_applicable";

export type FactRelationship = Readonly<{
  dimension: DimensionId;
  foreignKey: string;
  cardinality: RelationshipCardinality;
  nullable: boolean;
}>;

export type FactDeclaration = Readonly<{
  id: FactId;
  table: `core.${FactId}`;
  grain: string;
  primaryKey: readonly ["tenant_id", "id"];
  relationships: readonly FactRelationship[];
  additiveFields: Readonly<Record<string, Additivity>>;
  timeRoles: readonly string[];
  defaultTimeRole: string;
  refundBehaviour: RefundBehaviour;
  voidBehaviour: VoidBehaviour;
  reversalBehaviour: ReversalBehaviour;
}>;

export type DimensionDeclaration = Readonly<{
  id: DimensionId;
  table: `core.${DimensionId}`;
  grain: string;
  tenantScoped: boolean;
  effectiveDated?: boolean;
}>;

export const SOURCE_AUTHORITY_CONCEPTS = [
  "operational_sales",
  "stock",
  "product_master",
  "customer_master",
  "statutory_finance",
  "cash_settlement",
  "planned_shifts",
  "worked_hours",
] as const;

export type SourceAuthorityConcept = (typeof SOURCE_AUTHORITY_CONCEPTS)[number];

export type AuthorityConnectionMap = Readonly<{
  lightspeed?: string;
  xero?: string;
  deputy?: string;
  square?: string;
  momence?: string;
}>;

export type SourceAuthorityDefault = Readonly<{
  concept: SourceAuthorityConcept;
  connectionId: string;
}>;

export const QUALITY_CHECK_IDS = [
  "pk_unique",
  "orphan_rate",
  "status_mapping_total",
  "tz_validity",
  "tax_consistency",
  "field_coverage_vs_manifest",
  "observation_coverage",
  "no_orphan_observations",
  "line_maths",
  "tender_reconciles",
  "stock_continuity",
  "journal_balances",
  "shift_timesheet_coverage",
  "pos_ledger_tolerance",
  "no_fanout",
  "grain_compatible_ratios",
  "snapshot_not_summed",
  "authority_respected",
  "golden_fixture_match",
] as const;

export type QualityCheckId = (typeof QUALITY_CHECK_IDS)[number];
export type QualityCheckStatus = "passed" | "warning" | "failed" | "blocked";

export type QualityCheckResult = Readonly<{
  checkId: QualityCheckId;
  status: QualityCheckStatus;
  observed: string;
  threshold?: string;
  details: Readonly<Record<string, unknown>>;
}>;

export type CanonicalSourceRef = Readonly<{
  connectionId: string;
  sourceObjectType: string;
  sourceRecordId: string;
}>;

export type CanonicalCandidate<T extends Readonly<Record<string, unknown>>> = Readonly<{
  tenantId: string;
  id: string;
  fact: FactId;
  authorityConcept: SourceAuthorityConcept;
  source: CanonicalSourceRef;
  syncRunId: string;
  sourceUpdatedAt?: string;
  values: T;
}>;

export type AuthorityRule = Readonly<{
  concept: SourceAuthorityConcept;
  connectionId: string;
  effectiveFrom: string;
  effectiveTo?: string;
  scopeType: "tenant" | "location" | "legal_entity";
  scopeId: string;
}>;

export type IdentitySourceObservation = Readonly<{
  tenantId: string;
  entityType: "worker" | "location" | "product_variant" | "customer_account" | "supplier";
  connectionId: string;
  sourceObjectType: string;
  sourceRecordId: string;
  externalId?: string;
  deterministicKeys: Readonly<Record<string, string | undefined>>;
  normalizedName?: string;
  corroboratingScope?: string;
  /** Same-connection lookup observations whose deterministic evidence enriches this subject. */
  evidenceRefs?: readonly IdentityEvidenceReference[];
  /** Evidence-only observations are never emitted as review-card subjects. */
  linkable?: boolean;
}>;

export type IdentityEvidenceReference = Readonly<{
  sourceObjectType: string;
  sourceRecordId: string;
}>;

export type IdentitySuggestion = Readonly<{
  left: IdentitySourceObservation;
  right: IdentitySourceObservation;
  matchMethod: "external_id" | "deterministic_key" | "composite_suggestion";
  matchStatus: "accepted" | "proposed";
  confidenceBand: "high" | "medium";
  evidence: Readonly<Record<string, string>>;
}>;
