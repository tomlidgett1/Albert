import type { StagingFieldType } from "../../packages/connector-sdk/src/index.js";

export type ShopifyStreamId =
  | "shopify_shop"
  | "shopify_locations"
  | "shopify_products"
  | "shopify_product_variants"
  | "shopify_customers"
  | "shopify_orders"
  | "shopify_order_lines"
  | "shopify_transactions"
  | "shopify_refund_lines"
  | "shopify_inventory_levels"
  | "shopify_fulfillments"
  | "shopify_returns"
  | "shopify_discounts"
  | "shopify_metafield_definitions"
  | "shopify_metafield_values"
  | "shopify_fields";

export type ShopifyPhysicalField = Readonly<{
  name: string;
  type: StagingFieldType;
  pii?: "none" | "business_contact" | "customer_contact" | "free_text_untrusted";
  canonical?: string;
}>;

const f = (
  name: string,
  type: StagingFieldType = "text",
  options: Omit<ShopifyPhysicalField, "name" | "type"> = {},
): ShopifyPhysicalField => Object.freeze({ name, type, ...options });

const raw = f("rawNode", "jsonb");
const id = f("id");
const legacy = f("legacyResourceId");
const created = f("createdAt", "timestamptz");
const updated = f("updatedAt", "timestamptz");
const money = (name: string) => f(name, "numeric");
const bool = (name: string) => f(name, "boolean");
const json = (name: string, pii: ShopifyPhysicalField["pii"] = "none") => f(name, "jsonb", { pii });
const time = (name: string) => f(name, "timestamptz");

/**
 * Stable promoted columns. The complete 2026-07 schema is exposed separately
 * through shopify_fields, so adding an official field never requires a wide
 * table migration before it can be queried.
 */
export const SHOPIFY_STREAM_FIELDS: Readonly<Record<ShopifyStreamId, readonly ShopifyPhysicalField[]>> = Object.freeze({
  shopify_shop: [
    id, f("name"), f("myshopifyDomain"), f("primaryDomainHost"),
    f("email", "text", { pii: "business_contact" }),
    f("contactEmail", "text", { pii: "business_contact" }),
    f("currencyCode"), json("billingAddress", "business_contact"), f("ianaTimezone"),
    f("timezoneAbbreviation"), f("planDisplayName"), f("customerAccounts"), created, updated, raw,
  ],
  shopify_locations: [
    id, legacy, f("name"), bool("active"), json("address", "business_contact"),
    bool("fulfillsOnlineOrders"), bool("shipsInventory"), bool("hasActiveInventory"),
    bool("hasUnfulfilledOrders"), created, updated, raw,
  ],
  shopify_products: [
    id, legacy, f("title"), f("handle"), f("description", "text", { pii: "free_text_untrusted" }),
    f("descriptionHtml", "text", { pii: "free_text_untrusted" }), f("vendor"), f("productType"),
    f("status"), json("tags"), f("templateSuffix"), f("categoryId"), f("categoryName"),
    money("totalInventory"), bool("tracksInventory"), created, updated, time("publishedAt"),
    f("onlineStoreUrl"), f("seoTitle"), f("seoDescription", "text", { pii: "free_text_untrusted" }), raw,
  ],
  shopify_product_variants: [
    id, legacy, f("productId"), f("categoryId"), f("categoryName"),
    f("title"), f("displayName"), f("sku"), f("barcode"),
    money("price"), money("compareAtPrice"), f("inventoryPolicy"), money("inventoryQuantity"),
    money("sellableOnlineQuantity"), bool("taxable"), f("taxCode"), bool("availableForSale"),
    money("position"), created, updated, raw,
  ],
  shopify_customers: [
    id, legacy, f("displayName", "text", { pii: "customer_contact" }),
    f("firstName", "text", { pii: "customer_contact" }), f("lastName", "text", { pii: "customer_contact" }),
    f("email", "text", { pii: "customer_contact" }), f("phone", "text", { pii: "customer_contact" }),
    f("state"), json("tags"), f("note", "text", { pii: "free_text_untrusted" }), f("locale"),
    bool("verifiedEmail"), bool("validEmailAddress"), bool("taxExempt"), money("numberOfOrders"),
    money("amountSpent"), created, updated, raw,
  ],
  shopify_orders: [
    id, legacy, f("name"), money("number"), f("confirmationNumber"),
    f("email", "text", { pii: "customer_contact" }), f("phone", "text", { pii: "customer_contact" }),
    f("customerId"), f("locationId"), f("appId"), f("channelName"), f("sourceName"),
    created, time("processedAt"), updated, time("cancelledAt"), time("closedAt"), f("cancelReason"),
    f("displayFinancialStatus"), f("displayFulfillmentStatus"), f("currencyCode"), f("presentmentCurrencyCode"),
    money("subtotalAmount"), money("totalDiscountsAmount"), money("totalShippingAmount"), money("totalTaxAmount"),
    money("totalRefundedAmount"), money("totalOutstandingAmount"), money("totalPriceAmount"),
    money("currentSubtotalAmount"), money("currentTotalDiscountsAmount"), money("currentTotalTaxAmount"),
    money("currentTotalPriceAmount"), bool("test"), bool("taxesIncluded"), bool("confirmed"), bool("fullyPaid"),
    json("tags"), f("note", "text", { pii: "free_text_untrusted" }),
    json("billingAddress", "customer_contact"), json("shippingAddress", "customer_contact"), raw,
  ],
  shopify_order_lines: [
    id, f("orderId"), f("productId"), f("variantId"), f("name"), f("title"), f("sku"), f("vendor"),
    f("collectionScanId"), bool("collectionComplete"),
    f("locationId"), f("customerId"), f("channelName"), f("sourceName"),
    time("orderCreatedAt"), time("orderProcessedAt"), time("orderClosedAt"), time("orderCancelledAt"),
    f("orderFinancialStatus"), f("orderFulfillmentStatus"), f("currencyCode"),
    bool("taxesIncluded"), bool("orderTest"),
    money("quantity"), money("currentQuantity"), money("refundableQuantity"), money("fulfillableQuantity"),
    money("unfulfilledQuantity"), bool("requiresShipping"), bool("taxable"), money("originalUnitPriceAmount"),
    money("discountedUnitPriceAmount"), money("originalTotalAmount"), money("discountedTotalAmount"),
    money("totalDiscountAmount"), money("totalTaxAmount"), raw,
  ],
  shopify_transactions: [
    id, f("orderId"), f("parentTransactionId"), created, time("processedAt"), f("kind"), f("status"),
    f("collectionScanId"), bool("collectionComplete"),
    f("locationId"), f("channelName"), f("sourceName"),
    f("gateway"), f("paymentId"), f("authorizationCode"), money("amount"), f("currencyCode"), bool("test"),
    bool("manuallyCapturable"), money("maximumRefundable"), f("paymentMethod"), raw,
  ],
  shopify_refund_lines: [
    id, f("refundId"), f("orderId"), f("lineItemId"), f("variantId"), f("locationId"),
    f("collectionScanId"), bool("collectionComplete"),
    f("orderLocationId"), f("currencyCode"), money("quantity"), f("restockType"),
    money("subtotalAmount"), money("taxAmount"), money("totalAmount"), time("refundedAt"), raw,
  ],
  shopify_inventory_levels: [
    id, f("inventoryItemId"), f("variantId"), f("locationId"), updated, bool("canDeactivate"), money("available"), money("incoming"),
    money("onHand"), money("committed"), money("reserved"), money("damaged"), money("safetyStock"),
    money("qualityControl"), raw,
  ],
  shopify_fulfillments: [
    id, f("orderId"), f("name"), f("status"), f("displayStatus"), created, updated, time("deliveredAt"),
    f("collectionScanId"), bool("collectionComplete"),
    time("estimatedDeliveryAt"), time("inTransitAt"), money("totalQuantity"), json("trackingInfo"),
    f("locationId"), f("serviceHandle"), raw,
  ],
  shopify_returns: [
    id, f("orderId"), f("name"), f("status"), created, updated, time("closedAt"), money("totalQuantity"),
    f("collectionScanId"), bool("collectionComplete"),
    money("exchangeLineItemCount"), money("returnLineItemCount"), money("refundCount"), raw,
  ],
  shopify_discounts: [
    id, f("typename"), f("title"), f("status"), created, updated, time("startsAt"), time("endsAt"),
    money("totalSales"), money("usageLimit"), money("asyncUsageCount"), json("discountClasses"),
    json("combinesWith"), raw,
  ],
  shopify_metafield_definitions: [
    id, f("name"), f("namespace"), f("key"), f("ownerType"),
    f("typeName"), f("typeCategory"),
    f("description", "text", { pii: "free_text_untrusted" }),
    f("adminAccess"), f("storefrontAccess"), f("customerAccountAccess"),
    json("capabilities"), json("constraints"), json("validations"),
    f("validationStatus"), money("pinnedPosition"), bool("useAsCollectionCondition"),
    money("metafieldsCount"), time("observedAt"), raw,
  ],
  shopify_metafield_values: [
    id, legacy, f("definitionId"), f("ownerId", "text", { pii: "customer_contact" }), f("ownerType"), f("ownerGraphqlType"),
    f("namespace"), f("key"), f("metafieldType"),
    f("value", "text", { pii: "customer_contact" }),
    json("jsonValue", "customer_contact"),
    f("numericValue", "numeric", { pii: "customer_contact" }),
    f("booleanValue", "boolean", { pii: "customer_contact" }),
    f("datetimeValue", "timestamptz", { pii: "customer_contact" }),
    money("sizeInBytes"), f("compareDigest", "text", { pii: "customer_contact" }), created, updated,
    f("rawNode", "jsonb", { pii: "customer_contact" }),
  ],
  shopify_fields: [
    id, f("definitionKind"), f("schemaPath"), f("rootField"), f("objectType"), f("graphqlId"), f("parentGraphqlId"), f("fieldName"),
    f("fieldType"), f("valueKind"), f("valueForm"), f("observationForm"), money("ordinal"), f("jsonPointer"),
    f("stringValue"), money("numericValue"), bool("booleanValue"),
    time("datetimeValue"), json("jsonValue"), json("nodePayload"), f("apiVersion"), json("requiredScopes"),
    f("requiredAccess"), json("fieldArguments"), f("description"), f("protectedDataLevel"),
    f("availability"), f("availabilityReason"), bool("deprecated"), f("deprecationReason"),
    f("documentationUrl"), f("schemaSha256"), time("observedAt"),
  ],
});

export const SHOPIFY_STREAM_IDS = Object.freeze(Object.keys(SHOPIFY_STREAM_FIELDS) as ShopifyStreamId[]);
