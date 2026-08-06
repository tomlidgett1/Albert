/**
 * Top-level fields published by Lightspeed's official R-Series V3 endpoint
 * reference. The documentation build used for this reviewed catalogue reports
 * `Mon, 27 Jul 2026 19:51:56 +0000` on each endpoint page.
 * Nested relations remain inside their dispositioned parent JSON field.
 */
export const LIGHTSPEED_R_DOCUMENTATION_BUILD = "2026-07-27T19:51:56Z";

export const LIGHTSPEED_R_DOCUMENTED_FIELDS = Object.freeze({
  ls_shops: Object.freeze([
    "shopID", "name", "serviceRate", "timeZone", "taxLabor", "labelTitle",
    "labelMsrp", "archived", "contactID", "taxCategoryID", "receiptSetupID",
    "ccGatewayID", "priceLevelID", "Contact", "TaxCategory", "ReceiptSetup",
    "CCGateway", "PriceLevel", "Registers", "networkHealthTool",
  ]),
  ls_employees: Object.freeze([
    "employeeID", "firstName", "lastName", "lockOut", "archived", "contactID",
    "clockInEmployeeHoursID", "employeeRoleID", "limitToShopID", "lastShopID",
    "lastSaleID", "lastRegisterID", "Contact", "EmployeeRole", "EmployeeRights",
    "timeStamp", "createTime",
  ]),
  ls_categories: Object.freeze([
    "categoryID", "name", "nodeDepth", "fullPathName", "leftNode", "rightNode",
    "createTime", "timeStamp", "parentID", "Parent",
  ]),
  ls_items: Object.freeze([
    "itemID", "systemSku", "defaultCost", "avgCost", "tax", "archived",
    "discountable", "itemType", "serialized", "description", "modelYear", "upc",
    "ean", "customSku", "manufacturerSku", "timeStamp", "createTime",
    "publishToEcom", "categoryID", "taxClassID", "departmentID", "itemMatrixID",
    "manufacturerID", "seasonID", "defaultVendorID", "Category", "TaxClass",
    "Department", "ItemAttributes", "Manufacturer", "Note", "Season", "ItemShops",
    "ItemComponents", "ItemShelfLocations", "ItemVendorNums", "CustomFieldValues",
    "laborDurationMinutes",
  ]),
  ls_item_shops: Object.freeze([
    "itemShopID", "qoh", "sellable", "backorder", "componentQoh",
    "componentBackorder", "reorderPoint", "reorderLevel", "timeStamp", "itemID",
    "shopID", "onLayaway", "onSpecialOrder", "onWorkOrder", "onTransferOut",
    "onTransferIn", "averageCost", "totalValueFifo", "totalValueAvgCost",
    "totalValueNegativeInventory", "lastReceivedCost", "lastReceivedLotID",
    "nextFifoLotCost", "nextFifoLotID",
  ]),
  ls_sales: Object.freeze([
    "saleID", "timeStamp", "discountPercent", "completed", "archived", "voided",
    "enablePromotions", "createTime", "updatetime", "completeTime", "referenceNumber",
    "referenceNumberSource", "tax1Rate", "tax2Rate", "change", "tipEnabled",
    "calcDiscount", "calcTotal", "calcSubtotal", "calcTaxable", "calcNonTaxable",
    "calcAvgCost", "calcFIFOCost", "calcTax1", "calcTax2", "calcPayments",
    "calcTips", "total", "totalDue", "displayableTotal", "balance",
    "cashRoundingDelta", "cashRoundedBalance", "cashRoundedTotal", "customerID",
    "discountID", "employeeID", "tipEmployeeID", "quoteID", "registerID",
    "shipToID", "shopID", "taxCategoryID", "Customer", "Discount", "Quote",
    "ShipTo", "TaxCategory", "SaleLines", "SalePayments",
  ]),
  ls_customers: Object.freeze([
    "customerID", "firstName", "lastName", "dob", "archived", "title", "company",
    "companyRegistrationNumber", "vatNumber", "createTime", "timeStamp",
    "creditAccountID", "customerTypeID", "discountID", "taxCategoryID", "Contact",
    "CreditAccount", "CustomerType", "Discount", "Note", "TaxCategory",
    "CustomFieldValues", "contactID",
  ]),
  ls_vendors: Object.freeze([
    "vendorID", "name", "archived", "accountNumber", "priceLevel", "updatePrice",
    "updateCost", "updateDescription", "shareSellThrough", "timeStamp", "b2bSellerUID",
    "Contact", "Reps", "purchasingCurrency",
  ]),
  ls_purchase_orders: Object.freeze([
    "orderID", "orderedDate", "receivedDate", "arrivalDate", "refNum",
    "shipInstructions", "stockInstructions", "shipCost", "shipVendorCost", "otherCost",
    "otherVendorCost", "complete", "archived", "discount", "totalDiscount",
    "totalQuantity", "vendorID", "noteID", "shopID", "createdByEmployeeID", "Vendor",
    "Note", "Shop", "OrderLines", "CustomFieldValues", "createTime", "timeStamp",
    "vendorCurrencyRate", "vendorCurrencyCode", "shippingCostMethod", "hasShipments",
    "discountMethod", "discountMoneyValue", "discountMoneyVendorValue",
    "discountIsPercent", "discountPercentValue", "costsModifiedAfterShipment",
    "b2bOrderUID", "b2bOrderNumber",
  ]),
  ls_purchase_order_lines: Object.freeze([
    "orderLineID", "quantity", "price", "originalPrice", "vendorCost", "checkedIn",
    "numReceived", "orderID", "itemID", "timeStamp", "total", "createTime",
    "shippingCost", "shippingVendorCost", "discountMoneyValue",
    "discountMoneyVendorValue", "discountPercentValue",
  ]),
  ls_payment_types: Object.freeze([
    "paymentTypeID", "name", "requireCustomer", "archived", "internalReserved",
    "type", "refundAsPaymentTypeID", "code", "channel",
  ]),
  ls_tax_categories: Object.freeze([
    "taxCategoryID", "isTaxInclusive", "tax1Name", "tax2Name", "tax1Rate",
    "tax2Rate", "TaxCategoryClasses", "timeStamp",
  ]),
  ls_inventory_logs: Object.freeze([
    "inventoryLogID", "qohChange", "costChange", "createTime", "automated", "reason",
    "causedNegative", "employeeID", "itemID", "shopID", "orderID", "transferID",
    "saleID", "inventoryCountID", "customerID", "vendorReturnID", "itemImportID",
  ]),
} as const);

export type LightspeedRDocumentedStream = keyof typeof LIGHTSPEED_R_DOCUMENTED_FIELDS;
