import { SQUARE_CONTRACT_LOCK } from "./spec-lock.js";
import type { SourceAuthorityConcept } from "../../packages/canonical-schema/src/types.js";
import type { ConnectorEmittedTarget } from "../../packages/connector-sdk/src/contract.js";

export type SquareProductDomain =
  | "sales"
  | "inventory"
  | "customers"
  | "products"
  | "accounting"
  | "workforce";

/** Read-only seller OAuth permissions used by the selected 2026-07-15 endpoints. */
export type SquareReadScope =
  | "APPOINTMENTS_ALL_READ"
  | "APPOINTMENTS_BUSINESS_SETTINGS_READ"
  | "APPOINTMENTS_READ"
  | "BANK_ACCOUNTS_READ"
  | "CASH_DRAWER_READ"
  | "CUSTOMERS_READ"
  | "DEVICES_READ"
  | "DISPUTES_READ"
  | "EMPLOYEES_READ"
  | "GIFTCARDS_READ"
  | "INVENTORY_READ"
  | "INVOICES_READ"
  | "ITEMS_READ"
  | "LOYALTY_READ"
  | "MERCHANT_PROFILE_READ"
  | "ONLINE_STORE_SITE_READ"
  | "ONLINE_STORE_SNIPPETS_READ"
  | "ORDERS_READ"
  | "PAYMENTS_READ"
  | "PAYMENT_METHODS_READ"
  | "PAYOUTS_READ"
  | "SUBSCRIPTIONS_READ"
  | "TIMECARDS_READ"
  | "TIMECARDS_SETTINGS_READ"
  | "VENDOR_READ";

export type SquareJson =
  | null
  | boolean
  | number
  | string
  | readonly SquareJson[]
  | { readonly [key: string]: SquareJson };

export type SquareReadStream = Readonly<{
  id: string;
  label: string;
  /** Square wire entity represented by each emitted record. */
  resource: string;
  /** Official SDK serialization type used as the field-census root. */
  rootEntity: string;
  endpoint: string;
  method: "GET" | "POST";
  responsePath: string;
  /** One path, a composite key, or first-present alternatives (see identityMode). */
  recordIdPath: string | readonly string[];
  identityMode: "field" | "composite" | "first_present" | "singleton";
  modifiedPath: string | null;
  cursorLocation: "query" | "body" | "none";
  pagination: Readonly<{
    kind: "cursor" | "none";
    requestPath: string | null;
    responsePath: string | null;
    pageSizePath: string | null;
    defaultPageSize: number | null;
    maxPageSize: number | null;
    cursorTtlSeconds: number | null;
    durableWatermark: false;
  }>;
  scope: readonly SquareReadScope[];
  availability: Readonly<{
    release: "ga" | "beta" | "early_access";
    sellerOAuth: "documented" | "undocumented";
    notes: string | null;
  }>;
  dependencies: readonly string[];
  productDomains: readonly SquareProductDomain[];
  canonicalTargets: readonly ConnectorEmittedTarget[];
  authorityConcept: SourceAuthorityConcept | null;
  priority: 1 | 2 | 3 | 4 | 5;
  backfill: Readonly<{
    mode: "snapshot" | "full_scan" | "time_windowed" | "parent_fan_out";
    timeField: string | null;
    beginRequestPath: string | null;
    endRequestPath: string | null;
    boundary: "inclusive" | "exclusive" | "mixed" | "not_applicable";
    defaultWindowDays: number | null;
    limitation: string | null;
  }>;
  lateEdit: Readonly<{
    strategy: "updated_at_overlap" | "webhook_plus_reconcile" | "full_reconcile" | "immutable";
    overlapSeconds: number;
    notes: string | null;
  }>;
  deletion: Readonly<{
    strategy:
      | "soft_delete_field"
      | "webhook_tombstone_and_reconcile"
      | "authoritative_snapshot"
      | "immutable"
      | "not_exposed";
    tombstonePath: string | null;
    webhook: string | null;
  }>;
  sourceTotal: Readonly<{
    strategy: "response_count" | "completed_traversal_count" | "parent_reconciliation" | "not_available";
    path: string | null;
  }>;
  transport: Readonly<{
    pathParameters: readonly string[];
    locationMode: "none" | "query_one" | "body_one" | "body_many_max_10" | "path_one";
    locationRequestPath: string | null;
    fixedQuery: Readonly<Record<string, SquareJson>>;
    fixedBody: Readonly<Record<string, SquareJson>>;
  }>;
  documentation: string;
}>;

const cursor = (
  _location: "query" | "body",
  maximum: number,
  defaultSize: number = maximum,
  requestPath = "cursor",
  pageSizePath = "limit",
): SquareReadStream["pagination"] => Object.freeze({
  kind: "cursor",
  requestPath,
  responsePath: "cursor",
  pageSizePath,
  defaultPageSize: defaultSize,
  maxPageSize: maximum,
  cursorTtlSeconds: SQUARE_CONTRACT_LOCK.invariants.cursorTtlSeconds,
  durableWatermark: false,
});

/** Some Square cursor endpoints publish no page-size parameter. Keeping that
 * absence explicit prevents a generic `limit` from being silently ignored. */
const cursorWithoutPageSize = (
  _location: "query" | "body",
  requestPath = "cursor",
): SquareReadStream["pagination"] => Object.freeze({
  kind: "cursor",
  requestPath,
  responsePath: "cursor",
  pageSizePath: null,
  defaultPageSize: null,
  maxPageSize: null,
  cursorTtlSeconds: SQUARE_CONTRACT_LOCK.invariants.cursorTtlSeconds,
  durableWatermark: false,
});

const unpaged: SquareReadStream["pagination"] = Object.freeze({
  kind: "none",
  requestPath: null,
  responsePath: null,
  pageSizePath: null,
  defaultPageSize: null,
  maxPageSize: null,
  cursorTtlSeconds: null,
  durableWatermark: false,
});

const ga = (notes: string | null = null): SquareReadStream["availability"] =>
  Object.freeze({ release: "ga", sellerOAuth: "documented", notes });
const beta = (notes: string | null = null): SquareReadStream["availability"] =>
  Object.freeze({ release: "beta", sellerOAuth: "documented", notes });
const earlyAccess = (notes: string | null = null): SquareReadStream["availability"] =>
  Object.freeze({ release: "early_access", sellerOAuth: "documented", notes });

const snapshot = (limitation: string | null = null): SquareReadStream["backfill"] =>
  Object.freeze({
    mode: "snapshot",
    timeField: null,
    beginRequestPath: null,
    endRequestPath: null,
    boundary: "not_applicable",
    defaultWindowDays: null,
    limitation,
  });
const fullScan = (limitation: string | null = null): SquareReadStream["backfill"] =>
  Object.freeze({ ...snapshot(limitation), mode: "full_scan" });
const parentFanOut = (limitation: string | null = null): SquareReadStream["backfill"] =>
  Object.freeze({ ...snapshot(limitation), mode: "parent_fan_out" });
const timeWindow = (
  timeField: string,
  beginRequestPath: string,
  endRequestPath: string | null,
  boundary: SquareReadStream["backfill"]["boundary"],
  defaultWindowDays: number,
  limitation: string | null = null,
): SquareReadStream["backfill"] => Object.freeze({
  mode: "time_windowed",
  timeField,
  beginRequestPath,
  endRequestPath,
  boundary,
  defaultWindowDays,
  limitation,
});

const updatedOverlap = (
  overlapSeconds = 72 * 60 * 60,
  notes: string | null = null,
): SquareReadStream["lateEdit"] => Object.freeze({
  strategy: "updated_at_overlap",
  overlapSeconds,
  notes,
});
const reconcile = (notes: string | null = null): SquareReadStream["lateEdit"] =>
  Object.freeze({ strategy: "webhook_plus_reconcile", overlapSeconds: 0, notes });
const fullReconcile = (notes: string | null = null): SquareReadStream["lateEdit"] =>
  Object.freeze({ strategy: "full_reconcile", overlapSeconds: 0, notes });
const immutable = (notes: string | null = null): SquareReadStream["lateEdit"] =>
  Object.freeze({ strategy: "immutable", overlapSeconds: 0, notes });

const snapshotDelete: SquareReadStream["deletion"] = Object.freeze({
  strategy: "authoritative_snapshot",
  tombstonePath: null,
  webhook: null,
});
const noDelete: SquareReadStream["deletion"] = Object.freeze({
  strategy: "not_exposed",
  tombstonePath: null,
  webhook: null,
});
const immutableDelete: SquareReadStream["deletion"] = Object.freeze({
  strategy: "immutable",
  tombstonePath: null,
  webhook: null,
});
const tombstone = (webhook: string | null): SquareReadStream["deletion"] => Object.freeze({
  strategy: "webhook_tombstone_and_reconcile",
  tombstonePath: null,
  webhook,
});

const traversalTotal: SquareReadStream["sourceTotal"] = Object.freeze({
  strategy: "completed_traversal_count",
  path: null,
});
const noTotal: SquareReadStream["sourceTotal"] = Object.freeze({
  strategy: "not_available",
  path: null,
});
const parentTotal: SquareReadStream["sourceTotal"] = Object.freeze({
  strategy: "parent_reconciliation",
  path: null,
});

type StreamInput = Omit<
  SquareReadStream,
  "pagination" | "availability" | "backfill" | "lateEdit" | "deletion" | "sourceTotal" | "transport"
> & Partial<Pick<
  SquareReadStream,
  "pagination" | "availability" | "backfill" | "lateEdit" | "deletion" | "sourceTotal" | "transport"
>>;

function defineStream(input: StreamInput): SquareReadStream {
  const pagination = input.pagination ?? unpaged;
  return Object.freeze({
    ...input,
    pagination,
    availability: input.availability ?? ga(),
    backfill: input.backfill ?? fullScan(),
    lateEdit: input.lateEdit ?? fullReconcile(),
    deletion: input.deletion ?? snapshotDelete,
    sourceTotal: input.sourceTotal ?? (pagination.kind === "cursor" ? traversalTotal : noTotal),
    transport: input.transport ?? Object.freeze({
      pathParameters: Object.freeze([]),
      locationMode: "none",
      locationRequestPath: null,
      fixedQuery: Object.freeze({}),
      fixedBody: Object.freeze({}),
    }),
  });
}

const transport = (
  pathParameters: readonly string[] = [],
  locationMode: SquareReadStream["transport"]["locationMode"] = "none",
  locationRequestPath: string | null = null,
  fixedQuery: Readonly<Record<string, SquareJson>> = {},
  fixedBody: Readonly<Record<string, SquareJson>> = {},
): SquareReadStream["transport"] => Object.freeze({
  pathParameters: Object.freeze([...pathParameters]),
  locationMode,
  locationRequestPath,
  fixedQuery: Object.freeze({ ...fixedQuery }),
  fixedBody: Object.freeze({ ...fixedBody }),
});

const docs = (path: string): string => `https://developer.squareup.com/reference/square/${path}`;

/**
 * Seller-data reads supported by the pinned Square API/SDK contract.
 *
 * Cursors are deliberately described as five-minute traversal tokens, never
 * sync watermarks. Streams without an updated-time predicate declare the more
 * expensive webhook-plus-authoritative-reconciliation strategy explicitly.
 */
export const SQUARE_READ_STREAMS: readonly SquareReadStream[] = Object.freeze([
  defineStream({
    id: "square_merchants", label: "Merchants", resource: "Merchant", rootEntity: "Merchant",
    endpoint: "/v2/merchants", method: "GET", responsePath: "merchants",
    recordIdPath: "id", identityMode: "field", modifiedPath: null, cursorLocation: "none",
    scope: ["MERCHANT_PROFILE_READ"], dependencies: [], productDomains: ["sales"],
    canonicalTargets: ["legal_entity"], authorityConcept: "operational_sales", priority: 1,
    backfill: snapshot(), deletion: snapshotDelete,
    documentation: docs("merchants-api/list-merchants"),
  }),
  defineStream({
    id: "square_locations", label: "Locations", resource: "Location", rootEntity: "Location",
    endpoint: "/v2/locations", method: "GET", responsePath: "locations",
    recordIdPath: "id", identityMode: "field", modifiedPath: null, cursorLocation: "none",
    scope: ["MERCHANT_PROFILE_READ"], dependencies: ["square_merchants"], productDomains: ["sales", "inventory"],
    canonicalTargets: ["location", "stock_location"], authorityConcept: "operational_sales", priority: 1,
    backfill: snapshot("ListLocations includes inactive locations."), deletion: snapshotDelete,
    documentation: docs("locations-api/list-locations"),
  }),
  defineStream({
    id: "square_merchant_custom_attribute_definitions", label: "Merchant custom attribute definitions",
    resource: "CustomAttributeDefinition", rootEntity: "CustomAttributeDefinition",
    endpoint: "/v2/merchants/custom-attribute-definitions", method: "GET",
    responsePath: "custom_attribute_definitions", recordIdPath: "key", identityMode: "field",
    modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100, 20),
    scope: ["MERCHANT_PROFILE_READ"], dependencies: ["square_merchants"], productDomains: ["sales"],
    canonicalTargets: ["metadata"], authorityConcept: "operational_sales", priority: 4,
    availability: beta(), lateEdit: reconcile(), deletion: tombstone("merchant.custom_attribute_definition.owned.deleted"),
    documentation: docs("merchant-custom-attributes-api/list-merchant-custom-attribute-definitions"),
  }),
  defineStream({
    id: "square_merchant_custom_attributes", label: "Merchant custom attributes",
    resource: "CustomAttribute", rootEntity: "CustomAttribute",
    endpoint: "/v2/merchants/{merchant_id}/custom-attributes", method: "GET",
    responsePath: "custom_attributes", recordIdPath: "key", identityMode: "field",
    modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100, 20),
    scope: ["MERCHANT_PROFILE_READ"], dependencies: ["square_merchants", "square_merchant_custom_attribute_definitions"],
    productDomains: ["sales"], canonicalTargets: ["metadata"],
    authorityConcept: "operational_sales", priority: 4, backfill: parentFanOut(), lateEdit: reconcile(),
    deletion: tombstone("merchant.custom_attribute.owned.deleted"), sourceTotal: parentTotal,
    transport: transport(["merchant_id"], "none", null, { with_definitions: true, visibility_filter: "ALL" }),
    documentation: docs("merchant-custom-attributes-api/list-merchant-custom-attributes"),
  }),
  defineStream({
    id: "square_location_custom_attribute_definitions", label: "Location custom attribute definitions",
    resource: "CustomAttributeDefinition", rootEntity: "CustomAttributeDefinition",
    endpoint: "/v2/locations/custom-attribute-definitions", method: "GET",
    responsePath: "custom_attribute_definitions", recordIdPath: "key", identityMode: "field",
    modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100, 20),
    scope: ["MERCHANT_PROFILE_READ"], dependencies: ["square_locations"], productDomains: ["sales", "inventory"],
    canonicalTargets: ["metadata"], authorityConcept: "operational_sales", priority: 4,
    availability: beta(), lateEdit: reconcile(), deletion: tombstone("location.custom_attribute_definition.owned.deleted"),
    documentation: docs("location-custom-attributes-api/list-location-custom-attribute-definitions"),
  }),
  defineStream({
    id: "square_location_custom_attributes", label: "Location custom attributes",
    resource: "CustomAttribute", rootEntity: "CustomAttribute",
    endpoint: "/v2/locations/{location_id}/custom-attributes", method: "GET",
    responsePath: "custom_attributes", recordIdPath: "key", identityMode: "field",
    modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100, 20),
    scope: ["MERCHANT_PROFILE_READ"], dependencies: ["square_locations", "square_location_custom_attribute_definitions"],
    productDomains: ["sales", "inventory"], canonicalTargets: ["metadata"],
    authorityConcept: "operational_sales", priority: 4, backfill: parentFanOut(), lateEdit: reconcile(),
    deletion: tombstone("location.custom_attribute.owned.deleted"), sourceTotal: parentTotal,
    transport: transport(["location_id"], "path_one", null, { with_definitions: true, visibility_filter: "ALL" }),
    documentation: docs("location-custom-attributes-api/list-location-custom-attributes"),
  }),

  defineStream({
    id: "square_orders", label: "Orders", resource: "Order", rootEntity: "Order",
    endpoint: "/v2/orders/search", method: "POST", responsePath: "orders",
    recordIdPath: "id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body",
    pagination: cursor("body", 1000, 500), scope: ["ORDERS_READ"], dependencies: ["square_locations"],
    productDomains: ["sales", "inventory"],
    canonicalTargets: ["channel", "commerce_order", "commerce_order_line"],
    authorityConcept: "operational_sales", priority: 1,
    backfill: timeWindow("updated_at", "query.filter.date_time_filter.updated_at.start_at", "query.filter.date_time_filter.updated_at.end_at", "inclusive", 31),
    lateEdit: updatedOverlap(72 * 60 * 60, "Offline POS orders can arrive up to 72 hours after their original created_at."),
    deletion: tombstone(null),
    transport: transport([], "body_many_max_10", "location_ids", {}, {
      return_entries: false,
      query: { sort: { sort_field: "UPDATED_AT", sort_order: "ASC" } },
    }),
    documentation: docs("orders-api/search-orders"),
  }),
  defineStream({
    id: "square_order_custom_attribute_definitions", label: "Order custom attribute definitions",
    resource: "CustomAttributeDefinition", rootEntity: "CustomAttributeDefinition",
    endpoint: "/v2/orders/custom-attribute-definitions", method: "GET",
    responsePath: "custom_attribute_definitions", recordIdPath: "key", identityMode: "field",
    modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100, 20),
    scope: ["ORDERS_READ"], dependencies: ["square_orders"], productDomains: ["sales"],
    canonicalTargets: ["metadata"], authorityConcept: "operational_sales", priority: 4,
    availability: beta(), lateEdit: reconcile(), deletion: tombstone("order.custom_attribute_definition.owned.deleted"),
    documentation: docs("order-custom-attributes-api/list-order-custom-attribute-definitions"),
  }),
  defineStream({
    id: "square_order_custom_attributes", label: "Order custom attributes",
    resource: "CustomAttribute", rootEntity: "CustomAttribute",
    endpoint: "/v2/orders/{order_id}/custom-attributes", method: "GET",
    responsePath: "custom_attributes", recordIdPath: "key", identityMode: "field",
    modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100, 20),
    scope: ["ORDERS_READ"], dependencies: ["square_orders", "square_order_custom_attribute_definitions"],
    productDomains: ["sales"], canonicalTargets: ["metadata"],
    authorityConcept: "operational_sales", priority: 4, backfill: parentFanOut(), lateEdit: reconcile(),
    deletion: tombstone("order.custom_attribute.owned.deleted"), sourceTotal: parentTotal,
    transport: transport(["order_id"], "none", null, { with_definitions: true, visibility_filter: "ALL" }),
    documentation: docs("order-custom-attributes-api/list-order-custom-attributes"),
  }),
  defineStream({
    id: "square_payments", label: "Payments", resource: "Payment", rootEntity: "Payment",
    endpoint: "/v2/payments", method: "GET", responsePath: "payments", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query",
    pagination: cursor("query", 100), scope: ["PAYMENTS_READ"], dependencies: ["square_locations"],
    productDomains: ["sales"], canonicalTargets: ["commerce_payment", "commerce_payment_fee"],
    authorityConcept: "cash_settlement", priority: 1,
    backfill: timeWindow("created_at", "begin_time", "end_time", "mixed", 31, "The endpoint defaults to only one year; Albert always sends explicit bounds."),
    lateEdit: updatedOverlap(24 * 60 * 60, "ListPayments is eventually consistent; incremental reads sort and filter by UPDATED_AT."),
    deletion: noDelete,
    transport: transport([], "query_one", "location_id", { sort_field: "UPDATED_AT", sort_order: "ASC" }),
    documentation: docs("payments-api/list-payments"),
  }),
  defineStream({
    id: "square_refunds", label: "Payment refunds", resource: "PaymentRefund", rootEntity: "PaymentRefund",
    endpoint: "/v2/refunds", method: "GET", responsePath: "refunds", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query",
    pagination: cursor("query", 100), scope: ["PAYMENTS_READ"], dependencies: ["square_payments", "square_orders"],
    productDomains: ["sales", "accounting"], canonicalTargets: ["commerce_refund", "metadata"],
    authorityConcept: "cash_settlement", priority: 1,
    backfill: timeWindow("created_at", "begin_time", "end_time", "mixed", 31, "The endpoint defaults to only one year; Albert always sends explicit bounds."),
    lateEdit: updatedOverlap(24 * 60 * 60, "ListPaymentRefunds is eventually consistent; incremental reads use UPDATED_AT."),
    deletion: noDelete,
    transport: transport([], "none", null, { sort_field: "UPDATED_AT", sort_order: "ASC" }),
    documentation: docs("refunds-api/list-payment-refunds"),
  }),
  defineStream({
    id: "square_payment_links", label: "Checkout payment links", resource: "PaymentLink", rootEntity: "PaymentLink",
    endpoint: "/v2/online-checkout/payment-links", method: "GET", responsePath: "payment_links",
    recordIdPath: "id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query",
    pagination: cursor("query", 1000, 100), scope: ["ORDERS_READ"], dependencies: ["square_orders"],
    productDomains: ["sales"], canonicalTargets: ["metadata"], authorityConcept: "operational_sales",
    priority: 4, lateEdit: fullReconcile(), deletion: snapshotDelete,
    documentation: docs("checkout-api/list-payment-links"),
  }),
  defineStream({
    id: "square_checkout_merchant_settings", label: "Checkout merchant settings",
    resource: "CheckoutMerchantSettings", rootEntity: "CheckoutMerchantSettings",
    endpoint: "/v2/online-checkout/merchant-settings", method: "GET", responsePath: "merchant_settings",
    recordIdPath: "merchant_id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "none",
    scope: ["PAYMENT_METHODS_READ", "MERCHANT_PROFILE_READ"], dependencies: ["square_merchants"],
    productDomains: ["sales"], canonicalTargets: ["metadata"], authorityConcept: null,
    priority: 5, availability: beta("Square Sandbox does not support checkout settings."), backfill: snapshot(), deletion: noDelete,
    documentation: docs("checkout-api/retrieve-merchant-settings"),
  }),
  defineStream({
    id: "square_checkout_location_settings", label: "Checkout location settings",
    resource: "CheckoutLocationSettings", rootEntity: "CheckoutLocationSettings",
    endpoint: "/v2/online-checkout/location-settings/{location_id}", method: "GET", responsePath: "location_settings",
    recordIdPath: "location_id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "none",
    scope: ["PAYMENT_METHODS_READ", "MERCHANT_PROFILE_READ"], dependencies: ["square_locations"],
    productDomains: ["sales"], canonicalTargets: ["metadata"], authorityConcept: null,
    priority: 5, availability: beta("Square Sandbox does not support checkout settings."),
    backfill: parentFanOut(), deletion: noDelete, sourceTotal: parentTotal,
    transport: transport(["location_id"], "path_one"),
    documentation: docs("checkout-api/retrieve-location-settings"),
  }),

  defineStream({
    id: "square_catalog_objects", label: "Catalog objects", resource: "CatalogObject", rootEntity: "CatalogObject",
    endpoint: "/v2/catalog/search", method: "POST", responsePath: "objects", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body", pagination: cursor("body", 1000),
    scope: ["ITEMS_READ"], dependencies: ["square_locations"], productDomains: ["products", "inventory"],
    canonicalTargets: ["product", "product_variant", "product_category", "tax_code", "category_assignment"],
    authorityConcept: "product_master", priority: 1,
    backfill: timeWindow("updated_at", "begin_time", null, "exclusive", 31, "SearchCatalogObjects exposes an exclusive begin_time but no upper-bound filter; Albert fixes the traversal start, tolerates post-boundary duplicates, and advances only after the cursor is exhausted."),
    lateEdit: updatedOverlap(60, "catalog.version.updated is an accelerator; polling remains authoritative."),
    deletion: Object.freeze({ strategy: "soft_delete_field", tombstonePath: "is_deleted", webhook: "catalog.version.updated" }),
    transport: transport([], "none", null, {}, {
      include_deleted_objects: true,
      include_related_objects: false,
      object_types: [
        "ITEM", "IMAGE", "CATEGORY", "ITEM_VARIATION", "TAX", "DISCOUNT", "MODIFIER_LIST", "MODIFIER",
        "PRICING_RULE", "PRODUCT_SET", "TIME_PERIOD", "MEASUREMENT_UNIT", "SUBSCRIPTION_PLAN_VARIATION",
        "ITEM_OPTION", "ITEM_OPTION_VAL", "CUSTOM_ATTRIBUTE_DEFINITION", "QUICK_AMOUNTS_SETTINGS",
        "SUBSCRIPTION_PLAN", "AVAILABILITY_PERIOD",
      ],
    }),
    documentation: docs("catalog-api/search-catalog-objects"),
  }),
  defineStream({
    id: "square_inventory_counts", label: "Inventory counts", resource: "InventoryCount", rootEntity: "InventoryCount",
    endpoint: "/v2/inventory/counts/batch-retrieve", method: "POST", responsePath: "counts",
    recordIdPath: ["catalog_object_id", "location_id", "state"], identityMode: "composite",
    modifiedPath: "calculated_at", cursorLocation: "body", pagination: cursor("body", 1000),
    scope: ["INVENTORY_READ"], dependencies: ["square_catalog_objects", "square_locations"],
    productDomains: ["inventory"], canonicalTargets: ["inventory_balance_snapshot"], authorityConcept: "stock",
    priority: 1, backfill: snapshot("This endpoint returns current calculated counts, not historical snapshots."),
    lateEdit: updatedOverlap(60 * 60, "updated_after filters the calculated_at update watermark."),
    deletion: snapshotDelete, transport: transport([], "none", null, {}, {}),
    documentation: docs("inventory-api/batch-retrieve-inventory-counts"),
  }),
  defineStream({
    id: "square_inventory_changes", label: "Inventory changes", resource: "InventoryChange", rootEntity: "InventoryChange",
    endpoint: "/v2/inventory/changes/batch-retrieve", method: "POST", responsePath: "changes",
    recordIdPath: ["physical_count.id", "adjustment.id"], identityMode: "first_present",
    modifiedPath: "calculated_at", cursorLocation: "body", pagination: cursor("body", 1000),
    scope: ["INVENTORY_READ"], dependencies: ["square_catalog_objects", "square_locations"],
    productDomains: ["inventory"], canonicalTargets: ["inventory_movement"], authorityConcept: "stock",
    priority: 2,
    backfill: timeWindow("calculated_at", "updated_after", "updated_before", "mixed", 31, "The changes endpoint cannot select TRANSFER records; transfer orders are a separate stream."),
    lateEdit: updatedOverlap(60 * 60), deletion: immutableDelete,
    transport: transport([], "none", null, {}, { types: ["PHYSICAL_COUNT", "ADJUSTMENT"] }),
    documentation: docs("inventory-api/batch-retrieve-inventory-changes"),
  }),
  defineStream({
    id: "square_inventory_adjustment_reasons", label: "Inventory adjustment reasons",
    resource: "InventoryAdjustmentReason", rootEntity: "InventoryAdjustmentReason",
    endpoint: "/v2/inventory/adjustment-reasons", method: "GET", responsePath: "adjustment_reasons",
    recordIdPath: "id", identityMode: "field", modifiedPath: null, cursorLocation: "none",
    scope: ["INVENTORY_READ"], dependencies: [], productDomains: ["inventory"], canonicalTargets: ["metadata"],
    authorityConcept: "stock", priority: 4, availability: beta(), backfill: snapshot(), deletion: snapshotDelete,
    documentation: docs("inventory-api/list-inventory-adjustment-reasons"),
  }),
  defineStream({
    id: "square_transfer_orders", label: "Transfer orders", resource: "TransferOrder", rootEntity: "TransferOrder",
    endpoint: "/v2/transfer-orders/search", method: "POST", responsePath: "transfer_orders",
    recordIdPath: "id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body",
    pagination: cursor("body", 100), scope: ["INVENTORY_READ"], dependencies: ["square_locations", "square_catalog_objects"],
    productDomains: ["inventory"], canonicalTargets: ["inventory_movement"], authorityConcept: "stock", priority: 3,
    availability: beta(), backfill: fullScan("Search can sort by updated_at but does not expose an updated-at range filter."),
    lateEdit: reconcile(), deletion: tombstone("transfer_order.deleted"),
    transport: transport([], "none", null, {}, { query: { sort: { field: "UPDATED_AT", order: "ASC" } } }),
    documentation: docs("transfer-order-api/search-transfer-orders"),
  }),

  defineStream({
    id: "square_customers", label: "Customers", resource: "Customer", rootEntity: "Customer",
    endpoint: "/v2/customers", method: "GET", responsePath: "customers", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100),
    scope: ["CUSTOMERS_READ"], dependencies: [], productDomains: ["customers"], canonicalTargets: ["person", "customer_account", "identity_hint"],
    authorityConcept: "customer_master", priority: 2, backfill: fullScan("Customer listing is eventually consistent and includes only profiles with public information."),
    lateEdit: reconcile("There is no updated-at predicate; webhooks require periodic authoritative reconciliation."),
    deletion: tombstone("customer.deleted"),
    documentation: docs("customers-api/list-customers"),
  }),
  defineStream({
    id: "square_customer_custom_attribute_definitions", label: "Customer custom attribute definitions",
    resource: "CustomAttributeDefinition", rootEntity: "CustomAttributeDefinition",
    endpoint: "/v2/customers/custom-attribute-definitions", method: "GET",
    responsePath: "custom_attribute_definitions", recordIdPath: "key", identityMode: "field",
    modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100, 20),
    scope: ["CUSTOMERS_READ"], dependencies: ["square_customers"], productDomains: ["customers"],
    canonicalTargets: ["metadata"], authorityConcept: "customer_master", priority: 4,
    lateEdit: reconcile(), deletion: tombstone("customer.custom_attribute_definition.owned.deleted"),
    documentation: docs("customer-custom-attributes-api/list-customer-custom-attribute-definitions"),
  }),
  defineStream({
    id: "square_customer_custom_attributes", label: "Customer custom attributes",
    resource: "CustomAttribute", rootEntity: "CustomAttribute",
    endpoint: "/v2/customers/{customer_id}/custom-attributes", method: "GET",
    responsePath: "custom_attributes", recordIdPath: "key", identityMode: "field",
    modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100, 20),
    scope: ["CUSTOMERS_READ"], dependencies: ["square_customers", "square_customer_custom_attribute_definitions"],
    productDomains: ["customers"], canonicalTargets: ["metadata"], authorityConcept: "customer_master",
    priority: 4, backfill: parentFanOut("Custom attributes are not embedded in Customer; this is a rate-governed N+1 fan-out."),
    lateEdit: reconcile(), deletion: tombstone("customer.custom_attribute.owned.deleted"), sourceTotal: parentTotal,
    transport: transport(["customer_id"], "none", null, { with_definitions: true }),
    documentation: docs("customer-custom-attributes-api/list-customer-custom-attributes"),
  }),
  defineStream({
    id: "square_customer_groups", label: "Customer groups", resource: "CustomerGroup", rootEntity: "CustomerGroup",
    endpoint: "/v2/customers/groups", method: "GET", responsePath: "groups", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 50),
    scope: ["CUSTOMERS_READ"], dependencies: [], productDomains: ["customers"], canonicalTargets: ["metadata"],
    authorityConcept: "customer_master", priority: 4, lateEdit: fullReconcile(), deletion: snapshotDelete,
    documentation: docs("customer-groups-api/list-customer-groups"),
  }),
  defineStream({
    id: "square_customer_segments", label: "Customer segments", resource: "CustomerSegment", rootEntity: "CustomerSegment",
    endpoint: "/v2/customers/segments", method: "GET", responsePath: "segments", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 50),
    scope: ["CUSTOMERS_READ"], dependencies: [], productDomains: ["customers"], canonicalTargets: ["metadata"],
    authorityConcept: "customer_master", priority: 4, lateEdit: fullReconcile(), deletion: snapshotDelete,
    documentation: docs("customer-segments-api/list-customer-segments"),
  }),

  defineStream({
    id: "square_jobs", label: "Team jobs", resource: "Job", rootEntity: "Job",
    endpoint: "/v2/team-members/jobs", method: "GET", responsePath: "jobs", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query", pagination: cursorWithoutPageSize("query"),
    scope: ["EMPLOYEES_READ"], dependencies: [], productDomains: ["workforce"], canonicalTargets: ["metadata"],
    authorityConcept: "worked_hours", priority: 3, availability: beta(), lateEdit: fullReconcile(), deletion: snapshotDelete,
    documentation: docs("team-api/list-jobs"),
  }),
  defineStream({
    id: "square_team_members", label: "Team members", resource: "TeamMember", rootEntity: "TeamMember",
    endpoint: "/v2/team-members/search", method: "POST", responsePath: "team_members", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body", pagination: cursor("body", 200),
    scope: ["EMPLOYEES_READ"], dependencies: ["square_locations", "square_jobs"], productDomains: ["workforce"],
    canonicalTargets: ["person", "worker", "employment_episode", "identity_hint"], authorityConcept: "worked_hours", priority: 2,
    backfill: fullScan("No updated-at range filter is exposed."), lateEdit: reconcile(),
    deletion: tombstone("team_member.deleted"),
    documentation: docs("team-api/search-team-members"),
  }),
  defineStream({
    id: "square_team_member_wage_settings", label: "Team member wage settings",
    resource: "WageSetting", rootEntity: "WageSetting",
    endpoint: "/v2/team-members/{team_member_id}/wage-setting", method: "GET", responsePath: "wage_setting",
    recordIdPath: "team_member_id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "none",
    scope: ["EMPLOYEES_READ"], dependencies: ["square_team_members"], productDomains: ["workforce"],
    canonicalTargets: ["metadata"], authorityConcept: "worked_hours", priority: 3,
    backfill: parentFanOut(), lateEdit: reconcile(), deletion: snapshotDelete, sourceTotal: parentTotal,
    transport: transport(["team_member_id"]),
    documentation: docs("team-api/retrieve-wage-setting"),
  }),
  defineStream({
    id: "square_break_types", label: "Break types", resource: "BreakType", rootEntity: "BreakType",
    endpoint: "/v2/labor/break-types", method: "GET", responsePath: "break_types", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 200),
    scope: ["TIMECARDS_SETTINGS_READ"], dependencies: ["square_locations"], productDomains: ["workforce"],
    canonicalTargets: ["metadata"], authorityConcept: "worked_hours", priority: 3, lateEdit: fullReconcile(), deletion: snapshotDelete,
    documentation: docs("labor-api/list-break-types"),
  }),
  defineStream({
    id: "square_scheduled_shifts", label: "Scheduled shifts", resource: "ScheduledShift", rootEntity: "ScheduledShift",
    endpoint: "/v2/labor/scheduled-shifts/search", method: "POST", responsePath: "scheduled_shifts",
    recordIdPath: "id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body",
    pagination: cursor("body", 50), scope: ["TIMECARDS_READ", "EMPLOYEES_READ"],
    dependencies: ["square_team_members", "square_locations"], productDomains: ["workforce"],
    canonicalTargets: ["workforce_shift"], authorityConcept: "planned_shifts", priority: 2,
    availability: beta(), backfill: timeWindow("start_at", "query.filter.start.start_at", "query.filter.start.end_at", "inclusive", 31),
    lateEdit: reconcile("Search can sort but cannot filter by updated_at."), deletion: tombstone("labor.scheduled_shift.deleted"),
    transport: transport([], "none", null, {}, { query: { sort: { field: "UPDATED_AT", order: "ASC" } } }),
    documentation: docs("labor-api/search-scheduled-shifts"),
  }),
  defineStream({
    id: "square_timecards", label: "Timecards", resource: "Timecard", rootEntity: "Timecard",
    endpoint: "/v2/labor/timecards/search", method: "POST", responsePath: "timecards",
    recordIdPath: "id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body",
    pagination: cursor("body", 200), scope: ["TIMECARDS_READ", "EMPLOYEES_READ"],
    dependencies: ["square_team_members", "square_locations", "square_break_types"], productDomains: ["workforce"],
    canonicalTargets: ["workforce_time_entry"], authorityConcept: "worked_hours", priority: 2,
    backfill: timeWindow("start_at", "query.filter.start.start_at", "query.filter.start.end_at", "inclusive", 31),
    lateEdit: reconcile("Search can sort by UPDATED_AT but has no updated-at filter; reconcile authoritative windows."),
    deletion: tombstone("labor.timecard.deleted"),
    transport: transport([], "none", null, {}, { query: { sort: { field: "UPDATED_AT", order: "ASC" } } }),
    documentation: docs("labor-api/search-timecards"),
  }),
  defineStream({
    id: "square_team_member_wages", label: "Team member wages", resource: "TeamMemberWage", rootEntity: "TeamMemberWage",
    endpoint: "/v2/labor/team-member-wages", method: "GET", responsePath: "team_member_wages",
    recordIdPath: "id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query",
    pagination: cursor("query", 200), scope: ["TIMECARDS_SETTINGS_READ", "EMPLOYEES_READ"],
    dependencies: ["square_team_members"], productDomains: ["workforce"], canonicalTargets: ["metadata"],
    authorityConcept: "worked_hours", priority: 3, lateEdit: fullReconcile(), deletion: snapshotDelete,
    documentation: docs("labor-api/list-team-member-wages"),
  }),
  defineStream({
    id: "square_workweek_configs", label: "Workweek configurations", resource: "WorkweekConfig", rootEntity: "WorkweekConfig",
    endpoint: "/v2/labor/workweek-configs", method: "GET", responsePath: "workweek_configs",
    recordIdPath: "id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query",
    pagination: cursor("query", 200), scope: ["TIMECARDS_SETTINGS_READ"], dependencies: [], productDomains: ["workforce"],
    canonicalTargets: ["metadata"], authorityConcept: "worked_hours", priority: 4, lateEdit: fullReconcile(), deletion: snapshotDelete,
    documentation: docs("labor-api/list-workweek-configs"),
  }),

  defineStream({
    id: "square_cash_drawer_shifts", label: "Cash drawer shifts", resource: "CashDrawerShiftSummary",
    rootEntity: "CashDrawerShiftSummary", endpoint: "/v2/cash-drawers/shifts", method: "GET",
    responsePath: "cash_drawer_shifts", recordIdPath: "id", identityMode: "field", modifiedPath: "closed_at",
    cursorLocation: "query", pagination: cursor("query", 1000, 200), scope: ["CASH_DRAWER_READ"],
    dependencies: ["square_locations"], productDomains: ["accounting"], canonicalTargets: ["metadata"],
    authorityConcept: "cash_settlement", priority: 3,
    backfill: timeWindow("opened_at", "begin_time", "end_time", "mixed", 31), lateEdit: fullReconcile(), deletion: noDelete,
    transport: transport([], "query_one", "location_id", { sort_order: "ASC" }),
    documentation: docs("cash-drawers-api/list-cash-drawer-shifts"),
  }),
  defineStream({
    id: "square_cash_drawer_shift_events", label: "Cash drawer shift events", resource: "CashDrawerShiftEvent",
    rootEntity: "CashDrawerShiftEvent", endpoint: "/v2/cash-drawers/shifts/{cash_drawer_shift_id}/events",
    method: "GET", responsePath: "cash_drawer_shift_events", recordIdPath: "id", identityMode: "field",
    modifiedPath: "created_at", cursorLocation: "query", pagination: cursor("query", 1000, 200),
    scope: ["CASH_DRAWER_READ"], dependencies: ["square_cash_drawer_shifts"], productDomains: ["accounting"],
    canonicalTargets: ["metadata"], authorityConcept: "cash_settlement", priority: 3,
    backfill: parentFanOut(), lateEdit: immutable(), deletion: immutableDelete, sourceTotal: parentTotal,
    transport: transport(["cash_drawer_shift_id"]),
    documentation: docs("cash-drawers-api/list-cash-drawer-shift-events"),
  }),
  defineStream({
    id: "square_payouts", label: "Payouts", resource: "Payout", rootEntity: "Payout",
    endpoint: "/v2/payouts", method: "GET", responsePath: "payouts", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100),
    scope: ["PAYOUTS_READ"], dependencies: ["square_locations"], productDomains: ["accounting"],
    canonicalTargets: ["finance_settlement"], authorityConcept: "cash_settlement", priority: 2,
    backfill: timeWindow("created_at", "begin_time", "end_time", "mixed", 31, "The endpoint defaults to only one year and one main location."),
    lateEdit: reconcile("ListPayouts has no updated-at filter; payout version orders out-of-order updates."), deletion: noDelete,
    transport: transport([], "query_one", "location_id", { sort_order: "ASC" }),
    documentation: docs("payouts-api/list-payouts"),
  }),
  defineStream({
    id: "square_payout_entries", label: "Payout entries", resource: "PayoutEntry", rootEntity: "PayoutEntry",
    endpoint: "/v2/payouts/{payout_id}/payout-entries", method: "GET", responsePath: "payout_entries",
    recordIdPath: "id", identityMode: "field", modifiedPath: "effective_at", cursorLocation: "query",
    pagination: cursor("query", 100), scope: ["PAYOUTS_READ"], dependencies: ["square_payouts"],
    productDomains: ["accounting"], canonicalTargets: ["finance_settlement_line"], authorityConcept: "cash_settlement",
    priority: 2, backfill: parentFanOut(), lateEdit: fullReconcile(), deletion: noDelete, sourceTotal: parentTotal,
    transport: transport(["payout_id"]),
    documentation: docs("payouts-api/list-payout-entries"),
  }),
  defineStream({
    id: "square_bank_accounts", label: "Bank accounts", resource: "BankAccount", rootEntity: "BankAccount",
    endpoint: "/v2/bank-accounts", method: "GET", responsePath: "bank_accounts", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 1000),
    scope: ["BANK_ACCOUNTS_READ"], dependencies: ["square_locations"], productDomains: ["accounting"],
    canonicalTargets: ["metadata"], authorityConcept: "cash_settlement", priority: 3,
    lateEdit: reconcile(), deletion: tombstone("bank_account.disabled"),
    documentation: docs("bank-accounts-api/list-bank-accounts"),
  }),
  defineStream({
    id: "square_cards", label: "Cards on file", resource: "Card", rootEntity: "Card",
    endpoint: "/v2/cards", method: "GET", responsePath: "cards", recordIdPath: "id", identityMode: "field",
    modifiedPath: null, cursorLocation: "query", pagination: cursorWithoutPageSize("query"), scope: ["PAYMENTS_READ"],
    dependencies: ["square_customers"], productDomains: ["sales", "customers"], canonicalTargets: ["metadata"],
    authorityConcept: null, priority: 5, backfill: fullScan(), lateEdit: reconcile(), deletion: snapshotDelete,
    transport: transport([], "none", null, { include_disabled: true }),
    documentation: docs("cards-api/list-cards"),
  }),

  defineStream({
    id: "square_gift_cards", label: "Gift cards", resource: "GiftCard", rootEntity: "GiftCard",
    endpoint: "/v2/gift-cards", method: "GET", responsePath: "gift_cards", recordIdPath: "id",
    identityMode: "field", modifiedPath: null, cursorLocation: "query", pagination: cursor("query", 200, 30),
    scope: ["GIFTCARDS_READ"], dependencies: ["square_customers"], productDomains: ["customers", "accounting"],
    canonicalTargets: ["metadata"], authorityConcept: "customer_master", priority: 3,
    backfill: fullScan(), lateEdit: reconcile(), deletion: snapshotDelete,
    documentation: docs("gift-cards-api/list-gift-cards"),
  }),
  defineStream({
    id: "square_gift_card_activities", label: "Gift card activities", resource: "GiftCardActivity",
    rootEntity: "GiftCardActivity", endpoint: "/v2/gift-cards/activities", method: "GET",
    responsePath: "gift_card_activities", recordIdPath: "id", identityMode: "field", modifiedPath: "created_at",
    cursorLocation: "query", pagination: cursor("query", 100, 50), scope: ["GIFTCARDS_READ"],
    dependencies: ["square_gift_cards", "square_locations"], productDomains: ["customers", "accounting"],
    canonicalTargets: ["metadata"], authorityConcept: "customer_master", priority: 3,
    backfill: timeWindow("created_at", "begin_time", "end_time", "inclusive", 31, "ACTIVATE, CLEAR_BALANCE and IMPORT before 2016-03-02 are unavailable."),
    lateEdit: reconcile("Redemption activities can move from PENDING to COMPLETED or CANCELED."), deletion: noDelete,
    transport: transport([], "none", null, { sort_order: "ASC" }),
    documentation: docs("gift-card-activities-api/list-gift-card-activities"),
  }),
  defineStream({
    id: "square_loyalty_accounts", label: "Loyalty accounts", resource: "LoyaltyAccount", rootEntity: "LoyaltyAccount",
    endpoint: "/v2/loyalty/accounts/search", method: "POST", responsePath: "loyalty_accounts",
    recordIdPath: "id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body",
    pagination: cursor("body", 200), scope: ["LOYALTY_READ"], dependencies: ["square_customers"],
    productDomains: ["customers"], canonicalTargets: ["metadata"], authorityConcept: "customer_master",
    priority: 3, backfill: fullScan(), lateEdit: reconcile(), deletion: snapshotDelete,
    documentation: docs("loyalty-api/search-loyalty-accounts"),
  }),
  defineStream({
    id: "square_loyalty_events", label: "Loyalty events", resource: "LoyaltyEvent", rootEntity: "LoyaltyEvent",
    endpoint: "/v2/loyalty/events/search", method: "POST", responsePath: "events", recordIdPath: "id",
    identityMode: "field", modifiedPath: "created_at", cursorLocation: "body", pagination: cursor("body", 30),
    scope: ["LOYALTY_READ"], dependencies: ["square_loyalty_accounts", "square_locations"], productDomains: ["customers"],
    canonicalTargets: ["metadata"], authorityConcept: "customer_master", priority: 3,
    backfill: timeWindow("created_at", "query.filter.date_time_filter.created_at.start_at", "query.filter.date_time_filter.created_at.end_at", "mixed", 31),
    lateEdit: immutable(), deletion: immutableDelete,
    documentation: docs("loyalty-api/search-loyalty-events"),
  }),
  defineStream({
    id: "square_loyalty_programs", label: "Loyalty programs", resource: "LoyaltyProgram", rootEntity: "LoyaltyProgram",
    endpoint: "/v2/loyalty/programs", method: "GET", responsePath: "programs", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "none", scope: ["LOYALTY_READ"],
    dependencies: ["square_catalog_objects"], productDomains: ["customers", "products"], canonicalTargets: ["metadata"],
    authorityConcept: "customer_master", priority: 4, backfill: snapshot(), lateEdit: reconcile(), deletion: snapshotDelete,
    documentation: docs("loyalty-api/list-loyalty-programs"),
  }),
  defineStream({
    id: "square_loyalty_promotions", label: "Loyalty promotions", resource: "LoyaltyPromotion", rootEntity: "LoyaltyPromotion",
    endpoint: "/v2/loyalty/programs/{program_id}/promotions", method: "GET", responsePath: "loyalty_promotions",
    recordIdPath: "id", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query",
    pagination: cursor("query", 30), scope: ["LOYALTY_READ"], dependencies: ["square_loyalty_programs"],
    productDomains: ["customers"], canonicalTargets: ["metadata"], authorityConcept: "customer_master", priority: 4,
    backfill: parentFanOut(), lateEdit: reconcile(), deletion: snapshotDelete, sourceTotal: parentTotal,
    transport: transport(["program_id"]),
    documentation: docs("loyalty-api/list-loyalty-promotions"),
  }),
  defineStream({
    id: "square_loyalty_rewards", label: "Loyalty rewards", resource: "LoyaltyReward", rootEntity: "LoyaltyReward",
    endpoint: "/v2/loyalty/rewards/search", method: "POST", responsePath: "rewards", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body", pagination: cursor("body", 200),
    scope: ["LOYALTY_READ"], dependencies: ["square_loyalty_accounts", "square_orders"], productDomains: ["customers", "sales"],
    canonicalTargets: ["metadata"], authorityConcept: "customer_master", priority: 4,
    backfill: fullScan(), lateEdit: reconcile(), deletion: snapshotDelete,
    documentation: docs("loyalty-api/search-loyalty-rewards"),
  }),
  defineStream({
    id: "square_invoices", label: "Invoices", resource: "Invoice", rootEntity: "Invoice",
    endpoint: "/v2/invoices/search", method: "POST", responsePath: "invoices", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body", pagination: cursor("body", 200, 100),
    scope: ["INVOICES_READ"], dependencies: ["square_locations", "square_customers", "square_orders"],
    productDomains: ["accounting", "sales"], canonicalTargets: ["finance_invoice_line"],
    authorityConcept: "operational_sales", priority: 3,
    backfill: fullScan("Current implementation permits exactly one location and at most one customer per query."),
    lateEdit: reconcile("No updated-at filter is available."), deletion: tombstone("invoice.deleted"),
    transport: transport([], "body_one", "query.filter.location_ids", {}, {
      query: { sort: { field: "INVOICE_SORT_DATE", order: "ASC" } },
    }),
    documentation: docs("invoices-api/search-invoices"),
  }),
  defineStream({
    id: "square_subscriptions", label: "Subscriptions", resource: "Subscription", rootEntity: "Subscription",
    endpoint: "/v2/subscriptions/search", method: "POST", responsePath: "subscriptions", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body", pagination: cursor("body", 200),
    scope: ["SUBSCRIPTIONS_READ"], dependencies: ["square_locations", "square_customers", "square_catalog_objects"],
    productDomains: ["sales", "customers"], canonicalTargets: ["metadata"], authorityConcept: "customer_master",
    priority: 3, backfill: fullScan("Search filters location, customer and source only."),
    lateEdit: reconcile(), deletion: snapshotDelete,
    transport: transport([], "none", null, {}, { include: ["actions"] }),
    documentation: docs("subscriptions-api/search-subscriptions"),
  }),
  defineStream({
    id: "square_subscription_events", label: "Subscription events", resource: "SubscriptionEvent", rootEntity: "SubscriptionEvent",
    endpoint: "/v2/subscriptions/{subscription_id}/events", method: "GET", responsePath: "subscription_events",
    recordIdPath: "id", identityMode: "field", modifiedPath: "effective_date", cursorLocation: "query",
    pagination: cursor("query", 200), scope: ["SUBSCRIPTIONS_READ"], dependencies: ["square_subscriptions"],
    productDomains: ["sales"], canonicalTargets: ["metadata"], authorityConcept: "operational_sales", priority: 4,
    backfill: parentFanOut(), lateEdit: immutable(), deletion: immutableDelete, sourceTotal: parentTotal,
    transport: transport(["subscription_id"]),
    documentation: docs("subscriptions-api/list-subscription-events"),
  }),

  defineStream({
    id: "square_bookings", label: "Bookings", resource: "Booking", rootEntity: "Booking",
    endpoint: "/v2/bookings", method: "GET", responsePath: "bookings", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100),
    scope: ["APPOINTMENTS_READ", "APPOINTMENTS_ALL_READ"], dependencies: ["square_locations", "square_customers", "square_team_members", "square_catalog_objects"],
    productDomains: ["workforce", "customers"], canonicalTargets: ["metadata"], authorityConcept: "planned_shifts", priority: 3,
    backfill: timeWindow("start_at", "start_at_min", "start_at_max", "inclusive", 31, "ListBookings rejects ranges longer than 31 days and defaults to now through 31 days ahead."),
    lateEdit: reconcile(), deletion: snapshotDelete,
    documentation: docs("bookings-api/list-bookings"),
  }),
  defineStream({
    id: "square_booking_custom_attribute_definitions", label: "Booking custom attribute definitions",
    resource: "CustomAttributeDefinition", rootEntity: "CustomAttributeDefinition",
    endpoint: "/v2/bookings/custom-attribute-definitions", method: "GET", responsePath: "custom_attribute_definitions",
    recordIdPath: "key", identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query",
    pagination: cursor("query", 100, 20), scope: ["APPOINTMENTS_READ", "APPOINTMENTS_ALL_READ"],
    dependencies: ["square_bookings"], productDomains: ["workforce"], canonicalTargets: ["metadata"],
    authorityConcept: "planned_shifts", priority: 4, lateEdit: reconcile(), deletion: tombstone("booking.custom_attribute_definition.owned.deleted"),
    documentation: docs("booking-custom-attributes-api/list-booking-custom-attribute-definitions"),
  }),
  defineStream({
    id: "square_booking_custom_attributes", label: "Booking custom attributes", resource: "CustomAttribute",
    rootEntity: "CustomAttribute", endpoint: "/v2/bookings/{booking_id}/custom-attributes", method: "GET",
    responsePath: "custom_attributes", recordIdPath: "key", identityMode: "field", modifiedPath: "updated_at",
    cursorLocation: "query", pagination: cursor("query", 100, 20),
    scope: ["APPOINTMENTS_READ", "APPOINTMENTS_ALL_READ"], dependencies: ["square_bookings", "square_booking_custom_attribute_definitions"],
    productDomains: ["workforce"], canonicalTargets: ["metadata"], authorityConcept: "planned_shifts",
    priority: 4, backfill: parentFanOut(), lateEdit: reconcile(), deletion: tombstone("booking.custom_attribute.owned.deleted"),
    sourceTotal: parentTotal, transport: transport(["booking_id"], "none", null, { with_definitions: true }),
    documentation: docs("booking-custom-attributes-api/list-booking-custom-attributes"),
  }),
  defineStream({
    id: "square_booking_business_profile", label: "Booking business profile", resource: "BusinessBookingProfile",
    rootEntity: "BusinessBookingProfile", endpoint: "/v2/bookings/business-booking-profile", method: "GET",
    responsePath: "business_booking_profile", recordIdPath: "$merchant", identityMode: "singleton", modifiedPath: null,
    cursorLocation: "none", scope: ["APPOINTMENTS_BUSINESS_SETTINGS_READ"], dependencies: ["square_merchants"],
    productDomains: ["workforce"], canonicalTargets: ["metadata"], authorityConcept: "planned_shifts", priority: 4,
    backfill: snapshot(), deletion: noDelete,
    documentation: docs("bookings-api/retrieve-business-booking-profile"),
  }),
  defineStream({
    id: "square_booking_location_profiles", label: "Location booking profiles", resource: "LocationBookingProfile",
    rootEntity: "LocationBookingProfile", endpoint: "/v2/bookings/location-booking-profiles", method: "GET",
    responsePath: "location_booking_profiles", recordIdPath: "location_id", identityMode: "field", modifiedPath: null,
    cursorLocation: "query", pagination: cursor("query", 100), scope: ["APPOINTMENTS_BUSINESS_SETTINGS_READ"],
    dependencies: ["square_locations"], productDomains: ["workforce"], canonicalTargets: ["metadata"],
    authorityConcept: "planned_shifts", priority: 4, backfill: snapshot(), lateEdit: fullReconcile(), deletion: snapshotDelete,
    documentation: docs("bookings-api/list-location-booking-profiles"),
  }),
  defineStream({
    id: "square_booking_team_member_profiles", label: "Team member booking profiles",
    resource: "TeamMemberBookingProfile", rootEntity: "TeamMemberBookingProfile",
    endpoint: "/v2/bookings/team-member-booking-profiles", method: "GET", responsePath: "team_member_booking_profiles",
    recordIdPath: "team_member_id", identityMode: "field", modifiedPath: null, cursorLocation: "query",
    pagination: cursor("query", 100), scope: ["APPOINTMENTS_BUSINESS_SETTINGS_READ"], dependencies: ["square_team_members"],
    productDomains: ["workforce"], canonicalTargets: ["metadata"], authorityConcept: "planned_shifts",
    priority: 4, backfill: snapshot(), lateEdit: fullReconcile(), deletion: snapshotDelete,
    documentation: docs("bookings-api/list-team-member-booking-profiles"),
  }),

  defineStream({
    id: "square_disputes", label: "Disputes", resource: "Dispute", rootEntity: "Dispute",
    endpoint: "/v2/disputes", method: "GET", responsePath: "disputes", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query", pagination: cursorWithoutPageSize("query"),
    scope: ["DISPUTES_READ"], dependencies: ["square_payments", "square_locations"], productDomains: ["accounting", "sales"],
    canonicalTargets: ["metadata"], authorityConcept: "cash_settlement", priority: 3,
    backfill: fullScan("ListDisputes exposes state and location filters but no time range."), lateEdit: reconcile(), deletion: snapshotDelete,
    documentation: docs("disputes-api/list-disputes"),
  }),
  defineStream({
    id: "square_dispute_evidence", label: "Dispute evidence metadata", resource: "DisputeEvidence", rootEntity: "DisputeEvidence",
    endpoint: "/v2/disputes/{dispute_id}/evidence", method: "GET", responsePath: "evidence",
    recordIdPath: "id", identityMode: "field", modifiedPath: "uploaded_at", cursorLocation: "query",
    pagination: cursorWithoutPageSize("query"), scope: ["DISPUTES_READ"], dependencies: ["square_disputes"],
    productDomains: ["sales", "accounting"], canonicalTargets: ["metadata"], authorityConcept: "cash_settlement", priority: 5,
    backfill: parentFanOut(), lateEdit: reconcile(), deletion: tombstone("dispute.evidence.deleted"), sourceTotal: parentTotal,
    transport: transport(["dispute_id"]),
    documentation: docs("disputes-api/list-dispute-evidence"),
  }),
  defineStream({
    id: "square_vendors", label: "Vendors", resource: "Vendor", rootEntity: "Vendor",
    endpoint: "/v2/vendors/search", method: "POST", responsePath: "vendors", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body", pagination: cursorWithoutPageSize("body"),
    scope: ["VENDOR_READ"], dependencies: [], productDomains: ["products", "inventory"], canonicalTargets: ["supplier"],
    authorityConcept: "product_master", priority: 3, availability: beta(), backfill: fullScan(),
    lateEdit: reconcile(), deletion: tombstone("vendor.deleted"),
    transport: transport([], "none", null, {}, { sort: { field: "CREATED_AT", order: "ASC" } }),
    documentation: docs("vendors-api/search-vendors"),
  }),
  defineStream({
    id: "square_channels", label: "Channels", resource: "Channel", rootEntity: "Channel",
    endpoint: "/v2/channels", method: "GET", responsePath: "channels", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100),
    scope: [], dependencies: [], productDomains: ["sales"], canonicalTargets: ["channel"],
    authorityConcept: "operational_sales", priority: 5,
    availability: Object.freeze({ release: "beta", sellerOAuth: "undocumented", notes: "The current endpoint reference and OAuth permission index do not publish a Channels read scope; keep disabled until a granted scope is proven." }),
    backfill: fullScan(), lateEdit: fullReconcile(), deletion: snapshotDelete,
    documentation: docs("channels-api/list-channels"),
  }),
  defineStream({
    id: "square_devices", label: "Devices", resource: "Device", rootEntity: "Device",
    endpoint: "/v2/devices", method: "GET", responsePath: "devices", recordIdPath: "id", identityMode: "field",
    modifiedPath: "updated_at", cursorLocation: "query", pagination: cursor("query", 100), scope: ["DEVICES_READ"],
    dependencies: ["square_locations"], productDomains: ["sales"], canonicalTargets: ["register"],
    authorityConcept: "operational_sales", priority: 5, availability: beta(), backfill: fullScan(),
    lateEdit: reconcile(), deletion: snapshotDelete,
    documentation: docs("devices-api/list-devices"),
  }),
  defineStream({
    id: "square_sites", label: "Square Online sites", resource: "Site", rootEntity: "Site",
    endpoint: "/v2/sites", method: "GET", responsePath: "sites", recordIdPath: "id", identityMode: "field",
    modifiedPath: "updated_at", cursorLocation: "none", scope: ["ONLINE_STORE_SITE_READ"], dependencies: [],
    productDomains: ["sales"], canonicalTargets: ["channel"], authorityConcept: "operational_sales",
    priority: 5, availability: earlyAccess(), backfill: snapshot(), lateEdit: fullReconcile(), deletion: snapshotDelete,
    documentation: docs("sites-api/list-sites"),
  }),
  defineStream({
    id: "square_snippets", label: "Square Online snippets", resource: "Snippet", rootEntity: "Snippet",
    endpoint: "/v2/sites/{site_id}/snippet", method: "GET", responsePath: "snippet", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "none", scope: ["ONLINE_STORE_SNIPPETS_READ"],
    dependencies: ["square_sites"], productDomains: ["sales"], canonicalTargets: ["metadata"], authorityConcept: null,
    priority: 5, availability: earlyAccess("RetrieveSnippet returns only the snippet owned by the calling application."),
    backfill: parentFanOut(), lateEdit: fullReconcile(), deletion: snapshotDelete, sourceTotal: parentTotal,
    transport: transport(["site_id"]),
    documentation: docs("snippets-api/retrieve-snippet"),
  }),
  defineStream({
    id: "square_terminal_actions", label: "Terminal actions", resource: "TerminalAction", rootEntity: "TerminalAction",
    endpoint: "/v2/terminals/actions/search", method: "POST", responsePath: "action", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body", pagination: cursor("body", 100),
    scope: ["PAYMENTS_READ", "CUSTOMERS_READ"], dependencies: ["square_devices", "square_locations"],
    productDomains: ["sales"], canonicalTargets: ["metadata"], authorityConcept: "cash_settlement", priority: 5,
    backfill: fullScan("Terminal searches are limited to objects created by the account/application and are not a complete sales source."),
    lateEdit: reconcile(), deletion: snapshotDelete,
    documentation: docs("terminal-api/search-terminal-actions"),
  }),
  defineStream({
    id: "square_terminal_checkouts", label: "Terminal checkouts", resource: "TerminalCheckout", rootEntity: "TerminalCheckout",
    endpoint: "/v2/terminals/checkouts/search", method: "POST", responsePath: "checkouts", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body", pagination: cursor("body", 100),
    scope: ["PAYMENTS_READ"], dependencies: ["square_devices", "square_locations", "square_payments"],
    productDomains: ["sales"], canonicalTargets: ["metadata"], authorityConcept: "cash_settlement", priority: 5,
    backfill: fullScan("Terminal searches are secondary application-scoped telemetry, not the complete tender ledger."),
    lateEdit: reconcile(), deletion: snapshotDelete,
    documentation: docs("terminal-api/search-terminal-checkouts"),
  }),
  defineStream({
    id: "square_terminal_refunds", label: "Terminal refunds", resource: "TerminalRefund", rootEntity: "TerminalRefund",
    endpoint: "/v2/terminals/refunds/search", method: "POST", responsePath: "refunds", recordIdPath: "id",
    identityMode: "field", modifiedPath: "updated_at", cursorLocation: "body", pagination: cursor("body", 100),
    scope: ["PAYMENTS_READ"], dependencies: ["square_devices", "square_locations", "square_refunds"],
    productDomains: ["sales"], canonicalTargets: ["metadata"], authorityConcept: "cash_settlement", priority: 5,
    backfill: fullScan("Terminal searches are secondary application-scoped telemetry, not the complete refund ledger."),
    lateEdit: reconcile(), deletion: snapshotDelete,
    documentation: docs("terminal-api/search-terminal-refunds"),
  }),
]);

export type BuildSquareReadRequestInput = Readonly<{
  cursor?: string;
  pageSize?: number;
  beginTime?: string;
  endTime?: string;
  locationIds?: readonly string[];
  pathParameters?: Readonly<Record<string, string>>;
}>;

export type BuiltSquareReadRequest = Readonly<{
  method: "GET" | "POST";
  path: string;
  query: Readonly<Record<string, SquareJson>>;
  body: Readonly<Record<string, SquareJson>> | null;
}>;

function cloneJson(value: SquareJson): SquareJson {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
  }
  return value;
}

function setJsonPath(target: Record<string, SquareJson>, path: string, value: SquareJson): void {
  const parts = path.split(".").filter(Boolean);
  let cursorTarget = target;
  for (const part of parts.slice(0, -1)) {
    const current = cursorTarget[part];
    if (current === null || Array.isArray(current) || typeof current !== "object") {
      cursorTarget[part] = {};
    }
    cursorTarget = cursorTarget[part] as Record<string, SquareJson>;
  }
  const leaf = parts.at(-1);
  if (leaf) cursorTarget[leaf] = value;
}

/** Build a deterministic first-page or continuation request from stream metadata. */
export function buildSquareReadRequest(
  stream: SquareReadStream,
  input: BuildSquareReadRequestInput = {},
): BuiltSquareReadRequest {
  const suppliedPaths = input.pathParameters ?? {};
  let path = stream.endpoint;
  for (const parameter of stream.transport.pathParameters) {
    const value = suppliedPaths[parameter];
    if (!value) throw new Error(`${stream.id} requires path parameter ${parameter}.`);
    path = path.replace(`{${parameter}}`, encodeURIComponent(value));
  }
  if (/\{[^}]+\}/.test(path)) throw new Error(`${stream.id} has unresolved path parameters.`);

  const query = Object.fromEntries(
    Object.entries(stream.transport.fixedQuery).map(([key, value]) => [key, cloneJson(value)]),
  ) as Record<string, SquareJson>;
  const body = Object.fromEntries(
    Object.entries(stream.transport.fixedBody).map(([key, value]) => [key, cloneJson(value)]),
  ) as Record<string, SquareJson>;

  if (input.cursor && stream.pagination.requestPath) {
    setJsonPath(stream.cursorLocation === "query" ? query : body, stream.pagination.requestPath, input.cursor);
  }
  if (input.pageSize !== undefined && stream.pagination.pageSizePath) {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize <= 0) {
      throw new Error(`${stream.id} page size must be a positive safe integer.`);
    }
    if (stream.pagination.maxPageSize !== null && input.pageSize > stream.pagination.maxPageSize) {
      throw new Error(`${stream.id} page size exceeds ${stream.pagination.maxPageSize}.`);
    }
    setJsonPath(stream.cursorLocation === "query" ? query : body, stream.pagination.pageSizePath, input.pageSize);
  }
  if (input.beginTime && stream.backfill.beginRequestPath) {
    setJsonPath(stream.method === "GET" ? query : body, stream.backfill.beginRequestPath, input.beginTime);
  }
  if (input.endTime && stream.backfill.endRequestPath) {
    setJsonPath(stream.method === "GET" ? query : body, stream.backfill.endRequestPath, input.endTime);
  }
  if (input.locationIds?.length && stream.transport.locationRequestPath) {
    const mode = stream.transport.locationMode;
    if (mode === "body_one" && input.locationIds.length > 1) {
      throw new Error(`${stream.id} accepts exactly one location per request.`);
    }
    if (mode === "body_many_max_10" && input.locationIds.length > 10) {
      throw new Error(`${stream.id} accepts at most 10 locations per request.`);
    }
    const value: SquareJson = mode === "query_one" || mode === "path_one"
      ? input.locationIds[0] ?? ""
      : [...input.locationIds];
    setJsonPath(stream.method === "GET" ? query : body, stream.transport.locationRequestPath, value);
  }

  return Object.freeze({
    method: stream.method,
    path,
    query: Object.freeze(query),
    body: stream.method === "POST" ? Object.freeze(body) : null,
  });
}

/**
 * Exercise every optional request surface that a stream declares. The pinned
 * SDK census generator wire-validates this deterministic probe, and contract
 * tests bind the generated evidence back to the current stream metadata.
 */
export function squareReadRequestContractProbe(stream: SquareReadStream): BuiltSquareReadRequest {
  const pathParameters = Object.fromEntries(
    stream.transport.pathParameters.map((parameter) => [parameter, `contract-${parameter}`]),
  );
  const hasLocationInput = stream.transport.locationRequestPath !== null;
  const locationIds = hasLocationInput
    ? stream.transport.locationMode === "body_many_max_10"
      ? ["contract-location-1", "contract-location-2"]
      : ["contract-location-1"]
    : undefined;

  return buildSquareReadRequest(stream, {
    cursor: stream.pagination.requestPath ? "contract-cursor" : undefined,
    pageSize: stream.pagination.pageSizePath ? stream.pagination.defaultPageSize ?? undefined : undefined,
    beginTime: stream.backfill.beginRequestPath ? "2026-01-01T00:00:00Z" : undefined,
    endTime: stream.backfill.endRequestPath ? "2026-02-01T00:00:00Z" : undefined,
    locationIds,
    pathParameters,
  });
}

export function squareReadStream(id: string): SquareReadStream {
  const stream = SQUARE_READ_STREAMS.find((candidate) => candidate.id === id);
  if (!stream) throw new Error(`Unknown Square read stream: ${id}.`);
  return stream;
}

export type SquareDeletionContract =
  | "soft_delete"
  | "authoritative_identity_scan"
  | "no_absence_deletes"
  | "immutable_append_only";

export type SquareSourceTotalContract =
  | "count_distinct_complete_scan"
  | "count_distinct_bounded_scan";

function squareParentIdentityStream(stream: SquareReadStream, parameter: string): SquareReadStream | null {
  const singular = parameter.replace(/_id$/u, "");
  for (const dependencyId of stream.dependencies) {
    const dependency = squareReadStream(dependencyId);
    const resource = dependency.resource.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase();
    if (resource === singular || dependency.id.includes(singular)) return dependency;
  }
  return null;
}

/**
 * Whether reconciliation can observe this stream's complete identity universe.
 * A bounded date window is not absence evidence, and a child fan-out is also
 * bounded when its parent identities came from such a window.
 */
export function squareHasCompleteIdentityScan(stream: SquareReadStream): boolean {
  const evaluate = (candidate: SquareReadStream, visiting: ReadonlySet<string>): boolean => {
    if (candidate.backfill.mode === "time_windowed") return false;
    if (candidate.backfill.mode !== "parent_fan_out") return true;
    if (visiting.has(candidate.id) || candidate.transport.pathParameters.length !== 1) return false;
    const nextVisiting = new Set(visiting).add(candidate.id);
    const parameter = candidate.transport.pathParameters[0]!;
    // These two identity sets come from the OAuth merchant and complete
    // ListLocations response, not from the seven-day reconciliation range.
    if (parameter === "merchant_id" || parameter === "location_id") return true;
    const parent = squareParentIdentityStream(candidate, parameter);
    return parent !== null && evaluate(parent, nextVisiting);
  };
  return evaluate(stream, new Set());
}

/**
 * Fail-safe policy for the generic reconciliation worker. That worker compares
 * a scan against all staged history, so only an exhaustive current-list scan
 * may retire an identity. `no_absence_deletes` preserves mutable late-edit
 * replacement without treating a bounded scan's omissions as deletions;
 * `immutable_append_only` is reserved for genuinely immutable event streams.
 */
export function squareDeletionContract(stream: SquareReadStream): SquareDeletionContract {
  if (stream.deletion.strategy === "soft_delete_field") return "soft_delete";
  if (stream.deletion.strategy === "immutable") return "immutable_append_only";
  if (stream.deletion.strategy === "not_exposed" || !squareHasCompleteIdentityScan(stream)) {
    return "no_absence_deletes";
  }
  return "authoritative_identity_scan";
}

/**
 * The source total must describe the population the extraction actually saw.
 * Seven-day reads (and children reached through those reads) produce a bounded
 * window count, even when Square exposes explicit soft-delete markers.
 */
export function squareSourceTotalContract(stream: SquareReadStream): SquareSourceTotalContract {
  return squareHasCompleteIdentityScan(stream)
    ? "count_distinct_complete_scan"
    : "count_distinct_bounded_scan";
}
