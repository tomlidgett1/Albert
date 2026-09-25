import type { ConnectorEmittedTarget, StreamContract } from "../../packages/connector-sdk/src/contract.js";
import type { SourceAuthorityConcept } from "../../packages/canonical-schema/src/types.js";
import type { LightspeedXPagination } from "./pagination.js";

export type LightspeedXJson = null | boolean | number | string | readonly LightspeedXJson[] |
  { readonly [key: string]: LightspeedXJson };

export type LightspeedXParentFanout = Readonly<{
  stream: string;
  endpoint: string;
  responsePath: string;
  idPath: string;
  pathParameter: string;
  contextField: string;
  pagination: LightspeedXPagination;
}>;

export type LightspeedXStream = StreamContract & Readonly<{
  label: string;
  operationId: string;
  method: "GET" | "POST";
  requiredScopes: readonly string[];
  responsePaths: readonly string[];
  recordIdPaths: readonly string[];
  sourceUpdatedAtPaths: readonly string[];
  tombstonePaths: readonly string[];
  paginator: LightspeedXPagination;
  fixedQuery: Readonly<Record<string, LightspeedXJson>>;
  fixedBody: Readonly<Record<string, LightspeedXJson>>;
  partitions: readonly Readonly<Record<string, LightspeedXJson>>[];
  parent: LightspeedXParentFanout | null;
  rootSchemas: readonly string[];
  documentation: string;
}>;

const docs = (slug: string): string => `https://x-series-api.lightspeedhq.com/reference/${slug}`;
const version = (location: "query" | "body" = "query", pageSizeField = "page_size", pageSize = 1_000): LightspeedXPagination => ({
  kind: "version", location, requestField: "after", responseField: "version.max",
  pageSizeField, pageSize, emptyPageTerminates: true,
});
const offset = (location: "query" | "body" = "query", pageSizeField = "page_size", pageSize = 1_000): LightspeedXPagination => ({
  kind: "offset", location, requestField: "offset", pageSizeField, pageSize, emptyPageTerminates: true,
});
const page: LightspeedXPagination = { kind: "page", location: "query", requestField: "page_number", pageSizeField: "page_size", pageSize: 100, emptyPageTerminates: true };
const none: LightspeedXPagination = { kind: "none", location: "none" };
const afterId = (lastRecordField = "id", hasNextField?: string, pageSizeField = "limit"): LightspeedXPagination => ({
  kind: "after_id", location: "query", requestField: "after", pageSizeField, pageSize: 100,
  lastRecordField, ...(hasNextField ? { hasNextField } : {}), emptyPageTerminates: true,
});
const opaque: LightspeedXPagination = { kind: "opaque", location: "query", requestField: "cursor", responseField: "next_cursor", pageSizeField: "limit", pageSize: 1_000, emptyPageTerminates: true };
const beforeId: LightspeedXPagination = { kind: "before_id", location: "query", requestField: "before", pageSizeField: "page_size", pageSize: 1_000, lastRecordField: "id", emptyPageTerminates: true };

type Input = Omit<LightspeedXStream,
  "recordIdField" | "pagination" | "backfillStrategy" | "lateEditStrategy" | "deletionStrategy" |
  "sourceTotalStrategy" | "availability" | "dependencies" | "productDomains" |
  "canonicalTargets" | "authorityConcept" | "fixedQuery" | "fixedBody" |
  "partitions" | "parent" | "sourceUpdatedAtPaths" | "tombstonePaths"
> & Partial<Pick<LightspeedXStream,
  "availability" | "dependencies" | "productDomains" | "canonicalTargets" |
  "authorityConcept" | "fixedQuery" | "fixedBody" | "partitions" | "parent" |
  "sourceUpdatedAtPaths" | "tombstonePaths" | "backfillStrategy" |
  "lateEditStrategy" | "deletionStrategy" | "sourceTotalStrategy"
>>;

function define(input: Input): LightspeedXStream {
  const versioned = input.paginator.kind === "version";
  const parentDependencies = input.parent ? [input.parent.stream] : [];
  return Object.freeze({
    ...input,
    recordIdField: input.recordIdPaths[0] ?? "source_record_id",
    pagination: versioned || ["opaque", "before_id", "after_id"].includes(input.paginator.kind)
      ? "vendor_cursor"
      : input.paginator.kind === "offset" ? "offset"
      : input.paginator.kind === "page" ? "page" : "none",
    ...(versioned ? { modifiedField: "version" } : {}),
    backfillStrategy: input.backfillStrategy ?? (input.paginator.kind === "offset" ? "exhaustive_offset" : "snapshot"),
    lateEditStrategy: input.lateEditStrategy ?? (versioned ? "modified_field" : "full_snapshot"),
    deletionStrategy: input.deletionStrategy ?? (input.tombstonePaths?.length ? "soft_delete" : "authoritative_identity_scan"),
    sourceTotalStrategy: input.sourceTotalStrategy ?? "count_distinct_complete_scan",
    availability: input.availability ?? "required",
    dependencies: Object.freeze([...(input.dependencies ?? []), ...parentDependencies]),
    productDomains: Object.freeze(
      input.productDomains ?? (["sales"] as const),
    ) as LightspeedXStream["productDomains"],
    canonicalTargets: Object.freeze(input.canonicalTargets ?? ["metadata"]) as readonly ConnectorEmittedTarget[],
    authorityConcept: input.authorityConcept ?? "operational_sales" as SourceAuthorityConcept,
    fixedQuery: Object.freeze(input.fixedQuery ?? {}),
    fixedBody: Object.freeze(input.fixedBody ?? {}),
    partitions: Object.freeze(input.partitions ?? []),
    parent: input.parent ?? null,
    sourceUpdatedAtPaths: Object.freeze(input.sourceUpdatedAtPaths ?? ["updated_at", "created_at"]),
    tombstonePaths: Object.freeze(input.tombstonePaths ?? ["deleted_at", "deletedAt"]),
  });
}

const parent = (
  stream: string, endpoint: string, responsePath: string, idPath: string,
  pathParameter: string, contextField: string, pagination: LightspeedXPagination = version(),
): LightspeedXParentFanout => ({ stream, endpoint, responsePath, idPath, pathParameter, contextField, pagination });

/**
 * Exhaustive, enumerable read surface. Unsafe write-capable/management scopes
 * and request/response calculation functions remain in the official endpoint
 * census, but are intentionally not scheduled as ingestion streams.
 */
export const LIGHTSPEED_X_STREAMS: readonly LightspeedXStream[] = Object.freeze([
  define({ id: "lx_retailer", label: "Retailer", resource: "Retailer", endpoint: "/retailer", operationId: "GetRetailer", method: "GET", requiredScopes: ["retailer:read", "payment_types:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: none, rootSchemas: ["RetailerResponse"], canonicalTargets: ["legal_entity"], documentation: docs("getretailer") }),
  define({ id: "lx_outlets", label: "Outlets", resource: "Outlet", endpoint: "/outlets", operationId: "ListOutlets", method: "GET", requiredScopes: ["outlets:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["OutletCollection"], canonicalTargets: ["location", "stock_location", "identity_hint"], productDomains: ["sales", "inventory"], documentation: docs("listoutlets") }),
  define({ id: "lx_registers", label: "Registers", resource: "Register", endpoint: "/registers", operationId: "ListRegisters", method: "GET", requiredScopes: ["registers:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["RegisterCollection"], canonicalTargets: ["register"], dependencies: ["lx_outlets"], documentation: docs("listregisters") }),
  define({ id: "lx_users", label: "Users", resource: "User", endpoint: "/users", operationId: "ListUsers", method: "GET", requiredScopes: ["users:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), rootSchemas: ["UserCollection"], canonicalTargets: ["person", "worker", "identity_hint"], productDomains: ["workforce", "sales"], documentation: docs("listusers") }),
  define({ id: "lx_user_sale_totals", label: "User sale totals", resource: "UserSaleTotal", endpoint: "/users/{user_id}/sale_totals", operationId: "GetSalesTotalsForUserByID", method: "GET", requiredScopes: ["users:read"], responsePaths: ["data"], recordIdPaths: ["user_id", "_albert.parent.user_id"], paginator: none, parent: parent("lx_users", "/users", "data", "id", "user_id", "user_id"), rootSchemas: ["UserSaleTotalResponse"], dependencies: ["lx_sales"], documentation: docs("getsalestotalsforuserbyid") }),

  define({ id: "lx_brands", label: "Brands", resource: "Brand", endpoint: "/brands", operationId: "ListBrands", method: "GET", requiredScopes: ["products:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["BrandCollection"], productDomains: ["products"], authorityConcept: "product_master", documentation: docs("listbrands") }),
  define({ id: "lx_product_types", label: "Product types", resource: "ProductType", endpoint: "/product_types", operationId: "ListProductTypes", method: "GET", requiredScopes: ["products:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["ProductTypeCollection"], productDomains: ["products"], authorityConcept: "product_master", documentation: docs("listproducttypes") }),
  define({ id: "lx_product_categories", label: "Product categories", resource: "ProductCategory", endpoint: "/product_categories", operationId: "ListProductCategories", method: "GET", requiredScopes: ["products:read"], responsePaths: ["data.categories"], recordIdPaths: ["id"], paginator: { kind: "opaque", location: "query", requestField: "after", responseField: "page_info.last_seen", pageSizeField: "page_size", pageSize: 1_000, emptyPageTerminates: true }, fixedQuery: { include: "family" }, rootSchemas: ["ProductCategory"], canonicalTargets: ["product_category"], productDomains: ["products"], authorityConcept: "product_master", documentation: docs("listproductcategories") }),
  define({ id: "lx_tags", label: "Tags", resource: "Tag", endpoint: "/tags", operationId: "ListTags", method: "GET", requiredScopes: ["products:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["TagCollection"], productDomains: ["products"], authorityConcept: "product_master", documentation: docs("listtags") }),
  define({ id: "lx_products", label: "Products and variants", resource: "Product", endpoint: "/products", operationId: "ListProducts", method: "GET", requiredScopes: ["products:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true, include_images: true }, rootSchemas: ["ProductCollection"], canonicalTargets: ["product", "product_variant", "category_assignment", "identity_hint"], productDomains: ["products", "inventory", "sales"], authorityConcept: "product_master", documentation: docs("listproducts") }),
  define({ id: "lx_variant_attributes", label: "Variant attributes", resource: "VariantAttribute", endpoint: "/variant_attributes", operationId: "ListVariantAttributes", method: "GET", requiredScopes: ["products:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: none, fixedQuery: { deleted: true }, rootSchemas: ["VariantAttributesListResponse"], productDomains: ["products"], authorityConcept: "product_master", documentation: docs("listvariantattributes") }),
  define({ id: "lx_price_books", label: "Price books", resource: "PriceBook", endpoint: "/price_books", operationId: "ListPriceBooksV3", method: "GET", requiredScopes: ["customers:read", "outlets:read", "products:read:price_books"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["PriceBookCollection"], productDomains: ["products", "sales"], authorityConcept: "product_master", documentation: docs("listpricebooksv3") }),
  define({ id: "lx_price_book_products", label: "Price book products", resource: "PriceBookProduct", endpoint: "/price_book_products", operationId: "ListPriceBookProducts", method: "GET", requiredScopes: ["products:read:price_books"], responsePaths: ["data"], recordIdPaths: ["id", "product_id", "price_book_id"], paginator: version(), rootSchemas: ["PriceBookProductCollection"], productDomains: ["products", "sales"], authorityConcept: "product_master", documentation: docs("listpricebookproducts") }),

  define({ id: "lx_inventory", label: "Inventory", resource: "Inventory", endpoint: "/inventory", operationId: "ListInventoryRecords", method: "POST", requiredScopes: ["inventory:read"], responsePaths: ["$"], recordIdPaths: ["id", "product_id", "outlet_id"], paginator: version("body", "size", 5_000), fixedBody: { include_deleted: true, sort_direction: "asc" }, rootSchemas: ["Inventory"], canonicalTargets: ["inventory_balance_snapshot"], productDomains: ["inventory"], authorityConcept: "stock", reprocessIdenticalPayloadOnNewBatch: true, dependencies: ["lx_products", "lx_outlets"], documentation: docs("listinventoryrecords") }),
  define({ id: "lx_inventory_levels", label: "Inventory levels and value", resource: "InventoryLevel", endpoint: "/inventory_levels", operationId: "ListInventoryLevels", method: "POST", requiredScopes: ["inventory:read"], responsePaths: ["$"], recordIdPaths: ["product_id", "location_id"], paginator: offset("body", "size", 10_000), fixedBody: { include_inactive: true, include_composites: true, group_variants: false, sort_direction: "asc", sort_type: "product_name" }, rootSchemas: ["InventoryLevel"], productDomains: ["inventory"], authorityConcept: "stock", reprocessIdenticalPayloadOnNewBatch: true, dependencies: ["lx_inventory"], documentation: docs("listinventorylevels") }),

  define({ id: "lx_customer_groups", label: "Customer groups", resource: "CustomerGroup", endpoint: "/customer_groups", operationId: "ListCustomerGroups", method: "GET", requiredScopes: ["customers:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["CustomerGroupCollection"], productDomains: ["customers"], authorityConcept: "customer_master", documentation: docs("listcustomergroups") }),
  define({ id: "lx_customers", label: "Customers", resource: "Customer", endpoint: "/customers", operationId: "ListCustomers", method: "GET", requiredScopes: ["customers:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["CustomerCollection"], canonicalTargets: ["person", "customer_account", "identity_hint"], productDomains: ["customers", "sales"], authorityConcept: "customer_master", documentation: docs("listcustomers") }),
  define({ id: "lx_customer_group_memberships", label: "Customer group memberships", resource: "CustomerGroupMembership", endpoint: "/customer_groups/{customer_group_id}/customers", operationId: "GetCustomerGroupCustomers", method: "GET", requiredScopes: ["customers:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), parent: parent("lx_customer_groups", "/customer_groups", "data", "id", "customer_group_id", "customer_group_id"), rootSchemas: ["CustomerCollection"], productDomains: ["customers"], authorityConcept: "customer_master", documentation: docs("getcustomergroupcustomers") }),
  define({ id: "lx_customer_addresses", label: "Customer addresses", resource: "CustomerAddress", endpoint: "/customers/{customer_id}/addresses", operationId: "ListCustomerAddresses", method: "GET", requiredScopes: ["customers:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: none, parent: parent("lx_customers", "/customers", "data", "id", "customer_id", "customer_id"), rootSchemas: ["CustomerAddressCollection"], productDomains: ["customers"], authorityConcept: "customer_master", documentation: docs("listcustomeraddresses") }),

  define({ id: "lx_suppliers", label: "Suppliers", resource: "Supplier", endpoint: "/suppliers", operationId: "ListSuppliers", method: "GET", requiredScopes: ["suppliers:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["SupplierCollection"], canonicalTargets: ["supplier", "identity_hint"], productDomains: ["inventory"], authorityConcept: "stock", documentation: docs("listsuppliers") }),
  define({ id: "lx_consignments", label: "Consignments, purchase orders and stocktakes", resource: "Consignment", endpoint: "/consignments", operationId: "GetConsignments", method: "GET", requiredScopes: ["consignments:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), rootSchemas: ["ConsignmentCollection"], productDomains: ["inventory"], authorityConcept: "stock", dependencies: ["lx_suppliers", "lx_outlets"], documentation: docs("getconsignments") }),
  define({ id: "lx_consignment_products", label: "Consignment products", resource: "ConsignmentProduct", endpoint: "/consignments/{consignment_id}/products", operationId: "ListProductsByConsignmentID", method: "GET", requiredScopes: ["consignments:read"], responsePaths: ["data"], recordIdPaths: ["id", "product_id"], paginator: version(), parent: parent("lx_consignments", "/consignments", "data", "id", "consignment_id", "consignment_id"), rootSchemas: ["ConsignmentProductCollection"], productDomains: ["inventory"], authorityConcept: "stock", documentation: docs("listproductsbyconsignmentid") }),
  define({ id: "lx_consignment_totals", label: "Consignment totals", resource: "ConsignmentTotals", endpoint: "/consignments/{consignment_id}/totals", operationId: "ListConsignmentTotals", method: "GET", requiredScopes: ["consignments:read"], responsePaths: ["data"], recordIdPaths: ["id", "_albert.parent.consignment_id"], paginator: none, parent: parent("lx_consignments", "/consignments", "data", "id", "consignment_id", "consignment_id"), rootSchemas: ["ConsignmentTotalsResponse"], productDomains: ["inventory"], authorityConcept: "stock", documentation: docs("listconsignmenttotals") }),

  define({ id: "lx_taxes", label: "Taxes", resource: "Tax", endpoint: "/taxes", operationId: "ListTaxes", method: "GET", requiredScopes: ["taxes:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), rootSchemas: ["TaxCollection"], canonicalTargets: ["tax_code"], productDomains: ["accounting", "sales"], documentation: docs("listtaxes") }),
  define({ id: "lx_outlet_taxes", label: "Outlet product taxes", resource: "OutletTax", endpoint: "/outlet_taxes", operationId: "listOutletProductTaxes", method: "GET", requiredScopes: ["outlets:read"], responsePaths: ["data"], recordIdPaths: ["id", "outlet_id", "product_id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["OutletTaxCollection"], productDomains: ["accounting", "sales", "products"], dependencies: ["lx_taxes", "lx_products", "lx_outlets"], documentation: docs("listoutletproducttaxes") }),
  define({ id: "lx_payment_types", label: "Payment types", resource: "PaymentType", endpoint: "/payment_types", operationId: "ListPaymentTypes", method: "GET", requiredScopes: ["payment_types:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["PaymentTypeCollection"], productDomains: ["sales", "accounting"], documentation: docs("listpaymenttypes") }),
  define({ id: "lx_sales", label: "Sales, lines and payments", resource: "Sale", endpoint: "/sales", operationId: "ListSales", method: "GET", requiredScopes: ["sales:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), rootSchemas: ["SaleCollection"], canonicalTargets: ["channel", "commerce_order", "commerce_order_line", "commerce_refund_line", "commerce_payment", "event_link"], productDomains: ["sales", "accounting"], dependencies: ["lx_customers", "lx_products", "lx_users", "lx_registers", "lx_payment_types"], documentation: docs("listsales") }),
  define({ id: "lx_register_payment_summaries", label: "Register payment summaries", resource: "RegisterPaymentsSummary", endpoint: "/registers/{register_id}/payments_summary", operationId: "RegisterPaymentsSummary", method: "GET", requiredScopes: ["payments:read"], responsePaths: ["data"], recordIdPaths: ["id", "_albert.parent.register_id"], paginator: none, parent: parent("lx_registers", "/registers", "data", "id", "register_id", "register_id"), rootSchemas: ["RegisterPaymentsSummaryResponse"], productDomains: ["sales", "accounting"], dependencies: ["lx_payment_types"], documentation: docs("registerpaymentssummary") }),

  define({ id: "lx_fulfillments", label: "Fulfillments", resource: "Fulfillment", endpoint: "/fulfillments", operationId: "getFulfillmentSummary", method: "GET", requiredScopes: ["fulfillments:read"], responsePaths: ["data"], recordIdPaths: ["id", "fulfillment_id"], paginator: page, rootSchemas: ["FulfillmentSummaryResponse"], productDomains: ["sales", "inventory"], dependencies: ["lx_sales"], documentation: docs("getfulfillmentsummary") }),
  define({ id: "lx_fulfillment_history", label: "Fulfillment history", resource: "FulfillmentHistoryEntry", endpoint: "/fulfillments/{fulfillment_id}/history", operationId: "getFulfillmentHistory", method: "GET", requiredScopes: ["fulfillments:read"], responsePaths: ["data"], recordIdPaths: ["id", "event_id", "created_at"], paginator: opaque, parent: parent("lx_fulfillments", "/fulfillments", "data", "id", "fulfillment_id", "fulfillment_id", page), rootSchemas: ["FulfillmentHistoryResponse"], productDomains: ["sales", "inventory"], documentation: docs("getfulfillmenthistory") }),
  define({ id: "lx_gift_cards", label: "Gift cards and transactions", resource: "GiftCard", endpoint: "/gift_cards", operationId: "ListGiftCards", method: "GET", requiredScopes: ["gift_cards:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: beforeId, rootSchemas: ["GiftCardCollection"], productDomains: ["sales", "accounting"], documentation: docs("listgiftcards") }),
  define({ id: "lx_promotions", label: "Promotions", resource: "Promotion", endpoint: "/promotions/search", operationId: "SearchPromotions", method: "GET", requiredScopes: ["promotions:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: offset(), fixedQuery: { scope: "all", order_by: "name", direction: "asc" }, rootSchemas: ["PromotionCollection"], productDomains: ["sales", "products"], documentation: docs("searchpromotions") }),
  define({ id: "lx_promotion_products", label: "Promotion products", resource: "PromotionProduct", endpoint: "/promotions/{promotion_id}/products", operationId: "GetPromotionProducts", method: "GET", requiredScopes: ["promotions:read", "products:read"], responsePaths: ["data.condition_products", "data.action_products"], recordIdPaths: ["id"], paginator: offset(), parent: parent("lx_promotions", "/promotions/search", "data", "id", "promotion_id", "promotion_id", offset()), rootSchemas: ["PromotionProductsResponse"], productDomains: ["sales", "products"], documentation: docs("getpromotionproducts") }),
  define({ id: "lx_promotion_promocodes", label: "Promotion promo codes", resource: "PromotionPromoCode", endpoint: "/promotions/{promotion_id}/promocodes", operationId: "GetPromotionPromoCodes", method: "GET", requiredScopes: ["promotions:read"], responsePaths: ["data"], recordIdPaths: ["id", "code"], paginator: none, parent: parent("lx_promotions", "/promotions/search", "data", "id", "promotion_id", "promotion_id", offset()), rootSchemas: ["PromotionPromoCodesResponse"], productDomains: ["sales"], documentation: docs("getpromotionpromocodes") }),
  define({ id: "lx_quotes", label: "Quotes", resource: "Quote", endpoint: "/quotes", operationId: "get-quotes", method: "GET", requiredScopes: ["sales:read"], responsePaths: ["Quotes"], recordIdPaths: ["id"], paginator: afterId("id", "HasNext"), rootSchemas: ["QuotesCollection"], productDomains: ["sales"], dependencies: ["lx_customers", "lx_products", "lx_registers", "lx_users"], documentation: docs("get-quotes") }),

  define({ id: "lx_serial_numbers", label: "Serial numbers", resource: "SerialNumber", endpoint: "/serialnumbers", operationId: "get-serialnumbers", method: "GET", requiredScopes: ["serial_numbers:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), rootSchemas: ["SerialNumberCollection"], productDomains: ["inventory", "sales"], authorityConcept: "stock", dependencies: ["lx_products", "lx_outlets", "lx_sales"], documentation: docs("get-serialnumbers") }),
  define({ id: "lx_services", label: "Service orders", resource: "ServiceOrder", endpoint: "/services", operationId: "ListServices", method: "GET", requiredScopes: ["services:read"], responsePaths: ["jobs"], recordIdPaths: ["service.id", "id"], paginator: afterId("service.id", "has_next"), rootSchemas: ["ServiceOrder"], productDomains: ["sales"], dependencies: ["lx_customers", "lx_products", "lx_users"], documentation: docs("listservices") }),
  define({ id: "lx_service_details", label: "Service order details", resource: "DetailedService", endpoint: "/services/{service_id}", operationId: "GetService", method: "GET", requiredScopes: ["services:read"], responsePaths: ["$"], recordIdPaths: ["service.id", "id"], paginator: none, parent: parent("lx_services", "/services", "jobs", "service.id", "service_id", "service_id", afterId("service.id", "has_next")), rootSchemas: ["DetailedService"], productDomains: ["sales"], documentation: docs("getservice") }),
  define({ id: "lx_service_items", label: "Customer service items", resource: "ServiceItem", endpoint: "/service_items/customer/{customer_id}", operationId: "ListServiceItems", method: "GET", requiredScopes: ["services:read"], responsePaths: ["job_items"], recordIdPaths: ["id", "item_id"], paginator: afterId("id", "has_next"), parent: parent("lx_customers", "/customers", "data", "id", "customer_id", "customer_id"), rootSchemas: [], productDomains: ["sales"], documentation: docs("listserviceitems") }),
  define({ id: "lx_service_statuses", label: "Service statuses", resource: "ServiceStatus", endpoint: "/service_statuses", operationId: "ListServiceStatuses", method: "GET", requiredScopes: ["services:read"], responsePaths: ["$"], recordIdPaths: ["id"], paginator: none, rootSchemas: ["ServiceStatusDetails"], productDomains: ["sales"], documentation: docs("listservicestatuses") }),
  define({ id: "lx_service_agenda", label: "Service agenda", resource: "DailyAgenda", endpoint: "/services_agenda/outlet/{outlet_id}", operationId: "get-agenda-outlet_id", method: "GET", requiredScopes: ["services:read"], responsePaths: ["$"], recordIdPaths: ["date", "_albert.parent.outlet_id"], paginator: none, parent: parent("lx_outlets", "/outlets", "data", "id", "outlet_id", "outlet_id"), fixedQuery: { days: 366 }, rootSchemas: ["DailyAgenda"], backfillStrategy: "time_windowed", productDomains: ["sales", "workforce"], documentation: docs("get-agenda-outlet_id") }),

  define({ id: "lx_shifts", label: "User shifts", resource: "Shift", endpoint: "/shifts", operationId: "ListShifts", method: "GET", requiredScopes: ["users:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), rootSchemas: ["ShiftCollection"], canonicalTargets: ["workforce_shift"], productDomains: ["workforce"], dependencies: ["lx_users"], documentation: docs("listshifts") }),
  define({ id: "lx_store_credits", label: "Store credit accounts and transactions", resource: "StoreCreditCustomer", endpoint: "/store_credits/{customerId}", operationId: "ListStoreCreditForCustomer", method: "GET", requiredScopes: ["store_credits:read"], responsePaths: ["$"], recordIdPaths: ["id", "customer_id"], paginator: none, parent: parent("lx_customers", "/customers", "data", "id", "customerId", "customer_id"), rootSchemas: ["StoreCreditCustomer"], productDomains: ["customers", "sales", "accounting"], dependencies: ["lx_sales"], documentation: docs("liststorecreditforcustomer") }),
  define({ id: "lx_store_credit_report", label: "Store credit report", resource: "StoreCreditReport", endpoint: "/store_credits/report", operationId: "StoreCreditReport", method: "GET", requiredScopes: ["store_credits:read"], responsePaths: ["$"], recordIdPaths: ["_singleton"], paginator: none, rootSchemas: ["StoreCreditReport"], productDomains: ["sales", "accounting"], documentation: docs("storecreditreport") }),

  define({ id: "lx_audit_log_events", label: "Audit log events", resource: "AuditLogEvent", endpoint: "/auditlog_events", operationId: "GetAuditLogEvents", method: "GET", requiredScopes: ["audit:read"], responsePaths: ["data"], recordIdPaths: ["id", "event_id", "occurred_at"], paginator: offset("query", "page_size", 100), fixedQuery: { order: "asc" }, rootSchemas: ["AuditLogEvent"], backfillStrategy: "time_windowed", productDomains: ["workforce", "sales"], documentation: docs("getauditlogevents") }),
  define({ id: "lx_channels", label: "Sales channels", resource: "Channel", endpoint: "/channels", operationId: "listChannels", method: "GET", requiredScopes: ["channels:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: none, rootSchemas: ["ChannelCollectionResponse"], canonicalTargets: ["channel"], documentation: docs("listchannels") }),
  define({ id: "lx_channel_requests", label: "Channel request logs", resource: "ChannelRequest", endpoint: "/channel_requests", operationId: "listRequests", method: "GET", requiredScopes: ["channels:read"], responsePaths: ["data"], recordIdPaths: ["id", "request_log_id", "occurred_at"], paginator: none, rootSchemas: ["RequestCollectionResponse"], availability: "optional", documentation: docs("listrequests") }),
  define({ id: "lx_button_layouts", label: "Button layouts", resource: "ButtonLayout", endpoint: "/button_layouts", operationId: "ListButtonLayouts", method: "GET", requiredScopes: ["registers:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: version(), fixedQuery: { deleted: true }, rootSchemas: ["ButtonLayoutCollection"], dependencies: ["lx_registers"], documentation: docs("listbuttonlayouts") }),
  define({ id: "lx_partner_subscriptions", label: "Partner billing subscriptions", resource: "PartnerSubscription", endpoint: "/partner/billing/subscriptions", operationId: "PartnerSubscriptions", method: "GET", requiredScopes: ["billing:partner_subscription:read"], responsePaths: ["data"], recordIdPaths: ["id", "subscription_id"], paginator: none, rootSchemas: ["PartnerSubscription"], availability: "optional", productDomains: ["accounting"], documentation: docs("partnersubscriptions") }),
  define({ id: "lx_business_rules", label: "Business rules", resource: "BusinessRule", endpoint: "/workflows/rules", operationId: "get-rules", method: "GET", requiredScopes: ["business_rules:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: none, rootSchemas: ["BusinessRule"], documentation: docs("get-rules") }),
  define({ id: "lx_remote_rules", label: "Remote business rules", resource: "RemoteBusinessRule", endpoint: "/workflows/remote_rules", operationId: "get-remote-rules", method: "GET", requiredScopes: ["remote_rules:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: none, rootSchemas: ["RemoteBusinessRule"], documentation: docs("get-remote-rules") }),
  define({ id: "lx_custom_fields", label: "Custom field definitions", resource: "CustomFieldDefinition", endpoint: "/workflows/custom_fields", operationId: "GetCustomFields", method: "GET", requiredScopes: ["custom_fields:read"], responsePaths: ["data"], recordIdPaths: ["id"], paginator: none, partitions: [{ entity: "sale" }, { entity: "line_item" }, { entity: "customer" }, { entity: "product" }], rootSchemas: ["CustomFieldDefinitionCollection"], productDomains: ["sales", "customers", "products"], documentation: docs("getcustomfields") }),
]);

export const LIGHTSPEED_X_STREAM_BY_ID: ReadonlyMap<string, LightspeedXStream> =
  new Map(LIGHTSPEED_X_STREAMS.map((stream) => [stream.id, stream]));

export const LIGHTSPEED_X_UNOBSERVABLE_READS = Object.freeze([
  { operationId: "ListCustomInventoryAdjustmentReasons", endpoint: "/custom_inventory_adjustment_reasons", reason: "Requires inventory:write; Albert never requests write-capable source scopes." },
  { operationId: "ListStockAdjustments", endpoint: "/stock_adjustments", reason: "Requires inventory:write; Albert never requests write-capable source scopes." },
  { operationId: "get-webhooks", endpoint: "/webhooks", reason: "The webhooks scope also manages subscriptions; it is not requested by the read-only default grant." },
  { operationId: "GetCustomFieldValues", endpoint: "/workflows/custom_fields/values", reason: "Requires an entity ID fan-out across polymorphic entities; definitions are ingested and values remain available inside their owning source entities until a bounded vendor contract exists." },
  { operationId: "ListPromotions", endpoint: "/promotions", reason: "The endpoint documents page_size but no cursor. The exhaustive offset-capable /promotions/search endpoint is ingested instead." },
  { operationId: "ListStoreCredit", endpoint: "/store_credits", reason: "The endpoint documents page_size but no cursor. Albert exhaustively fans out /store_credits/{customerId} from customers instead." },
] as const);
