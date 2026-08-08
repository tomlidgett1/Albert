import {
  type ConnectorManifest,
} from "../../packages/connector-sdk/src/index.js";
import { LIGHTSPEED_R_DOCUMENTATION_BUILD } from "./documented-fields.js";
import { LIGHTSPEED_FIELD_COVERAGE } from "./field-coverage.js";
import { LIGHTSPEED_STREAMS } from "./streams.js";

/**
 * Match the proven bike-dashboard consent: one `employee:all` grant.
 * Granular scopes + PKCE still hit Lightspeed's merchantos OIDC redirect loop
 * in Safari for this API client; bike-dashboard's confidential-client shape
 * (`employee:all`, no PKCE, JSON token exchange) is the live-working path.
 */
export const LIGHTSPEED_R_DEFAULT_SCOPES = [
  "employee:all",
] as const;

export const lightspeedRManifest: ConnectorManifest = {
  id: "lightspeed-r",
  displayName: "Lightspeed Retail POS (R-Series)",
  packVersion: "2.0.0",
  apiVersion: `R-Series API V3; documentation build ${LIGHTSPEED_R_DOCUMENTATION_BUILD}`,
  releasedAt: "2026-08-03",
  documentation: [
    "https://developers.lightspeedhq.com/retail/authentication/authentication-overview/",
    "https://developers.lightspeedhq.com/retail/authentication/scopes/",
    "https://developers.lightspeedhq.com/retail/introduction/pagination/",
    "https://developers.lightspeedhq.com/retail/introduction/ratelimits/",
    "https://developers.lightspeedhq.com/retail/introduction/relations/",
    "https://developers.lightspeedhq.com/retail/introduction/parameters/",
    "https://www.postman.com/lightspeedhq/r-series-api/documentation/01jc01h/r-series-collection",
    "https://developers.lightspeedhq.com/retail/endpoints/Shop/",
    "https://developers.lightspeedhq.com/retail/endpoints/Employee/",
    "https://developers.lightspeedhq.com/retail/endpoints/Category/",
    "https://developers.lightspeedhq.com/retail/endpoints/Item/",
    "https://developers.lightspeedhq.com/retail/endpoints/ItemShop/",
    "https://developers.lightspeedhq.com/retail/endpoints/Sale/",
    "https://developers.lightspeedhq.com/retail/endpoints/SaleLine/",
    "https://developers.lightspeedhq.com/retail/endpoints/SalePayment/",
    "https://developers.lightspeedhq.com/retail/endpoints/Customer/",
    "https://developers.lightspeedhq.com/retail/endpoints/Vendor/",
    "https://developers.lightspeedhq.com/retail/endpoints/Order/",
    "https://developers.lightspeedhq.com/retail/endpoints/OrderLine/",
    "https://developers.lightspeedhq.com/retail/endpoints/PaymentType/",
    "https://developers.lightspeedhq.com/retail/endpoints/TaxCategory/",
    "https://developers.lightspeedhq.com/retail/endpoints/InventoryLog/",
  ],
  oauth: {
    scopes: LIGHTSPEED_R_DEFAULT_SCOPES,
    leastPrivilegeNotes: [
      "R-Series does not publish read-only variants for employees, shops, categories, vendors, purchase orders, payment types, or tax categories. Albert requests the narrowest documented scopes covering V1 extraction domains and contains no source write methods.",
    ],
    refreshTokenRotation: true,
    remoteRevocation: "supported",
  },
  // The 90 spec-derived stream contracts; see streams.ts for the derivation.
  streams: [...LIGHTSPEED_STREAMS],
  sourceAuthority: {
    defaults: [{
      concepts: ["operational_sales", "stock", "product_master", "customer_master"],
      scope: { kind: "connection_account" },
    }],
  },
  rateLimit: {
    algorithm: "vendor leaky bucket plus one-second burst limiter",
    budgets: {
      baseDripsPerSecond: 1,
      baseBucketSize: 90,
      additionalDripsPerSecondPerRegister: 0.5,
      additionalBucketSizePerRegister: 10,
    },
    responseHeaders: [
      "X-LS-Api-Bucket-Level",
      "X-LS-API-Burst-Level",
      "X-LS-Api-Drip-Rate",
      "X-LS-Api-Request-Cost",
      "Retry-After",
    ],
    reservations: [{
      key: "lightspeed-r.api",
      burstCapacity: 2,
      interval: { kind: "fixed", milliseconds: 1_000 },
    }],
    cooldowns: [{
      kind: "token_bucket_headers",
      levelHeader: "X-LS-Api-Bucket-Level",
      dripRateHeader: "X-LS-Api-Drip-Rate",
      headroom: 2,
    }],
  },
  capabilities: {
    "connector.variant.r_series": {
      support: "full", streams: ["ls_shops"],
      reason: "A successful R-Series Account and Shop extraction verifies the vendor variant.",
    },
    "commerce.orders": {
      support: "full", streams: ["ls_sales"],
      reason: "Sale headers map to canonical commercial orders.",
    },
    "commerce.order_lines": {
      support: "full", streams: ["ls_sale_lines"],
      reason: "SaleLine observations map to canonical order lines.",
    },
    "commerce.order_lines.discounts": {
      support: "full", streams: ["ls_sale_lines"],
      reason: "SaleLine normal price, unit price and discount amount support governed discount measures.",
    },
    "commerce.refunds": {
      support: "full", streams: ["ls_sale_lines"],
      reason: "Negative or refund-linked SaleLine observations map to canonical refund lines.",
    },
    "commerce.payments": {
      support: "full", streams: ["ls_sale_payments"],
      reason: "Loaded SalePayments map to canonical tender events.",
    },
    "commerce.orders.customer": {
      support: "full", streams: ["ls_sales"], coverageFields: ["customerID"],
      reason: "Sale customerID supports governed customer attribution; observed coverage is reported separately.",
    },
    "commerce.order_lines.worker_attribution": {
      support: "full", streams: ["ls_sale_lines"], coverageFields: ["employeeID"],
      reason: "Sale and SaleLine employee identifiers support worker attribution; observed coverage is reported separately.",
    },
    "commerce.order_lines.cost": {
      support: "full", streams: ["ls_sale_lines"], coverageFields: ["avgCost"],
      reason: "The product-cost scope and SaleLine cost fields support governed cost and margin measures.",
    },
    "inventory.balances": {
      support: "full", streams: ["ls_item_shops"],
      reason: "ItemShop quantity on hand maps to canonical inventory balance snapshots.",
    },
    "inventory.cost": {
      support: "partial", streams: ["ls_item_shops"], coverageFields: ["avgCost"], requiresObservedCoverage: true,
      reason: "Inventory valuation is available where ItemShop cost or value fields are populated.",
    },
    "inventory.purchase_orders": {
      support: "full", streams: ["ls_vendors", "ls_purchase_order_lines"],
      reason: "Vendor supplier identities and dependent Order lines jointly provide attributable purchase-order facts.",
    },
    "inventory.movements": {
      support: "partial", streams: ["ls_inventory_logs"],
      reason: "InventoryLog supplies movement observations when enabled for the account.",
    },
    "inventory.stocktakes": {
      support: "partial", streams: ["ls_inventory_logs"], coverageFields: ["inventoryCountID"], requiresObservedCoverage: true, nonZeroCoverage: true,
      reason: "Stocktake variance is available only for InventoryLog records carrying a non-zero inventoryCountID.",
    },
    "source.webhooks": {
      support: "unavailable", streams: [],
      reason: "R-Series does not expose a supported webhook path for these streams.",
    },
  },
  identityRules: [
    "Employee work email exact within tenant, otherwise employee name plus shop is a deterministic suggestion requiring confirmation.",
    "Customer primary email exact within tenant is a deterministic suggestion for Xero contacts and never an automatic merge.",
    "Supplier names may suggest a Xero supplier match but always require human confirmation; source vendor IDs are connector-namespaced.",
    "Item systemSku, UPC, EAN, or customSku may link variants only within this source in v1.",
  ],
  topology: [
    "Sales are authoritative for operational_sales; employeeID supplies worker attribution.",
    "ItemShop is authoritative for current stock by item and shop.",
    "Vendor is authoritative for purchase-order supplier identity and is transformed before dependent Order records.",
    "Negative SaleLine quantities and refund sales are reversal observations, never additional positive sales.",
    "Purchase-order lines are first-class rows carrying projected parent context (vendor, shop, lifecycle, currency); the Order header stream is a lookup-only identity sweep.",
  ],
  // Coverage generated from the same spec as the streams; see field-coverage.ts.
  fieldCoverage: [...LIGHTSPEED_FIELD_COVERAGE],
  qualityAssertions: [
    "cursor_completeness",
    "scope_available",
    "retention_limit_recorded",
    "delete_handling",
    "schema_drift",
    "enum_drift",
    "sale_line_maths_source",
    "sale_payment_reconciles_source",
  ],
  limitations: [
    "The account must be confirmed as R-Series. X-Series (formerly Vend) credentials and endpoints are intentionally rejected.",
    "No R-Series webhook contract is documented; incrementals and nightly reconciliation sweeps remain authoritative.",
    "Shop and PaymentType are ID-sortable but not timestamp-sortable; they are refreshed as complete snapshots rather than unsafe high-watermark incrementals.",
    "InventoryLog is ID-cursored because createTime is not sortable. Endpoint access and retention vary by merchant rights; historical inventory remains Unknown until a live extraction succeeds and Partial thereafter.",
    "The InventoryLog endpoint documents employee:inventory_log while the public OAuth scope allow-list does not. Albert requests only public documented scopes and fails visibly if the authorizing employee rights do not expose the endpoint.",
    "Several required R-Series resources have no documented read-only OAuth scope. The pack exposes no source write operation despite those grants.",
  ],
  unknownFieldPolicy: "quarantine_schema_drift",
};
