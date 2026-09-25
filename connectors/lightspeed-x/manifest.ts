import type { ConnectorManifest } from "../../packages/connector-sdk/src/index.js";
import { LIGHTSPEED_X_FIELD_COVERAGE } from "./field-census.js";
import { LIGHTSPEED_X_CONTRACT_LOCK } from "./spec-lock.js";
import { LIGHTSPEED_X_STREAMS, LIGHTSPEED_X_UNOBSERVABLE_READS } from "./streams.js";

/** Every official read-only X-Series scope used by an enumerable stream. */
export const LIGHTSPEED_X_DEFAULT_SCOPES = Object.freeze([
  "audit:read",
  "billing:partner_subscription:read",
  "business_rules:read",
  "channels:read",
  "consignments:read",
  "customers:read",
  "custom_fields:read",
  "fulfillments:read",
  "gift_cards:read",
  "inventory:read",
  "outlets:read",
  "payments:read",
  "payment_types:read",
  "products:read",
  "products:read:price_books",
  "promotions:read",
  "registers:read",
  "remote_rules:read",
  "retailer:read",
  "sales:read",
  "serial_numbers:read",
  "services:read",
  "store_credits:read",
  "suppliers:read",
  "taxes:read",
  "users:read",
] as const);

export const LIGHTSPEED_X_ALLOWED_SCOPES = LIGHTSPEED_X_DEFAULT_SCOPES;

const fiveMinuteLimits = Object.freeze(
  // Account discovery and the worker admission boundary accept at most 100
  // registers. Keep every value from that validated range admissible here so
  // a large retailer cannot fail locally before the first vendor request.
  Array.from({ length: 100 }, (_, index) => 300 * (index + 1) + 50),
);

export const lightspeedXManifest: ConnectorManifest = {
  id: "lightspeed-x",
  displayName: "Lightspeed Retail POS (X-Series)",
  packVersion: "1.0.0",
  apiVersion: `X-Series API ${LIGHTSPEED_X_CONTRACT_LOCK.apiVersion}; merged contract sha256:${LIGHTSPEED_X_CONTRACT_LOCK.mergedOpenApi.sha256}`,
  releasedAt: "2026-08-12",
  documentation: Object.values(LIGHTSPEED_X_CONTRACT_LOCK.documentation),
  ingestion: { initialStart: "manual" },
  oauth: {
    scopes: LIGHTSPEED_X_DEFAULT_SCOPES,
    leastPrivilegeNotes: [
      "Albert requests every official read-only scope needed for complete analytics once, because widening the scope later requires retailer re-consent.",
      "inventory:write is deliberately absent even though two GET endpoints require it. The webhooks management scope is also absent; polling is authoritative and no connector method writes vendor data.",
      "The source pack implements only GET and the two enumerable read-semantics POST operations (/inventory and /inventory_levels). Calculation/bulk lookup POSTs remain on-demand contract entries and are never scheduled as mutation-like ingestion.",
    ],
    refreshTokenRotation: true,
    remoteRevocation: "not_documented",
  },
  streams: LIGHTSPEED_X_STREAMS,
  sourceAuthority: {
    defaults: [{
      concepts: ["operational_sales", "stock", "product_master", "customer_master"],
      scope: { kind: "connection_account" },
    }],
  },
  rateLimit: {
    algorithm: "durable five-minute window reservation plus Retry-After HTTP-date backoff",
    concurrency: 2,
    budgets: {
      formula: "300 * register_count + 50 requests per retailer/application per 300 seconds",
      defaultRegisterCount: 1,
      defaultLimit: 350,
      headroomRequests: 10,
    },
    responseHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After"],
    reservations: [{
      key: "lightspeed-x.api",
      burstCapacity: 2,
      interval: {
        kind: "window_budget",
        windowMilliseconds: 300_000,
        option: "retailerWindowLimit",
        defaultLimit: 350,
        allowedLimits: fiveMinuteLimits,
        headroomRequests: 10,
      },
    }],
  },
  capabilities: {
    "commerce.orders": { support: "full", streams: ["lx_sales"], reason: "Version-cursored sales project one canonical order per source sale." },
    "commerce.order_lines": { support: "full", streams: ["lx_sales"], reason: "Every nested sale line is projected at its own canonical grain." },
    "commerce.order_lines.discounts": { support: "full", streams: ["lx_sales"], reason: "Line and sale totals preserve documented discount allocations." },
    "commerce.order_lines.worker_attribution": { support: "full", streams: ["lx_sales", "lx_users"], coverageFields: ["user_id", "line_items[].sales_person_id"], reason: "Sale and line salesperson identifiers resolve to X-Series users." },
    "commerce.orders.customer": { support: "full", streams: ["lx_sales", "lx_customers"], coverageFields: ["customer_id"], reason: "Sale customer IDs resolve to canonical customer accounts." },
    "commerce.order_lines.cost": { support: "partial", streams: ["lx_sales", "lx_inventory_levels"], coverageFields: ["line_items[].cost", "average_cost"], requiresObservedCoverage: true, reason: "Cost depends on product-cost visibility and field population." },
    "commerce.payments": { support: "full", streams: ["lx_sales", "lx_payment_types"], reason: "Nested sale payments project independent tender events." },
    "commerce.refunds": { support: "full", streams: ["lx_sales"], reason: "Returns and negative/reversal lines are retained as reversal facts." },
    "inventory.balances": { support: "full", streams: ["lx_inventory"], reason: "Inventory records are point-in-time balance observations by product and outlet." },
    "inventory.cost": { support: "partial", streams: ["lx_inventory", "lx_inventory_levels"], coverageFields: ["average_cost", "total_cost"], requiresObservedCoverage: true, reason: "Average and total cost require the retailer's product cost visibility." },
    "inventory.purchase_orders": { support: "partial", streams: ["lx_consignments", "lx_consignment_products"], reason: "Supplier consignments and their product fan-out retain purchase-order evidence." },
    "inventory.movements": { support: "unavailable", streams: [], reason: "The only stock-adjustment read requires inventory:write, which Albert deliberately does not request." },
    "inventory.stocktakes": { support: "partial", streams: ["lx_consignments", "lx_consignment_products"], reason: "STOCKTAKE consignments preserve counts and variances, but stock-adjustment history remains unavailable without a write-capable grant." },
    "workforce.shifts": { support: "full", streams: ["lx_shifts", "lx_users"], reason: "Version-cursored shifts project start/end intervals against users." },
    "source.webhooks": { support: "unavailable", streams: [], reason: "The combined webhooks management scope is not requested; polling and reconciliation are authoritative." },
  },
  identityRules: [
    "Retailer ID is the immutable connection account identity; domain_prefix selects the vendor host but is never used as the canonical ID.",
    "Outlet IDs, product IDs, customer IDs, supplier IDs and user IDs are connector-namespaced before canonical projection.",
    "Customer email, user work email, product SKU/barcodes, and supplier normalized name are identity suggestions; only source IDs create automatic same-connection references.",
    "All int64 versions and snowflake-like IDs remain decimal strings from HTTP parse through staging and cursor persistence.",
  ],
  topology: [
    "A successful OAuth exchange stores the validated callback domainPrefix. The retailer singleton establishes retailerId, currency and timezone before a user manually starts ingestion.",
    "Version collections advance with response.version.max and terminate only after an empty data page; versions are global and non-contiguous.",
    "Parent-scoped endpoints fan out from durable enumerable parent collections. Emitted normalized records carry _albert.parent.<id>; the immutable vendor payload is never modified.",
    "Sales carry nested lines, payments, taxes and returns in one versioned record; the canonical mapper emits each economic grain exactly once.",
    "Every emitted entity retains payload_json and a typed field_index. Additive/opaque fields become queryable without silently changing physical column contracts.",
  ],
  fieldCoverage: LIGHTSPEED_X_FIELD_COVERAGE,
  qualityAssertions: [
    "official_contract_hash_matches",
    "all_5202_official_fields_accounted_for",
    "version_cursor_advances_or_blocks",
    "version_cursor_terminates_only_on_empty_data",
    "parent_fanout_context_present",
    "int64_round_trip_exact",
    "rotating_refresh_token_serialized_cas",
    "rate_limit_reservation_and_retry_after",
    "canonical_sale_line_and_tender_reconciliation",
    "unknown_runtime_fields_indexed",
  ],
  limitations: [
    ...LIGHTSPEED_X_UNOBSERVABLE_READS.map((entry) => `${entry.operationId} ${entry.endpoint}: ${entry.reason}`),
    "Lightspeed does not provide a permanent public sandbox. Production credentials are never bundled; live verification must use a retailer-controlled demo/trial store.",
    "Channel request logs document no pagination. They are optional snapshots and can never be represented as exhaustive history unless Lightspeed publishes a cursor contract.",
    "API versions are quarterly and end-of-life URLs can fall forward to the oldest supported version. The pinned contract hash check must block silent schema fallback.",
  ],
  unknownFieldPolicy: "quarantine_schema_drift",
};
