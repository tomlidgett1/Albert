import type { ShopifyStreamId } from "./streams.js";

export type ShopifyQueryPlan = Readonly<{
  query: string;
  root: string;
  shape:
    | "single"
    | "connection"
    | "nested_connection"
    | "nested_list"
    | "refund_lines"
    | "metafield_definitions"
    | "metafield_values";
}>;

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const MONEY = "amount currencyCode";
const ADDRESS = "address1 address2 city company country countryCodeV2 firstName lastName phone province provinceCode zip";
const LOCATION_ADDRESS = "address1 address2 city country countryCode phone province provinceCode zip";

/**
 * Shopify's non-deprecated event ledger is the only reviewed polling surface
 * that exposes destroy events for all of Albert's promoted parent grains. The
 * caller supplies one subject type per stream and a closed created-at window;
 * keeping this query separate from the resource query gives it an independent
 * opaque cursor and watermark.
 */
export const SHOPIFY_DELETION_EVENTS_QUERY = `query AlbertDeletionEvents(
  $first:Int!
  $after:String
  $query:String!
) {
  events(first:$first,after:$after,sortKey:CREATED_AT,query:$query) {
    edges { cursor node {
      id action createdAt
      ... on BasicEvent { subjectId subjectType }
    } }
    ${PAGE_INFO}
  }
}`;

/**
 * Owner types that have a reviewed, least-privilege read path in this pack.
 * Shopify exposes additional owner types, but many are plan-, permission-, or
 * app-ownership-bound; those remain explicitly definition-only.
 */
export type ShopifyMetafieldOwnerPolicy = Readonly<{
  ownerType: string;
  liveCoverage: "default_read_surface" | "definition_only";
  boundary: "default_scope" | "optional_scope" | "plan_or_permission" | "app_ownership" | "no_reviewed_enumerator";
  requiredScopes: readonly string[];
  reason: string;
}>;

/**
 * Exact disposition of every owner enum in the pinned registry. Only owner
 * types reached through the connector's default least-privilege read surface
 * are enumerated live. Other definitions remain fully answerable from the
 * offline schema census without causing an unattended optional-scope failure.
 */
export const SHOPIFY_METAFIELD_OWNER_POLICIES: readonly ShopifyMetafieldOwnerPolicy[] = Object.freeze([
  { ownerType: "SHOP", liveCoverage: "default_read_surface", boundary: "default_scope", requiredScopes: [], reason: "Shop metafields require no optional module beyond the installed app." },
  { ownerType: "PRODUCT", liveCoverage: "default_read_surface", boundary: "default_scope", requiredScopes: ["read_products"], reason: "Covered by the default read_products scope." },
  { ownerType: "PRODUCTVARIANT", liveCoverage: "default_read_surface", boundary: "default_scope", requiredScopes: ["read_products"], reason: "Covered by the default read_products scope." },
  { ownerType: "COLLECTION", liveCoverage: "default_read_surface", boundary: "default_scope", requiredScopes: ["read_products"], reason: "Covered by the default read_products scope." },
  { ownerType: "LOCATION", liveCoverage: "default_read_surface", boundary: "default_scope", requiredScopes: ["read_locations"], reason: "Covered by the default read_locations scope." },
  { ownerType: "ORDER", liveCoverage: "default_read_surface", boundary: "default_scope", requiredScopes: ["read_orders"], reason: "Covered by read_orders; the ordinary 60-day order boundary still applies to order retrieval." },
  { ownerType: "DISCOUNT", liveCoverage: "default_read_surface", boundary: "default_scope", requiredScopes: ["read_discounts"], reason: "Covered by the default read_discounts scope." },
  { ownerType: "CUSTOMER", liveCoverage: "default_read_surface", boundary: "default_scope", requiredScopes: ["read_customers"], reason: "Covered by read_customers and subject to protected-customer-data approval." },
  { ownerType: "ARTICLE", liveCoverage: "definition_only", boundary: "optional_scope", requiredScopes: ["read_content"], reason: "Live article metafields require optional online-store content access, which Albert does not request by default." },
  { ownerType: "BLOG", liveCoverage: "definition_only", boundary: "optional_scope", requiredScopes: ["read_content"], reason: "Live blog metafields require optional online-store content access, which Albert does not request by default." },
  { ownerType: "PAGE", liveCoverage: "definition_only", boundary: "optional_scope", requiredScopes: ["read_content"], reason: "Live page metafields require optional online-store content access, which Albert does not request by default." },
  { ownerType: "CARTTRANSFORM", liveCoverage: "definition_only", boundary: "app_ownership", requiredScopes: ["read_cart_transforms"], reason: "Cart-transform resources require optional read_cart_transforms access and are app-owned configuration, not a generic merchant analytics population." },
  { ownerType: "COMPANY", liveCoverage: "definition_only", boundary: "plan_or_permission", requiredScopes: ["read_companies"], reason: "Company metafields require optional B2B access and a shop plan/permission that supports B2B." },
  { ownerType: "COMPANY_LOCATION", liveCoverage: "definition_only", boundary: "plan_or_permission", requiredScopes: ["read_companies"], reason: "Company-location metafields require optional B2B access and a shop plan/permission that supports B2B." },
  { ownerType: "DELIVERY_CUSTOMIZATION", liveCoverage: "definition_only", boundary: "app_ownership", requiredScopes: ["read_delivery_customizations"], reason: "Delivery customizations require an optional scope and are app/function configuration, not part of Albert's default merchant-data grant." },
  { ownerType: "DRAFTORDER", liveCoverage: "definition_only", boundary: "optional_scope", requiredScopes: ["read_draft_orders"], reason: "Draft-order metafields require optional read_draft_orders access and are not included in Albert's default commerce ingestion." },
  { ownerType: "FULFILLMENT_CONSTRAINT_RULE", liveCoverage: "definition_only", boundary: "app_ownership", requiredScopes: ["read_fulfillment_constraint_rules"], reason: "Fulfillment constraint rules require an optional app-function scope and are not a store-wide business-event surface." },
  { ownerType: "GIFT_CARD_TRANSACTION", liveCoverage: "definition_only", boundary: "optional_scope", requiredScopes: ["read_gift_cards"], reason: "Gift-card transactions require separately approved optional read_gift_cards access." },
  { ownerType: "MARKET", liveCoverage: "definition_only", boundary: "optional_scope", requiredScopes: ["read_markets"], reason: "Market metafields require optional read_markets access, which Albert does not request by default." },
  { ownerType: "MEDIA_IMAGE", liveCoverage: "definition_only", boundary: "optional_scope", requiredScopes: ["read_files"], reason: "Standalone media-image enumeration requires an optional files/images read surface; product media remains covered only where explicitly selected." },
  { ownerType: "ORDER_ROUTING_LOCATION_RULE", liveCoverage: "definition_only", boundary: "no_reviewed_enumerator", requiredScopes: [], reason: "The owner enum exists, but the pinned QueryRoot publishes no reviewed store-wide order-routing-rule enumerator for Albert to scan." },
  { ownerType: "PAYMENT_CUSTOMIZATION", liveCoverage: "definition_only", boundary: "app_ownership", requiredScopes: ["read_payment_customizations"], reason: "Payment customizations require an optional app-function scope and are not a store-wide payments ledger." },
  { ownerType: "SELLING_PLAN", liveCoverage: "definition_only", boundary: "app_ownership", requiredScopes: ["read_products"], reason: "Selling plans can be app-owned and are deleted after the creating app is uninstalled; Albert does not claim store-wide ownership coverage." },
  { ownerType: "TRANSFER", liveCoverage: "definition_only", boundary: "optional_scope", requiredScopes: ["read_inventory_transfers"], reason: "Inventory-transfer metafields require optional transfer access and a separately reviewed transfer stream." },
  { ownerType: "VALIDATION", liveCoverage: "definition_only", boundary: "app_ownership", requiredScopes: ["read_validations"], reason: "Validation resources are optional app/function configuration and are not a generic merchant analytics population." },
  { ownerType: "API_PERMISSION", liveCoverage: "definition_only", boundary: "no_reviewed_enumerator", requiredScopes: [], reason: "The schema defines this owner type but publishes no reviewed store-wide merchant analytics enumerator for Albert to scan." },
]);

export const SHOPIFY_METAFIELD_DEFINITION_OWNER_TYPES = Object.freeze(
  SHOPIFY_METAFIELD_OWNER_POLICIES
    .filter(({ liveCoverage }) => liveCoverage === "default_read_surface")
    .map(({ ownerType }) => ownerType),
);

export const SHOPIFY_METAFIELD_VALUE_OWNER_TYPES = SHOPIFY_METAFIELD_DEFINITION_OWNER_TYPES;

export const SHOPIFY_QUERIES: Readonly<Record<Exclude<ShopifyStreamId, "shopify_fields">, ShopifyQueryPlan>> = Object.freeze({
  shopify_shop: {
    root: "shop",
    shape: "single",
    query: `query AlbertShop {
      shop {
        id name myshopifyDomain email contactEmail currencyCode ianaTimezone timezoneAbbreviation
        customerAccounts createdAt updatedAt billingAddress { ${ADDRESS} }
        primaryDomain { host } plan { displayName }
      }
    }`,
  },
  shopify_locations: {
    root: "locations",
    shape: "connection",
    query: `query AlbertLocations($first:Int!,$after:String) {
      locations(first:$first,after:$after,includeInactive:true) {
        edges { cursor node {
          __typename id legacyResourceId name isActive fulfillsOnlineOrders shipsInventory
          hasActiveInventory hasUnfulfilledOrders createdAt updatedAt address { ${LOCATION_ADDRESS} }
        } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_products: {
    root: "products",
    shape: "connection",
    query: `query AlbertProducts($first:Int!,$after:String,$query:String) {
      products(first:$first,after:$after,sortKey:UPDATED_AT,query:$query) {
        edges { cursor node {
          __typename id legacyResourceId title handle description descriptionHtml vendor productType status tags
          templateSuffix totalInventory tracksInventory createdAt updatedAt publishedAt onlineStoreUrl
          category { id fullName } seo { title description }
        } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_product_variants: {
    root: "products",
    shape: "nested_connection",
    query: `query AlbertVariants($parentAfter:String,$childAfter:String,$query:String) {
      products(first:1,after:$parentAfter,sortKey:UPDATED_AT,query:$query) {
        edges { cursor node {
          id category { id fullName }
          variants(first:100,after:$childAfter) {
          edges { cursor node {
            __typename id legacyResourceId title displayName sku barcode price compareAtPrice inventoryPolicy
            inventoryQuantity sellableOnlineQuantity taxable taxCode availableForSale position createdAt updatedAt
            product { id }
          } } ${PAGE_INFO}
        } } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_customers: {
    root: "customers",
    shape: "connection",
    query: `query AlbertCustomers($first:Int!,$after:String,$query:String) {
      customers(first:$first,after:$after,sortKey:UPDATED_AT,query:$query) {
        edges { cursor node {
          __typename id legacyResourceId displayName firstName lastName email phone state tags note locale
          verifiedEmail validEmailAddress taxExempt numberOfOrders amountSpent { ${MONEY} } createdAt updatedAt
        } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_orders: {
    root: "orders",
    shape: "connection",
    query: `query AlbertOrders($first:Int!,$after:String,$query:String) {
      orders(first:$first,after:$after,sortKey:UPDATED_AT,query:$query) {
        edges { cursor node {
          __typename id legacyResourceId name number confirmationNumber email phone createdAt processedAt updatedAt
          cancelledAt closedAt cancelReason displayFinancialStatus displayFulfillmentStatus currencyCode
          presentmentCurrencyCode test taxesIncluded confirmed fullyPaid tags note sourceName
          customer { id } retailLocation { id } app { id } channel { name }
          subtotalPriceSet { shopMoney { ${MONEY} } } totalDiscountsSet { shopMoney { ${MONEY} } }
          totalShippingPriceSet { shopMoney { ${MONEY} } } totalTaxSet { shopMoney { ${MONEY} } }
          totalRefundedSet { shopMoney { ${MONEY} } } totalOutstandingSet { shopMoney { ${MONEY} } }
          totalPriceSet { shopMoney { ${MONEY} } } currentSubtotalPriceSet { shopMoney { ${MONEY} } }
          currentTotalDiscountsSet { shopMoney { ${MONEY} } } currentTotalTaxSet { shopMoney { ${MONEY} } }
          currentTotalPriceSet { shopMoney { ${MONEY} } }
          billingAddress { ${ADDRESS} } shippingAddress { ${ADDRESS} }
        } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_order_lines: {
    root: "orders",
    shape: "nested_connection",
    query: `query AlbertOrderLines($parentAfter:String,$childAfter:String,$query:String) {
      orders(first:1,after:$parentAfter,sortKey:UPDATED_AT,query:$query) {
        edges { cursor node {
          id createdAt processedAt updatedAt closedAt cancelledAt displayFinancialStatus displayFulfillmentStatus
          currencyCode taxesIncluded test sourceName customer { id } retailLocation { id } channel { name }
          lineItems(first:100,after:$childAfter) {
          edges { cursor node {
            __typename id name title sku vendor quantity currentQuantity refundableQuantity fulfillableQuantity
            unfulfilledQuantity requiresShipping taxable product { id } variant { id }
            originalUnitPriceSet { shopMoney { ${MONEY} } } discountedUnitPriceSet { shopMoney { ${MONEY} } }
            originalTotalSet { shopMoney { ${MONEY} } } discountedTotalSet { shopMoney { ${MONEY} } }
            totalDiscountSet { shopMoney { ${MONEY} } }
            discountAllocations { allocatedAmountSet { shopMoney { ${MONEY} } } }
            taxLines { priceSet { shopMoney { ${MONEY} } } }
          } } ${PAGE_INFO}
        } } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_transactions: {
    root: "orders",
    shape: "nested_list",
    query: `query AlbertTransactions($first:Int!,$after:String,$query:String) {
      orders(first:$first,after:$after,sortKey:UPDATED_AT,query:$query) {
        edges { cursor node { id updatedAt sourceName retailLocation { id } channel { name } transactions(first:250) {
          __typename id createdAt processedAt kind status gateway paymentId authorizationCode test manuallyCapturable
          paymentMethod parentTransaction { id } amountSet { shopMoney { ${MONEY} } }
          maximumRefundableV2 { amount currencyCode }
        } } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_refund_lines: {
    root: "orders",
    shape: "refund_lines",
    query: `query AlbertRefundLines($first:Int!,$after:String,$query:String) {
      orders(first:$first,after:$after,sortKey:UPDATED_AT,query:$query) {
        edges { cursor node { id updatedAt currencyCode retailLocation { id } refunds(first:250) { id createdAt updatedAt refundLineItems(first:250) {
          nodes { __typename id quantity restockType lineItem { id variant { id } } location { id }
            subtotalSet { shopMoney { ${MONEY} } } totalTaxSet { shopMoney { ${MONEY} } }
          }
        } } } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_inventory_levels: {
    root: "inventoryItems",
    shape: "nested_connection",
    query: `query AlbertInventoryLevels($parentAfter:String,$childAfter:String) {
      inventoryItems(first:1,after:$parentAfter) {
        edges { cursor node { id updatedAt variant { id } inventoryLevels(first:100,after:$childAfter,includeInactive:true) {
          edges { cursor node { __typename id canDeactivate updatedAt location { id }
            quantities(names:["available","incoming","on_hand","committed","reserved","damaged","safety_stock","quality_control"]) {
              name quantity updatedAt
            }
          } } ${PAGE_INFO}
        } } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_fulfillments: {
    root: "orders",
    shape: "nested_list",
    query: `query AlbertFulfillments($first:Int!,$after:String,$query:String) {
      orders(first:$first,after:$after,sortKey:UPDATED_AT,query:$query) {
        edges { cursor node { id updatedAt fulfillments(first:250) {
          __typename id name status displayStatus createdAt updatedAt deliveredAt estimatedDeliveryAt inTransitAt
          totalQuantity trackingInfo { company number url } location { id } service { handle }
        } } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_returns: {
    root: "orders",
    shape: "nested_connection",
    query: `query AlbertReturns($parentAfter:String,$childAfter:String,$query:String) {
      orders(first:1,after:$parentAfter,sortKey:UPDATED_AT,query:$query) {
        edges { cursor node { id updatedAt returns(first:100,after:$childAfter) {
          edges { cursor node {
            __typename id name status createdAt closedAt totalQuantity order { id }
            exchangeLineItems(first:250) { nodes { id } }
            returnLineItems(first:250) { nodes { id } }
            refunds(first:250) { nodes { id } }
          } } ${PAGE_INFO}
        } } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_discounts: {
    root: "discountNodes",
    shape: "connection",
    query: `query AlbertDiscounts($first:Int!,$after:String,$query:String) {
      discountNodes(first:$first,after:$after,sortKey:UPDATED_AT,query:$query) {
        edges { cursor node { __typename id discount { __typename
          ... on DiscountAutomaticApp { title status createdAt updatedAt startsAt endsAt asyncUsageCount discountClasses combinesWith { orderDiscounts productDiscounts shippingDiscounts } }
          ... on DiscountAutomaticBasic { title status createdAt updatedAt startsAt endsAt asyncUsageCount discountClasses combinesWith { orderDiscounts productDiscounts shippingDiscounts } }
          ... on DiscountAutomaticBxgy { title status createdAt updatedAt startsAt endsAt asyncUsageCount discountClasses combinesWith { orderDiscounts productDiscounts shippingDiscounts } }
          ... on DiscountAutomaticFreeShipping { title status createdAt updatedAt startsAt endsAt totalSales { ${MONEY} } asyncUsageCount discountClasses combinesWith { orderDiscounts productDiscounts shippingDiscounts } }
          ... on DiscountCodeApp { title status createdAt updatedAt startsAt endsAt totalSales { ${MONEY} } usageLimit asyncUsageCount discountClasses combinesWith { orderDiscounts productDiscounts shippingDiscounts } }
          ... on DiscountCodeBasic { title status createdAt updatedAt startsAt endsAt totalSales { ${MONEY} } usageLimit asyncUsageCount discountClasses combinesWith { orderDiscounts productDiscounts shippingDiscounts } }
          ... on DiscountCodeBxgy { title status createdAt updatedAt startsAt endsAt totalSales { ${MONEY} } usageLimit asyncUsageCount discountClasses combinesWith { orderDiscounts productDiscounts shippingDiscounts } }
          ... on DiscountCodeFreeShipping { title status createdAt updatedAt startsAt endsAt totalSales { ${MONEY} } usageLimit asyncUsageCount discountClasses combinesWith { orderDiscounts productDiscounts shippingDiscounts } }
        } } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_metafield_definitions: {
    root: "metafieldDefinitions",
    shape: "metafield_definitions",
    query: `query AlbertMetafieldDefinitions($ownerType:MetafieldOwnerType!,$first:Int!,$after:String) {
      metafieldDefinitions(ownerType:$ownerType,first:$first,after:$after,sortKey:ID) {
        edges { cursor node {
          __typename id name namespace key ownerType description pinnedPosition
          useAsCollectionCondition validationStatus metafieldsCount
          type { name category }
          access { admin storefront customerAccount }
          capabilities {
            adminFilterable { eligible enabled status }
            analyticsQueryable { eligible enabled }
            cartToOrderCopyable { eligible enabled }
            smartCollectionCondition { eligible enabled }
            uniqueValues { eligible enabled }
          }
          constraints { key }
          validations { name type value }
        } } ${PAGE_INFO}
      }
    }`,
  },
  shopify_metafield_values: {
    root: "metafieldDefinitions",
    shape: "metafield_values",
    query: `query AlbertMetafieldValues(
      $ownerType:MetafieldOwnerType!
      $definitionAfter:String
      $valueAfter:String
    ) {
      metafieldDefinitions(ownerType:$ownerType,first:1,after:$definitionAfter,sortKey:ID) {
        edges { cursor node {
          id ownerType namespace key
          metafields(first:100,after:$valueAfter) {
            edges { cursor node {
              __typename id legacyResourceId namespace key type value jsonValue sizeInBytes
              compareDigest createdAt updatedAt ownerType
              owner { __typename ... on Node { id } }
              definition { id }
            } } ${PAGE_INFO}
          }
        } } ${PAGE_INFO}
      }
    }`,
  },
});
