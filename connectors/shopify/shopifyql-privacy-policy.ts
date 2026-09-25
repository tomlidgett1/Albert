import { createHash } from "node:crypto";

import type { ShopifyQLSchemaRegistry } from "./shopifyql-registry.js";

/**
 * Reviewed execution policy for the committed official ShopifyQL 2026-07
 * registry. Catalogue metadata remains visible, but merchant values for fields
 * that can identify or link a person are not executable through Albert.
 *
 * Keep this digest and the exact contract counts in sync only after reviewing
 * a regenerated official registry. The compiler refuses an unreviewed digest.
 */
export const SHOPIFYQL_PRIVACY_POLICY_VERSION = "2026-07-direct-identifiers-v1" as const;
export const SHOPIFYQL_PRIVACY_REVIEWED_REGISTRY_SHA256 =
  "54670253f05752b8a1123de2d373d16e42d0003e9aa7b93ac60027859d050bdd" as const;
export const SHOPIFYQL_PRIVACY_REVIEWED_CLASSIFICATION_SHA256 =
  "08efc5b1de5f86319ac99c700a8c10a0feb62d15757e51de4450e9d78e0b8541" as const;

export type ShopifyQLPrivacyCounts = Readonly<{
  staticFields: number;
  allowedStaticFields: number;
  deniedStaticFields: number;
  allowedMetrics: number;
  deniedMetrics: number;
  allowedDimensions: number;
  deniedDimensions: number;
  matchConditionFields: number;
  allowedMatchConditionFields: number;
  deniedMatchConditionFields: number;
  deniedQueryableMetafieldPatterns: number;
}>;

export const SHOPIFYQL_PRIVACY_REVIEWED_COUNTS = Object.freeze({
  staticFields: 2_327,
  allowedStaticFields: 1_668,
  deniedStaticFields: 659,
  allowedMetrics: 349,
  deniedMetrics: 0,
  allowedDimensions: 1_319,
  deniedDimensions: 659,
  matchConditionFields: 211,
  allowedMatchConditionFields: 149,
  deniedMatchConditionFields: 62,
  deniedQueryableMetafieldPatterns: 5,
} satisfies ShopifyQLPrivacyCounts);

export type ShopifyQLPrivacyReason =
  | "aggregate_metric"
  | "documented_non_identifier_dimension"
  | "raw_resource_identifier"
  | "natural_person_or_customer_identifier"
  | "customer_address_or_precise_location"
  | "row_level_linkage_identifier"
  | "individual_customer_behavior"
  | "high_precision_event_time"
  | "unbounded_personal_text"
  | "url_path_or_token"
  | "payment_account_identifier"
  | "merchant_defined_unclassified";

export type ShopifyQLPrivacyDecision = Readonly<{
  disposition: "allowed" | "denied";
  reason: ShopifyQLPrivacyReason;
  explanation: string;
}>;

type ShopifyQLPrivacyField = Readonly<{
  kind: "metric" | "dimension" | "metafield";
  name: string;
  type: string;
}>;

type ShopifyQLPrivacyMatchField = Readonly<{
  name: string;
  type: string;
}>;

/**
 * Non-IDENTITY dimension names whose official definitions were individually
 * reviewed. IDENTITY is handled separately and denied without exceptions.
 */
export const SHOPIFYQL_EXPLICIT_DENIED_DIMENSION_NAMES = Object.freeze({
  natural_person_or_customer_identifier: Object.freeze([
    "assisting_staff_member_name",
    "company_location_name",
    "company_name",
    "customer_email",
    "customer_email_domain",
    "customer_name",
    "staff_member_name",
    "store_credit_source",
  ]),
  customer_address_or_precise_location: Object.freeze([
    "billing_city",
    "billing_company",
    "billing_country",
    "billing_postal_code",
    "billing_region",
    "customer_cities",
    "customer_city",
    "customer_countries",
    "customer_country",
    "customer_region",
    "customer_regions",
    "session_city",
    "session_region",
    "shipping_city",
    "shipping_company",
    "shipping_country",
    "shipping_postal_code",
    "shipping_region",
    "tax_city",
    "tax_country",
    "tax_region",
  ]),
  row_level_linkage_identifier: Object.freeze([
    "discount_line_id",
    "document_uri",
    "order_name",
    "payment_attempt_group",
    "products_bought_together_ids",
    "reference_document_uri",
    "remote_id",
    "return_name",
    "rollout_ids",
    "rollout_treatment_ids",
    "session_id",
    "shipment_name",
    "tracking_number",
    "transaction_number",
    "transfer_name",
    "transfer_reference_name",
  ]),
  individual_customer_behavior: Object.freeze([
    "abandoned_checkout_date",
    "customer_account_status",
    "customer_added_date",
    "customer_amount_spent",
    "customer_email_subscription_status",
    "customer_first_order_date",
    "customer_language",
    "customer_last_order_date",
    "customer_number_of_orders",
    "customer_sms_subscription_status",
    "first_order_date",
    "last_order_date",
  ]),
  high_precision_event_time: Object.freeze([
    "created_at",
    "ended_at",
    "expected_delivery_at",
    "minute",
    "order_processed_at",
    "payment_first_attempted_at",
    "payment_last_attempted_at",
    "scheduled_to_end_at",
    "second",
    "session_timestamp",
    "shipment_received_at",
    "shipment_shipped_at",
    "started_at",
    "store_credit_expires_at",
    "transfer_created_at",
  ]),
  unbounded_personal_text: Object.freeze([
    "customer_tag",
    "customer_tags",
    "marketing_activity_url_parameter_value",
    "order_tag",
    "order_tags",
    "referrer_terms",
    "return_customer_note",
    "return_note",
    "transfer_note",
    "transfer_tags",
  ]),
  url_path_or_token: Object.freeze([
    "click_id_tag",
    "landing_page_path",
    "landing_page_url",
    "manage_url",
    "normalized_page_url",
    "order_landing_page_path",
    "order_landing_page_url",
    "order_referrer_path",
    "order_referrer_url",
    "page_path",
    "page_url",
    "preview_url",
    "referrer_path",
    "referrer_url",
    "sa_token",
    "tracking_url",
  ]),
  payment_account_identifier: Object.freeze([
    "payment_card_bin",
  ]),
} satisfies Readonly<Record<Exclude<
  ShopifyQLPrivacyReason,
  | "aggregate_metric"
  | "documented_non_identifier_dimension"
  | "raw_resource_identifier"
  | "merchant_defined_unclassified"
>, readonly string[]>>);

const DENIED_DIMENSION_REASON_BY_NAME = new Map<string, ShopifyQLPrivacyReason>(
  Object.entries(SHOPIFYQL_EXPLICIT_DENIED_DIMENSION_NAMES).flatMap(([reason, names]) =>
    names.map((name) => [name, reason as ShopifyQLPrivacyReason] as const)
  ),
);

const EXPLANATIONS = Object.freeze({
  aggregate_metric: "Official aggregate metrics remain available for analysis.",
  documented_non_identifier_dimension:
    "The reviewed official dimension is not a direct identifier under this execution policy.",
  raw_resource_identifier:
    "Raw Shopify resource identifiers can link an aggregate result back to a specific resource or person.",
  natural_person_or_customer_identifier:
    "The value can directly name or contact a customer, staff member, or customer company.",
  customer_address_or_precise_location:
    "The value is customer address data or sufficiently precise visitor location data.",
  row_level_linkage_identifier:
    "The value can link a report row to an individual order, session, payment, shipment, return, or other resource.",
  individual_customer_behavior:
    "The value describes one customer's lifecycle or behavior and can create a unique or highly identifying report group.",
  high_precision_event_time:
    "Minute-, second-, or exact-event time can link a report row to an individual customer action or resource.",
  unbounded_personal_text:
    "Free-form merchant or customer text can contain personal data and has no enforceable public type contract.",
  url_path_or_token:
    "URLs, paths, and tracking tokens can embed personal data, secrets, or row-level identifiers.",
  payment_account_identifier:
    "The value is payment-account data that must not be exposed through the conversational report plane.",
  merchant_defined_unclassified:
    "Merchant-defined metafield values are unclassified and can contain direct personal data.",
} satisfies Readonly<Record<ShopifyQLPrivacyReason, string>>);

function decision(disposition: "allowed" | "denied", reason: ShopifyQLPrivacyReason): ShopifyQLPrivacyDecision {
  return Object.freeze({ disposition, reason, explanation: EXPLANATIONS[reason] });
}

/** Classifies a static ShopifyQL field or a queryable metafield before execution. */
export function classifyShopifyQLPrivacyField(field: ShopifyQLPrivacyField): ShopifyQLPrivacyDecision {
  if (field.kind === "metric") return decision("allowed", "aggregate_metric");
  if (field.kind === "metafield") return decision("denied", "merchant_defined_unclassified");
  if (field.type === "IDENTITY") return decision("denied", "raw_resource_identifier");
  const reason = DENIED_DIMENSION_REASON_BY_NAME.get(field.name);
  return reason
    ? decision("denied", reason)
    : decision("allowed", "documented_non_identifier_dimension");
}

/** Classifies a field used inside a documented MATCHES condition. */
export function classifyShopifyQLPrivacyMatchField(
  field: ShopifyQLPrivacyMatchField,
): ShopifyQLPrivacyDecision {
  if (field.type === "IDENTITY") return decision("denied", "raw_resource_identifier");
  if (field.name === "coordinates") {
    return decision("denied", "customer_address_or_precise_location");
  }
  return decision("allowed", "documented_non_identifier_dimension");
}

export function isShopifyQLPrivacyRegistryReviewed(registrySha256: string): boolean {
  return registrySha256 === SHOPIFYQL_PRIVACY_REVIEWED_REGISTRY_SHA256;
}

export type ShopifyQLPrivacyRegistryAudit = Readonly<{
  classificationSha256: string;
  counts: ShopifyQLPrivacyCounts;
  reviewed: boolean;
}>;

/**
 * Recomputes a digest over every official definition and its decision. This is
 * intentionally not cached: even a registry edit that forgets to update its
 * declared source digest must fail closed at the execution boundary.
 */
export function auditShopifyQLPrivacyRegistry(
  registry: ShopifyQLSchemaRegistry,
): ShopifyQLPrivacyRegistryAudit {
  const entries: unknown[] = [];
  let allowedMetrics = 0;
  let deniedMetrics = 0;
  let allowedDimensions = 0;
  let deniedDimensions = 0;
  let allowedMatchConditionFields = 0;
  let deniedMatchConditionFields = 0;
  let deniedQueryableMetafieldPatterns = 0;

  for (const schema of registry.schemas) {
    for (const field of schema.metrics) {
      const privacy = classifyShopifyQLPrivacyField({ kind: "metric", ...field });
      if (privacy.disposition === "allowed") allowedMetrics += 1;
      else deniedMetrics += 1;
      entries.push([
        "static", schema.name, "metric", field.name, field.type, field.description,
        field.formula ?? null, field.isDeprecated, privacy.disposition, privacy.reason,
      ]);
    }
    for (const field of schema.dimensions) {
      const privacy = classifyShopifyQLPrivacyField({ kind: "dimension", ...field });
      if (privacy.disposition === "allowed") allowedDimensions += 1;
      else deniedDimensions += 1;
      entries.push([
        "static", schema.name, "dimension", field.name, field.type, field.description,
        field.formula ?? null, field.isDeprecated, privacy.disposition, privacy.reason,
      ]);
    }
    for (const condition of schema.matchConditions) {
      for (const field of condition.fields) {
        const privacy = classifyShopifyQLPrivacyMatchField(field);
        if (privacy.disposition === "allowed") allowedMatchConditionFields += 1;
        else deniedMatchConditionFields += 1;
        entries.push([
          "match", schema.name, condition.name, field.name, field.role, field.type,
          field.description, privacy.disposition, privacy.reason,
        ]);
      }
    }
    for (const pattern of schema.queryableMetafieldPatterns) {
      const privacy = classifyShopifyQLPrivacyField({
        kind: "metafield",
        name: pattern,
        type: "METAFIELD",
      });
      if (privacy.disposition === "denied") deniedQueryableMetafieldPatterns += 1;
      entries.push([
        "metafield", schema.name, pattern, privacy.disposition, privacy.reason,
      ]);
    }
  }

  const counts: ShopifyQLPrivacyCounts = Object.freeze({
    staticFields: allowedMetrics + deniedMetrics + allowedDimensions + deniedDimensions,
    allowedStaticFields: allowedMetrics + allowedDimensions,
    deniedStaticFields: deniedMetrics + deniedDimensions,
    allowedMetrics,
    deniedMetrics,
    allowedDimensions,
    deniedDimensions,
    matchConditionFields: allowedMatchConditionFields + deniedMatchConditionFields,
    allowedMatchConditionFields,
    deniedMatchConditionFields,
    deniedQueryableMetafieldPatterns,
  });
  const classificationSha256 = createHash("sha256")
    .update(JSON.stringify(entries), "utf8")
    .digest("hex");
  const countsReviewed = Object.entries(SHOPIFYQL_PRIVACY_REVIEWED_COUNTS).every(
    ([name, expected]) => counts[name as keyof typeof counts] === expected,
  );
  return Object.freeze({
    classificationSha256,
    counts,
    reviewed:
      isShopifyQLPrivacyRegistryReviewed(registry.source.registrySha256) &&
      classificationSha256 === SHOPIFYQL_PRIVACY_REVIEWED_CLASSIFICATION_SHA256 &&
      countsReviewed,
  });
}
