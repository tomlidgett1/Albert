import type { ConnectorManifest } from "../../packages/connector-sdk/src/index.js";
import { MOMENCE_FIELD_COVERAGE } from "./field-coverage.js";
import { MOMENCE_OPENAPI_SPEC_LOCK } from "./spec-lock.js";
import { momenceStreamContracts } from "./streams.js";

/** Momence documents a single public API scope; there is no narrower variant. */
export const MOMENCE_DEFAULT_SCOPES = ["public-api-v2"] as const;
export const MOMENCE_ALLOWED_SCOPES = MOMENCE_DEFAULT_SCOPES;

export const momenceManifest: ConnectorManifest = {
  id: "momence",
  displayName: "Momence",
  packVersion: "1.0.0",
  apiVersion: `Momence public API v${MOMENCE_OPENAPI_SPEC_LOCK.apiVersion}; OpenAPI ${MOMENCE_OPENAPI_SPEC_LOCK.sourceSha256.slice(0, 12)}`,
  releasedAt: "2026-08-12",
  documentation: [
    "https://api.docs.momence.com/",
    "https://api.docs.momence.com/llms.txt",
    "https://api.docs.momence.com/docs/get-started",
    "https://api.docs.momence.com/docs/getting-started",
    "https://api.docs.momence.com/docs/authorization",
    "https://api.docs.momence.com/docs/terminology",
    "https://api.docs.momence.com/reference/outoging-webhooks",
    "https://api.docs.momence.com/reference/webhooks-reference",
    MOMENCE_OPENAPI_SPEC_LOCK.sourceUrl,
  ],
  // OAuth establishes authorization only. The dedicated, audited activation
  // RPC is the sole first-ingestion boundary for a connection generation.
  ingestion: { initialStart: "manual" },
  oauth: {
    scopes: MOMENCE_DEFAULT_SCOPES,
    leastPrivilegeNotes: [
      "Momence publishes one public-api-v2 OAuth scope rather than resource-specific read scopes. Albert requests that scope but implements no host/member write, checkout, cancellation, check-in, tag, freeze, signature or payment-method operation.",
      "Only the authorization-code and refresh-token grants are implemented. The documented password grant is forbidden because Albert never handles a staff member's Momence password.",
    ],
    refreshTokenRotation: true,
    remoteRevocation: "not_documented",
  },
  streams: momenceStreamContracts(),
  sourceAuthority: {
    defaults: [{
      concepts: ["customer_master", "product_master", "operational_sales", "cash_settlement"],
      scope: { kind: "connection_account" },
    }],
  },
  rateLimit: {
    algorithm: "conservative shared GCRA plus Retry-After and bounded full-jitter retry",
    concurrency: 1,
    budgets: {
      documentedGeneralLimit: "not_published",
      reportCreatesPerDay: 100,
      reportRetrievalsPerDay: 1_000,
      defaultRequestsPerSecond: 2,
    },
    responseHeaders: ["Retry-After", "X-Request-Id"],
    reservations: [{
      key: "momence.api",
      burstCapacity: 1,
      interval: { kind: "fixed", milliseconds: 500 },
    }],
  },
  capabilities: {
    "commerce.orders": {
      support: "partial", streams: ["momence_sales"],
      reason: "Host sales exposes orders when Momence support enables the experimental endpoint.",
    },
    "commerce.order_lines": {
      support: "partial", streams: ["momence_sales"],
      reason: "HostSale items retain the exact purchased item, quantity, unit price, tax and discount fields.",
    },
    "commerce.order_lines.discounts": {
      support: "partial", streams: ["momence_sales"], coverageFields: ["$.items[].discountCode.unitDiscountExcludingTaxInCurrency"],
      requiresObservedCoverage: true,
      reason: "Discount values are available where a sale item carries a discountCode object.",
    },
    "commerce.orders.customer": {
      support: "partial", streams: ["momence_sales"], coverageFields: ["$.items[].targetMember.id"],
      requiresObservedCoverage: true,
      reason: "Sales identify paying and target members where the host records them.",
    },
    "commerce.payments": {
      support: "partial", streams: ["momence_payment_transactions"],
      reason: "Payment transaction detail is complete for discovered transaction ids; Momence publishes no global transaction list.",
    },
    "commerce.refunds": {
      support: "partial", streams: ["momence_payment_transactions"], coverageFields: ["$.refunds[].id"],
      requiresObservedCoverage: true,
      reason: "Refund objects are retained exactly when returned by payment-transaction detail.",
    },
    "source.webhooks": {
      support: "unavailable", streams: [],
      reason: "Momence webhooks are experimental, support-enabled and dashboard-configured; polling and reconciliation are the production completeness authority.",
    },
  },
  identityRules: [
    "Member id is the source-owned customer identity. Email and normalized phone are corroborating identity hints only and never automatic cross-source merges.",
    "Teacher id is a source-owned worker identity. A teacher embedded in a session or appointment is not assumed to be an employee or a paid shift.",
    "Location id is source-owned. Names and addresses may suggest a reviewed cross-source location match but never create one automatically.",
    "Public API v2 AuthProfileDto exposes userId but no selected host id. The connection is therefore namespaced to the documented authorising user identity; Albert never guesses host identity from an unrelated record.",
  ],
  topology: [
    "Members are the parent population for active bought memberships, member bookings, member appointments and notes because Momence publishes no global bought-membership list.",
    "Sessions are the parent population for detail and booking fan-out. Session occurrence, booking, attendance and commercial sale remain separate grains.",
    "Sales are optional because the endpoint is experimental. Payment transaction detail fans out from transaction ids referenced by member notes; Momence exposes no transaction list and HostSaleDto does not contain the transaction id.",
    "Every entity keeps its exact raw object and a typed long-form scalar index. Curated fields accelerate common questions; the source explorer makes every documented nested scalar answerable.",
    "No general updated-since predicate exists. Fixed operational windows reduce routine cost and progressive backfill expands history; absence from a bounded window or note-discovered payment population is never treated as deletion evidence.",
  ],
  fieldCoverage: MOMENCE_FIELD_COVERAGE,
  qualityAssertions: [
    "openapi_spec_hash_locked",
    "all_74_operations_dispositioned",
    "all_2225_operation_leaf_occurrences_dispositioned",
    "every_store_read_leaf_queryable",
    "page_zero_pagination_complete",
    "pagination_total_count_reconciles",
    "pagination_identity_advances",
    "bounded_population_absence_never_deletes",
    "fanout_parent_population_complete",
    "fanout_parent_pages_reused_within_traversal",
    "refresh_token_rotation_committed_under_lease",
    "optional_endpoint_unavailability_fail_visible",
    "schema_drift_quarantined_with_raw_retained",
    "manual_generation_activation_required",
    "currency_not_mixed",
    "booking_attendance_sale_grains_not_mixed",
  ],
  limitations: [
    "Momence documents no sandbox, test API host or developer test account. The official schema names only https://api.momence.com, so automated acceptance uses schema-derived mocks until an explicitly authorised disposable host is connected.",
    "No general rate limit is published. Albert begins at two request starts per second, permits one in-process active request per connection, honours Retry-After, and shares a burst-one durable start budget across worker replicas.",
    "Host sales and webhooks are experimental and require Momence support. Their absence is reported as unavailable coverage rather than zero activity.",
    "Report creation is limited to 100/day and retrieval to 1,000/day; public API v2 does not expose the selected hostId or a report-run list, so automatic report generation is intentionally outside this ingestion graph.",
    "The API exposes no global bought-membership list, payment-transaction list, host teacher list or unambiguous host location list. Governed fan-out and public storefront fallbacks are used where safe.",
    "Report details objects are untyped in the official schema. If report ingestion is later enabled, those objects must remain raw/indexed until Momence publishes a contract.",
    "Money fields use inconsistent units and types across endpoints. Raw values are preserved; curated measures only combine fields whose unit and currency semantics are explicit.",
    "Time-filtered reconciliation totals describe only the requested operational window. Absence from that bounded scan is never treated as evidence that an older Momence identity was deleted.",
    "Payment-transaction reconciliation covers only transaction ids currently discoverable through member notes. A missing note reference is never treated as evidence that the underlying transaction was deleted.",
  ],
  unknownFieldPolicy: "quarantine_schema_drift",
};
