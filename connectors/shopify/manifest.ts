import type {
  ConnectorManifest,
  FieldCoverage,
  PiiClass,
  StreamContract,
} from "../../packages/connector-sdk/src/index.js";
import {
  SHOPIFY_STREAM_FIELDS,
  type ShopifyStreamId,
} from "./streams.js";
import {
  loadShopifyAdminSchemaRegistry,
  shopifyGraphQLNamedType,
} from "./schema-registry.js";
import { loadShopifyQLSchemaRegistry } from "./shopifyql-registry.js";
import { SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY } from "./field-value-availability.js";
import { SHOPIFY_METAFIELD_OWNER_POLICIES } from "./queries.js";

/** Core read scopes that work on an ordinary Shopify store. */
export const SHOPIFY_DEFAULT_SCOPES = [
  "read_products",
  "read_orders",
  "read_customers",
  "read_inventory",
  "read_locations",
  "read_fulfillments",
  "read_returns",
  "read_price_rules",
  "read_discounts",
  "read_reports",
] as const;

/**
 * Additional reviewed modules. They are deliberately not requested by
 * default: Shopify requires separate approval, plan support, or a merchant
 * feature before some of them can be granted.
 */
export const SHOPIFY_OPTIONAL_SCOPES = [
  "read_all_orders",
  "read_companies",
  "read_own_subscription_contracts",
  "read_customer_payment_methods",
  "read_shipping",
  "read_marketing_events",
  "read_markets",
  "read_locales",
  "read_translations",
  "read_metaobjects",
  "read_metaobject_definitions",
  "read_content",
  "read_files",
  "read_gift_cards",
  "read_shopify_payments_payouts",
  "read_shopify_payments_disputes",
  "read_cash_tracking",
  "read_store_credit_accounts",
  "read_store_credit_account_transactions",
  "read_users",
] as const;

export const SHOPIFY_ALLOWED_SCOPES = [
  ...SHOPIFY_DEFAULT_SCOPES,
  ...SHOPIFY_OPTIONAL_SCOPES,
] as const;

export const SHOPIFY_API_VERSION = "2026-07";

/** Shopify's authorization host is merchant supplied, so only this exact form is accepted. */
const SHOP_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?\.myshopify\.com$/u;

export function normalizeShopifyShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
  const candidate = trimmed.includes(".") ? trimmed : `${trimmed}.myshopify.com`;
  if (!SHOP_DOMAIN_PATTERN.test(candidate)) {
    throw new Error("A Shopify shop domain must look like your-store.myshopify.com.");
  }
  return candidate;
}

type StreamSeed = Readonly<{
  id: ShopifyStreamId;
  resource: string;
  endpoint: string;
  recordIdField?: string;
  modifiedField?: string;
  pagination: StreamContract["pagination"];
  backfillStrategy: StreamContract["backfillStrategy"];
  lateEditStrategy: StreamContract["lateEditStrategy"];
  deletionStrategy: StreamContract["deletionStrategy"];
  availability?: StreamContract["availability"];
  dependencies?: readonly ShopifyStreamId[];
  productDomains: StreamContract["productDomains"];
  canonicalTargets: StreamContract["canonicalTargets"];
  authorityConcept: StreamContract["authorityConcept"];
}>;

const seeds: readonly StreamSeed[] = [
  { id: "shopify_shop", resource: "Shop", endpoint: "shop", pagination: "none", backfillStrategy: "snapshot", lateEditStrategy: "full_snapshot", deletionStrategy: "soft_delete", productDomains: ["sales", "inventory", "customers", "products"], canonicalTargets: ["channel", "location", "stock_location", "metadata"], authorityConcept: "operational_sales" },
  { id: "shopify_locations", resource: "Location", endpoint: "locations", modifiedField: "updatedAt", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "authoritative_identity_scan", productDomains: ["sales", "inventory"], canonicalTargets: ["location", "stock_location", "identity_hint"], authorityConcept: "stock" },
  { id: "shopify_products", resource: "Product", endpoint: "products", modifiedField: "updatedAt", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "verified_delete_feed", productDomains: ["products", "inventory"], canonicalTargets: ["product", "product_category"], authorityConcept: "product_master" },
  { id: "shopify_product_variants", resource: "ProductVariant", endpoint: "products.variants", modifiedField: "updatedAt", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "verified_delete_feed", dependencies: ["shopify_products"], productDomains: ["products", "inventory"], canonicalTargets: ["product_variant", "product_category", "category_assignment", "identity_hint"], authorityConcept: "product_master" },
  { id: "shopify_customers", resource: "Customer", endpoint: "customers", modifiedField: "updatedAt", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "verified_delete_feed", productDomains: ["customers", "sales"], canonicalTargets: ["person", "customer_account", "identity_hint"], authorityConcept: "customer_master" },
  { id: "shopify_orders", resource: "Order", endpoint: "orders", modifiedField: "updatedAt", pagination: "vendor_cursor", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "verified_delete_feed", dependencies: ["shopify_shop", "shopify_locations", "shopify_customers"], productDomains: ["sales", "customers"], canonicalTargets: ["commerce_order", "channel", "location", "stock_location"], authorityConcept: "operational_sales" },
  { id: "shopify_order_lines", resource: "LineItem", endpoint: "orders.lineItems", pagination: "vendor_cursor", backfillStrategy: "time_windowed", lateEditStrategy: "full_snapshot", deletionStrategy: "no_absence_deletes", dependencies: ["shopify_orders", "shopify_product_variants"], productDomains: ["sales", "products"], canonicalTargets: ["commerce_order_line", "channel", "location", "stock_location"], authorityConcept: "operational_sales" },
  { id: "shopify_transactions", resource: "OrderTransaction", endpoint: "orders.transactions", pagination: "vendor_cursor", backfillStrategy: "time_windowed", lateEditStrategy: "full_snapshot", deletionStrategy: "no_absence_deletes", dependencies: ["shopify_orders"], productDomains: ["sales"], canonicalTargets: ["commerce_payment", "channel", "location", "stock_location"], authorityConcept: "cash_settlement" },
  { id: "shopify_refund_lines", resource: "RefundLineItem", endpoint: "orders.refunds.refundLineItems", pagination: "vendor_cursor", backfillStrategy: "time_windowed", lateEditStrategy: "full_snapshot", deletionStrategy: "no_absence_deletes", dependencies: ["shopify_orders", "shopify_order_lines"], productDomains: ["sales", "products"], canonicalTargets: ["commerce_refund_line", "location", "stock_location", "event_link"], authorityConcept: "operational_sales" },
  { id: "shopify_inventory_levels", resource: "InventoryLevel", endpoint: "inventoryItems.inventoryLevels", modifiedField: "updatedAt", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "no_absence_deletes", dependencies: ["shopify_locations", "shopify_product_variants"], productDomains: ["inventory", "products"], canonicalTargets: ["inventory_balance_snapshot"], authorityConcept: "stock" },
  { id: "shopify_fulfillments", resource: "Fulfillment", endpoint: "orders.fulfillments", modifiedField: "updatedAt", pagination: "vendor_cursor", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "no_absence_deletes", dependencies: ["shopify_orders"], productDomains: ["sales", "inventory"], canonicalTargets: ["metadata"], authorityConcept: "operational_sales" },
  { id: "shopify_returns", resource: "Return", endpoint: "orders.returns", modifiedField: "updatedAt", pagination: "vendor_cursor", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "no_absence_deletes", availability: "optional", dependencies: ["shopify_orders"], productDomains: ["sales", "inventory"], canonicalTargets: ["metadata"], authorityConcept: "operational_sales" },
  { id: "shopify_discounts", resource: "DiscountNode", endpoint: "discountNodes", modifiedField: "updatedAt", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "verified_delete_feed", availability: "optional", productDomains: ["sales", "customers", "products"], canonicalTargets: ["metadata"], authorityConcept: "operational_sales" },
  { id: "shopify_metafield_definitions", resource: "MetafieldDefinition", endpoint: "metafieldDefinitions", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "full_snapshot", deletionStrategy: "authoritative_identity_scan", availability: "optional", dependencies: ["shopify_shop"], productDomains: ["sales", "inventory", "customers", "products"], canonicalTargets: ["metadata"], authorityConcept: "product_master" },
  { id: "shopify_metafield_values", resource: "Metafield", endpoint: "metafieldDefinitions.metafields", modifiedField: "updatedAt", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "full_snapshot", deletionStrategy: "authoritative_identity_scan", availability: "optional", dependencies: ["shopify_metafield_definitions"], productDomains: ["sales", "inventory", "customers", "products"], canonicalTargets: ["metadata"], authorityConcept: "product_master" },
  { id: "shopify_fields", resource: "GraphQLFieldObservation", endpoint: "schema-driven QueryRoot", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "full_snapshot", deletionStrategy: "authoritative_identity_scan", dependencies: ["shopify_shop"], productDomains: ["sales", "inventory", "customers", "products"], canonicalTargets: ["metadata"], authorityConcept: "operational_sales" },
] as const;

export const SHOPIFY_STREAMS: readonly StreamContract[] = Object.freeze(seeds.map((seed) => ({
  ...seed,
  recordIdField: seed.recordIdField ?? "id",
  sourceTotalStrategy: seed.backfillStrategy === "time_windowed"
    ? "count_distinct_bounded_scan" as const
    : "count_distinct_complete_scan" as const,
  dependencies: seed.dependencies ?? [],
  ...(seed.id === "shopify_inventory_levels" ? { reprocessIdenticalPayloadOnNewBatch: true } : {}),
})));

const canonicalTargets: Readonly<Record<ShopifyStreamId, Readonly<Record<string, string>>>> = {
  shopify_shop: {
    id: "metadata.source_record_id",
    name: "location.name",
    myshopifyDomain: "location.name",
    ianaTimezone: "location.timezone",
  },
  shopify_locations: {
    id: "location.source_id",
    name: "location.name",
    active: "location.active",
    address: "identity_hint.deterministic_keys.location_name_address",
  },
  shopify_products: {
    id: "product.source_id",
    title: "product.name",
    status: "product.active",
    categoryId: "product_category.source_id",
    categoryName: "product_category.name",
  },
  shopify_product_variants: {
    id: "product_variant.source_id",
    productId: "product_variant.product_id",
    categoryId: "product_category.source_id",
    categoryName: "product_category.name",
    title: "product_variant.name",
    displayName: "product_variant.name",
    sku: "product_variant.sku",
    barcode: "product_variant.barcode",
  },
  shopify_customers: {
    id: "customer_account.source_id",
    displayName: "customer_account.display_name",
    firstName: "customer_account.display_name",
    lastName: "customer_account.display_name",
    email: "identity_hint.deterministic_keys.email",
    phone: "identity_hint.deterministic_keys.phone",
  },
  shopify_orders: {
    id: "commerce_order.source_id",
    customerId: "commerce_order.customer_account_id",
    locationId: "commerce_order.location_id",
    createdAt: "commerce_order.ordered_at",
    processedAt: "commerce_order.completed_at",
    closedAt: "commerce_order.completed_at",
    cancelledAt: "commerce_order.voided",
    displayFinancialStatus: "commerce_order.status",
    currencyCode: "commerce_order.currency",
    totalPriceAmount: "commerce_order.net_amount_inc_tax",
    totalTaxAmount: "commerce_order.tax_amount",
    totalDiscountsAmount: "commerce_order.discount_amount",
    test: "commerce_order.internal_transaction",
  },
  shopify_order_lines: {
    id: "commerce_order_line.source_id",
    orderId: "commerce_order_line.order_id",
    variantId: "commerce_order_line.product_variant_id",
    locationId: "commerce_order_line.location_id",
    customerId: "commerce_order_line.customer_account_id",
    orderCreatedAt: "commerce_order_line.ordered_at",
    orderProcessedAt: "commerce_order_line.completed_at",
    orderClosedAt: "commerce_order_line.completed_at",
    orderCancelledAt: "commerce_order_line.voided",
    orderFinancialStatus: "commerce_order_line.order_status",
    currencyCode: "commerce_order_line.currency",
    taxesIncluded: "commerce_order_line.tax_treatment",
    orderTest: "commerce_order_line.internal_transaction",
    quantity: "commerce_order_line.quantity",
    originalUnitPriceAmount: "commerce_order_line.unit_price",
    originalTotalAmount: "commerce_order_line.gross_amount",
    discountedTotalAmount: "commerce_order_line.net_amount_inc_tax",
    totalDiscountAmount: "commerce_order_line.discount_amount",
    totalTaxAmount: "commerce_order_line.tax_amount",
  },
  shopify_transactions: {
    id: "commerce_payment.source_id",
    orderId: "commerce_payment.order_id",
    createdAt: "commerce_payment.paid_at",
    processedAt: "commerce_payment.paid_at",
    kind: "commerce_payment.status",
    status: "commerce_payment.status",
    locationId: "commerce_payment.location_id",
    gateway: "commerce_payment.tender_type",
    paymentMethod: "commerce_payment.tender_type",
    amount: "commerce_payment.amount",
    currencyCode: "commerce_payment.currency",
  },
  shopify_refund_lines: {
    id: "commerce_refund_line.source_id",
    refundId: "event_link.evidence.refund_id",
    lineItemId: "commerce_refund_line.original_order_line_id",
    variantId: "commerce_refund_line.product_variant_id",
    locationId: "commerce_refund_line.location_id",
    orderLocationId: "commerce_refund_line.location_id",
    currencyCode: "commerce_refund_line.currency",
    quantity: "commerce_refund_line.quantity",
    subtotalAmount: "commerce_refund_line.refund_amount_ex_tax",
    taxAmount: "commerce_refund_line.tax_amount",
    totalAmount: "commerce_refund_line.refund_amount_inc_tax",
    refundedAt: "commerce_refund_line.refunded_at",
  },
  shopify_inventory_levels: {
    id: "inventory_balance_snapshot.source_id",
    variantId: "inventory_balance_snapshot.product_variant_id",
    locationId: "inventory_balance_snapshot.stock_location_id",
    updatedAt: "inventory_balance_snapshot.snapshot_at",
    available: "inventory_balance_snapshot.quantity_on_hand",
    onHand: "inventory_balance_snapshot.quantity_on_hand",
  },
  shopify_fulfillments: {},
  shopify_returns: {},
  shopify_discounts: {},
  shopify_metafield_definitions: {},
  shopify_metafield_values: {},
  shopify_fields: {},
};

const coverage: FieldCoverage[] = [];
for (const stream of Object.keys(SHOPIFY_STREAM_FIELDS) as ShopifyStreamId[]) {
  const canonical = canonicalTargets[stream];
  for (const field of SHOPIFY_STREAM_FIELDS[stream]) {
    const target = canonical[field.name];
    coverage.push({
      stream,
      field: field.name,
      disposition: target ? "canonical" : "governed_extension",
      stagingType: field.type,
      ...(target ? { target } : { target: `source_shopify.${stream}.${snake(field.name)}` }),
      pii: field.pii ?? piiForRawNode(stream, field.name),
    });
  }
}

const schemaRegistry = loadShopifyAdminSchemaRegistry();
const fieldAvailability = new Map(
  SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY.map((entry) => [entry.schemaPath, entry]),
);
for (const type of schemaRegistry.types) {
  for (const field of type.fields ?? []) {
    const availability = fieldAvailability.get(`${type.name}.${field.name}`);
    const unsupportedReason = availability && ![
      "observed_curated", "generic_metafield_ingested", "runtime_observation_required",
      "protected_approval_required",
    ].includes(availability.availability) ? availability.reason : null;
    coverage.push({
      stream: "shopify_fields",
      field: `${type.name}.${field.name}`,
      disposition: unsupportedReason ? "unsupported" : "governed_extension",
      stagingType: schemaFieldType(field.type),
      ...(unsupportedReason ? { reason: unsupportedReason } : {
        storageField: "nodePayload",
        storageType: "jsonb",
        queryPath: field.name,
        queryable: true,
        target: "source_shopify.shopify_fields.node_payload",
        ...(field.isDeprecated ? { reason: `Deprecated by Shopify${field.deprecationReason ? `: ${field.deprecationReason}` : "."}` } : {}),
      }),
      pii: field.isProtected ? "customer_contact" : "none",
    });
    for (const argument of field.args) {
      coverage.push({
        stream: "shopify_fields",
        field: `${type.name}.${field.name}(${argument.name})`,
        disposition: "governed_extension",
        stagingType: schemaFieldType(argument.type),
        storageField: "nodePayload",
        storageType: "jsonb",
        queryPath: `argument.${argument.name}`,
        queryable: true,
        target: "source_shopify.shopify_fields.node_payload",
        reason: "Official GraphQL field-argument definition; query-construction metadata only, never an observed merchant value.",
        pii: "none",
      });
    }
  }
  for (const field of type.inputFields ?? []) {
    coverage.push({
      stream: "shopify_fields",
      field: `${type.name}.${field.name}`,
      disposition: "governed_extension",
      stagingType: schemaFieldType(field.type),
      storageField: "nodePayload",
      storageType: "jsonb",
      queryPath: field.name,
      queryable: true,
      target: "source_shopify.shopify_fields.node_payload",
      reason: "Official GraphQL input-object field definition; query-construction metadata only, never an observed merchant value.",
      pii: "none",
    });
  }
  for (const value of type.enumValues ?? []) {
    coverage.push({
      stream: "shopify_fields",
      field: `${type.name}.${value.name}`,
      disposition: "governed_extension",
      stagingType: "text",
      storageField: "nodePayload",
      storageType: "jsonb",
      queryPath: value.name,
      queryable: true,
      target: "source_shopify.shopify_fields.node_payload",
      reason: "Official GraphQL enum option definition; query-construction/interpretation metadata only, never an observed merchant value.",
      pii: "none",
    });
  }
}

const shopifyQlRegistry = loadShopifyQLSchemaRegistry();
for (const schema of shopifyQlRegistry.schemas) {
  for (const role of ["metrics", "dimensions"] as const) {
    for (const field of schema[role]) {
      coverage.push({
        stream: "shopify_fields",
        field: `ShopifyQL.${schema.name}.${role}.${field.name}`,
        disposition: "governed_extension",
        stagingType: shopifyQlFieldType(field.type),
        storageField: "nodePayload",
        storageType: "jsonb",
        queryPath: `field.${field.name}`,
        queryable: true,
        target: "source_shopify.shopify_fields.node_payload",
        reason: `Official ${role === "metrics" ? "metric" : "dimension"} definition. Store values require read_reports, Level 2 protected-customer-data approval, and a validated bounded ShopifyQL query.`,
        pii: "none",
      });
    }
  }
  for (const expression of schema.matches) {
    coverage.push({
      stream: "shopify_fields",
      field: `ShopifyQL.${schema.name}.matches.${expression.name}`,
      disposition: "governed_extension",
      stagingType: "jsonb",
      storageField: "nodePayload",
      storageType: "jsonb",
      queryPath: `expression.${expression.name}`,
      queryable: true,
      target: "source_shopify.shopify_fields.node_payload",
      reason: "Official MATCHES expression definition; it is planner metadata and not an observed store value.",
      pii: "none",
    });
  }
  for (const condition of schema.matchConditions) {
    for (const field of condition.fields) {
      coverage.push({
        stream: "shopify_fields",
        field: `ShopifyQL.${schema.name}.matchConditions.${condition.name}.${field.name}`,
        disposition: "governed_extension",
        stagingType: shopifyQlFieldType(field.type),
        storageField: "nodePayload",
        storageType: "jsonb",
        queryPath: `field.${field.name}`,
        queryable: true,
        target: "source_shopify.shopify_fields.node_payload",
        reason: `Official ${condition.name} ${field.role} definition; it is planner metadata and not an observed store value.`,
        pii: "none",
      });
    }
  }
}
for (const schema of shopifyQlRegistry.undocumentedSchemas) {
  coverage.push({
    stream: "shopify_fields",
    field: `ShopifyQL.${schema.name}`,
    disposition: "unsupported",
    stagingType: "jsonb",
    reason: "Shopify lists this FROM name but publishes no field-reference page; Albert records the official gap and does not fabricate fields.",
    pii: "none",
  });
}

function schemaFieldType(typeRef: string): FieldCoverage["stagingType"] {
  const named = shopifyGraphQLNamedType(typeRef);
  if (named === "Boolean") return "boolean";
  if (["Int", "Float", "Decimal", "UnsignedInt64"].includes(named)) return "numeric";
  if (named === "Date") return "date";
  if (["DateTime", "TimeWithoutTimezone"].includes(named)) return "timestamptz";
  const registered = schemaRegistry.types.find((type) => type.name === named);
  return registered?.kind === "SCALAR" || registered?.kind === "ENUM" ? "text" : "jsonb";
}

function shopifyQlFieldType(type: string): FieldCoverage["stagingType"] {
  if (type === "BOOLEAN") return "boolean";
  if (["DECIMAL", "FLOAT", "INTEGER", "MONEY", "PERCENTAGE"].includes(type)) return "numeric";
  if (type === "DATE") return "date";
  if (type.includes("TIMESTAMP")) return "timestamptz";
  return "text";
}

function piiForRawNode(stream: ShopifyStreamId, field: string): PiiClass {
  if (field !== "rawNode" && field !== "nodePayload") return "none";
  if (stream === "shopify_customers" || stream === "shopify_orders" || stream === "shopify_metafield_values") return "customer_contact";
  return "none";
}

function snake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

export const shopifyManifest: ConnectorManifest = {
  id: "shopify",
  displayName: "Shopify",
  packVersion: "1.0.0",
  apiVersion: `Admin GraphQL ${SHOPIFY_API_VERSION}`,
  releasedAt: "2026-08-12",
  documentation: [
    "https://shopify.dev/docs/api/admin-graphql/2026-07",
    "https://shopify.dev/docs/api/usage/bulk-operations/queries",
    "https://shopify.dev/docs/api/usage/limits",
    "https://shopify.dev/docs/api/usage/versioning",
    "https://shopify.dev/docs/api/usage/access-scopes",
    "https://shopify.dev/docs/apps/launch/protected-customer-data",
    "https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens",
    "https://shopify.dev/docs/api/shopifyql/2026-07/schemas",
  ],
  ingestion: { initialStart: "manual" },
  oauth: {
    scopes: SHOPIFY_DEFAULT_SCOPES,
    leastPrivilegeNotes: [
      "Albert requests read-only scopes and contains no Admin API write mutation.",
      "read_all_orders, Shopify Payments, B2B, subscriptions, POS cash, store credit and staff modules remain separately approved optional capabilities; absence is reported, never interpreted as zero.",
    ],
    refreshTokenRotation: true,
    remoteRevocation: "not_documented",
  },
  streams: SHOPIFY_STREAMS,
  sourceAuthority: {
    defaults: [
      { concepts: ["operational_sales", "cash_settlement"], scope: { kind: "connection_account" } },
      { concepts: ["stock", "product_master", "customer_master"], scope: { kind: "connection_account" } },
    ],
  },
  rateLimit: {
    algorithm: "GraphQL calculated query cost plus throttleStatus-directed retry and bounded full jitter",
    concurrency: 5,
    budgets: { normalQueryMaximumCost: 1000, concurrentBulkQueriesPerShop: 5, bulkMaximumRuntimeDays: 10 },
    responseHeaders: ["Retry-After", "X-Shopify-API-Version", "X-Request-ID"],
    reservations: [{ key: "shopify.admin_graphql", burstCapacity: 1, interval: { kind: "fixed", milliseconds: 1_000 } }],
  },
  webhook: {
    verifiedTombstones: {
      jobReason: "webhook",
      requireReceipt: true,
      payloadSignalType: "verified_shopify_webhook_tombstone",
    },
  },
  capabilities: {
    "commerce.orders": { support: "unknown", streams: ["shopify_orders"], reason: "Confirmed after an Order query succeeds for the granted store." },
    "commerce.orders.customer": { support: "partial", streams: ["shopify_orders", "shopify_customers"], coverageFields: ["customerId"], requiresObservedCoverage: true, reason: "Protected customer data approval and the granted merchant account determine customer detail coverage." },
    "commerce.order_lines": { support: "unknown", streams: ["shopify_order_lines"], reason: "Confirmed after the nested LineItem walk succeeds." },
    "commerce.order_lines.discounts": { support: "full", streams: ["shopify_order_lines"], reason: "Applied discount totals are selected on each line; discount intent is retained separately." },
    "commerce.order_lines.cost": { support: "unavailable", streams: ["shopify_order_lines"], reason: "Current InventoryItem.unitCost is not a truthful historical line cost. ShopifyQL profitability is the official historical source when approved." },
    "commerce.payments": { support: "unknown", streams: ["shopify_transactions"], reason: "Confirmed after OrderTransaction extraction succeeds." },
    "commerce.refunds": { support: "unknown", streams: ["shopify_refund_lines"], reason: "Confirmed after RefundLineItem extraction succeeds." },
    "inventory.balances": { support: "unknown", streams: ["shopify_inventory_levels"], reason: "All official inventory quantity states are extracted and periodically reconciled." },
    "inventory.cost": { support: "partial", streams: ["shopify_product_variants", "shopify_inventory_levels"], reason: "Unit cost is separately permission-gated and current cost must not be applied retroactively." },
    "inventory.movements": { support: "unavailable", streams: ["shopify_inventory_levels"], reason: "This pack ingests reconciled current inventory-level states only. It does not materialize Shopify adjustment groups as canonical inventory movements, so historical movement questions must be reported as unavailable rather than inferred from snapshot deltas." },
    "source.webhooks": { support: "unavailable", streams: [], reason: "No operational data webhook subscriptions are configured. Mandatory compliance and uninstall webhooks are isolated from ingestion; polling and reconciliation are the production completeness authority." },
  },
  identityRules: [
    "Shopify GIDs are the immutable source identities; legacyResourceId is retained only as an external alias.",
    "A shop is bound to its exact lower-case myshopify.com domain across OAuth state, credential metadata, connection identity and every API request.",
    "Customer email and phone are reviewable identity hints only and are never used for an automatic cross-source merge.",
  ],
  topology: [
    "Shopify orders, lines, transactions, refunds, returns and fulfillments remain separate grains; a merchandise return is not assumed to be a gateway refund.",
    "Shop and presentment currencies are retained separately. Settlement and payout currency belong to their own event grains.",
    "The exhaustive field stream is a generated schema-backed long-tail plane; promoted columns and canonical facts are the reviewed fast path.",
    `Metafield definitions and values are cursor-paginated for ${SHOPIFY_METAFIELD_OWNER_POLICIES.filter(({ liveCoverage }) => liveCoverage === "default_read_surface").length} least-privilege owner types; all ${SHOPIFY_METAFIELD_OWNER_POLICIES.length} official owner types have an explicit live or definition-only disposition.`,
    "Connection succeeds without moving data. Only the authenticated Start ingestion action activates the current connection generation.",
  ],
  fieldCoverage: Object.freeze(coverage),
  qualityAssertions: [
    "schema_registry_exact_2026_07",
    "cursor_completeness",
    "scope_available",
    "protected_data_disposition",
    "inventory_state_reconciled",
    "money_currency_paired",
    "order_line_header_reconciles",
    "refund_payment_return_grains_distinct",
  ],
  limitations: [
    "Shopify exposes only the most recent 60 days of orders until the app is approved for read_all_orders; Albert states the observed boundary in answers.",
    "Shopify's events ledger retains one year of activity. After manual activation Albert polls action:destroy with an independent, closed created-at window for PRODUCT, PRODUCT_VARIANT, CUSTOMER, ORDER and DISCOUNT_NODE. If the feed is unavailable or invalid, or continuity is missing, unproven across generations, or older than one year, the check fails closed and every private Shopify Cube excludes that exact connection. Reauthorization alone cannot clear the fence: recovery requires a full Disconnect, waiting for verified local deletion to complete, reconnecting, and an explicit new Start ingestion action.",
    "Shopify does not document destroy events for line items, transactions, refund lines, fulfillments or returns. For each updated order Albert replaces those five child identity sets only after a complete collection observation, tombstones exact missing children, and retires corresponding canonical sales/payment/refund facts; partial or fixed-cap selections fail closed and never become absence evidence. Global bounded reconciliation absence is still forbidden by no_absence_deletes.",
    "Inventory-level absence is not treated as deletion. A product or variant destroy hides its inventory through the exact live-parent gate, but an isolated inventory-level removal for a still-live variant can remain in historical staging and is never presented as a fabricated movement.",
    "Protected customer data, plan-only fields, merchant staff permissions and optional modules can redact fields even when a related OAuth scope is present.",
    "SubscriptionContract exposes only contracts owned by this app; store-wide subscription detail from other apps is not available through Admin GraphQL.",
    "ShopifyQL requires read_reports and Level 2 protected-customer-data approval. Without both, official traffic, search, attribution and profitability datasets are reported as unavailable.",
    "A nested order, return, refund, transaction or fulfilment selection that reaches Shopify's fixed 250-item safety boundary fails closed. The affected stream is unavailable until a reviewed narrower query is shipped; Albert never reports the truncated selection as complete.",
    "Metafield literal values are ingested privately, but treated as unclassified sensitive data and redacted from public Cube views because merchants can store personal or confidential content in any namespace.",
    `The pinned ${SHOPIFY_API_VERSION} registries disposition ${schemaRegistry.counts.fields.toLocaleString("en-US")} Admin GraphQL output fields and materialize ${schemaRegistry.counts.inputFields.toLocaleString("en-US")} input fields, ${schemaRegistry.counts.fieldArguments.toLocaleString("en-US")} field arguments, ${schemaRegistry.counts.enumValues.toLocaleString("en-US")} enum options, and ${shopifyQlRegistry.counts.fields.toLocaleString("en-US")} ShopifyQL metrics/dimensions as searchable definitions. Query-construction members and write mutations are never fabricated as store observations.`,
  ],
  unknownFieldPolicy: "quarantine_schema_drift",
};
