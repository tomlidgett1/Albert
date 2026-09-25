# GENERATED FILE — do not edit.
# Source: connectors/lightspeed-r/tables.json (pack 2.0.0) via
# scripts/generate-fivetran-lightspeed-sdk-spec.ts. Regenerate with:
#   npx tsx scripts/generate-fivetran-lightspeed-sdk-spec.ts
import json

SPEC_SHA256 = "8f6e7f50563e12aa5adda63f56ef5633ddf2c22402b441fdfb3ca08173658b14"

SPEC = json.loads(r'''{
 "revision": "2.0.0 (R-Series API V3; documentation build 2026-07-27T19:51:56Z)",
 "tables": {
  "ls_sales": {
   "id": "ls_sales",
   "domain": "sales",
   "additivity": "additive",
   "primaryKey": [
    "sale_id"
   ],
   "recordIdField": "saleID",
   "availability": "required",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    },
    {
     "column": "completed",
     "field": "completed",
     "type": "boolean"
    },
    {
     "column": "voided",
     "field": "voided",
     "type": "boolean"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "complete_time",
     "field": "completeTime",
     "type": "timestamptz"
    },
    {
     "column": "updatetime",
     "field": "updatetime",
     "type": "timestamptz"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "reference_number",
     "field": "referenceNumber",
     "type": "text"
    },
    {
     "column": "reference_number_source",
     "field": "referenceNumberSource",
     "type": "text"
    },
    {
     "column": "tax1_rate",
     "field": "tax1Rate",
     "type": "numeric"
    },
    {
     "column": "tax2_rate",
     "field": "tax2Rate",
     "type": "numeric"
    },
    {
     "column": "change",
     "field": "change",
     "type": "numeric"
    },
    {
     "column": "tip_enabled",
     "field": "tipEnabled",
     "type": "boolean"
    },
    {
     "column": "enable_promotions",
     "field": "enablePromotions",
     "type": "boolean"
    },
    {
     "column": "calc_discount",
     "field": "calcDiscount",
     "type": "numeric"
    },
    {
     "column": "calc_total",
     "field": "calcTotal",
     "type": "numeric"
    },
    {
     "column": "calc_subtotal",
     "field": "calcSubtotal",
     "type": "numeric"
    },
    {
     "column": "calc_taxable",
     "field": "calcTaxable",
     "type": "numeric"
    },
    {
     "column": "calc_non_taxable",
     "field": "calcNonTaxable",
     "type": "numeric"
    },
    {
     "column": "calc_avg_cost",
     "field": "calcAvgCost",
     "type": "numeric"
    },
    {
     "column": "calc_fifo_cost",
     "field": "calcFIFOCost",
     "type": "numeric"
    },
    {
     "column": "calc_tax1",
     "field": "calcTax1",
     "type": "numeric"
    },
    {
     "column": "calc_tax2",
     "field": "calcTax2",
     "type": "numeric"
    },
    {
     "column": "calc_payments",
     "field": "calcPayments",
     "type": "numeric"
    },
    {
     "column": "calc_tips",
     "field": "calcTips",
     "type": "numeric"
    },
    {
     "column": "total",
     "field": "total",
     "type": "numeric"
    },
    {
     "column": "total_due",
     "field": "totalDue",
     "type": "numeric"
    },
    {
     "column": "displayable_total",
     "field": "displayableTotal",
     "type": "numeric"
    },
    {
     "column": "balance",
     "field": "balance",
     "type": "numeric"
    },
    {
     "column": "customer_id",
     "field": "customerID",
     "type": "numeric"
    },
    {
     "column": "discount_id",
     "field": "discountID",
     "type": "numeric"
    },
    {
     "column": "discount_percent",
     "field": "discountPercent",
     "type": "numeric"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "tip_employee_id",
     "field": "tipEmployeeID",
     "type": "numeric"
    },
    {
     "column": "quote_id",
     "field": "quoteID",
     "type": "numeric"
    },
    {
     "column": "register_id",
     "field": "registerID",
     "type": "numeric"
    },
    {
     "column": "ship_to_id",
     "field": "shipToID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "tax_category_id",
     "field": "taxCategoryID",
     "type": "numeric"
    }
   ]
  },
  "ls_sale_lines": {
   "id": "ls_sale_lines",
   "domain": "sales",
   "additivity": "additive",
   "primaryKey": [
    "sale_line_id"
   ],
   "recordIdField": "saleLineID",
   "availability": "required",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "sale_line_id",
     "field": "saleLineID",
     "type": "numeric"
    },
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "unit_quantity",
     "field": "unitQuantity",
     "type": "numeric"
    },
    {
     "column": "unit_price",
     "field": "unitPrice",
     "type": "numeric"
    },
    {
     "column": "normal_unit_price",
     "field": "normalUnitPrice",
     "type": "numeric"
    },
    {
     "column": "discount_amount",
     "field": "discountAmount",
     "type": "numeric"
    },
    {
     "column": "discount_percent",
     "field": "discountPercent",
     "type": "numeric"
    },
    {
     "column": "avg_cost",
     "field": "avgCost",
     "type": "numeric"
    },
    {
     "column": "fifo_cost",
     "field": "fifoCost",
     "type": "numeric"
    },
    {
     "column": "tax",
     "field": "tax",
     "type": "boolean"
    },
    {
     "column": "tax1_rate",
     "field": "tax1Rate",
     "type": "numeric"
    },
    {
     "column": "tax2_rate",
     "field": "tax2Rate",
     "type": "numeric"
    },
    {
     "column": "is_layaway",
     "field": "isLayaway",
     "type": "boolean"
    },
    {
     "column": "is_workorder",
     "field": "isWorkorder",
     "type": "boolean"
    },
    {
     "column": "is_special_order",
     "field": "isSpecialOrder",
     "type": "boolean"
    },
    {
     "column": "displayable_subtotal",
     "field": "displayableSubtotal",
     "type": "numeric"
    },
    {
     "column": "displayable_unit_price",
     "field": "displayableUnitPrice",
     "type": "numeric"
    },
    {
     "column": "calc_line_discount",
     "field": "calcLineDiscount",
     "type": "numeric"
    },
    {
     "column": "calc_transaction_discount",
     "field": "calcTransactionDiscount",
     "type": "numeric"
    },
    {
     "column": "calc_total",
     "field": "calcTotal",
     "type": "numeric"
    },
    {
     "column": "calc_subtotal",
     "field": "calcSubtotal",
     "type": "numeric"
    },
    {
     "column": "calc_tax1",
     "field": "calcTax1",
     "type": "numeric"
    },
    {
     "column": "calc_tax2",
     "field": "calcTax2",
     "type": "numeric"
    },
    {
     "column": "tax_class_id",
     "field": "taxClassID",
     "type": "numeric"
    },
    {
     "column": "customer_id",
     "field": "customerID",
     "type": "numeric"
    },
    {
     "column": "discount_id",
     "field": "discountID",
     "type": "numeric"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "note_id",
     "field": "noteID",
     "type": "numeric"
    },
    {
     "column": "parent_sale_line_id",
     "field": "parentSaleLineID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "tax_category_id",
     "field": "taxCategoryID",
     "type": "numeric"
    },
    {
     "column": "item_fee_id",
     "field": "itemFeeID",
     "type": "numeric"
    },
    {
     "column": "line_type",
     "field": "lineType",
     "type": "text"
    },
    {
     "column": "require_full_reservation",
     "field": "requireFullReservation",
     "type": "boolean"
    },
    {
     "column": "completed",
     "field": "completed",
     "type": "boolean"
    },
    {
     "column": "voided",
     "field": "voided",
     "type": "boolean"
    },
    {
     "column": "complete_time",
     "field": "completeTime",
     "type": "timestamptz"
    }
   ]
  },
  "ls_sale_payments": {
   "id": "ls_sale_payments",
   "domain": "sales",
   "additivity": "additive",
   "primaryKey": [
    "sale_payment_id"
   ],
   "recordIdField": "salePaymentID",
   "availability": "required",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "sale_payment_id",
     "field": "salePaymentID",
     "type": "numeric"
    },
    {
     "column": "amount",
     "field": "amount",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "remote_reference",
     "field": "remoteReference",
     "type": "text"
    },
    {
     "column": "tip_amount",
     "field": "tipAmount",
     "type": "numeric"
    },
    {
     "column": "payment_id",
     "field": "paymentID",
     "type": "text"
    },
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    },
    {
     "column": "payment_type_id",
     "field": "paymentTypeID",
     "type": "numeric"
    },
    {
     "column": "cc_charge_id",
     "field": "ccChargeID",
     "type": "numeric"
    },
    {
     "column": "ref_payment_id",
     "field": "refPaymentID",
     "type": "numeric"
    },
    {
     "column": "register_id",
     "field": "registerID",
     "type": "numeric"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "credit_account_id",
     "field": "creditAccountID",
     "type": "numeric"
    },
    {
     "column": "completed",
     "field": "completed",
     "type": "boolean"
    },
    {
     "column": "voided",
     "field": "voided",
     "type": "boolean"
    },
    {
     "column": "complete_time",
     "field": "completeTime",
     "type": "timestamptz"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    }
   ]
  },
  "ls_sale_accounts": {
   "id": "ls_sale_accounts",
   "domain": "sales",
   "additivity": "reference",
   "primaryKey": [
    "sale_account_id"
   ],
   "recordIdField": "saleAccountID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "sale_account_id",
     "field": "saleAccountID",
     "type": "numeric"
    },
    {
     "column": "credit_account_id",
     "field": "creditAccountID",
     "type": "numeric"
    },
    {
     "column": "sale_payment_id",
     "field": "salePaymentID",
     "type": "numeric"
    },
    {
     "column": "sale_line_id",
     "field": "saleLineID",
     "type": "numeric"
    }
   ]
  },
  "ls_sale_payment_signatures": {
   "id": "ls_sale_payment_signatures",
   "domain": "sales",
   "additivity": "reference",
   "primaryKey": [
    "sale_payment_signature_id"
   ],
   "recordIdField": "salePaymentSignatureID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "sale_payment_signature_id",
     "field": "salePaymentSignatureID",
     "type": "numeric"
    },
    {
     "column": "file_path",
     "field": "filePath",
     "type": "text"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "sale_payment_id",
     "field": "salePaymentID",
     "type": "numeric"
    }
   ]
  },
  "ls_sale_line_inventory_allocations": {
   "id": "ls_sale_line_inventory_allocations",
   "domain": "sales",
   "additivity": "additive",
   "primaryKey": [
    "inventory_sale_id"
   ],
   "recordIdField": "inventorySaleID",
   "availability": "optional",
   "deletionStrategy": "immutable_append_only",
   "columns": [
    {
     "column": "inventory_sale_id",
     "field": "inventorySaleID",
     "type": "numeric"
    },
    {
     "column": "quantity",
     "field": "quantity",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "inventory_id",
     "field": "inventoryID",
     "type": "numeric"
    },
    {
     "column": "sale_line_id",
     "field": "saleLineID",
     "type": "numeric"
    },
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    }
   ]
  },
  "ls_sale_voids": {
   "id": "ls_sale_voids",
   "domain": "sales",
   "additivity": "additive",
   "primaryKey": [
    "sale_void_id"
   ],
   "recordIdField": "saleVoidID",
   "availability": "optional",
   "deletionStrategy": "immutable_append_only",
   "columns": [
    {
     "column": "sale_void_id",
     "field": "saleVoidID",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "reason",
     "field": "reason",
     "type": "text"
    },
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    }
   ]
  },
  "ls_cc_charges": {
   "id": "ls_cc_charges",
   "domain": "sales",
   "additivity": "last_value_over_time",
   "primaryKey": [
    "cc_charge_id"
   ],
   "recordIdField": "ccChargeID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "cc_charge_id",
     "field": "ccChargeID",
     "type": "numeric"
    },
    {
     "column": "gateway_trans_id",
     "field": "gatewayTransID",
     "type": "text"
    },
    {
     "column": "xnum",
     "field": "xnum",
     "type": "text"
    },
    {
     "column": "response",
     "field": "response",
     "type": "text"
    },
    {
     "column": "voided",
     "field": "voided",
     "type": "boolean"
    },
    {
     "column": "refunded",
     "field": "refunded",
     "type": "numeric"
    },
    {
     "column": "amount",
     "field": "amount",
     "type": "numeric"
    },
    {
     "column": "exp",
     "field": "exp",
     "type": "text"
    },
    {
     "column": "auth_only",
     "field": "authOnly",
     "type": "boolean"
    },
    {
     "column": "auth_code",
     "field": "authCode",
     "type": "text"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "declined",
     "field": "declined",
     "type": "boolean"
    },
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    },
    {
     "column": "entry_method",
     "field": "entryMethod",
     "type": "text"
    },
    {
     "column": "cardholder_name",
     "field": "cardholderName",
     "type": "text"
    },
    {
     "column": "communication_key",
     "field": "communicationKey",
     "type": "text"
    }
   ]
  },
  "ls_processing_fees": {
   "id": "ls_processing_fees",
   "domain": "sales",
   "additivity": "additive",
   "primaryKey": [
    "sale_payment_processing_fee_id"
   ],
   "recordIdField": "salePaymentProcessingFeeID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "sale_payment_processing_fee_id",
     "field": "salePaymentProcessingFeeID",
     "type": "numeric"
    },
    {
     "column": "sale_payment_id",
     "field": "salePaymentID",
     "type": "numeric"
    },
    {
     "column": "processing_fee_ref",
     "field": "processingFeeRef",
     "type": "text"
    },
    {
     "column": "processor",
     "field": "processor",
     "type": "text"
    },
    {
     "column": "amount",
     "field": "amount",
     "type": "numeric"
    },
    {
     "column": "fixed_fee",
     "field": "fixedFee",
     "type": "numeric"
    },
    {
     "column": "variable_fee",
     "field": "variableFee",
     "type": "numeric"
    },
    {
     "column": "variable_pct",
     "field": "variablePct",
     "type": "numeric"
    },
    {
     "column": "interchange_fees_fixed_fee",
     "field": "interchangeFeesFixedFee",
     "type": "numeric"
    },
    {
     "column": "interchange_fees_variable_fee",
     "field": "interchangeFeesVariableFee",
     "type": "numeric"
    },
    {
     "column": "interchange_fees_variable_pct",
     "field": "interchangeFeesVariablePct",
     "type": "numeric"
    },
    {
     "column": "scheme_fees_fixed_fee",
     "field": "schemeFeesFixedFee",
     "type": "numeric"
    },
    {
     "column": "scheme_fees_variable_fee",
     "field": "schemeFeesVariableFee",
     "type": "numeric"
    },
    {
     "column": "scheme_fees_variable_pct",
     "field": "schemeFeesVariablePct",
     "type": "numeric"
    },
    {
     "column": "processing_time",
     "field": "processingTime",
     "type": "timestamptz"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "update_time",
     "field": "updateTime",
     "type": "timestamptz"
    }
   ]
  },
  "ls_quotes": {
   "id": "ls_quotes",
   "domain": "sales",
   "additivity": "last_value_over_time",
   "primaryKey": [
    "quote_id"
   ],
   "recordIdField": "quoteID",
   "availability": "optional",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "quote_id",
     "field": "quoteID",
     "type": "numeric"
    },
    {
     "column": "issue_date",
     "field": "issueDate",
     "type": "timestamptz"
    },
    {
     "column": "notes",
     "field": "notes",
     "type": "text"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    }
   ]
  },
  "ls_discounts": {
   "id": "ls_discounts",
   "domain": "sales",
   "additivity": "reference",
   "primaryKey": [
    "discount_id"
   ],
   "recordIdField": "discountID",
   "availability": "optional",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "discount_id",
     "field": "discountID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "discount_amount",
     "field": "discountAmount",
     "type": "numeric"
    },
    {
     "column": "discount_percent",
     "field": "discountPercent",
     "type": "numeric"
    },
    {
     "column": "require_customer",
     "field": "requireCustomer",
     "type": "boolean"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "source_id",
     "field": "sourceID",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_items": {
   "id": "ls_items",
   "domain": "catalogue",
   "additivity": "non_additive",
   "primaryKey": [
    "item_id"
   ],
   "recordIdField": "itemID",
   "availability": "required",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "system_sku",
     "field": "systemSku",
     "type": "text"
    },
    {
     "column": "default_cost",
     "field": "defaultCost",
     "type": "numeric"
    },
    {
     "column": "avg_cost",
     "field": "avgCost",
     "type": "numeric"
    },
    {
     "column": "tax",
     "field": "tax",
     "type": "boolean"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "discountable",
     "field": "discountable",
     "type": "boolean"
    },
    {
     "column": "item_type",
     "field": "itemType",
     "type": "text"
    },
    {
     "column": "serialized",
     "field": "serialized",
     "type": "boolean"
    },
    {
     "column": "description",
     "field": "description",
     "type": "text"
    },
    {
     "column": "model_year",
     "field": "modelYear",
     "type": "numeric"
    },
    {
     "column": "upc",
     "field": "upc",
     "type": "text"
    },
    {
     "column": "ean",
     "field": "ean",
     "type": "text"
    },
    {
     "column": "custom_sku",
     "field": "customSku",
     "type": "text"
    },
    {
     "column": "manufacturer_sku",
     "field": "manufacturerSku",
     "type": "text"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "publish_to_ecom",
     "field": "publishToEcom",
     "type": "boolean"
    },
    {
     "column": "category_id",
     "field": "categoryID",
     "type": "numeric"
    },
    {
     "column": "tax_class_id",
     "field": "taxClassID",
     "type": "numeric"
    },
    {
     "column": "department_id",
     "field": "departmentID",
     "type": "numeric"
    },
    {
     "column": "item_matrix_id",
     "field": "itemMatrixID",
     "type": "numeric"
    },
    {
     "column": "manufacturer_id",
     "field": "manufacturerID",
     "type": "numeric"
    },
    {
     "column": "season_id",
     "field": "seasonID",
     "type": "numeric"
    },
    {
     "column": "default_vendor_id",
     "field": "defaultVendorID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "full_path_name",
     "field": "fullPathName",
     "type": "text"
    },
    {
     "column": "tax_class",
     "field": "TaxClass",
     "type": "jsonb"
    },
    {
     "column": "note",
     "field": "Note",
     "type": "jsonb"
    },
    {
     "column": "custom_field_values",
     "field": "CustomFieldValues",
     "type": "jsonb"
    },
    {
     "column": "attribute1",
     "field": "attribute1",
     "type": "text"
    },
    {
     "column": "attribute2",
     "field": "attribute2",
     "type": "text"
    },
    {
     "column": "attribute3",
     "field": "attribute3",
     "type": "text"
    },
    {
     "column": "item_attribute_set_id",
     "field": "itemAttributeSetID",
     "type": "numeric"
    },
    {
     "column": "attribute_name1",
     "field": "attributeName1",
     "type": "text"
    },
    {
     "column": "attribute_name2",
     "field": "attributeName2",
     "type": "text"
    },
    {
     "column": "attribute_name3",
     "field": "attributeName3",
     "type": "text"
    },
    {
     "column": "item_e_commerce_id",
     "field": "itemECommerceID",
     "type": "numeric"
    },
    {
     "column": "long_description",
     "field": "longDescription",
     "type": "text"
    },
    {
     "column": "short_description",
     "field": "shortDescription",
     "type": "text"
    },
    {
     "column": "weight",
     "field": "weight",
     "type": "numeric"
    },
    {
     "column": "width",
     "field": "width",
     "type": "numeric"
    },
    {
     "column": "height",
     "field": "height",
     "type": "numeric"
    },
    {
     "column": "length",
     "field": "length",
     "type": "numeric"
    },
    {
     "column": "list_on_store",
     "field": "listOnStore",
     "type": "boolean"
    },
    {
     "column": "amount_where_use_type_default",
     "field": "amount where useType='Default'",
     "type": "numeric"
    },
    {
     "column": "amount_where_use_type_msrp",
     "field": "amount where useType='MSRP'",
     "type": "numeric"
    }
   ]
  },
  "ls_item_shops": {
   "id": "ls_item_shops",
   "domain": "catalogue",
   "additivity": "last_value_over_time",
   "primaryKey": [
    "item_shop_id"
   ],
   "recordIdField": "itemShopID",
   "availability": "required",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "item_shop_id",
     "field": "itemShopID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "qoh",
     "field": "qoh",
     "type": "numeric"
    },
    {
     "column": "sellable",
     "field": "sellable",
     "type": "numeric"
    },
    {
     "column": "backorder",
     "field": "backorder",
     "type": "numeric"
    },
    {
     "column": "component_qoh",
     "field": "componentQoh",
     "type": "numeric"
    },
    {
     "column": "component_backorder",
     "field": "componentBackorder",
     "type": "numeric"
    },
    {
     "column": "reorder_point",
     "field": "reorderPoint",
     "type": "numeric"
    },
    {
     "column": "reorder_level",
     "field": "reorderLevel",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "description",
     "field": "description",
     "type": "text"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "item_type",
     "field": "itemType",
     "type": "text"
    },
    {
     "column": "avg_cost",
     "field": "avgCost",
     "type": "numeric"
    },
    {
     "column": "category_id",
     "field": "categoryID",
     "type": "numeric"
    },
    {
     "column": "manufacturer_id",
     "field": "manufacturerID",
     "type": "numeric"
    }
   ]
  },
  "ls_item_prices": {
   "id": "ls_item_prices",
   "domain": "catalogue",
   "additivity": "non_additive",
   "primaryKey": [
    "item_id",
    "use_type_id"
   ],
   "recordIdField": "itemID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "use_type_id",
     "field": "useTypeID",
     "type": "numeric"
    },
    {
     "column": "use_type",
     "field": "useType",
     "type": "text"
    },
    {
     "column": "amount",
     "field": "amount",
     "type": "numeric"
    },
    {
     "column": "description",
     "field": "description",
     "type": "text"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    }
   ]
  },
  "ls_item_components": {
   "id": "ls_item_components",
   "domain": "catalogue",
   "additivity": "non_additive",
   "primaryKey": [
    "item_component_id"
   ],
   "recordIdField": "itemComponentID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "item_component_id",
     "field": "itemComponentID",
     "type": "numeric"
    },
    {
     "column": "assembly_item_id",
     "field": "assemblyItemID",
     "type": "numeric"
    },
    {
     "column": "component_item_id",
     "field": "componentItemID",
     "type": "numeric"
    },
    {
     "column": "quantity",
     "field": "quantity",
     "type": "numeric"
    },
    {
     "column": "component_group",
     "field": "componentGroup",
     "type": "numeric"
    }
   ]
  },
  "ls_item_vendor_nums": {
   "id": "ls_item_vendor_nums",
   "domain": "catalogue",
   "additivity": "non_additive",
   "primaryKey": [
    "item_vendor_num_id"
   ],
   "recordIdField": "itemVendorNumID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "item_vendor_num_id",
     "field": "itemVendorNumID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "vendor_id",
     "field": "vendorID",
     "type": "numeric"
    },
    {
     "column": "value",
     "field": "value",
     "type": "text"
    },
    {
     "column": "cost",
     "field": "cost",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_item_matrices": {
   "id": "ls_item_matrices",
   "domain": "catalogue",
   "additivity": "non_additive",
   "primaryKey": [
    "item_matrix_id"
   ],
   "recordIdField": "itemMatrixID",
   "availability": "optional",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "item_matrix_id",
     "field": "itemMatrixID",
     "type": "numeric"
    },
    {
     "column": "description",
     "field": "description",
     "type": "text"
    },
    {
     "column": "item_type",
     "field": "itemType",
     "type": "text"
    },
    {
     "column": "serialized",
     "field": "serialized",
     "type": "boolean"
    },
    {
     "column": "tax",
     "field": "tax",
     "type": "boolean"
    },
    {
     "column": "default_cost",
     "field": "defaultCost",
     "type": "numeric"
    },
    {
     "column": "model_year",
     "field": "modelYear",
     "type": "numeric"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "category_id",
     "field": "categoryID",
     "type": "numeric"
    },
    {
     "column": "tax_class_id",
     "field": "taxClassID",
     "type": "numeric"
    },
    {
     "column": "department_id",
     "field": "departmentID",
     "type": "numeric"
    },
    {
     "column": "manufacturer_id",
     "field": "manufacturerID",
     "type": "numeric"
    },
    {
     "column": "season_id",
     "field": "seasonID",
     "type": "numeric"
    },
    {
     "column": "default_vendor_id",
     "field": "defaultVendorID",
     "type": "numeric"
    },
    {
     "column": "item_attribute_set_id",
     "field": "itemAttributeSetID",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "full_path_name",
     "field": "fullPathName",
     "type": "text"
    },
    {
     "column": "attribute_name1",
     "field": "attributeName1",
     "type": "text"
    },
    {
     "column": "attribute_name2",
     "field": "attributeName2",
     "type": "text"
    },
    {
     "column": "attribute_name3",
     "field": "attributeName3",
     "type": "text"
    },
    {
     "column": "tax_class",
     "field": "TaxClass",
     "type": "jsonb"
    },
    {
     "column": "department",
     "field": "Department",
     "type": "jsonb"
    },
    {
     "column": "custom_field_values",
     "field": "CustomFieldValues",
     "type": "jsonb"
    }
   ]
  },
  "ls_item_attribute_sets": {
   "id": "ls_item_attribute_sets",
   "domain": "catalogue",
   "additivity": "reference",
   "primaryKey": [
    "item_attribute_set_id"
   ],
   "recordIdField": "itemAttributeSetID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "item_attribute_set_id",
     "field": "itemAttributeSetID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "attribute_name1",
     "field": "attributeName1",
     "type": "text"
    },
    {
     "column": "attribute_name2",
     "field": "attributeName2",
     "type": "text"
    },
    {
     "column": "attribute_name3",
     "field": "attributeName3",
     "type": "text"
    }
   ]
  },
  "ls_item_fees": {
   "id": "ls_item_fees",
   "domain": "catalogue",
   "additivity": "reference",
   "primaryKey": [
    "item_fee_id"
   ],
   "recordIdField": "itemFeeID",
   "availability": "optional",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "item_fee_id",
     "field": "itemFeeID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "calculation_method",
     "field": "calculationMethod",
     "type": "text"
    },
    {
     "column": "fee_value",
     "field": "feeValue",
     "type": "numeric"
    },
    {
     "column": "taxable",
     "field": "taxable",
     "type": "boolean"
    },
    {
     "column": "discountable",
     "field": "discountable",
     "type": "boolean"
    },
    {
     "column": "non_refundable",
     "field": "nonRefundable",
     "type": "boolean"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "timestamp",
     "field": "timestamp",
     "type": "timestamptz"
    },
    {
     "column": "item_fee_categories",
     "field": "ItemFeeCategories",
     "type": "jsonb"
    }
   ]
  },
  "ls_images": {
   "id": "ls_images",
   "domain": "catalogue",
   "additivity": "reference",
   "primaryKey": [
    "image_id"
   ],
   "recordIdField": "imageID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "image_id",
     "field": "imageID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "item_matrix_id",
     "field": "itemMatrixID",
     "type": "numeric"
    },
    {
     "column": "description",
     "field": "description",
     "type": "text"
    },
    {
     "column": "filename",
     "field": "filename",
     "type": "text"
    },
    {
     "column": "ordering",
     "field": "ordering",
     "type": "numeric"
    },
    {
     "column": "public_id",
     "field": "publicID",
     "type": "text"
    }
   ]
  },
  "ls_serialized": {
   "id": "ls_serialized",
   "domain": "catalogue",
   "additivity": "non_additive",
   "primaryKey": [
    "serialized_id"
   ],
   "recordIdField": "serializedID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "serialized_id",
     "field": "serializedID",
     "type": "numeric"
    },
    {
     "column": "serial",
     "field": "serial",
     "type": "text"
    },
    {
     "column": "description",
     "field": "description",
     "type": "text"
    },
    {
     "column": "color_name",
     "field": "colorName",
     "type": "text"
    },
    {
     "column": "size_name",
     "field": "sizeName",
     "type": "text"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "sale_line_id",
     "field": "saleLineID",
     "type": "numeric"
    },
    {
     "column": "customer_id",
     "field": "customerID",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_tags": {
   "id": "ls_tags",
   "domain": "catalogue",
   "additivity": "reference",
   "primaryKey": [
    "tag_id"
   ],
   "recordIdField": "tagID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "tag_id",
     "field": "tagID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    }
   ]
  },
  "ls_tag_groups": {
   "id": "ls_tag_groups",
   "domain": "catalogue",
   "additivity": "reference",
   "primaryKey": [
    "name"
   ],
   "recordIdField": "name",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "name",
     "field": "name",
     "type": "text"
    }
   ]
  },
  "ls_seasons": {
   "id": "ls_seasons",
   "domain": "catalogue",
   "additivity": "reference",
   "primaryKey": [
    "season_id"
   ],
   "recordIdField": "seasonID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "season_id",
     "field": "seasonID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    }
   ]
  },
  "ls_manufacturers": {
   "id": "ls_manufacturers",
   "domain": "catalogue",
   "additivity": "reference",
   "primaryKey": [
    "manufacturer_id"
   ],
   "recordIdField": "manufacturerID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "manufacturer_id",
     "field": "manufacturerID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_categories": {
   "id": "ls_categories",
   "domain": "catalogue",
   "additivity": "reference",
   "primaryKey": [
    "category_id"
   ],
   "recordIdField": "categoryID",
   "availability": "required",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "category_id",
     "field": "categoryID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "full_path_name",
     "field": "fullPathName",
     "type": "text"
    },
    {
     "column": "parent_id",
     "field": "parentID",
     "type": "numeric"
    },
    {
     "column": "node_depth",
     "field": "nodeDepth",
     "type": "numeric"
    },
    {
     "column": "left_node",
     "field": "leftNode",
     "type": "numeric"
    },
    {
     "column": "right_node",
     "field": "rightNode",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_options": {
   "id": "ls_options",
   "domain": "catalogue",
   "additivity": "reference",
   "primaryKey": [
    "name"
   ],
   "recordIdField": "name",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "value",
     "field": "value",
     "type": "text"
    }
   ]
  },
  "ls_price_levels": {
   "id": "ls_price_levels",
   "domain": "catalogue",
   "additivity": "reference",
   "primaryKey": [
    "price_level_id"
   ],
   "recordIdField": "priceLevelID",
   "availability": "optional",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "price_level_id",
     "field": "priceLevelID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "can_be_archived",
     "field": "canBeArchived",
     "type": "boolean"
    },
    {
     "column": "type",
     "field": "type",
     "type": "text"
    },
    {
     "column": "calculation",
     "field": "Calculation",
     "type": "jsonb"
    }
   ]
  },
  "ls_catalog_vendor_items": {
   "id": "ls_catalog_vendor_items",
   "domain": "catalogue",
   "additivity": "non_additive",
   "primaryKey": [
    "catalog_vendor_item_id"
   ],
   "recordIdField": "catalogVendorItemID",
   "availability": "optional",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "catalog_vendor_item_id",
     "field": "catalogVendorItemID",
     "type": "numeric"
    },
    {
     "column": "catalog_vendor_id",
     "field": "catalogVendorID",
     "type": "numeric"
    },
    {
     "column": "vendor_number",
     "field": "vendorNumber",
     "type": "text"
    },
    {
     "column": "manufacturer_number",
     "field": "manufacturerNumber",
     "type": "text"
    },
    {
     "column": "description",
     "field": "description",
     "type": "text"
    },
    {
     "column": "category",
     "field": "category",
     "type": "text"
    },
    {
     "column": "brand",
     "field": "brand",
     "type": "text"
    },
    {
     "column": "model",
     "field": "model",
     "type": "text"
    },
    {
     "column": "year",
     "field": "year",
     "type": "text"
    },
    {
     "column": "upc",
     "field": "upc",
     "type": "text"
    },
    {
     "column": "ean",
     "field": "ean",
     "type": "text"
    },
    {
     "column": "ean2",
     "field": "ean2",
     "type": "text"
    },
    {
     "column": "color_name",
     "field": "colorName",
     "type": "text"
    },
    {
     "column": "size_name",
     "field": "sizeName",
     "type": "text"
    },
    {
     "column": "retail_unit",
     "field": "retailUnit",
     "type": "numeric"
    },
    {
     "column": "unit_of_measurement",
     "field": "unitOfMeasurement",
     "type": "text"
    },
    {
     "column": "cost",
     "field": "cost",
     "type": "numeric"
    },
    {
     "column": "cost_level2",
     "field": "costLevel2",
     "type": "numeric"
    },
    {
     "column": "cost_level3",
     "field": "costLevel3",
     "type": "numeric"
    },
    {
     "column": "cost_level4",
     "field": "costLevel4",
     "type": "numeric"
    },
    {
     "column": "msrp",
     "field": "msrp",
     "type": "numeric"
    },
    {
     "column": "break_qty",
     "field": "breakQty",
     "type": "numeric"
    },
    {
     "column": "break_price",
     "field": "breakPrice",
     "type": "numeric"
    },
    {
     "column": "break_qty2",
     "field": "breakQty2",
     "type": "numeric"
    },
    {
     "column": "break_price2",
     "field": "breakPrice2",
     "type": "numeric"
    },
    {
     "column": "break_qty3",
     "field": "breakQty3",
     "type": "numeric"
    },
    {
     "column": "break_price3",
     "field": "breakPrice3",
     "type": "numeric"
    },
    {
     "column": "status",
     "field": "status",
     "type": "text"
    },
    {
     "column": "replacement",
     "field": "replacement",
     "type": "text"
    },
    {
     "column": "replacement_description",
     "field": "replacementDescription",
     "type": "text"
    },
    {
     "column": "last_price_change",
     "field": "lastPriceChange",
     "type": "timestamptz"
    },
    {
     "column": "last_qoh",
     "field": "lastQoh",
     "type": "numeric"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "catalog_vendor",
     "field": "CatalogVendor",
     "type": "jsonb"
    }
   ]
  },
  "ls_inventory_logs": {
   "id": "ls_inventory_logs",
   "domain": "inventory",
   "additivity": "additive",
   "primaryKey": [
    "inventory_log_id"
   ],
   "recordIdField": "inventoryLogID",
   "availability": "required",
   "deletionStrategy": "immutable_append_only",
   "columns": [
    {
     "column": "inventory_log_id",
     "field": "inventoryLogID",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "qoh_change",
     "field": "qohChange",
     "type": "numeric"
    },
    {
     "column": "cost_change",
     "field": "costChange",
     "type": "numeric"
    },
    {
     "column": "automated",
     "field": "automated",
     "type": "boolean"
    },
    {
     "column": "reason",
     "field": "reason",
     "type": "text"
    },
    {
     "column": "caused_negative",
     "field": "causedNegative",
     "type": "boolean"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "order_id",
     "field": "orderID",
     "type": "numeric"
    },
    {
     "column": "transfer_id",
     "field": "transferID",
     "type": "numeric"
    },
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    },
    {
     "column": "inventory_count_id",
     "field": "inventoryCountID",
     "type": "numeric"
    },
    {
     "column": "customer_id",
     "field": "customerID",
     "type": "numeric"
    },
    {
     "column": "vendor_return_id",
     "field": "vendorReturnID",
     "type": "numeric"
    },
    {
     "column": "item_import_id",
     "field": "itemImportID",
     "type": "numeric"
    }
   ]
  },
  "ls_inventory_count_calcs": {
   "id": "ls_inventory_count_calcs",
   "domain": "inventory",
   "additivity": "last_value_over_time",
   "primaryKey": [
    "inventory_count_calc_id"
   ],
   "recordIdField": "inventoryCountCalcID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "inventory_count_calc_id",
     "field": "inventoryCountCalcID",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "calc_qoh",
     "field": "calcQoh",
     "type": "numeric"
    },
    {
     "column": "counted_qoh",
     "field": "countedQoh",
     "type": "numeric"
    },
    {
     "column": "inventory_count_id",
     "field": "inventoryCountID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    }
   ]
  },
  "ls_inventory_count_items": {
   "id": "ls_inventory_count_items",
   "domain": "inventory",
   "additivity": "additive",
   "primaryKey": [
    "inventory_count_item_id"
   ],
   "recordIdField": "inventoryCountItemID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "inventory_count_item_id",
     "field": "inventoryCountItemID",
     "type": "numeric"
    },
    {
     "column": "qty",
     "field": "qty",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "inventory_count_id",
     "field": "inventoryCountID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    }
   ]
  },
  "ls_inventory_count_reconciles": {
   "id": "ls_inventory_count_reconciles",
   "domain": "inventory",
   "additivity": "additive",
   "primaryKey": [
    "inventory_count_reconcile_id"
   ],
   "recordIdField": "inventoryCountReconcileID",
   "availability": "optional",
   "deletionStrategy": "immutable_append_only",
   "columns": [
    {
     "column": "inventory_count_reconcile_id",
     "field": "inventoryCountReconcileID",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "cost_change",
     "field": "costChange",
     "type": "numeric"
    },
    {
     "column": "qoh_change",
     "field": "qohChange",
     "type": "numeric"
    },
    {
     "column": "inventory_count_id",
     "field": "inventoryCountID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    }
   ]
  },
  "ls_transfers": {
   "id": "ls_transfers",
   "domain": "inventory",
   "additivity": "non_additive",
   "primaryKey": [
    "transfer_id"
   ],
   "recordIdField": "transferID",
   "availability": "optional",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "transfer_id",
     "field": "transferID",
     "type": "numeric"
    },
    {
     "column": "sent",
     "field": "sent",
     "type": "boolean"
    },
    {
     "column": "received",
     "field": "received",
     "type": "boolean"
    },
    {
     "column": "note",
     "field": "note",
     "type": "text"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "transfer_from_id",
     "field": "transferFromID",
     "type": "numeric"
    },
    {
     "column": "transfer_to_id",
     "field": "transferToID",
     "type": "numeric"
    },
    {
     "column": "order_id",
     "field": "orderID",
     "type": "numeric"
    },
    {
     "column": "sent_on",
     "field": "sentOn",
     "type": "timestamptz"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "need_by",
     "field": "needBy",
     "type": "timestamptz"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_transfer_items": {
   "id": "ls_transfer_items",
   "domain": "inventory",
   "additivity": "last_value_over_time",
   "primaryKey": [
    "transfer_item_id"
   ],
   "recordIdField": "transferItemID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "transfer_item_id",
     "field": "transferItemID",
     "type": "numeric"
    },
    {
     "column": "transfer_id",
     "field": "transferID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "to_send",
     "field": "toSend",
     "type": "numeric"
    },
    {
     "column": "to_receive",
     "field": "toReceive",
     "type": "numeric"
    },
    {
     "column": "sent",
     "field": "sent",
     "type": "numeric"
    },
    {
     "column": "received",
     "field": "received",
     "type": "numeric"
    },
    {
     "column": "sent_value",
     "field": "sentValue",
     "type": "numeric"
    },
    {
     "column": "received_value",
     "field": "receivedValue",
     "type": "numeric"
    },
    {
     "column": "comment",
     "field": "comment",
     "type": "text"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_special_orders": {
   "id": "ls_special_orders",
   "domain": "inventory",
   "additivity": "last_value_over_time",
   "primaryKey": [
    "special_order_id"
   ],
   "recordIdField": "specialOrderID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "special_order_id",
     "field": "specialOrderID",
     "type": "numeric"
    },
    {
     "column": "unit_quantity",
     "field": "unitQuantity",
     "type": "numeric"
    },
    {
     "column": "contacted",
     "field": "contacted",
     "type": "boolean"
    },
    {
     "column": "completed",
     "field": "completed",
     "type": "boolean"
    },
    {
     "column": "customer_id",
     "field": "customerID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "sale_line_id",
     "field": "saleLineID",
     "type": "numeric"
    },
    {
     "column": "order_line_id",
     "field": "orderLineID",
     "type": "numeric"
    },
    {
     "column": "transfer_item_id",
     "field": "transferItemID",
     "type": "numeric"
    }
   ]
  },
  "ls_transfer_from": {
   "id": "ls_transfer_from",
   "domain": "inventory",
   "additivity": "reference",
   "primaryKey": [
    "transfer_from_id"
   ],
   "recordIdField": "transferFromID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "transfer_from_id",
     "field": "transferFromID",
     "type": "numeric"
    }
   ]
  },
  "ls_transfer_to": {
   "id": "ls_transfer_to",
   "domain": "inventory",
   "additivity": "reference",
   "primaryKey": [
    "transfer_to_id"
   ],
   "recordIdField": "transferToID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "transfer_to_id",
     "field": "transferToID",
     "type": "numeric"
    }
   ]
  },
  "ls_purchase_orders": {
   "id": "ls_purchase_orders",
   "domain": "purchasing",
   "additivity": "additive",
   "primaryKey": [
    "order_id"
   ],
   "recordIdField": "orderID",
   "availability": "required",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "order_id",
     "field": "orderID",
     "type": "numeric"
    },
    {
     "column": "ordered_date",
     "field": "orderedDate",
     "type": "timestamptz"
    },
    {
     "column": "received_date",
     "field": "receivedDate",
     "type": "timestamptz"
    },
    {
     "column": "arrival_date",
     "field": "arrivalDate",
     "type": "timestamptz"
    },
    {
     "column": "ref_num",
     "field": "refNum",
     "type": "text"
    },
    {
     "column": "ship_instructions",
     "field": "shipInstructions",
     "type": "text"
    },
    {
     "column": "stock_instructions",
     "field": "stockInstructions",
     "type": "text"
    },
    {
     "column": "ship_cost",
     "field": "shipCost",
     "type": "numeric"
    },
    {
     "column": "ship_vendor_cost",
     "field": "shipVendorCost",
     "type": "numeric"
    },
    {
     "column": "other_cost",
     "field": "otherCost",
     "type": "numeric"
    },
    {
     "column": "other_vendor_cost",
     "field": "otherVendorCost",
     "type": "numeric"
    },
    {
     "column": "complete",
     "field": "complete",
     "type": "boolean"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "discount",
     "field": "discount",
     "type": "numeric"
    },
    {
     "column": "total_discount",
     "field": "totalDiscount",
     "type": "numeric"
    },
    {
     "column": "total_quantity",
     "field": "totalQuantity",
     "type": "numeric"
    },
    {
     "column": "vendor_id",
     "field": "vendorID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "note_id",
     "field": "noteID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "created_by_employee_id",
     "field": "createdByEmployeeID",
     "type": "numeric"
    },
    {
     "column": "custom_field_values",
     "field": "CustomFieldValues",
     "type": "jsonb"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "vendor_currency_rate",
     "field": "vendorCurrencyRate",
     "type": "numeric"
    },
    {
     "column": "vendor_currency_code",
     "field": "vendorCurrencyCode",
     "type": "text"
    },
    {
     "column": "shipping_cost_method",
     "field": "shippingCostMethod",
     "type": "text"
    },
    {
     "column": "has_shipments",
     "field": "hasShipments",
     "type": "boolean"
    },
    {
     "column": "discount_method",
     "field": "discountMethod",
     "type": "text"
    },
    {
     "column": "discount_money_value",
     "field": "discountMoneyValue",
     "type": "numeric"
    },
    {
     "column": "discount_money_vendor_value",
     "field": "discountMoneyVendorValue",
     "type": "numeric"
    },
    {
     "column": "discount_is_percent",
     "field": "discountIsPercent",
     "type": "boolean"
    },
    {
     "column": "discount_percent_value",
     "field": "discountPercentValue",
     "type": "numeric"
    },
    {
     "column": "costs_modified_after_shipment",
     "field": "costsModifiedAfterShipment",
     "type": "boolean"
    },
    {
     "column": "b2b_order_uid",
     "field": "b2bOrderUID",
     "type": "text"
    },
    {
     "column": "b2b_order_number",
     "field": "b2bOrderNumber",
     "type": "text"
    }
   ]
  },
  "ls_purchase_order_lines": {
   "id": "ls_purchase_order_lines",
   "domain": "purchasing",
   "additivity": "last_value_over_time",
   "primaryKey": [
    "order_line_id"
   ],
   "recordIdField": "orderLineID",
   "availability": "required",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "order_line_id",
     "field": "orderLineID",
     "type": "numeric"
    },
    {
     "column": "order_id",
     "field": "orderID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "quantity",
     "field": "quantity",
     "type": "numeric"
    },
    {
     "column": "price",
     "field": "price",
     "type": "numeric"
    },
    {
     "column": "original_price",
     "field": "originalPrice",
     "type": "numeric"
    },
    {
     "column": "vendor_cost",
     "field": "vendorCost",
     "type": "numeric"
    },
    {
     "column": "checked_in",
     "field": "checkedIn",
     "type": "numeric"
    },
    {
     "column": "num_received",
     "field": "numReceived",
     "type": "numeric"
    },
    {
     "column": "total",
     "field": "total",
     "type": "numeric"
    },
    {
     "column": "shipping_cost",
     "field": "shippingCost",
     "type": "numeric"
    },
    {
     "column": "shipping_vendor_cost",
     "field": "shippingVendorCost",
     "type": "numeric"
    },
    {
     "column": "discount_money_value",
     "field": "discountMoneyValue",
     "type": "numeric"
    },
    {
     "column": "discount_money_vendor_value",
     "field": "discountMoneyVendorValue",
     "type": "numeric"
    },
    {
     "column": "discount_percent_value",
     "field": "discountPercentValue",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "vendor_id",
     "field": "vendorID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "complete",
     "field": "complete",
     "type": "boolean"
    },
    {
     "column": "ordered_date",
     "field": "orderedDate",
     "type": "timestamptz"
    },
    {
     "column": "received_date",
     "field": "receivedDate",
     "type": "timestamptz"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "vendor_currency_code",
     "field": "vendorCurrencyCode",
     "type": "text"
    }
   ]
  },
  "ls_order_shipments": {
   "id": "ls_order_shipments",
   "domain": "purchasing",
   "additivity": "additive",
   "primaryKey": [
    "order_shipment_id"
   ],
   "recordIdField": "orderShipmentID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "order_shipment_id",
     "field": "orderShipmentID",
     "type": "numeric"
    },
    {
     "column": "order_id",
     "field": "orderID",
     "type": "numeric"
    },
    {
     "column": "sequence_number",
     "field": "sequenceNumber",
     "type": "numeric"
    },
    {
     "column": "total_qty_received",
     "field": "totalQtyReceived",
     "type": "numeric"
    },
    {
     "column": "total_vendor_cost",
     "field": "totalVendorCost",
     "type": "numeric"
    },
    {
     "column": "total_cost",
     "field": "totalCost",
     "type": "numeric"
    },
    {
     "column": "currency_code",
     "field": "currencyCode",
     "type": "text"
    },
    {
     "column": "vendor_currency_code",
     "field": "vendorCurrencyCode",
     "type": "text"
    },
    {
     "column": "vendor_currency_rate",
     "field": "vendorCurrencyRate",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "payment_due_date",
     "field": "paymentDueDate",
     "type": "date"
    },
    {
     "column": "shipment_packing_ref_num",
     "field": "shipmentPackingRefNum",
     "type": "text"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "reception_date",
     "field": "receptionDate",
     "type": "timestamptz"
    },
    {
     "column": "shipping_cost_method",
     "field": "shippingCostMethod",
     "type": "text"
    },
    {
     "column": "shipping_vendor_cost",
     "field": "shippingVendorCost",
     "type": "numeric"
    },
    {
     "column": "shipping_cost",
     "field": "shippingCost",
     "type": "numeric"
    },
    {
     "column": "shipping_cost_order_full_value",
     "field": "shippingCostOrderFullValue",
     "type": "numeric"
    },
    {
     "column": "shipping_cost_order_full_vendor_value",
     "field": "shippingCostOrderFullVendorValue",
     "type": "numeric"
    },
    {
     "column": "discount_method",
     "field": "discountMethod",
     "type": "text"
    },
    {
     "column": "discount_money_vendor_value",
     "field": "discountMoneyVendorValue",
     "type": "numeric"
    },
    {
     "column": "discount_money_value",
     "field": "discountMoneyValue",
     "type": "numeric"
    },
    {
     "column": "discount_percent_value",
     "field": "discountPercentValue",
     "type": "numeric"
    },
    {
     "column": "discount_order_full_money_value",
     "field": "discountOrderFullMoneyValue",
     "type": "numeric"
    },
    {
     "column": "discount_order_full_money_vendor_value",
     "field": "discountOrderFullMoneyVendorValue",
     "type": "numeric"
    },
    {
     "column": "cost",
     "field": "cost",
     "type": "numeric"
    },
    {
     "column": "vendor_cost",
     "field": "vendorCost",
     "type": "numeric"
    },
    {
     "column": "status",
     "field": "status",
     "type": "text"
    }
   ]
  },
  "ls_order_shipment_items": {
   "id": "ls_order_shipment_items",
   "domain": "purchasing",
   "additivity": "additive",
   "primaryKey": [
    "order_shipment_item_id"
   ],
   "recordIdField": "orderShipmentItemID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "order_shipment_item_id",
     "field": "orderShipmentItemID",
     "type": "numeric"
    },
    {
     "column": "order_shipment_id",
     "field": "orderShipmentID",
     "type": "numeric"
    },
    {
     "column": "qty_received",
     "field": "qtyReceived",
     "type": "numeric"
    },
    {
     "column": "vendor_cost",
     "field": "vendorCost",
     "type": "numeric"
    },
    {
     "column": "cost",
     "field": "cost",
     "type": "numeric"
    },
    {
     "column": "total_vendor_cost",
     "field": "totalVendorCost",
     "type": "numeric"
    },
    {
     "column": "total_cost",
     "field": "totalCost",
     "type": "numeric"
    },
    {
     "column": "shipping_cost",
     "field": "shippingCost",
     "type": "numeric"
    },
    {
     "column": "shipping_vendor_cost",
     "field": "shippingVendorCost",
     "type": "numeric"
    },
    {
     "column": "discount_money_value",
     "field": "discountMoneyValue",
     "type": "numeric"
    },
    {
     "column": "discount_money_vendor_value",
     "field": "discountMoneyVendorValue",
     "type": "numeric"
    },
    {
     "column": "discount_percent_value",
     "field": "discountPercentValue",
     "type": "numeric"
    },
    {
     "column": "currency_code",
     "field": "currencyCode",
     "type": "text"
    },
    {
     "column": "vendor_currency_code",
     "field": "vendorCurrencyCode",
     "type": "text"
    },
    {
     "column": "vendor_currency_rate",
     "field": "vendorCurrencyRate",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "item_vendor_id",
     "field": "itemVendorID",
     "type": "text"
    },
    {
     "column": "item_description",
     "field": "itemDescription",
     "type": "text"
    }
   ]
  },
  "ls_vendors": {
   "id": "ls_vendors",
   "domain": "purchasing",
   "additivity": "reference",
   "primaryKey": [
    "vendor_id"
   ],
   "recordIdField": "vendorID",
   "availability": "required",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "vendor_id",
     "field": "vendorID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "account_number",
     "field": "accountNumber",
     "type": "text"
    },
    {
     "column": "price_level",
     "field": "priceLevel",
     "type": "text"
    },
    {
     "column": "update_price",
     "field": "updatePrice",
     "type": "boolean"
    },
    {
     "column": "update_cost",
     "field": "updateCost",
     "type": "boolean"
    },
    {
     "column": "update_description",
     "field": "updateDescription",
     "type": "boolean"
    },
    {
     "column": "share_sell_through",
     "field": "shareSellThrough",
     "type": "boolean"
    },
    {
     "column": "b2b_seller_uid",
     "field": "b2bSellerUID",
     "type": "text"
    },
    {
     "column": "contact",
     "field": "Contact",
     "type": "jsonb"
    },
    {
     "column": "code",
     "field": "code",
     "type": "text"
    },
    {
     "column": "symbol",
     "field": "symbol",
     "type": "text"
    },
    {
     "column": "rate",
     "field": "rate",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_vendor_returns": {
   "id": "ls_vendor_returns",
   "domain": "purchasing",
   "additivity": "additive",
   "primaryKey": [
    "vendor_return_id"
   ],
   "recordIdField": "vendorReturnID",
   "availability": "optional",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "vendor_return_id",
     "field": "vendorReturnID",
     "type": "numeric"
    },
    {
     "column": "vendor_id",
     "field": "vendorID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "ref_num",
     "field": "refNum",
     "type": "text"
    },
    {
     "column": "status",
     "field": "status",
     "type": "text"
    },
    {
     "column": "sent_date",
     "field": "sentDate",
     "type": "timestamptz"
    },
    {
     "column": "ship_cost",
     "field": "shipCost",
     "type": "numeric"
    },
    {
     "column": "other_cost",
     "field": "otherCost",
     "type": "numeric"
    },
    {
     "column": "hide_vendor_details",
     "field": "hideVendorDetails",
     "type": "boolean"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "subtotal",
     "field": "subtotal",
     "type": "numeric"
    },
    {
     "column": "total",
     "field": "total",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_customers": {
   "id": "ls_customers",
   "domain": "customers",
   "additivity": "reference",
   "primaryKey": [
    "customer_id"
   ],
   "recordIdField": "customerID",
   "availability": "required",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "customer_id",
     "field": "customerID",
     "type": "numeric"
    },
    {
     "column": "first_name",
     "field": "firstName",
     "type": "text"
    },
    {
     "column": "last_name",
     "field": "lastName",
     "type": "text"
    },
    {
     "column": "dob",
     "field": "dob",
     "type": "timestamptz"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "title",
     "field": "title",
     "type": "text"
    },
    {
     "column": "company",
     "field": "company",
     "type": "text"
    },
    {
     "column": "company_registration_number",
     "field": "companyRegistrationNumber",
     "type": "text"
    },
    {
     "column": "vat_number",
     "field": "vatNumber",
     "type": "text"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "credit_account_id",
     "field": "creditAccountID",
     "type": "numeric"
    },
    {
     "column": "customer_type_id",
     "field": "customerTypeID",
     "type": "numeric"
    },
    {
     "column": "discount_id",
     "field": "discountID",
     "type": "numeric"
    },
    {
     "column": "tax_category_id",
     "field": "taxCategoryID",
     "type": "numeric"
    },
    {
     "column": "contact_id",
     "field": "contactID",
     "type": "numeric"
    },
    {
     "column": "contact",
     "field": "Contact",
     "type": "jsonb"
    },
    {
     "column": "custom_field_values",
     "field": "CustomFieldValues",
     "type": "jsonb"
    }
   ]
  },
  "ls_contacts": {
   "id": "ls_contacts",
   "domain": "customers",
   "additivity": "reference",
   "primaryKey": [
    "contact_id"
   ],
   "recordIdField": "contactID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "contact_id",
     "field": "contactID",
     "type": "numeric"
    },
    {
     "column": "contact",
     "field": "Contact",
     "type": "text"
    },
    {
     "column": "ship_to_id",
     "field": "shipToID",
     "type": "numeric"
    },
    {
     "column": "address1",
     "field": "address1",
     "type": "text"
    },
    {
     "column": "address2",
     "field": "address2",
     "type": "text"
    },
    {
     "column": "city",
     "field": "city",
     "type": "text"
    },
    {
     "column": "state",
     "field": "state",
     "type": "text"
    },
    {
     "column": "state_code",
     "field": "stateCode",
     "type": "text"
    },
    {
     "column": "zip",
     "field": "zip",
     "type": "text"
    },
    {
     "column": "country",
     "field": "country",
     "type": "text"
    },
    {
     "column": "country_code",
     "field": "countryCode",
     "type": "text"
    },
    {
     "column": "no_email",
     "field": "noEmail",
     "type": "boolean"
    },
    {
     "column": "no_mail",
     "field": "noMail",
     "type": "boolean"
    },
    {
     "column": "no_phone",
     "field": "noPhone",
     "type": "boolean"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_contact_emails": {
   "id": "ls_contact_emails",
   "domain": "customers",
   "additivity": "reference",
   "primaryKey": [
    "contact_id",
    "entry_index"
   ],
   "recordIdField": "contactID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "contact_id",
     "field": "contactID",
     "type": "numeric"
    },
    {
     "column": "contact_email",
     "field": "ContactEmail",
     "type": "numeric"
    },
    {
     "column": "address",
     "field": "address",
     "type": "text"
    },
    {
     "column": "use_type",
     "field": "useType",
     "type": "text"
    }
   ]
  },
  "ls_contact_phones": {
   "id": "ls_contact_phones",
   "domain": "customers",
   "additivity": "reference",
   "primaryKey": [
    "contact_id",
    "entry_index"
   ],
   "recordIdField": "contactID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "contact_id",
     "field": "contactID",
     "type": "numeric"
    },
    {
     "column": "contact_phone",
     "field": "ContactPhone",
     "type": "numeric"
    },
    {
     "column": "number",
     "field": "number",
     "type": "text"
    },
    {
     "column": "use_type",
     "field": "useType",
     "type": "text"
    }
   ]
  },
  "ls_contact_websites": {
   "id": "ls_contact_websites",
   "domain": "customers",
   "additivity": "reference",
   "primaryKey": [
    "contact_id",
    "entry_index"
   ],
   "recordIdField": "contactID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "contact_id",
     "field": "contactID",
     "type": "numeric"
    },
    {
     "column": "contact_website",
     "field": "ContactWebsite",
     "type": "numeric"
    },
    {
     "column": "url",
     "field": "url",
     "type": "text"
    }
   ]
  },
  "ls_customer_types": {
   "id": "ls_customer_types",
   "domain": "customers",
   "additivity": "reference",
   "primaryKey": [
    "customer_type_id"
   ],
   "recordIdField": "customerTypeID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "customer_type_id",
     "field": "customerTypeID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "tax_category_id",
     "field": "taxCategoryID",
     "type": "numeric"
    },
    {
     "column": "discount_id",
     "field": "discountID",
     "type": "numeric"
    }
   ]
  },
  "ls_credit_accounts": {
   "id": "ls_credit_accounts",
   "domain": "customers",
   "additivity": "last_value_over_time",
   "primaryKey": [
    "credit_account_id"
   ],
   "recordIdField": "creditAccountID",
   "availability": "optional",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "credit_account_id",
     "field": "creditAccountID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "code",
     "field": "code",
     "type": "text"
    },
    {
     "column": "description",
     "field": "description",
     "type": "text"
    },
    {
     "column": "gift_card",
     "field": "giftCard",
     "type": "boolean"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "customer_id",
     "field": "customerID",
     "type": "numeric"
    },
    {
     "column": "balance",
     "field": "balance",
     "type": "numeric"
    },
    {
     "column": "contact_id",
     "field": "contactID",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_ship_tos": {
   "id": "ls_ship_tos",
   "domain": "customers",
   "additivity": "non_additive",
   "primaryKey": [
    "ship_to_id"
   ],
   "recordIdField": "shipToID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "ship_to_id",
     "field": "shipToID",
     "type": "numeric"
    },
    {
     "column": "shipped",
     "field": "shipped",
     "type": "boolean"
    },
    {
     "column": "ship_note",
     "field": "shipNote",
     "type": "text"
    },
    {
     "column": "first_name",
     "field": "firstName",
     "type": "text"
    },
    {
     "column": "last_name",
     "field": "lastName",
     "type": "text"
    },
    {
     "column": "customer_id",
     "field": "customerID",
     "type": "numeric"
    },
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "contact",
     "field": "Contact",
     "type": "jsonb"
    },
    {
     "column": "contact_id",
     "field": "contactID",
     "type": "numeric"
    }
   ]
  },
  "ls_custom_fields": {
   "id": "ls_custom_fields",
   "domain": "customers",
   "additivity": "reference",
   "primaryKey": [
    "custom_field_id"
   ],
   "recordIdField": "customFieldID",
   "availability": "optional",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "custom_field_id",
     "field": "customFieldID",
     "type": "numeric"
    },
    {
     "column": "type",
     "field": "type",
     "type": "text"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "uom",
     "field": "uom",
     "type": "text"
    },
    {
     "column": "decimal_precision",
     "field": "decimalPrecision",
     "type": "numeric"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "default",
     "field": "default",
     "type": "jsonb"
    }
   ]
  },
  "ls_custom_field_choices": {
   "id": "ls_custom_field_choices",
   "domain": "customers",
   "additivity": "reference",
   "primaryKey": [
    "custom_field_choice_id"
   ],
   "recordIdField": "customFieldChoiceID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "custom_field_choice_id",
     "field": "customFieldChoiceID",
     "type": "numeric"
    },
    {
     "column": "custom_field_id",
     "field": "customFieldID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "value",
     "field": "value",
     "type": "text"
    },
    {
     "column": "can_be_deleted",
     "field": "canBeDeleted",
     "type": "boolean"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_customer_custom_field_values": {
   "id": "ls_customer_custom_field_values",
   "domain": "customers",
   "additivity": "reference",
   "primaryKey": [
    "custom_field_value_id"
   ],
   "recordIdField": "customFieldValueID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "custom_field_value_id",
     "field": "customFieldValueID",
     "type": "numeric"
    },
    {
     "column": "customer_id",
     "field": "customerID",
     "type": "numeric"
    },
    {
     "column": "custom_field_id",
     "field": "customFieldID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "type",
     "field": "type",
     "type": "text"
    },
    {
     "column": "value",
     "field": "value",
     "type": "jsonb"
    },
    {
     "column": "custom_field_choice_id",
     "field": "customFieldChoiceID",
     "type": "numeric"
    },
    {
     "column": "deleted",
     "field": "deleted",
     "type": "boolean"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_customer_notes": {
   "id": "ls_customer_notes",
   "domain": "customers",
   "additivity": "non_additive",
   "primaryKey": [
    "note_id"
   ],
   "recordIdField": "noteID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "note_id",
     "field": "noteID",
     "type": "numeric"
    },
    {
     "column": "customer_id",
     "field": "customerID",
     "type": "numeric"
    },
    {
     "column": "note",
     "field": "note",
     "type": "text"
    },
    {
     "column": "is_public",
     "field": "isPublic",
     "type": "boolean"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_workorders": {
   "id": "ls_workorders",
   "domain": "workshop",
   "additivity": "last_value_over_time",
   "primaryKey": [
    "workorder_id"
   ],
   "recordIdField": "workorderID",
   "availability": "optional",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "workorder_id",
     "field": "workorderID",
     "type": "numeric"
    },
    {
     "column": "time_in",
     "field": "timeIn",
     "type": "timestamptz"
    },
    {
     "column": "eta_out",
     "field": "etaOut",
     "type": "timestamptz"
    },
    {
     "column": "note",
     "field": "note",
     "type": "text"
    },
    {
     "column": "internal_note",
     "field": "internalNote",
     "type": "text"
    },
    {
     "column": "warranty",
     "field": "warranty",
     "type": "boolean"
    },
    {
     "column": "tax",
     "field": "tax",
     "type": "boolean"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "hook_in",
     "field": "hookIn",
     "type": "text"
    },
    {
     "column": "hook_out",
     "field": "hookOut",
     "type": "text"
    },
    {
     "column": "save_parts",
     "field": "saveParts",
     "type": "boolean"
    },
    {
     "column": "assign_employee_to_all",
     "field": "assignEmployeeToAll",
     "type": "boolean"
    },
    {
     "column": "customer_id",
     "field": "customerID",
     "type": "numeric"
    },
    {
     "column": "discount_id",
     "field": "discountID",
     "type": "numeric"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "serialized_id",
     "field": "serializedID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    },
    {
     "column": "sale_line_id",
     "field": "saleLineID",
     "type": "numeric"
    },
    {
     "column": "workorder_status_id",
     "field": "workorderStatusID",
     "type": "numeric"
    },
    {
     "column": "customer",
     "field": "Customer",
     "type": "text"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "system_value",
     "field": "systemValue",
     "type": "text"
    },
    {
     "column": "description",
     "field": "description",
     "type": "text"
    },
    {
     "column": "serial",
     "field": "serial",
     "type": "text"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_workorder_lines": {
   "id": "ls_workorder_lines",
   "domain": "workshop",
   "additivity": "additive",
   "primaryKey": [
    "workorder_line_id"
   ],
   "recordIdField": "workorderLineID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "workorder_line_id",
     "field": "workorderLineID",
     "type": "numeric"
    },
    {
     "column": "workorder_id",
     "field": "workorderID",
     "type": "numeric"
    },
    {
     "column": "note",
     "field": "note",
     "type": "text"
    },
    {
     "column": "hours",
     "field": "hours",
     "type": "numeric"
    },
    {
     "column": "minutes",
     "field": "minutes",
     "type": "numeric"
    },
    {
     "column": "unit_price_override",
     "field": "unitPriceOverride",
     "type": "numeric"
    },
    {
     "column": "unit_quantity",
     "field": "unitQuantity",
     "type": "numeric"
    },
    {
     "column": "unit_cost",
     "field": "unitCost",
     "type": "numeric"
    },
    {
     "column": "done",
     "field": "done",
     "type": "boolean"
    },
    {
     "column": "approved",
     "field": "approved",
     "type": "boolean"
    },
    {
     "column": "warranty",
     "field": "warranty",
     "type": "boolean"
    },
    {
     "column": "tax",
     "field": "tax",
     "type": "boolean"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "sale_line_id",
     "field": "saleLineID",
     "type": "numeric"
    },
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "discount_id",
     "field": "discountID",
     "type": "numeric"
    },
    {
     "column": "tax_class_id",
     "field": "taxClassID",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_workorder_items": {
   "id": "ls_workorder_items",
   "domain": "workshop",
   "additivity": "additive",
   "primaryKey": [
    "workorder_item_id"
   ],
   "recordIdField": "workorderItemID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "workorder_item_id",
     "field": "workorderItemID",
     "type": "numeric"
    },
    {
     "column": "workorder_id",
     "field": "workorderID",
     "type": "numeric"
    },
    {
     "column": "approved",
     "field": "approved",
     "type": "boolean"
    },
    {
     "column": "unit_price",
     "field": "unitPrice",
     "type": "numeric"
    },
    {
     "column": "unit_quantity",
     "field": "unitQuantity",
     "type": "numeric"
    },
    {
     "column": "warranty",
     "field": "warranty",
     "type": "boolean"
    },
    {
     "column": "tax",
     "field": "tax",
     "type": "boolean"
    },
    {
     "column": "is_special_order",
     "field": "isSpecialOrder",
     "type": "boolean"
    },
    {
     "column": "note",
     "field": "note",
     "type": "text"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "sale_line_id",
     "field": "saleLineID",
     "type": "numeric"
    },
    {
     "column": "sale_id",
     "field": "saleID",
     "type": "numeric"
    },
    {
     "column": "item_id",
     "field": "itemID",
     "type": "numeric"
    },
    {
     "column": "discount_id",
     "field": "discountID",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_workorder_statuses": {
   "id": "ls_workorder_statuses",
   "domain": "workshop",
   "additivity": "reference",
   "primaryKey": [
    "workorder_status_id"
   ],
   "recordIdField": "workorderStatusID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "workorder_status_id",
     "field": "workorderStatusID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "sort_order",
     "field": "sortOrder",
     "type": "numeric"
    },
    {
     "column": "html_color",
     "field": "htmlColor",
     "type": "text"
    },
    {
     "column": "system_value",
     "field": "systemValue",
     "type": "text"
    }
   ]
  },
  "ls_workorder_images": {
   "id": "ls_workorder_images",
   "domain": "workshop",
   "additivity": "non_additive",
   "primaryKey": [
    "workorder_image_id"
   ],
   "recordIdField": "workorderImageID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "workorder_image_id",
     "field": "workorderImageID",
     "type": "numeric"
    },
    {
     "column": "workorder_id",
     "field": "workorderID",
     "type": "numeric"
    },
    {
     "column": "description",
     "field": "description",
     "type": "text"
    },
    {
     "column": "filename",
     "field": "filename",
     "type": "text"
    },
    {
     "column": "ordering",
     "field": "ordering",
     "type": "numeric"
    },
    {
     "column": "public_id",
     "field": "publicID",
     "type": "text"
    },
    {
     "column": "base_image_url",
     "field": "baseImageURL",
     "type": "text"
    },
    {
     "column": "size",
     "field": "size",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_shops": {
   "id": "ls_shops",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "shop_id"
   ],
   "recordIdField": "shopID",
   "availability": "required",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "service_rate",
     "field": "serviceRate",
     "type": "numeric"
    },
    {
     "column": "time_zone",
     "field": "timeZone",
     "type": "text"
    },
    {
     "column": "tax_labor",
     "field": "taxLabor",
     "type": "boolean"
    },
    {
     "column": "label_title",
     "field": "labelTitle",
     "type": "text"
    },
    {
     "column": "label_msrp",
     "field": "labelMsrp",
     "type": "boolean"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "contact_id",
     "field": "contactID",
     "type": "numeric"
    },
    {
     "column": "tax_category_id",
     "field": "taxCategoryID",
     "type": "numeric"
    },
    {
     "column": "receipt_setup_id",
     "field": "receiptSetupID",
     "type": "numeric"
    },
    {
     "column": "cc_gateway_id",
     "field": "ccGatewayID",
     "type": "numeric"
    },
    {
     "column": "price_level_id",
     "field": "priceLevelID",
     "type": "numeric"
    },
    {
     "column": "contact",
     "field": "Contact",
     "type": "jsonb"
    }
   ]
  },
  "ls_registers": {
   "id": "ls_registers",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "register_id"
   ],
   "recordIdField": "registerID",
   "availability": "required",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "register_id",
     "field": "registerID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "open",
     "field": "open",
     "type": "boolean"
    },
    {
     "column": "open_time",
     "field": "openTime",
     "type": "timestamptz"
    },
    {
     "column": "tip_enabled",
     "field": "tipEnabled",
     "type": "boolean"
    },
    {
     "column": "open_employee_id",
     "field": "openEmployeeID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    }
   ]
  },
  "ls_employees": {
   "id": "ls_employees",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": "employeeID",
   "availability": "required",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "first_name",
     "field": "firstName",
     "type": "text"
    },
    {
     "column": "last_name",
     "field": "lastName",
     "type": "text"
    },
    {
     "column": "lock_out",
     "field": "lockOut",
     "type": "boolean"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "contact_id",
     "field": "contactID",
     "type": "numeric"
    },
    {
     "column": "clock_in_employee_hours_id",
     "field": "clockInEmployeeHoursID",
     "type": "numeric"
    },
    {
     "column": "employee_role_id",
     "field": "employeeRoleID",
     "type": "numeric"
    },
    {
     "column": "limit_to_shop_id",
     "field": "limitToShopID",
     "type": "numeric"
    },
    {
     "column": "last_shop_id",
     "field": "lastShopID",
     "type": "numeric"
    },
    {
     "column": "last_sale_id",
     "field": "lastSaleID",
     "type": "numeric"
    },
    {
     "column": "last_register_id",
     "field": "lastRegisterID",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    },
    {
     "column": "contact",
     "field": "Contact",
     "type": "jsonb"
    }
   ]
  },
  "ls_employee_roles": {
   "id": "ls_employee_roles",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "employee_role_id"
   ],
   "recordIdField": "employeeRoleID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "employee_role_id",
     "field": "employeeRoleID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    }
   ]
  },
  "ls_employee_role_rights": {
   "id": "ls_employee_role_rights",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "employee_role_id",
    "employee_right_id"
   ],
   "recordIdField": "employeeRoleID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "employee_role_id",
     "field": "employeeRoleID",
     "type": "numeric"
    },
    {
     "column": "employee_right_id",
     "field": "employeeRightID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    }
   ]
  },
  "ls_employee_rights": {
   "id": "ls_employee_rights",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "employee_id",
    "employee_right_id"
   ],
   "recordIdField": "employeeID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "employee_right_id",
     "field": "employeeRightID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    }
   ]
  },
  "ls_employee_hours": {
   "id": "ls_employee_hours",
   "domain": "org",
   "additivity": "additive",
   "primaryKey": [
    "employee_hours_id"
   ],
   "recordIdField": "employeeHoursID",
   "availability": "optional",
   "deletionStrategy": "immutable_append_only",
   "columns": [
    {
     "column": "employee_hours_id",
     "field": "employeeHoursID",
     "type": "numeric"
    },
    {
     "column": "check_in",
     "field": "checkIn",
     "type": "timestamptz"
    },
    {
     "column": "check_out",
     "field": "checkOut",
     "type": "timestamptz"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    }
   ]
  },
  "ls_session": {
   "id": "ls_session",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "system_api_key_id"
   ],
   "recordIdField": "systemAPIKeyID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "session_id",
     "field": "sessionID",
     "type": "numeric"
    },
    {
     "column": "session_cookie",
     "field": "sessionCookie",
     "type": "text"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "system_customer_id",
     "field": "systemCustomerID",
     "type": "numeric"
    },
    {
     "column": "system_user_id",
     "field": "systemUserID",
     "type": "numeric"
    },
    {
     "column": "system_api_client_id",
     "field": "systemAPIClientID",
     "type": "numeric"
    },
    {
     "column": "system_api_key_id",
     "field": "systemAPIKeyID",
     "type": "numeric"
    },
    {
     "column": "ecom_url",
     "field": "ecomUrl",
     "type": "text"
    },
    {
     "column": "shop_count",
     "field": "shopCount",
     "type": "numeric"
    }
   ]
  },
  "ls_account": {
   "id": "ls_account",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "account_id"
   ],
   "recordIdField": "accountID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "account_id",
     "field": "accountID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "link",
     "field": "link",
     "type": "text"
    },
    {
     "column": "system_customer_id",
     "field": "systemCustomerID",
     "type": "numeric"
    },
    {
     "column": "status",
     "field": "status",
     "type": "text"
    },
    {
     "column": "employee_count",
     "field": "employeeCount",
     "type": "numeric"
    },
    {
     "column": "employee_limit",
     "field": "employeeLimit",
     "type": "numeric"
    },
    {
     "column": "unique_subscription_identifier",
     "field": "uniqueSubscriptionIdentifier",
     "type": "text"
    },
    {
     "column": "code",
     "field": "code",
     "type": "text"
    },
    {
     "column": "symbol",
     "field": "symbol",
     "type": "text"
    }
   ]
  },
  "ls_account_purchasing_currencies": {
   "id": "ls_account_purchasing_currencies",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "account_id",
    "currency_code"
   ],
   "recordIdField": "accountID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "account_id",
     "field": "accountID",
     "type": "numeric"
    },
    {
     "column": "code",
     "field": "code",
     "type": "text"
    },
    {
     "column": "symbol",
     "field": "symbol",
     "type": "text"
    },
    {
     "column": "rate",
     "field": "rate",
     "type": "numeric"
    }
   ]
  },
  "ls_locales": {
   "id": "ls_locales",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "name"
   ],
   "recordIdField": "name",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "country",
     "field": "country",
     "type": "text"
    },
    {
     "column": "states",
     "field": "states",
     "type": "text"
    },
    {
     "column": "currency_symbol",
     "field": "currencySymbol",
     "type": "text"
    },
    {
     "column": "currency_code",
     "field": "currencyCode",
     "type": "text"
    },
    {
     "column": "currency_precision",
     "field": "currencyPrecision",
     "type": "numeric"
    },
    {
     "column": "cash_rounding_precision",
     "field": "cashRoundingPrecision",
     "type": "numeric"
    },
    {
     "column": "include_tax_on_labels",
     "field": "includeTaxOnLabels",
     "type": "boolean"
    },
    {
     "column": "language_tag",
     "field": "languageTag",
     "type": "text"
    },
    {
     "column": "date_format",
     "field": "dateFormat",
     "type": "text"
    },
    {
     "column": "datetime_format",
     "field": "datetimeFormat",
     "type": "text"
    },
    {
     "column": "tax_name1",
     "field": "taxName1",
     "type": "text"
    },
    {
     "column": "tax_name2",
     "field": "taxName2",
     "type": "text"
    },
    {
     "column": "currency_denominations",
     "field": "CurrencyDenominations",
     "type": "jsonb"
    }
   ]
  },
  "ls_industries": {
   "id": "ls_industries",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "industry_id"
   ],
   "recordIdField": "industryID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "industry_id",
     "field": "industryID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "enabled",
     "field": "enabled",
     "type": "boolean"
    }
   ]
  },
  "ls_cc_gateways": {
   "id": "ls_cc_gateways",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "cc_gateway_id"
   ],
   "recordIdField": "ccGatewayID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "cc_gateway_id",
     "field": "ccGatewayID",
     "type": "numeric"
    },
    {
     "column": "gateway",
     "field": "gateway",
     "type": "text"
    },
    {
     "column": "enabled",
     "field": "enabled",
     "type": "boolean"
    },
    {
     "column": "test_mode",
     "field": "testMode",
     "type": "boolean"
    },
    {
     "column": "allow_credits",
     "field": "allowCredits",
     "type": "boolean"
    },
    {
     "column": "market_type",
     "field": "marketType",
     "type": "text"
    },
    {
     "column": "device_type",
     "field": "deviceType",
     "type": "numeric"
    },
    {
     "column": "terminal_num",
     "field": "terminalNum",
     "type": "text"
    },
    {
     "column": "login",
     "field": "login",
     "type": "text"
    },
    {
     "column": "trans_key",
     "field": "transKey",
     "type": "text"
    },
    {
     "column": "account_num",
     "field": "accountNum",
     "type": "text"
    },
    {
     "column": "hash_value",
     "field": "hashValue",
     "type": "text"
    },
    {
     "column": "other_credentials1",
     "field": "otherCredentials1",
     "type": "text"
    },
    {
     "column": "other_credentials2",
     "field": "otherCredentials2",
     "type": "text"
    },
    {
     "column": "visa_payment_type_id",
     "field": "visaPaymentTypeID",
     "type": "numeric"
    },
    {
     "column": "master_payment_type_id",
     "field": "masterPaymentTypeID",
     "type": "numeric"
    },
    {
     "column": "discover_payment_type_id",
     "field": "discoverPaymentTypeID",
     "type": "numeric"
    },
    {
     "column": "american_payment_type_id",
     "field": "americanPaymentTypeID",
     "type": "numeric"
    },
    {
     "column": "debit_payment_type_id",
     "field": "debitPaymentTypeID",
     "type": "numeric"
    }
   ]
  },
  "ls_receipt_setups": {
   "id": "ls_receipt_setups",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "receipt_setup_id"
   ],
   "recordIdField": "receiptSetupID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "receipt_setup_id",
     "field": "receiptSetupID",
     "type": "numeric"
    },
    {
     "column": "header",
     "field": "header",
     "type": "text"
    },
    {
     "column": "general_msg",
     "field": "generalMsg",
     "type": "text"
    },
    {
     "column": "workorder_agree",
     "field": "workorderAgree",
     "type": "text"
    },
    {
     "column": "creditcard_agree",
     "field": "creditcardAgree",
     "type": "text"
    },
    {
     "column": "logo",
     "field": "logo",
     "type": "text"
    },
    {
     "column": "logo_height",
     "field": "logoHeight",
     "type": "numeric"
    },
    {
     "column": "logo_width",
     "field": "logoWidth",
     "type": "numeric"
    }
   ]
  },
  "ls_currency_rates": {
   "id": "ls_currency_rates",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "currency_rate_id"
   ],
   "recordIdField": "currencyRateID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "currency_rate_id",
     "field": "currencyRateID",
     "type": "numeric"
    },
    {
     "column": "currency_code",
     "field": "currencyCode",
     "type": "text"
    },
    {
     "column": "rate",
     "field": "rate",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_currency_denominations": {
   "id": "ls_currency_denominations",
   "domain": "org",
   "additivity": "reference",
   "primaryKey": [
    "locale_id",
    "value"
   ],
   "recordIdField": "localeID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "locale_id",
     "field": "localeID",
     "type": "numeric"
    },
    {
     "column": "currency_denominations",
     "field": "CurrencyDenominations",
     "type": "numeric"
    }
   ]
  },
  "ls_register_counts": {
   "id": "ls_register_counts",
   "domain": "registers",
   "additivity": "non_additive",
   "primaryKey": [
    "register_count_id"
   ],
   "recordIdField": "registerCountID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "register_count_id",
     "field": "registerCountID",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "open_time",
     "field": "openTime",
     "type": "timestamptz"
    },
    {
     "column": "notes",
     "field": "notes",
     "type": "text"
    },
    {
     "column": "register_id",
     "field": "registerID",
     "type": "numeric"
    },
    {
     "column": "open_employee_id",
     "field": "openEmployeeID",
     "type": "numeric"
    },
    {
     "column": "close_employee_id",
     "field": "closeEmployeeID",
     "type": "numeric"
    }
   ]
  },
  "ls_register_count_amounts": {
   "id": "ls_register_count_amounts",
   "domain": "registers",
   "additivity": "last_value_over_time",
   "primaryKey": [
    "register_count_amount_id"
   ],
   "recordIdField": "registerCountAmountID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "register_count_amount_id",
     "field": "registerCountAmountID",
     "type": "numeric"
    },
    {
     "column": "register_count_id",
     "field": "registerCountID",
     "type": "numeric"
    },
    {
     "column": "payment_type_id",
     "field": "paymentTypeID",
     "type": "numeric"
    },
    {
     "column": "calculated",
     "field": "calculated",
     "type": "numeric"
    },
    {
     "column": "actual",
     "field": "actual",
     "type": "numeric"
    }
   ]
  },
  "ls_register_withdraws": {
   "id": "ls_register_withdraws",
   "domain": "registers",
   "additivity": "additive",
   "primaryKey": [
    "register_withdraw_id"
   ],
   "recordIdField": "registerWithdrawID",
   "availability": "optional",
   "deletionStrategy": "immutable_append_only",
   "columns": [
    {
     "column": "register_withdraw_id",
     "field": "registerWithdrawID",
     "type": "numeric"
    },
    {
     "column": "amount",
     "field": "amount",
     "type": "numeric"
    },
    {
     "column": "create_time",
     "field": "createTime",
     "type": "timestamptz"
    },
    {
     "column": "notes",
     "field": "notes",
     "type": "text"
    },
    {
     "column": "employee_id",
     "field": "employeeID",
     "type": "numeric"
    },
    {
     "column": "payment_type_id",
     "field": "paymentTypeID",
     "type": "numeric"
    },
    {
     "column": "register_id",
     "field": "registerID",
     "type": "numeric"
    }
   ]
  },
  "ls_register_calculated": {
   "id": "ls_register_calculated",
   "domain": "registers",
   "additivity": "last_value_over_time",
   "primaryKey": [
    "register_id",
    "payment_type_id"
   ],
   "recordIdField": null,
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "register_calculated_path_parameter_register_id",
     "field": "Register-calculated path parameter {registerID}",
     "type": "numeric"
    },
    {
     "column": "payment_type_id",
     "field": "paymentTypeID",
     "type": "numeric"
    },
    {
     "column": "payment",
     "field": "payment",
     "type": "numeric"
    },
    {
     "column": "add",
     "field": "add",
     "type": "numeric"
    },
    {
     "column": "withdraw",
     "field": "withdraw",
     "type": "numeric"
    }
   ]
  },
  "ls_tax_categories": {
   "id": "ls_tax_categories",
   "domain": "taxreports",
   "additivity": "reference",
   "primaryKey": [
    "tax_category_id"
   ],
   "recordIdField": "taxCategoryID",
   "availability": "required",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "tax_category_id",
     "field": "taxCategoryID",
     "type": "numeric"
    },
    {
     "column": "is_tax_inclusive",
     "field": "isTaxInclusive",
     "type": "boolean"
    },
    {
     "column": "tax1_name",
     "field": "tax1Name",
     "type": "text"
    },
    {
     "column": "tax2_name",
     "field": "tax2Name",
     "type": "text"
    },
    {
     "column": "tax1_rate",
     "field": "tax1Rate",
     "type": "numeric"
    },
    {
     "column": "tax2_rate",
     "field": "tax2Rate",
     "type": "numeric"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_tax_category_classes": {
   "id": "ls_tax_category_classes",
   "domain": "taxreports",
   "additivity": "reference",
   "primaryKey": [
    "tax_category_id",
    "tax_class_id"
   ],
   "recordIdField": "taxCategoryID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "tax_category_id",
     "field": "taxCategoryID",
     "type": "numeric"
    },
    {
     "column": "tax_category_class_id",
     "field": "taxCategoryClassID",
     "type": "numeric"
    },
    {
     "column": "tax_class_id",
     "field": "taxClassID",
     "type": "numeric"
    },
    {
     "column": "tax1_rate",
     "field": "tax1Rate",
     "type": "numeric"
    },
    {
     "column": "tax2_rate",
     "field": "tax2Rate",
     "type": "numeric"
    }
   ]
  },
  "ls_tax_classes": {
   "id": "ls_tax_classes",
   "domain": "taxreports",
   "additivity": "reference",
   "primaryKey": [
    "tax_class_id"
   ],
   "recordIdField": "taxClassID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "tax_class_id",
     "field": "taxClassID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "time_stamp",
     "field": "timeStamp",
     "type": "timestamptz"
    }
   ]
  },
  "ls_payment_types": {
   "id": "ls_payment_types",
   "domain": "taxreports",
   "additivity": "reference",
   "primaryKey": [
    "payment_type_id"
   ],
   "recordIdField": "paymentTypeID",
   "availability": "required",
   "deletionStrategy": "soft_delete",
   "columns": [
    {
     "column": "payment_type_id",
     "field": "paymentTypeID",
     "type": "numeric"
    },
    {
     "column": "name",
     "field": "name",
     "type": "text"
    },
    {
     "column": "require_customer",
     "field": "requireCustomer",
     "type": "boolean"
    },
    {
     "column": "archived",
     "field": "archived",
     "type": "boolean"
    },
    {
     "column": "internal_reserved",
     "field": "internalReserved",
     "type": "boolean"
    },
    {
     "column": "type",
     "field": "type",
     "type": "text"
    },
    {
     "column": "refund_as_payment_type_id",
     "field": "refundAsPaymentTypeID",
     "type": "numeric"
    }
   ]
  },
  "ls_report_payments_by_day": {
   "id": "ls_report_payments_by_day",
   "domain": "taxreports",
   "additivity": "additive",
   "primaryKey": [
    "day",
    "shop_id",
    "payment_type_id",
    "is_layaway"
   ],
   "recordIdField": "date",
   "availability": "optional",
   "deletionStrategy": "immutable_append_only",
   "columns": [
    {
     "column": "date",
     "field": "date",
     "type": "date"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "layaway",
     "field": "layaway",
     "type": "boolean"
    },
    {
     "column": "amount",
     "field": "amount",
     "type": "numeric"
    },
    {
     "column": "payment_type_name",
     "field": "paymentTypeName",
     "type": "text"
    },
    {
     "column": "payment_type_id",
     "field": "paymentTypeID",
     "type": "numeric"
    }
   ]
  },
  "ls_report_taxes_by_day": {
   "id": "ls_report_taxes_by_day",
   "domain": "taxreports",
   "additivity": "additive",
   "primaryKey": [
    "day",
    "shop_id",
    "tax_category_id"
   ],
   "recordIdField": "date",
   "availability": "optional",
   "deletionStrategy": "immutable_append_only",
   "columns": [
    {
     "column": "date",
     "field": "date",
     "type": "date"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "tax_category_id",
     "field": "taxCategoryID",
     "type": "numeric"
    },
    {
     "column": "tax_category_name",
     "field": "taxCategoryName",
     "type": "text"
    },
    {
     "column": "tax",
     "field": "tax",
     "type": "numeric"
    }
   ]
  },
  "ls_report_discounts_by_day": {
   "id": "ls_report_discounts_by_day",
   "domain": "taxreports",
   "additivity": "additive",
   "primaryKey": [
    "day",
    "shop_id"
   ],
   "recordIdField": "date",
   "availability": "optional",
   "deletionStrategy": "immutable_append_only",
   "columns": [
    {
     "column": "date",
     "field": "date",
     "type": "date"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "discount",
     "field": "discount",
     "type": "numeric"
    }
   ]
  },
  "ls_report_tax_class_sales_by_day": {
   "id": "ls_report_tax_class_sales_by_day",
   "domain": "taxreports",
   "additivity": "additive",
   "primaryKey": [
    "day",
    "shop_id",
    "tax_class_id"
   ],
   "recordIdField": "date",
   "availability": "optional",
   "deletionStrategy": "immutable_append_only",
   "columns": [
    {
     "column": "date",
     "field": "date",
     "type": "date"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "tax_class_id",
     "field": "taxClassID",
     "type": "numeric"
    },
    {
     "column": "tax_class_name",
     "field": "taxClassName",
     "type": "text"
    },
    {
     "column": "subtotal",
     "field": "subtotal",
     "type": "numeric"
    },
    {
     "column": "fifo_cost",
     "field": "fifoCost",
     "type": "numeric"
    },
    {
     "column": "avg_cost",
     "field": "avgCost",
     "type": "numeric"
    }
   ]
  },
  "ls_report_orders_by_tax_class": {
   "id": "ls_report_orders_by_tax_class",
   "domain": "taxreports",
   "additivity": "non_additive",
   "primaryKey": [
    "order_id",
    "tax_class_id"
   ],
   "recordIdField": "taxClassID",
   "availability": "optional",
   "deletionStrategy": "authoritative_identity_scan",
   "columns": [
    {
     "column": "date",
     "field": "date",
     "type": "date"
    },
    {
     "column": "shop_id",
     "field": "shopID",
     "type": "numeric"
    },
    {
     "column": "vendor_id",
     "field": "vendorID",
     "type": "numeric"
    },
    {
     "column": "vendor_name",
     "field": "vendorName",
     "type": "text"
    },
    {
     "column": "tax_class_id",
     "field": "taxClassID",
     "type": "numeric"
    },
    {
     "column": "tax_class_name",
     "field": "taxClassName",
     "type": "text"
    },
    {
     "column": "cost",
     "field": "cost",
     "type": "numeric"
    },
    {
     "column": "order_id",
     "field": "orderID",
     "type": "numeric"
    },
    {
     "column": "total_ship_cost",
     "field": "totalShipCost",
     "type": "numeric"
    },
    {
     "column": "total_other_cost",
     "field": "totalOtherCost",
     "type": "numeric"
    }
   ]
  }
 },
 "groups": [
  {
   "resource": "Account",
   "path": "Account.json",
   "idField": "accountID",
   "keysetCapable": false,
   "leader": "ls_account",
   "members": [
    {
     "table": "ls_account",
     "resource": "Account",
     "projectFrom": null,
     "recordIdField": "accountID",
     "parentLeaves": []
    },
    {
     "table": "ls_account_purchasing_currencies",
     "resource": "Account",
     "projectFrom": "purchasingCurrencies.purchasingCurrency",
     "recordIdField": "accountID",
     "parentLeaves": []
    }
   ],
   "singleton": true,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "CatalogVendorItem",
   "path": "CatalogVendorItem.json",
   "idField": "catalogVendorItemID",
   "keysetCapable": false,
   "leader": "ls_catalog_vendor_items",
   "members": [
    {
     "table": "ls_catalog_vendor_items",
     "resource": "CatalogVendorItem",
     "projectFrom": null,
     "recordIdField": "catalogVendorItemID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "CatalogVendor"
   ],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Category",
   "path": "Category.json",
   "idField": "categoryID",
   "keysetCapable": false,
   "leader": "ls_categories",
   "members": [
    {
     "table": "ls_categories",
     "resource": "Category",
     "projectFrom": null,
     "recordIdField": "categoryID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "required"
  },
  {
   "resource": "CCCharge",
   "path": "CCCharge.json",
   "idField": "ccChargeID",
   "keysetCapable": true,
   "leader": "ls_cc_charges",
   "members": [
    {
     "table": "ls_cc_charges",
     "resource": "CCCharge",
     "projectFrom": null,
     "recordIdField": "ccChargeID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "CreditAccount",
   "path": "CreditAccount.json",
   "idField": "creditAccountID",
   "keysetCapable": true,
   "leader": "ls_credit_accounts",
   "members": [
    {
     "table": "ls_credit_accounts",
     "resource": "CreditAccount",
     "projectFrom": null,
     "recordIdField": "creditAccountID",
     "parentLeaves": []
    },
    {
     "table": "ls_contacts",
     "resource": "Contact",
     "projectFrom": "Contact",
     "recordIdField": "contactID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "Contact"
   ],
   "extraParamSets": [
    {
     "giftCard": "true"
    }
   ],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "CurrencyRate",
   "path": "CurrencyRate.json",
   "idField": "currencyRateID",
   "keysetCapable": false,
   "leader": "ls_currency_rates",
   "members": [
    {
     "table": "ls_currency_rates",
     "resource": "CurrencyRate",
     "projectFrom": null,
     "recordIdField": "currencyRateID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Customer",
   "path": "Customer.json",
   "idField": "customerID",
   "keysetCapable": true,
   "leader": "ls_customers",
   "members": [
    {
     "table": "ls_customers",
     "resource": "Customer",
     "projectFrom": null,
     "recordIdField": "customerID",
     "parentLeaves": []
    },
    {
     "table": "ls_contacts",
     "resource": "Contact",
     "projectFrom": "Contact",
     "recordIdField": "contactID",
     "parentLeaves": []
    },
    {
     "table": "ls_contact_emails",
     "resource": "Contact",
     "projectFrom": "Contact.Emails.ContactEmail",
     "recordIdField": "contactID",
     "parentLeaves": []
    },
    {
     "table": "ls_contact_phones",
     "resource": "Contact",
     "projectFrom": "Contact.Phones.ContactPhone",
     "recordIdField": "contactID",
     "parentLeaves": []
    },
    {
     "table": "ls_contact_websites",
     "resource": "Contact",
     "projectFrom": "Contact.Websites.ContactWebsite",
     "recordIdField": "contactID",
     "parentLeaves": []
    },
    {
     "table": "ls_customer_custom_field_values",
     "resource": "CustomFieldValue",
     "projectFrom": "CustomFieldValues.CustomFieldValue",
     "recordIdField": "customFieldValueID",
     "parentLeaves": [
      "customerID"
     ]
    },
    {
     "table": "ls_customer_notes",
     "resource": "Note",
     "projectFrom": "Note",
     "recordIdField": "noteID",
     "parentLeaves": [
      "customerID"
     ]
    }
   ],
   "singleton": false,
   "relations": [
    "Contact",
    "CustomFieldValues.value",
    "Note"
   ],
   "extraParamSets": [
    {
     "archived": "only"
    }
   ],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [],
   "availability": "required"
  },
  {
   "resource": "CustomerType",
   "path": "CustomerType.json",
   "idField": "customerTypeID",
   "keysetCapable": true,
   "leader": "ls_customer_types",
   "members": [
    {
     "table": "ls_customer_types",
     "resource": "CustomerType",
     "projectFrom": null,
     "recordIdField": "customerTypeID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "CustomField",
   "path": "CustomField.json",
   "idField": "customFieldID",
   "keysetCapable": false,
   "leader": "ls_custom_fields",
   "members": [
    {
     "table": "ls_custom_fields",
     "resource": "CustomField",
     "projectFrom": null,
     "recordIdField": "customFieldID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Discount",
   "path": "Discount.json",
   "idField": "discountID",
   "keysetCapable": false,
   "leader": "ls_discounts",
   "members": [
    {
     "table": "ls_discounts",
     "resource": "Discount",
     "projectFrom": null,
     "recordIdField": "discountID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [
    {
     "archived": "only"
    }
   ],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "DiscountsByDay",
   "path": "DiscountsByDay.json",
   "idField": "date",
   "keysetCapable": true,
   "leader": "ls_report_discounts_by_day",
   "members": [
    {
     "table": "ls_report_discounts_by_day",
     "resource": "DiscountsByDay",
     "projectFrom": null,
     "recordIdField": "date",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "date_range",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Employee",
   "path": "Employee.json",
   "idField": "employeeID",
   "keysetCapable": false,
   "leader": "ls_employees",
   "members": [
    {
     "table": "ls_employees",
     "resource": "Employee",
     "projectFrom": null,
     "recordIdField": "employeeID",
     "parentLeaves": []
    },
    {
     "table": "ls_employee_roles",
     "resource": "EmployeeRole",
     "projectFrom": "EmployeeRole",
     "recordIdField": "employeeRoleID",
     "parentLeaves": []
    },
    {
     "table": "ls_employee_role_rights",
     "resource": "EmployeeRole",
     "projectFrom": "EmployeeRole.EmployeeRights.EmployeeRight",
     "recordIdField": "employeeRoleID",
     "parentLeaves": []
    },
    {
     "table": "ls_employee_rights",
     "resource": "Employee",
     "projectFrom": "EmployeeRights.EmployeeRight",
     "recordIdField": "employeeID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "Contact",
    "EmployeeRights",
    "EmployeeRole.EmployeeRights"
   ],
   "extraParamSets": [
    {
     "archived": "only"
    }
   ],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [],
   "availability": "required"
  },
  {
   "resource": "EmployeeHours",
   "path": "EmployeeHours.json",
   "idField": "employeeHoursID",
   "keysetCapable": false,
   "leader": "ls_employee_hours",
   "members": [
    {
     "table": "ls_employee_hours",
     "resource": "EmployeeHours",
     "projectFrom": null,
     "recordIdField": "employeeHoursID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Image",
   "path": "Image.json",
   "idField": "imageID",
   "keysetCapable": false,
   "leader": "ls_images",
   "members": [
    {
     "table": "ls_images",
     "resource": "Image",
     "projectFrom": null,
     "recordIdField": "imageID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Industry",
   "path": "Industry.json",
   "idField": "industryID",
   "keysetCapable": false,
   "leader": "ls_industries",
   "members": [
    {
     "table": "ls_industries",
     "resource": "Industry",
     "projectFrom": null,
     "recordIdField": "industryID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "InventoryCountCalc",
   "path": "InventoryCountCalc.json",
   "idField": "inventoryCountCalcID",
   "keysetCapable": true,
   "leader": "ls_inventory_count_calcs",
   "members": [
    {
     "table": "ls_inventory_count_calcs",
     "resource": "InventoryCountCalc",
     "projectFrom": null,
     "recordIdField": "inventoryCountCalcID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "InventoryCountItem",
   "path": "InventoryCountItem.json",
   "idField": "inventoryCountItemID",
   "keysetCapable": true,
   "leader": "ls_inventory_count_items",
   "members": [
    {
     "table": "ls_inventory_count_items",
     "resource": "InventoryCountItem",
     "projectFrom": null,
     "recordIdField": "inventoryCountItemID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "InventoryCountReconcile",
   "path": "InventoryCountReconcile.json",
   "idField": "inventoryCountReconcileID",
   "keysetCapable": true,
   "leader": "ls_inventory_count_reconciles",
   "members": [
    {
     "table": "ls_inventory_count_reconciles",
     "resource": "InventoryCountReconcile",
     "projectFrom": null,
     "recordIdField": "inventoryCountReconcileID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "id_keyset",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "InventoryLog",
   "path": "InventoryLog.json",
   "idField": "inventoryLogID",
   "keysetCapable": true,
   "leader": "ls_inventory_logs",
   "members": [
    {
     "table": "ls_inventory_logs",
     "resource": "InventoryLog",
     "projectFrom": null,
     "recordIdField": "inventoryLogID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "id_keyset",
   "requiredRoots": [],
   "availability": "required"
  },
  {
   "resource": "Item",
   "path": "Item.json",
   "idField": "itemID",
   "keysetCapable": true,
   "leader": "ls_items",
   "members": [
    {
     "table": "ls_items",
     "resource": "Item",
     "projectFrom": null,
     "recordIdField": "itemID",
     "parentLeaves": []
    },
    {
     "table": "ls_item_shops",
     "resource": "ItemShop",
     "projectFrom": "ItemShops.ItemShop",
     "recordIdField": "itemShopID",
     "parentLeaves": [
      "description",
      "archived",
      "itemType",
      "avgCost",
      "categoryID",
      "manufacturerID"
     ]
    },
    {
     "table": "ls_item_prices",
     "resource": "Item",
     "projectFrom": "ItemPrices.ItemPrice",
     "recordIdField": "itemID",
     "parentLeaves": []
    },
    {
     "table": "ls_item_components",
     "resource": "ItemComponent",
     "projectFrom": "ItemComponents.ItemComponent",
     "recordIdField": "itemComponentID",
     "parentLeaves": []
    },
    {
     "table": "ls_item_vendor_nums",
     "resource": "ItemVendorNum",
     "projectFrom": "ItemVendorNums.ItemVendorNum",
     "recordIdField": "itemVendorNumID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "CustomFieldValues.value",
    "ItemComponents",
    "ItemPrices",
    "ItemShops",
    "ItemVendorNums",
    "Note",
    "TaxClass"
   ],
   "extraParamSets": [
    {
     "archived": "only"
    }
   ],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [
    "ItemShops"
   ],
   "availability": "required"
  },
  {
   "resource": "ItemAttributeSet",
   "path": "ItemAttributeSet.json",
   "idField": "itemAttributeSetID",
   "keysetCapable": false,
   "leader": "ls_item_attribute_sets",
   "members": [
    {
     "table": "ls_item_attribute_sets",
     "resource": "ItemAttributeSet",
     "projectFrom": null,
     "recordIdField": "itemAttributeSetID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "ItemFee",
   "path": "ItemFee.json",
   "idField": "itemFeeID",
   "keysetCapable": false,
   "leader": "ls_item_fees",
   "members": [
    {
     "table": "ls_item_fees",
     "resource": "ItemFee",
     "projectFrom": null,
     "recordIdField": "itemFeeID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "ItemFeeCategories"
   ],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "ItemMatrix",
   "path": "ItemMatrix.json",
   "idField": "itemMatrixID",
   "keysetCapable": true,
   "leader": "ls_item_matrices",
   "members": [
    {
     "table": "ls_item_matrices",
     "resource": "ItemMatrix",
     "projectFrom": null,
     "recordIdField": "itemMatrixID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "Department",
    "TaxClass"
   ],
   "extraParamSets": [
    {
     "archived": "only"
    }
   ],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Locale",
   "path": "Locale.json",
   "idField": "name",
   "keysetCapable": false,
   "leader": "ls_locales",
   "members": [
    {
     "table": "ls_locales",
     "resource": "Locale",
     "projectFrom": null,
     "recordIdField": "name",
     "parentLeaves": []
    },
    {
     "table": "ls_currency_denominations",
     "resource": "Locale",
     "projectFrom": "CurrencyDenominations.CurrencyDenomination",
     "recordIdField": "localeID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "CurrencyDenominations"
   ],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Manufacturer",
   "path": "Manufacturer.json",
   "idField": "manufacturerID",
   "keysetCapable": false,
   "leader": "ls_manufacturers",
   "members": [
    {
     "table": "ls_manufacturers",
     "resource": "Manufacturer",
     "projectFrom": null,
     "recordIdField": "manufacturerID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Option",
   "path": "Option.json",
   "idField": "name",
   "keysetCapable": false,
   "leader": "ls_options",
   "members": [
    {
     "table": "ls_options",
     "resource": "Option",
     "projectFrom": null,
     "recordIdField": "name",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Order",
   "path": "Order.json",
   "idField": "orderID",
   "keysetCapable": true,
   "leader": "ls_purchase_orders",
   "members": [
    {
     "table": "ls_purchase_orders",
     "resource": "Order",
     "projectFrom": null,
     "recordIdField": "orderID",
     "parentLeaves": []
    },
    {
     "table": "ls_purchase_order_lines",
     "resource": "OrderLine",
     "projectFrom": "OrderLines",
     "recordIdField": "orderLineID",
     "parentLeaves": [
      "vendorID",
      "shopID",
      "complete",
      "orderedDate",
      "receivedDate",
      "archived",
      "vendorCurrencyCode"
     ]
    }
   ],
   "singleton": false,
   "relations": [
    "CustomFieldValues.value",
    "OrderLines"
   ],
   "extraParamSets": [],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [
    "OrderLines"
   ],
   "availability": "required"
  },
  {
   "resource": "OrdersByTaxClass",
   "path": "OrdersByTaxClass.json",
   "idField": "taxClassID",
   "keysetCapable": false,
   "leader": "ls_report_orders_by_tax_class",
   "members": [
    {
     "table": "ls_report_orders_by_tax_class",
     "resource": "Orders",
     "projectFrom": null,
     "recordIdField": "taxClassID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "date_range",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "OrderShipmentItem",
   "path": "OrderShipmentItem.json",
   "idField": "orderShipmentItemID",
   "keysetCapable": true,
   "leader": "ls_order_shipment_items",
   "members": [
    {
     "table": "ls_order_shipment_items",
     "resource": "ShipmentItem",
     "projectFrom": null,
     "recordIdField": "orderShipmentItemID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "PaymentsByDay",
   "path": "PaymentsByDay.json",
   "idField": "date",
   "keysetCapable": true,
   "leader": "ls_report_payments_by_day",
   "members": [
    {
     "table": "ls_report_payments_by_day",
     "resource": "PaymentsByDay",
     "projectFrom": null,
     "recordIdField": "date",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "date_range",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "PaymentType",
   "path": "PaymentType.json",
   "idField": "paymentTypeID",
   "keysetCapable": false,
   "leader": "ls_payment_types",
   "members": [
    {
     "table": "ls_payment_types",
     "resource": "PaymentType",
     "projectFrom": null,
     "recordIdField": "paymentTypeID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "required"
  },
  {
   "resource": "PriceLevel",
   "path": "PriceLevel.json",
   "idField": "priceLevelID",
   "keysetCapable": false,
   "leader": "ls_price_levels",
   "members": [
    {
     "table": "ls_price_levels",
     "resource": "PriceLevel",
     "projectFrom": null,
     "recordIdField": "priceLevelID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "ProcessingFee",
   "path": "ProcessingFee.json",
   "idField": "salePaymentProcessingFeeID",
   "keysetCapable": false,
   "leader": "ls_processing_fees",
   "members": [
    {
     "table": "ls_processing_fees",
     "resource": "ProcessingFee",
     "projectFrom": null,
     "recordIdField": "salePaymentProcessingFeeID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Quote",
   "path": "Quote.json",
   "idField": "quoteID",
   "keysetCapable": true,
   "leader": "ls_quotes",
   "members": [
    {
     "table": "ls_quotes",
     "resource": "Quote",
     "projectFrom": null,
     "recordIdField": "quoteID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Register",
   "path": "Register.json",
   "idField": "registerID",
   "keysetCapable": false,
   "leader": "ls_registers",
   "members": [
    {
     "table": "ls_registers",
     "resource": "Register",
     "projectFrom": null,
     "recordIdField": "registerID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "required"
  },
  {
   "resource": "RegisterCount",
   "path": "RegisterCount.json",
   "idField": "registerCountID",
   "keysetCapable": true,
   "leader": "ls_register_counts",
   "members": [
    {
     "table": "ls_register_counts",
     "resource": "RegisterCount",
     "projectFrom": null,
     "recordIdField": "registerCountID",
     "parentLeaves": []
    },
    {
     "table": "ls_register_count_amounts",
     "resource": "RegisterCountAmount",
     "projectFrom": "RegisterCountAmounts.RegisterCountAmount",
     "recordIdField": "registerCountAmountID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "RegisterCountAmounts.PaymentType"
   ],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "RegisterWithdraw",
   "path": "RegisterWithdraw.json",
   "idField": "registerWithdrawID",
   "keysetCapable": true,
   "leader": "ls_register_withdraws",
   "members": [
    {
     "table": "ls_register_withdraws",
     "resource": "RegisterWithdraw",
     "projectFrom": null,
     "recordIdField": "registerWithdrawID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "id_keyset",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Sale",
   "path": "Sale.json",
   "idField": "saleID",
   "keysetCapable": true,
   "leader": "ls_sales",
   "members": [
    {
     "table": "ls_sales",
     "resource": "Sale",
     "projectFrom": null,
     "recordIdField": "saleID",
     "parentLeaves": []
    },
    {
     "table": "ls_sale_lines",
     "resource": "SaleLine",
     "projectFrom": "SaleLines.SaleLine",
     "recordIdField": "saleLineID",
     "parentLeaves": [
      "completed",
      "voided",
      "completeTime"
     ]
    },
    {
     "table": "ls_sale_payments",
     "resource": "SalePayment",
     "projectFrom": "SalePayments.SalePayment",
     "recordIdField": "salePaymentID",
     "parentLeaves": [
      "completed",
      "voided",
      "completeTime",
      "shopID"
     ]
    },
    {
     "table": "ls_sale_accounts",
     "resource": "SaleAccount",
     "projectFrom": "SalePayments.SalePayment.SaleAccounts.SaleAccount",
     "recordIdField": "saleAccountID",
     "parentLeaves": []
    },
    {
     "table": "ls_sale_payment_signatures",
     "resource": "SalePaymentSignature",
     "projectFrom": "SalePayments.SalePayment.Signatures.SalePaymentSignature",
     "recordIdField": "salePaymentSignatureID",
     "parentLeaves": []
    },
    {
     "table": "ls_sale_line_inventory_allocations",
     "resource": "InventorySale",
     "projectFrom": "SaleLines.SaleLine.InventorySales.InventorySale",
     "recordIdField": "inventorySaleID",
     "parentLeaves": [
      "saleID"
     ]
    }
   ],
   "singleton": false,
   "relations": [
    "SaleLines.InventorySales",
    "SalePayments.SaleAccounts",
    "SalePayments.Signatures"
   ],
   "extraParamSets": [],
   "modifiedParam": "updateTime",
   "incremental": "modified",
   "requiredRoots": [
    "SaleLines",
    "SalePayments"
   ],
   "availability": "required"
  },
  {
   "resource": "SaleVoid",
   "path": "SaleVoid.json",
   "idField": "saleVoidID",
   "keysetCapable": true,
   "leader": "ls_sale_voids",
   "members": [
    {
     "table": "ls_sale_voids",
     "resource": "SaleVoid",
     "projectFrom": null,
     "recordIdField": "saleVoidID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "id_keyset",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Season",
   "path": "Season.json",
   "idField": "seasonID",
   "keysetCapable": false,
   "leader": "ls_seasons",
   "members": [
    {
     "table": "ls_seasons",
     "resource": "Season",
     "projectFrom": null,
     "recordIdField": "seasonID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Serialized",
   "path": "Serialized.json",
   "idField": "serializedID",
   "keysetCapable": false,
   "leader": "ls_serialized",
   "members": [
    {
     "table": "ls_serialized",
     "resource": "Serialized",
     "projectFrom": null,
     "recordIdField": "serializedID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Session",
   "path": "Session.json",
   "idField": "systemAPIKeyID",
   "keysetCapable": false,
   "leader": "ls_session",
   "members": [
    {
     "table": "ls_session",
     "resource": "Session",
     "projectFrom": null,
     "recordIdField": "systemAPIKeyID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Shipment",
   "path": "Shipment.json",
   "idField": "orderShipmentID",
   "keysetCapable": true,
   "leader": "ls_order_shipments",
   "members": [
    {
     "table": "ls_order_shipments",
     "resource": "OrderShipment",
     "projectFrom": null,
     "recordIdField": "orderShipmentID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "ShipTo",
   "path": "ShipTo.json",
   "idField": "shipToID",
   "keysetCapable": true,
   "leader": "ls_ship_tos",
   "members": [
    {
     "table": "ls_ship_tos",
     "resource": "ShipTo",
     "projectFrom": null,
     "recordIdField": "shipToID",
     "parentLeaves": []
    },
    {
     "table": "ls_contacts",
     "resource": "Contact",
     "projectFrom": "Contact",
     "recordIdField": "contactID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "Contact"
   ],
   "extraParamSets": [],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Shop",
   "path": "Shop.json",
   "idField": "shopID",
   "keysetCapable": true,
   "leader": "ls_shops",
   "members": [
    {
     "table": "ls_shops",
     "resource": "Shop",
     "projectFrom": null,
     "recordIdField": "shopID",
     "parentLeaves": []
    },
    {
     "table": "ls_cc_gateways",
     "resource": "CCGateway",
     "projectFrom": "CCGateway",
     "recordIdField": "ccGatewayID",
     "parentLeaves": []
    },
    {
     "table": "ls_receipt_setups",
     "resource": "ReceiptSetup",
     "projectFrom": "ReceiptSetup",
     "recordIdField": "receiptSetupID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "CCGateway",
    "Contact",
    "ReceiptSetup"
   ],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "required"
  },
  {
   "resource": "SpecialOrder",
   "path": "SpecialOrder.json",
   "idField": "specialOrderID",
   "keysetCapable": true,
   "leader": "ls_special_orders",
   "members": [
    {
     "table": "ls_special_orders",
     "resource": "SpecialOrder",
     "projectFrom": null,
     "recordIdField": "specialOrderID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Tag",
   "path": "Tag.json",
   "idField": "tagID",
   "keysetCapable": false,
   "leader": "ls_tags",
   "members": [
    {
     "table": "ls_tags",
     "resource": "Tag",
     "projectFrom": null,
     "recordIdField": "tagID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "TagGroup",
   "path": "TagGroup.json",
   "idField": "name",
   "keysetCapable": false,
   "leader": "ls_tag_groups",
   "members": [
    {
     "table": "ls_tag_groups",
     "resource": "TagGroup",
     "projectFrom": null,
     "recordIdField": "name",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "TaxCategory",
   "path": "TaxCategory.json",
   "idField": "taxCategoryID",
   "keysetCapable": false,
   "leader": "ls_tax_categories",
   "members": [
    {
     "table": "ls_tax_categories",
     "resource": "TaxCategory",
     "projectFrom": null,
     "recordIdField": "taxCategoryID",
     "parentLeaves": []
    },
    {
     "table": "ls_tax_category_classes",
     "resource": "TaxCategory",
     "projectFrom": "TaxCategoryClasses.TaxCategoryClass",
     "recordIdField": "taxCategoryID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "TaxCategoryClasses.TaxClass"
   ],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "required"
  },
  {
   "resource": "TaxClass",
   "path": "TaxClass.json",
   "idField": "taxClassID",
   "keysetCapable": false,
   "leader": "ls_tax_classes",
   "members": [
    {
     "table": "ls_tax_classes",
     "resource": "TaxClass",
     "projectFrom": null,
     "recordIdField": "taxClassID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "TaxClassSalesByDay",
   "path": "TaxClassSalesByDay.json",
   "idField": "date",
   "keysetCapable": true,
   "leader": "ls_report_tax_class_sales_by_day",
   "members": [
    {
     "table": "ls_report_tax_class_sales_by_day",
     "resource": "SalesByTaxClassAndDay",
     "projectFrom": null,
     "recordIdField": "date",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "date_range",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "TaxesByDay",
   "path": "TaxesByDay.json",
   "idField": "date",
   "keysetCapable": true,
   "leader": "ls_report_taxes_by_day",
   "members": [
    {
     "table": "ls_report_taxes_by_day",
     "resource": "TaxesByDay",
     "projectFrom": null,
     "recordIdField": "date",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "date_range",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Transfer",
   "path": "Transfer.json",
   "idField": "transferID",
   "keysetCapable": true,
   "leader": "ls_transfers",
   "members": [
    {
     "table": "ls_transfers",
     "resource": "Transfer",
     "projectFrom": null,
     "recordIdField": "transferID",
     "parentLeaves": []
    },
    {
     "table": "ls_transfer_items",
     "resource": "TransferItem",
     "projectFrom": "TransferItems.TransferItem",
     "recordIdField": "transferItemID",
     "parentLeaves": []
    },
    {
     "table": "ls_transfer_from",
     "resource": "TransferFrom",
     "projectFrom": null,
     "recordIdField": "transferFromID",
     "parentLeaves": []
    },
    {
     "table": "ls_transfer_to",
     "resource": "TransferTo",
     "projectFrom": null,
     "recordIdField": "transferToID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "TransferItems"
   ],
   "extraParamSets": [],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Vendor",
   "path": "Vendor.json",
   "idField": "vendorID",
   "keysetCapable": true,
   "leader": "ls_vendors",
   "members": [
    {
     "table": "ls_vendors",
     "resource": "Vendor",
     "projectFrom": null,
     "recordIdField": "vendorID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "Contact"
   ],
   "extraParamSets": [
    {
     "archived": "only"
    }
   ],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [],
   "availability": "required"
  },
  {
   "resource": "VendorReturn",
   "path": "VendorReturn.json",
   "idField": "vendorReturnID",
   "keysetCapable": true,
   "leader": "ls_vendor_returns",
   "members": [
    {
     "table": "ls_vendor_returns",
     "resource": "VendorReturn",
     "projectFrom": null,
     "recordIdField": "vendorReturnID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "Workorder",
   "path": "Workorder.json",
   "idField": "workorderID",
   "keysetCapable": true,
   "leader": "ls_workorders",
   "members": [
    {
     "table": "ls_workorders",
     "resource": "Workorder",
     "projectFrom": null,
     "recordIdField": "workorderID",
     "parentLeaves": []
    },
    {
     "table": "ls_workorder_lines",
     "resource": "WorkorderLine",
     "projectFrom": "WorkorderLines.WorkorderLine",
     "recordIdField": "workorderLineID",
     "parentLeaves": []
    },
    {
     "table": "ls_workorder_items",
     "resource": "WorkorderItem",
     "projectFrom": "WorkorderItems.WorkorderItem",
     "recordIdField": "workorderItemID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [
    "Customer",
    "WorkorderItems.Discount",
    "WorkorderLines.Discount",
    "WorkorderLines.TaxClass"
   ],
   "extraParamSets": [],
   "modifiedParam": "timeStamp",
   "incremental": "modified",
   "requiredRoots": [],
   "availability": "optional"
  },
  {
   "resource": "WorkorderStatus",
   "path": "WorkorderStatus.json",
   "idField": "workorderStatusID",
   "keysetCapable": true,
   "leader": "ls_workorder_statuses",
   "members": [
    {
     "table": "ls_workorder_statuses",
     "resource": "WorkorderStatus",
     "projectFrom": null,
     "recordIdField": "workorderStatusID",
     "parentLeaves": []
    }
   ],
   "singleton": false,
   "relations": [],
   "extraParamSets": [],
   "modifiedParam": null,
   "incremental": "full",
   "requiredRoots": [],
   "availability": "optional"
  }
 ],
 "fanOuts": [
  {
   "table": "ls_custom_field_choices",
   "resource": "CustomFieldChoice",
   "parentResource": "CustomField",
   "parentPath": "CustomField.json",
   "parentIdField": "customFieldID",
   "endpointTemplate": "Customer/CustomField/{customFieldID}/CustomFieldChoice.json",
   "recordIdField": "customFieldChoiceID",
   "alwaysOn": true
  },
  {
   "table": "ls_workorder_images",
   "resource": "WorkorderImage",
   "parentResource": "Workorder",
   "parentPath": "Workorder.json",
   "parentIdField": "workorderID",
   "endpointTemplate": "Workorder/{workorderID}/WorkorderImage.json",
   "recordIdField": "workorderImageID",
   "alwaysOn": false
  },
  {
   "table": "ls_register_calculated",
   "resource": "Register Calculated",
   "parentResource": "Register",
   "parentPath": "Register.json",
   "parentIdField": "registerID",
   "endpointTemplate": "Register/{registerID}/calculated.json",
   "recordIdField": null,
   "alwaysOn": true
  }
 ]
}''')
