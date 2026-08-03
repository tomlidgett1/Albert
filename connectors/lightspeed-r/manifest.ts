import {
  inferStagingType,
  stagingColumnName,
  type ConnectorManifest,
  type FieldCoverage,
} from "../../packages/connector-sdk/src/index.js";
import {
  LIGHTSPEED_R_DOCUMENTATION_BUILD,
  LIGHTSPEED_R_DOCUMENTED_FIELDS,
  type LightspeedRDocumentedStream,
} from "./documented-fields.js";

export const LIGHTSPEED_R_DEFAULT_SCOPES = [
  "employee:register_read",
  "employee:inventory_read",
  "employee:customers_read",
  "employee:product_cost",
  "employee:admin_employees",
  "employee:admin_shops",
  "employee:categories",
  "employee:vendors",
  "employee:purchase_orders",
  "employee:admin_purchases",
] as const;

const coverage = (
  stream: LightspeedRDocumentedStream,
  canonical: Readonly<Record<string, string>>,
  extensions: readonly string[] = [],
  pii: Readonly<Record<string, FieldCoverage["pii"]>> = {},
): readonly FieldCoverage[] => {
  const explicitlyDispositioned = new Set([...Object.keys(canonical), ...extensions]);
  return [
    ...Object.entries(canonical).map(([field, target]) => ({
    stream,
    field,
    disposition: "canonical" as const,
    stagingType: inferStagingType("lightspeed-r", field, target),
    target,
    pii: pii[field] ?? ("none" as const),
    })),
    ...extensions.map((field) => ({
    stream,
    field,
    disposition: "governed_extension" as const,
    stagingType: inferStagingType("lightspeed-r", field),
    target: `source_lightspeed.${stream}.${stagingColumnName(field)}`,
    pii: pii[field] ?? ("none" as const),
    })),
    ...LIGHTSPEED_R_DOCUMENTED_FIELDS[stream]
      .filter((field) => !explicitlyDispositioned.has(field))
      .map((field) => ({
        stream,
        field,
        disposition: "unsupported" as const,
        stagingType: inferStagingType("lightspeed-r", field),
        reason: "Published by the pinned Lightspeed R-Series V3 documentation build but outside Albert V1 canonical and governed source-extension scope; retained only in immutable encrypted raw storage.",
        pii: pii[field] ?? unsupportedPii(stream, field),
      })),
  ];
};

function unsupportedPii(
  stream: LightspeedRDocumentedStream,
  field: string,
): FieldCoverage["pii"] {
  if (/Note|Instructions|CustomFieldValues/u.test(field)) return "free_text_untrusted";
  if (stream === "customers" && /CreditAccount/u.test(field)) return "customer_contact";
  return "none";
}

export const lightspeedRManifest: ConnectorManifest = {
  id: "lightspeed-r",
  displayName: "Lightspeed Retail POS (R-Series)",
  packVersion: "1.1.0",
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
      "R-Series does not publish read-only variants for employees, shops, categories, vendors, purchase orders, payment types, or tax categories. Albert requests the narrowest documented scopes and contains no source write methods.",
    ],
    refreshTokenRotation: true,
    remoteRevocation: "supported",
  },
  streams: [
    { id: "shops", resource: "Shop", endpoint: "Shop.json", recordIdField: "shopID", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "full_snapshot", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: [], productDomains: ["sales", "inventory", "products"], canonicalTargets: ["location"] },
    { id: "employees", resource: "Employee", endpoint: "Employee.json", recordIdField: "employeeID", modifiedField: "timeStamp", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["shops"], productDomains: ["sales"], canonicalTargets: ["worker"] },
    { id: "categories", resource: "Category", endpoint: "Category.json", recordIdField: "categoryID", modifiedField: "timeStamp", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: [], productDomains: ["products", "sales", "inventory"], canonicalTargets: ["product_category"] },
    { id: "items", resource: "Item", endpoint: "Item.json", recordIdField: "itemID", modifiedField: "timeStamp", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["categories"], productDomains: ["products", "sales", "inventory"], canonicalTargets: ["product", "product_variant"] },
    { id: "item_shops", resource: "ItemShop", endpoint: "ItemShop.json", recordIdField: "itemShopID", modifiedField: "timeStamp", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "full_snapshot", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["shops", "items"], productDomains: ["inventory"], canonicalTargets: ["inventory_balance_snapshot"] },
    { id: "sales", resource: "Sale", endpoint: "Sale.json", recordIdField: "saleID", modifiedField: "timeStamp", pagination: "vendor_cursor", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["shops", "employees", "items", "customers", "payment_types", "tax_categories"], productDomains: ["sales", "customers"], canonicalTargets: ["commerce_order", "commerce_order_line", "commerce_payment", "commerce_refund_line"] },
    { id: "customers", resource: "Customer", endpoint: "Customer.json", recordIdField: "customerID", modifiedField: "timeStamp", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: [], productDomains: ["customers"], canonicalTargets: ["customer_account"] },
    { id: "vendors", resource: "Vendor", endpoint: "Vendor.json", recordIdField: "vendorID", modifiedField: "timeStamp", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: [], productDomains: ["inventory"], canonicalTargets: ["supplier"] },
    { id: "orders", resource: "Order", endpoint: "Order.json", recordIdField: "orderID", modifiedField: "timeStamp", pagination: "vendor_cursor", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["shops", "employees", "items", "vendors"], productDomains: ["inventory"], canonicalTargets: ["purchase_order_line"] },
    { id: "order_lines", resource: "OrderLine", endpoint: "OrderLine.json", recordIdField: "orderLineID", modifiedField: "timeStamp", pagination: "vendor_cursor", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["orders", "items"], productDomains: ["inventory"], canonicalTargets: ["purchase_order_line"] },
    { id: "payment_types", resource: "PaymentType", endpoint: "PaymentType.json", recordIdField: "paymentTypeID", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "full_snapshot", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: [], productDomains: ["sales"], canonicalTargets: ["commerce_payment"] },
    { id: "tax_categories", resource: "TaxCategory", endpoint: "TaxCategory.json", recordIdField: "taxCategoryID", modifiedField: "timeStamp", pagination: "vendor_cursor", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: [], productDomains: ["sales"], canonicalTargets: ["tax_code"] },
    { id: "inventory_logs", resource: "InventoryLog", endpoint: "InventoryLog.json", recordIdField: "inventoryLogID", modifiedField: "createTime", pagination: "vendor_cursor", backfillStrategy: "time_windowed", lateEditStrategy: "append_only", deletionStrategy: "immutable_append_only", sourceTotalStrategy: "count_distinct_complete_scan", availability: "optional", dependencies: ["shops", "items"], productDomains: ["inventory"], canonicalTargets: ["inventory_movement"] },
  ],
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
  },
  capabilities: {
    "connector.variant.r_series": {
      support: "full", streams: ["shops"],
      reason: "A successful R-Series Account and Shop extraction verifies the vendor variant.",
    },
    "commerce.orders": {
      support: "full", streams: ["sales"],
      reason: "Sale headers map to canonical commercial orders.",
    },
    "commerce.order_lines": {
      support: "full", streams: ["sales"],
      reason: "SaleLine observations map to canonical order lines.",
    },
    "commerce.order_lines.discounts": {
      support: "full", streams: ["sales"],
      reason: "SaleLine normal price, unit price and discount amount support governed discount measures.",
    },
    "commerce.refunds": {
      support: "full", streams: ["sales"],
      reason: "Negative or refund-linked SaleLine observations map to canonical refund lines.",
    },
    "commerce.payments": {
      support: "full", streams: ["sales"],
      reason: "Loaded SalePayments map to canonical tender events.",
    },
    "commerce.orders.customer": {
      support: "full", streams: ["sales"], coverageFields: ["customerID"],
      reason: "Sale customerID supports governed customer attribution; observed coverage is reported separately.",
    },
    "commerce.order_lines.worker_attribution": {
      support: "full", streams: ["sales"], coverageFields: ["employeeID"],
      reason: "Sale and SaleLine employee identifiers support worker attribution; observed coverage is reported separately.",
    },
    "commerce.order_lines.cost": {
      support: "full", streams: ["sales"], coverageFields: ["SaleLines", "calcAvgCost"],
      reason: "The product-cost scope and SaleLine cost fields support governed cost and margin measures.",
    },
    "inventory.balances": {
      support: "full", streams: ["item_shops"],
      reason: "ItemShop quantity on hand maps to canonical inventory balance snapshots.",
    },
    "inventory.cost": {
      support: "partial", streams: ["item_shops"], coverageFields: ["averageCost", "totalValueAvgCost"], requiresObservedCoverage: true,
      reason: "Inventory valuation is available where ItemShop cost or value fields are populated.",
    },
    "inventory.purchase_orders": {
      support: "full", streams: ["vendors", "orders"],
      reason: "Vendor supplier identities and dependent Order lines jointly provide attributable purchase-order facts.",
    },
    "inventory.movements": {
      support: "partial", streams: ["inventory_logs"],
      reason: "InventoryLog supplies movement observations when enabled for the account.",
    },
    "inventory.stocktakes": {
      support: "partial", streams: ["inventory_logs"], coverageFields: ["inventoryCountID"], requiresObservedCoverage: true, nonZeroCoverage: true,
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
    "Order with loaded OrderLines is the sole complete purchase-order projection; standalone OrderLine is an identity and deletion-reconciliation stream.",
  ],
  fieldCoverage: [
    ...coverage("shops", {
      shopID: "location.source_id", name: "location.name", timeZone: "location.timezone",
      archived: "location.inactive", timeStamp: "location.source_updated_at", Contact: "location.contact",
    }, [
      "serviceRate", "taxLabor", "labelTitle", "labelMsrp", "companyRegistrationNumber",
      "vatNumber", "zebraBrowserPrint", "contactID", "taxCategoryID", "receiptSetupID",
      "vendorID", "ccGatewayID", "gatewayConfigID", "priceLevelID",
    ], { Contact: "business_contact" }),
    ...coverage("employees", {
      employeeID: "worker.source_id", firstName: "person.first_name", lastName: "person.last_name",
      lockOut: "worker.login_locked", archived: "worker.inactive", timeStamp: "worker.source_updated_at",
      Contact: "worker.contact",
    }, [
      "contactID", "clockInEmployeeHoursID", "employeeRoleID", "limitToShopID", "lastShopID",
      "lastSaleID", "lastRegisterID",
    ], { firstName: "employee_contact", lastName: "employee_contact", Contact: "employee_contact" }),
    ...coverage("categories", {
      categoryID: "product_category.source_id", name: "product_category.name",
      parentID: "product_category.parent_source_id", nodeDepth: "product_category.depth",
      timeStamp: "product_category.source_updated_at",
    }, ["fullPathName", "leftNode", "rightNode", "createTime", "Parent"]),
    ...coverage("items", {
      itemID: "product_variant.source_id", systemSku: "product_variant.sku", description: "product.name",
      categoryID: "product_category_assignment.category_source_id", defaultCost: "product_variant.unit_cost",
      archived: "product_variant.inactive", timeStamp: "product_variant.source_updated_at",
    }, [
      "avgCost", "tax", "discountable", "itemType", "serialized", "modelYear", "upc", "ean",
      "customSku", "manufacturerSku", "createTime", "publishToEcom", "taxClassID", "departmentID",
      "itemMatrixID", "manufacturerID", "seasonID", "defaultVendorID", "Category", "TaxClass",
      "Department", "ItemAttributes", "Manufacturer", "Note", "Season", "ItemShops",
      "ItemComponents", "ItemShelfLocations", "ItemVendorNums", "CustomFieldValues", "Prices",
    ], { description: "free_text_untrusted", Note: "free_text_untrusted" }),
    ...coverage("item_shops", {
      itemShopID: "inventory_balance_snapshot.source_id", itemID: "product_variant.source_id",
      shopID: "stock_location.source_id", qoh: "inventory_balance_snapshot.quantity",
      timeStamp: "inventory_balance_snapshot.source_updated_at",
    }, [
      "sellable", "backorder", "componentQoh", "componentBackorder", "reorderPoint", "reorderLevel",
      "onLayaway", "onSpecialOrder", "onWorkOrder", "onWorkorder", "onTransferOut", "onTransferIn",
      "averageCost", "totalValueFifo", "totalValueAvgCost", "totalValueNegativeInventory",
      "lastReceivedCost", "lastReceivedLotID", "nextFifoLotCost", "nextFifoLotID",
    ]),
    ...coverage("sales", {
      saleID: "commerce_order.source_id", shopID: "location.source_id", employeeID: "worker.source_id",
      registerID: "register.source_id", customerID: "customer_account.source_id",
      completed: "commerce_order.completed", voided: "commerce_order.voided",
      completeTime: "commerce_order.completed_at", timeStamp: "commerce_order.source_updated_at",
      total: "commerce_order.net_amount_inc_tax", taxTotal: "commerce_order.tax_amount",
      SaleLines: "commerce_order_line.observations", SalePayments: "commerce_payment.observations",
    }, [
      "discountPercent", "archived", "enablePromotions", "isTaxInclusive", "createTime", "updatetime",
      "updateTime", "referenceNumber", "referenceNumberSource", "tax1Rate", "tax2Rate", "change",
      "tipEnabled", "receiptPreference", "displayableSubtotal", "ticketNumber", "calcDiscount",
      "calcTotal", "calcSubtotal", "calcTaxable", "calcNonTaxable", "calcAvgCost", "calcFIFOCost",
      "calcTax1", "calcTax2", "calcPayments", "calcTips", "calcSurcharges", "calcItemFees", "totalDue",
      "displayableTotal", "balance", "cashRoundingDelta", "cashRoundedBalance", "cashRoundedTotal",
      "discountID", "tipEmployeeID", "quoteID", "shipToID", "taxCategoryID", "Customer", "Discount",
      "Quote", "ShipTo", "TaxCategory", "tippableAmount",
    ], { referenceNumber: "free_text_untrusted" }),
    ...coverage("customers", {
      customerID: "customer_account.source_id", firstName: "person.first_name", lastName: "person.last_name",
      company: "customer_account.company_name", archived: "customer_account.inactive",
      timeStamp: "customer_account.source_updated_at", Contact: "customer_account.contact",
    }, [
      "dob", "title", "companyRegistrationNumber", "vatNumber", "creditAccountID", "customerTypeID",
      "discountID", "taxCategoryID", "createTime",
    ], {
      firstName: "customer_contact", lastName: "customer_contact", company: "business_contact",
      dob: "customer_contact", Contact: "customer_contact",
    }),
    ...coverage("vendors", {
      vendorID: "supplier.source_id", name: "supplier.name", archived: "supplier.inactive",
      timeStamp: "supplier.source_updated_at",
    }, [
      "accountNumber", "priceLevel", "updatePrice", "updateCost", "updateDescription",
      "shareSellThrough", "b2bSellerUID", "Contact", "purchasingCurrency",
    ], {
      accountNumber: "free_text_untrusted", Contact: "business_contact", Reps: "business_contact",
    }),
    ...coverage("orders", {
      orderID: "purchase_order_line.order_source_id", shopID: "location.source_id",
      vendorID: "supplier.source_id", createdByEmployeeID: "worker.source_id",
      orderedDate: "purchase_order_line.ordered_at", receivedDate: "purchase_order_line.received_at",
      totalCost: "purchase_order_line.order_total", timeStamp: "purchase_order_line.source_updated_at",
      OrderLines: "purchase_order_line.observations",
    }, [
      "arrivalDate", "refNum", "shipInstructions", "stockInstructions", "shipCost", "shipVendorCost",
      "otherCost", "otherVendorCost", "complete", "archived", "discount", "totalDiscount",
      "totalQuantity", "subTotalCost", "noteID", "createTime", "vendorCurrencyRate",
      "vendorCurrencyCode", "shippingCostMethod", "hasShipments", "discountMethod", "discountMoneyValue",
      "discountMoneyVendorValue", "discountIsPercent", "discountPercentValue", "costsModifiedAfterShipment",
      "b2bOrderUID", "b2bOrderNumber", "Vendor", "Note", "Shop", "CustomFieldValues",
    ], { refNum: "free_text_untrusted", shipInstructions: "free_text_untrusted", stockInstructions: "free_text_untrusted", Note: "free_text_untrusted" }),
    ...coverage("order_lines", {
      orderLineID: "purchase_order_line.source_id", orderID: "purchase_order_line.order_source_id",
      itemID: "product_variant.source_id", quantity: "purchase_order_line.quantity",
      price: "purchase_order_line.unit_cost", timeStamp: "purchase_order_line.source_updated_at",
    }, [
      "originalPrice", "vendorCost", "checkedIn", "numReceived", "total", "createTime", "shippingCost",
      "shippingVendorCost", "discountMoneyValue", "discountMoneyVendorValue", "discountPercentValue",
    ]),
    ...coverage("payment_types", {
      paymentTypeID: "metadata.source_record_id",
    }, ["name", "archived", "requireCustomer", "internalReserved", "type", "refundAsPaymentTypeID"]),
    ...coverage("tax_categories", {
      taxCategoryID: "tax_code.source_id", tax1Name: "tax_code.name", tax1Rate: "tax_code.rate",
      isTaxInclusive: "tax_code.inclusive", timeStamp: "tax_code.source_updated_at",
    }, ["tax2Name", "tax2Rate", "TaxCategoryClasses"]),
    ...coverage("inventory_logs", {
      inventoryLogID: "inventory_movement.source_id", itemID: "product_variant.source_id",
      shopID: "stock_location.source_id", qohChange: "inventory_movement.quantity",
      costChange: "inventory_movement.unit_cost", createTime: "inventory_movement.occurred_at",
      reason: "inventory_movement.reason", employeeID: "worker.source_id",
    }, [
      "automated", "causedNegative", "orderID", "transferID", "saleID", "inventoryCountID",
      "customerID", "vendorReturnID", "itemImportID",
    ], { reason: "free_text_untrusted" }),
  ],
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
