# GENERATED FILE — do not edit.
# Source: connectors/xero/tables.json (XeroAPI/Xero-OpenAPI@45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f (accounting, assets, projects, files, payroll AU/UK/NZ, identity) via the domain design + adversarial audit pipeline) via
# scripts/generate-fivetran-xero-sdk-spec.ts. Regenerate with:
#   npx tsx scripts/generate-fivetran-xero-sdk-spec.ts
import json

SPEC_SHA256 = "52e2b5ece062ef7d969d54b14d41a1cf48e9e1f8906c573c56663bd8f560a277"

SPEC = json.loads(r'''{
 "revision": "XeroAPI/Xero-OpenAPI@45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f (accounting, assets, projects, files, payroll AU/UK/NZ, identity) via the domain design + adversarial audit pipeline",
 "profiles": {
  "accounting": {
   "basePath": "/api.xro/2.0",
   "pageParam": "page",
   "pageSizeParam": "pageSize",
   "pageSize": 1000,
   "supportsIfModifiedSince": true,
   "supportsWhere": true,
   "supportsOrder": true
  },
  "assets": {
   "basePath": "/assets.xro/1.0",
   "pageParam": "page",
   "pageSizeParam": "pageSize",
   "pageSize": 100,
   "supportsIfModifiedSince": false,
   "supportsWhere": false,
   "supportsOrder": false
  },
  "projects": {
   "basePath": "/projects.xro/2.0",
   "pageParam": "page",
   "pageSizeParam": "pageSize",
   "pageSize": 50,
   "supportsIfModifiedSince": false,
   "supportsWhere": false,
   "supportsOrder": false
  },
  "files": {
   "basePath": "/files.xro/1.0",
   "pageParam": "page",
   "pageSizeParam": "pagesize",
   "pageSize": 100,
   "supportsIfModifiedSince": false,
   "supportsWhere": false,
   "supportsOrder": false
  },
  "payroll_au": {
   "basePath": "/payroll.xro/1.0",
   "pageParam": "page",
   "pageSizeParam": null,
   "pageSize": 100,
   "supportsIfModifiedSince": true,
   "supportsWhere": true,
   "supportsOrder": true
  },
  "payroll_uk": {
   "basePath": "/payroll.xro/2.0",
   "pageParam": "page",
   "pageSizeParam": null,
   "pageSize": 100,
   "supportsIfModifiedSince": false,
   "supportsWhere": false,
   "supportsOrder": false
  },
  "payroll_nz": {
   "basePath": "/payroll.xro/2.0",
   "pageParam": "page",
   "pageSizeParam": null,
   "pageSize": 100,
   "supportsIfModifiedSince": false,
   "supportsWhere": false,
   "supportsOrder": false
  },
  "identity": {
   "basePath": "",
   "pageParam": null,
   "pageSizeParam": null,
   "pageSize": 0,
   "supportsIfModifiedSince": false,
   "supportsWhere": false,
   "supportsOrder": false
  }
 },
 "tables": {
  "xero_1099_contacts": {
   "id": "xero_1099_contacts",
   "primaryKey": [
    "report_year",
    "contact_id"
   ],
   "recordIdField": "ContactId",
   "sourceObjects": [
    "accounting:TenNinetyNineContact"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Reports/TenNinetyNine",
    "envelope": "Reports",
    "arrayKey": "Reports",
    "explodePath": "Report.Contacts",
    "explodeChain": [
     "Report",
     "TenNinetyNineContact"
    ],
    "parentTable": "xero_1099_reports",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.reports.read",
     "accounting.reports.tenninetynine.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "report_year",
     "type": "integer",
     "api": "synthetic:reportYear request parameter inherited from the parent report scan"
    },
    {
     "name": "contact_id",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.ContactId"
    },
    {
     "name": "box1",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box1"
    },
    {
     "name": "box2",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box2"
    },
    {
     "name": "box3",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box3"
    },
    {
     "name": "box4",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box4"
    },
    {
     "name": "box5",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box5"
    },
    {
     "name": "box6",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box6"
    },
    {
     "name": "box7",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box7"
    },
    {
     "name": "box8",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box8"
    },
    {
     "name": "box9",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box9"
    },
    {
     "name": "box10",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box10"
    },
    {
     "name": "box11",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box11"
    },
    {
     "name": "box13",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box13"
    },
    {
     "name": "box14",
     "type": "numeric",
     "api": "accounting:TenNinetyNineContact.Box14"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.Name"
    },
    {
     "name": "legal_name",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.LegalName"
    },
    {
     "name": "business_name",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.BusinessName"
    },
    {
     "name": "federal_tax_id_type",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.FederalTaxIDType"
    },
    {
     "name": "tax_id",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.TaxID"
    },
    {
     "name": "federal_tax_classification",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.FederalTaxClassification"
    },
    {
     "name": "street_address",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.StreetAddress"
    },
    {
     "name": "city",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.City"
    },
    {
     "name": "state",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.State"
    },
    {
     "name": "zip",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.Zip"
    },
    {
     "name": "email",
     "type": "text",
     "api": "accounting:TenNinetyNineContact.Email"
    }
   ]
  },
  "xero_1099_reports": {
   "id": "xero_1099_reports",
   "primaryKey": [
    "report_year"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:Report"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Reports/TenNinetyNine",
    "envelope": "Reports",
    "arrayKey": "Reports",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "accounting.reports.read",
     "accounting.reports.tenninetynine.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "report_year",
     "type": "integer",
     "api": "synthetic:the reportYear request parameter the scan issued for this fetch"
    },
    {
     "name": "report_name",
     "type": "text",
     "api": "accounting:Report.ReportName"
    },
    {
     "name": "report_type",
     "type": "text",
     "api": "accounting:Report.ReportType"
    },
    {
     "name": "report_title",
     "type": "text",
     "api": "accounting:Report.ReportTitle"
    },
    {
     "name": "report_date",
     "type": "date",
     "api": "accounting:Report.ReportDate"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Report.UpdatedDateUTC"
    },
    {
     "name": "contacts",
     "type": "jsonb",
     "api": "accounting:Report.Contacts"
    }
   ]
  },
  "xero_accounts": {
   "id": "xero_accounts",
   "primaryKey": [
    "account_id"
   ],
   "recordIdField": "AccountID",
   "sourceObjects": [
    "accounting:Account"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Accounts",
    "envelope": "Accounts",
    "arrayKey": "Accounts",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.settings",
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "account_id",
     "type": "text",
     "api": "accounting:Account.AccountID"
    },
    {
     "name": "code",
     "type": "text",
     "api": "accounting:Account.Code"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:Account.Name"
    },
    {
     "name": "type",
     "type": "text",
     "api": "accounting:Account.Type"
    },
    {
     "name": "bank_account_number",
     "type": "text",
     "api": "accounting:Account.BankAccountNumber"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:Account.Status"
    },
    {
     "name": "description",
     "type": "text",
     "api": "accounting:Account.Description"
    },
    {
     "name": "bank_account_type",
     "type": "text",
     "api": "accounting:Account.BankAccountType"
    },
    {
     "name": "currency_code",
     "type": "text",
     "api": "accounting:Account.CurrencyCode"
    },
    {
     "name": "tax_type",
     "type": "text",
     "api": "accounting:Account.TaxType"
    },
    {
     "name": "enable_payments_to_account",
     "type": "boolean",
     "api": "accounting:Account.EnablePaymentsToAccount"
    },
    {
     "name": "show_in_expense_claims",
     "type": "boolean",
     "api": "accounting:Account.ShowInExpenseClaims"
    },
    {
     "name": "class",
     "type": "text",
     "api": "accounting:Account.Class"
    },
    {
     "name": "system_account",
     "type": "text",
     "api": "accounting:Account.SystemAccount"
    },
    {
     "name": "reporting_code",
     "type": "text",
     "api": "accounting:Account.ReportingCode"
    },
    {
     "name": "reporting_code_name",
     "type": "text",
     "api": "accounting:Account.ReportingCodeName"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:Account.HasAttachments"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Account.UpdatedDateUTC"
    },
    {
     "name": "add_to_watchlist",
     "type": "boolean",
     "api": "accounting:Account.AddToWatchlist"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:Account.ValidationErrors"
    }
   ]
  },
  "xero_asset_settings": {
   "id": "xero_asset_settings",
   "primaryKey": [
    "singleton_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "assets:Setting"
   ],
   "source": {
    "api": "assets",
    "endpointOp": "GET /Settings",
    "envelope": "Setting",
    "arrayKey": null,
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "assets",
     "assets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "singleton_id",
     "type": "text",
     "api": "synthetic:constant key ('settings') minted because GET /Settings returns one unkeyed record per organisation"
    },
    {
     "name": "asset_number_prefix",
     "type": "text",
     "api": "assets:Setting.assetNumberPrefix"
    },
    {
     "name": "asset_number_sequence",
     "type": "text",
     "api": "assets:Setting.assetNumberSequence"
    },
    {
     "name": "asset_start_date",
     "type": "date",
     "api": "assets:Setting.assetStartDate"
    },
    {
     "name": "last_depreciation_date",
     "type": "date",
     "api": "assets:Setting.lastDepreciationDate"
    },
    {
     "name": "default_gain_on_disposal_account_id",
     "type": "text",
     "api": "assets:Setting.defaultGainOnDisposalAccountId"
    },
    {
     "name": "default_loss_on_disposal_account_id",
     "type": "text",
     "api": "assets:Setting.defaultLossOnDisposalAccountId"
    },
    {
     "name": "default_capital_gain_on_disposal_account_id",
     "type": "text",
     "api": "assets:Setting.defaultCapitalGainOnDisposalAccountId"
    },
    {
     "name": "opt_in_for_tax",
     "type": "boolean",
     "api": "assets:Setting.optInForTax"
    }
   ]
  },
  "xero_asset_types": {
   "id": "xero_asset_types",
   "primaryKey": [
    "asset_type_id"
   ],
   "recordIdField": "assetTypeId",
   "sourceObjects": [
    "assets:AssetType",
    "assets:BookDepreciationSetting"
   ],
   "source": {
    "api": "assets",
    "endpointOp": "GET /AssetTypes",
    "envelope": "AssetType",
    "arrayKey": null,
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "assets",
     "assets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "asset_type_id",
     "type": "text",
     "api": "assets:AssetType.assetTypeId"
    },
    {
     "name": "asset_type_name",
     "type": "text",
     "api": "assets:AssetType.assetTypeName"
    },
    {
     "name": "fixed_asset_account_id",
     "type": "text",
     "api": "assets:AssetType.fixedAssetAccountId"
    },
    {
     "name": "depreciation_expense_account_id",
     "type": "text",
     "api": "assets:AssetType.depreciationExpenseAccountId"
    },
    {
     "name": "accumulated_depreciation_account_id",
     "type": "text",
     "api": "assets:AssetType.accumulatedDepreciationAccountId"
    },
    {
     "name": "book_depreciation_setting_depreciation_method",
     "type": "text",
     "api": "assets:AssetType.bookDepreciationSetting.depreciationMethod"
    },
    {
     "name": "book_depreciation_setting_averaging_method",
     "type": "text",
     "api": "assets:AssetType.bookDepreciationSetting.averagingMethod"
    },
    {
     "name": "book_depreciation_setting_depreciation_rate",
     "type": "numeric",
     "api": "assets:AssetType.bookDepreciationSetting.depreciationRate"
    },
    {
     "name": "book_depreciation_setting_effective_life_years",
     "type": "integer",
     "api": "assets:AssetType.bookDepreciationSetting.effectiveLifeYears"
    },
    {
     "name": "book_depreciation_setting_depreciation_calculation_method",
     "type": "text",
     "api": "assets:AssetType.bookDepreciationSetting.depreciationCalculationMethod"
    },
    {
     "name": "book_depreciation_setting_depreciable_object_id",
     "type": "text",
     "api": "assets:AssetType.bookDepreciationSetting.depreciableObjectId"
    },
    {
     "name": "book_depreciation_setting_depreciable_object_type",
     "type": "text",
     "api": "assets:AssetType.bookDepreciationSetting.depreciableObjectType"
    },
    {
     "name": "book_depreciation_setting_book_effective_date_of_change_id",
     "type": "text",
     "api": "assets:AssetType.bookDepreciationSetting.bookEffectiveDateOfChangeId"
    },
    {
     "name": "locks",
     "type": "integer",
     "api": "assets:AssetType.locks"
    }
   ]
  },
  "xero_assets": {
   "id": "xero_assets",
   "primaryKey": [
    "asset_id"
   ],
   "recordIdField": "assetId",
   "sourceObjects": [
    "assets:Asset",
    "assets:BookDepreciationSetting",
    "assets:BookDepreciationDetail"
   ],
   "source": {
    "api": "assets",
    "endpointOp": "GET /Assets",
    "envelope": "Assets",
    "arrayKey": "items",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "assets",
     "assets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "asset_id",
     "type": "text",
     "api": "assets:Asset.assetId"
    },
    {
     "name": "asset_name",
     "type": "text",
     "api": "assets:Asset.assetName"
    },
    {
     "name": "asset_type_id",
     "type": "text",
     "api": "assets:Asset.assetTypeId"
    },
    {
     "name": "asset_number",
     "type": "text",
     "api": "assets:Asset.assetNumber"
    },
    {
     "name": "purchase_date",
     "type": "date",
     "api": "assets:Asset.purchaseDate"
    },
    {
     "name": "purchase_price",
     "type": "numeric",
     "api": "assets:Asset.purchasePrice"
    },
    {
     "name": "disposal_date",
     "type": "date",
     "api": "assets:Asset.disposalDate"
    },
    {
     "name": "disposal_price",
     "type": "numeric",
     "api": "assets:Asset.disposalPrice"
    },
    {
     "name": "asset_status",
     "type": "text",
     "api": "assets:Asset.assetStatus"
    },
    {
     "name": "warranty_expiry_date",
     "type": "date",
     "api": "assets:Asset.warrantyExpiryDate"
    },
    {
     "name": "serial_number",
     "type": "text",
     "api": "assets:Asset.serialNumber"
    },
    {
     "name": "book_depreciation_setting_depreciation_method",
     "type": "text",
     "api": "assets:Asset.bookDepreciationSetting.depreciationMethod"
    },
    {
     "name": "book_depreciation_setting_averaging_method",
     "type": "text",
     "api": "assets:Asset.bookDepreciationSetting.averagingMethod"
    },
    {
     "name": "book_depreciation_setting_depreciation_rate",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationSetting.depreciationRate"
    },
    {
     "name": "book_depreciation_setting_effective_life_years",
     "type": "integer",
     "api": "assets:Asset.bookDepreciationSetting.effectiveLifeYears"
    },
    {
     "name": "book_depreciation_setting_depreciation_calculation_method",
     "type": "text",
     "api": "assets:Asset.bookDepreciationSetting.depreciationCalculationMethod"
    },
    {
     "name": "book_depreciation_setting_depreciable_object_id",
     "type": "text",
     "api": "assets:Asset.bookDepreciationSetting.depreciableObjectId"
    },
    {
     "name": "book_depreciation_setting_depreciable_object_type",
     "type": "text",
     "api": "assets:Asset.bookDepreciationSetting.depreciableObjectType"
    },
    {
     "name": "book_depreciation_setting_book_effective_date_of_change_id",
     "type": "text",
     "api": "assets:Asset.bookDepreciationSetting.bookEffectiveDateOfChangeId"
    },
    {
     "name": "book_depreciation_detail_depreciation_start_date",
     "type": "date",
     "api": "assets:Asset.bookDepreciationDetail.depreciationStartDate"
    },
    {
     "name": "book_depreciation_detail_cost_limit",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationDetail.costLimit"
    },
    {
     "name": "book_depreciation_detail_residual_value",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationDetail.residualValue"
    },
    {
     "name": "book_depreciation_detail_prior_accum_depreciation_amount",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationDetail.priorAccumDepreciationAmount"
    },
    {
     "name": "book_depreciation_detail_current_accum_depreciation_amount",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationDetail.currentAccumDepreciationAmount"
    },
    {
     "name": "book_depreciation_detail_current_capital_gain",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationDetail.currentCapitalGain"
    },
    {
     "name": "book_depreciation_detail_current_gain_loss",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationDetail.currentGainLoss"
    },
    {
     "name": "book_depreciation_detail_business_use_capital_gain",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationDetail.businessUseCapitalGain"
    },
    {
     "name": "book_depreciation_detail_business_use_current_gain_loss",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationDetail.businessUseCurrentGainLoss"
    },
    {
     "name": "book_depreciation_detail_private_use_capital_gain",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationDetail.privateUseCapitalGain"
    },
    {
     "name": "book_depreciation_detail_private_use_current_gain_loss",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationDetail.privateUseCurrentGainLoss"
    },
    {
     "name": "book_depreciation_detail_initial_deduction_percentage",
     "type": "numeric",
     "api": "assets:Asset.bookDepreciationDetail.initialDeductionPercentage"
    },
    {
     "name": "can_rollback",
     "type": "boolean",
     "api": "assets:Asset.canRollback"
    },
    {
     "name": "accounting_book_value",
     "type": "numeric",
     "api": "assets:Asset.accountingBookValue"
    },
    {
     "name": "is_delete_enabled_for_date",
     "type": "boolean",
     "api": "assets:Asset.isDeleteEnabledForDate"
    }
   ]
  },
  "xero_attachments": {
   "id": "xero_attachments",
   "primaryKey": [
    "parent_endpoint",
    "parent_id",
    "attachment_id"
   ],
   "recordIdField": "AttachmentID",
   "sourceObjects": [
    "accounting:Attachment"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /{Endpoint}/{Guid}/Attachments",
    "envelope": "Attachments",
    "arrayKey": "Attachments",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": "Guid",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.attachments.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "parent_endpoint",
     "type": "text",
     "api": "synthetic:the {Endpoint} segment of the fan-out path — which Xero collection the parent record lives in (e.g. 'Invoices', 'Receipts', 'BankTransactions')"
    },
    {
     "name": "parent_id",
     "type": "text",
     "api": "synthetic:the {Guid} segment of the fan-out path — the parent record's vendor UUID"
    },
    {
     "name": "attachment_id",
     "type": "text",
     "api": "accounting:Attachment.AttachmentID"
    },
    {
     "name": "file_name",
     "type": "text",
     "api": "accounting:Attachment.FileName"
    },
    {
     "name": "url",
     "type": "text",
     "api": "accounting:Attachment.Url"
    },
    {
     "name": "mime_type",
     "type": "text",
     "api": "accounting:Attachment.MimeType"
    },
    {
     "name": "content_length",
     "type": "integer",
     "api": "accounting:Attachment.ContentLength"
    },
    {
     "name": "include_online",
     "type": "boolean",
     "api": "accounting:Attachment.IncludeOnline"
    }
   ]
  },
  "xero_bank_transaction_line_item_tracking": {
   "id": "xero_bank_transaction_line_item_tracking",
   "primaryKey": [
    "bank_transaction_id",
    "line_index",
    "tracking_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:LineItemTracking",
    "accounting:BankTransaction",
    "accounting:LineItem"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /BankTransactions",
    "envelope": "BankTransactions",
    "arrayKey": "BankTransactions",
    "explodePath": "BankTransaction.LineItems.Tracking",
    "explodeChain": [
     "BankTransaction",
     "LineItem",
     "LineItemTracking"
    ],
    "parentTable": "xero_bank_transaction_line_items",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "bank_transaction_id",
     "type": "text",
     "api": "accounting:BankTransaction.BankTransactionID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position of the parent line in accounting:BankTransaction.LineItems"
    },
    {
     "name": "tracking_index",
     "type": "integer",
     "api": "synthetic:zero-based position in accounting:LineItem.Tracking (Xero allows at most two entries per line)"
    },
    {
     "name": "tracking_category_id",
     "type": "text",
     "api": "accounting:LineItemTracking.TrackingCategoryID"
    },
    {
     "name": "tracking_option_id",
     "type": "text",
     "api": "accounting:LineItemTracking.TrackingOptionID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:LineItemTracking.Name"
    },
    {
     "name": "option",
     "type": "text",
     "api": "accounting:LineItemTracking.Option"
    }
   ]
  },
  "xero_bank_transaction_line_items": {
   "id": "xero_bank_transaction_line_items",
   "primaryKey": [
    "bank_transaction_id",
    "line_index"
   ],
   "recordIdField": "LineItemID",
   "sourceObjects": [
    "accounting:LineItem",
    "accounting:BankTransaction"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /BankTransactions",
    "envelope": "BankTransactions",
    "arrayKey": "BankTransactions",
    "explodePath": "BankTransaction.LineItems",
    "explodeChain": [
     "BankTransaction",
     "LineItem"
    ],
    "parentTable": "xero_bank_transactions",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "bank_transaction_id",
     "type": "text",
     "api": "accounting:BankTransaction.BankTransactionID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position of this line in accounting:BankTransaction.LineItems, preserving Xero's presentation order"
    },
    {
     "name": "line_item_id",
     "type": "text",
     "api": "accounting:LineItem.LineItemID"
    },
    {
     "name": "description",
     "type": "text",
     "api": "accounting:LineItem.Description"
    },
    {
     "name": "quantity",
     "type": "numeric",
     "api": "accounting:LineItem.Quantity"
    },
    {
     "name": "unit_amount",
     "type": "numeric",
     "api": "accounting:LineItem.UnitAmount"
    },
    {
     "name": "item_code",
     "type": "text",
     "api": "accounting:LineItem.ItemCode"
    },
    {
     "name": "account_code",
     "type": "text",
     "api": "accounting:LineItem.AccountCode"
    },
    {
     "name": "account_id",
     "type": "text",
     "api": "accounting:LineItem.AccountID"
    },
    {
     "name": "tax_type",
     "type": "text",
     "api": "accounting:LineItem.TaxType"
    },
    {
     "name": "tax_amount",
     "type": "numeric",
     "api": "accounting:LineItem.TaxAmount"
    },
    {
     "name": "line_amount",
     "type": "numeric",
     "api": "accounting:LineItem.LineAmount"
    }
   ]
  },
  "xero_bank_transactions": {
   "id": "xero_bank_transactions",
   "primaryKey": [
    "bank_transaction_id"
   ],
   "recordIdField": "BankTransactionID",
   "sourceObjects": [
    "accounting:BankTransaction"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /BankTransactions",
    "envelope": "BankTransactions",
    "arrayKey": "BankTransactions",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "bank_transaction_id",
     "type": "text",
     "api": "accounting:BankTransaction.BankTransactionID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "accounting:BankTransaction.Type"
    },
    {
     "name": "contact_contact_id",
     "type": "text",
     "api": "accounting:BankTransaction.Contact.ContactID"
    },
    {
     "name": "contact_name",
     "type": "text",
     "api": "accounting:BankTransaction.Contact.Name"
    },
    {
     "name": "bank_account_account_id",
     "type": "text",
     "api": "accounting:BankTransaction.BankAccount.AccountID"
    },
    {
     "name": "bank_account_code",
     "type": "text",
     "api": "accounting:BankTransaction.BankAccount.Code"
    },
    {
     "name": "bank_account_name",
     "type": "text",
     "api": "accounting:BankTransaction.BankAccount.Name"
    },
    {
     "name": "is_reconciled",
     "type": "boolean",
     "api": "accounting:BankTransaction.IsReconciled"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:BankTransaction.Date"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:BankTransaction.Reference"
    },
    {
     "name": "currency_code",
     "type": "text",
     "api": "accounting:BankTransaction.CurrencyCode"
    },
    {
     "name": "currency_rate",
     "type": "numeric",
     "api": "accounting:BankTransaction.CurrencyRate"
    },
    {
     "name": "url",
     "type": "text",
     "api": "accounting:BankTransaction.Url"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:BankTransaction.Status"
    },
    {
     "name": "line_amount_types",
     "type": "text",
     "api": "accounting:BankTransaction.LineAmountTypes"
    },
    {
     "name": "sub_total",
     "type": "numeric",
     "api": "accounting:BankTransaction.SubTotal"
    },
    {
     "name": "total_tax",
     "type": "numeric",
     "api": "accounting:BankTransaction.TotalTax"
    },
    {
     "name": "total",
     "type": "numeric",
     "api": "accounting:BankTransaction.Total"
    },
    {
     "name": "prepayment_id",
     "type": "text",
     "api": "accounting:BankTransaction.PrepaymentID"
    },
    {
     "name": "overpayment_id",
     "type": "text",
     "api": "accounting:BankTransaction.OverpaymentID"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:BankTransaction.UpdatedDateUTC"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:BankTransaction.HasAttachments"
    },
    {
     "name": "status_attribute_string",
     "type": "text",
     "api": "accounting:BankTransaction.StatusAttributeString"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:BankTransaction.ValidationErrors"
    },
    {
     "name": "contact",
     "type": "jsonb",
     "api": "accounting:BankTransaction.Contact"
    },
    {
     "name": "line_items",
     "type": "jsonb",
     "api": "accounting:BankTransaction.LineItems"
    },
    {
     "name": "bank_account",
     "type": "jsonb",
     "api": "accounting:BankTransaction.BankAccount"
    }
   ]
  },
  "xero_bank_transfers": {
   "id": "xero_bank_transfers",
   "primaryKey": [
    "bank_transfer_id"
   ],
   "recordIdField": "BankTransferID",
   "sourceObjects": [
    "accounting:BankTransfer"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /BankTransfers",
    "envelope": "BankTransfers",
    "arrayKey": "BankTransfers",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": "CreatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "bank_transfer_id",
     "type": "text",
     "api": "accounting:BankTransfer.BankTransferID"
    },
    {
     "name": "from_bank_account_account_id",
     "type": "text",
     "api": "accounting:BankTransfer.FromBankAccount.AccountID"
    },
    {
     "name": "from_bank_account_code",
     "type": "text",
     "api": "accounting:BankTransfer.FromBankAccount.Code"
    },
    {
     "name": "from_bank_account_name",
     "type": "text",
     "api": "accounting:BankTransfer.FromBankAccount.Name"
    },
    {
     "name": "to_bank_account_account_id",
     "type": "text",
     "api": "accounting:BankTransfer.ToBankAccount.AccountID"
    },
    {
     "name": "to_bank_account_code",
     "type": "text",
     "api": "accounting:BankTransfer.ToBankAccount.Code"
    },
    {
     "name": "to_bank_account_name",
     "type": "text",
     "api": "accounting:BankTransfer.ToBankAccount.Name"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "accounting:BankTransfer.Amount"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:BankTransfer.Date"
    },
    {
     "name": "currency_rate",
     "type": "numeric",
     "api": "accounting:BankTransfer.CurrencyRate"
    },
    {
     "name": "from_bank_transaction_id",
     "type": "text",
     "api": "accounting:BankTransfer.FromBankTransactionID"
    },
    {
     "name": "to_bank_transaction_id",
     "type": "text",
     "api": "accounting:BankTransfer.ToBankTransactionID"
    },
    {
     "name": "from_is_reconciled",
     "type": "boolean",
     "api": "accounting:BankTransfer.FromIsReconciled"
    },
    {
     "name": "to_is_reconciled",
     "type": "boolean",
     "api": "accounting:BankTransfer.ToIsReconciled"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:BankTransfer.Reference"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:BankTransfer.HasAttachments"
    },
    {
     "name": "created_date_utc",
     "type": "timestamp",
     "api": "accounting:BankTransfer.CreatedDateUTC"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:BankTransfer.Status"
    },
    {
     "name": "from_tracking",
     "type": "jsonb",
     "api": "accounting:BankTransfer.FromTracking"
    },
    {
     "name": "to_tracking",
     "type": "jsonb",
     "api": "accounting:BankTransfer.ToTracking"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:BankTransfer.ValidationErrors"
    }
   ]
  },
  "xero_batch_payments": {
   "id": "xero_batch_payments",
   "primaryKey": [
    "batch_payment_id"
   ],
   "recordIdField": "BatchPaymentID",
   "sourceObjects": [
    "accounting:BatchPayment"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /BatchPayments",
    "envelope": "BatchPayments",
    "arrayKey": "BatchPayments",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions",
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "batch_payment_id",
     "type": "text",
     "api": "accounting:BatchPayment.BatchPaymentID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "accounting:BatchPayment.Type"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:BatchPayment.Status"
    },
    {
     "name": "account_account_id",
     "type": "text",
     "api": "accounting:BatchPayment.Account.AccountID"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:BatchPayment.Date"
    },
    {
     "name": "date_string",
     "type": "text",
     "api": "accounting:BatchPayment.DateString"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "accounting:BatchPayment.Amount"
    },
    {
     "name": "total_amount",
     "type": "numeric",
     "api": "accounting:BatchPayment.TotalAmount"
    },
    {
     "name": "is_reconciled",
     "type": "boolean",
     "api": "accounting:BatchPayment.IsReconciled"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:BatchPayment.Reference"
    },
    {
     "name": "particulars",
     "type": "text",
     "api": "accounting:BatchPayment.Particulars"
    },
    {
     "name": "code",
     "type": "text",
     "api": "accounting:BatchPayment.Code"
    },
    {
     "name": "details",
     "type": "text",
     "api": "accounting:BatchPayment.Details"
    },
    {
     "name": "narrative",
     "type": "text",
     "api": "accounting:BatchPayment.Narrative"
    },
    {
     "name": "payments",
     "type": "jsonb",
     "api": "accounting:BatchPayment.Payments"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:BatchPayment.UpdatedDateUTC"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:BatchPayment.ValidationErrors"
    }
   ]
  },
  "xero_branding_themes": {
   "id": "xero_branding_themes",
   "primaryKey": [
    "branding_theme_id"
   ],
   "recordIdField": "BrandingThemeID",
   "sourceObjects": [
    "accounting:BrandingTheme"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /BrandingThemes",
    "envelope": "BrandingThemes",
    "arrayKey": "BrandingThemes",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "branding_theme_id",
     "type": "text",
     "api": "accounting:BrandingTheme.BrandingThemeID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:BrandingTheme.Name"
    },
    {
     "name": "logo_url",
     "type": "text",
     "api": "accounting:BrandingTheme.LogoUrl"
    },
    {
     "name": "type",
     "type": "text",
     "api": "accounting:BrandingTheme.Type"
    },
    {
     "name": "sort_order",
     "type": "integer",
     "api": "accounting:BrandingTheme.SortOrder"
    },
    {
     "name": "created_date_utc",
     "type": "timestamp",
     "api": "accounting:BrandingTheme.CreatedDateUTC"
    }
   ]
  },
  "xero_budget_balances": {
   "id": "xero_budget_balances",
   "primaryKey": [
    "budget_id",
    "account_id",
    "period"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:BudgetBalance"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Budgets/{BudgetID}",
    "envelope": "Budgets",
    "arrayKey": "Budgets",
    "explodePath": "Budget.BudgetLines.BudgetBalances",
    "explodeChain": [
     "Budget",
     "BudgetLine",
     "BudgetBalance"
    ],
    "parentTable": "xero_budget_lines",
    "fanOutParam": "BudgetID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.budgets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "budget_id",
     "type": "text",
     "api": "accounting:Budget.BudgetID"
    },
    {
     "name": "account_id",
     "type": "text",
     "api": "accounting:BudgetLine.AccountID"
    },
    {
     "name": "budget_balances",
     "type": "integer",
     "api": "accounting:BudgetLine.BudgetBalances"
    },
    {
     "name": "period",
     "type": "text",
     "api": "accounting:BudgetBalance.Period"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "accounting:BudgetBalance.Amount"
    },
    {
     "name": "unit_amount",
     "type": "numeric",
     "api": "accounting:BudgetBalance.UnitAmount"
    },
    {
     "name": "notes",
     "type": "text",
     "api": "accounting:BudgetBalance.Notes"
    }
   ]
  },
  "xero_budget_lines": {
   "id": "xero_budget_lines",
   "primaryKey": [
    "budget_id",
    "account_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:BudgetLine"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Budgets/{BudgetID}",
    "envelope": "Budgets",
    "arrayKey": "Budgets",
    "explodePath": "Budget.BudgetLines",
    "explodeChain": [
     "Budget",
     "BudgetLine"
    ],
    "parentTable": "xero_budgets",
    "fanOutParam": "BudgetID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.budgets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "budget_id",
     "type": "text",
     "api": "accounting:Budget.BudgetID"
    },
    {
     "name": "account_id",
     "type": "text",
     "api": "accounting:BudgetLine.AccountID"
    },
    {
     "name": "account_code",
     "type": "text",
     "api": "accounting:BudgetLine.AccountCode"
    },
    {
     "name": "budget_lines",
     "type": "integer",
     "api": "accounting:Budget.BudgetLines"
    }
   ]
  },
  "xero_budget_tracking": {
   "id": "xero_budget_tracking",
   "primaryKey": [
    "budget_id",
    "tracking_category_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:TrackingCategory"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Budgets",
    "envelope": "Budgets",
    "arrayKey": "Budgets",
    "explodePath": "Budget.Tracking",
    "explodeChain": [
     "Budget",
     "TrackingCategory"
    ],
    "parentTable": "xero_budgets",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.budgets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "budget_id",
     "type": "text",
     "api": "accounting:Budget.BudgetID"
    },
    {
     "name": "tracking",
     "type": "integer",
     "api": "accounting:Budget.Tracking"
    },
    {
     "name": "tracking_category_id",
     "type": "text",
     "api": "accounting:TrackingCategory.TrackingCategoryID"
    },
    {
     "name": "tracking_option_id",
     "type": "text",
     "api": "accounting:TrackingCategory.TrackingOptionID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:TrackingCategory.Name"
    },
    {
     "name": "option",
     "type": "text",
     "api": "accounting:TrackingCategory.Option"
    }
   ]
  },
  "xero_budgets": {
   "id": "xero_budgets",
   "primaryKey": [
    "budget_id"
   ],
   "recordIdField": "BudgetID",
   "sourceObjects": [
    "accounting:Budget"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Budgets",
    "envelope": "Budgets",
    "arrayKey": "Budgets",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "accounting.budgets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "budget_id",
     "type": "text",
     "api": "accounting:Budget.BudgetID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "accounting:Budget.Type"
    },
    {
     "name": "description",
     "type": "text",
     "api": "accounting:Budget.Description"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Budget.UpdatedDateUTC"
    }
   ]
  },
  "xero_connections": {
   "id": "xero_connections",
   "primaryKey": [
    "id"
   ],
   "recordIdField": "id",
   "sourceObjects": [
    "identity:Connection"
   ],
   "source": {
    "api": "identity",
    "endpointOp": "GET /Connections",
    "envelope": "Connection",
    "arrayKey": null,
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": "updatedDateUtc",
    "whereFilterable": false,
    "scopes": [],
    "availability": "required"
   },
   "columns": [
    {
     "name": "id",
     "type": "text",
     "api": "identity:Connection.id"
    },
    {
     "name": "connection_tenant_id",
     "type": "text",
     "api": "identity:Connection.tenantId"
    },
    {
     "name": "auth_event_id",
     "type": "text",
     "api": "identity:Connection.authEventId"
    },
    {
     "name": "tenant_type",
     "type": "text",
     "api": "identity:Connection.tenantType"
    },
    {
     "name": "tenant_name",
     "type": "text",
     "api": "identity:Connection.tenantName"
    },
    {
     "name": "created_date_utc",
     "type": "timestamp",
     "api": "identity:Connection.createdDateUtc"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "identity:Connection.updatedDateUtc"
    }
   ]
  },
  "xero_contact_addresses": {
   "id": "xero_contact_addresses",
   "primaryKey": [
    "contact_id",
    "address_type"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:Address"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Contacts",
    "envelope": "Contacts",
    "arrayKey": "Contacts",
    "explodePath": "Contact.Addresses",
    "explodeChain": [
     "Contact",
     "Address"
    ],
    "parentTable": "xero_contacts",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.contacts",
     "accounting.contacts.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "contact_id",
     "type": "text",
     "api": "accounting:Contact.ContactID"
    },
    {
     "name": "address_type",
     "type": "text",
     "api": "accounting:Address.AddressType"
    },
    {
     "name": "address_line1",
     "type": "text",
     "api": "accounting:Address.AddressLine1"
    },
    {
     "name": "address_line2",
     "type": "text",
     "api": "accounting:Address.AddressLine2"
    },
    {
     "name": "address_line3",
     "type": "text",
     "api": "accounting:Address.AddressLine3"
    },
    {
     "name": "address_line4",
     "type": "text",
     "api": "accounting:Address.AddressLine4"
    },
    {
     "name": "city",
     "type": "text",
     "api": "accounting:Address.City"
    },
    {
     "name": "region",
     "type": "text",
     "api": "accounting:Address.Region"
    },
    {
     "name": "postal_code",
     "type": "text",
     "api": "accounting:Address.PostalCode"
    },
    {
     "name": "country",
     "type": "text",
     "api": "accounting:Address.Country"
    },
    {
     "name": "attention_to",
     "type": "text",
     "api": "accounting:Address.AttentionTo"
    }
   ]
  },
  "xero_contact_balances": {
   "id": "xero_contact_balances",
   "primaryKey": [
    "contact_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:Balances",
    "accounting:AccountsReceivable",
    "accounting:AccountsPayable"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Contacts",
    "envelope": "Contacts",
    "arrayKey": "Contacts",
    "explodePath": "Contact.Balances",
    "explodeChain": [
     "Contact",
     "Balances"
    ],
    "parentTable": "xero_contacts",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.contacts",
     "accounting.contacts.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "contact_id",
     "type": "text",
     "api": "accounting:Contact.ContactID"
    },
    {
     "name": "accounts_receivable_outstanding",
     "type": "numeric",
     "api": "accounting:Balances.AccountsReceivable.Outstanding"
    },
    {
     "name": "accounts_receivable_overdue",
     "type": "numeric",
     "api": "accounting:Balances.AccountsReceivable.Overdue"
    },
    {
     "name": "accounts_payable_outstanding",
     "type": "numeric",
     "api": "accounting:Balances.AccountsPayable.Outstanding"
    },
    {
     "name": "accounts_payable_overdue",
     "type": "numeric",
     "api": "accounting:Balances.AccountsPayable.Overdue"
    }
   ]
  },
  "xero_contact_cis_settings": {
   "id": "xero_contact_cis_settings",
   "primaryKey": [
    "contact_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:CISSetting"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Contacts/{ContactID}/CISSettings",
    "envelope": "CISSettings",
    "arrayKey": "CISSettings",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_contacts",
    "fanOutParam": "ContactID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.settings",
     "accounting.settings.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "contact_id",
     "type": "text",
     "api": "accounting:Contact.ContactID"
    },
    {
     "name": "cis_enabled",
     "type": "boolean",
     "api": "accounting:CISSetting.CISEnabled"
    },
    {
     "name": "rate",
     "type": "numeric",
     "api": "accounting:CISSetting.Rate"
    }
   ]
  },
  "xero_contact_group_members": {
   "id": "xero_contact_group_members",
   "primaryKey": [
    "contact_group_id",
    "contact_id"
   ],
   "recordIdField": "ContactID",
   "sourceObjects": [
    "accounting:Contact",
    "accounting:ContactGroup"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /ContactGroups/{ContactGroupID}",
    "envelope": "ContactGroups",
    "arrayKey": "ContactGroups",
    "explodePath": "ContactGroup.Contacts",
    "explodeChain": [
     "ContactGroup",
     "Contact"
    ],
    "parentTable": "xero_contact_groups",
    "fanOutParam": "ContactGroupID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.contacts",
     "accounting.contacts.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "contact_group_id",
     "type": "text",
     "api": "accounting:ContactGroup.ContactGroupID"
    },
    {
     "name": "contact_id",
     "type": "text",
     "api": "accounting:Contact.ContactID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:Contact.Name"
    }
   ]
  },
  "xero_contact_groups": {
   "id": "xero_contact_groups",
   "primaryKey": [
    "contact_group_id"
   ],
   "recordIdField": "ContactGroupID",
   "sourceObjects": [
    "accounting:ContactGroup"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /ContactGroups",
    "envelope": "ContactGroups",
    "arrayKey": "ContactGroups",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.contacts",
     "accounting.contacts.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "contact_group_id",
     "type": "text",
     "api": "accounting:ContactGroup.ContactGroupID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:ContactGroup.Name"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:ContactGroup.Status"
    },
    {
     "name": "contacts",
     "type": "jsonb",
     "api": "accounting:ContactGroup.Contacts"
    }
   ]
  },
  "xero_contact_persons": {
   "id": "xero_contact_persons",
   "primaryKey": [
    "contact_id",
    "person_ordinal"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:ContactPerson"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Contacts",
    "envelope": "Contacts",
    "arrayKey": "Contacts",
    "explodePath": "Contact.ContactPersons",
    "explodeChain": [
     "Contact",
     "ContactPerson"
    ],
    "parentTable": "xero_contacts",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.contacts",
     "accounting.contacts.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "contact_id",
     "type": "text",
     "api": "accounting:Contact.ContactID"
    },
    {
     "name": "person_ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position in Contact.ContactPersons"
    },
    {
     "name": "first_name",
     "type": "text",
     "api": "accounting:ContactPerson.FirstName"
    },
    {
     "name": "last_name",
     "type": "text",
     "api": "accounting:ContactPerson.LastName"
    },
    {
     "name": "email_address",
     "type": "text",
     "api": "accounting:ContactPerson.EmailAddress"
    },
    {
     "name": "include_in_emails",
     "type": "boolean",
     "api": "accounting:ContactPerson.IncludeInEmails"
    }
   ]
  },
  "xero_contact_phones": {
   "id": "xero_contact_phones",
   "primaryKey": [
    "contact_id",
    "phone_type"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:Phone"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Contacts",
    "envelope": "Contacts",
    "arrayKey": "Contacts",
    "explodePath": "Contact.Phones",
    "explodeChain": [
     "Contact",
     "Phone"
    ],
    "parentTable": "xero_contacts",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.contacts",
     "accounting.contacts.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "contact_id",
     "type": "text",
     "api": "accounting:Contact.ContactID"
    },
    {
     "name": "phone_type",
     "type": "text",
     "api": "accounting:Phone.PhoneType"
    },
    {
     "name": "phone_number",
     "type": "text",
     "api": "accounting:Phone.PhoneNumber"
    },
    {
     "name": "phone_area_code",
     "type": "text",
     "api": "accounting:Phone.PhoneAreaCode"
    },
    {
     "name": "phone_country_code",
     "type": "text",
     "api": "accounting:Phone.PhoneCountryCode"
    }
   ]
  },
  "xero_contacts": {
   "id": "xero_contacts",
   "primaryKey": [
    "contact_id"
   ],
   "recordIdField": "ContactID",
   "sourceObjects": [
    "accounting:Contact"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Contacts",
    "envelope": "Contacts",
    "arrayKey": "Contacts",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.contacts",
     "accounting.contacts.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "contact_id",
     "type": "text",
     "api": "accounting:Contact.ContactID"
    },
    {
     "name": "merged_to_contact_id",
     "type": "text",
     "api": "accounting:Contact.MergedToContactID"
    },
    {
     "name": "contact_number",
     "type": "text",
     "api": "accounting:Contact.ContactNumber"
    },
    {
     "name": "account_number",
     "type": "text",
     "api": "accounting:Contact.AccountNumber"
    },
    {
     "name": "contact_status",
     "type": "text",
     "api": "accounting:Contact.ContactStatus"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:Contact.Name"
    },
    {
     "name": "first_name",
     "type": "text",
     "api": "accounting:Contact.FirstName"
    },
    {
     "name": "last_name",
     "type": "text",
     "api": "accounting:Contact.LastName"
    },
    {
     "name": "company_number",
     "type": "text",
     "api": "accounting:Contact.CompanyNumber"
    },
    {
     "name": "email_address",
     "type": "text",
     "api": "accounting:Contact.EmailAddress"
    },
    {
     "name": "bank_account_details",
     "type": "text",
     "api": "accounting:Contact.BankAccountDetails"
    },
    {
     "name": "tax_number",
     "type": "text",
     "api": "accounting:Contact.TaxNumber"
    },
    {
     "name": "tax_number_type",
     "type": "text",
     "api": "accounting:Contact.TaxNumberType"
    },
    {
     "name": "accounts_receivable_tax_type",
     "type": "text",
     "api": "accounting:Contact.AccountsReceivableTaxType"
    },
    {
     "name": "accounts_payable_tax_type",
     "type": "text",
     "api": "accounting:Contact.AccountsPayableTaxType"
    },
    {
     "name": "is_supplier",
     "type": "boolean",
     "api": "accounting:Contact.IsSupplier"
    },
    {
     "name": "is_customer",
     "type": "boolean",
     "api": "accounting:Contact.IsCustomer"
    },
    {
     "name": "sales_default_line_amount_type",
     "type": "text",
     "api": "accounting:Contact.SalesDefaultLineAmountType"
    },
    {
     "name": "purchases_default_line_amount_type",
     "type": "text",
     "api": "accounting:Contact.PurchasesDefaultLineAmountType"
    },
    {
     "name": "default_currency",
     "type": "text",
     "api": "accounting:Contact.DefaultCurrency"
    },
    {
     "name": "xero_network_key",
     "type": "text",
     "api": "accounting:Contact.XeroNetworkKey"
    },
    {
     "name": "sales_default_account_code",
     "type": "text",
     "api": "accounting:Contact.SalesDefaultAccountCode"
    },
    {
     "name": "purchases_default_account_code",
     "type": "text",
     "api": "accounting:Contact.PurchasesDefaultAccountCode"
    },
    {
     "name": "sales_tracking_categories",
     "type": "jsonb",
     "api": "accounting:Contact.SalesTrackingCategories"
    },
    {
     "name": "purchases_tracking_categories",
     "type": "jsonb",
     "api": "accounting:Contact.PurchasesTrackingCategories"
    },
    {
     "name": "tracking_category_name",
     "type": "text",
     "api": "accounting:Contact.TrackingCategoryName"
    },
    {
     "name": "tracking_category_option",
     "type": "text",
     "api": "accounting:Contact.TrackingCategoryOption"
    },
    {
     "name": "payment_terms",
     "type": "jsonb",
     "api": "accounting:Contact.PaymentTerms"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Contact.UpdatedDateUTC"
    },
    {
     "name": "contact_groups",
     "type": "jsonb",
     "api": "accounting:Contact.ContactGroups"
    },
    {
     "name": "website",
     "type": "text",
     "api": "accounting:Contact.Website"
    },
    {
     "name": "branding_theme_branding_theme_id",
     "type": "text",
     "api": "accounting:Contact.BrandingTheme.BrandingThemeID"
    },
    {
     "name": "batch_payments",
     "type": "jsonb",
     "api": "accounting:Contact.BatchPayments"
    },
    {
     "name": "balances",
     "type": "jsonb",
     "api": "accounting:Contact.Balances"
    },
    {
     "name": "discount",
     "type": "numeric",
     "api": "accounting:Contact.Discount"
    },
    {
     "name": "attachments",
     "type": "jsonb",
     "api": "accounting:Contact.Attachments"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:Contact.HasAttachments"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:Contact.ValidationErrors"
    },
    {
     "name": "has_validation_errors",
     "type": "boolean",
     "api": "accounting:Contact.HasValidationErrors"
    },
    {
     "name": "status_attribute_string",
     "type": "text",
     "api": "accounting:Contact.StatusAttributeString"
    },
    {
     "name": "addresses",
     "type": "jsonb",
     "api": "accounting:Contact.Addresses"
    },
    {
     "name": "phones",
     "type": "jsonb",
     "api": "accounting:Contact.Phones"
    },
    {
     "name": "contact_persons",
     "type": "jsonb",
     "api": "accounting:Contact.ContactPersons"
    },
    {
     "name": "branding_theme",
     "type": "jsonb",
     "api": "accounting:Contact.BrandingTheme"
    }
   ]
  },
  "xero_credit_note_allocations": {
   "id": "xero_credit_note_allocations",
   "primaryKey": [
    "credit_note_id",
    "allocations"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:CreditNote",
    "accounting:Allocation"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /CreditNotes",
    "envelope": "CreditNotes",
    "arrayKey": "CreditNotes",
    "explodePath": "CreditNote.Allocations",
    "explodeChain": [
     "CreditNote",
     "Allocation"
    ],
    "parentTable": "xero_credit_notes",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "credit_note_id",
     "type": "text",
     "api": "accounting:CreditNote.CreditNoteID"
    },
    {
     "name": "allocations",
     "type": "integer",
     "api": "accounting:CreditNote.Allocations"
    },
    {
     "name": "allocations_invoice_invoice_id",
     "type": "text",
     "api": "accounting:CreditNote.Allocations.Invoice.InvoiceID"
    },
    {
     "name": "allocations_amount",
     "type": "numeric",
     "api": "accounting:CreditNote.Allocations.Amount"
    },
    {
     "name": "allocations_date",
     "type": "date",
     "api": "accounting:CreditNote.Allocations.Date"
    }
   ]
  },
  "xero_credit_note_line_items": {
   "id": "xero_credit_note_line_items",
   "primaryKey": [
    "line_items_line_item_id"
   ],
   "recordIdField": "LineItemID",
   "sourceObjects": [
    "accounting:CreditNote",
    "accounting:LineItem",
    "accounting:LineItemItem",
    "accounting:LineItemTracking",
    "accounting:TaxBreakdownComponent"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /CreditNotes",
    "envelope": "CreditNotes",
    "arrayKey": "CreditNotes",
    "explodePath": "CreditNote.LineItems",
    "explodeChain": [
     "CreditNote",
     "LineItem"
    ],
    "parentTable": "xero_credit_notes",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "line_items_line_item_id",
     "type": "text",
     "api": "accounting:CreditNote.LineItems.LineItemID"
    },
    {
     "name": "credit_note_id",
     "type": "text",
     "api": "accounting:CreditNote.CreditNoteID"
    },
    {
     "name": "line_items",
     "type": "integer",
     "api": "accounting:CreditNote.LineItems"
    },
    {
     "name": "line_items_description",
     "type": "text",
     "api": "accounting:CreditNote.LineItems.Description"
    },
    {
     "name": "line_items_quantity",
     "type": "numeric",
     "api": "accounting:CreditNote.LineItems.Quantity"
    },
    {
     "name": "line_items_unit_amount",
     "type": "numeric",
     "api": "accounting:CreditNote.LineItems.UnitAmount"
    },
    {
     "name": "line_items_line_amount",
     "type": "numeric",
     "api": "accounting:CreditNote.LineItems.LineAmount"
    },
    {
     "name": "line_items_tax_type",
     "type": "text",
     "api": "accounting:CreditNote.LineItems.TaxType"
    },
    {
     "name": "line_items_tax_amount",
     "type": "numeric",
     "api": "accounting:CreditNote.LineItems.TaxAmount"
    },
    {
     "name": "line_items_account_code",
     "type": "text",
     "api": "accounting:CreditNote.LineItems.AccountCode"
    },
    {
     "name": "line_items_account_id",
     "type": "text",
     "api": "accounting:CreditNote.LineItems.AccountID"
    },
    {
     "name": "line_items_item_code",
     "type": "text",
     "api": "accounting:CreditNote.LineItems.ItemCode"
    },
    {
     "name": "line_items_item_item_id",
     "type": "text",
     "api": "accounting:CreditNote.LineItems.Item.ItemID"
    },
    {
     "name": "line_items_item",
     "type": "jsonb",
     "api": "accounting:CreditNote.LineItems.Item"
    },
    {
     "name": "line_items_tracking",
     "type": "jsonb",
     "api": "accounting:CreditNote.LineItems.Tracking"
    },
    {
     "name": "line_items_discount_rate",
     "type": "numeric",
     "api": "accounting:CreditNote.LineItems.DiscountRate"
    },
    {
     "name": "line_items_discount_amount",
     "type": "numeric",
     "api": "accounting:CreditNote.LineItems.DiscountAmount"
    },
    {
     "name": "line_items_repeating_invoice_id",
     "type": "text",
     "api": "accounting:CreditNote.LineItems.RepeatingInvoiceID"
    },
    {
     "name": "line_items_taxability",
     "type": "text",
     "api": "accounting:CreditNote.LineItems.Taxability"
    },
    {
     "name": "line_items_sales_tax_code_id",
     "type": "numeric",
     "api": "accounting:CreditNote.LineItems.SalesTaxCodeId"
    },
    {
     "name": "line_items_tax_breakdown",
     "type": "jsonb",
     "api": "accounting:CreditNote.LineItems.TaxBreakdown"
    }
   ]
  },
  "xero_credit_notes": {
   "id": "xero_credit_notes",
   "primaryKey": [
    "credit_note_id"
   ],
   "recordIdField": "CreditNoteID",
   "sourceObjects": [
    "accounting:CreditNote"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /CreditNotes",
    "envelope": "CreditNotes",
    "arrayKey": "CreditNotes",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "credit_note_id",
     "type": "text",
     "api": "accounting:CreditNote.CreditNoteID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "accounting:CreditNote.Type"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:CreditNote.Status"
    },
    {
     "name": "contact_contact_id",
     "type": "text",
     "api": "accounting:CreditNote.Contact.ContactID"
    },
    {
     "name": "contact_name",
     "type": "text",
     "api": "accounting:CreditNote.Contact.Name"
    },
    {
     "name": "credit_note_number",
     "type": "text",
     "api": "accounting:CreditNote.CreditNoteNumber"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:CreditNote.Reference"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:CreditNote.Date"
    },
    {
     "name": "due_date",
     "type": "date",
     "api": "accounting:CreditNote.DueDate"
    },
    {
     "name": "line_amount_types",
     "type": "text",
     "api": "accounting:CreditNote.LineAmountTypes"
    },
    {
     "name": "currency_code",
     "type": "text",
     "api": "accounting:CreditNote.CurrencyCode"
    },
    {
     "name": "currency_rate",
     "type": "numeric",
     "api": "accounting:CreditNote.CurrencyRate"
    },
    {
     "name": "sub_total",
     "type": "numeric",
     "api": "accounting:CreditNote.SubTotal"
    },
    {
     "name": "total_tax",
     "type": "numeric",
     "api": "accounting:CreditNote.TotalTax"
    },
    {
     "name": "total",
     "type": "numeric",
     "api": "accounting:CreditNote.Total"
    },
    {
     "name": "remaining_credit",
     "type": "numeric",
     "api": "accounting:CreditNote.RemainingCredit"
    },
    {
     "name": "applied_amount",
     "type": "numeric",
     "api": "accounting:CreditNote.AppliedAmount"
    },
    {
     "name": "fully_paid_on_date",
     "type": "date",
     "api": "accounting:CreditNote.FullyPaidOnDate"
    },
    {
     "name": "cis_deduction",
     "type": "numeric",
     "api": "accounting:CreditNote.CISDeduction"
    },
    {
     "name": "cis_rate",
     "type": "numeric",
     "api": "accounting:CreditNote.CISRate"
    },
    {
     "name": "sent_to_contact",
     "type": "boolean",
     "api": "accounting:CreditNote.SentToContact"
    },
    {
     "name": "branding_theme_id",
     "type": "text",
     "api": "accounting:CreditNote.BrandingThemeID"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:CreditNote.HasAttachments"
    },
    {
     "name": "has_errors",
     "type": "boolean",
     "api": "accounting:CreditNote.HasErrors"
    },
    {
     "name": "status_attribute_string",
     "type": "text",
     "api": "accounting:CreditNote.StatusAttributeString"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:CreditNote.UpdatedDateUTC"
    },
    {
     "name": "updated_date_utc_string",
     "type": "text",
     "api": "accounting:CreditNote.UpdatedDateUTCString"
    },
    {
     "name": "payments",
     "type": "jsonb",
     "api": "accounting:CreditNote.Payments"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:CreditNote.ValidationErrors"
    },
    {
     "name": "warnings",
     "type": "jsonb",
     "api": "accounting:CreditNote.Warnings"
    },
    {
     "name": "invoice_addresses",
     "type": "jsonb",
     "api": "accounting:CreditNote.InvoiceAddresses"
    },
    {
     "name": "contact",
     "type": "jsonb",
     "api": "accounting:CreditNote.Contact"
    },
    {
     "name": "line_items",
     "type": "jsonb",
     "api": "accounting:CreditNote.LineItems"
    },
    {
     "name": "allocations",
     "type": "jsonb",
     "api": "accounting:CreditNote.Allocations"
    }
   ]
  },
  "xero_currencies": {
   "id": "xero_currencies",
   "primaryKey": [
    "code"
   ],
   "recordIdField": "Code",
   "sourceObjects": [
    "accounting:Currency"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Currencies",
    "envelope": "Currencies",
    "arrayKey": "Currencies",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.settings",
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "code",
     "type": "text",
     "api": "accounting:Currency.Code"
    },
    {
     "name": "description",
     "type": "text",
     "api": "accounting:Currency.Description"
    }
   ]
  },
  "xero_expense_claim_payments": {
   "id": "xero_expense_claim_payments",
   "primaryKey": [
    "payment_id"
   ],
   "recordIdField": "PaymentID",
   "sourceObjects": [
    "accounting:Payment",
    "accounting:ExpenseClaim"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /ExpenseClaims",
    "envelope": "ExpenseClaims",
    "arrayKey": "ExpenseClaims",
    "explodePath": "ExpenseClaim.Payments",
    "explodeChain": [
     "ExpenseClaim",
     "Payment"
    ],
    "parentTable": "xero_expense_claims",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payment_id",
     "type": "text",
     "api": "accounting:Payment.PaymentID"
    },
    {
     "name": "expense_claim_id",
     "type": "text",
     "api": "accounting:ExpenseClaim.ExpenseClaimID"
    },
    {
     "name": "payment_ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position of the payment in ExpenseClaim.Payments"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:Payment.Date"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "accounting:Payment.Amount"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:Payment.Reference"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:Payment.Status"
    },
    {
     "name": "payment_type",
     "type": "text",
     "api": "accounting:Payment.PaymentType"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Payment.UpdatedDateUTC"
    }
   ]
  },
  "xero_expense_claim_receipts": {
   "id": "xero_expense_claim_receipts",
   "primaryKey": [
    "expense_claim_id",
    "receipt_id"
   ],
   "recordIdField": "ReceiptID",
   "sourceObjects": [
    "accounting:Receipt",
    "accounting:ExpenseClaim"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /ExpenseClaims",
    "envelope": "ExpenseClaims",
    "arrayKey": "ExpenseClaims",
    "explodePath": "ExpenseClaim.Receipts",
    "explodeChain": [
     "ExpenseClaim",
     "Receipt"
    ],
    "parentTable": "xero_expense_claims",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "expense_claim_id",
     "type": "text",
     "api": "accounting:ExpenseClaim.ExpenseClaimID"
    },
    {
     "name": "receipt_id",
     "type": "text",
     "api": "accounting:Receipt.ReceiptID"
    },
    {
     "name": "receipt_ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position of the receipt in ExpenseClaim.Receipts"
    }
   ]
  },
  "xero_expense_claims": {
   "id": "xero_expense_claims",
   "primaryKey": [
    "expense_claim_id"
   ],
   "recordIdField": "ExpenseClaimID",
   "sourceObjects": [
    "accounting:ExpenseClaim"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /ExpenseClaims",
    "envelope": "ExpenseClaims",
    "arrayKey": "ExpenseClaims",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "expense_claim_id",
     "type": "text",
     "api": "accounting:ExpenseClaim.ExpenseClaimID"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:ExpenseClaim.Status"
    },
    {
     "name": "user_user_id",
     "type": "text",
     "api": "accounting:ExpenseClaim.User.UserID"
    },
    {
     "name": "total",
     "type": "numeric",
     "api": "accounting:ExpenseClaim.Total"
    },
    {
     "name": "amount_due",
     "type": "numeric",
     "api": "accounting:ExpenseClaim.AmountDue"
    },
    {
     "name": "amount_paid",
     "type": "numeric",
     "api": "accounting:ExpenseClaim.AmountPaid"
    },
    {
     "name": "payment_due_date",
     "type": "date",
     "api": "accounting:ExpenseClaim.PaymentDueDate"
    },
    {
     "name": "reporting_date",
     "type": "date",
     "api": "accounting:ExpenseClaim.ReportingDate"
    },
    {
     "name": "receipt_id",
     "type": "text",
     "api": "accounting:ExpenseClaim.ReceiptID"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:ExpenseClaim.UpdatedDateUTC"
    },
    {
     "name": "receipts",
     "type": "jsonb",
     "api": "accounting:ExpenseClaim.Receipts"
    },
    {
     "name": "payments",
     "type": "jsonb",
     "api": "accounting:ExpenseClaim.Payments"
    }
   ]
  },
  "xero_file_associations": {
   "id": "xero_file_associations",
   "primaryKey": [
    "file_id",
    "object_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "files:Association"
   ],
   "source": {
    "api": "files",
    "endpointOp": "GET /Files/{FileId}/Associations",
    "envelope": "Association",
    "arrayKey": null,
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_files",
    "fanOutParam": "FileId",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "files.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "file_id",
     "type": "text",
     "api": "files:Association.FileId"
    },
    {
     "name": "object_id",
     "type": "text",
     "api": "files:Association.ObjectId"
    },
    {
     "name": "object_group",
     "type": "text",
     "api": "files:Association.ObjectGroup"
    },
    {
     "name": "object_type",
     "type": "text",
     "api": "files:Association.ObjectType"
    },
    {
     "name": "send_with_object",
     "type": "boolean",
     "api": "files:Association.SendWithObject"
    },
    {
     "name": "name",
     "type": "text",
     "api": "files:Association.Name"
    },
    {
     "name": "size",
     "type": "bigint",
     "api": "files:Association.Size"
    },
    {
     "name": "created_date_utc",
     "type": "timestamp",
     "api": "files:Association.CreatedDateUtc"
    },
    {
     "name": "association_date_utc",
     "type": "timestamp",
     "api": "files:Association.AssociationDateUtc"
    }
   ]
  },
  "xero_files": {
   "id": "xero_files",
   "primaryKey": [
    "id"
   ],
   "recordIdField": "Id",
   "sourceObjects": [
    "files:FileObject",
    "files:User"
   ],
   "source": {
    "api": "files",
    "endpointOp": "GET /Files",
    "envelope": "Files",
    "arrayKey": "Items",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUtc",
    "whereFilterable": false,
    "scopes": [
     "files.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "id",
     "type": "text",
     "api": "files:FileObject.Id"
    },
    {
     "name": "folder_id",
     "type": "text",
     "api": "files:FileObject.FolderId"
    },
    {
     "name": "name",
     "type": "text",
     "api": "files:FileObject.Name"
    },
    {
     "name": "mime_type",
     "type": "text",
     "api": "files:FileObject.MimeType"
    },
    {
     "name": "size",
     "type": "bigint",
     "api": "files:FileObject.Size"
    },
    {
     "name": "created_date_utc",
     "type": "timestamp",
     "api": "files:FileObject.CreatedDateUtc"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "files:FileObject.UpdatedDateUtc"
    },
    {
     "name": "user_id",
     "type": "text",
     "api": "files:FileObject.User.Id"
    },
    {
     "name": "user_name",
     "type": "text",
     "api": "files:FileObject.User.Name"
    },
    {
     "name": "user_first_name",
     "type": "text",
     "api": "files:FileObject.User.FirstName"
    },
    {
     "name": "user_last_name",
     "type": "text",
     "api": "files:FileObject.User.LastName"
    },
    {
     "name": "user_full_name",
     "type": "text",
     "api": "files:FileObject.User.FullName"
    }
   ]
  },
  "xero_folders": {
   "id": "xero_folders",
   "primaryKey": [
    "id"
   ],
   "recordIdField": "Id",
   "sourceObjects": [
    "files:Folder"
   ],
   "source": {
    "api": "files",
    "endpointOp": "GET /Folders",
    "envelope": "Folder",
    "arrayKey": null,
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "files.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "id",
     "type": "text",
     "api": "files:Folder.Id"
    },
    {
     "name": "name",
     "type": "text",
     "api": "files:Folder.Name"
    },
    {
     "name": "file_count",
     "type": "integer",
     "api": "files:Folder.FileCount"
    },
    {
     "name": "email",
     "type": "text",
     "api": "files:Folder.Email"
    },
    {
     "name": "is_inbox",
     "type": "boolean",
     "api": "files:Folder.IsInbox"
    }
   ]
  },
  "xero_history_records": {
   "id": "xero_history_records",
   "primaryKey": [
    "parent_endpoint",
    "parent_id",
    "ordinal"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:HistoryRecord"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /{Endpoint}/{Guid}/History",
    "envelope": "HistoryRecords",
    "arrayKey": "HistoryRecords",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": "Guid",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "parent_endpoint",
     "type": "text",
     "api": "synthetic:the {Endpoint} segment of the fan-out path — which Xero collection the parent record lives in (e.g. 'Invoices', 'Payments', 'Contacts')"
    },
    {
     "name": "parent_id",
     "type": "text",
     "api": "synthetic:the {Guid} segment of the fan-out path — the parent record's vendor UUID"
    },
    {
     "name": "ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position in the HistoryRecords array at sync time (Xero returns newest first)"
    },
    {
     "name": "details",
     "type": "text",
     "api": "accounting:HistoryRecord.Details"
    },
    {
     "name": "changes",
     "type": "text",
     "api": "accounting:HistoryRecord.Changes"
    },
    {
     "name": "user",
     "type": "text",
     "api": "accounting:HistoryRecord.User"
    },
    {
     "name": "date_utc",
     "type": "timestamp",
     "api": "accounting:HistoryRecord.DateUTC"
    }
   ]
  },
  "xero_invoice_line_items": {
   "id": "xero_invoice_line_items",
   "primaryKey": [
    "line_items_line_item_id"
   ],
   "recordIdField": "LineItemID",
   "sourceObjects": [
    "accounting:Invoice",
    "accounting:LineItem",
    "accounting:LineItemItem",
    "accounting:LineItemTracking",
    "accounting:TaxBreakdownComponent"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Invoices",
    "envelope": "Invoices",
    "arrayKey": "Invoices",
    "explodePath": "Invoice.LineItems",
    "explodeChain": [
     "Invoice",
     "LineItem"
    ],
    "parentTable": "xero_invoices",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "line_items_line_item_id",
     "type": "text",
     "api": "accounting:Invoice.LineItems.LineItemID"
    },
    {
     "name": "invoice_id",
     "type": "text",
     "api": "accounting:Invoice.InvoiceID"
    },
    {
     "name": "line_items",
     "type": "integer",
     "api": "accounting:Invoice.LineItems"
    },
    {
     "name": "line_items_description",
     "type": "text",
     "api": "accounting:Invoice.LineItems.Description"
    },
    {
     "name": "line_items_quantity",
     "type": "numeric",
     "api": "accounting:Invoice.LineItems.Quantity"
    },
    {
     "name": "line_items_unit_amount",
     "type": "numeric",
     "api": "accounting:Invoice.LineItems.UnitAmount"
    },
    {
     "name": "line_items_line_amount",
     "type": "numeric",
     "api": "accounting:Invoice.LineItems.LineAmount"
    },
    {
     "name": "line_items_tax_type",
     "type": "text",
     "api": "accounting:Invoice.LineItems.TaxType"
    },
    {
     "name": "line_items_tax_amount",
     "type": "numeric",
     "api": "accounting:Invoice.LineItems.TaxAmount"
    },
    {
     "name": "line_items_account_code",
     "type": "text",
     "api": "accounting:Invoice.LineItems.AccountCode"
    },
    {
     "name": "line_items_account_id",
     "type": "text",
     "api": "accounting:Invoice.LineItems.AccountID"
    },
    {
     "name": "line_items_item_code",
     "type": "text",
     "api": "accounting:Invoice.LineItems.ItemCode"
    },
    {
     "name": "line_items_item_item_id",
     "type": "text",
     "api": "accounting:Invoice.LineItems.Item.ItemID"
    },
    {
     "name": "line_items_item",
     "type": "jsonb",
     "api": "accounting:Invoice.LineItems.Item"
    },
    {
     "name": "line_items_tracking",
     "type": "jsonb",
     "api": "accounting:Invoice.LineItems.Tracking"
    },
    {
     "name": "line_items_discount_rate",
     "type": "numeric",
     "api": "accounting:Invoice.LineItems.DiscountRate"
    },
    {
     "name": "line_items_discount_amount",
     "type": "numeric",
     "api": "accounting:Invoice.LineItems.DiscountAmount"
    },
    {
     "name": "line_items_repeating_invoice_id",
     "type": "text",
     "api": "accounting:Invoice.LineItems.RepeatingInvoiceID"
    },
    {
     "name": "line_items_taxability",
     "type": "text",
     "api": "accounting:Invoice.LineItems.Taxability"
    },
    {
     "name": "line_items_sales_tax_code_id",
     "type": "numeric",
     "api": "accounting:Invoice.LineItems.SalesTaxCodeId"
    },
    {
     "name": "line_items_tax_breakdown",
     "type": "jsonb",
     "api": "accounting:Invoice.LineItems.TaxBreakdown"
    }
   ]
  },
  "xero_invoice_reminders": {
   "id": "xero_invoice_reminders",
   "primaryKey": [
    "settings_key"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:InvoiceReminder"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /InvoiceReminders/Settings",
    "envelope": "InvoiceReminders",
    "arrayKey": "InvoiceReminders",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "settings_key",
     "type": "text",
     "api": "synthetic:constant 'invoice_reminders' — the endpoint returns a single org-level settings record with no vendor identifier"
    },
    {
     "name": "enabled",
     "type": "boolean",
     "api": "accounting:InvoiceReminder.Enabled"
    }
   ]
  },
  "xero_invoices": {
   "id": "xero_invoices",
   "primaryKey": [
    "invoice_id"
   ],
   "recordIdField": "InvoiceID",
   "sourceObjects": [
    "accounting:Invoice"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Invoices",
    "envelope": "Invoices",
    "arrayKey": "Invoices",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "invoice_id",
     "type": "text",
     "api": "accounting:Invoice.InvoiceID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "accounting:Invoice.Type"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:Invoice.Status"
    },
    {
     "name": "contact_contact_id",
     "type": "text",
     "api": "accounting:Invoice.Contact.ContactID"
    },
    {
     "name": "contact_name",
     "type": "text",
     "api": "accounting:Invoice.Contact.Name"
    },
    {
     "name": "invoice_number",
     "type": "text",
     "api": "accounting:Invoice.InvoiceNumber"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:Invoice.Reference"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:Invoice.Date"
    },
    {
     "name": "due_date",
     "type": "date",
     "api": "accounting:Invoice.DueDate"
    },
    {
     "name": "line_amount_types",
     "type": "text",
     "api": "accounting:Invoice.LineAmountTypes"
    },
    {
     "name": "currency_code",
     "type": "text",
     "api": "accounting:Invoice.CurrencyCode"
    },
    {
     "name": "currency_rate",
     "type": "numeric",
     "api": "accounting:Invoice.CurrencyRate"
    },
    {
     "name": "sub_total",
     "type": "numeric",
     "api": "accounting:Invoice.SubTotal"
    },
    {
     "name": "total_tax",
     "type": "numeric",
     "api": "accounting:Invoice.TotalTax"
    },
    {
     "name": "total",
     "type": "numeric",
     "api": "accounting:Invoice.Total"
    },
    {
     "name": "total_discount",
     "type": "numeric",
     "api": "accounting:Invoice.TotalDiscount"
    },
    {
     "name": "amount_due",
     "type": "numeric",
     "api": "accounting:Invoice.AmountDue"
    },
    {
     "name": "amount_paid",
     "type": "numeric",
     "api": "accounting:Invoice.AmountPaid"
    },
    {
     "name": "amount_credited",
     "type": "numeric",
     "api": "accounting:Invoice.AmountCredited"
    },
    {
     "name": "fully_paid_on_date",
     "type": "date",
     "api": "accounting:Invoice.FullyPaidOnDate"
    },
    {
     "name": "expected_payment_date",
     "type": "date",
     "api": "accounting:Invoice.ExpectedPaymentDate"
    },
    {
     "name": "planned_payment_date",
     "type": "date",
     "api": "accounting:Invoice.PlannedPaymentDate"
    },
    {
     "name": "sent_to_contact",
     "type": "boolean",
     "api": "accounting:Invoice.SentToContact"
    },
    {
     "name": "cis_deduction",
     "type": "numeric",
     "api": "accounting:Invoice.CISDeduction"
    },
    {
     "name": "cis_rate",
     "type": "numeric",
     "api": "accounting:Invoice.CISRate"
    },
    {
     "name": "is_discounted",
     "type": "boolean",
     "api": "accounting:Invoice.IsDiscounted"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:Invoice.HasAttachments"
    },
    {
     "name": "has_errors",
     "type": "boolean",
     "api": "accounting:Invoice.HasErrors"
    },
    {
     "name": "status_attribute_string",
     "type": "text",
     "api": "accounting:Invoice.StatusAttributeString"
    },
    {
     "name": "url",
     "type": "text",
     "api": "accounting:Invoice.Url"
    },
    {
     "name": "branding_theme_id",
     "type": "text",
     "api": "accounting:Invoice.BrandingThemeID"
    },
    {
     "name": "repeating_invoice_id",
     "type": "text",
     "api": "accounting:Invoice.RepeatingInvoiceID"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Invoice.UpdatedDateUTC"
    },
    {
     "name": "updated_date_utc_string",
     "type": "text",
     "api": "accounting:Invoice.UpdatedDateUTCString"
    },
    {
     "name": "payments",
     "type": "jsonb",
     "api": "accounting:Invoice.Payments"
    },
    {
     "name": "prepayments",
     "type": "jsonb",
     "api": "accounting:Invoice.Prepayments"
    },
    {
     "name": "overpayments",
     "type": "jsonb",
     "api": "accounting:Invoice.Overpayments"
    },
    {
     "name": "credit_notes",
     "type": "jsonb",
     "api": "accounting:Invoice.CreditNotes"
    },
    {
     "name": "attachments",
     "type": "jsonb",
     "api": "accounting:Invoice.Attachments"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:Invoice.ValidationErrors"
    },
    {
     "name": "warnings",
     "type": "jsonb",
     "api": "accounting:Invoice.Warnings"
    },
    {
     "name": "invoice_addresses",
     "type": "jsonb",
     "api": "accounting:Invoice.InvoiceAddresses"
    },
    {
     "name": "contact",
     "type": "jsonb",
     "api": "accounting:Invoice.Contact"
    },
    {
     "name": "line_items",
     "type": "jsonb",
     "api": "accounting:Invoice.LineItems"
    }
   ]
  },
  "xero_items": {
   "id": "xero_items",
   "primaryKey": [
    "item_id"
   ],
   "recordIdField": "ItemID",
   "sourceObjects": [
    "accounting:Item",
    "accounting:Purchase"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Items",
    "envelope": "Items",
    "arrayKey": "Items",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "item_id",
     "type": "text",
     "api": "accounting:Item.ItemID"
    },
    {
     "name": "code",
     "type": "text",
     "api": "accounting:Item.Code"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:Item.Name"
    },
    {
     "name": "description",
     "type": "text",
     "api": "accounting:Item.Description"
    },
    {
     "name": "purchase_description",
     "type": "text",
     "api": "accounting:Item.PurchaseDescription"
    },
    {
     "name": "is_sold",
     "type": "boolean",
     "api": "accounting:Item.IsSold"
    },
    {
     "name": "is_purchased",
     "type": "boolean",
     "api": "accounting:Item.IsPurchased"
    },
    {
     "name": "is_tracked_as_inventory",
     "type": "boolean",
     "api": "accounting:Item.IsTrackedAsInventory"
    },
    {
     "name": "inventory_asset_account_code",
     "type": "text",
     "api": "accounting:Item.InventoryAssetAccountCode"
    },
    {
     "name": "sales_details_unit_price",
     "type": "numeric",
     "api": "accounting:Item.SalesDetails.UnitPrice"
    },
    {
     "name": "sales_details_account_code",
     "type": "text",
     "api": "accounting:Item.SalesDetails.AccountCode"
    },
    {
     "name": "sales_details_tax_type",
     "type": "text",
     "api": "accounting:Item.SalesDetails.TaxType"
    },
    {
     "name": "purchase_details_unit_price",
     "type": "numeric",
     "api": "accounting:Item.PurchaseDetails.UnitPrice"
    },
    {
     "name": "purchase_details_account_code",
     "type": "text",
     "api": "accounting:Item.PurchaseDetails.AccountCode"
    },
    {
     "name": "purchase_details_cogs_account_code",
     "type": "text",
     "api": "accounting:Item.PurchaseDetails.COGSAccountCode"
    },
    {
     "name": "purchase_details_tax_type",
     "type": "text",
     "api": "accounting:Item.PurchaseDetails.TaxType"
    },
    {
     "name": "quantity_on_hand",
     "type": "numeric",
     "api": "accounting:Item.QuantityOnHand"
    },
    {
     "name": "total_cost_pool",
     "type": "numeric",
     "api": "accounting:Item.TotalCostPool"
    },
    {
     "name": "status_attribute_string",
     "type": "text",
     "api": "accounting:Item.StatusAttributeString"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Item.UpdatedDateUTC"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:Item.ValidationErrors"
    }
   ]
  },
  "xero_journal_line_tracking": {
   "id": "xero_journal_line_tracking",
   "primaryKey": [
    "journal_lines_journal_line_id",
    "tracking_category_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:TrackingReference",
    "accounting:TrackingCategory"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Journals",
    "envelope": "Journals",
    "arrayKey": "Journals",
    "explodePath": "Journal.JournalLines.TrackingCategories",
    "explodeChain": [
     "Journal",
     "JournalLine",
     "TrackingCategory"
    ],
    "parentTable": "xero_journal_lines",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.journals.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "journal_lines_journal_line_id",
     "type": "text",
     "api": "accounting:Journal.JournalLines.JournalLineID"
    },
    {
     "name": "journal_id",
     "type": "text",
     "api": "accounting:Journal.JournalID"
    },
    {
     "name": "journal_lines_tracking_categories",
     "type": "integer",
     "api": "accounting:Journal.JournalLines.TrackingCategories"
    },
    {
     "name": "tracking_category_id",
     "type": "text",
     "api": "accounting:TrackingReference.TrackingCategoryID"
    },
    {
     "name": "tracking_option_id",
     "type": "text",
     "api": "accounting:TrackingReference.TrackingOptionID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:TrackingReference.Name"
    },
    {
     "name": "option",
     "type": "text",
     "api": "accounting:TrackingReference.Option"
    }
   ]
  },
  "xero_journal_lines": {
   "id": "xero_journal_lines",
   "primaryKey": [
    "journal_line_id"
   ],
   "recordIdField": "JournalLineID",
   "sourceObjects": [
    "accounting:JournalLine"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Journals",
    "envelope": "Journals",
    "arrayKey": "Journals",
    "explodePath": "Journal.JournalLines",
    "explodeChain": [
     "Journal",
     "JournalLine"
    ],
    "parentTable": "xero_journals",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.journals.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "journal_line_id",
     "type": "text",
     "api": "accounting:JournalLine.JournalLineID"
    },
    {
     "name": "journal_id",
     "type": "text",
     "api": "accounting:Journal.JournalID"
    },
    {
     "name": "journal_lines",
     "type": "integer",
     "api": "accounting:Journal.JournalLines"
    },
    {
     "name": "account_id",
     "type": "text",
     "api": "accounting:JournalLine.AccountID"
    },
    {
     "name": "account_code",
     "type": "text",
     "api": "accounting:JournalLine.AccountCode"
    },
    {
     "name": "account_type",
     "type": "text",
     "api": "accounting:JournalLine.AccountType"
    },
    {
     "name": "account_name",
     "type": "text",
     "api": "accounting:JournalLine.AccountName"
    },
    {
     "name": "description",
     "type": "text",
     "api": "accounting:JournalLine.Description"
    },
    {
     "name": "net_amount",
     "type": "numeric",
     "api": "accounting:JournalLine.NetAmount"
    },
    {
     "name": "gross_amount",
     "type": "numeric",
     "api": "accounting:JournalLine.GrossAmount"
    },
    {
     "name": "tax_amount",
     "type": "numeric",
     "api": "accounting:JournalLine.TaxAmount"
    },
    {
     "name": "tax_type",
     "type": "text",
     "api": "accounting:JournalLine.TaxType"
    },
    {
     "name": "tax_name",
     "type": "text",
     "api": "accounting:JournalLine.TaxName"
    }
   ]
  },
  "xero_journals": {
   "id": "xero_journals",
   "primaryKey": [
    "journal_id"
   ],
   "recordIdField": "JournalID",
   "sourceObjects": [
    "accounting:Journal"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Journals",
    "envelope": "Journals",
    "arrayKey": "Journals",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "offset",
    "modifiedField": "CreatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "accounting.journals.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "journal_id",
     "type": "text",
     "api": "accounting:Journal.JournalID"
    },
    {
     "name": "journal_date",
     "type": "date",
     "api": "accounting:Journal.JournalDate"
    },
    {
     "name": "journal_number",
     "type": "integer",
     "api": "accounting:Journal.JournalNumber"
    },
    {
     "name": "created_date_utc",
     "type": "timestamp",
     "api": "accounting:Journal.CreatedDateUTC"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:Journal.Reference"
    },
    {
     "name": "source_id",
     "type": "text",
     "api": "accounting:Journal.SourceID"
    },
    {
     "name": "source_type",
     "type": "text",
     "api": "accounting:Journal.SourceType"
    },
    {
     "name": "journal_lines",
     "type": "jsonb",
     "api": "accounting:Journal.JournalLines"
    }
   ]
  },
  "xero_linked_transactions": {
   "id": "xero_linked_transactions",
   "primaryKey": [
    "linked_transaction_id"
   ],
   "recordIdField": "LinkedTransactionID",
   "sourceObjects": [
    "accounting:LinkedTransaction"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /LinkedTransactions",
    "envelope": "LinkedTransactions",
    "arrayKey": "LinkedTransactions",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "linked_transaction_id",
     "type": "text",
     "api": "accounting:LinkedTransaction.LinkedTransactionID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "accounting:LinkedTransaction.Type"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:LinkedTransaction.Status"
    },
    {
     "name": "source_transaction_id",
     "type": "text",
     "api": "accounting:LinkedTransaction.SourceTransactionID"
    },
    {
     "name": "source_line_item_id",
     "type": "text",
     "api": "accounting:LinkedTransaction.SourceLineItemID"
    },
    {
     "name": "source_transaction_type_code",
     "type": "text",
     "api": "accounting:LinkedTransaction.SourceTransactionTypeCode"
    },
    {
     "name": "target_transaction_id",
     "type": "text",
     "api": "accounting:LinkedTransaction.TargetTransactionID"
    },
    {
     "name": "target_line_item_id",
     "type": "text",
     "api": "accounting:LinkedTransaction.TargetLineItemID"
    },
    {
     "name": "contact_id",
     "type": "text",
     "api": "accounting:LinkedTransaction.ContactID"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:LinkedTransaction.UpdatedDateUTC"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:LinkedTransaction.ValidationErrors"
    }
   ]
  },
  "xero_manual_journal_line_tracking": {
   "id": "xero_manual_journal_line_tracking",
   "primaryKey": [
    "manual_journal_id",
    "line_ordinal",
    "tracking_category_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:TrackingCategory"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /ManualJournals",
    "envelope": "ManualJournals",
    "arrayKey": "ManualJournals",
    "explodePath": "ManualJournal.JournalLines.Tracking",
    "explodeChain": [
     "ManualJournal",
     "ManualJournalLine",
     "TrackingCategory"
    ],
    "parentTable": "xero_manual_journal_lines",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions",
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "manual_journal_id",
     "type": "text",
     "api": "accounting:ManualJournal.ManualJournalID"
    },
    {
     "name": "line_ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position of the parent line in ManualJournal.JournalLines, inherited from xero_manual_journal_lines"
    },
    {
     "name": "journal_lines_tracking",
     "type": "integer",
     "api": "accounting:ManualJournal.JournalLines.Tracking"
    },
    {
     "name": "tracking_category_id",
     "type": "text",
     "api": "accounting:TrackingCategory.TrackingCategoryID"
    },
    {
     "name": "tracking_option_id",
     "type": "text",
     "api": "accounting:TrackingCategory.TrackingOptionID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:TrackingCategory.Name"
    },
    {
     "name": "option",
     "type": "text",
     "api": "accounting:TrackingCategory.Option"
    }
   ]
  },
  "xero_manual_journal_lines": {
   "id": "xero_manual_journal_lines",
   "primaryKey": [
    "manual_journal_id",
    "journal_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:ManualJournalLine"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /ManualJournals",
    "envelope": "ManualJournals",
    "arrayKey": "ManualJournals",
    "explodePath": "ManualJournal.JournalLines",
    "explodeChain": [
     "ManualJournal",
     "ManualJournalLine"
    ],
    "parentTable": "xero_manual_journals",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions",
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "manual_journal_id",
     "type": "text",
     "api": "accounting:ManualJournal.ManualJournalID"
    },
    {
     "name": "journal_lines",
     "type": "integer",
     "api": "accounting:ManualJournal.JournalLines"
    },
    {
     "name": "line_amount",
     "type": "numeric",
     "api": "accounting:ManualJournalLine.LineAmount"
    },
    {
     "name": "account_code",
     "type": "text",
     "api": "accounting:ManualJournalLine.AccountCode"
    },
    {
     "name": "account_id",
     "type": "text",
     "api": "accounting:ManualJournalLine.AccountID"
    },
    {
     "name": "description",
     "type": "text",
     "api": "accounting:ManualJournalLine.Description"
    },
    {
     "name": "tax_type",
     "type": "text",
     "api": "accounting:ManualJournalLine.TaxType"
    },
    {
     "name": "tax_amount",
     "type": "numeric",
     "api": "accounting:ManualJournalLine.TaxAmount"
    },
    {
     "name": "is_blank",
     "type": "boolean",
     "api": "accounting:ManualJournalLine.IsBlank"
    }
   ]
  },
  "xero_manual_journals": {
   "id": "xero_manual_journals",
   "primaryKey": [
    "manual_journal_id"
   ],
   "recordIdField": "ManualJournalID",
   "sourceObjects": [
    "accounting:ManualJournal"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /ManualJournals",
    "envelope": "ManualJournals",
    "arrayKey": "ManualJournals",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions",
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "manual_journal_id",
     "type": "text",
     "api": "accounting:ManualJournal.ManualJournalID"
    },
    {
     "name": "narration",
     "type": "text",
     "api": "accounting:ManualJournal.Narration"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:ManualJournal.Date"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:ManualJournal.Status"
    },
    {
     "name": "line_amount_types",
     "type": "text",
     "api": "accounting:ManualJournal.LineAmountTypes"
    },
    {
     "name": "url",
     "type": "text",
     "api": "accounting:ManualJournal.Url"
    },
    {
     "name": "show_on_cash_basis_reports",
     "type": "boolean",
     "api": "accounting:ManualJournal.ShowOnCashBasisReports"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:ManualJournal.HasAttachments"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:ManualJournal.UpdatedDateUTC"
    },
    {
     "name": "status_attribute_string",
     "type": "text",
     "api": "accounting:ManualJournal.StatusAttributeString"
    },
    {
     "name": "warnings",
     "type": "jsonb",
     "api": "accounting:ManualJournal.Warnings"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:ManualJournal.ValidationErrors"
    },
    {
     "name": "attachments",
     "type": "jsonb",
     "api": "accounting:ManualJournal.Attachments"
    },
    {
     "name": "journal_lines",
     "type": "jsonb",
     "api": "accounting:ManualJournal.JournalLines"
    }
   ]
  },
  "xero_online_invoices": {
   "id": "xero_online_invoices",
   "primaryKey": [
    "invoice_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:OnlineInvoice"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Invoices/{InvoiceID}/OnlineInvoice",
    "envelope": "OnlineInvoices",
    "arrayKey": "OnlineInvoices",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_invoices",
    "fanOutParam": "InvoiceID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "invoice_id",
     "type": "text",
     "api": "accounting:Invoice.InvoiceID"
    },
    {
     "name": "online_invoice_url",
     "type": "text",
     "api": "accounting:OnlineInvoice.OnlineInvoiceUrl"
    }
   ]
  },
  "xero_organisation_actions": {
   "id": "xero_organisation_actions",
   "primaryKey": [
    "organisation_id",
    "name"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:Action"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Organisation/Actions",
    "envelope": "Actions",
    "arrayKey": "Actions",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "organisation_id",
     "type": "text",
     "api": "synthetic:the connected tenant's OrganisationID, minted onto each row from connection context — GET /Organisation/Actions takes no path parameter and the Action payload carries no org id"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:Action.Name"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:Action.Status"
    }
   ]
  },
  "xero_organisation_addresses": {
   "id": "xero_organisation_addresses",
   "primaryKey": [
    "organisation_id",
    "address_type"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:AddressForOrganisation"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Organisation",
    "envelope": "Organisations",
    "arrayKey": "Organisations",
    "explodePath": "Organisation.Addresses",
    "explodeChain": [
     "Organisation",
     "AddressForOrganisation"
    ],
    "parentTable": "xero_organisations",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "organisation_id",
     "type": "text",
     "api": "accounting:Organisation.OrganisationID"
    },
    {
     "name": "address_type",
     "type": "text",
     "api": "accounting:AddressForOrganisation.AddressType"
    },
    {
     "name": "address_line1",
     "type": "text",
     "api": "accounting:AddressForOrganisation.AddressLine1"
    },
    {
     "name": "address_line2",
     "type": "text",
     "api": "accounting:AddressForOrganisation.AddressLine2"
    },
    {
     "name": "address_line3",
     "type": "text",
     "api": "accounting:AddressForOrganisation.AddressLine3"
    },
    {
     "name": "address_line4",
     "type": "text",
     "api": "accounting:AddressForOrganisation.AddressLine4"
    },
    {
     "name": "city",
     "type": "text",
     "api": "accounting:AddressForOrganisation.City"
    },
    {
     "name": "region",
     "type": "text",
     "api": "accounting:AddressForOrganisation.Region"
    },
    {
     "name": "postal_code",
     "type": "text",
     "api": "accounting:AddressForOrganisation.PostalCode"
    },
    {
     "name": "country",
     "type": "text",
     "api": "accounting:AddressForOrganisation.Country"
    },
    {
     "name": "attention_to",
     "type": "text",
     "api": "accounting:AddressForOrganisation.AttentionTo"
    }
   ]
  },
  "xero_organisation_cis_settings": {
   "id": "xero_organisation_cis_settings",
   "primaryKey": [
    "organisation_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:CISOrgSetting"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Organisation/{OrganisationID}/CISSettings",
    "envelope": "CISOrgSettings",
    "arrayKey": "CISSettings",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_organisations",
    "fanOutParam": "OrganisationID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.settings.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "organisation_id",
     "type": "text",
     "api": "accounting:Organisation.OrganisationID"
    },
    {
     "name": "cis_contractor_enabled",
     "type": "boolean",
     "api": "accounting:CISOrgSetting.CISContractorEnabled"
    },
    {
     "name": "cis_sub_contractor_enabled",
     "type": "boolean",
     "api": "accounting:CISOrgSetting.CISSubContractorEnabled"
    },
    {
     "name": "rate",
     "type": "numeric",
     "api": "accounting:CISOrgSetting.Rate"
    }
   ]
  },
  "xero_organisation_external_links": {
   "id": "xero_organisation_external_links",
   "primaryKey": [
    "organisation_id",
    "ordinal"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:ExternalLink"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Organisation",
    "envelope": "Organisations",
    "arrayKey": "Organisations",
    "explodePath": "Organisation.ExternalLinks",
    "explodeChain": [
     "Organisation",
     "ExternalLink"
    ],
    "parentTable": "xero_organisations",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "organisation_id",
     "type": "text",
     "api": "accounting:Organisation.OrganisationID"
    },
    {
     "name": "ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position in Organisation.ExternalLinks as returned"
    },
    {
     "name": "link_type",
     "type": "text",
     "api": "accounting:ExternalLink.LinkType"
    },
    {
     "name": "url",
     "type": "text",
     "api": "accounting:ExternalLink.Url"
    },
    {
     "name": "description",
     "type": "text",
     "api": "accounting:ExternalLink.Description"
    }
   ]
  },
  "xero_organisation_payment_terms": {
   "id": "xero_organisation_payment_terms",
   "primaryKey": [
    "organisation_id",
    "term_scope"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:PaymentTerm",
    "accounting:Bill"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Organisation",
    "envelope": "Organisations",
    "arrayKey": "Organisations",
    "explodePath": "Organisation.PaymentTerms",
    "explodeChain": [
     "Organisation",
     "PaymentTerm"
    ],
    "parentTable": "xero_organisations",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "organisation_id",
     "type": "text",
     "api": "accounting:Organisation.OrganisationID"
    },
    {
     "name": "term_scope",
     "type": "text",
     "api": "synthetic:discriminator for which PaymentTerm branch this row materializes — SALES from accounting:PaymentTerm.Sales, BILLS from accounting:PaymentTerm.Bills"
    },
    {
     "name": "bills_day",
     "type": "integer",
     "api": "accounting:PaymentTerm.Bills.Day"
    },
    {
     "name": "bills_type",
     "type": "text",
     "api": "accounting:PaymentTerm.Bills.Type"
    }
   ]
  },
  "xero_organisation_phones": {
   "id": "xero_organisation_phones",
   "primaryKey": [
    "organisation_id",
    "phone_type"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:Phone"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Organisation",
    "envelope": "Organisations",
    "arrayKey": "Organisations",
    "explodePath": "Organisation.Phones",
    "explodeChain": [
     "Organisation",
     "Phone"
    ],
    "parentTable": "xero_organisations",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "organisation_id",
     "type": "text",
     "api": "accounting:Organisation.OrganisationID"
    },
    {
     "name": "phone_type",
     "type": "text",
     "api": "accounting:Phone.PhoneType"
    },
    {
     "name": "phone_number",
     "type": "text",
     "api": "accounting:Phone.PhoneNumber"
    },
    {
     "name": "phone_area_code",
     "type": "text",
     "api": "accounting:Phone.PhoneAreaCode"
    },
    {
     "name": "phone_country_code",
     "type": "text",
     "api": "accounting:Phone.PhoneCountryCode"
    }
   ]
  },
  "xero_organisations": {
   "id": "xero_organisations",
   "primaryKey": [
    "organisation_id"
   ],
   "recordIdField": "OrganisationID",
   "sourceObjects": [
    "accounting:Organisation"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Organisation",
    "envelope": "Organisations",
    "arrayKey": "Organisations",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "organisation_id",
     "type": "text",
     "api": "accounting:Organisation.OrganisationID"
    },
    {
     "name": "api_key",
     "type": "text",
     "api": "accounting:Organisation.APIKey"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:Organisation.Name"
    },
    {
     "name": "legal_name",
     "type": "text",
     "api": "accounting:Organisation.LegalName"
    },
    {
     "name": "pays_tax",
     "type": "boolean",
     "api": "accounting:Organisation.PaysTax"
    },
    {
     "name": "version",
     "type": "text",
     "api": "accounting:Organisation.Version"
    },
    {
     "name": "organisation_type",
     "type": "text",
     "api": "accounting:Organisation.OrganisationType"
    },
    {
     "name": "base_currency",
     "type": "text",
     "api": "accounting:Organisation.BaseCurrency"
    },
    {
     "name": "country_code",
     "type": "text",
     "api": "accounting:Organisation.CountryCode"
    },
    {
     "name": "is_demo_company",
     "type": "boolean",
     "api": "accounting:Organisation.IsDemoCompany"
    },
    {
     "name": "organisation_status",
     "type": "text",
     "api": "accounting:Organisation.OrganisationStatus"
    },
    {
     "name": "registration_number",
     "type": "text",
     "api": "accounting:Organisation.RegistrationNumber"
    },
    {
     "name": "employer_identification_number",
     "type": "text",
     "api": "accounting:Organisation.EmployerIdentificationNumber"
    },
    {
     "name": "tax_number",
     "type": "text",
     "api": "accounting:Organisation.TaxNumber"
    },
    {
     "name": "financial_year_end_day",
     "type": "integer",
     "api": "accounting:Organisation.FinancialYearEndDay"
    },
    {
     "name": "financial_year_end_month",
     "type": "integer",
     "api": "accounting:Organisation.FinancialYearEndMonth"
    },
    {
     "name": "sales_tax_basis",
     "type": "text",
     "api": "accounting:Organisation.SalesTaxBasis"
    },
    {
     "name": "sales_tax_period",
     "type": "text",
     "api": "accounting:Organisation.SalesTaxPeriod"
    },
    {
     "name": "default_sales_tax",
     "type": "text",
     "api": "accounting:Organisation.DefaultSalesTax"
    },
    {
     "name": "default_purchases_tax",
     "type": "text",
     "api": "accounting:Organisation.DefaultPurchasesTax"
    },
    {
     "name": "period_lock_date",
     "type": "date",
     "api": "accounting:Organisation.PeriodLockDate"
    },
    {
     "name": "end_of_year_lock_date",
     "type": "date",
     "api": "accounting:Organisation.EndOfYearLockDate"
    },
    {
     "name": "created_date_utc",
     "type": "timestamp",
     "api": "accounting:Organisation.CreatedDateUTC"
    },
    {
     "name": "timezone",
     "type": "text",
     "api": "accounting:Organisation.Timezone"
    },
    {
     "name": "organisation_entity_type",
     "type": "text",
     "api": "accounting:Organisation.OrganisationEntityType"
    },
    {
     "name": "short_code",
     "type": "text",
     "api": "accounting:Organisation.ShortCode"
    },
    {
     "name": "class",
     "type": "text",
     "api": "accounting:Organisation.Class"
    },
    {
     "name": "edition",
     "type": "text",
     "api": "accounting:Organisation.Edition"
    },
    {
     "name": "line_of_business",
     "type": "text",
     "api": "accounting:Organisation.LineOfBusiness"
    },
    {
     "name": "addresses",
     "type": "jsonb",
     "api": "accounting:Organisation.Addresses"
    },
    {
     "name": "phones",
     "type": "jsonb",
     "api": "accounting:Organisation.Phones"
    },
    {
     "name": "external_links",
     "type": "jsonb",
     "api": "accounting:Organisation.ExternalLinks"
    },
    {
     "name": "payment_terms",
     "type": "jsonb",
     "api": "accounting:Organisation.PaymentTerms"
    }
   ]
  },
  "xero_overpayment_allocations": {
   "id": "xero_overpayment_allocations",
   "primaryKey": [
    "overpayment_overpayment_id",
    "allocation_ordinal"
   ],
   "recordIdField": "AllocationID",
   "sourceObjects": [
    "accounting:Allocation"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Overpayments",
    "envelope": "Overpayments",
    "arrayKey": "Overpayments",
    "explodePath": "Overpayment.Allocations",
    "explodeChain": [
     "Overpayment",
     "Allocation"
    ],
    "parentTable": "xero_overpayments",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions",
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "overpayment_overpayment_id",
     "type": "text",
     "api": "accounting:Allocation.Overpayment.OverpaymentID"
    },
    {
     "name": "allocation_ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position in the parent Overpayment.Allocations array"
    },
    {
     "name": "allocation_id",
     "type": "text",
     "api": "accounting:Allocation.AllocationID"
    },
    {
     "name": "invoice_invoice_id",
     "type": "text",
     "api": "accounting:Allocation.Invoice.InvoiceID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "accounting:Allocation.Amount"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:Allocation.Date"
    },
    {
     "name": "is_deleted",
     "type": "boolean",
     "api": "accounting:Allocation.IsDeleted"
    },
    {
     "name": "status_attribute_string",
     "type": "text",
     "api": "accounting:Allocation.StatusAttributeString"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:Allocation.ValidationErrors"
    }
   ]
  },
  "xero_overpayments": {
   "id": "xero_overpayments",
   "primaryKey": [
    "overpayment_id"
   ],
   "recordIdField": "OverpaymentID",
   "sourceObjects": [
    "accounting:Overpayment"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Overpayments",
    "envelope": "Overpayments",
    "arrayKey": "Overpayments",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions",
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "overpayment_id",
     "type": "text",
     "api": "accounting:Overpayment.OverpaymentID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "accounting:Overpayment.Type"
    },
    {
     "name": "contact_contact_id",
     "type": "text",
     "api": "accounting:Overpayment.Contact.ContactID"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:Overpayment.Date"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:Overpayment.Status"
    },
    {
     "name": "line_amount_types",
     "type": "text",
     "api": "accounting:Overpayment.LineAmountTypes"
    },
    {
     "name": "line_items",
     "type": "jsonb",
     "api": "accounting:Overpayment.LineItems"
    },
    {
     "name": "sub_total",
     "type": "numeric",
     "api": "accounting:Overpayment.SubTotal"
    },
    {
     "name": "total_tax",
     "type": "numeric",
     "api": "accounting:Overpayment.TotalTax"
    },
    {
     "name": "total",
     "type": "numeric",
     "api": "accounting:Overpayment.Total"
    },
    {
     "name": "currency_code",
     "type": "text",
     "api": "accounting:Overpayment.CurrencyCode"
    },
    {
     "name": "currency_rate",
     "type": "numeric",
     "api": "accounting:Overpayment.CurrencyRate"
    },
    {
     "name": "remaining_credit",
     "type": "numeric",
     "api": "accounting:Overpayment.RemainingCredit"
    },
    {
     "name": "applied_amount",
     "type": "numeric",
     "api": "accounting:Overpayment.AppliedAmount"
    },
    {
     "name": "allocations",
     "type": "jsonb",
     "api": "accounting:Overpayment.Allocations"
    },
    {
     "name": "payments",
     "type": "jsonb",
     "api": "accounting:Overpayment.Payments"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:Overpayment.Reference"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:Overpayment.HasAttachments"
    },
    {
     "name": "attachments",
     "type": "jsonb",
     "api": "accounting:Overpayment.Attachments"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Overpayment.UpdatedDateUTC"
    },
    {
     "name": "updated_date_utc_string",
     "type": "text",
     "api": "accounting:Overpayment.UpdatedDateUTCString"
    }
   ]
  },
  "xero_payment_services": {
   "id": "xero_payment_services",
   "primaryKey": [
    "payment_service_id"
   ],
   "recordIdField": "PaymentServiceID",
   "sourceObjects": [
    "accounting:PaymentService"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /PaymentServices",
    "envelope": "PaymentServices",
    "arrayKey": "PaymentServices",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "paymentservices"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payment_service_id",
     "type": "text",
     "api": "accounting:PaymentService.PaymentServiceID"
    },
    {
     "name": "payment_service_name",
     "type": "text",
     "api": "accounting:PaymentService.PaymentServiceName"
    },
    {
     "name": "payment_service_url",
     "type": "text",
     "api": "accounting:PaymentService.PaymentServiceUrl"
    },
    {
     "name": "pay_now_text",
     "type": "text",
     "api": "accounting:PaymentService.PayNowText"
    },
    {
     "name": "payment_service_type",
     "type": "text",
     "api": "accounting:PaymentService.PaymentServiceType"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:PaymentService.ValidationErrors"
    }
   ]
  },
  "xero_payments": {
   "id": "xero_payments",
   "primaryKey": [
    "payment_id"
   ],
   "recordIdField": "PaymentID",
   "sourceObjects": [
    "accounting:Payment"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Payments",
    "envelope": "Payments",
    "arrayKey": "Payments",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions",
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payment_id",
     "type": "text",
     "api": "accounting:Payment.PaymentID"
    },
    {
     "name": "payment_type",
     "type": "text",
     "api": "accounting:Payment.PaymentType"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:Payment.Status"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:Payment.Date"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "accounting:Payment.Amount"
    },
    {
     "name": "bank_amount",
     "type": "numeric",
     "api": "accounting:Payment.BankAmount"
    },
    {
     "name": "currency_rate",
     "type": "numeric",
     "api": "accounting:Payment.CurrencyRate"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:Payment.Reference"
    },
    {
     "name": "is_reconciled",
     "type": "boolean",
     "api": "accounting:Payment.IsReconciled"
    },
    {
     "name": "account_account_id",
     "type": "text",
     "api": "accounting:Payment.Account.AccountID"
    },
    {
     "name": "code",
     "type": "text",
     "api": "accounting:Payment.Code"
    },
    {
     "name": "invoice_invoice_id",
     "type": "text",
     "api": "accounting:Payment.Invoice.InvoiceID"
    },
    {
     "name": "invoice_number",
     "type": "text",
     "api": "accounting:Payment.InvoiceNumber"
    },
    {
     "name": "credit_note_credit_note_id",
     "type": "text",
     "api": "accounting:Payment.CreditNote.CreditNoteID"
    },
    {
     "name": "credit_note_number",
     "type": "text",
     "api": "accounting:Payment.CreditNoteNumber"
    },
    {
     "name": "prepayment_prepayment_id",
     "type": "text",
     "api": "accounting:Payment.Prepayment.PrepaymentID"
    },
    {
     "name": "overpayment_overpayment_id",
     "type": "text",
     "api": "accounting:Payment.Overpayment.OverpaymentID"
    },
    {
     "name": "batch_payment_id",
     "type": "text",
     "api": "accounting:Payment.BatchPaymentID"
    },
    {
     "name": "batch_payment",
     "type": "jsonb",
     "api": "accounting:Payment.BatchPayment"
    },
    {
     "name": "bank_account_number",
     "type": "text",
     "api": "accounting:Payment.BankAccountNumber"
    },
    {
     "name": "particulars",
     "type": "text",
     "api": "accounting:Payment.Particulars"
    },
    {
     "name": "details",
     "type": "text",
     "api": "accounting:Payment.Details"
    },
    {
     "name": "has_account",
     "type": "boolean",
     "api": "accounting:Payment.HasAccount"
    },
    {
     "name": "has_validation_errors",
     "type": "boolean",
     "api": "accounting:Payment.HasValidationErrors"
    },
    {
     "name": "status_attribute_string",
     "type": "text",
     "api": "accounting:Payment.StatusAttributeString"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:Payment.ValidationErrors"
    },
    {
     "name": "warnings",
     "type": "jsonb",
     "api": "accounting:Payment.Warnings"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Payment.UpdatedDateUTC"
    },
    {
     "name": "updated_date_utc_string",
     "type": "text",
     "api": "accounting:Payment.UpdatedDateUTCString"
    },
    {
     "name": "invoice",
     "type": "jsonb",
     "api": "accounting:Payment.Invoice"
    },
    {
     "name": "credit_note",
     "type": "jsonb",
     "api": "accounting:Payment.CreditNote"
    },
    {
     "name": "prepayment",
     "type": "jsonb",
     "api": "accounting:Payment.Prepayment"
    },
    {
     "name": "overpayment",
     "type": "jsonb",
     "api": "accounting:Payment.Overpayment"
    },
    {
     "name": "account",
     "type": "jsonb",
     "api": "accounting:Payment.Account"
    }
   ]
  },
  "xero_payroll_au_deduction_types": {
   "id": "xero_payroll_au_deduction_types",
   "primaryKey": [
    "deduction_type_id"
   ],
   "recordIdField": "DeductionTypeID",
   "sourceObjects": [
    "payroll_au:DeductionType"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /PayItems",
    "envelope": "PayItems",
    "arrayKey": "PayItems.DeductionTypes",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "deduction_type_id",
     "type": "text",
     "api": "payroll_au:DeductionType.DeductionTypeID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_au:DeductionType.Name"
    },
    {
     "name": "account_code",
     "type": "text",
     "api": "payroll_au:DeductionType.AccountCode"
    },
    {
     "name": "reduces_tax",
     "type": "boolean",
     "api": "payroll_au:DeductionType.ReducesTax"
    },
    {
     "name": "reduces_super",
     "type": "boolean",
     "api": "payroll_au:DeductionType.ReducesSuper"
    },
    {
     "name": "is_exempt_from_w1",
     "type": "boolean",
     "api": "payroll_au:DeductionType.IsExemptFromW1"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:DeductionType.UpdatedDateUTC"
    },
    {
     "name": "deduction_category",
     "type": "text",
     "api": "payroll_au:DeductionType.DeductionCategory"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_au:DeductionType.CurrentRecord"
    }
   ]
  },
  "xero_payroll_au_earnings_rates": {
   "id": "xero_payroll_au_earnings_rates",
   "primaryKey": [
    "earnings_rate_id"
   ],
   "recordIdField": "EarningsRateID",
   "sourceObjects": [
    "payroll_au:EarningsRate"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /PayItems",
    "envelope": "PayItems",
    "arrayKey": "PayItems.EarningsRates",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_au:EarningsRate.EarningsRateID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_au:EarningsRate.Name"
    },
    {
     "name": "account_code",
     "type": "text",
     "api": "payroll_au:EarningsRate.AccountCode"
    },
    {
     "name": "type_of_units",
     "type": "text",
     "api": "payroll_au:EarningsRate.TypeOfUnits"
    },
    {
     "name": "is_exempt_from_tax",
     "type": "boolean",
     "api": "payroll_au:EarningsRate.IsExemptFromTax"
    },
    {
     "name": "is_exempt_from_super",
     "type": "boolean",
     "api": "payroll_au:EarningsRate.IsExemptFromSuper"
    },
    {
     "name": "is_reportable_as_w1",
     "type": "boolean",
     "api": "payroll_au:EarningsRate.IsReportableAsW1"
    },
    {
     "name": "is_qualifying_earnings",
     "type": "boolean",
     "api": "payroll_au:EarningsRate.IsQualifyingEarnings"
    },
    {
     "name": "allowance_contributes_to_annual_leave_rate",
     "type": "boolean",
     "api": "payroll_au:EarningsRate.AllowanceContributesToAnnualLeaveRate"
    },
    {
     "name": "allowance_contributes_to_overtime_rate",
     "type": "boolean",
     "api": "payroll_au:EarningsRate.AllowanceContributesToOvertimeRate"
    },
    {
     "name": "earnings_type",
     "type": "text",
     "api": "payroll_au:EarningsRate.EarningsType"
    },
    {
     "name": "rate_type",
     "type": "text",
     "api": "payroll_au:EarningsRate.RateType"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_au:EarningsRate.RatePerUnit"
    },
    {
     "name": "multiplier",
     "type": "numeric",
     "api": "payroll_au:EarningsRate.Multiplier"
    },
    {
     "name": "accrue_leave",
     "type": "boolean",
     "api": "payroll_au:EarningsRate.AccrueLeave"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:EarningsRate.Amount"
    },
    {
     "name": "employment_termination_payment_type",
     "type": "text",
     "api": "payroll_au:EarningsRate.EmploymentTerminationPaymentType"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:EarningsRate.UpdatedDateUTC"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_au:EarningsRate.CurrentRecord"
    },
    {
     "name": "allowance_type",
     "type": "text",
     "api": "payroll_au:EarningsRate.AllowanceType"
    },
    {
     "name": "allowance_category",
     "type": "text",
     "api": "payroll_au:EarningsRate.AllowanceCategory"
    }
   ]
  },
  "xero_payroll_au_employee_bank_accounts": {
   "id": "xero_payroll_au_employee_bank_accounts",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:BankAccount"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.BankAccounts",
    "explodeChain": [
     "Employee",
     "BankAccount"
    ],
    "parentTable": "xero_payroll_au_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.BankAccounts"
    },
    {
     "name": "statement_text",
     "type": "text",
     "api": "payroll_au:BankAccount.StatementText"
    },
    {
     "name": "account_name",
     "type": "text",
     "api": "payroll_au:BankAccount.AccountName"
    },
    {
     "name": "bsb",
     "type": "text",
     "api": "payroll_au:BankAccount.BSB"
    },
    {
     "name": "account_number",
     "type": "text",
     "api": "payroll_au:BankAccount.AccountNumber"
    },
    {
     "name": "remainder",
     "type": "boolean",
     "api": "payroll_au:BankAccount.Remainder"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:BankAccount.Amount"
    }
   ]
  },
  "xero_payroll_au_employee_home_addresses": {
   "id": "xero_payroll_au_employee_home_addresses",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:HomeAddress"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.HomeAddress",
    "explodeChain": [
     "Employee",
     "HomeAddress"
    ],
    "parentTable": "xero_payroll_au_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "address_line1",
     "type": "text",
     "api": "payroll_au:HomeAddress.AddressLine1"
    },
    {
     "name": "address_line2",
     "type": "text",
     "api": "payroll_au:HomeAddress.AddressLine2"
    },
    {
     "name": "city",
     "type": "text",
     "api": "payroll_au:HomeAddress.City"
    },
    {
     "name": "region",
     "type": "text",
     "api": "payroll_au:HomeAddress.Region"
    },
    {
     "name": "postal_code",
     "type": "text",
     "api": "payroll_au:HomeAddress.PostalCode"
    },
    {
     "name": "country",
     "type": "text",
     "api": "payroll_au:HomeAddress.Country"
    }
   ]
  },
  "xero_payroll_au_employee_leave_balances": {
   "id": "xero_payroll_au_employee_leave_balances",
   "primaryKey": [
    "employee_id",
    "leave_type_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:LeaveBalance"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.LeaveBalances",
    "explodeChain": [
     "Employee",
     "LeaveBalance"
    ],
    "parentTable": "xero_payroll_au_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_au:LeaveBalance.LeaveTypeID"
    },
    {
     "name": "leave_name",
     "type": "text",
     "api": "payroll_au:LeaveBalance.LeaveName"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_au:LeaveBalance.NumberOfUnits"
    },
    {
     "name": "type_of_units",
     "type": "text",
     "api": "payroll_au:LeaveBalance.TypeOfUnits"
    }
   ]
  },
  "xero_payroll_au_employee_super_memberships": {
   "id": "xero_payroll_au_employee_super_memberships",
   "primaryKey": [
    "super_membership_id"
   ],
   "recordIdField": "SuperMembershipID",
   "sourceObjects": [
    "payroll_au:SuperMembership"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.SuperMemberships",
    "explodeChain": [
     "Employee",
     "SuperMembership"
    ],
    "parentTable": "xero_payroll_au_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "super_membership_id",
     "type": "text",
     "api": "payroll_au:SuperMembership.SuperMembershipID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "super_fund_id",
     "type": "text",
     "api": "payroll_au:SuperMembership.SuperFundID"
    },
    {
     "name": "employee_number",
     "type": "text",
     "api": "payroll_au:SuperMembership.EmployeeNumber"
    }
   ]
  },
  "xero_payroll_au_employee_tax_declarations": {
   "id": "xero_payroll_au_employee_tax_declarations",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": "EmployeeID",
   "sourceObjects": [
    "payroll_au:TaxDeclaration"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.TaxDeclaration",
    "explodeChain": [
     "Employee",
     "TaxDeclaration"
    ],
    "parentTable": "xero_payroll_au_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:TaxDeclaration.EmployeeID"
    },
    {
     "name": "employment_basis",
     "type": "text",
     "api": "payroll_au:TaxDeclaration.EmploymentBasis"
    },
    {
     "name": "tfn_exemption_type",
     "type": "text",
     "api": "payroll_au:TaxDeclaration.TFNExemptionType"
    },
    {
     "name": "tax_file_number",
     "type": "text",
     "api": "payroll_au:TaxDeclaration.TaxFileNumber"
    },
    {
     "name": "abn",
     "type": "text",
     "api": "payroll_au:TaxDeclaration.ABN"
    },
    {
     "name": "australian_resident_for_tax_purposes",
     "type": "boolean",
     "api": "payroll_au:TaxDeclaration.AustralianResidentForTaxPurposes"
    },
    {
     "name": "residency_status",
     "type": "text",
     "api": "payroll_au:TaxDeclaration.ResidencyStatus"
    },
    {
     "name": "tax_scale_type",
     "type": "text",
     "api": "payroll_au:TaxDeclaration.TaxScaleType"
    },
    {
     "name": "work_condition",
     "type": "text",
     "api": "payroll_au:TaxDeclaration.WorkCondition"
    },
    {
     "name": "senior_marital_status",
     "type": "text",
     "api": "payroll_au:TaxDeclaration.SeniorMaritalStatus"
    },
    {
     "name": "tax_free_threshold_claimed",
     "type": "boolean",
     "api": "payroll_au:TaxDeclaration.TaxFreeThresholdClaimed"
    },
    {
     "name": "tax_offset_estimated_amount",
     "type": "integer",
     "api": "payroll_au:TaxDeclaration.TaxOffsetEstimatedAmount"
    },
    {
     "name": "has_help_debt",
     "type": "boolean",
     "api": "payroll_au:TaxDeclaration.HasHELPDebt"
    },
    {
     "name": "has_sfss_debt",
     "type": "boolean",
     "api": "payroll_au:TaxDeclaration.HasSFSSDebt"
    },
    {
     "name": "has_trade_support_loan_debt",
     "type": "boolean",
     "api": "payroll_au:TaxDeclaration.HasTradeSupportLoanDebt"
    },
    {
     "name": "upward_variation_tax_withholding_amount",
     "type": "integer",
     "api": "payroll_au:TaxDeclaration.UpwardVariationTaxWithholdingAmount"
    },
    {
     "name": "eligible_to_receive_leave_loading",
     "type": "boolean",
     "api": "payroll_au:TaxDeclaration.EligibleToReceiveLeaveLoading"
    },
    {
     "name": "approved_withholding_variation_percentage",
     "type": "integer",
     "api": "payroll_au:TaxDeclaration.ApprovedWithholdingVariationPercentage"
    },
    {
     "name": "has_student_startup_loan",
     "type": "boolean",
     "api": "payroll_au:TaxDeclaration.HasStudentStartupLoan"
    },
    {
     "name": "has_loan_or_student_debt",
     "type": "boolean",
     "api": "payroll_au:TaxDeclaration.HasLoanOrStudentDebt"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:TaxDeclaration.UpdatedDateUTC"
    },
    {
     "name": "include_leave_loading_in_qualifying_earnings",
     "type": "boolean",
     "api": "payroll_au:TaxDeclaration.IncludeLeaveLoadingInQualifyingEarnings"
    }
   ]
  },
  "xero_payroll_au_employees": {
   "id": "xero_payroll_au_employees",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": "EmployeeID",
   "sourceObjects": [
    "payroll_au:Employee"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "first_name",
     "type": "text",
     "api": "payroll_au:Employee.FirstName"
    },
    {
     "name": "last_name",
     "type": "text",
     "api": "payroll_au:Employee.LastName"
    },
    {
     "name": "middle_names",
     "type": "text",
     "api": "payroll_au:Employee.MiddleNames"
    },
    {
     "name": "title",
     "type": "text",
     "api": "payroll_au:Employee.Title"
    },
    {
     "name": "date_of_birth",
     "type": "date",
     "api": "payroll_au:Employee.DateOfBirth"
    },
    {
     "name": "gender",
     "type": "text",
     "api": "payroll_au:Employee.Gender"
    },
    {
     "name": "email",
     "type": "text",
     "api": "payroll_au:Employee.Email"
    },
    {
     "name": "phone",
     "type": "text",
     "api": "payroll_au:Employee.Phone"
    },
    {
     "name": "mobile",
     "type": "text",
     "api": "payroll_au:Employee.Mobile"
    },
    {
     "name": "twitter_user_name",
     "type": "text",
     "api": "payroll_au:Employee.TwitterUserName"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_au:Employee.StartDate"
    },
    {
     "name": "termination_date",
     "type": "date",
     "api": "payroll_au:Employee.TerminationDate"
    },
    {
     "name": "termination_reason",
     "type": "text",
     "api": "payroll_au:Employee.TerminationReason"
    },
    {
     "name": "status",
     "type": "text",
     "api": "payroll_au:Employee.Status"
    },
    {
     "name": "job_title",
     "type": "text",
     "api": "payroll_au:Employee.JobTitle"
    },
    {
     "name": "classification",
     "type": "text",
     "api": "payroll_au:Employee.Classification"
    },
    {
     "name": "employee_group_name",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeGroupName"
    },
    {
     "name": "is_authorised_to_approve_leave",
     "type": "boolean",
     "api": "payroll_au:Employee.IsAuthorisedToApproveLeave"
    },
    {
     "name": "is_authorised_to_approve_timesheets",
     "type": "boolean",
     "api": "payroll_au:Employee.IsAuthorisedToApproveTimesheets"
    },
    {
     "name": "ordinary_earnings_rate_id",
     "type": "text",
     "api": "payroll_au:Employee.OrdinaryEarningsRateID"
    },
    {
     "name": "payroll_calendar_id",
     "type": "text",
     "api": "payroll_au:Employee.PayrollCalendarID"
    },
    {
     "name": "income_type",
     "type": "text",
     "api": "payroll_au:Employee.IncomeType"
    },
    {
     "name": "employment_type",
     "type": "text",
     "api": "payroll_au:Employee.EmploymentType"
    },
    {
     "name": "country_of_residence",
     "type": "text",
     "api": "payroll_au:Employee.CountryOfResidence"
    },
    {
     "name": "is_stp2_qualified",
     "type": "boolean",
     "api": "payroll_au:Employee.IsSTP2Qualified"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:Employee.UpdatedDateUTC"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "payroll_au:Employee.ValidationErrors"
    },
    {
     "name": "home_address",
     "type": "jsonb",
     "api": "payroll_au:Employee.HomeAddress"
    },
    {
     "name": "bank_accounts",
     "type": "jsonb",
     "api": "payroll_au:Employee.BankAccounts"
    },
    {
     "name": "pay_template",
     "type": "jsonb",
     "api": "payroll_au:Employee.PayTemplate"
    },
    {
     "name": "opening_balances",
     "type": "jsonb",
     "api": "payroll_au:Employee.OpeningBalances"
    },
    {
     "name": "tax_declaration",
     "type": "jsonb",
     "api": "payroll_au:Employee.TaxDeclaration"
    },
    {
     "name": "leave_balances",
     "type": "jsonb",
     "api": "payroll_au:Employee.LeaveBalances"
    },
    {
     "name": "super_memberships",
     "type": "jsonb",
     "api": "payroll_au:Employee.SuperMemberships"
    },
    {
     "name": "earnings_lines",
     "type": "jsonb",
     "api": "payroll_au:PayTemplate.EarningsLines"
    },
    {
     "name": "deduction_lines",
     "type": "jsonb",
     "api": "payroll_au:PayTemplate.DeductionLines"
    },
    {
     "name": "super_lines",
     "type": "jsonb",
     "api": "payroll_au:PayTemplate.SuperLines"
    },
    {
     "name": "reimbursement_lines",
     "type": "jsonb",
     "api": "payroll_au:PayTemplate.ReimbursementLines"
    },
    {
     "name": "leave_lines",
     "type": "jsonb",
     "api": "payroll_au:PayTemplate.LeaveLines"
    }
   ]
  },
  "xero_payroll_au_leave_applications": {
   "id": "xero_payroll_au_leave_applications",
   "primaryKey": [
    "leave_application_id"
   ],
   "recordIdField": "LeaveApplicationID",
   "sourceObjects": [
    "payroll_au:LeaveApplication"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /LeaveApplications/v2",
    "envelope": "LeaveApplications",
    "arrayKey": "LeaveApplications",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "leave_application_id",
     "type": "text",
     "api": "payroll_au:LeaveApplication.LeaveApplicationID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:LeaveApplication.EmployeeID"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_au:LeaveApplication.LeaveTypeID"
    },
    {
     "name": "title",
     "type": "text",
     "api": "payroll_au:LeaveApplication.Title"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_au:LeaveApplication.StartDate"
    },
    {
     "name": "end_date",
     "type": "date",
     "api": "payroll_au:LeaveApplication.EndDate"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_au:LeaveApplication.Description"
    },
    {
     "name": "pay_out_type",
     "type": "text",
     "api": "payroll_au:LeaveApplication.PayOutType"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:LeaveApplication.UpdatedDateUTC"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "payroll_au:LeaveApplication.ValidationErrors"
    }
   ]
  },
  "xero_payroll_au_leave_periods": {
   "id": "xero_payroll_au_leave_periods",
   "primaryKey": [
    "leave_application_id",
    "leave_periods"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:LeaveApplication",
    "payroll_au:LeavePeriod"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /LeaveApplications/v2",
    "envelope": "LeaveApplications",
    "arrayKey": "LeaveApplications",
    "explodePath": "LeaveApplication.LeavePeriods",
    "explodeChain": [
     "LeaveApplication",
     "LeavePeriod"
    ],
    "parentTable": "xero_payroll_au_leave_applications",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "leave_application_id",
     "type": "text",
     "api": "payroll_au:LeaveApplication.LeaveApplicationID"
    },
    {
     "name": "leave_periods",
     "type": "integer",
     "api": "payroll_au:LeaveApplication.LeavePeriods[] index"
    },
    {
     "name": "leave_periods_pay_period_start_date",
     "type": "date",
     "api": "payroll_au:LeaveApplication.LeavePeriods.PayPeriodStartDate"
    },
    {
     "name": "leave_periods_pay_period_end_date",
     "type": "date",
     "api": "payroll_au:LeaveApplication.LeavePeriods.PayPeriodEndDate"
    },
    {
     "name": "leave_periods_number_of_units",
     "type": "numeric",
     "api": "payroll_au:LeaveApplication.LeavePeriods.NumberOfUnits"
    },
    {
     "name": "leave_periods_leave_period_status",
     "type": "text",
     "api": "payroll_au:LeaveApplication.LeavePeriods.LeavePeriodStatus"
    }
   ]
  },
  "xero_payroll_au_leave_types": {
   "id": "xero_payroll_au_leave_types",
   "primaryKey": [
    "leave_type_id"
   ],
   "recordIdField": "LeaveTypeID",
   "sourceObjects": [
    "payroll_au:LeaveType"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /PayItems",
    "envelope": "PayItems",
    "arrayKey": "PayItems.LeaveTypes",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_au:LeaveType.LeaveTypeID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_au:LeaveType.Name"
    },
    {
     "name": "type_of_units",
     "type": "text",
     "api": "payroll_au:LeaveType.TypeOfUnits"
    },
    {
     "name": "normal_entitlement",
     "type": "numeric",
     "api": "payroll_au:LeaveType.NormalEntitlement"
    },
    {
     "name": "leave_loading_rate",
     "type": "numeric",
     "api": "payroll_au:LeaveType.LeaveLoadingRate"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:LeaveType.UpdatedDateUTC"
    },
    {
     "name": "is_paid_leave",
     "type": "boolean",
     "api": "payroll_au:LeaveType.IsPaidLeave"
    },
    {
     "name": "show_on_payslip",
     "type": "boolean",
     "api": "payroll_au:LeaveType.ShowOnPayslip"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_au:LeaveType.CurrentRecord"
    },
    {
     "name": "leave_category_code",
     "type": "text",
     "api": "payroll_au:LeaveType.LeaveCategoryCode"
    },
    {
     "name": "sgc_exempt",
     "type": "boolean",
     "api": "payroll_au:LeaveType.SGCExempt"
    },
    {
     "name": "is_qualifying_earnings",
     "type": "boolean",
     "api": "payroll_au:LeaveType.IsQualifyingEarnings"
    }
   ]
  },
  "xero_payroll_au_opening_balance_deduction_lines": {
   "id": "xero_payroll_au_opening_balance_deduction_lines",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:DeductionLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.OpeningBalances.DeductionLines",
    "explodeChain": [
     "Employee",
     "OpeningBalances",
     "DeductionLine"
    ],
    "parentTable": "xero_payroll_au_opening_balances",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.OpeningBalances.DeductionLines"
    },
    {
     "name": "deduction_type_id",
     "type": "text",
     "api": "payroll_au:DeductionLine.DeductionTypeID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:DeductionLine.Amount"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_au:DeductionLine.CalculationType"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_au:DeductionLine.Percentage"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_au:DeductionLine.NumberOfUnits"
    }
   ]
  },
  "xero_payroll_au_opening_balance_earnings_lines": {
   "id": "xero_payroll_au_opening_balance_earnings_lines",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:EarningsLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.OpeningBalances.EarningsLines",
    "explodeChain": [
     "Employee",
     "OpeningBalances",
     "EarningsLine"
    ],
    "parentTable": "xero_payroll_au_opening_balances",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.OpeningBalances.EarningsLines"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_au:EarningsLine.EarningsRateID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.Amount"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_au:EarningsLine.CalculationType"
    },
    {
     "name": "annual_salary",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.AnnualSalary"
    },
    {
     "name": "number_of_units_per_week",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.NumberOfUnitsPerWeek"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.RatePerUnit"
    },
    {
     "name": "normal_number_of_units",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.NormalNumberOfUnits"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.NumberOfUnits"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.FixedAmount"
    }
   ]
  },
  "xero_payroll_au_opening_balance_leave_lines": {
   "id": "xero_payroll_au_opening_balance_leave_lines",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:OpeningBalanceLeaveLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.OpeningBalances.LeaveLines",
    "explodeChain": [
     "Employee",
     "OpeningBalances",
     "OpeningBalanceLeaveLine"
    ],
    "parentTable": "xero_payroll_au_opening_balances",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.OpeningBalances.LeaveLines"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_au:OpeningBalanceLeaveLine.LeaveTypeID"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_au:OpeningBalanceLeaveLine.NumberOfUnits"
    }
   ]
  },
  "xero_payroll_au_opening_balance_paid_leave_lines": {
   "id": "xero_payroll_au_opening_balance_paid_leave_lines",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:PaidLeaveEarningsLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.OpeningBalances.PaidLeaveEarningsLines",
    "explodeChain": [
     "Employee",
     "OpeningBalances",
     "PaidLeaveEarningsLine"
    ],
    "parentTable": "xero_payroll_au_opening_balances",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.OpeningBalances.PaidLeaveEarningsLines"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_au:PaidLeaveEarningsLine.LeaveTypeID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:PaidLeaveEarningsLine.Amount"
    },
    {
     "name": "sgc_applied_leave_loading_amount",
     "type": "numeric",
     "api": "payroll_au:PaidLeaveEarningsLine.SGCAppliedLeaveLoadingAmount"
    },
    {
     "name": "sgc_exempted_leave_loading_amount",
     "type": "numeric",
     "api": "payroll_au:PaidLeaveEarningsLine.SGCExemptedLeaveLoadingAmount"
    },
    {
     "name": "reset_stp_categorisation",
     "type": "boolean",
     "api": "payroll_au:PaidLeaveEarningsLine.ResetSTPCategorisation"
    }
   ]
  },
  "xero_payroll_au_opening_balance_reimbursement_lines": {
   "id": "xero_payroll_au_opening_balance_reimbursement_lines",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:ReimbursementLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.OpeningBalances.ReimbursementLines",
    "explodeChain": [
     "Employee",
     "OpeningBalances",
     "ReimbursementLine"
    ],
    "parentTable": "xero_payroll_au_opening_balances",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.OpeningBalances.ReimbursementLines"
    },
    {
     "name": "reimbursement_type_id",
     "type": "text",
     "api": "payroll_au:ReimbursementLine.ReimbursementTypeID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:ReimbursementLine.Amount"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_au:ReimbursementLine.Description"
    },
    {
     "name": "expense_account",
     "type": "text",
     "api": "payroll_au:ReimbursementLine.ExpenseAccount"
    }
   ]
  },
  "xero_payroll_au_opening_balance_super_lines": {
   "id": "xero_payroll_au_opening_balance_super_lines",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:SuperLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.OpeningBalances.SuperLines",
    "explodeChain": [
     "Employee",
     "OpeningBalances",
     "SuperLine"
    ],
    "parentTable": "xero_payroll_au_opening_balances",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.OpeningBalances.SuperLines"
    },
    {
     "name": "super_membership_id",
     "type": "text",
     "api": "payroll_au:SuperLine.SuperMembershipID"
    },
    {
     "name": "contribution_type",
     "type": "text",
     "api": "payroll_au:SuperLine.ContributionType"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:SuperLine.Amount"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_au:SuperLine.CalculationType"
    },
    {
     "name": "minimum_monthly_earnings",
     "type": "numeric",
     "api": "payroll_au:SuperLine.MinimumMonthlyEarnings"
    },
    {
     "name": "expense_account_code",
     "type": "text",
     "api": "payroll_au:SuperLine.ExpenseAccountCode"
    },
    {
     "name": "liability_account_code",
     "type": "text",
     "api": "payroll_au:SuperLine.LiabilityAccountCode"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_au:SuperLine.Percentage"
    }
   ]
  },
  "xero_payroll_au_opening_balances": {
   "id": "xero_payroll_au_opening_balances",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:OpeningBalances"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.OpeningBalances",
    "explodeChain": [
     "Employee",
     "OpeningBalances"
    ],
    "parentTable": "xero_payroll_au_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "opening_balance_date",
     "type": "date",
     "api": "payroll_au:OpeningBalances.OpeningBalanceDate"
    },
    {
     "name": "tax",
     "type": "text",
     "api": "payroll_au:OpeningBalances.Tax"
    }
   ]
  },
  "xero_payroll_au_pay_runs": {
   "id": "xero_payroll_au_pay_runs",
   "primaryKey": [
    "pay_run_id"
   ],
   "recordIdField": "PayRunID",
   "sourceObjects": [
    "payroll_au:PayRun",
    "payroll_au:PayslipSummary"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /PayRuns",
    "envelope": "PayRuns",
    "arrayKey": "PayRuns",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.payruns",
     "payroll.payruns.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_run_id",
     "type": "text",
     "api": "payroll_au:PayRun.PayRunID"
    },
    {
     "name": "payroll_calendar_id",
     "type": "text",
     "api": "payroll_au:PayRun.PayrollCalendarID"
    },
    {
     "name": "pay_run_period_start_date",
     "type": "date",
     "api": "payroll_au:PayRun.PayRunPeriodStartDate"
    },
    {
     "name": "pay_run_period_end_date",
     "type": "date",
     "api": "payroll_au:PayRun.PayRunPeriodEndDate"
    },
    {
     "name": "pay_run_status",
     "type": "text",
     "api": "payroll_au:PayRun.PayRunStatus"
    },
    {
     "name": "payment_date",
     "type": "date",
     "api": "payroll_au:PayRun.PaymentDate"
    },
    {
     "name": "payslip_message",
     "type": "text",
     "api": "payroll_au:PayRun.PayslipMessage"
    },
    {
     "name": "wages",
     "type": "numeric",
     "api": "payroll_au:PayRun.Wages"
    },
    {
     "name": "deductions",
     "type": "numeric",
     "api": "payroll_au:PayRun.Deductions"
    },
    {
     "name": "tax",
     "type": "numeric",
     "api": "payroll_au:PayRun.Tax"
    },
    {
     "name": "super",
     "type": "numeric",
     "api": "payroll_au:PayRun.Super"
    },
    {
     "name": "reimbursement",
     "type": "numeric",
     "api": "payroll_au:PayRun.Reimbursement"
    },
    {
     "name": "net_pay",
     "type": "numeric",
     "api": "payroll_au:PayRun.NetPay"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:PayRun.UpdatedDateUTC"
    },
    {
     "name": "payslips",
     "type": "jsonb",
     "api": "payroll_au:PayRun.Payslips"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "payroll_au:PayRun.ValidationErrors"
    }
   ]
  },
  "xero_payroll_au_pay_template_deduction_lines": {
   "id": "xero_payroll_au_pay_template_deduction_lines",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:DeductionLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.PayTemplate.DeductionLines",
    "explodeChain": [
     "Employee",
     "PayTemplate",
     "DeductionLine"
    ],
    "parentTable": "xero_payroll_au_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.PayTemplate.DeductionLines"
    },
    {
     "name": "deduction_type_id",
     "type": "text",
     "api": "payroll_au:DeductionLine.DeductionTypeID"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_au:DeductionLine.CalculationType"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:DeductionLine.Amount"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_au:DeductionLine.Percentage"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_au:DeductionLine.NumberOfUnits"
    }
   ]
  },
  "xero_payroll_au_pay_template_earnings_lines": {
   "id": "xero_payroll_au_pay_template_earnings_lines",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:EarningsLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.PayTemplate.EarningsLines",
    "explodeChain": [
     "Employee",
     "PayTemplate",
     "EarningsLine"
    ],
    "parentTable": "xero_payroll_au_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.PayTemplate.EarningsLines"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_au:EarningsLine.EarningsRateID"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_au:EarningsLine.CalculationType"
    },
    {
     "name": "annual_salary",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.AnnualSalary"
    },
    {
     "name": "number_of_units_per_week",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.NumberOfUnitsPerWeek"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.RatePerUnit"
    },
    {
     "name": "normal_number_of_units",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.NormalNumberOfUnits"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.Amount"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.NumberOfUnits"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.FixedAmount"
    }
   ]
  },
  "xero_payroll_au_pay_template_leave_lines": {
   "id": "xero_payroll_au_pay_template_leave_lines",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:LeaveLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.PayTemplate.LeaveLines",
    "explodeChain": [
     "Employee",
     "PayTemplate",
     "LeaveLine"
    ],
    "parentTable": "xero_payroll_au_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.PayTemplate.LeaveLines"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_au:LeaveLine.LeaveTypeID"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_au:LeaveLine.CalculationType"
    },
    {
     "name": "entitlement_final_pay_payout_type",
     "type": "text",
     "api": "payroll_au:LeaveLine.EntitlementFinalPayPayoutType"
    },
    {
     "name": "employment_termination_payment_type",
     "type": "text",
     "api": "payroll_au:LeaveLine.EmploymentTerminationPaymentType"
    },
    {
     "name": "include_superannuation_guarantee_contribution",
     "type": "boolean",
     "api": "payroll_au:LeaveLine.IncludeSuperannuationGuaranteeContribution"
    },
    {
     "name": "is_qualifying_earnings",
     "type": "boolean",
     "api": "payroll_au:LeaveLine.IsQualifyingEarnings"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_au:LeaveLine.NumberOfUnits"
    },
    {
     "name": "annual_number_of_units",
     "type": "numeric",
     "api": "payroll_au:LeaveLine.AnnualNumberOfUnits"
    },
    {
     "name": "full_time_number_of_units_per_period",
     "type": "numeric",
     "api": "payroll_au:LeaveLine.FullTimeNumberOfUnitsPerPeriod"
    }
   ]
  },
  "xero_payroll_au_pay_template_reimbursement_lines": {
   "id": "xero_payroll_au_pay_template_reimbursement_lines",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:ReimbursementLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.PayTemplate.ReimbursementLines",
    "explodeChain": [
     "Employee",
     "PayTemplate",
     "ReimbursementLine"
    ],
    "parentTable": "xero_payroll_au_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.PayTemplate.ReimbursementLines"
    },
    {
     "name": "reimbursement_type_id",
     "type": "text",
     "api": "payroll_au:ReimbursementLine.ReimbursementTypeID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:ReimbursementLine.Amount"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_au:ReimbursementLine.Description"
    },
    {
     "name": "expense_account",
     "type": "text",
     "api": "payroll_au:ReimbursementLine.ExpenseAccount"
    }
   ]
  },
  "xero_payroll_au_pay_template_super_lines": {
   "id": "xero_payroll_au_pay_template_super_lines",
   "primaryKey": [
    "employee_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:SuperLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Employees/{EmployeeID}",
    "envelope": "Employees",
    "arrayKey": "Employees",
    "explodePath": "Employee.PayTemplate.SuperLines",
    "explodeChain": [
     "Employee",
     "PayTemplate",
     "SuperLine"
    ],
    "parentTable": "xero_payroll_au_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Employee.EmployeeID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based position in Employee.PayTemplate.SuperLines"
    },
    {
     "name": "super_membership_id",
     "type": "text",
     "api": "payroll_au:SuperLine.SuperMembershipID"
    },
    {
     "name": "contribution_type",
     "type": "text",
     "api": "payroll_au:SuperLine.ContributionType"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_au:SuperLine.CalculationType"
    },
    {
     "name": "minimum_monthly_earnings",
     "type": "numeric",
     "api": "payroll_au:SuperLine.MinimumMonthlyEarnings"
    },
    {
     "name": "expense_account_code",
     "type": "text",
     "api": "payroll_au:SuperLine.ExpenseAccountCode"
    },
    {
     "name": "liability_account_code",
     "type": "text",
     "api": "payroll_au:SuperLine.LiabilityAccountCode"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_au:SuperLine.Percentage"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:SuperLine.Amount"
    }
   ]
  },
  "xero_payroll_au_payroll_calendars": {
   "id": "xero_payroll_au_payroll_calendars",
   "primaryKey": [
    "payroll_calendar_id"
   ],
   "recordIdField": "PayrollCalendarID",
   "sourceObjects": [
    "payroll_au:PayrollCalendar"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /PayrollCalendars",
    "envelope": "PayrollCalendars",
    "arrayKey": "PayrollCalendars",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payroll_calendar_id",
     "type": "text",
     "api": "payroll_au:PayrollCalendar.PayrollCalendarID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_au:PayrollCalendar.Name"
    },
    {
     "name": "calendar_type",
     "type": "text",
     "api": "payroll_au:PayrollCalendar.CalendarType"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_au:PayrollCalendar.StartDate"
    },
    {
     "name": "payment_date",
     "type": "date",
     "api": "payroll_au:PayrollCalendar.PaymentDate"
    },
    {
     "name": "reference_date",
     "type": "date",
     "api": "payroll_au:PayrollCalendar.ReferenceDate"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:PayrollCalendar.UpdatedDateUTC"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "payroll_au:PayrollCalendar.ValidationErrors"
    }
   ]
  },
  "xero_payroll_au_payslip_deduction_lines": {
   "id": "xero_payroll_au_payslip_deduction_lines",
   "primaryKey": [
    "payslip_id",
    "deduction_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:DeductionLine",
    "payroll_au:Payslip"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Payslip/{PayslipID}",
    "envelope": "PayslipObject",
    "arrayKey": "Payslip",
    "explodePath": "Payslip.DeductionLines",
    "explodeChain": [
     "Payslip",
     "DeductionLine"
    ],
    "parentTable": "xero_payroll_au_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payslip_id",
     "type": "text",
     "api": "payroll_au:Payslip.PayslipID"
    },
    {
     "name": "deduction_lines",
     "type": "integer",
     "api": "payroll_au:Payslip.DeductionLines[] index"
    },
    {
     "name": "deduction_type_id",
     "type": "text",
     "api": "payroll_au:DeductionLine.DeductionTypeID"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_au:DeductionLine.CalculationType"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:DeductionLine.Amount"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_au:DeductionLine.Percentage"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_au:DeductionLine.NumberOfUnits"
    }
   ]
  },
  "xero_payroll_au_payslip_earnings_lines": {
   "id": "xero_payroll_au_payslip_earnings_lines",
   "primaryKey": [
    "payslip_id",
    "earnings_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:EarningsLine",
    "payroll_au:Payslip"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Payslip/{PayslipID}",
    "envelope": "PayslipObject",
    "arrayKey": "Payslip",
    "explodePath": "Payslip.EarningsLines",
    "explodeChain": [
     "Payslip",
     "EarningsLine"
    ],
    "parentTable": "xero_payroll_au_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payslip_id",
     "type": "text",
     "api": "payroll_au:Payslip.PayslipID"
    },
    {
     "name": "earnings_lines",
     "type": "integer",
     "api": "payroll_au:Payslip.EarningsLines[] index"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_au:EarningsLine.EarningsRateID"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_au:EarningsLine.CalculationType"
    },
    {
     "name": "annual_salary",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.AnnualSalary"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.RatePerUnit"
    },
    {
     "name": "normal_number_of_units",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.NormalNumberOfUnits"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.NumberOfUnits"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.Amount"
    }
   ]
  },
  "xero_payroll_au_payslip_leave_accrual_lines": {
   "id": "xero_payroll_au_payslip_leave_accrual_lines",
   "primaryKey": [
    "payslip_id",
    "leave_accrual_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:Payslip",
    "payroll_au:LeaveAccrualLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Payslip/{PayslipID}",
    "envelope": "PayslipObject",
    "arrayKey": "Payslip",
    "explodePath": "Payslip.LeaveAccrualLines",
    "explodeChain": [
     "Payslip",
     "LeaveAccrualLine"
    ],
    "parentTable": "xero_payroll_au_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payslip_id",
     "type": "text",
     "api": "payroll_au:Payslip.PayslipID"
    },
    {
     "name": "leave_accrual_lines",
     "type": "integer",
     "api": "payroll_au:Payslip.LeaveAccrualLines[] index"
    },
    {
     "name": "leave_accrual_lines_leave_type_id",
     "type": "text",
     "api": "payroll_au:Payslip.LeaveAccrualLines.LeaveTypeID"
    },
    {
     "name": "leave_accrual_lines_number_of_units",
     "type": "numeric",
     "api": "payroll_au:Payslip.LeaveAccrualLines.NumberOfUnits"
    },
    {
     "name": "leave_accrual_lines_auto_calculate",
     "type": "boolean",
     "api": "payroll_au:Payslip.LeaveAccrualLines.AutoCalculate"
    }
   ]
  },
  "xero_payroll_au_payslip_leave_earnings_lines": {
   "id": "xero_payroll_au_payslip_leave_earnings_lines",
   "primaryKey": [
    "payslip_id",
    "leave_earnings_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:Payslip",
    "payroll_au:LeaveEarningsLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Payslip/{PayslipID}",
    "envelope": "PayslipObject",
    "arrayKey": "Payslip",
    "explodePath": "Payslip.LeaveEarningsLines",
    "explodeChain": [
     "Payslip",
     "LeaveEarningsLine"
    ],
    "parentTable": "xero_payroll_au_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payslip_id",
     "type": "text",
     "api": "payroll_au:Payslip.PayslipID"
    },
    {
     "name": "leave_earnings_lines",
     "type": "integer",
     "api": "payroll_au:Payslip.LeaveEarningsLines[] index"
    },
    {
     "name": "leave_earnings_lines_earnings_rate_id",
     "type": "text",
     "api": "payroll_au:Payslip.LeaveEarningsLines.EarningsRateID"
    },
    {
     "name": "leave_earnings_lines_rate_per_unit",
     "type": "numeric",
     "api": "payroll_au:Payslip.LeaveEarningsLines.RatePerUnit"
    },
    {
     "name": "leave_earnings_lines_number_of_units",
     "type": "numeric",
     "api": "payroll_au:Payslip.LeaveEarningsLines.NumberOfUnits"
    },
    {
     "name": "leave_earnings_lines_pay_out_type",
     "type": "text",
     "api": "payroll_au:Payslip.LeaveEarningsLines.PayOutType"
    }
   ]
  },
  "xero_payroll_au_payslip_reimbursement_lines": {
   "id": "xero_payroll_au_payslip_reimbursement_lines",
   "primaryKey": [
    "payslip_id",
    "reimbursement_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:ReimbursementLine",
    "payroll_au:Payslip"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Payslip/{PayslipID}",
    "envelope": "PayslipObject",
    "arrayKey": "Payslip",
    "explodePath": "Payslip.ReimbursementLines",
    "explodeChain": [
     "Payslip",
     "ReimbursementLine"
    ],
    "parentTable": "xero_payroll_au_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payslip_id",
     "type": "text",
     "api": "payroll_au:Payslip.PayslipID"
    },
    {
     "name": "reimbursement_lines",
     "type": "integer",
     "api": "payroll_au:Payslip.ReimbursementLines[] index"
    },
    {
     "name": "reimbursement_type_id",
     "type": "text",
     "api": "payroll_au:ReimbursementLine.ReimbursementTypeID"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_au:ReimbursementLine.Description"
    },
    {
     "name": "expense_account",
     "type": "text",
     "api": "payroll_au:ReimbursementLine.ExpenseAccount"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:ReimbursementLine.Amount"
    }
   ]
  },
  "xero_payroll_au_payslip_superannuation_lines": {
   "id": "xero_payroll_au_payslip_superannuation_lines",
   "primaryKey": [
    "payslip_id",
    "superannuation_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:Payslip",
    "payroll_au:SuperannuationLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Payslip/{PayslipID}",
    "envelope": "PayslipObject",
    "arrayKey": "Payslip",
    "explodePath": "Payslip.SuperannuationLines",
    "explodeChain": [
     "Payslip",
     "SuperannuationLine"
    ],
    "parentTable": "xero_payroll_au_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payslip_id",
     "type": "text",
     "api": "payroll_au:Payslip.PayslipID"
    },
    {
     "name": "superannuation_lines",
     "type": "integer",
     "api": "payroll_au:Payslip.SuperannuationLines[] index"
    },
    {
     "name": "superannuation_lines_super_membership_id",
     "type": "text",
     "api": "payroll_au:Payslip.SuperannuationLines.SuperMembershipID"
    },
    {
     "name": "superannuation_lines_contribution_type",
     "type": "text",
     "api": "payroll_au:Payslip.SuperannuationLines.ContributionType"
    },
    {
     "name": "superannuation_lines_calculation_type",
     "type": "text",
     "api": "payroll_au:Payslip.SuperannuationLines.CalculationType"
    },
    {
     "name": "superannuation_lines_minimum_monthly_earnings",
     "type": "numeric",
     "api": "payroll_au:Payslip.SuperannuationLines.MinimumMonthlyEarnings"
    },
    {
     "name": "superannuation_lines_expense_account_code",
     "type": "text",
     "api": "payroll_au:Payslip.SuperannuationLines.ExpenseAccountCode"
    },
    {
     "name": "superannuation_lines_liability_account_code",
     "type": "text",
     "api": "payroll_au:Payslip.SuperannuationLines.LiabilityAccountCode"
    },
    {
     "name": "superannuation_lines_payment_date_for_this_period",
     "type": "date",
     "api": "payroll_au:Payslip.SuperannuationLines.PaymentDateForThisPeriod"
    },
    {
     "name": "superannuation_lines_percentage",
     "type": "numeric",
     "api": "payroll_au:Payslip.SuperannuationLines.Percentage"
    },
    {
     "name": "superannuation_lines_amount",
     "type": "numeric",
     "api": "payroll_au:Payslip.SuperannuationLines.Amount"
    }
   ]
  },
  "xero_payroll_au_payslip_tax_lines": {
   "id": "xero_payroll_au_payslip_tax_lines",
   "primaryKey": [
    "payslip_id",
    "tax_lines"
   ],
   "recordIdField": "PayslipTaxLineID",
   "sourceObjects": [
    "payroll_au:Payslip",
    "payroll_au:TaxLine"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Payslip/{PayslipID}",
    "envelope": "PayslipObject",
    "arrayKey": "Payslip",
    "explodePath": "Payslip.TaxLines",
    "explodeChain": [
     "Payslip",
     "TaxLine"
    ],
    "parentTable": "xero_payroll_au_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payslip_id",
     "type": "text",
     "api": "payroll_au:Payslip.PayslipID"
    },
    {
     "name": "tax_lines",
     "type": "integer",
     "api": "payroll_au:Payslip.TaxLines[] index"
    },
    {
     "name": "tax_lines_payslip_tax_line_id",
     "type": "text",
     "api": "payroll_au:Payslip.TaxLines.PayslipTaxLineID"
    },
    {
     "name": "tax_lines_amount",
     "type": "numeric",
     "api": "payroll_au:Payslip.TaxLines.Amount"
    },
    {
     "name": "tax_lines_tax_type_name",
     "type": "text",
     "api": "payroll_au:Payslip.TaxLines.TaxTypeName"
    },
    {
     "name": "tax_lines_description",
     "type": "text",
     "api": "payroll_au:Payslip.TaxLines.Description"
    },
    {
     "name": "tax_lines_manual_tax_type",
     "type": "text",
     "api": "payroll_au:Payslip.TaxLines.ManualTaxType"
    },
    {
     "name": "tax_lines_liability_account",
     "type": "text",
     "api": "payroll_au:Payslip.TaxLines.LiabilityAccount"
    }
   ]
  },
  "xero_payroll_au_payslip_timesheet_earnings_lines": {
   "id": "xero_payroll_au_payslip_timesheet_earnings_lines",
   "primaryKey": [
    "payslip_id",
    "timesheet_earnings_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:EarningsLine",
    "payroll_au:Payslip"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Payslip/{PayslipID}",
    "envelope": "PayslipObject",
    "arrayKey": "Payslip",
    "explodePath": "Payslip.TimesheetEarningsLines",
    "explodeChain": [
     "Payslip",
     "EarningsLine"
    ],
    "parentTable": "xero_payroll_au_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payslip_id",
     "type": "text",
     "api": "payroll_au:Payslip.PayslipID"
    },
    {
     "name": "timesheet_earnings_lines",
     "type": "integer",
     "api": "payroll_au:Payslip.TimesheetEarningsLines[] index"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_au:EarningsLine.EarningsRateID"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_au:EarningsLine.CalculationType"
    },
    {
     "name": "annual_salary",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.AnnualSalary"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.RatePerUnit"
    },
    {
     "name": "normal_number_of_units",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.NormalNumberOfUnits"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.NumberOfUnits"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_au:EarningsLine.Amount"
    }
   ]
  },
  "xero_payroll_au_payslips": {
   "id": "xero_payroll_au_payslips",
   "primaryKey": [
    "payslip_id"
   ],
   "recordIdField": "PayslipID",
   "sourceObjects": [
    "payroll_au:Payslip",
    "payroll_au:PayslipSummary"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Payslip/{PayslipID}",
    "envelope": "PayslipObject",
    "arrayKey": "Payslip",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_au_pay_runs",
    "fanOutParam": "PayslipID",
    "pagination": "parent",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payslip_id",
     "type": "text",
     "api": "payroll_au:Payslip.PayslipID"
    },
    {
     "name": "pay_run_id",
     "type": "text",
     "api": "payroll_au:PayRun.PayRunID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Payslip.EmployeeID"
    },
    {
     "name": "first_name",
     "type": "text",
     "api": "payroll_au:Payslip.FirstName"
    },
    {
     "name": "last_name",
     "type": "text",
     "api": "payroll_au:Payslip.LastName"
    },
    {
     "name": "payslips_employee_group",
     "type": "text",
     "api": "payroll_au:PayRun.Payslips.EmployeeGroup"
    },
    {
     "name": "wages",
     "type": "numeric",
     "api": "payroll_au:Payslip.Wages"
    },
    {
     "name": "deductions",
     "type": "numeric",
     "api": "payroll_au:Payslip.Deductions"
    },
    {
     "name": "tax",
     "type": "numeric",
     "api": "payroll_au:Payslip.Tax"
    },
    {
     "name": "super",
     "type": "numeric",
     "api": "payroll_au:Payslip.Super"
    },
    {
     "name": "reimbursements",
     "type": "numeric",
     "api": "payroll_au:Payslip.Reimbursements"
    },
    {
     "name": "net_pay",
     "type": "numeric",
     "api": "payroll_au:Payslip.NetPay"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:Payslip.UpdatedDateUTC"
    },
    {
     "name": "earnings_lines",
     "type": "jsonb",
     "api": "payroll_au:Payslip.EarningsLines"
    },
    {
     "name": "timesheet_earnings_lines",
     "type": "jsonb",
     "api": "payroll_au:Payslip.TimesheetEarningsLines"
    },
    {
     "name": "deduction_lines",
     "type": "jsonb",
     "api": "payroll_au:Payslip.DeductionLines"
    },
    {
     "name": "reimbursement_lines",
     "type": "jsonb",
     "api": "payroll_au:Payslip.ReimbursementLines"
    }
   ]
  },
  "xero_payroll_au_reimbursement_types": {
   "id": "xero_payroll_au_reimbursement_types",
   "primaryKey": [
    "reimbursement_type_id"
   ],
   "recordIdField": "ReimbursementTypeID",
   "sourceObjects": [
    "payroll_au:ReimbursementType"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /PayItems",
    "envelope": "PayItems",
    "arrayKey": "PayItems.ReimbursementTypes",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "reimbursement_type_id",
     "type": "text",
     "api": "payroll_au:ReimbursementType.ReimbursementTypeID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_au:ReimbursementType.Name"
    },
    {
     "name": "account_code",
     "type": "text",
     "api": "payroll_au:ReimbursementType.AccountCode"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:ReimbursementType.UpdatedDateUTC"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_au:ReimbursementType.CurrentRecord"
    }
   ]
  },
  "xero_payroll_au_settings": {
   "id": "xero_payroll_au_settings",
   "primaryKey": [
    "settings_scope"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:Settings"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Settings",
    "envelope": "SettingsObject",
    "arrayKey": "Settings",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "settings_scope",
     "type": "text",
     "api": "synthetic:constant 'AU_PAYROLL' — GET /Settings returns exactly one record per tenant, which has no vendor id"
    },
    {
     "name": "days_in_payroll_year",
     "type": "integer",
     "api": "payroll_au:Settings.DaysInPayrollYear"
    },
    {
     "name": "employees_are_stp2",
     "type": "boolean",
     "api": "payroll_au:Settings.EmployeesAreSTP2"
    },
    {
     "name": "tracking_categories",
     "type": "jsonb",
     "api": "payroll_au:Settings.TrackingCategories"
    },
    {
     "name": "accounts",
     "type": "jsonb",
     "api": "payroll_au:Settings.Accounts"
    }
   ]
  },
  "xero_payroll_au_settings_accounts": {
   "id": "xero_payroll_au_settings_accounts",
   "primaryKey": [
    "settings_scope",
    "account_id",
    "type"
   ],
   "recordIdField": "AccountID",
   "sourceObjects": [
    "payroll_au:Account"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Settings",
    "envelope": "SettingsObject",
    "arrayKey": "Settings",
    "explodePath": "Settings.Accounts",
    "explodeChain": [
     "Settings",
     "Account"
    ],
    "parentTable": "xero_payroll_au_settings",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "settings_scope",
     "type": "text",
     "api": "synthetic:constant 'AU_PAYROLL' — parent key inherited from the singleton GET /Settings record, which carries no vendor id"
    },
    {
     "name": "account_id",
     "type": "text",
     "api": "payroll_au:Account.AccountID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "payroll_au:Account.Type"
    },
    {
     "name": "code",
     "type": "text",
     "api": "payroll_au:Account.Code"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_au:Account.Name"
    }
   ]
  },
  "xero_payroll_au_super_fund_products": {
   "id": "xero_payroll_au_super_fund_products",
   "primaryKey": [
    "abn",
    "usi"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:SuperFundProduct"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /SuperfundProducts",
    "envelope": "SuperFundProducts",
    "arrayKey": "SuperFundProducts",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_au_super_funds",
    "fanOutParam": "USI",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "abn",
     "type": "text",
     "api": "payroll_au:SuperFundProduct.ABN"
    },
    {
     "name": "usi",
     "type": "text",
     "api": "payroll_au:SuperFundProduct.USI"
    },
    {
     "name": "spin",
     "type": "text",
     "api": "payroll_au:SuperFundProduct.SPIN"
    },
    {
     "name": "product_name",
     "type": "text",
     "api": "payroll_au:SuperFundProduct.ProductName"
    }
   ]
  },
  "xero_payroll_au_super_funds": {
   "id": "xero_payroll_au_super_funds",
   "primaryKey": [
    "super_fund_id"
   ],
   "recordIdField": "SuperFundID",
   "sourceObjects": [
    "payroll_au:SuperFund"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Superfunds",
    "envelope": "SuperFunds",
    "arrayKey": "SuperFunds",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "super_fund_id",
     "type": "text",
     "api": "payroll_au:SuperFund.SuperFundID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "payroll_au:SuperFund.Type"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_au:SuperFund.Name"
    },
    {
     "name": "abn",
     "type": "text",
     "api": "payroll_au:SuperFund.ABN"
    },
    {
     "name": "bsb",
     "type": "text",
     "api": "payroll_au:SuperFund.BSB"
    },
    {
     "name": "account_number",
     "type": "text",
     "api": "payroll_au:SuperFund.AccountNumber"
    },
    {
     "name": "account_name",
     "type": "text",
     "api": "payroll_au:SuperFund.AccountName"
    },
    {
     "name": "electronic_service_address",
     "type": "text",
     "api": "payroll_au:SuperFund.ElectronicServiceAddress"
    },
    {
     "name": "employer_number",
     "type": "text",
     "api": "payroll_au:SuperFund.EmployerNumber"
    },
    {
     "name": "spin",
     "type": "text",
     "api": "payroll_au:SuperFund.SPIN"
    },
    {
     "name": "usi",
     "type": "text",
     "api": "payroll_au:SuperFund.USI"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:SuperFund.UpdatedDateUTC"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "payroll_au:SuperFund.ValidationErrors"
    }
   ]
  },
  "xero_payroll_au_timesheet_lines": {
   "id": "xero_payroll_au_timesheet_lines",
   "primaryKey": [
    "timesheet_id",
    "timesheet_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_au:TimesheetLine",
    "payroll_au:Timesheet"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Timesheets",
    "envelope": "Timesheets",
    "arrayKey": "Timesheets",
    "explodePath": "Timesheet.TimesheetLines",
    "explodeChain": [
     "Timesheet",
     "TimesheetLines"
    ],
    "parentTable": "xero_payroll_au_timesheets",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "payroll.timesheets",
     "payroll.timesheets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "timesheet_id",
     "type": "text",
     "api": "payroll_au:Timesheet.TimesheetID"
    },
    {
     "name": "timesheet_lines",
     "type": "integer",
     "api": "payroll_au:Timesheet.TimesheetLines[] index"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_au:TimesheetLine.EarningsRateID"
    },
    {
     "name": "tracking_item_id",
     "type": "text",
     "api": "payroll_au:TimesheetLine.TrackingItemID"
    },
    {
     "name": "number_of_units",
     "type": "jsonb",
     "api": "payroll_au:TimesheetLine.NumberOfUnits"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:TimesheetLine.UpdatedDateUTC"
    }
   ]
  },
  "xero_payroll_au_timesheets": {
   "id": "xero_payroll_au_timesheets",
   "primaryKey": [
    "timesheet_id"
   ],
   "recordIdField": "TimesheetID",
   "sourceObjects": [
    "payroll_au:Timesheet"
   ],
   "source": {
    "api": "payroll_au",
    "endpointOp": "GET /Timesheets",
    "envelope": "Timesheets",
    "arrayKey": "Timesheets",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.timesheets",
     "payroll.timesheets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "timesheet_id",
     "type": "text",
     "api": "payroll_au:Timesheet.TimesheetID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_au:Timesheet.EmployeeID"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_au:Timesheet.StartDate"
    },
    {
     "name": "end_date",
     "type": "date",
     "api": "payroll_au:Timesheet.EndDate"
    },
    {
     "name": "status",
     "type": "text",
     "api": "payroll_au:Timesheet.Status"
    },
    {
     "name": "hours",
     "type": "numeric",
     "api": "payroll_au:Timesheet.Hours"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_au:Timesheet.UpdatedDateUTC"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "payroll_au:Timesheet.ValidationErrors"
    },
    {
     "name": "timesheet_lines",
     "type": "jsonb",
     "api": "payroll_au:Timesheet.TimesheetLines"
    }
   ]
  },
  "xero_payroll_nz_deductions": {
   "id": "xero_payroll_nz_deductions",
   "primaryKey": [
    "deduction_id"
   ],
   "recordIdField": "deductionId",
   "sourceObjects": [
    "payroll_nz:Deduction"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Deductions",
    "envelope": "Deductions",
    "arrayKey": "deductions",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "deduction_id",
     "type": "text",
     "api": "payroll_nz:Deduction.deductionId"
    },
    {
     "name": "deduction_name",
     "type": "text",
     "api": "payroll_nz:Deduction.deductionName"
    },
    {
     "name": "deduction_category",
     "type": "text",
     "api": "payroll_nz:Deduction.deductionCategory"
    },
    {
     "name": "liability_account_id",
     "type": "text",
     "api": "payroll_nz:Deduction.liabilityAccountId"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_nz:Deduction.currentRecord"
    },
    {
     "name": "standard_amount",
     "type": "numeric",
     "api": "payroll_nz:Deduction.standardAmount"
    }
   ]
  },
  "xero_payroll_nz_earnings_rates": {
   "id": "xero_payroll_nz_earnings_rates",
   "primaryKey": [
    "earnings_rate_id"
   ],
   "recordIdField": "earningsRateID",
   "sourceObjects": [
    "payroll_nz:EarningsRate"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /EarningsRates",
    "envelope": "EarningsRates",
    "arrayKey": "earningsRates",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_nz:EarningsRate.earningsRateID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_nz:EarningsRate.name"
    },
    {
     "name": "earnings_type",
     "type": "text",
     "api": "payroll_nz:EarningsRate.earningsType"
    },
    {
     "name": "rate_type",
     "type": "text",
     "api": "payroll_nz:EarningsRate.rateType"
    },
    {
     "name": "type_of_units",
     "type": "text",
     "api": "payroll_nz:EarningsRate.typeOfUnits"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_nz:EarningsRate.currentRecord"
    },
    {
     "name": "expense_account_id",
     "type": "text",
     "api": "payroll_nz:EarningsRate.expenseAccountID"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_nz:EarningsRate.ratePerUnit"
    },
    {
     "name": "multiple_of_ordinary_earnings_rate",
     "type": "numeric",
     "api": "payroll_nz:EarningsRate.multipleOfOrdinaryEarningsRate"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_nz:EarningsRate.fixedAmount"
    }
   ]
  },
  "xero_payroll_nz_employee_bank_accounts": {
   "id": "xero_payroll_nz_employee_bank_accounts",
   "primaryKey": [
    "employee_id",
    "bank_accounts"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:BankAccount"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/PaymentMethods",
    "envelope": "PaymentMethodObject",
    "arrayKey": "paymentMethod",
    "explodePath": "PaymentMethod.bankAccounts",
    "explodeChain": [
     "PaymentMethod",
     "BankAccount"
    ],
    "parentTable": "xero_payroll_nz_employee_payment_methods",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "synthetic:EmployeeID path parameter of GET /Employees/{EmployeeID}/PaymentMethods, denormalized onto each exploded bank account (Employee.employeeID is the real-world source; neither BankAccount nor PaymentMethod carries it in the payload)"
    },
    {
     "name": "bank_accounts",
     "type": "integer",
     "api": "payroll_nz:PaymentMethod.bankAccounts"
    },
    {
     "name": "account_name",
     "type": "text",
     "api": "payroll_nz:BankAccount.accountName"
    },
    {
     "name": "account_number",
     "type": "text",
     "api": "payroll_nz:BankAccount.accountNumber"
    },
    {
     "name": "sort_code",
     "type": "text",
     "api": "payroll_nz:BankAccount.sortCode"
    },
    {
     "name": "particulars",
     "type": "text",
     "api": "payroll_nz:BankAccount.particulars"
    },
    {
     "name": "code",
     "type": "text",
     "api": "payroll_nz:BankAccount.code"
    },
    {
     "name": "dollar_amount",
     "type": "numeric",
     "api": "payroll_nz:BankAccount.dollarAmount"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "payroll_nz:BankAccount.reference"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_nz:BankAccount.calculationType"
    }
   ]
  },
  "xero_payroll_nz_employee_leave": {
   "id": "xero_payroll_nz_employee_leave",
   "primaryKey": [
    "leave_id"
   ],
   "recordIdField": "leaveID",
   "sourceObjects": [
    "payroll_nz:EmployeeLeave"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/Leave",
    "envelope": "EmployeeLeaves",
    "arrayKey": "leave",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_nz_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": "updatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "leave_id",
     "type": "text",
     "api": "payroll_nz:EmployeeLeave.leaveID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:Employee.employeeID"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_nz:EmployeeLeave.leaveTypeID"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_nz:EmployeeLeave.description"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_nz:EmployeeLeave.startDate"
    },
    {
     "name": "end_date",
     "type": "date",
     "api": "payroll_nz:EmployeeLeave.endDate"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_nz:EmployeeLeave.updatedDateUTC"
    }
   ]
  },
  "xero_payroll_nz_employee_leave_balances": {
   "id": "xero_payroll_nz_employee_leave_balances",
   "primaryKey": [
    "employee_id",
    "leave_type_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:EmployeeLeaveBalance"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/LeaveBalances",
    "envelope": "EmployeeLeaveBalances",
    "arrayKey": "leaveBalances",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_nz_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:Employee.employeeID"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_nz:EmployeeLeaveBalance.leaveTypeID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_nz:EmployeeLeaveBalance.name"
    },
    {
     "name": "balance",
     "type": "numeric",
     "api": "payroll_nz:EmployeeLeaveBalance.balance"
    },
    {
     "name": "type_of_units",
     "type": "text",
     "api": "payroll_nz:EmployeeLeaveBalance.typeOfUnits"
    }
   ]
  },
  "xero_payroll_nz_employee_leave_periods": {
   "id": "xero_payroll_nz_employee_leave_periods",
   "primaryKey": [
    "leave_id",
    "periods"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:LeavePeriod"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/Leave",
    "envelope": "EmployeeLeaves",
    "arrayKey": "leave",
    "explodePath": "EmployeeLeave.periods",
    "explodeChain": [
     "EmployeeLeave",
     "LeavePeriod"
    ],
    "parentTable": "xero_payroll_nz_employee_leave",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "leave_id",
     "type": "text",
     "api": "payroll_nz:EmployeeLeave.leaveID"
    },
    {
     "name": "periods",
     "type": "integer",
     "api": "payroll_nz:EmployeeLeave.periods"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "synthetic:EmployeeID path parameter of GET /Employees/{EmployeeID}/Leave, denormalized onto each exploded period (Employee.employeeID is the real-world source; neither LeavePeriod nor EmployeeLeave carries it in the payload)"
    },
    {
     "name": "period_start_date",
     "type": "date",
     "api": "payroll_nz:LeavePeriod.periodStartDate"
    },
    {
     "name": "period_end_date",
     "type": "date",
     "api": "payroll_nz:LeavePeriod.periodEndDate"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_nz:LeavePeriod.numberOfUnits"
    },
    {
     "name": "number_of_units_taken",
     "type": "numeric",
     "api": "payroll_nz:LeavePeriod.numberOfUnitsTaken"
    },
    {
     "name": "type_of_units",
     "type": "text",
     "api": "payroll_nz:LeavePeriod.typeOfUnits"
    },
    {
     "name": "type_of_units_taken",
     "type": "text",
     "api": "payroll_nz:LeavePeriod.typeOfUnitsTaken"
    },
    {
     "name": "period_status",
     "type": "text",
     "api": "payroll_nz:LeavePeriod.periodStatus"
    }
   ]
  },
  "xero_payroll_nz_employee_leave_types": {
   "id": "xero_payroll_nz_employee_leave_types",
   "primaryKey": [
    "employee_id",
    "leave_type_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:EmployeeLeaveType"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/LeaveTypes",
    "envelope": "EmployeeLeaveTypes",
    "arrayKey": "leaveTypes",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_nz_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:Employee.employeeID"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_nz:EmployeeLeaveType.leaveTypeID"
    },
    {
     "name": "schedule_of_accrual",
     "type": "text",
     "api": "payroll_nz:EmployeeLeaveType.scheduleOfAccrual"
    },
    {
     "name": "units_accrued_annually",
     "type": "numeric",
     "api": "payroll_nz:EmployeeLeaveType.unitsAccruedAnnually"
    },
    {
     "name": "type_of_units_to_accrue",
     "type": "text",
     "api": "payroll_nz:EmployeeLeaveType.typeOfUnitsToAccrue"
    },
    {
     "name": "maximum_to_accrue",
     "type": "numeric",
     "api": "payroll_nz:EmployeeLeaveType.maximumToAccrue"
    },
    {
     "name": "opening_balance",
     "type": "numeric",
     "api": "payroll_nz:EmployeeLeaveType.openingBalance"
    },
    {
     "name": "opening_balance_type_of_units",
     "type": "text",
     "api": "payroll_nz:EmployeeLeaveType.openingBalanceTypeOfUnits"
    },
    {
     "name": "rate_accrued_hourly",
     "type": "numeric",
     "api": "payroll_nz:EmployeeLeaveType.rateAccruedHourly"
    },
    {
     "name": "percentage_of_gross_earnings",
     "type": "numeric",
     "api": "payroll_nz:EmployeeLeaveType.percentageOfGrossEarnings"
    },
    {
     "name": "include_holiday_pay_every_pay",
     "type": "boolean",
     "api": "payroll_nz:EmployeeLeaveType.includeHolidayPayEveryPay"
    },
    {
     "name": "show_annual_leave_in_advance",
     "type": "boolean",
     "api": "payroll_nz:EmployeeLeaveType.showAnnualLeaveInAdvance"
    },
    {
     "name": "annual_leave_total_amount_paid",
     "type": "numeric",
     "api": "payroll_nz:EmployeeLeaveType.annualLeaveTotalAmountPaid"
    },
    {
     "name": "schedule_of_accrual_date",
     "type": "date",
     "api": "payroll_nz:EmployeeLeaveType.scheduleOfAccrualDate"
    }
   ]
  },
  "xero_payroll_nz_employee_opening_balances": {
   "id": "xero_payroll_nz_employee_opening_balances",
   "primaryKey": [
    "employee_id",
    "balance_ordinal"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:EmployeeOpeningBalance"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/OpeningBalances",
    "envelope": "EmployeeOpeningBalancesObject",
    "arrayKey": "openingBalances",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_nz_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:Employee.employeeID"
    },
    {
     "name": "balance_ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position in the openingBalances array of EmployeeOpeningBalancesObject"
    },
    {
     "name": "period_end_date",
     "type": "date",
     "api": "payroll_nz:EmployeeOpeningBalance.periodEndDate"
    },
    {
     "name": "days_paid",
     "type": "integer",
     "api": "payroll_nz:EmployeeOpeningBalance.daysPaid"
    },
    {
     "name": "unpaid_weeks",
     "type": "integer",
     "api": "payroll_nz:EmployeeOpeningBalance.unpaidWeeks"
    },
    {
     "name": "gross_earnings",
     "type": "numeric",
     "api": "payroll_nz:EmployeeOpeningBalance.grossEarnings"
    }
   ]
  },
  "xero_payroll_nz_employee_pay_template_earnings": {
   "id": "xero_payroll_nz_employee_pay_template_earnings",
   "primaryKey": [
    "employee_id",
    "pay_template_earning_id"
   ],
   "recordIdField": "payTemplateEarningID",
   "sourceObjects": [
    "payroll_nz:EarningsTemplate",
    "payroll_nz:EmployeePayTemplate"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/PayTemplates",
    "envelope": "EmployeePayTemplates",
    "arrayKey": "payTemplate",
    "explodePath": "EmployeePayTemplate.earningTemplates",
    "explodeChain": [
     "EmployeePayTemplate",
     "EarningsTemplates"
    ],
    "parentTable": "xero_payroll_nz_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:EmployeePayTemplate.employeeID"
    },
    {
     "name": "pay_template_earning_id",
     "type": "text",
     "api": "payroll_nz:EarningsTemplate.payTemplateEarningID"
    },
    {
     "name": "earning_templates",
     "type": "integer",
     "api": "payroll_nz:EmployeePayTemplate.earningTemplates"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_nz:EarningsTemplate.earningsRateID"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_nz:EarningsTemplate.ratePerUnit"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_nz:EarningsTemplate.numberOfUnits"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_nz:EarningsTemplate.fixedAmount"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_nz:EarningsTemplate.name"
    }
   ]
  },
  "xero_payroll_nz_employee_payment_methods": {
   "id": "xero_payroll_nz_employee_payment_methods",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:PaymentMethod"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/PaymentMethods",
    "envelope": "PaymentMethodObject",
    "arrayKey": "paymentMethod",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_nz_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:Employee.employeeID"
    },
    {
     "name": "payment_method",
     "type": "text",
     "api": "payroll_nz:PaymentMethod.paymentMethod"
    }
   ]
  },
  "xero_payroll_nz_employee_tax": {
   "id": "xero_payroll_nz_employee_tax",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:EmployeeTax"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/Tax",
    "envelope": "EmployeeTaxObject",
    "arrayKey": "employeeTax",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_nz_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:Employee.employeeID"
    },
    {
     "name": "ird_number",
     "type": "text",
     "api": "payroll_nz:EmployeeTax.irdNumber"
    },
    {
     "name": "tax_code",
     "type": "text",
     "api": "payroll_nz:EmployeeTax.taxCode"
    },
    {
     "name": "special_tax_rate_percentage",
     "type": "numeric",
     "api": "payroll_nz:EmployeeTax.specialTaxRatePercentage"
    },
    {
     "name": "has_special_student_loan_rate",
     "type": "boolean",
     "api": "payroll_nz:EmployeeTax.hasSpecialStudentLoanRate"
    },
    {
     "name": "special_student_loan_rate_percentage",
     "type": "numeric",
     "api": "payroll_nz:EmployeeTax.specialStudentLoanRatePercentage"
    },
    {
     "name": "is_eligible_for_kiwi_saver",
     "type": "boolean",
     "api": "payroll_nz:EmployeeTax.isEligibleForKiwiSaver"
    },
    {
     "name": "esct_rate_percentage",
     "type": "numeric",
     "api": "payroll_nz:EmployeeTax.esctRatePercentage"
    },
    {
     "name": "kiwi_saver_contributions",
     "type": "text",
     "api": "payroll_nz:EmployeeTax.kiwiSaverContributions"
    },
    {
     "name": "kiwi_saver_employee_contribution_rate_percentage",
     "type": "numeric",
     "api": "payroll_nz:EmployeeTax.kiwiSaverEmployeeContributionRatePercentage"
    },
    {
     "name": "kiwi_saver_employer_contribution_rate_percentage",
     "type": "numeric",
     "api": "payroll_nz:EmployeeTax.kiwiSaverEmployerContributionRatePercentage"
    },
    {
     "name": "kiwi_saver_employer_salary_sacrifice_contribution_rate_percentage",
     "type": "numeric",
     "api": "payroll_nz:EmployeeTax.kiwiSaverEmployerSalarySacrificeContributionRatePercentage"
    },
    {
     "name": "kiwi_saver_opt_out_date",
     "type": "date",
     "api": "payroll_nz:EmployeeTax.kiwiSaverOptOutDate"
    },
    {
     "name": "kiwi_saver_contribution_holiday_end_date",
     "type": "date",
     "api": "payroll_nz:EmployeeTax.kiwiSaverContributionHolidayEndDate"
    },
    {
     "name": "has_student_loan_balance",
     "type": "boolean",
     "api": "payroll_nz:EmployeeTax.hasStudentLoanBalance"
    },
    {
     "name": "student_loan_balance",
     "type": "numeric",
     "api": "payroll_nz:EmployeeTax.studentLoanBalance"
    },
    {
     "name": "student_loan_as_at",
     "type": "date",
     "api": "payroll_nz:EmployeeTax.studentLoanAsAt"
    }
   ]
  },
  "xero_payroll_nz_employee_working_patterns": {
   "id": "xero_payroll_nz_employee_working_patterns",
   "primaryKey": [
    "payee_working_pattern_id"
   ],
   "recordIdField": "payeeWorkingPatternID",
   "sourceObjects": [
    "payroll_nz:EmployeeWorkingPattern"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/Working-Patterns",
    "envelope": "EmployeeWorkingPatternsObject",
    "arrayKey": "workingPatterns",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_nz_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "payee_working_pattern_id",
     "type": "text",
     "api": "payroll_nz:EmployeeWorkingPattern.payeeWorkingPatternID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:Employee.employeeID"
    },
    {
     "name": "effective_from",
     "type": "date",
     "api": "payroll_nz:EmployeeWorkingPattern.effectiveFrom"
    }
   ]
  },
  "xero_payroll_nz_employee_working_weeks": {
   "id": "xero_payroll_nz_employee_working_weeks",
   "primaryKey": [
    "payee_working_pattern_id",
    "working_weeks"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:WorkingWeek",
    "payroll_nz:EmployeeWorkingPatternWithWorkingWeeks"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/Working-Patterns/{EmployeeWorkingPatternID}",
    "envelope": "EmployeeWorkingPatternWithWorkingWeeksObject",
    "arrayKey": "workingPattern",
    "explodePath": "EmployeeWorkingPatternWithWorkingWeeks.workingWeeks",
    "explodeChain": [
     "EmployeeWorkingPatternWithWorkingWeeks",
     "WorkingWeeks"
    ],
    "parentTable": "xero_payroll_nz_employee_working_patterns",
    "fanOutParam": "EmployeeWorkingPatternID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "payee_working_pattern_id",
     "type": "text",
     "api": "payroll_nz:EmployeeWorkingPatternWithWorkingWeeks.payeeWorkingPatternID"
    },
    {
     "name": "working_weeks",
     "type": "integer",
     "api": "payroll_nz:EmployeeWorkingPatternWithWorkingWeeks.workingWeeks"
    },
    {
     "name": "effective_from",
     "type": "date",
     "api": "payroll_nz:EmployeeWorkingPatternWithWorkingWeeks.effectiveFrom"
    },
    {
     "name": "monday",
     "type": "numeric",
     "api": "payroll_nz:WorkingWeek.monday"
    },
    {
     "name": "tuesday",
     "type": "numeric",
     "api": "payroll_nz:WorkingWeek.tuesday"
    },
    {
     "name": "wednesday",
     "type": "numeric",
     "api": "payroll_nz:WorkingWeek.wednesday"
    },
    {
     "name": "thursday",
     "type": "numeric",
     "api": "payroll_nz:WorkingWeek.thursday"
    },
    {
     "name": "friday",
     "type": "numeric",
     "api": "payroll_nz:WorkingWeek.friday"
    },
    {
     "name": "saturday",
     "type": "numeric",
     "api": "payroll_nz:WorkingWeek.saturday"
    },
    {
     "name": "sunday",
     "type": "numeric",
     "api": "payroll_nz:WorkingWeek.sunday"
    }
   ]
  },
  "xero_payroll_nz_employees": {
   "id": "xero_payroll_nz_employees",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": "employeeID",
   "sourceObjects": [
    "payroll_nz:Employee",
    "payroll_nz:Address"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees",
    "envelope": "Employees",
    "arrayKey": "employees",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "updatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:Employee.employeeID"
    },
    {
     "name": "title",
     "type": "text",
     "api": "payroll_nz:Employee.title"
    },
    {
     "name": "first_name",
     "type": "text",
     "api": "payroll_nz:Employee.firstName"
    },
    {
     "name": "last_name",
     "type": "text",
     "api": "payroll_nz:Employee.lastName"
    },
    {
     "name": "date_of_birth",
     "type": "date",
     "api": "payroll_nz:Employee.dateOfBirth"
    },
    {
     "name": "address_address_line1",
     "type": "text",
     "api": "payroll_nz:Employee.address.addressLine1"
    },
    {
     "name": "address_address_line2",
     "type": "text",
     "api": "payroll_nz:Employee.address.addressLine2"
    },
    {
     "name": "address_city",
     "type": "text",
     "api": "payroll_nz:Employee.address.city"
    },
    {
     "name": "address_suburb",
     "type": "text",
     "api": "payroll_nz:Employee.address.suburb"
    },
    {
     "name": "address_post_code",
     "type": "text",
     "api": "payroll_nz:Employee.address.postCode"
    },
    {
     "name": "address_country_name",
     "type": "text",
     "api": "payroll_nz:Employee.address.countryName"
    },
    {
     "name": "email",
     "type": "text",
     "api": "payroll_nz:Employee.email"
    },
    {
     "name": "gender",
     "type": "text",
     "api": "payroll_nz:Employee.gender"
    },
    {
     "name": "phone_number",
     "type": "text",
     "api": "payroll_nz:Employee.phoneNumber"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_nz:Employee.startDate"
    },
    {
     "name": "end_date",
     "type": "date",
     "api": "payroll_nz:Employee.endDate"
    },
    {
     "name": "payroll_calendar_id",
     "type": "text",
     "api": "payroll_nz:Employee.payrollCalendarID"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_nz:Employee.updatedDateUTC"
    },
    {
     "name": "created_date_utc",
     "type": "timestamp",
     "api": "payroll_nz:Employee.createdDateUTC"
    },
    {
     "name": "job_title",
     "type": "text",
     "api": "payroll_nz:Employee.jobTitle"
    },
    {
     "name": "engagement_type",
     "type": "text",
     "api": "payroll_nz:Employee.engagementType"
    },
    {
     "name": "fixed_term_end_date",
     "type": "date",
     "api": "payroll_nz:Employee.fixedTermEndDate"
    }
   ]
  },
  "xero_payroll_nz_leave_types": {
   "id": "xero_payroll_nz_leave_types",
   "primaryKey": [
    "leave_type_id"
   ],
   "recordIdField": "leaveTypeID",
   "sourceObjects": [
    "payroll_nz:LeaveType"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /LeaveTypes",
    "envelope": "LeaveTypes",
    "arrayKey": "leaveTypes",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "updatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_nz:LeaveType.leaveTypeID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_nz:LeaveType.name"
    },
    {
     "name": "is_paid_leave",
     "type": "boolean",
     "api": "payroll_nz:LeaveType.isPaidLeave"
    },
    {
     "name": "show_on_payslip",
     "type": "boolean",
     "api": "payroll_nz:LeaveType.showOnPayslip"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_nz:LeaveType.updatedDateUTC"
    },
    {
     "name": "is_active",
     "type": "boolean",
     "api": "payroll_nz:LeaveType.isActive"
    },
    {
     "name": "type_of_units",
     "type": "text",
     "api": "payroll_nz:LeaveType.typeOfUnits"
    },
    {
     "name": "type_of_units_to_accrue",
     "type": "text",
     "api": "payroll_nz:LeaveType.typeOfUnitsToAccrue"
    }
   ]
  },
  "xero_payroll_nz_pay_run_calendars": {
   "id": "xero_payroll_nz_pay_run_calendars",
   "primaryKey": [
    "payroll_calendar_id"
   ],
   "recordIdField": "payrollCalendarID",
   "sourceObjects": [
    "payroll_nz:PayRunCalendar"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PayRunCalendars",
    "envelope": "PayRunCalendars",
    "arrayKey": "payRunCalendars",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "updatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payroll_calendar_id",
     "type": "text",
     "api": "payroll_nz:PayRunCalendar.payrollCalendarID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_nz:PayRunCalendar.name"
    },
    {
     "name": "calendar_type",
     "type": "text",
     "api": "payroll_nz:PayRunCalendar.calendarType"
    },
    {
     "name": "period_start_date",
     "type": "date",
     "api": "payroll_nz:PayRunCalendar.periodStartDate"
    },
    {
     "name": "period_end_date",
     "type": "date",
     "api": "payroll_nz:PayRunCalendar.periodEndDate"
    },
    {
     "name": "payment_date",
     "type": "date",
     "api": "payroll_nz:PayRunCalendar.paymentDate"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_nz:PayRunCalendar.updatedDateUTC"
    }
   ]
  },
  "xero_payroll_nz_pay_runs": {
   "id": "xero_payroll_nz_pay_runs",
   "primaryKey": [
    "pay_run_id"
   ],
   "recordIdField": "payRunID",
   "sourceObjects": [
    "payroll_nz:PayRun"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PayRuns",
    "envelope": "PayRuns",
    "arrayKey": "payRuns",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payruns",
     "payroll.payruns.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_run_id",
     "type": "text",
     "api": "payroll_nz:PayRun.payRunID"
    },
    {
     "name": "payroll_calendar_id",
     "type": "text",
     "api": "payroll_nz:PayRun.payrollCalendarID"
    },
    {
     "name": "period_start_date",
     "type": "date",
     "api": "payroll_nz:PayRun.periodStartDate"
    },
    {
     "name": "period_end_date",
     "type": "date",
     "api": "payroll_nz:PayRun.periodEndDate"
    },
    {
     "name": "payment_date",
     "type": "date",
     "api": "payroll_nz:PayRun.paymentDate"
    },
    {
     "name": "total_cost",
     "type": "numeric",
     "api": "payroll_nz:PayRun.totalCost"
    },
    {
     "name": "total_pay",
     "type": "numeric",
     "api": "payroll_nz:PayRun.totalPay"
    },
    {
     "name": "pay_run_status",
     "type": "text",
     "api": "payroll_nz:PayRun.payRunStatus"
    },
    {
     "name": "pay_run_type",
     "type": "text",
     "api": "payroll_nz:PayRun.payRunType"
    },
    {
     "name": "calendar_type",
     "type": "text",
     "api": "payroll_nz:PayRun.calendarType"
    },
    {
     "name": "posted_date_time",
     "type": "timestamp",
     "api": "payroll_nz:PayRun.postedDateTime"
    },
    {
     "name": "pay_slips",
     "type": "jsonb",
     "api": "payroll_nz:PayRun.paySlips"
    }
   ]
  },
  "xero_payroll_nz_payslip_deduction_lines": {
   "id": "xero_payroll_nz_payslip_deduction_lines",
   "primaryKey": [
    "pay_slip_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:DeductionLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": "PaySlip.deductionLines",
    "explodeChain": [
     "PaySlip",
     "DeductionLines"
    ],
    "parentTable": "xero_payroll_nz_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based ordinal of the line within payroll_nz:PaySlip.deductionLines"
    },
    {
     "name": "deduction_type_id",
     "type": "text",
     "api": "payroll_nz:DeductionLine.deductionTypeID"
    },
    {
     "name": "display_name",
     "type": "text",
     "api": "payroll_nz:DeductionLine.displayName"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_nz:DeductionLine.amount"
    },
    {
     "name": "subject_to_tax",
     "type": "boolean",
     "api": "payroll_nz:DeductionLine.subjectToTax"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_nz:DeductionLine.percentage"
    }
   ]
  },
  "xero_payroll_nz_payslip_earnings_lines": {
   "id": "xero_payroll_nz_payslip_earnings_lines",
   "primaryKey": [
    "pay_slip_id",
    "line_index"
   ],
   "recordIdField": "earningsLineID",
   "sourceObjects": [
    "payroll_nz:EarningsLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": "PaySlip.earningsLines",
    "explodeChain": [
     "PaySlip",
     "EarningsLines"
    ],
    "parentTable": "xero_payroll_nz_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based ordinal of the line within payroll_nz:PaySlip.earningsLines"
    },
    {
     "name": "earnings_line_id",
     "type": "text",
     "api": "payroll_nz:EarningsLine.earningsLineID"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_nz:EarningsLine.earningsRateID"
    },
    {
     "name": "display_name",
     "type": "text",
     "api": "payroll_nz:EarningsLine.displayName"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_nz:EarningsLine.ratePerUnit"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_nz:EarningsLine.numberOfUnits"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_nz:EarningsLine.fixedAmount"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_nz:EarningsLine.amount"
    },
    {
     "name": "is_linked_to_timesheet",
     "type": "boolean",
     "api": "payroll_nz:EarningsLine.isLinkedToTimesheet"
    },
    {
     "name": "is_average_daily_pay_rate",
     "type": "boolean",
     "api": "payroll_nz:EarningsLine.isAverageDailyPayRate"
    },
    {
     "name": "is_system_generated",
     "type": "boolean",
     "api": "payroll_nz:EarningsLine.isSystemGenerated"
    }
   ]
  },
  "xero_payroll_nz_payslip_employee_tax_lines": {
   "id": "xero_payroll_nz_payslip_employee_tax_lines",
   "primaryKey": [
    "pay_slip_id",
    "line_index"
   ],
   "recordIdField": "taxLineID",
   "sourceObjects": [
    "payroll_nz:TaxLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": "PaySlip.employeeTaxLines",
    "explodeChain": [
     "PaySlip",
     "TaxLines"
    ],
    "parentTable": "xero_payroll_nz_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based ordinal of the line within payroll_nz:PaySlip.employeeTaxLines"
    },
    {
     "name": "tax_line_id",
     "type": "text",
     "api": "payroll_nz:TaxLine.taxLineID"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_nz:TaxLine.description"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_nz:TaxLine.amount"
    },
    {
     "name": "global_tax_type_id",
     "type": "text",
     "api": "payroll_nz:TaxLine.globalTaxTypeID"
    },
    {
     "name": "manual_adjustment",
     "type": "boolean",
     "api": "payroll_nz:TaxLine.manualAdjustment"
    }
   ]
  },
  "xero_payroll_nz_payslip_employer_tax_lines": {
   "id": "xero_payroll_nz_payslip_employer_tax_lines",
   "primaryKey": [
    "pay_slip_id",
    "line_index"
   ],
   "recordIdField": "taxLineID",
   "sourceObjects": [
    "payroll_nz:TaxLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": "PaySlip.employerTaxLines",
    "explodeChain": [
     "PaySlip",
     "TaxLines"
    ],
    "parentTable": "xero_payroll_nz_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based ordinal of the line within payroll_nz:PaySlip.employerTaxLines"
    },
    {
     "name": "tax_line_id",
     "type": "text",
     "api": "payroll_nz:TaxLine.taxLineID"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_nz:TaxLine.description"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_nz:TaxLine.amount"
    },
    {
     "name": "global_tax_type_id",
     "type": "text",
     "api": "payroll_nz:TaxLine.globalTaxTypeID"
    },
    {
     "name": "manual_adjustment",
     "type": "boolean",
     "api": "payroll_nz:TaxLine.manualAdjustment"
    }
   ]
  },
  "xero_payroll_nz_payslip_leave_accrual_lines": {
   "id": "xero_payroll_nz_payslip_leave_accrual_lines",
   "primaryKey": [
    "pay_slip_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:LeaveAccrualLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": "PaySlip.leaveAccrualLines",
    "explodeChain": [
     "PaySlip",
     "LeaveAccrualLines"
    ],
    "parentTable": "xero_payroll_nz_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based ordinal of the line within payroll_nz:PaySlip.leaveAccrualLines"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_nz:LeaveAccrualLine.leaveTypeID"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_nz:LeaveAccrualLine.numberOfUnits"
    }
   ]
  },
  "xero_payroll_nz_payslip_leave_earnings_lines": {
   "id": "xero_payroll_nz_payslip_leave_earnings_lines",
   "primaryKey": [
    "pay_slip_id",
    "line_index"
   ],
   "recordIdField": "earningsLineID",
   "sourceObjects": [
    "payroll_nz:LeaveEarningsLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": "PaySlip.leaveEarningsLines",
    "explodeChain": [
     "PaySlip",
     "LeaveEarningsLines"
    ],
    "parentTable": "xero_payroll_nz_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based ordinal of the line within payroll_nz:PaySlip.leaveEarningsLines"
    },
    {
     "name": "earnings_line_id",
     "type": "text",
     "api": "payroll_nz:LeaveEarningsLine.earningsLineID"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_nz:LeaveEarningsLine.earningsRateID"
    },
    {
     "name": "display_name",
     "type": "text",
     "api": "payroll_nz:LeaveEarningsLine.displayName"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_nz:LeaveEarningsLine.ratePerUnit"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_nz:LeaveEarningsLine.numberOfUnits"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_nz:LeaveEarningsLine.fixedAmount"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_nz:LeaveEarningsLine.amount"
    },
    {
     "name": "is_linked_to_timesheet",
     "type": "boolean",
     "api": "payroll_nz:LeaveEarningsLine.isLinkedToTimesheet"
    },
    {
     "name": "is_average_daily_pay_rate",
     "type": "boolean",
     "api": "payroll_nz:LeaveEarningsLine.isAverageDailyPayRate"
    },
    {
     "name": "is_system_generated",
     "type": "boolean",
     "api": "payroll_nz:LeaveEarningsLine.isSystemGenerated"
    }
   ]
  },
  "xero_payroll_nz_payslip_payment_lines": {
   "id": "xero_payroll_nz_payslip_payment_lines",
   "primaryKey": [
    "pay_slip_id",
    "line_index"
   ],
   "recordIdField": "paymentLineID",
   "sourceObjects": [
    "payroll_nz:PaymentLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": "PaySlip.paymentLines",
    "explodeChain": [
     "PaySlip",
     "PaymentLines"
    ],
    "parentTable": "xero_payroll_nz_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based ordinal of the line within payroll_nz:PaySlip.paymentLines"
    },
    {
     "name": "payment_line_id",
     "type": "text",
     "api": "payroll_nz:PaymentLine.paymentLineID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_nz:PaymentLine.amount"
    },
    {
     "name": "account_number",
     "type": "text",
     "api": "payroll_nz:PaymentLine.accountNumber"
    },
    {
     "name": "sort_code",
     "type": "text",
     "api": "payroll_nz:PaymentLine.sortCode"
    },
    {
     "name": "account_name",
     "type": "text",
     "api": "payroll_nz:PaymentLine.accountName"
    }
   ]
  },
  "xero_payroll_nz_payslip_reimbursement_lines": {
   "id": "xero_payroll_nz_payslip_reimbursement_lines",
   "primaryKey": [
    "pay_slip_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:ReimbursementLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": "PaySlip.reimbursementLines",
    "explodeChain": [
     "PaySlip",
     "ReimbursementLines"
    ],
    "parentTable": "xero_payroll_nz_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based ordinal of the line within payroll_nz:PaySlip.reimbursementLines"
    },
    {
     "name": "reimbursement_type_id",
     "type": "text",
     "api": "payroll_nz:ReimbursementLine.reimbursementTypeID"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_nz:ReimbursementLine.description"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_nz:ReimbursementLine.amount"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_nz:ReimbursementLine.ratePerUnit"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_nz:ReimbursementLine.numberOfUnits"
    }
   ]
  },
  "xero_payroll_nz_payslip_statutory_deduction_lines": {
   "id": "xero_payroll_nz_payslip_statutory_deduction_lines",
   "primaryKey": [
    "pay_slip_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:StatutoryDeductionLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": "PaySlip.statutoryDeductionLines",
    "explodeChain": [
     "PaySlip",
     "StatutoryDeductionLines"
    ],
    "parentTable": "xero_payroll_nz_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based ordinal of the line within payroll_nz:PaySlip.statutoryDeductionLines"
    },
    {
     "name": "statutory_deduction_type_id",
     "type": "text",
     "api": "payroll_nz:StatutoryDeductionLine.statutoryDeductionTypeID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_nz:StatutoryDeductionLine.amount"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_nz:StatutoryDeductionLine.fixedAmount"
    },
    {
     "name": "manual_adjustment",
     "type": "boolean",
     "api": "payroll_nz:StatutoryDeductionLine.manualAdjustment"
    }
   ]
  },
  "xero_payroll_nz_payslip_superannuation_lines": {
   "id": "xero_payroll_nz_payslip_superannuation_lines",
   "primaryKey": [
    "pay_slip_id",
    "line_index"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:SuperannuationLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": "PaySlip.superannuationLines",
    "explodeChain": [
     "PaySlip",
     "SuperannuationLines"
    ],
    "parentTable": "xero_payroll_nz_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based ordinal of the line within payroll_nz:PaySlip.superannuationLines"
    },
    {
     "name": "superannuation_type_id",
     "type": "text",
     "api": "payroll_nz:SuperannuationLine.superannuationTypeID"
    },
    {
     "name": "display_name",
     "type": "text",
     "api": "payroll_nz:SuperannuationLine.displayName"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_nz:SuperannuationLine.amount"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_nz:SuperannuationLine.fixedAmount"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_nz:SuperannuationLine.percentage"
    },
    {
     "name": "manual_adjustment",
     "type": "boolean",
     "api": "payroll_nz:SuperannuationLine.manualAdjustment"
    }
   ]
  },
  "xero_payroll_nz_payslip_timesheet_earnings_lines": {
   "id": "xero_payroll_nz_payslip_timesheet_earnings_lines",
   "primaryKey": [
    "pay_slip_id",
    "line_index"
   ],
   "recordIdField": "earningsLineID",
   "sourceObjects": [
    "payroll_nz:TimesheetEarningsLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": "PaySlip.timesheetEarningsLines",
    "explodeChain": [
     "PaySlip",
     "TimesheetEarningsLines"
    ],
    "parentTable": "xero_payroll_nz_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "line_index",
     "type": "integer",
     "api": "synthetic:zero-based ordinal of the line within payroll_nz:PaySlip.timesheetEarningsLines"
    },
    {
     "name": "earnings_line_id",
     "type": "text",
     "api": "payroll_nz:TimesheetEarningsLine.earningsLineID"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_nz:TimesheetEarningsLine.earningsRateID"
    },
    {
     "name": "display_name",
     "type": "text",
     "api": "payroll_nz:TimesheetEarningsLine.displayName"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_nz:TimesheetEarningsLine.ratePerUnit"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_nz:TimesheetEarningsLine.numberOfUnits"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_nz:TimesheetEarningsLine.fixedAmount"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_nz:TimesheetEarningsLine.amount"
    },
    {
     "name": "is_linked_to_timesheet",
     "type": "boolean",
     "api": "payroll_nz:TimesheetEarningsLine.isLinkedToTimesheet"
    },
    {
     "name": "is_average_daily_pay_rate",
     "type": "boolean",
     "api": "payroll_nz:TimesheetEarningsLine.isAverageDailyPayRate"
    },
    {
     "name": "is_system_generated",
     "type": "boolean",
     "api": "payroll_nz:TimesheetEarningsLine.isSystemGenerated"
    }
   ]
  },
  "xero_payroll_nz_payslips": {
   "id": "xero_payroll_nz_payslips",
   "primaryKey": [
    "pay_slip_id"
   ],
   "recordIdField": "paySlipID",
   "sourceObjects": [
    "payroll_nz:PaySlip",
    "payroll_nz:TaxSettings",
    "payroll_nz:GrossEarningsHistory"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /PaySlips",
    "envelope": "PaySlips",
    "arrayKey": "paySlips",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "lastEdited",
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.paySlipID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.employeeID"
    },
    {
     "name": "pay_run_id",
     "type": "text",
     "api": "payroll_nz:PaySlip.payRunID"
    },
    {
     "name": "last_edited",
     "type": "timestamp",
     "api": "payroll_nz:PaySlip.lastEdited"
    },
    {
     "name": "first_name",
     "type": "text",
     "api": "payroll_nz:PaySlip.firstName"
    },
    {
     "name": "last_name",
     "type": "text",
     "api": "payroll_nz:PaySlip.lastName"
    },
    {
     "name": "total_earnings",
     "type": "numeric",
     "api": "payroll_nz:PaySlip.totalEarnings"
    },
    {
     "name": "gross_earnings",
     "type": "numeric",
     "api": "payroll_nz:PaySlip.grossEarnings"
    },
    {
     "name": "total_pay",
     "type": "numeric",
     "api": "payroll_nz:PaySlip.totalPay"
    },
    {
     "name": "total_employer_taxes",
     "type": "numeric",
     "api": "payroll_nz:PaySlip.totalEmployerTaxes"
    },
    {
     "name": "total_employee_taxes",
     "type": "numeric",
     "api": "payroll_nz:PaySlip.totalEmployeeTaxes"
    },
    {
     "name": "total_deductions",
     "type": "numeric",
     "api": "payroll_nz:PaySlip.totalDeductions"
    },
    {
     "name": "total_reimbursements",
     "type": "numeric",
     "api": "payroll_nz:PaySlip.totalReimbursements"
    },
    {
     "name": "total_statutory_deductions",
     "type": "numeric",
     "api": "payroll_nz:PaySlip.totalStatutoryDeductions"
    },
    {
     "name": "total_superannuation",
     "type": "numeric",
     "api": "payroll_nz:PaySlip.totalSuperannuation"
    },
    {
     "name": "bacs_hash",
     "type": "text",
     "api": "payroll_nz:PaySlip.bacsHash"
    },
    {
     "name": "payment_method",
     "type": "text",
     "api": "payroll_nz:PaySlip.paymentMethod"
    },
    {
     "name": "tax_settings_period_units",
     "type": "numeric",
     "api": "payroll_nz:PaySlip.taxSettings.periodUnits"
    },
    {
     "name": "tax_settings_period_type",
     "type": "text",
     "api": "payroll_nz:PaySlip.taxSettings.periodType"
    },
    {
     "name": "tax_settings_tax_code",
     "type": "text",
     "api": "payroll_nz:PaySlip.taxSettings.taxCode"
    },
    {
     "name": "tax_settings_special_tax_rate",
     "type": "text",
     "api": "payroll_nz:PaySlip.taxSettings.specialTaxRate"
    },
    {
     "name": "tax_settings_lump_sum_tax_code",
     "type": "text",
     "api": "payroll_nz:PaySlip.taxSettings.lumpSumTaxCode"
    },
    {
     "name": "tax_settings_lump_sum_amount",
     "type": "text",
     "api": "payroll_nz:PaySlip.taxSettings.lumpSumAmount"
    },
    {
     "name": "gross_earnings_history_days_paid",
     "type": "integer",
     "api": "payroll_nz:PaySlip.grossEarningsHistory.daysPaid"
    },
    {
     "name": "gross_earnings_history_unpaid_weeks",
     "type": "integer",
     "api": "payroll_nz:PaySlip.grossEarningsHistory.unpaidWeeks"
    },
    {
     "name": "earnings_lines",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.earningsLines"
    },
    {
     "name": "leave_earnings_lines",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.leaveEarningsLines"
    },
    {
     "name": "timesheet_earnings_lines",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.timesheetEarningsLines"
    },
    {
     "name": "deduction_lines",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.deductionLines"
    },
    {
     "name": "reimbursement_lines",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.reimbursementLines"
    },
    {
     "name": "leave_accrual_lines",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.leaveAccrualLines"
    },
    {
     "name": "superannuation_lines",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.superannuationLines"
    },
    {
     "name": "payment_lines",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.paymentLines"
    },
    {
     "name": "employee_tax_lines",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.employeeTaxLines"
    },
    {
     "name": "employer_tax_lines",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.employerTaxLines"
    },
    {
     "name": "statutory_deduction_lines",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.statutoryDeductionLines"
    },
    {
     "name": "tax_settings",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.taxSettings"
    },
    {
     "name": "gross_earnings_history",
     "type": "jsonb",
     "api": "payroll_nz:PaySlip.grossEarningsHistory"
    }
   ]
  },
  "xero_payroll_nz_reimbursements": {
   "id": "xero_payroll_nz_reimbursements",
   "primaryKey": [
    "reimbursement_id"
   ],
   "recordIdField": "reimbursementID",
   "sourceObjects": [
    "payroll_nz:Reimbursement"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Reimbursements",
    "envelope": "Reimbursements",
    "arrayKey": "reimbursements",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "reimbursement_id",
     "type": "text",
     "api": "payroll_nz:Reimbursement.reimbursementID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_nz:Reimbursement.name"
    },
    {
     "name": "account_id",
     "type": "text",
     "api": "payroll_nz:Reimbursement.accountID"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_nz:Reimbursement.currentRecord"
    },
    {
     "name": "reimbursement_category",
     "type": "text",
     "api": "payroll_nz:Reimbursement.reimbursementCategory"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_nz:Reimbursement.calculationType"
    },
    {
     "name": "standard_amount",
     "type": "numeric",
     "api": "payroll_nz:Reimbursement.standardAmount"
    },
    {
     "name": "standard_type_of_units",
     "type": "text",
     "api": "payroll_nz:Reimbursement.standardTypeOfUnits"
    },
    {
     "name": "standard_rate_per_unit",
     "type": "numeric",
     "api": "payroll_nz:Reimbursement.standardRatePerUnit"
    }
   ]
  },
  "xero_payroll_nz_salary_and_wages": {
   "id": "xero_payroll_nz_salary_and_wages",
   "primaryKey": [
    "salary_and_wages_id"
   ],
   "recordIdField": "salaryAndWagesID",
   "sourceObjects": [
    "payroll_nz:SalaryAndWage"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Employees/{EmployeeID}/SalaryAndWages",
    "envelope": "SalaryAndWages",
    "arrayKey": "salaryAndWages",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_nz_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "salary_and_wages_id",
     "type": "text",
     "api": "payroll_nz:SalaryAndWage.salaryAndWagesID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:Employee.employeeID"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_nz:SalaryAndWage.earningsRateID"
    },
    {
     "name": "number_of_units_per_week",
     "type": "numeric",
     "api": "payroll_nz:SalaryAndWage.numberOfUnitsPerWeek"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_nz:SalaryAndWage.ratePerUnit"
    },
    {
     "name": "number_of_units_per_day",
     "type": "numeric",
     "api": "payroll_nz:SalaryAndWage.numberOfUnitsPerDay"
    },
    {
     "name": "days_per_week",
     "type": "numeric",
     "api": "payroll_nz:SalaryAndWage.daysPerWeek"
    },
    {
     "name": "effective_from",
     "type": "date",
     "api": "payroll_nz:SalaryAndWage.effectiveFrom"
    },
    {
     "name": "annual_salary",
     "type": "numeric",
     "api": "payroll_nz:SalaryAndWage.annualSalary"
    },
    {
     "name": "status",
     "type": "text",
     "api": "payroll_nz:SalaryAndWage.status"
    },
    {
     "name": "payment_type",
     "type": "text",
     "api": "payroll_nz:SalaryAndWage.paymentType"
    },
    {
     "name": "work_pattern_type",
     "type": "text",
     "api": "payroll_nz:SalaryAndWage.workPatternType"
    }
   ]
  },
  "xero_payroll_nz_settings_accounts": {
   "id": "xero_payroll_nz_settings_accounts",
   "primaryKey": [
    "type"
   ],
   "recordIdField": "accountID",
   "sourceObjects": [
    "payroll_nz:Account"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Settings",
    "envelope": "Settings",
    "arrayKey": "settings.accounts",
    "explodePath": null,
    "explodeChain": [
     "Settings"
    ],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "account_id",
     "type": "text",
     "api": "payroll_nz:Account.accountID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "payroll_nz:Account.type"
    },
    {
     "name": "code",
     "type": "text",
     "api": "payroll_nz:Account.code"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_nz:Account.name"
    }
   ]
  },
  "xero_payroll_nz_statutory_deductions": {
   "id": "xero_payroll_nz_statutory_deductions",
   "primaryKey": [
    "id"
   ],
   "recordIdField": "id",
   "sourceObjects": [
    "payroll_nz:StatutoryDeduction"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /StatutoryDeductions",
    "envelope": "StatutoryDeductions",
    "arrayKey": "statutoryDeductions",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "id",
     "type": "text",
     "api": "payroll_nz:StatutoryDeduction.id"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_nz:StatutoryDeduction.name"
    },
    {
     "name": "statutory_deduction_category",
     "type": "text",
     "api": "payroll_nz:StatutoryDeduction.statutoryDeductionCategory"
    },
    {
     "name": "liability_account_id",
     "type": "text",
     "api": "payroll_nz:StatutoryDeduction.liabilityAccountId"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_nz:StatutoryDeduction.currentRecord"
    }
   ]
  },
  "xero_payroll_nz_superannuations": {
   "id": "xero_payroll_nz_superannuations",
   "primaryKey": [
    "id"
   ],
   "recordIdField": "id",
   "sourceObjects": [
    "payroll_nz:Benefit"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Superannuations",
    "envelope": "Superannuations",
    "arrayKey": "superannuations",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "id",
     "type": "text",
     "api": "payroll_nz:Benefit.id"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_nz:Benefit.name"
    },
    {
     "name": "category",
     "type": "text",
     "api": "payroll_nz:Benefit.category"
    },
    {
     "name": "liability_account_id",
     "type": "text",
     "api": "payroll_nz:Benefit.liabilityAccountId"
    },
    {
     "name": "expense_account_id",
     "type": "text",
     "api": "payroll_nz:Benefit.expenseAccountId"
    },
    {
     "name": "calculation_type_nz",
     "type": "text",
     "api": "payroll_nz:Benefit.calculationTypeNZ"
    },
    {
     "name": "standard_amount",
     "type": "numeric",
     "api": "payroll_nz:Benefit.standardAmount"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_nz:Benefit.percentage"
    },
    {
     "name": "company_max",
     "type": "numeric",
     "api": "payroll_nz:Benefit.companyMax"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_nz:Benefit.currentRecord"
    }
   ]
  },
  "xero_payroll_nz_timesheet_lines": {
   "id": "xero_payroll_nz_timesheet_lines",
   "primaryKey": [
    "timesheet_line_id"
   ],
   "recordIdField": "timesheetLineID",
   "sourceObjects": [
    "payroll_nz:TimesheetLine"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Timesheets",
    "envelope": "Timesheets",
    "arrayKey": "timesheets",
    "explodePath": "Timesheet.timesheetLines",
    "explodeChain": [
     "Timesheet",
     "TimesheetLines"
    ],
    "parentTable": "xero_payroll_nz_timesheets",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "payroll.timesheets",
     "payroll.timesheets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "timesheet_line_id",
     "type": "text",
     "api": "payroll_nz:TimesheetLine.timesheetLineID"
    },
    {
     "name": "timesheet_id",
     "type": "text",
     "api": "payroll_nz:Timesheet.timesheetID"
    },
    {
     "name": "timesheet_lines",
     "type": "integer",
     "api": "payroll_nz:Timesheet.timesheetLines"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:Timesheet.employeeID"
    },
    {
     "name": "date",
     "type": "date",
     "api": "payroll_nz:TimesheetLine.date"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_nz:TimesheetLine.earningsRateID"
    },
    {
     "name": "tracking_item_id",
     "type": "text",
     "api": "payroll_nz:TimesheetLine.trackingItemID"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_nz:TimesheetLine.numberOfUnits"
    }
   ]
  },
  "xero_payroll_nz_timesheets": {
   "id": "xero_payroll_nz_timesheets",
   "primaryKey": [
    "timesheet_id"
   ],
   "recordIdField": "timesheetID",
   "sourceObjects": [
    "payroll_nz:Timesheet"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Timesheets",
    "envelope": "Timesheets",
    "arrayKey": "timesheets",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "updatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "payroll.timesheets",
     "payroll.timesheets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "timesheet_id",
     "type": "text",
     "api": "payroll_nz:Timesheet.timesheetID"
    },
    {
     "name": "payroll_calendar_id",
     "type": "text",
     "api": "payroll_nz:Timesheet.payrollCalendarID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_nz:Timesheet.employeeID"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_nz:Timesheet.startDate"
    },
    {
     "name": "end_date",
     "type": "date",
     "api": "payroll_nz:Timesheet.endDate"
    },
    {
     "name": "status",
     "type": "text",
     "api": "payroll_nz:Timesheet.status"
    },
    {
     "name": "total_hours",
     "type": "numeric",
     "api": "payroll_nz:Timesheet.totalHours"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_nz:Timesheet.updatedDateUTC"
    }
   ]
  },
  "xero_payroll_nz_tracking_categories": {
   "id": "xero_payroll_nz_tracking_categories",
   "primaryKey": [
    "settings_key"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_nz:TrackingCategory"
   ],
   "source": {
    "api": "payroll_nz",
    "endpointOp": "GET /Settings/TrackingCategories",
    "envelope": "TrackingCategories",
    "arrayKey": "trackingCategories",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "settings_key",
     "type": "text",
     "api": "synthetic:constant 'payroll_nz' — the endpoint returns exactly one configuration record per tenant and it has no natural key"
    },
    {
     "name": "employee_groups_tracking_category_id",
     "type": "text",
     "api": "payroll_nz:TrackingCategory.employeeGroupsTrackingCategoryID"
    },
    {
     "name": "timesheet_tracking_category_id",
     "type": "text",
     "api": "payroll_nz:TrackingCategory.timesheetTrackingCategoryID"
    }
   ]
  },
  "xero_payroll_uk_benefits": {
   "id": "xero_payroll_uk_benefits",
   "primaryKey": [
    "id"
   ],
   "recordIdField": "id",
   "sourceObjects": [
    "payroll_uk:Benefit"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Benefits",
    "envelope": "Benefits",
    "arrayKey": "benefits",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "id",
     "type": "text",
     "api": "payroll_uk:Benefit.id"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_uk:Benefit.name"
    },
    {
     "name": "category",
     "type": "text",
     "api": "payroll_uk:Benefit.category"
    },
    {
     "name": "liability_account_id",
     "type": "text",
     "api": "payroll_uk:Benefit.liabilityAccountId"
    },
    {
     "name": "expense_account_id",
     "type": "text",
     "api": "payroll_uk:Benefit.expenseAccountId"
    },
    {
     "name": "standard_amount",
     "type": "numeric",
     "api": "payroll_uk:Benefit.standardAmount"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_uk:Benefit.percentage"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_uk:Benefit.calculationType"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_uk:Benefit.currentRecord"
    },
    {
     "name": "subject_to_nic",
     "type": "boolean",
     "api": "payroll_uk:Benefit.subjectToNIC"
    },
    {
     "name": "subject_to_pension",
     "type": "boolean",
     "api": "payroll_uk:Benefit.subjectToPension"
    },
    {
     "name": "subject_to_tax",
     "type": "boolean",
     "api": "payroll_uk:Benefit.subjectToTax"
    },
    {
     "name": "is_calculating_on_qualifying_earnings",
     "type": "boolean",
     "api": "payroll_uk:Benefit.isCalculatingOnQualifyingEarnings"
    },
    {
     "name": "show_balance_to_employee",
     "type": "boolean",
     "api": "payroll_uk:Benefit.showBalanceToEmployee"
    }
   ]
  },
  "xero_payroll_uk_deductions": {
   "id": "xero_payroll_uk_deductions",
   "primaryKey": [
    "deduction_id"
   ],
   "recordIdField": "deductionId",
   "sourceObjects": [
    "payroll_uk:Deduction"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Deductions",
    "envelope": "Deductions",
    "arrayKey": "deductions",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "deduction_id",
     "type": "text",
     "api": "payroll_uk:Deduction.deductionId"
    },
    {
     "name": "deduction_name",
     "type": "text",
     "api": "payroll_uk:Deduction.deductionName"
    },
    {
     "name": "deduction_category",
     "type": "text",
     "api": "payroll_uk:Deduction.deductionCategory"
    },
    {
     "name": "liability_account_id",
     "type": "text",
     "api": "payroll_uk:Deduction.liabilityAccountId"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_uk:Deduction.currentRecord"
    },
    {
     "name": "standard_amount",
     "type": "numeric",
     "api": "payroll_uk:Deduction.standardAmount"
    },
    {
     "name": "reduces_super_liability",
     "type": "boolean",
     "api": "payroll_uk:Deduction.reducesSuperLiability"
    },
    {
     "name": "reduces_tax_liability",
     "type": "boolean",
     "api": "payroll_uk:Deduction.reducesTaxLiability"
    },
    {
     "name": "calculation_type",
     "type": "text",
     "api": "payroll_uk:Deduction.calculationType"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_uk:Deduction.percentage"
    },
    {
     "name": "subject_to_nic",
     "type": "boolean",
     "api": "payroll_uk:Deduction.subjectToNIC"
    },
    {
     "name": "subject_to_tax",
     "type": "boolean",
     "api": "payroll_uk:Deduction.subjectToTax"
    },
    {
     "name": "is_reduced_by_basic_rate",
     "type": "boolean",
     "api": "payroll_uk:Deduction.isReducedByBasicRate"
    },
    {
     "name": "apply_to_pension_calculations",
     "type": "boolean",
     "api": "payroll_uk:Deduction.applyToPensionCalculations"
    },
    {
     "name": "is_calculating_on_qualifying_earnings",
     "type": "boolean",
     "api": "payroll_uk:Deduction.isCalculatingOnQualifyingEarnings"
    },
    {
     "name": "is_pension",
     "type": "boolean",
     "api": "payroll_uk:Deduction.isPension"
    }
   ]
  },
  "xero_payroll_uk_earnings_orders": {
   "id": "xero_payroll_uk_earnings_orders",
   "primaryKey": [
    "id"
   ],
   "recordIdField": "id",
   "sourceObjects": [
    "payroll_uk:EarningsOrder"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /EarningsOrders",
    "envelope": "EarningsOrders",
    "arrayKey": "statutoryDeductions",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "id",
     "type": "text",
     "api": "payroll_uk:EarningsOrder.id"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_uk:EarningsOrder.name"
    },
    {
     "name": "statutory_deduction_category",
     "type": "text",
     "api": "payroll_uk:EarningsOrder.statutoryDeductionCategory"
    },
    {
     "name": "liability_account_id",
     "type": "text",
     "api": "payroll_uk:EarningsOrder.liabilityAccountId"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_uk:EarningsOrder.currentRecord"
    }
   ]
  },
  "xero_payroll_uk_earnings_rates": {
   "id": "xero_payroll_uk_earnings_rates",
   "primaryKey": [
    "earnings_rate_id"
   ],
   "recordIdField": "earningsRateID",
   "sourceObjects": [
    "payroll_uk:EarningsRate"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /EarningsRates",
    "envelope": "EarningsRates",
    "arrayKey": "earningsRates",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_uk:EarningsRate.earningsRateID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_uk:EarningsRate.name"
    },
    {
     "name": "earnings_type",
     "type": "text",
     "api": "payroll_uk:EarningsRate.earningsType"
    },
    {
     "name": "rate_type",
     "type": "text",
     "api": "payroll_uk:EarningsRate.rateType"
    },
    {
     "name": "type_of_units",
     "type": "text",
     "api": "payroll_uk:EarningsRate.typeOfUnits"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_uk:EarningsRate.currentRecord"
    },
    {
     "name": "expense_account_id",
     "type": "text",
     "api": "payroll_uk:EarningsRate.expenseAccountID"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_uk:EarningsRate.ratePerUnit"
    },
    {
     "name": "multiple_of_ordinary_earnings_rate",
     "type": "numeric",
     "api": "payroll_uk:EarningsRate.multipleOfOrdinaryEarningsRate"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_uk:EarningsRate.fixedAmount"
    }
   ]
  },
  "xero_payroll_uk_employee_bank_accounts": {
   "id": "xero_payroll_uk_employee_bank_accounts",
   "primaryKey": [
    "employee_id",
    "ordinal"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:BankAccount"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees/{EmployeeID}/PaymentMethods",
    "envelope": "PaymentMethodObject",
    "arrayKey": "paymentMethod",
    "explodePath": "PaymentMethod.bankAccounts",
    "explodeChain": [
     "PaymentMethod",
     "BankAccount"
    ],
    "parentTable": "xero_payroll_uk_employee_payment_methods",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "synthetic:EmployeeID path parameter of GET /Employees/{EmployeeID}/PaymentMethods, inherited through parent xero_payroll_uk_employee_payment_methods — neither BankAccount nor PaymentMethod carries an employee field"
    },
    {
     "name": "ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position in payroll_uk:PaymentMethod.bankAccounts"
    },
    {
     "name": "account_name",
     "type": "text",
     "api": "payroll_uk:BankAccount.accountName"
    },
    {
     "name": "account_number",
     "type": "text",
     "api": "payroll_uk:BankAccount.accountNumber"
    },
    {
     "name": "sort_code",
     "type": "text",
     "api": "payroll_uk:BankAccount.sortCode"
    }
   ]
  },
  "xero_payroll_uk_employee_contracts": {
   "id": "xero_payroll_uk_employee_contracts",
   "primaryKey": [
    "employee_id",
    "ordinal"
   ],
   "recordIdField": "publicKey",
   "sourceObjects": [
    "payroll_uk:Contracts",
    "payroll_uk:DevelopmentalRoleDetails"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees",
    "envelope": "Employees",
    "arrayKey": "employees",
    "explodePath": "Employee.contracts",
    "explodeChain": [
     "Employee",
     "Contracts"
    ],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Employee.employeeID"
    },
    {
     "name": "ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position in payroll_uk:Employee.contracts"
    },
    {
     "name": "public_key",
     "type": "text",
     "api": "payroll_uk:Contracts.publicKey"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_uk:Contracts.startDate"
    },
    {
     "name": "employment_status",
     "type": "text",
     "api": "payroll_uk:Contracts.employmentStatus"
    },
    {
     "name": "contract_type",
     "type": "text",
     "api": "payroll_uk:Contracts.contractType"
    },
    {
     "name": "is_fixed_term",
     "type": "boolean",
     "api": "payroll_uk:Contracts.isFixedTerm"
    },
    {
     "name": "fixed_term_end_date",
     "type": "date",
     "api": "payroll_uk:Contracts.fixedTermEndDate"
    },
    {
     "name": "developmental_role_details_start_date",
     "type": "date",
     "api": "payroll_uk:Contracts.developmentalRoleDetails.startDate"
    },
    {
     "name": "developmental_role_details_end_date",
     "type": "date",
     "api": "payroll_uk:Contracts.developmentalRoleDetails.endDate"
    },
    {
     "name": "developmental_role_details_developmental_role",
     "type": "text",
     "api": "payroll_uk:Contracts.developmentalRoleDetails.developmentalRole"
    },
    {
     "name": "developmental_role_details_public_key",
     "type": "text",
     "api": "payroll_uk:Contracts.developmentalRoleDetails.publicKey"
    }
   ]
  },
  "xero_payroll_uk_employee_leave": {
   "id": "xero_payroll_uk_employee_leave",
   "primaryKey": [
    "leave_id"
   ],
   "recordIdField": "leaveID",
   "sourceObjects": [
    "payroll_uk:EmployeeLeave"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees/{EmployeeID}/Leave",
    "envelope": "EmployeeLeaves",
    "arrayKey": "leave",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": "updatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "leave_id",
     "type": "text",
     "api": "payroll_uk:EmployeeLeave.leaveID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Employee.employeeID"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_uk:EmployeeLeave.leaveTypeID"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_uk:EmployeeLeave.description"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_uk:EmployeeLeave.startDate"
    },
    {
     "name": "end_date",
     "type": "date",
     "api": "payroll_uk:EmployeeLeave.endDate"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_uk:EmployeeLeave.updatedDateUTC"
    },
    {
     "name": "periods",
     "type": "jsonb",
     "api": "payroll_uk:EmployeeLeave.periods"
    }
   ]
  },
  "xero_payroll_uk_employee_leave_balances": {
   "id": "xero_payroll_uk_employee_leave_balances",
   "primaryKey": [
    "employee_id",
    "leave_type_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:EmployeeLeaveBalance"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees/{EmployeeID}/LeaveBalances",
    "envelope": "EmployeeLeaveBalances",
    "arrayKey": "leaveBalances",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Employee.employeeID"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_uk:EmployeeLeaveBalance.leaveTypeID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_uk:EmployeeLeaveBalance.name"
    },
    {
     "name": "balance",
     "type": "numeric",
     "api": "payroll_uk:EmployeeLeaveBalance.balance"
    },
    {
     "name": "type_of_units",
     "type": "text",
     "api": "payroll_uk:EmployeeLeaveBalance.typeOfUnits"
    }
   ]
  },
  "xero_payroll_uk_employee_leave_periods": {
   "id": "xero_payroll_uk_employee_leave_periods",
   "primaryKey": [
    "leave_id",
    "ordinal"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:LeavePeriod"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees/{EmployeeID}/Leave",
    "envelope": "EmployeeLeaves",
    "arrayKey": "leave",
    "explodePath": "EmployeeLeave.periods",
    "explodeChain": [
     "EmployeeLeave",
     "LeavePeriod"
    ],
    "parentTable": "xero_payroll_uk_employee_leave",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "leave_id",
     "type": "text",
     "api": "payroll_uk:EmployeeLeave.leaveID"
    },
    {
     "name": "ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position in payroll_uk:EmployeeLeave.periods"
    },
    {
     "name": "period_start_date",
     "type": "date",
     "api": "payroll_uk:LeavePeriod.periodStartDate"
    },
    {
     "name": "period_end_date",
     "type": "date",
     "api": "payroll_uk:LeavePeriod.periodEndDate"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_uk:LeavePeriod.numberOfUnits"
    },
    {
     "name": "period_status",
     "type": "text",
     "api": "payroll_uk:LeavePeriod.periodStatus"
    }
   ]
  },
  "xero_payroll_uk_employee_leave_types": {
   "id": "xero_payroll_uk_employee_leave_types",
   "primaryKey": [
    "employee_id",
    "leave_type_id"
   ],
   "recordIdField": "leaveTypeID",
   "sourceObjects": [
    "payroll_uk:EmployeeLeaveType"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees/{EmployeeID}/LeaveTypes",
    "envelope": "EmployeeLeaveTypes",
    "arrayKey": "leaveTypes",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Employee.employeeID"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_uk:EmployeeLeaveType.leaveTypeID"
    },
    {
     "name": "schedule_of_accrual",
     "type": "text",
     "api": "payroll_uk:EmployeeLeaveType.scheduleOfAccrual"
    },
    {
     "name": "hours_accrued_annually",
     "type": "numeric",
     "api": "payroll_uk:EmployeeLeaveType.hoursAccruedAnnually"
    },
    {
     "name": "maximum_to_accrue",
     "type": "numeric",
     "api": "payroll_uk:EmployeeLeaveType.maximumToAccrue"
    },
    {
     "name": "opening_balance",
     "type": "numeric",
     "api": "payroll_uk:EmployeeLeaveType.openingBalance"
    },
    {
     "name": "rate_accrued_hourly",
     "type": "numeric",
     "api": "payroll_uk:EmployeeLeaveType.rateAccruedHourly"
    },
    {
     "name": "schedule_of_accrual_date",
     "type": "date",
     "api": "payroll_uk:EmployeeLeaveType.scheduleOfAccrualDate"
    }
   ]
  },
  "xero_payroll_uk_employee_ni_categories": {
   "id": "xero_payroll_uk_employee_ni_categories",
   "primaryKey": [
    "employee_id",
    "ordinal"
   ],
   "recordIdField": "niCategoryID",
   "sourceObjects": [
    "payroll_uk:NICategory"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees",
    "envelope": "Employees",
    "arrayKey": "employees",
    "explodePath": "Employee.niCategories",
    "explodeChain": [
     "Employee",
     "NICategory"
    ],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Employee.employeeID"
    },
    {
     "name": "ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position in payroll_uk:Employee.niCategories"
    },
    {
     "name": "ni_category_id",
     "type": "bigint",
     "api": "payroll_uk:NICategory.niCategoryID"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_uk:NICategory.startDate"
    },
    {
     "name": "ni_category",
     "type": "text",
     "api": "payroll_uk:NICategory.niCategory"
    },
    {
     "name": "date_first_employed_as_civilian",
     "type": "date",
     "api": "payroll_uk:NICategory.dateFirstEmployedAsCivilian"
    },
    {
     "name": "workplace_postcode",
     "type": "text",
     "api": "payroll_uk:NICategory.workplacePostcode"
    }
   ]
  },
  "xero_payroll_uk_employee_opening_balances": {
   "id": "xero_payroll_uk_employee_opening_balances",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:EmployeeOpeningBalances"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees/{EmployeeID}/ukopeningbalances",
    "envelope": "EmployeeOpeningBalancesObject",
    "arrayKey": "openingBalances",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Employee.employeeID"
    },
    {
     "name": "statutory_adoption_pay",
     "type": "numeric",
     "api": "payroll_uk:EmployeeOpeningBalances.statutoryAdoptionPay"
    },
    {
     "name": "statutory_maternity_pay",
     "type": "numeric",
     "api": "payroll_uk:EmployeeOpeningBalances.statutoryMaternityPay"
    },
    {
     "name": "statutory_paternity_pay",
     "type": "numeric",
     "api": "payroll_uk:EmployeeOpeningBalances.statutoryPaternityPay"
    },
    {
     "name": "statutory_shared_parental_pay",
     "type": "numeric",
     "api": "payroll_uk:EmployeeOpeningBalances.statutorySharedParentalPay"
    },
    {
     "name": "statutory_sick_pay",
     "type": "numeric",
     "api": "payroll_uk:EmployeeOpeningBalances.statutorySickPay"
    },
    {
     "name": "prior_employee_number",
     "type": "numeric",
     "api": "payroll_uk:EmployeeOpeningBalances.priorEmployeeNumber"
    }
   ]
  },
  "xero_payroll_uk_employee_pay_template_earnings": {
   "id": "xero_payroll_uk_employee_pay_template_earnings",
   "primaryKey": [
    "pay_template_earning_id"
   ],
   "recordIdField": "payTemplateEarningID",
   "sourceObjects": [
    "payroll_uk:EarningsTemplate",
    "payroll_uk:EmployeePayTemplate"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees/{EmployeeID}/PayTemplates",
    "envelope": "EmployeePayTemplateObject",
    "arrayKey": "payTemplate",
    "explodePath": "EmployeePayTemplate.earningTemplates",
    "explodeChain": [
     "EmployeePayTemplate",
     "EarningsTemplates"
    ],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_template_earning_id",
     "type": "text",
     "api": "payroll_uk:EarningsTemplate.payTemplateEarningID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:EmployeePayTemplate.employeeID"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_uk:EarningsTemplate.earningsRateID"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_uk:EarningsTemplate.ratePerUnit"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_uk:EarningsTemplate.numberOfUnits"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_uk:EarningsTemplate.fixedAmount"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_uk:EarningsTemplate.name"
    }
   ]
  },
  "xero_payroll_uk_employee_payment_methods": {
   "id": "xero_payroll_uk_employee_payment_methods",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:PaymentMethod"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees/{EmployeeID}/PaymentMethods",
    "envelope": "PaymentMethodObject",
    "arrayKey": "paymentMethod",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Employee.employeeID"
    },
    {
     "name": "payment_method",
     "type": "text",
     "api": "payroll_uk:PaymentMethod.paymentMethod"
    },
    {
     "name": "bank_accounts",
     "type": "jsonb",
     "api": "payroll_uk:PaymentMethod.bankAccounts"
    }
   ]
  },
  "xero_payroll_uk_employee_salary_and_wages": {
   "id": "xero_payroll_uk_employee_salary_and_wages",
   "primaryKey": [
    "salary_and_wages_id"
   ],
   "recordIdField": "salaryAndWagesID",
   "sourceObjects": [
    "payroll_uk:SalaryAndWage"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees/{EmployeeID}/SalaryAndWages",
    "envelope": "SalaryAndWages",
    "arrayKey": "salaryAndWages",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "salary_and_wages_id",
     "type": "text",
     "api": "payroll_uk:SalaryAndWage.salaryAndWagesID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Employee.employeeID"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_uk:SalaryAndWage.earningsRateID"
    },
    {
     "name": "number_of_units_per_week",
     "type": "numeric",
     "api": "payroll_uk:SalaryAndWage.numberOfUnitsPerWeek"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_uk:SalaryAndWage.ratePerUnit"
    },
    {
     "name": "number_of_units_per_day",
     "type": "numeric",
     "api": "payroll_uk:SalaryAndWage.numberOfUnitsPerDay"
    },
    {
     "name": "effective_from",
     "type": "date",
     "api": "payroll_uk:SalaryAndWage.effectiveFrom"
    },
    {
     "name": "annual_salary",
     "type": "numeric",
     "api": "payroll_uk:SalaryAndWage.annualSalary"
    },
    {
     "name": "status",
     "type": "text",
     "api": "payroll_uk:SalaryAndWage.status"
    },
    {
     "name": "payment_type",
     "type": "text",
     "api": "payroll_uk:SalaryAndWage.paymentType"
    }
   ]
  },
  "xero_payroll_uk_employee_statutory_leave_balances": {
   "id": "xero_payroll_uk_employee_statutory_leave_balances",
   "primaryKey": [
    "employee_id",
    "leave_type",
    "as_of_date"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:EmployeeStatutoryLeaveBalance"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees/{EmployeeID}/StatutoryLeaveBalance",
    "envelope": "EmployeeStatutoryLeaveBalanceObject",
    "arrayKey": "leaveBalance",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Employee.employeeID"
    },
    {
     "name": "leave_type",
     "type": "text",
     "api": "payroll_uk:EmployeeStatutoryLeaveBalance.leaveType"
    },
    {
     "name": "as_of_date",
     "type": "date",
     "api": "synthetic:AsOfDate query parameter of GET /Employees/{EmployeeID}/StatutoryLeaveBalance — the response body carries no date, so the ingester stamps the date it asked about"
    },
    {
     "name": "balance_remaining",
     "type": "numeric",
     "api": "payroll_uk:EmployeeStatutoryLeaveBalance.balanceRemaining"
    },
    {
     "name": "units",
     "type": "text",
     "api": "payroll_uk:EmployeeStatutoryLeaveBalance.units"
    }
   ]
  },
  "xero_payroll_uk_employee_tax": {
   "id": "xero_payroll_uk_employee_tax",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:EmployeeTax"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees/{EmployeeID}/Tax",
    "envelope": "EmployeeTaxObject",
    "arrayKey": "employeeTax",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Employee.employeeID"
    },
    {
     "name": "starter_type",
     "type": "text",
     "api": "payroll_uk:EmployeeTax.starterType"
    },
    {
     "name": "starter_declaration",
     "type": "text",
     "api": "payroll_uk:EmployeeTax.starterDeclaration"
    },
    {
     "name": "tax_code",
     "type": "text",
     "api": "payroll_uk:EmployeeTax.taxCode"
    },
    {
     "name": "w1_m1",
     "type": "boolean",
     "api": "payroll_uk:EmployeeTax.w1M1"
    },
    {
     "name": "previous_taxable_pay",
     "type": "numeric",
     "api": "payroll_uk:EmployeeTax.previousTaxablePay"
    },
    {
     "name": "previous_tax_paid",
     "type": "numeric",
     "api": "payroll_uk:EmployeeTax.previousTaxPaid"
    },
    {
     "name": "student_loan_deduction",
     "type": "text",
     "api": "payroll_uk:EmployeeTax.studentLoanDeduction"
    },
    {
     "name": "has_post_graduate_loans",
     "type": "boolean",
     "api": "payroll_uk:EmployeeTax.hasPostGraduateLoans"
    },
    {
     "name": "is_director",
     "type": "boolean",
     "api": "payroll_uk:EmployeeTax.isDirector"
    },
    {
     "name": "directorship_start_date",
     "type": "date",
     "api": "payroll_uk:EmployeeTax.directorshipStartDate"
    },
    {
     "name": "nic_calculation_method",
     "type": "text",
     "api": "payroll_uk:EmployeeTax.nicCalculationMethod"
    }
   ]
  },
  "xero_payroll_uk_employees": {
   "id": "xero_payroll_uk_employees",
   "primaryKey": [
    "employee_id"
   ],
   "recordIdField": "employeeID",
   "sourceObjects": [
    "payroll_uk:Employee",
    "payroll_uk:Address"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Employees",
    "envelope": "Employees",
    "arrayKey": "employees",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "updatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "payroll.employees",
     "payroll.employees.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Employee.employeeID"
    },
    {
     "name": "title",
     "type": "text",
     "api": "payroll_uk:Employee.title"
    },
    {
     "name": "first_name",
     "type": "text",
     "api": "payroll_uk:Employee.firstName"
    },
    {
     "name": "last_name",
     "type": "text",
     "api": "payroll_uk:Employee.lastName"
    },
    {
     "name": "date_of_birth",
     "type": "date",
     "api": "payroll_uk:Employee.dateOfBirth"
    },
    {
     "name": "address_address_line1",
     "type": "text",
     "api": "payroll_uk:Employee.address.addressLine1"
    },
    {
     "name": "address_address_line2",
     "type": "text",
     "api": "payroll_uk:Employee.address.addressLine2"
    },
    {
     "name": "address_city",
     "type": "text",
     "api": "payroll_uk:Employee.address.city"
    },
    {
     "name": "address_post_code",
     "type": "text",
     "api": "payroll_uk:Employee.address.postCode"
    },
    {
     "name": "address_country_name",
     "type": "text",
     "api": "payroll_uk:Employee.address.countryName"
    },
    {
     "name": "email",
     "type": "text",
     "api": "payroll_uk:Employee.email"
    },
    {
     "name": "gender",
     "type": "text",
     "api": "payroll_uk:Employee.gender"
    },
    {
     "name": "phone_number",
     "type": "text",
     "api": "payroll_uk:Employee.phoneNumber"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_uk:Employee.startDate"
    },
    {
     "name": "end_date",
     "type": "date",
     "api": "payroll_uk:Employee.endDate"
    },
    {
     "name": "payroll_calendar_id",
     "type": "text",
     "api": "payroll_uk:Employee.payrollCalendarID"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_uk:Employee.updatedDateUTC"
    },
    {
     "name": "created_date_utc",
     "type": "timestamp",
     "api": "payroll_uk:Employee.createdDateUTC"
    },
    {
     "name": "ni_category",
     "type": "text",
     "api": "payroll_uk:Employee.niCategory"
    },
    {
     "name": "national_insurance_number",
     "type": "text",
     "api": "payroll_uk:Employee.nationalInsuranceNumber"
    },
    {
     "name": "is_off_payroll_worker",
     "type": "boolean",
     "api": "payroll_uk:Employee.isOffPayrollWorker"
    },
    {
     "name": "ni_categories",
     "type": "jsonb",
     "api": "payroll_uk:Employee.niCategories"
    },
    {
     "name": "contracts",
     "type": "jsonb",
     "api": "payroll_uk:Employee.contracts"
    },
    {
     "name": "earning_templates",
     "type": "jsonb",
     "api": "payroll_uk:EmployeePayTemplate.earningTemplates"
    }
   ]
  },
  "xero_payroll_uk_leave_types": {
   "id": "xero_payroll_uk_leave_types",
   "primaryKey": [
    "leave_type_id"
   ],
   "recordIdField": "leaveTypeID",
   "sourceObjects": [
    "payroll_uk:LeaveType"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /LeaveTypes",
    "envelope": "LeaveTypes",
    "arrayKey": "leaveTypes",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "updatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_uk:LeaveType.leaveTypeID"
    },
    {
     "name": "leave_id",
     "type": "text",
     "api": "payroll_uk:LeaveType.leaveID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_uk:LeaveType.name"
    },
    {
     "name": "is_paid_leave",
     "type": "boolean",
     "api": "payroll_uk:LeaveType.isPaidLeave"
    },
    {
     "name": "show_on_payslip",
     "type": "boolean",
     "api": "payroll_uk:LeaveType.showOnPayslip"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_uk:LeaveType.updatedDateUTC"
    },
    {
     "name": "is_active",
     "type": "boolean",
     "api": "payroll_uk:LeaveType.isActive"
    },
    {
     "name": "is_statutory_leave",
     "type": "boolean",
     "api": "payroll_uk:LeaveType.isStatutoryLeave"
    }
   ]
  },
  "xero_payroll_uk_pay_run_calendars": {
   "id": "xero_payroll_uk_pay_run_calendars",
   "primaryKey": [
    "payroll_calendar_id"
   ],
   "recordIdField": "payrollCalendarID",
   "sourceObjects": [
    "payroll_uk:PayRunCalendar"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /PayRunCalendars",
    "envelope": "PayRunCalendars",
    "arrayKey": "payRunCalendars",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "updatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "payroll_calendar_id",
     "type": "text",
     "api": "payroll_uk:PayRunCalendar.payrollCalendarID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_uk:PayRunCalendar.name"
    },
    {
     "name": "calendar_type",
     "type": "text",
     "api": "payroll_uk:PayRunCalendar.calendarType"
    },
    {
     "name": "period_start_date",
     "type": "date",
     "api": "payroll_uk:PayRunCalendar.periodStartDate"
    },
    {
     "name": "period_end_date",
     "type": "date",
     "api": "payroll_uk:PayRunCalendar.periodEndDate"
    },
    {
     "name": "payment_date",
     "type": "date",
     "api": "payroll_uk:PayRunCalendar.paymentDate"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_uk:PayRunCalendar.updatedDateUTC"
    }
   ]
  },
  "xero_payroll_uk_pay_runs": {
   "id": "xero_payroll_uk_pay_runs",
   "primaryKey": [
    "pay_run_id"
   ],
   "recordIdField": "payRunID",
   "sourceObjects": [
    "payroll_uk:PayRun"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /PayRuns",
    "envelope": "PayRuns",
    "arrayKey": "payRuns",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payruns",
     "payroll.payruns.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_run_id",
     "type": "text",
     "api": "payroll_uk:PayRun.payRunID"
    },
    {
     "name": "payroll_calendar_id",
     "type": "text",
     "api": "payroll_uk:PayRun.payrollCalendarID"
    },
    {
     "name": "period_start_date",
     "type": "date",
     "api": "payroll_uk:PayRun.periodStartDate"
    },
    {
     "name": "period_end_date",
     "type": "date",
     "api": "payroll_uk:PayRun.periodEndDate"
    },
    {
     "name": "payment_date",
     "type": "date",
     "api": "payroll_uk:PayRun.paymentDate"
    },
    {
     "name": "total_cost",
     "type": "numeric",
     "api": "payroll_uk:PayRun.totalCost"
    },
    {
     "name": "total_pay",
     "type": "numeric",
     "api": "payroll_uk:PayRun.totalPay"
    },
    {
     "name": "pay_run_status",
     "type": "text",
     "api": "payroll_uk:PayRun.payRunStatus"
    },
    {
     "name": "pay_run_type",
     "type": "text",
     "api": "payroll_uk:PayRun.payRunType"
    },
    {
     "name": "calendar_type",
     "type": "text",
     "api": "payroll_uk:PayRun.calendarType"
    },
    {
     "name": "posted_date_time",
     "type": "timestamp",
     "api": "payroll_uk:PayRun.postedDateTime"
    }
   ]
  },
  "xero_payroll_uk_payslip_benefit_lines": {
   "id": "xero_payroll_uk_payslip_benefit_lines",
   "primaryKey": [
    "pay_slip_id",
    "benefit_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:BenefitLine",
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": "Payslip.benefitLines",
    "explodeChain": [
     "Payslip",
     "BenefitLines"
    ],
    "parentTable": "xero_payroll_uk_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "benefit_lines",
     "type": "integer",
     "api": "payroll_uk:Payslip.benefitLines"
    },
    {
     "name": "benefit_type_id",
     "type": "text",
     "api": "payroll_uk:BenefitLine.benefitTypeID"
    },
    {
     "name": "display_name",
     "type": "text",
     "api": "payroll_uk:BenefitLine.displayName"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_uk:BenefitLine.amount"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_uk:BenefitLine.fixedAmount"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_uk:BenefitLine.percentage"
    }
   ]
  },
  "xero_payroll_uk_payslip_court_order_lines": {
   "id": "xero_payroll_uk_payslip_court_order_lines",
   "primaryKey": [
    "pay_slip_id",
    "court_order_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:CourtOrderLine",
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": "Payslip.courtOrderLines",
    "explodeChain": [
     "Payslip",
     "CourtOrderLines"
    ],
    "parentTable": "xero_payroll_uk_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "court_order_lines",
     "type": "integer",
     "api": "payroll_uk:Payslip.courtOrderLines"
    },
    {
     "name": "court_order_type_id",
     "type": "text",
     "api": "payroll_uk:CourtOrderLine.courtOrderTypeID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_uk:CourtOrderLine.amount"
    }
   ]
  },
  "xero_payroll_uk_payslip_deduction_lines": {
   "id": "xero_payroll_uk_payslip_deduction_lines",
   "primaryKey": [
    "pay_slip_id",
    "deduction_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:DeductionLine",
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": "Payslip.deductionLines",
    "explodeChain": [
     "Payslip",
     "DeductionLines"
    ],
    "parentTable": "xero_payroll_uk_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "deduction_lines",
     "type": "integer",
     "api": "payroll_uk:Payslip.deductionLines"
    },
    {
     "name": "deduction_type_id",
     "type": "text",
     "api": "payroll_uk:DeductionLine.deductionTypeID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_uk:DeductionLine.amount"
    },
    {
     "name": "subject_to_tax",
     "type": "boolean",
     "api": "payroll_uk:DeductionLine.subjectToTax"
    },
    {
     "name": "percentage",
     "type": "numeric",
     "api": "payroll_uk:DeductionLine.percentage"
    }
   ]
  },
  "xero_payroll_uk_payslip_earnings_lines": {
   "id": "xero_payroll_uk_payslip_earnings_lines",
   "primaryKey": [
    "pay_slip_id",
    "earnings_lines"
   ],
   "recordIdField": "earningsLineID",
   "sourceObjects": [
    "payroll_uk:EarningsLine",
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": "Payslip.earningsLines",
    "explodeChain": [
     "Payslip",
     "EarningsLines"
    ],
    "parentTable": "xero_payroll_uk_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "earnings_lines",
     "type": "integer",
     "api": "payroll_uk:Payslip.earningsLines"
    },
    {
     "name": "earnings_line_id",
     "type": "text",
     "api": "payroll_uk:EarningsLine.earningsLineID"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_uk:EarningsLine.earningsRateID"
    },
    {
     "name": "display_name",
     "type": "text",
     "api": "payroll_uk:EarningsLine.displayName"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_uk:EarningsLine.ratePerUnit"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_uk:EarningsLine.numberOfUnits"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_uk:EarningsLine.fixedAmount"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_uk:EarningsLine.amount"
    },
    {
     "name": "is_linked_to_timesheet",
     "type": "boolean",
     "api": "payroll_uk:EarningsLine.isLinkedToTimesheet"
    },
    {
     "name": "is_average_daily_pay_rate",
     "type": "boolean",
     "api": "payroll_uk:EarningsLine.isAverageDailyPayRate"
    }
   ]
  },
  "xero_payroll_uk_payslip_employee_tax_lines": {
   "id": "xero_payroll_uk_payslip_employee_tax_lines",
   "primaryKey": [
    "pay_slip_id",
    "employee_tax_lines"
   ],
   "recordIdField": "taxLineID",
   "sourceObjects": [
    "payroll_uk:TaxLine",
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": "Payslip.employeeTaxLines",
    "explodeChain": [
     "Payslip",
     "TaxLines"
    ],
    "parentTable": "xero_payroll_uk_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "employee_tax_lines",
     "type": "integer",
     "api": "payroll_uk:Payslip.employeeTaxLines"
    },
    {
     "name": "tax_line_id",
     "type": "text",
     "api": "payroll_uk:TaxLine.taxLineID"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_uk:TaxLine.description"
    },
    {
     "name": "is_employer_tax",
     "type": "boolean",
     "api": "payroll_uk:TaxLine.isEmployerTax"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_uk:TaxLine.amount"
    },
    {
     "name": "global_tax_type_id",
     "type": "text",
     "api": "payroll_uk:TaxLine.globalTaxTypeID"
    },
    {
     "name": "manual_adjustment",
     "type": "boolean",
     "api": "payroll_uk:TaxLine.manualAdjustment"
    }
   ]
  },
  "xero_payroll_uk_payslip_employer_tax_lines": {
   "id": "xero_payroll_uk_payslip_employer_tax_lines",
   "primaryKey": [
    "pay_slip_id",
    "employer_tax_lines"
   ],
   "recordIdField": "taxLineID",
   "sourceObjects": [
    "payroll_uk:TaxLine",
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": "Payslip.employerTaxLines",
    "explodeChain": [
     "Payslip",
     "TaxLines"
    ],
    "parentTable": "xero_payroll_uk_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "employer_tax_lines",
     "type": "integer",
     "api": "payroll_uk:Payslip.employerTaxLines"
    },
    {
     "name": "tax_line_id",
     "type": "text",
     "api": "payroll_uk:TaxLine.taxLineID"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_uk:TaxLine.description"
    },
    {
     "name": "is_employer_tax",
     "type": "boolean",
     "api": "payroll_uk:TaxLine.isEmployerTax"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_uk:TaxLine.amount"
    },
    {
     "name": "global_tax_type_id",
     "type": "text",
     "api": "payroll_uk:TaxLine.globalTaxTypeID"
    },
    {
     "name": "manual_adjustment",
     "type": "boolean",
     "api": "payroll_uk:TaxLine.manualAdjustment"
    }
   ]
  },
  "xero_payroll_uk_payslip_leave_accrual_lines": {
   "id": "xero_payroll_uk_payslip_leave_accrual_lines",
   "primaryKey": [
    "pay_slip_id",
    "leave_accrual_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:LeaveAccrualLine",
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": "Payslip.leaveAccrualLines",
    "explodeChain": [
     "Payslip",
     "LeaveAccrualLines"
    ],
    "parentTable": "xero_payroll_uk_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "leave_accrual_lines",
     "type": "integer",
     "api": "payroll_uk:Payslip.leaveAccrualLines"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_uk:LeaveAccrualLine.leaveTypeID"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_uk:LeaveAccrualLine.numberOfUnits"
    }
   ]
  },
  "xero_payroll_uk_payslip_leave_earnings_lines": {
   "id": "xero_payroll_uk_payslip_leave_earnings_lines",
   "primaryKey": [
    "pay_slip_id",
    "leave_earnings_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:LeaveEarningsLine",
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": "Payslip.leaveEarningsLines",
    "explodeChain": [
     "Payslip",
     "LeaveEarningsLines"
    ],
    "parentTable": "xero_payroll_uk_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "leave_earnings_lines",
     "type": "integer",
     "api": "payroll_uk:Payslip.leaveEarningsLines"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_uk:LeaveEarningsLine.earningsRateID"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_uk:LeaveEarningsLine.ratePerUnit"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_uk:LeaveEarningsLine.numberOfUnits"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_uk:LeaveEarningsLine.fixedAmount"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_uk:LeaveEarningsLine.amount"
    },
    {
     "name": "is_linked_to_timesheet",
     "type": "boolean",
     "api": "payroll_uk:LeaveEarningsLine.isLinkedToTimesheet"
    }
   ]
  },
  "xero_payroll_uk_payslip_payment_lines": {
   "id": "xero_payroll_uk_payslip_payment_lines",
   "primaryKey": [
    "pay_slip_id",
    "payment_lines"
   ],
   "recordIdField": "paymentLineID",
   "sourceObjects": [
    "payroll_uk:PaymentLine",
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": "Payslip.paymentLines",
    "explodeChain": [
     "Payslip",
     "PaymentLines"
    ],
    "parentTable": "xero_payroll_uk_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "payment_lines",
     "type": "integer",
     "api": "payroll_uk:Payslip.paymentLines"
    },
    {
     "name": "payment_line_id",
     "type": "text",
     "api": "payroll_uk:PaymentLine.paymentLineID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_uk:PaymentLine.amount"
    },
    {
     "name": "account_number",
     "type": "text",
     "api": "payroll_uk:PaymentLine.accountNumber"
    },
    {
     "name": "sort_code",
     "type": "text",
     "api": "payroll_uk:PaymentLine.sortCode"
    },
    {
     "name": "account_name",
     "type": "text",
     "api": "payroll_uk:PaymentLine.accountName"
    }
   ]
  },
  "xero_payroll_uk_payslip_reimbursement_lines": {
   "id": "xero_payroll_uk_payslip_reimbursement_lines",
   "primaryKey": [
    "pay_slip_id",
    "reimbursement_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:ReimbursementLine",
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": "Payslip.reimbursementLines",
    "explodeChain": [
     "Payslip",
     "ReimbursementLines"
    ],
    "parentTable": "xero_payroll_uk_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "reimbursement_lines",
     "type": "integer",
     "api": "payroll_uk:Payslip.reimbursementLines"
    },
    {
     "name": "reimbursement_type_id",
     "type": "text",
     "api": "payroll_uk:ReimbursementLine.reimbursementTypeID"
    },
    {
     "name": "description",
     "type": "text",
     "api": "payroll_uk:ReimbursementLine.description"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_uk:ReimbursementLine.amount"
    }
   ]
  },
  "xero_payroll_uk_payslip_timesheet_earnings_lines": {
   "id": "xero_payroll_uk_payslip_timesheet_earnings_lines",
   "primaryKey": [
    "pay_slip_id",
    "timesheet_earnings_lines"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:TimesheetEarningsLine",
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": "Payslip.timesheetEarningsLines",
    "explodeChain": [
     "Payslip",
     "TimesheetEarningsLines"
    ],
    "parentTable": "xero_payroll_uk_payslips",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "timesheet_earnings_lines",
     "type": "integer",
     "api": "payroll_uk:Payslip.timesheetEarningsLines"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_uk:TimesheetEarningsLine.earningsRateID"
    },
    {
     "name": "rate_per_unit",
     "type": "numeric",
     "api": "payroll_uk:TimesheetEarningsLine.ratePerUnit"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_uk:TimesheetEarningsLine.numberOfUnits"
    },
    {
     "name": "fixed_amount",
     "type": "numeric",
     "api": "payroll_uk:TimesheetEarningsLine.fixedAmount"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "payroll_uk:TimesheetEarningsLine.amount"
    },
    {
     "name": "is_linked_to_timesheet",
     "type": "boolean",
     "api": "payroll_uk:TimesheetEarningsLine.isLinkedToTimesheet"
    }
   ]
  },
  "xero_payroll_uk_payslips": {
   "id": "xero_payroll_uk_payslips",
   "primaryKey": [
    "pay_slip_id"
   ],
   "recordIdField": "paySlipID",
   "sourceObjects": [
    "payroll_uk:Payslip"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Payslips",
    "envelope": "Payslips",
    "arrayKey": "paySlips",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_uk_pay_runs",
    "fanOutParam": "PayRunID",
    "pagination": "page",
    "modifiedField": "lastEdited",
    "whereFilterable": false,
    "scopes": [
     "payroll.payslip",
     "payroll.payslip.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "pay_slip_id",
     "type": "text",
     "api": "payroll_uk:Payslip.paySlipID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Payslip.employeeID"
    },
    {
     "name": "pay_run_id",
     "type": "text",
     "api": "payroll_uk:Payslip.payRunID"
    },
    {
     "name": "last_edited",
     "type": "timestamp",
     "api": "payroll_uk:Payslip.lastEdited"
    },
    {
     "name": "first_name",
     "type": "text",
     "api": "payroll_uk:Payslip.firstName"
    },
    {
     "name": "last_name",
     "type": "text",
     "api": "payroll_uk:Payslip.lastName"
    },
    {
     "name": "total_earnings",
     "type": "numeric",
     "api": "payroll_uk:Payslip.totalEarnings"
    },
    {
     "name": "gross_earnings",
     "type": "numeric",
     "api": "payroll_uk:Payslip.grossEarnings"
    },
    {
     "name": "total_pay",
     "type": "numeric",
     "api": "payroll_uk:Payslip.totalPay"
    },
    {
     "name": "total_employer_taxes",
     "type": "numeric",
     "api": "payroll_uk:Payslip.totalEmployerTaxes"
    },
    {
     "name": "total_employee_taxes",
     "type": "numeric",
     "api": "payroll_uk:Payslip.totalEmployeeTaxes"
    },
    {
     "name": "total_deductions",
     "type": "numeric",
     "api": "payroll_uk:Payslip.totalDeductions"
    },
    {
     "name": "total_reimbursements",
     "type": "numeric",
     "api": "payroll_uk:Payslip.totalReimbursements"
    },
    {
     "name": "total_court_orders",
     "type": "numeric",
     "api": "payroll_uk:Payslip.totalCourtOrders"
    },
    {
     "name": "total_benefits",
     "type": "numeric",
     "api": "payroll_uk:Payslip.totalBenefits"
    },
    {
     "name": "bacs_hash",
     "type": "text",
     "api": "payroll_uk:Payslip.bacsHash"
    },
    {
     "name": "payment_method",
     "type": "text",
     "api": "payroll_uk:Payslip.paymentMethod"
    }
   ]
  },
  "xero_payroll_uk_reimbursements": {
   "id": "xero_payroll_uk_reimbursements",
   "primaryKey": [
    "reimbursement_id"
   ],
   "recordIdField": "reimbursementID",
   "sourceObjects": [
    "payroll_uk:Reimbursement"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Reimbursements",
    "envelope": "Reimbursements",
    "arrayKey": "reimbursements",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "reimbursement_id",
     "type": "text",
     "api": "payroll_uk:Reimbursement.reimbursementID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_uk:Reimbursement.name"
    },
    {
     "name": "account_id",
     "type": "text",
     "api": "payroll_uk:Reimbursement.accountID"
    },
    {
     "name": "current_record",
     "type": "boolean",
     "api": "payroll_uk:Reimbursement.currentRecord"
    }
   ]
  },
  "xero_payroll_uk_settings_accounts": {
   "id": "xero_payroll_uk_settings_accounts",
   "primaryKey": [
    "type"
   ],
   "recordIdField": "accountID",
   "sourceObjects": [
    "payroll_uk:Account"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Settings",
    "envelope": "Settings",
    "arrayKey": "settings.accounts",
    "explodePath": null,
    "explodeChain": [
     "Settings"
    ],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "account_id",
     "type": "text",
     "api": "payroll_uk:Account.accountID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "payroll_uk:Account.type"
    },
    {
     "name": "code",
     "type": "text",
     "api": "payroll_uk:Account.code"
    },
    {
     "name": "name",
     "type": "text",
     "api": "payroll_uk:Account.name"
    }
   ]
  },
  "xero_payroll_uk_statutory_leave_summaries": {
   "id": "xero_payroll_uk_statutory_leave_summaries",
   "primaryKey": [
    "statutory_leave_id"
   ],
   "recordIdField": "statutoryLeaveID",
   "sourceObjects": [
    "payroll_uk:EmployeeStatutoryLeaveSummary"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /StatutoryLeaves/Summary/{EmployeeID}",
    "envelope": "EmployeeStatutoryLeavesSummaries",
    "arrayKey": "statutoryLeaves",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_uk_employees",
    "fanOutParam": "EmployeeID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "statutory_leave_id",
     "type": "text",
     "api": "payroll_uk:EmployeeStatutoryLeaveSummary.statutoryLeaveID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:EmployeeStatutoryLeaveSummary.employeeID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "payroll_uk:EmployeeStatutoryLeaveSummary.type"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_uk:EmployeeStatutoryLeaveSummary.startDate"
    },
    {
     "name": "end_date",
     "type": "date",
     "api": "payroll_uk:EmployeeStatutoryLeaveSummary.endDate"
    },
    {
     "name": "is_entitled",
     "type": "boolean",
     "api": "payroll_uk:EmployeeStatutoryLeaveSummary.isEntitled"
    },
    {
     "name": "status",
     "type": "text",
     "api": "payroll_uk:EmployeeStatutoryLeaveSummary.status"
    }
   ]
  },
  "xero_payroll_uk_statutory_sick_leaves": {
   "id": "xero_payroll_uk_statutory_sick_leaves",
   "primaryKey": [
    "statutory_leave_id"
   ],
   "recordIdField": "statutoryLeaveID",
   "sourceObjects": [
    "payroll_uk:EmployeeStatutorySickLeave"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /StatutoryLeaves/Sick/{StatutorySickLeaveID}",
    "envelope": "EmployeeStatutorySickLeaveObject",
    "arrayKey": "statutorySickLeave",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_payroll_uk_statutory_leave_summaries",
    "fanOutParam": "StatutorySickLeaveID",
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "optional"
   },
   "columns": [
    {
     "name": "statutory_leave_id",
     "type": "text",
     "api": "payroll_uk:EmployeeStatutorySickLeave.statutoryLeaveID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:EmployeeStatutorySickLeave.employeeID"
    },
    {
     "name": "leave_type_id",
     "type": "text",
     "api": "payroll_uk:EmployeeStatutorySickLeave.leaveTypeID"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_uk:EmployeeStatutorySickLeave.startDate"
    },
    {
     "name": "end_date",
     "type": "date",
     "api": "payroll_uk:EmployeeStatutorySickLeave.endDate"
    },
    {
     "name": "type",
     "type": "text",
     "api": "payroll_uk:EmployeeStatutorySickLeave.type"
    },
    {
     "name": "status",
     "type": "text",
     "api": "payroll_uk:EmployeeStatutorySickLeave.status"
    },
    {
     "name": "work_pattern",
     "type": "jsonb",
     "api": "payroll_uk:EmployeeStatutorySickLeave.workPattern"
    },
    {
     "name": "is_pregnancy_related",
     "type": "boolean",
     "api": "payroll_uk:EmployeeStatutorySickLeave.isPregnancyRelated"
    },
    {
     "name": "sufficient_notice",
     "type": "boolean",
     "api": "payroll_uk:EmployeeStatutorySickLeave.sufficientNotice"
    },
    {
     "name": "is_entitled",
     "type": "boolean",
     "api": "payroll_uk:EmployeeStatutorySickLeave.isEntitled"
    },
    {
     "name": "entitlement_weeks_requested",
     "type": "numeric",
     "api": "payroll_uk:EmployeeStatutorySickLeave.entitlementWeeksRequested"
    },
    {
     "name": "entitlement_weeks_qualified",
     "type": "numeric",
     "api": "payroll_uk:EmployeeStatutorySickLeave.entitlementWeeksQualified"
    },
    {
     "name": "entitlement_weeks_remaining",
     "type": "numeric",
     "api": "payroll_uk:EmployeeStatutorySickLeave.entitlementWeeksRemaining"
    },
    {
     "name": "overlaps_with_other_leave",
     "type": "boolean",
     "api": "payroll_uk:EmployeeStatutorySickLeave.overlapsWithOtherLeave"
    },
    {
     "name": "entitlement_failure_reasons",
     "type": "jsonb",
     "api": "payroll_uk:EmployeeStatutorySickLeave.entitlementFailureReasons"
    }
   ]
  },
  "xero_payroll_uk_timesheet_lines": {
   "id": "xero_payroll_uk_timesheet_lines",
   "primaryKey": [
    "timesheet_line_id"
   ],
   "recordIdField": "timesheetLineID",
   "sourceObjects": [
    "payroll_uk:TimesheetLine"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Timesheets",
    "envelope": "Timesheets",
    "arrayKey": "timesheets",
    "explodePath": "Timesheet.timesheetLines",
    "explodeChain": [
     "Timesheet",
     "TimesheetLines"
    ],
    "parentTable": "xero_payroll_uk_timesheets",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.timesheets",
     "payroll.timesheets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "timesheet_line_id",
     "type": "text",
     "api": "payroll_uk:TimesheetLine.timesheetLineID"
    },
    {
     "name": "timesheet_id",
     "type": "text",
     "api": "payroll_uk:Timesheet.timesheetID"
    },
    {
     "name": "date",
     "type": "date",
     "api": "payroll_uk:TimesheetLine.date"
    },
    {
     "name": "earnings_rate_id",
     "type": "text",
     "api": "payroll_uk:TimesheetLine.earningsRateID"
    },
    {
     "name": "tracking_item_id",
     "type": "text",
     "api": "payroll_uk:TimesheetLine.trackingItemID"
    },
    {
     "name": "number_of_units",
     "type": "numeric",
     "api": "payroll_uk:TimesheetLine.numberOfUnits"
    }
   ]
  },
  "xero_payroll_uk_timesheets": {
   "id": "xero_payroll_uk_timesheets",
   "primaryKey": [
    "timesheet_id"
   ],
   "recordIdField": "timesheetID",
   "sourceObjects": [
    "payroll_uk:Timesheet"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Timesheets",
    "envelope": "Timesheets",
    "arrayKey": "timesheets",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "updatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "payroll.timesheets",
     "payroll.timesheets.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "timesheet_id",
     "type": "text",
     "api": "payroll_uk:Timesheet.timesheetID"
    },
    {
     "name": "payroll_calendar_id",
     "type": "text",
     "api": "payroll_uk:Timesheet.payrollCalendarID"
    },
    {
     "name": "employee_id",
     "type": "text",
     "api": "payroll_uk:Timesheet.employeeID"
    },
    {
     "name": "start_date",
     "type": "date",
     "api": "payroll_uk:Timesheet.startDate"
    },
    {
     "name": "end_date",
     "type": "date",
     "api": "payroll_uk:Timesheet.endDate"
    },
    {
     "name": "status",
     "type": "text",
     "api": "payroll_uk:Timesheet.status"
    },
    {
     "name": "total_hours",
     "type": "numeric",
     "api": "payroll_uk:Timesheet.totalHours"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "payroll_uk:Timesheet.updatedDateUTC"
    },
    {
     "name": "timesheet_lines",
     "type": "jsonb",
     "api": "payroll_uk:Timesheet.timesheetLines"
    }
   ]
  },
  "xero_payroll_uk_tracking_categories": {
   "id": "xero_payroll_uk_tracking_categories",
   "primaryKey": [
    "record_key"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "payroll_uk:TrackingCategory"
   ],
   "source": {
    "api": "payroll_uk",
    "endpointOp": "GET /Settings/trackingCategories",
    "envelope": "TrackingCategories",
    "arrayKey": "trackingCategories",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "payroll.settings",
     "payroll.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "record_key",
     "type": "text",
     "api": "synthetic:constant 'payroll_uk' — the endpoint returns exactly one configuration record per organisation, which has no natural key"
    },
    {
     "name": "employee_groups_tracking_category_id",
     "type": "text",
     "api": "payroll_uk:TrackingCategory.employeeGroupsTrackingCategoryID"
    },
    {
     "name": "timesheet_tracking_category_id",
     "type": "text",
     "api": "payroll_uk:TrackingCategory.timesheetTrackingCategoryID"
    }
   ]
  },
  "xero_prepayment_allocations": {
   "id": "xero_prepayment_allocations",
   "primaryKey": [
    "prepayment_prepayment_id",
    "allocation_ordinal"
   ],
   "recordIdField": "AllocationID",
   "sourceObjects": [
    "accounting:Allocation"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Prepayments",
    "envelope": "Prepayments",
    "arrayKey": "Prepayments",
    "explodePath": "Prepayment.Allocations",
    "explodeChain": [
     "Prepayment",
     "Allocation"
    ],
    "parentTable": "xero_prepayments",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions",
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "prepayment_prepayment_id",
     "type": "text",
     "api": "accounting:Allocation.Prepayment.PrepaymentID"
    },
    {
     "name": "allocation_ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position in the parent Prepayment.Allocations array"
    },
    {
     "name": "allocation_id",
     "type": "text",
     "api": "accounting:Allocation.AllocationID"
    },
    {
     "name": "invoice_invoice_id",
     "type": "text",
     "api": "accounting:Allocation.Invoice.InvoiceID"
    },
    {
     "name": "amount",
     "type": "numeric",
     "api": "accounting:Allocation.Amount"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:Allocation.Date"
    },
    {
     "name": "is_deleted",
     "type": "boolean",
     "api": "accounting:Allocation.IsDeleted"
    },
    {
     "name": "credit_note_credit_note_id",
     "type": "text",
     "api": "accounting:Allocation.CreditNote.CreditNoteID"
    },
    {
     "name": "status_attribute_string",
     "type": "text",
     "api": "accounting:Allocation.StatusAttributeString"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:Allocation.ValidationErrors"
    }
   ]
  },
  "xero_prepayments": {
   "id": "xero_prepayments",
   "primaryKey": [
    "prepayment_id"
   ],
   "recordIdField": "PrepaymentID",
   "sourceObjects": [
    "accounting:Prepayment"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Prepayments",
    "envelope": "Prepayments",
    "arrayKey": "Prepayments",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions",
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "prepayment_id",
     "type": "text",
     "api": "accounting:Prepayment.PrepaymentID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "accounting:Prepayment.Type"
    },
    {
     "name": "contact_contact_id",
     "type": "text",
     "api": "accounting:Prepayment.Contact.ContactID"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:Prepayment.Date"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:Prepayment.Status"
    },
    {
     "name": "line_amount_types",
     "type": "text",
     "api": "accounting:Prepayment.LineAmountTypes"
    },
    {
     "name": "line_items",
     "type": "jsonb",
     "api": "accounting:Prepayment.LineItems"
    },
    {
     "name": "sub_total",
     "type": "numeric",
     "api": "accounting:Prepayment.SubTotal"
    },
    {
     "name": "total_tax",
     "type": "numeric",
     "api": "accounting:Prepayment.TotalTax"
    },
    {
     "name": "total",
     "type": "numeric",
     "api": "accounting:Prepayment.Total"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:Prepayment.Reference"
    },
    {
     "name": "invoice_number",
     "type": "text",
     "api": "accounting:Prepayment.InvoiceNumber"
    },
    {
     "name": "currency_code",
     "type": "text",
     "api": "accounting:Prepayment.CurrencyCode"
    },
    {
     "name": "branding_theme_id",
     "type": "text",
     "api": "accounting:Prepayment.BrandingThemeID"
    },
    {
     "name": "currency_rate",
     "type": "numeric",
     "api": "accounting:Prepayment.CurrencyRate"
    },
    {
     "name": "remaining_credit",
     "type": "numeric",
     "api": "accounting:Prepayment.RemainingCredit"
    },
    {
     "name": "applied_amount",
     "type": "numeric",
     "api": "accounting:Prepayment.AppliedAmount"
    },
    {
     "name": "allocations",
     "type": "jsonb",
     "api": "accounting:Prepayment.Allocations"
    },
    {
     "name": "payments",
     "type": "jsonb",
     "api": "accounting:Prepayment.Payments"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:Prepayment.HasAttachments"
    },
    {
     "name": "attachments",
     "type": "jsonb",
     "api": "accounting:Prepayment.Attachments"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Prepayment.UpdatedDateUTC"
    },
    {
     "name": "updated_date_utc_string",
     "type": "text",
     "api": "accounting:Prepayment.UpdatedDateUTCString"
    }
   ]
  },
  "xero_project_tasks": {
   "id": "xero_project_tasks",
   "primaryKey": [
    "task_id"
   ],
   "recordIdField": "taskId",
   "sourceObjects": [
    "projects:Task",
    "projects:Amount"
   ],
   "source": {
    "api": "projects",
    "endpointOp": "GET /Projects/{projectId}/Tasks",
    "envelope": "Tasks",
    "arrayKey": "items",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_projects",
    "fanOutParam": "projectId",
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "projects",
     "projects.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "task_id",
     "type": "text",
     "api": "projects:Task.taskId"
    },
    {
     "name": "project_id",
     "type": "text",
     "api": "projects:Task.projectId"
    },
    {
     "name": "name",
     "type": "text",
     "api": "projects:Task.name"
    },
    {
     "name": "charge_type",
     "type": "text",
     "api": "projects:Task.chargeType"
    },
    {
     "name": "rate_value",
     "type": "numeric",
     "api": "projects:Task.rate.value"
    },
    {
     "name": "rate_currency",
     "type": "text",
     "api": "projects:Task.rate.currency"
    },
    {
     "name": "estimate_minutes",
     "type": "integer",
     "api": "projects:Task.estimateMinutes"
    },
    {
     "name": "total_minutes",
     "type": "integer",
     "api": "projects:Task.totalMinutes"
    },
    {
     "name": "minutes_invoiced",
     "type": "integer",
     "api": "projects:Task.minutesInvoiced"
    },
    {
     "name": "minutes_to_be_invoiced",
     "type": "integer",
     "api": "projects:Task.minutesToBeInvoiced"
    },
    {
     "name": "fixed_minutes",
     "type": "integer",
     "api": "projects:Task.fixedMinutes"
    },
    {
     "name": "non_chargeable_minutes",
     "type": "integer",
     "api": "projects:Task.nonChargeableMinutes"
    },
    {
     "name": "total_amount_value",
     "type": "numeric",
     "api": "projects:Task.totalAmount.value"
    },
    {
     "name": "amount_to_be_invoiced_value",
     "type": "numeric",
     "api": "projects:Task.amountToBeInvoiced.value"
    },
    {
     "name": "amount_invoiced_value",
     "type": "numeric",
     "api": "projects:Task.amountInvoiced.value"
    },
    {
     "name": "status",
     "type": "text",
     "api": "projects:Task.status"
    }
   ]
  },
  "xero_project_time_entries": {
   "id": "xero_project_time_entries",
   "primaryKey": [
    "time_entry_id"
   ],
   "recordIdField": "timeEntryId",
   "sourceObjects": [
    "projects:TimeEntry"
   ],
   "source": {
    "api": "projects",
    "endpointOp": "GET /Projects/{projectId}/Time",
    "envelope": "TimeEntries",
    "arrayKey": "items",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": "xero_projects",
    "fanOutParam": "projectId",
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "projects",
     "projects.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "time_entry_id",
     "type": "text",
     "api": "projects:TimeEntry.timeEntryId"
    },
    {
     "name": "user_id",
     "type": "text",
     "api": "projects:TimeEntry.userId"
    },
    {
     "name": "project_id",
     "type": "text",
     "api": "projects:TimeEntry.projectId"
    },
    {
     "name": "task_id",
     "type": "text",
     "api": "projects:TimeEntry.taskId"
    },
    {
     "name": "date_utc",
     "type": "timestamp",
     "api": "projects:TimeEntry.dateUtc"
    },
    {
     "name": "date_entered_utc",
     "type": "timestamp",
     "api": "projects:TimeEntry.dateEnteredUtc"
    },
    {
     "name": "duration",
     "type": "integer",
     "api": "projects:TimeEntry.duration"
    },
    {
     "name": "description",
     "type": "text",
     "api": "projects:TimeEntry.description"
    },
    {
     "name": "status",
     "type": "text",
     "api": "projects:TimeEntry.status"
    }
   ]
  },
  "xero_project_users": {
   "id": "xero_project_users",
   "primaryKey": [
    "user_id"
   ],
   "recordIdField": "userId",
   "sourceObjects": [
    "projects:ProjectUser"
   ],
   "source": {
    "api": "projects",
    "endpointOp": "GET /ProjectsUsers",
    "envelope": "ProjectUsers",
    "arrayKey": "items",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "projects",
     "projects.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "user_id",
     "type": "text",
     "api": "projects:ProjectUser.userId"
    },
    {
     "name": "name",
     "type": "text",
     "api": "projects:ProjectUser.name"
    },
    {
     "name": "email",
     "type": "text",
     "api": "projects:ProjectUser.email"
    }
   ]
  },
  "xero_projects": {
   "id": "xero_projects",
   "primaryKey": [
    "project_id"
   ],
   "recordIdField": "projectId",
   "sourceObjects": [
    "projects:Project",
    "projects:Amount"
   ],
   "source": {
    "api": "projects",
    "endpointOp": "GET /Projects",
    "envelope": "Projects",
    "arrayKey": "items",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "projects",
     "projects.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "project_id",
     "type": "text",
     "api": "projects:Project.projectId"
    },
    {
     "name": "contact_id",
     "type": "text",
     "api": "projects:Project.contactId"
    },
    {
     "name": "name",
     "type": "text",
     "api": "projects:Project.name"
    },
    {
     "name": "status",
     "type": "text",
     "api": "projects:Project.status"
    },
    {
     "name": "currency_code",
     "type": "text",
     "api": "projects:Project.currencyCode"
    },
    {
     "name": "deadline_utc",
     "type": "timestamp",
     "api": "projects:Project.deadlineUtc"
    },
    {
     "name": "minutes_logged",
     "type": "integer",
     "api": "projects:Project.minutesLogged"
    },
    {
     "name": "minutes_to_be_invoiced",
     "type": "integer",
     "api": "projects:Project.minutesToBeInvoiced"
    },
    {
     "name": "total_task_amount_value",
     "type": "numeric",
     "api": "projects:Project.totalTaskAmount.value"
    },
    {
     "name": "total_expense_amount_value",
     "type": "numeric",
     "api": "projects:Project.totalExpenseAmount.value"
    },
    {
     "name": "estimate_value",
     "type": "numeric",
     "api": "projects:Project.estimate.value"
    },
    {
     "name": "estimate_currency",
     "type": "text",
     "api": "projects:Project.estimate.currency"
    },
    {
     "name": "estimate_amount_value",
     "type": "numeric",
     "api": "projects:Project.estimateAmount.value"
    },
    {
     "name": "task_amount_to_be_invoiced_value",
     "type": "numeric",
     "api": "projects:Project.taskAmountToBeInvoiced.value"
    },
    {
     "name": "task_amount_invoiced_value",
     "type": "numeric",
     "api": "projects:Project.taskAmountInvoiced.value"
    },
    {
     "name": "expense_amount_to_be_invoiced_value",
     "type": "numeric",
     "api": "projects:Project.expenseAmountToBeInvoiced.value"
    },
    {
     "name": "expense_amount_invoiced_value",
     "type": "numeric",
     "api": "projects:Project.expenseAmountInvoiced.value"
    },
    {
     "name": "project_amount_invoiced_value",
     "type": "numeric",
     "api": "projects:Project.projectAmountInvoiced.value"
    },
    {
     "name": "deposit_value",
     "type": "numeric",
     "api": "projects:Project.deposit.value"
    },
    {
     "name": "deposit_currency",
     "type": "text",
     "api": "projects:Project.deposit.currency"
    },
    {
     "name": "deposit_applied_value",
     "type": "numeric",
     "api": "projects:Project.depositApplied.value"
    },
    {
     "name": "credit_note_amount_value",
     "type": "numeric",
     "api": "projects:Project.creditNoteAmount.value"
    },
    {
     "name": "total_invoiced_value",
     "type": "numeric",
     "api": "projects:Project.totalInvoiced.value"
    },
    {
     "name": "total_to_be_invoiced_value",
     "type": "numeric",
     "api": "projects:Project.totalToBeInvoiced.value"
    }
   ]
  },
  "xero_purchase_order_line_items": {
   "id": "xero_purchase_order_line_items",
   "primaryKey": [
    "purchase_order_id",
    "line_ordinal"
   ],
   "recordIdField": "LineItemID",
   "sourceObjects": [
    "accounting:LineItem",
    "accounting:PurchaseOrder"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /PurchaseOrders",
    "envelope": "PurchaseOrders",
    "arrayKey": "PurchaseOrders",
    "explodePath": "PurchaseOrder.LineItems",
    "explodeChain": [
     "PurchaseOrder",
     "LineItem"
    ],
    "parentTable": "xero_purchase_orders",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "line_item_id",
     "type": "text",
     "api": "accounting:LineItem.LineItemID"
    },
    {
     "name": "purchase_order_id",
     "type": "text",
     "api": "accounting:PurchaseOrder.PurchaseOrderID"
    },
    {
     "name": "line_ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position of the line in PurchaseOrder.LineItems"
    },
    {
     "name": "description",
     "type": "text",
     "api": "accounting:LineItem.Description"
    },
    {
     "name": "quantity",
     "type": "numeric",
     "api": "accounting:LineItem.Quantity"
    },
    {
     "name": "unit_amount",
     "type": "numeric",
     "api": "accounting:LineItem.UnitAmount"
    },
    {
     "name": "item_code",
     "type": "text",
     "api": "accounting:LineItem.ItemCode"
    },
    {
     "name": "account_code",
     "type": "text",
     "api": "accounting:LineItem.AccountCode"
    },
    {
     "name": "account_id",
     "type": "text",
     "api": "accounting:LineItem.AccountID"
    },
    {
     "name": "tax_type",
     "type": "text",
     "api": "accounting:LineItem.TaxType"
    },
    {
     "name": "tax_amount",
     "type": "numeric",
     "api": "accounting:LineItem.TaxAmount"
    },
    {
     "name": "line_amount",
     "type": "numeric",
     "api": "accounting:LineItem.LineAmount"
    },
    {
     "name": "discount_rate",
     "type": "numeric",
     "api": "accounting:LineItem.DiscountRate"
    },
    {
     "name": "discount_amount",
     "type": "numeric",
     "api": "accounting:LineItem.DiscountAmount"
    },
    {
     "name": "tracking",
     "type": "jsonb",
     "api": "accounting:LineItem.Tracking"
    }
   ]
  },
  "xero_purchase_orders": {
   "id": "xero_purchase_orders",
   "primaryKey": [
    "purchase_order_id"
   ],
   "recordIdField": "PurchaseOrderID",
   "sourceObjects": [
    "accounting:PurchaseOrder"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /PurchaseOrders",
    "envelope": "PurchaseOrders",
    "arrayKey": "PurchaseOrders",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "purchase_order_id",
     "type": "text",
     "api": "accounting:PurchaseOrder.PurchaseOrderID"
    },
    {
     "name": "purchase_order_number",
     "type": "text",
     "api": "accounting:PurchaseOrder.PurchaseOrderNumber"
    },
    {
     "name": "contact_contact_id",
     "type": "text",
     "api": "accounting:PurchaseOrder.Contact.ContactID"
    },
    {
     "name": "contact_name",
     "type": "text",
     "api": "accounting:PurchaseOrder.Contact.Name"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:PurchaseOrder.Status"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:PurchaseOrder.Date"
    },
    {
     "name": "delivery_date",
     "type": "date",
     "api": "accounting:PurchaseOrder.DeliveryDate"
    },
    {
     "name": "expected_arrival_date",
     "type": "date",
     "api": "accounting:PurchaseOrder.ExpectedArrivalDate"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:PurchaseOrder.Reference"
    },
    {
     "name": "line_amount_types",
     "type": "text",
     "api": "accounting:PurchaseOrder.LineAmountTypes"
    },
    {
     "name": "currency_code",
     "type": "text",
     "api": "accounting:PurchaseOrder.CurrencyCode"
    },
    {
     "name": "currency_rate",
     "type": "numeric",
     "api": "accounting:PurchaseOrder.CurrencyRate"
    },
    {
     "name": "sub_total",
     "type": "numeric",
     "api": "accounting:PurchaseOrder.SubTotal"
    },
    {
     "name": "total_tax",
     "type": "numeric",
     "api": "accounting:PurchaseOrder.TotalTax"
    },
    {
     "name": "total",
     "type": "numeric",
     "api": "accounting:PurchaseOrder.Total"
    },
    {
     "name": "total_discount",
     "type": "numeric",
     "api": "accounting:PurchaseOrder.TotalDiscount"
    },
    {
     "name": "sent_to_contact",
     "type": "boolean",
     "api": "accounting:PurchaseOrder.SentToContact"
    },
    {
     "name": "delivery_address",
     "type": "text",
     "api": "accounting:PurchaseOrder.DeliveryAddress"
    },
    {
     "name": "attention_to",
     "type": "text",
     "api": "accounting:PurchaseOrder.AttentionTo"
    },
    {
     "name": "telephone",
     "type": "text",
     "api": "accounting:PurchaseOrder.Telephone"
    },
    {
     "name": "delivery_instructions",
     "type": "text",
     "api": "accounting:PurchaseOrder.DeliveryInstructions"
    },
    {
     "name": "branding_theme_id",
     "type": "text",
     "api": "accounting:PurchaseOrder.BrandingThemeID"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:PurchaseOrder.HasAttachments"
    },
    {
     "name": "status_attribute_string",
     "type": "text",
     "api": "accounting:PurchaseOrder.StatusAttributeString"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:PurchaseOrder.UpdatedDateUTC"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:PurchaseOrder.ValidationErrors"
    },
    {
     "name": "warnings",
     "type": "jsonb",
     "api": "accounting:PurchaseOrder.Warnings"
    },
    {
     "name": "attachments",
     "type": "jsonb",
     "api": "accounting:PurchaseOrder.Attachments"
    },
    {
     "name": "line_items",
     "type": "jsonb",
     "api": "accounting:PurchaseOrder.LineItems"
    }
   ]
  },
  "xero_quote_line_items": {
   "id": "xero_quote_line_items",
   "primaryKey": [
    "line_items_line_item_id"
   ],
   "recordIdField": "LineItemID",
   "sourceObjects": [
    "accounting:Quote",
    "accounting:LineItem",
    "accounting:LineItemItem",
    "accounting:LineItemTracking",
    "accounting:TaxBreakdownComponent"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Quotes",
    "envelope": "Quotes",
    "arrayKey": "Quotes",
    "explodePath": "Quote.LineItems",
    "explodeChain": [
     "Quote",
     "LineItem"
    ],
    "parentTable": "xero_quotes",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": false,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "line_items_line_item_id",
     "type": "text",
     "api": "accounting:Quote.LineItems.LineItemID"
    },
    {
     "name": "quote_id",
     "type": "text",
     "api": "accounting:Quote.QuoteID"
    },
    {
     "name": "line_items",
     "type": "integer",
     "api": "accounting:Quote.LineItems"
    },
    {
     "name": "line_items_description",
     "type": "text",
     "api": "accounting:Quote.LineItems.Description"
    },
    {
     "name": "line_items_quantity",
     "type": "numeric",
     "api": "accounting:Quote.LineItems.Quantity"
    },
    {
     "name": "line_items_unit_amount",
     "type": "numeric",
     "api": "accounting:Quote.LineItems.UnitAmount"
    },
    {
     "name": "line_items_line_amount",
     "type": "numeric",
     "api": "accounting:Quote.LineItems.LineAmount"
    },
    {
     "name": "line_items_tax_type",
     "type": "text",
     "api": "accounting:Quote.LineItems.TaxType"
    },
    {
     "name": "line_items_tax_amount",
     "type": "numeric",
     "api": "accounting:Quote.LineItems.TaxAmount"
    },
    {
     "name": "line_items_account_code",
     "type": "text",
     "api": "accounting:Quote.LineItems.AccountCode"
    },
    {
     "name": "line_items_account_id",
     "type": "text",
     "api": "accounting:Quote.LineItems.AccountID"
    },
    {
     "name": "line_items_item_code",
     "type": "text",
     "api": "accounting:Quote.LineItems.ItemCode"
    },
    {
     "name": "line_items_item_item_id",
     "type": "text",
     "api": "accounting:Quote.LineItems.Item.ItemID"
    },
    {
     "name": "line_items_item",
     "type": "jsonb",
     "api": "accounting:Quote.LineItems.Item"
    },
    {
     "name": "line_items_tracking",
     "type": "jsonb",
     "api": "accounting:Quote.LineItems.Tracking"
    },
    {
     "name": "line_items_discount_rate",
     "type": "numeric",
     "api": "accounting:Quote.LineItems.DiscountRate"
    },
    {
     "name": "line_items_discount_amount",
     "type": "numeric",
     "api": "accounting:Quote.LineItems.DiscountAmount"
    },
    {
     "name": "line_items_repeating_invoice_id",
     "type": "text",
     "api": "accounting:Quote.LineItems.RepeatingInvoiceID"
    },
    {
     "name": "line_items_taxability",
     "type": "text",
     "api": "accounting:Quote.LineItems.Taxability"
    },
    {
     "name": "line_items_sales_tax_code_id",
     "type": "numeric",
     "api": "accounting:Quote.LineItems.SalesTaxCodeId"
    },
    {
     "name": "line_items_tax_breakdown",
     "type": "jsonb",
     "api": "accounting:Quote.LineItems.TaxBreakdown"
    }
   ]
  },
  "xero_quotes": {
   "id": "xero_quotes",
   "primaryKey": [
    "quote_id"
   ],
   "recordIdField": "QuoteID",
   "sourceObjects": [
    "accounting:Quote"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Quotes",
    "envelope": "Quotes",
    "arrayKey": "Quotes",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "page",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": false,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "quote_id",
     "type": "text",
     "api": "accounting:Quote.QuoteID"
    },
    {
     "name": "quote_number",
     "type": "text",
     "api": "accounting:Quote.QuoteNumber"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:Quote.Status"
    },
    {
     "name": "contact_contact_id",
     "type": "text",
     "api": "accounting:Quote.Contact.ContactID"
    },
    {
     "name": "contact_name",
     "type": "text",
     "api": "accounting:Quote.Contact.Name"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:Quote.Reference"
    },
    {
     "name": "terms",
     "type": "text",
     "api": "accounting:Quote.Terms"
    },
    {
     "name": "title",
     "type": "text",
     "api": "accounting:Quote.Title"
    },
    {
     "name": "summary",
     "type": "text",
     "api": "accounting:Quote.Summary"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:Quote.Date"
    },
    {
     "name": "date_string",
     "type": "text",
     "api": "accounting:Quote.DateString"
    },
    {
     "name": "expiry_date",
     "type": "date",
     "api": "accounting:Quote.ExpiryDate"
    },
    {
     "name": "expiry_date_string",
     "type": "text",
     "api": "accounting:Quote.ExpiryDateString"
    },
    {
     "name": "currency_code",
     "type": "text",
     "api": "accounting:Quote.CurrencyCode"
    },
    {
     "name": "currency_rate",
     "type": "numeric",
     "api": "accounting:Quote.CurrencyRate"
    },
    {
     "name": "line_amount_types",
     "type": "text",
     "api": "accounting:Quote.LineAmountTypes"
    },
    {
     "name": "sub_total",
     "type": "numeric",
     "api": "accounting:Quote.SubTotal"
    },
    {
     "name": "total_tax",
     "type": "numeric",
     "api": "accounting:Quote.TotalTax"
    },
    {
     "name": "total",
     "type": "numeric",
     "api": "accounting:Quote.Total"
    },
    {
     "name": "total_discount",
     "type": "numeric",
     "api": "accounting:Quote.TotalDiscount"
    },
    {
     "name": "branding_theme_id",
     "type": "text",
     "api": "accounting:Quote.BrandingThemeID"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Quote.UpdatedDateUTC"
    },
    {
     "name": "status_attribute_string",
     "type": "text",
     "api": "accounting:Quote.StatusAttributeString"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:Quote.ValidationErrors"
    }
   ]
  },
  "xero_receipt_line_items": {
   "id": "xero_receipt_line_items",
   "primaryKey": [
    "receipt_id",
    "line_ordinal"
   ],
   "recordIdField": "LineItemID",
   "sourceObjects": [
    "accounting:LineItem",
    "accounting:Receipt"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Receipts",
    "envelope": "Receipts",
    "arrayKey": "Receipts",
    "explodePath": "Receipt.LineItems",
    "explodeChain": [
     "Receipt",
     "LineItem"
    ],
    "parentTable": "xero_receipts",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "line_item_id",
     "type": "text",
     "api": "accounting:LineItem.LineItemID"
    },
    {
     "name": "receipt_id",
     "type": "text",
     "api": "accounting:Receipt.ReceiptID"
    },
    {
     "name": "line_ordinal",
     "type": "integer",
     "api": "synthetic:zero-based position of the line in Receipt.LineItems"
    },
    {
     "name": "description",
     "type": "text",
     "api": "accounting:LineItem.Description"
    },
    {
     "name": "quantity",
     "type": "numeric",
     "api": "accounting:LineItem.Quantity"
    },
    {
     "name": "unit_amount",
     "type": "numeric",
     "api": "accounting:LineItem.UnitAmount"
    },
    {
     "name": "item_code",
     "type": "text",
     "api": "accounting:LineItem.ItemCode"
    },
    {
     "name": "account_code",
     "type": "text",
     "api": "accounting:LineItem.AccountCode"
    },
    {
     "name": "account_id",
     "type": "text",
     "api": "accounting:LineItem.AccountID"
    },
    {
     "name": "tax_type",
     "type": "text",
     "api": "accounting:LineItem.TaxType"
    },
    {
     "name": "tax_amount",
     "type": "numeric",
     "api": "accounting:LineItem.TaxAmount"
    },
    {
     "name": "line_amount",
     "type": "numeric",
     "api": "accounting:LineItem.LineAmount"
    },
    {
     "name": "tracking",
     "type": "jsonb",
     "api": "accounting:LineItem.Tracking"
    }
   ]
  },
  "xero_receipts": {
   "id": "xero_receipts",
   "primaryKey": [
    "receipt_id"
   ],
   "recordIdField": "ReceiptID",
   "sourceObjects": [
    "accounting:Receipt"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Receipts",
    "envelope": "Receipts",
    "arrayKey": "Receipts",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "receipt_id",
     "type": "text",
     "api": "accounting:Receipt.ReceiptID"
    },
    {
     "name": "receipt_number",
     "type": "text",
     "api": "accounting:Receipt.ReceiptNumber"
    },
    {
     "name": "date",
     "type": "date",
     "api": "accounting:Receipt.Date"
    },
    {
     "name": "contact_contact_id",
     "type": "text",
     "api": "accounting:Receipt.Contact.ContactID"
    },
    {
     "name": "contact_name",
     "type": "text",
     "api": "accounting:Receipt.Contact.Name"
    },
    {
     "name": "user_user_id",
     "type": "text",
     "api": "accounting:Receipt.User.UserID"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:Receipt.Reference"
    },
    {
     "name": "line_amount_types",
     "type": "text",
     "api": "accounting:Receipt.LineAmountTypes"
    },
    {
     "name": "sub_total",
     "type": "numeric",
     "api": "accounting:Receipt.SubTotal"
    },
    {
     "name": "total_tax",
     "type": "numeric",
     "api": "accounting:Receipt.TotalTax"
    },
    {
     "name": "total",
     "type": "numeric",
     "api": "accounting:Receipt.Total"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:Receipt.Status"
    },
    {
     "name": "url",
     "type": "text",
     "api": "accounting:Receipt.Url"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:Receipt.HasAttachments"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:Receipt.UpdatedDateUTC"
    },
    {
     "name": "validation_errors",
     "type": "jsonb",
     "api": "accounting:Receipt.ValidationErrors"
    },
    {
     "name": "warnings",
     "type": "jsonb",
     "api": "accounting:Receipt.Warnings"
    },
    {
     "name": "attachments",
     "type": "jsonb",
     "api": "accounting:Receipt.Attachments"
    },
    {
     "name": "line_items",
     "type": "jsonb",
     "api": "accounting:Receipt.LineItems"
    }
   ]
  },
  "xero_repeating_invoice_line_items": {
   "id": "xero_repeating_invoice_line_items",
   "primaryKey": [
    "line_items_line_item_id"
   ],
   "recordIdField": "LineItemID",
   "sourceObjects": [
    "accounting:RepeatingInvoice",
    "accounting:LineItem",
    "accounting:LineItemItem",
    "accounting:LineItemTracking",
    "accounting:TaxBreakdownComponent"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /RepeatingInvoices",
    "envelope": "RepeatingInvoices",
    "arrayKey": "RepeatingInvoices",
    "explodePath": "RepeatingInvoice.LineItems",
    "explodeChain": [
     "RepeatingInvoice",
     "LineItem"
    ],
    "parentTable": "xero_repeating_invoices",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "line_items_line_item_id",
     "type": "text",
     "api": "accounting:RepeatingInvoice.LineItems.LineItemID"
    },
    {
     "name": "repeating_invoice_id",
     "type": "text",
     "api": "accounting:RepeatingInvoice.RepeatingInvoiceID"
    },
    {
     "name": "line_items",
     "type": "integer",
     "api": "accounting:RepeatingInvoice.LineItems"
    },
    {
     "name": "line_items_description",
     "type": "text",
     "api": "accounting:RepeatingInvoice.LineItems.Description"
    },
    {
     "name": "line_items_quantity",
     "type": "numeric",
     "api": "accounting:RepeatingInvoice.LineItems.Quantity"
    },
    {
     "name": "line_items_unit_amount",
     "type": "numeric",
     "api": "accounting:RepeatingInvoice.LineItems.UnitAmount"
    },
    {
     "name": "line_items_line_amount",
     "type": "numeric",
     "api": "accounting:RepeatingInvoice.LineItems.LineAmount"
    },
    {
     "name": "line_items_tax_type",
     "type": "text",
     "api": "accounting:RepeatingInvoice.LineItems.TaxType"
    },
    {
     "name": "line_items_tax_amount",
     "type": "numeric",
     "api": "accounting:RepeatingInvoice.LineItems.TaxAmount"
    },
    {
     "name": "line_items_account_code",
     "type": "text",
     "api": "accounting:RepeatingInvoice.LineItems.AccountCode"
    },
    {
     "name": "line_items_account_id",
     "type": "text",
     "api": "accounting:RepeatingInvoice.LineItems.AccountID"
    },
    {
     "name": "line_items_item_code",
     "type": "text",
     "api": "accounting:RepeatingInvoice.LineItems.ItemCode"
    },
    {
     "name": "line_items_item_item_id",
     "type": "text",
     "api": "accounting:RepeatingInvoice.LineItems.Item.ItemID"
    },
    {
     "name": "line_items_item",
     "type": "jsonb",
     "api": "accounting:RepeatingInvoice.LineItems.Item"
    },
    {
     "name": "line_items_tracking",
     "type": "jsonb",
     "api": "accounting:RepeatingInvoice.LineItems.Tracking"
    },
    {
     "name": "line_items_discount_rate",
     "type": "numeric",
     "api": "accounting:RepeatingInvoice.LineItems.DiscountRate"
    },
    {
     "name": "line_items_discount_amount",
     "type": "numeric",
     "api": "accounting:RepeatingInvoice.LineItems.DiscountAmount"
    },
    {
     "name": "line_items_taxability",
     "type": "text",
     "api": "accounting:RepeatingInvoice.LineItems.Taxability"
    },
    {
     "name": "line_items_sales_tax_code_id",
     "type": "numeric",
     "api": "accounting:RepeatingInvoice.LineItems.SalesTaxCodeId"
    },
    {
     "name": "line_items_tax_breakdown",
     "type": "jsonb",
     "api": "accounting:RepeatingInvoice.LineItems.TaxBreakdown"
    }
   ]
  },
  "xero_repeating_invoices": {
   "id": "xero_repeating_invoices",
   "primaryKey": [
    "repeating_invoice_id"
   ],
   "recordIdField": "RepeatingInvoiceID",
   "sourceObjects": [
    "accounting:RepeatingInvoice",
    "accounting:Schedule"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /RepeatingInvoices",
    "envelope": "RepeatingInvoices",
    "arrayKey": "RepeatingInvoices",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.transactions.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "repeating_invoice_id",
     "type": "text",
     "api": "accounting:RepeatingInvoice.RepeatingInvoiceID"
    },
    {
     "name": "id",
     "type": "text",
     "api": "accounting:RepeatingInvoice.ID"
    },
    {
     "name": "type",
     "type": "text",
     "api": "accounting:RepeatingInvoice.Type"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:RepeatingInvoice.Status"
    },
    {
     "name": "contact_contact_id",
     "type": "text",
     "api": "accounting:RepeatingInvoice.Contact.ContactID"
    },
    {
     "name": "contact_name",
     "type": "text",
     "api": "accounting:RepeatingInvoice.Contact.Name"
    },
    {
     "name": "reference",
     "type": "text",
     "api": "accounting:RepeatingInvoice.Reference"
    },
    {
     "name": "line_amount_types",
     "type": "text",
     "api": "accounting:RepeatingInvoice.LineAmountTypes"
    },
    {
     "name": "currency_code",
     "type": "text",
     "api": "accounting:RepeatingInvoice.CurrencyCode"
    },
    {
     "name": "sub_total",
     "type": "numeric",
     "api": "accounting:RepeatingInvoice.SubTotal"
    },
    {
     "name": "total_tax",
     "type": "numeric",
     "api": "accounting:RepeatingInvoice.TotalTax"
    },
    {
     "name": "total",
     "type": "numeric",
     "api": "accounting:RepeatingInvoice.Total"
    },
    {
     "name": "schedule_period",
     "type": "integer",
     "api": "accounting:RepeatingInvoice.Schedule.Period"
    },
    {
     "name": "schedule_unit",
     "type": "text",
     "api": "accounting:RepeatingInvoice.Schedule.Unit"
    },
    {
     "name": "schedule_due_date",
     "type": "integer",
     "api": "accounting:RepeatingInvoice.Schedule.DueDate"
    },
    {
     "name": "schedule_due_date_type",
     "type": "text",
     "api": "accounting:RepeatingInvoice.Schedule.DueDateType"
    },
    {
     "name": "schedule_start_date",
     "type": "date",
     "api": "accounting:RepeatingInvoice.Schedule.StartDate"
    },
    {
     "name": "schedule_next_scheduled_date",
     "type": "date",
     "api": "accounting:RepeatingInvoice.Schedule.NextScheduledDate"
    },
    {
     "name": "schedule_end_date",
     "type": "date",
     "api": "accounting:RepeatingInvoice.Schedule.EndDate"
    },
    {
     "name": "branding_theme_id",
     "type": "text",
     "api": "accounting:RepeatingInvoice.BrandingThemeID"
    },
    {
     "name": "approved_for_sending",
     "type": "boolean",
     "api": "accounting:RepeatingInvoice.ApprovedForSending"
    },
    {
     "name": "send_copy",
     "type": "boolean",
     "api": "accounting:RepeatingInvoice.SendCopy"
    },
    {
     "name": "mark_as_sent",
     "type": "boolean",
     "api": "accounting:RepeatingInvoice.MarkAsSent"
    },
    {
     "name": "include_pdf",
     "type": "boolean",
     "api": "accounting:RepeatingInvoice.IncludePDF"
    },
    {
     "name": "has_attachments",
     "type": "boolean",
     "api": "accounting:RepeatingInvoice.HasAttachments"
    },
    {
     "name": "attachments",
     "type": "jsonb",
     "api": "accounting:RepeatingInvoice.Attachments"
    }
   ]
  },
  "xero_tax_rate_components": {
   "id": "xero_tax_rate_components",
   "primaryKey": [
    "tax_type",
    "tax_components"
   ],
   "recordIdField": null,
   "sourceObjects": [
    "accounting:TaxComponent"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /TaxRates",
    "envelope": "TaxRates",
    "arrayKey": "TaxRates",
    "explodePath": "TaxRate.TaxComponents",
    "explodeChain": [
     "TaxRate",
     "TaxComponent"
    ],
    "parentTable": "xero_tax_rates",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.settings",
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "tax_type",
     "type": "text",
     "api": "accounting:TaxRate.TaxType"
    },
    {
     "name": "tax_components",
     "type": "integer",
     "api": "accounting:TaxRate.TaxComponents"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:TaxComponent.Name"
    },
    {
     "name": "rate",
     "type": "numeric",
     "api": "accounting:TaxComponent.Rate"
    },
    {
     "name": "is_compound",
     "type": "boolean",
     "api": "accounting:TaxComponent.IsCompound"
    },
    {
     "name": "is_non_recoverable",
     "type": "boolean",
     "api": "accounting:TaxComponent.IsNonRecoverable"
    }
   ]
  },
  "xero_tax_rates": {
   "id": "xero_tax_rates",
   "primaryKey": [
    "tax_type"
   ],
   "recordIdField": "TaxType",
   "sourceObjects": [
    "accounting:TaxRate"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /TaxRates",
    "envelope": "TaxRates",
    "arrayKey": "TaxRates",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.settings",
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "tax_type",
     "type": "text",
     "api": "accounting:TaxRate.TaxType"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:TaxRate.Name"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:TaxRate.Status"
    },
    {
     "name": "report_tax_type",
     "type": "text",
     "api": "accounting:TaxRate.ReportTaxType"
    },
    {
     "name": "can_apply_to_assets",
     "type": "boolean",
     "api": "accounting:TaxRate.CanApplyToAssets"
    },
    {
     "name": "can_apply_to_equity",
     "type": "boolean",
     "api": "accounting:TaxRate.CanApplyToEquity"
    },
    {
     "name": "can_apply_to_expenses",
     "type": "boolean",
     "api": "accounting:TaxRate.CanApplyToExpenses"
    },
    {
     "name": "can_apply_to_liabilities",
     "type": "boolean",
     "api": "accounting:TaxRate.CanApplyToLiabilities"
    },
    {
     "name": "can_apply_to_revenue",
     "type": "boolean",
     "api": "accounting:TaxRate.CanApplyToRevenue"
    },
    {
     "name": "display_tax_rate",
     "type": "numeric",
     "api": "accounting:TaxRate.DisplayTaxRate"
    },
    {
     "name": "effective_rate",
     "type": "numeric",
     "api": "accounting:TaxRate.EffectiveRate"
    },
    {
     "name": "tax_components",
     "type": "jsonb",
     "api": "accounting:TaxRate.TaxComponents"
    }
   ]
  },
  "xero_tracking_categories": {
   "id": "xero_tracking_categories",
   "primaryKey": [
    "tracking_category_id"
   ],
   "recordIdField": "TrackingCategoryID",
   "sourceObjects": [
    "accounting:TrackingCategory"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /TrackingCategories",
    "envelope": "TrackingCategories",
    "arrayKey": "TrackingCategories",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.settings",
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "tracking_category_id",
     "type": "text",
     "api": "accounting:TrackingCategory.TrackingCategoryID"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:TrackingCategory.Name"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:TrackingCategory.Status"
    },
    {
     "name": "options",
     "type": "jsonb",
     "api": "accounting:TrackingCategory.Options"
    },
    {
     "name": "tracking_option_id",
     "type": "text",
     "api": "accounting:TrackingCategory.TrackingOptionID"
    },
    {
     "name": "option",
     "type": "text",
     "api": "accounting:TrackingCategory.Option"
    }
   ]
  },
  "xero_tracking_options": {
   "id": "xero_tracking_options",
   "primaryKey": [
    "tracking_option_id"
   ],
   "recordIdField": "TrackingOptionID",
   "sourceObjects": [
    "accounting:TrackingOption"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /TrackingCategories",
    "envelope": "TrackingCategories",
    "arrayKey": "TrackingCategories",
    "explodePath": "TrackingCategory.Options",
    "explodeChain": [
     "TrackingCategory",
     "TrackingOption"
    ],
    "parentTable": "xero_tracking_categories",
    "fanOutParam": null,
    "pagination": "parent",
    "modifiedField": null,
    "whereFilterable": true,
    "scopes": [
     "accounting.settings",
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "tracking_option_id",
     "type": "text",
     "api": "accounting:TrackingOption.TrackingOptionID"
    },
    {
     "name": "tracking_category_id",
     "type": "text",
     "api": "accounting:TrackingOption.TrackingCategoryID"
    },
    {
     "name": "options",
     "type": "integer",
     "api": "accounting:TrackingCategory.Options"
    },
    {
     "name": "name",
     "type": "text",
     "api": "accounting:TrackingOption.Name"
    },
    {
     "name": "status",
     "type": "text",
     "api": "accounting:TrackingOption.Status"
    }
   ]
  },
  "xero_users": {
   "id": "xero_users",
   "primaryKey": [
    "user_id"
   ],
   "recordIdField": "UserID",
   "sourceObjects": [
    "accounting:User"
   ],
   "source": {
    "api": "accounting",
    "endpointOp": "GET /Users",
    "envelope": "Users",
    "arrayKey": "Users",
    "explodePath": null,
    "explodeChain": [],
    "parentTable": null,
    "fanOutParam": null,
    "pagination": "none",
    "modifiedField": "UpdatedDateUTC",
    "whereFilterable": true,
    "scopes": [
     "accounting.settings.read"
    ],
    "availability": "required"
   },
   "columns": [
    {
     "name": "user_id",
     "type": "text",
     "api": "accounting:User.UserID"
    },
    {
     "name": "email_address",
     "type": "text",
     "api": "accounting:User.EmailAddress"
    },
    {
     "name": "first_name",
     "type": "text",
     "api": "accounting:User.FirstName"
    },
    {
     "name": "last_name",
     "type": "text",
     "api": "accounting:User.LastName"
    },
    {
     "name": "updated_date_utc",
     "type": "timestamp",
     "api": "accounting:User.UpdatedDateUTC"
    },
    {
     "name": "is_subscriber",
     "type": "boolean",
     "api": "accounting:User.IsSubscriber"
    },
    {
     "name": "organisation_role",
     "type": "text",
     "api": "accounting:User.OrganisationRole"
    }
   ]
  }
 },
 "groups": [
  {
   "key": "accounting GET /Accounts Accounts",
   "api": "accounting",
   "endpointOp": "GET /Accounts",
   "path": "/api.xro/2.0/Accounts",
   "resource": "Accounts",
   "leader": "xero_accounts",
   "members": [
    {
     "table": "xero_accounts",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /BankTransactions BankTransactions",
   "api": "accounting",
   "endpointOp": "GET /BankTransactions",
   "path": "/api.xro/2.0/BankTransactions",
   "resource": "BankTransactions",
   "leader": "xero_bank_transactions",
   "members": [
    {
     "table": "xero_bank_transactions",
     "projectFrom": null
    },
    {
     "table": "xero_bank_transaction_line_item_tracking",
     "projectFrom": "LineItems.Tracking"
    },
    {
     "table": "xero_bank_transaction_line_items",
     "projectFrom": "LineItems"
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {
    "unitdp": "4"
   },
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /BankTransfers BankTransfers",
   "api": "accounting",
   "endpointOp": "GET /BankTransfers",
   "path": "/api.xro/2.0/BankTransfers",
   "resource": "BankTransfers",
   "leader": "xero_bank_transfers",
   "members": [
    {
     "table": "xero_bank_transfers",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": "CreatedDateUTC",
   "whereFilterable": true,
   "baseParams": {
    "includeDeleted": "true"
   },
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /BatchPayments BatchPayments",
   "api": "accounting",
   "endpointOp": "GET /BatchPayments",
   "path": "/api.xro/2.0/BatchPayments",
   "resource": "BatchPayments",
   "leader": "xero_batch_payments",
   "members": [
    {
     "table": "xero_batch_payments",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /BrandingThemes BrandingThemes",
   "api": "accounting",
   "endpointOp": "GET /BrandingThemes",
   "path": "/api.xro/2.0/BrandingThemes",
   "resource": "BrandingThemes",
   "leader": "xero_branding_themes",
   "members": [
    {
     "table": "xero_branding_themes",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Budgets Budgets",
   "api": "accounting",
   "endpointOp": "GET /Budgets",
   "path": "/api.xro/2.0/Budgets",
   "resource": "Budgets",
   "leader": "xero_budgets",
   "members": [
    {
     "table": "xero_budgets",
     "projectFrom": null
    },
    {
     "table": "xero_budget_tracking",
     "projectFrom": "Tracking"
    }
   ],
   "pagination": "none",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /ContactGroups ContactGroups",
   "api": "accounting",
   "endpointOp": "GET /ContactGroups",
   "path": "/api.xro/2.0/ContactGroups",
   "resource": "ContactGroups",
   "leader": "xero_contact_groups",
   "members": [
    {
     "table": "xero_contact_groups",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Contacts Contacts",
   "api": "accounting",
   "endpointOp": "GET /Contacts",
   "path": "/api.xro/2.0/Contacts",
   "resource": "Contacts",
   "leader": "xero_contacts",
   "members": [
    {
     "table": "xero_contacts",
     "projectFrom": null
    },
    {
     "table": "xero_contact_addresses",
     "projectFrom": "Addresses"
    },
    {
     "table": "xero_contact_balances",
     "projectFrom": "Balances"
    },
    {
     "table": "xero_contact_persons",
     "projectFrom": "ContactPersons"
    },
    {
     "table": "xero_contact_phones",
     "projectFrom": "Phones"
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {
    "includeArchived": "true"
   },
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /CreditNotes CreditNotes",
   "api": "accounting",
   "endpointOp": "GET /CreditNotes",
   "path": "/api.xro/2.0/CreditNotes",
   "resource": "CreditNotes",
   "leader": "xero_credit_notes",
   "members": [
    {
     "table": "xero_credit_notes",
     "projectFrom": null
    },
    {
     "table": "xero_credit_note_allocations",
     "projectFrom": "Allocations"
    },
    {
     "table": "xero_credit_note_line_items",
     "projectFrom": "LineItems"
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {
    "unitdp": "4"
   },
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Currencies Currencies",
   "api": "accounting",
   "endpointOp": "GET /Currencies",
   "path": "/api.xro/2.0/Currencies",
   "resource": "Currencies",
   "leader": "xero_currencies",
   "members": [
    {
     "table": "xero_currencies",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /ExpenseClaims ExpenseClaims",
   "api": "accounting",
   "endpointOp": "GET /ExpenseClaims",
   "path": "/api.xro/2.0/ExpenseClaims",
   "resource": "ExpenseClaims",
   "leader": "xero_expense_claims",
   "members": [
    {
     "table": "xero_expense_claims",
     "projectFrom": null
    },
    {
     "table": "xero_expense_claim_payments",
     "projectFrom": "Payments"
    },
    {
     "table": "xero_expense_claim_receipts",
     "projectFrom": "Receipts"
    }
   ],
   "pagination": "none",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /InvoiceReminders/Settings InvoiceReminders",
   "api": "accounting",
   "endpointOp": "GET /InvoiceReminders/Settings",
   "path": "/api.xro/2.0/InvoiceReminders/Settings",
   "resource": "InvoiceReminders",
   "leader": "xero_invoice_reminders",
   "members": [
    {
     "table": "xero_invoice_reminders",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Invoices Invoices",
   "api": "accounting",
   "endpointOp": "GET /Invoices",
   "path": "/api.xro/2.0/Invoices",
   "resource": "Invoices",
   "leader": "xero_invoices",
   "members": [
    {
     "table": "xero_invoices",
     "projectFrom": null
    },
    {
     "table": "xero_invoice_line_items",
     "projectFrom": "LineItems"
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {
    "unitdp": "4"
   },
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Items Items",
   "api": "accounting",
   "endpointOp": "GET /Items",
   "path": "/api.xro/2.0/Items",
   "resource": "Items",
   "leader": "xero_items",
   "members": [
    {
     "table": "xero_items",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {
    "unitdp": "4"
   },
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Journals Journals",
   "api": "accounting",
   "endpointOp": "GET /Journals",
   "path": "/api.xro/2.0/Journals",
   "resource": "Journals",
   "leader": "xero_journals",
   "members": [
    {
     "table": "xero_journals",
     "projectFrom": null
    },
    {
     "table": "xero_journal_line_tracking",
     "projectFrom": "JournalLines.TrackingCategories"
    },
    {
     "table": "xero_journal_lines",
     "projectFrom": "JournalLines"
    }
   ],
   "pagination": "offset",
   "modifiedField": "CreatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "optional"
  },
  {
   "key": "accounting GET /LinkedTransactions LinkedTransactions",
   "api": "accounting",
   "endpointOp": "GET /LinkedTransactions",
   "path": "/api.xro/2.0/LinkedTransactions",
   "resource": "LinkedTransactions",
   "leader": "xero_linked_transactions",
   "members": [
    {
     "table": "xero_linked_transactions",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /ManualJournals ManualJournals",
   "api": "accounting",
   "endpointOp": "GET /ManualJournals",
   "path": "/api.xro/2.0/ManualJournals",
   "resource": "ManualJournals",
   "leader": "xero_manual_journals",
   "members": [
    {
     "table": "xero_manual_journals",
     "projectFrom": null
    },
    {
     "table": "xero_manual_journal_line_tracking",
     "projectFrom": "JournalLines.Tracking"
    },
    {
     "table": "xero_manual_journal_lines",
     "projectFrom": "JournalLines"
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Organisation Organisations",
   "api": "accounting",
   "endpointOp": "GET /Organisation",
   "path": "/api.xro/2.0/Organisation",
   "resource": "Organisations",
   "leader": "xero_organisations",
   "members": [
    {
     "table": "xero_organisations",
     "projectFrom": null
    },
    {
     "table": "xero_organisation_addresses",
     "projectFrom": "Addresses"
    },
    {
     "table": "xero_organisation_external_links",
     "projectFrom": "ExternalLinks"
    },
    {
     "table": "xero_organisation_payment_terms",
     "projectFrom": "PaymentTerms"
    },
    {
     "table": "xero_organisation_phones",
     "projectFrom": "Phones"
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Organisation/Actions Actions",
   "api": "accounting",
   "endpointOp": "GET /Organisation/Actions",
   "path": "/api.xro/2.0/Organisation/Actions",
   "resource": "Actions",
   "leader": "xero_organisation_actions",
   "members": [
    {
     "table": "xero_organisation_actions",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Overpayments Overpayments",
   "api": "accounting",
   "endpointOp": "GET /Overpayments",
   "path": "/api.xro/2.0/Overpayments",
   "resource": "Overpayments",
   "leader": "xero_overpayments",
   "members": [
    {
     "table": "xero_overpayments",
     "projectFrom": null
    },
    {
     "table": "xero_overpayment_allocations",
     "projectFrom": "Allocations"
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {
    "unitdp": "4"
   },
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Payments Payments",
   "api": "accounting",
   "endpointOp": "GET /Payments",
   "path": "/api.xro/2.0/Payments",
   "resource": "Payments",
   "leader": "xero_payments",
   "members": [
    {
     "table": "xero_payments",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /PaymentServices PaymentServices",
   "api": "accounting",
   "endpointOp": "GET /PaymentServices",
   "path": "/api.xro/2.0/PaymentServices",
   "resource": "PaymentServices",
   "leader": "xero_payment_services",
   "members": [
    {
     "table": "xero_payment_services",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Prepayments Prepayments",
   "api": "accounting",
   "endpointOp": "GET /Prepayments",
   "path": "/api.xro/2.0/Prepayments",
   "resource": "Prepayments",
   "leader": "xero_prepayments",
   "members": [
    {
     "table": "xero_prepayments",
     "projectFrom": null
    },
    {
     "table": "xero_prepayment_allocations",
     "projectFrom": "Allocations"
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {
    "unitdp": "4"
   },
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /PurchaseOrders PurchaseOrders",
   "api": "accounting",
   "endpointOp": "GET /PurchaseOrders",
   "path": "/api.xro/2.0/PurchaseOrders",
   "resource": "PurchaseOrders",
   "leader": "xero_purchase_orders",
   "members": [
    {
     "table": "xero_purchase_orders",
     "projectFrom": null
    },
    {
     "table": "xero_purchase_order_line_items",
     "projectFrom": "LineItems"
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Quotes Quotes",
   "api": "accounting",
   "endpointOp": "GET /Quotes",
   "path": "/api.xro/2.0/Quotes",
   "resource": "Quotes",
   "leader": "xero_quotes",
   "members": [
    {
     "table": "xero_quotes",
     "projectFrom": null
    },
    {
     "table": "xero_quote_line_items",
     "projectFrom": "LineItems"
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Receipts Receipts",
   "api": "accounting",
   "endpointOp": "GET /Receipts",
   "path": "/api.xro/2.0/Receipts",
   "resource": "Receipts",
   "leader": "xero_receipts",
   "members": [
    {
     "table": "xero_receipts",
     "projectFrom": null
    },
    {
     "table": "xero_receipt_line_items",
     "projectFrom": "LineItems"
    }
   ],
   "pagination": "none",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {
    "unitdp": "4"
   },
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /RepeatingInvoices RepeatingInvoices",
   "api": "accounting",
   "endpointOp": "GET /RepeatingInvoices",
   "path": "/api.xro/2.0/RepeatingInvoices",
   "resource": "RepeatingInvoices",
   "leader": "xero_repeating_invoices",
   "members": [
    {
     "table": "xero_repeating_invoices",
     "projectFrom": null
    },
    {
     "table": "xero_repeating_invoice_line_items",
     "projectFrom": "LineItems"
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Reports/TenNinetyNine Reports",
   "api": "accounting",
   "endpointOp": "GET /Reports/TenNinetyNine",
   "path": "/api.xro/2.0/Reports/TenNinetyNine",
   "resource": "Reports",
   "leader": "xero_1099_reports",
   "members": [
    {
     "table": "xero_1099_reports",
     "projectFrom": null
    },
    {
     "table": "xero_1099_contacts",
     "projectFrom": "Contacts"
    }
   ],
   "pagination": "none",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [
    {
     "reportYear": "2025"
    },
    {
     "reportYear": "2024"
    },
    {
     "reportYear": "2023"
    },
    {
     "reportYear": "2022"
    }
   ],
   "availability": "optional"
  },
  {
   "key": "accounting GET /TaxRates TaxRates",
   "api": "accounting",
   "endpointOp": "GET /TaxRates",
   "path": "/api.xro/2.0/TaxRates",
   "resource": "TaxRates",
   "leader": "xero_tax_rates",
   "members": [
    {
     "table": "xero_tax_rates",
     "projectFrom": null
    },
    {
     "table": "xero_tax_rate_components",
     "projectFrom": "TaxComponents"
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /TrackingCategories TrackingCategories",
   "api": "accounting",
   "endpointOp": "GET /TrackingCategories",
   "path": "/api.xro/2.0/TrackingCategories",
   "resource": "TrackingCategories",
   "leader": "xero_tracking_categories",
   "members": [
    {
     "table": "xero_tracking_categories",
     "projectFrom": null
    },
    {
     "table": "xero_tracking_options",
     "projectFrom": "Options"
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "accounting GET /Users Users",
   "api": "accounting",
   "endpointOp": "GET /Users",
   "path": "/api.xro/2.0/Users",
   "resource": "Users",
   "leader": "xero_users",
   "members": [
    {
     "table": "xero_users",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "assets GET /Assets items",
   "api": "assets",
   "endpointOp": "GET /Assets",
   "path": "/assets.xro/1.0/Assets",
   "resource": "items",
   "leader": "xero_assets",
   "members": [
    {
     "table": "xero_assets",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [
    {
     "status": "REGISTERED"
    },
    {
     "status": "DRAFT"
    },
    {
     "status": "DISPOSED"
    }
   ],
   "availability": "required"
  },
  {
   "key": "assets GET /AssetTypes",
   "api": "assets",
   "endpointOp": "GET /AssetTypes",
   "path": "/assets.xro/1.0/AssetTypes",
   "resource": "AssetType",
   "leader": "xero_asset_types",
   "members": [
    {
     "table": "xero_asset_types",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "assets GET /Settings",
   "api": "assets",
   "endpointOp": "GET /Settings",
   "path": "/assets.xro/1.0/Settings",
   "resource": "Setting",
   "leader": "xero_asset_settings",
   "members": [
    {
     "table": "xero_asset_settings",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "files GET /Files Items",
   "api": "files",
   "endpointOp": "GET /Files",
   "path": "/files.xro/1.0/Files",
   "resource": "Items",
   "leader": "xero_files",
   "members": [
    {
     "table": "xero_files",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUtc",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "files GET /Folders",
   "api": "files",
   "endpointOp": "GET /Folders",
   "path": "/files.xro/1.0/Folders",
   "resource": "Folder",
   "leader": "xero_folders",
   "members": [
    {
     "table": "xero_folders",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "identity GET /Connections",
   "api": "identity",
   "endpointOp": "GET /Connections",
   "path": "/connections",
   "resource": "Connection",
   "leader": "xero_connections",
   "members": [
    {
     "table": "xero_connections",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": "updatedDateUtc",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_au GET /Employees Employees",
   "api": "payroll_au",
   "endpointOp": "GET /Employees",
   "path": "/payroll.xro/1.0/Employees",
   "resource": "Employees",
   "leader": "xero_payroll_au_employees",
   "members": [
    {
     "table": "xero_payroll_au_employees",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_au GET /LeaveApplications/v2 LeaveApplications",
   "api": "payroll_au",
   "endpointOp": "GET /LeaveApplications/v2",
   "path": "/payroll.xro/1.0/LeaveApplications/v2",
   "resource": "LeaveApplications",
   "leader": "xero_payroll_au_leave_applications",
   "members": [
    {
     "table": "xero_payroll_au_leave_applications",
     "projectFrom": null
    },
    {
     "table": "xero_payroll_au_leave_periods",
     "projectFrom": "LeavePeriods"
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_au GET /PayItems PayItems.DeductionTypes",
   "api": "payroll_au",
   "endpointOp": "GET /PayItems",
   "path": "/payroll.xro/1.0/PayItems",
   "resource": "PayItems.DeductionTypes",
   "leader": "xero_payroll_au_deduction_types",
   "members": [
    {
     "table": "xero_payroll_au_deduction_types",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_au GET /PayItems PayItems.EarningsRates",
   "api": "payroll_au",
   "endpointOp": "GET /PayItems",
   "path": "/payroll.xro/1.0/PayItems",
   "resource": "PayItems.EarningsRates",
   "leader": "xero_payroll_au_earnings_rates",
   "members": [
    {
     "table": "xero_payroll_au_earnings_rates",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_au GET /PayItems PayItems.LeaveTypes",
   "api": "payroll_au",
   "endpointOp": "GET /PayItems",
   "path": "/payroll.xro/1.0/PayItems",
   "resource": "PayItems.LeaveTypes",
   "leader": "xero_payroll_au_leave_types",
   "members": [
    {
     "table": "xero_payroll_au_leave_types",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_au GET /PayItems PayItems.ReimbursementTypes",
   "api": "payroll_au",
   "endpointOp": "GET /PayItems",
   "path": "/payroll.xro/1.0/PayItems",
   "resource": "PayItems.ReimbursementTypes",
   "leader": "xero_payroll_au_reimbursement_types",
   "members": [
    {
     "table": "xero_payroll_au_reimbursement_types",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_au GET /PayrollCalendars PayrollCalendars",
   "api": "payroll_au",
   "endpointOp": "GET /PayrollCalendars",
   "path": "/payroll.xro/1.0/PayrollCalendars",
   "resource": "PayrollCalendars",
   "leader": "xero_payroll_au_payroll_calendars",
   "members": [
    {
     "table": "xero_payroll_au_payroll_calendars",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_au GET /PayRuns PayRuns",
   "api": "payroll_au",
   "endpointOp": "GET /PayRuns",
   "path": "/payroll.xro/1.0/PayRuns",
   "resource": "PayRuns",
   "leader": "xero_payroll_au_pay_runs",
   "members": [
    {
     "table": "xero_payroll_au_pay_runs",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_au GET /Settings Settings",
   "api": "payroll_au",
   "endpointOp": "GET /Settings",
   "path": "/payroll.xro/1.0/Settings",
   "resource": "Settings",
   "leader": "xero_payroll_au_settings",
   "members": [
    {
     "table": "xero_payroll_au_settings",
     "projectFrom": null
    },
    {
     "table": "xero_payroll_au_settings_accounts",
     "projectFrom": "Accounts"
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_au GET /Superfunds SuperFunds",
   "api": "payroll_au",
   "endpointOp": "GET /Superfunds",
   "path": "/payroll.xro/1.0/Superfunds",
   "resource": "SuperFunds",
   "leader": "xero_payroll_au_super_funds",
   "members": [
    {
     "table": "xero_payroll_au_super_funds",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_au GET /Timesheets Timesheets",
   "api": "payroll_au",
   "endpointOp": "GET /Timesheets",
   "path": "/payroll.xro/1.0/Timesheets",
   "resource": "Timesheets",
   "leader": "xero_payroll_au_timesheets",
   "members": [
    {
     "table": "xero_payroll_au_timesheets",
     "projectFrom": null
    },
    {
     "table": "xero_payroll_au_timesheet_lines",
     "projectFrom": "TimesheetLines"
    }
   ],
   "pagination": "page",
   "modifiedField": "UpdatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /Deductions deductions",
   "api": "payroll_nz",
   "endpointOp": "GET /Deductions",
   "path": "/payroll.xro/2.0/Deductions",
   "resource": "deductions",
   "leader": "xero_payroll_nz_deductions",
   "members": [
    {
     "table": "xero_payroll_nz_deductions",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /EarningsRates earningsRates",
   "api": "payroll_nz",
   "endpointOp": "GET /EarningsRates",
   "path": "/payroll.xro/2.0/EarningsRates",
   "resource": "earningsRates",
   "leader": "xero_payroll_nz_earnings_rates",
   "members": [
    {
     "table": "xero_payroll_nz_earnings_rates",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /Employees employees",
   "api": "payroll_nz",
   "endpointOp": "GET /Employees",
   "path": "/payroll.xro/2.0/Employees",
   "resource": "employees",
   "leader": "xero_payroll_nz_employees",
   "members": [
    {
     "table": "xero_payroll_nz_employees",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "updatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /LeaveTypes leaveTypes",
   "api": "payroll_nz",
   "endpointOp": "GET /LeaveTypes",
   "path": "/payroll.xro/2.0/LeaveTypes",
   "resource": "leaveTypes",
   "leader": "xero_payroll_nz_leave_types",
   "members": [
    {
     "table": "xero_payroll_nz_leave_types",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "updatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /PayRunCalendars payRunCalendars",
   "api": "payroll_nz",
   "endpointOp": "GET /PayRunCalendars",
   "path": "/payroll.xro/2.0/PayRunCalendars",
   "resource": "payRunCalendars",
   "leader": "xero_payroll_nz_pay_run_calendars",
   "members": [
    {
     "table": "xero_payroll_nz_pay_run_calendars",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "updatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /PayRuns payRuns",
   "api": "payroll_nz",
   "endpointOp": "GET /PayRuns",
   "path": "/payroll.xro/2.0/PayRuns",
   "resource": "payRuns",
   "leader": "xero_payroll_nz_pay_runs",
   "members": [
    {
     "table": "xero_payroll_nz_pay_runs",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /PaySlips paySlips",
   "api": "payroll_nz",
   "endpointOp": "GET /PaySlips",
   "path": "/payroll.xro/2.0/PaySlips",
   "resource": "paySlips",
   "leader": "xero_payroll_nz_payslips",
   "members": [
    {
     "table": "xero_payroll_nz_payslips",
     "projectFrom": null
    },
    {
     "table": "xero_payroll_nz_payslip_deduction_lines",
     "projectFrom": "deductionLines"
    },
    {
     "table": "xero_payroll_nz_payslip_earnings_lines",
     "projectFrom": "earningsLines"
    },
    {
     "table": "xero_payroll_nz_payslip_employee_tax_lines",
     "projectFrom": "employeeTaxLines"
    },
    {
     "table": "xero_payroll_nz_payslip_employer_tax_lines",
     "projectFrom": "employerTaxLines"
    },
    {
     "table": "xero_payroll_nz_payslip_leave_accrual_lines",
     "projectFrom": "leaveAccrualLines"
    },
    {
     "table": "xero_payroll_nz_payslip_leave_earnings_lines",
     "projectFrom": "leaveEarningsLines"
    },
    {
     "table": "xero_payroll_nz_payslip_payment_lines",
     "projectFrom": "paymentLines"
    },
    {
     "table": "xero_payroll_nz_payslip_reimbursement_lines",
     "projectFrom": "reimbursementLines"
    },
    {
     "table": "xero_payroll_nz_payslip_statutory_deduction_lines",
     "projectFrom": "statutoryDeductionLines"
    },
    {
     "table": "xero_payroll_nz_payslip_superannuation_lines",
     "projectFrom": "superannuationLines"
    },
    {
     "table": "xero_payroll_nz_payslip_timesheet_earnings_lines",
     "projectFrom": "timesheetEarningsLines"
    }
   ],
   "pagination": "page",
   "modifiedField": "lastEdited",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /Reimbursements reimbursements",
   "api": "payroll_nz",
   "endpointOp": "GET /Reimbursements",
   "path": "/payroll.xro/2.0/Reimbursements",
   "resource": "reimbursements",
   "leader": "xero_payroll_nz_reimbursements",
   "members": [
    {
     "table": "xero_payroll_nz_reimbursements",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /Settings settings.accounts",
   "api": "payroll_nz",
   "endpointOp": "GET /Settings",
   "path": "/payroll.xro/2.0/Settings",
   "resource": "settings.accounts",
   "leader": "xero_payroll_nz_settings_accounts",
   "members": [
    {
     "table": "xero_payroll_nz_settings_accounts",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /Settings/TrackingCategories trackingCategories",
   "api": "payroll_nz",
   "endpointOp": "GET /Settings/TrackingCategories",
   "path": "/payroll.xro/2.0/Settings/TrackingCategories",
   "resource": "trackingCategories",
   "leader": "xero_payroll_nz_tracking_categories",
   "members": [
    {
     "table": "xero_payroll_nz_tracking_categories",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /StatutoryDeductions statutoryDeductions",
   "api": "payroll_nz",
   "endpointOp": "GET /StatutoryDeductions",
   "path": "/payroll.xro/2.0/StatutoryDeductions",
   "resource": "statutoryDeductions",
   "leader": "xero_payroll_nz_statutory_deductions",
   "members": [
    {
     "table": "xero_payroll_nz_statutory_deductions",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /Superannuations superannuations",
   "api": "payroll_nz",
   "endpointOp": "GET /Superannuations",
   "path": "/payroll.xro/2.0/Superannuations",
   "resource": "superannuations",
   "leader": "xero_payroll_nz_superannuations",
   "members": [
    {
     "table": "xero_payroll_nz_superannuations",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_nz GET /Timesheets timesheets",
   "api": "payroll_nz",
   "endpointOp": "GET /Timesheets",
   "path": "/payroll.xro/2.0/Timesheets",
   "resource": "timesheets",
   "leader": "xero_payroll_nz_timesheets",
   "members": [
    {
     "table": "xero_payroll_nz_timesheets",
     "projectFrom": null
    },
    {
     "table": "xero_payroll_nz_timesheet_lines",
     "projectFrom": "timesheetLines"
    }
   ],
   "pagination": "page",
   "modifiedField": "updatedDateUTC",
   "whereFilterable": true,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /Benefits benefits",
   "api": "payroll_uk",
   "endpointOp": "GET /Benefits",
   "path": "/payroll.xro/2.0/Benefits",
   "resource": "benefits",
   "leader": "xero_payroll_uk_benefits",
   "members": [
    {
     "table": "xero_payroll_uk_benefits",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /Deductions deductions",
   "api": "payroll_uk",
   "endpointOp": "GET /Deductions",
   "path": "/payroll.xro/2.0/Deductions",
   "resource": "deductions",
   "leader": "xero_payroll_uk_deductions",
   "members": [
    {
     "table": "xero_payroll_uk_deductions",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /EarningsOrders statutoryDeductions",
   "api": "payroll_uk",
   "endpointOp": "GET /EarningsOrders",
   "path": "/payroll.xro/2.0/EarningsOrders",
   "resource": "statutoryDeductions",
   "leader": "xero_payroll_uk_earnings_orders",
   "members": [
    {
     "table": "xero_payroll_uk_earnings_orders",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /EarningsRates earningsRates",
   "api": "payroll_uk",
   "endpointOp": "GET /EarningsRates",
   "path": "/payroll.xro/2.0/EarningsRates",
   "resource": "earningsRates",
   "leader": "xero_payroll_uk_earnings_rates",
   "members": [
    {
     "table": "xero_payroll_uk_earnings_rates",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /Employees employees",
   "api": "payroll_uk",
   "endpointOp": "GET /Employees",
   "path": "/payroll.xro/2.0/Employees",
   "resource": "employees",
   "leader": "xero_payroll_uk_employees",
   "members": [
    {
     "table": "xero_payroll_uk_employees",
     "projectFrom": null
    },
    {
     "table": "xero_payroll_uk_employee_contracts",
     "projectFrom": "contracts"
    },
    {
     "table": "xero_payroll_uk_employee_ni_categories",
     "projectFrom": "niCategories"
    }
   ],
   "pagination": "page",
   "modifiedField": "updatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /LeaveTypes leaveTypes",
   "api": "payroll_uk",
   "endpointOp": "GET /LeaveTypes",
   "path": "/payroll.xro/2.0/LeaveTypes",
   "resource": "leaveTypes",
   "leader": "xero_payroll_uk_leave_types",
   "members": [
    {
     "table": "xero_payroll_uk_leave_types",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "updatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /PayRunCalendars payRunCalendars",
   "api": "payroll_uk",
   "endpointOp": "GET /PayRunCalendars",
   "path": "/payroll.xro/2.0/PayRunCalendars",
   "resource": "payRunCalendars",
   "leader": "xero_payroll_uk_pay_run_calendars",
   "members": [
    {
     "table": "xero_payroll_uk_pay_run_calendars",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": "updatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /PayRuns payRuns",
   "api": "payroll_uk",
   "endpointOp": "GET /PayRuns",
   "path": "/payroll.xro/2.0/PayRuns",
   "resource": "payRuns",
   "leader": "xero_payroll_uk_pay_runs",
   "members": [
    {
     "table": "xero_payroll_uk_pay_runs",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /Reimbursements reimbursements",
   "api": "payroll_uk",
   "endpointOp": "GET /Reimbursements",
   "path": "/payroll.xro/2.0/Reimbursements",
   "resource": "reimbursements",
   "leader": "xero_payroll_uk_reimbursements",
   "members": [
    {
     "table": "xero_payroll_uk_reimbursements",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /Settings settings.accounts",
   "api": "payroll_uk",
   "endpointOp": "GET /Settings",
   "path": "/payroll.xro/2.0/Settings",
   "resource": "settings.accounts",
   "leader": "xero_payroll_uk_settings_accounts",
   "members": [
    {
     "table": "xero_payroll_uk_settings_accounts",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /Settings/trackingCategories trackingCategories",
   "api": "payroll_uk",
   "endpointOp": "GET /Settings/trackingCategories",
   "path": "/payroll.xro/2.0/Settings/trackingCategories",
   "resource": "trackingCategories",
   "leader": "xero_payroll_uk_tracking_categories",
   "members": [
    {
     "table": "xero_payroll_uk_tracking_categories",
     "projectFrom": null
    }
   ],
   "pagination": "none",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "payroll_uk GET /Timesheets timesheets",
   "api": "payroll_uk",
   "endpointOp": "GET /Timesheets",
   "path": "/payroll.xro/2.0/Timesheets",
   "resource": "timesheets",
   "leader": "xero_payroll_uk_timesheets",
   "members": [
    {
     "table": "xero_payroll_uk_timesheets",
     "projectFrom": null
    },
    {
     "table": "xero_payroll_uk_timesheet_lines",
     "projectFrom": "timesheetLines"
    }
   ],
   "pagination": "page",
   "modifiedField": "updatedDateUTC",
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "projects GET /Projects items",
   "api": "projects",
   "endpointOp": "GET /Projects",
   "path": "/projects.xro/2.0/Projects",
   "resource": "items",
   "leader": "xero_projects",
   "members": [
    {
     "table": "xero_projects",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  },
  {
   "key": "projects GET /ProjectsUsers items",
   "api": "projects",
   "endpointOp": "GET /ProjectsUsers",
   "path": "/projects.xro/2.0/ProjectsUsers",
   "resource": "items",
   "leader": "xero_project_users",
   "members": [
    {
     "table": "xero_project_users",
     "projectFrom": null
    }
   ],
   "pagination": "page",
   "modifiedField": null,
   "whereFilterable": false,
   "baseParams": {},
   "extraPasses": [],
   "availability": "required"
  }
 ],
 "fanOuts": [
  {
   "id": "xero_attachments",
   "api": "accounting",
   "endpointOp": "GET /{Endpoint}/{Guid}/Attachments",
   "path": "/api.xro/2.0/{Endpoint}/{Guid}/Attachments",
   "fanOutParam": "Guid",
   "parentTable": null,
   "availability": "optional",
   "members": [],
   "templatedParents": [
    {
     "endpointOp": "GET /Accounts",
     "pathTemplate": "/Accounts/{AccountID}/Attachments",
     "idParam": "AccountID"
    },
    {
     "endpointOp": "GET /BankTransactions",
     "pathTemplate": "/BankTransactions/{BankTransactionID}/Attachments",
     "idParam": "BankTransactionID"
    },
    {
     "endpointOp": "GET /BankTransfers",
     "pathTemplate": "/BankTransfers/{BankTransferID}/Attachments",
     "idParam": "BankTransferID"
    },
    {
     "endpointOp": "GET /Contacts",
     "pathTemplate": "/Contacts/{ContactID}/Attachments",
     "idParam": "ContactID"
    },
    {
     "endpointOp": "GET /CreditNotes",
     "pathTemplate": "/CreditNotes/{CreditNoteID}/Attachments",
     "idParam": "CreditNoteID"
    },
    {
     "endpointOp": "GET /Invoices",
     "pathTemplate": "/Invoices/{InvoiceID}/Attachments",
     "idParam": "InvoiceID"
    },
    {
     "endpointOp": "GET /ManualJournals",
     "pathTemplate": "/ManualJournals/{ManualJournalID}/Attachments",
     "idParam": "ManualJournalID"
    },
    {
     "endpointOp": "GET /PurchaseOrders",
     "pathTemplate": "/PurchaseOrders/{PurchaseOrderID}/Attachments",
     "idParam": "PurchaseOrderID"
    },
    {
     "endpointOp": "GET /Quotes",
     "pathTemplate": "/Quotes/{QuoteID}/Attachments",
     "idParam": "QuoteID"
    },
    {
     "endpointOp": "GET /Receipts",
     "pathTemplate": "/Receipts/{ReceiptID}/Attachments",
     "idParam": "ReceiptID"
    },
    {
     "endpointOp": "GET /RepeatingInvoices",
     "pathTemplate": "/RepeatingInvoices/{RepeatingInvoiceID}/Attachments",
     "idParam": "RepeatingInvoiceID"
    }
   ]
  },
  {
   "id": "xero_budget_lines",
   "api": "accounting",
   "endpointOp": "GET /Budgets/{BudgetID}",
   "path": "/api.xro/2.0/Budgets/{BudgetID}",
   "fanOutParam": "BudgetID",
   "parentTable": "xero_budgets",
   "availability": "required",
   "members": [
    {
     "table": "xero_budget_balances",
     "projectFrom": "BudgetLines.BudgetBalances"
    }
   ],
   "templatedParents": null
  },
  {
   "id": "xero_contact_cis_settings",
   "api": "accounting",
   "endpointOp": "GET /Contacts/{ContactID}/CISSettings",
   "path": "/api.xro/2.0/Contacts/{ContactID}/CISSettings",
   "fanOutParam": "ContactID",
   "parentTable": "xero_contacts",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_contact_group_members",
   "api": "accounting",
   "endpointOp": "GET /ContactGroups/{ContactGroupID}",
   "path": "/api.xro/2.0/ContactGroups/{ContactGroupID}",
   "fanOutParam": "ContactGroupID",
   "parentTable": "xero_contact_groups",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_file_associations",
   "api": "files",
   "endpointOp": "GET /Files/{FileId}/Associations",
   "path": "/files.xro/1.0/Files/{FileId}/Associations",
   "fanOutParam": "FileId",
   "parentTable": "xero_files",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_history_records",
   "api": "accounting",
   "endpointOp": "GET /{Endpoint}/{Guid}/History",
   "path": "/api.xro/2.0/{Endpoint}/{Guid}/History",
   "fanOutParam": "Guid",
   "parentTable": null,
   "availability": "optional",
   "members": [],
   "templatedParents": [
    {
     "endpointOp": "GET /BankTransactions",
     "pathTemplate": "/BankTransactions/{BankTransactionID}/History",
     "idParam": "BankTransactionID"
    },
    {
     "endpointOp": "GET /BankTransfers",
     "pathTemplate": "/BankTransfers/{BankTransferID}/History",
     "idParam": "BankTransferID"
    },
    {
     "endpointOp": "GET /BatchPayments",
     "pathTemplate": "/BatchPayments/{BatchPaymentID}/History",
     "idParam": "BatchPaymentID"
    },
    {
     "endpointOp": "GET /Contacts",
     "pathTemplate": "/Contacts/{ContactID}/History",
     "idParam": "ContactID"
    },
    {
     "endpointOp": "GET /CreditNotes",
     "pathTemplate": "/CreditNotes/{CreditNoteID}/History",
     "idParam": "CreditNoteID"
    },
    {
     "endpointOp": "GET /ExpenseClaims",
     "pathTemplate": "/ExpenseClaims/{ExpenseClaimID}/History",
     "idParam": "ExpenseClaimID"
    },
    {
     "endpointOp": "GET /Invoices",
     "pathTemplate": "/Invoices/{InvoiceID}/History",
     "idParam": "InvoiceID"
    },
    {
     "endpointOp": "GET /Items",
     "pathTemplate": "/Items/{ItemID}/History",
     "idParam": "ItemID"
    },
    {
     "endpointOp": "GET /ManualJournals",
     "pathTemplate": "/ManualJournals/{ManualJournalID}/History",
     "idParam": "ManualJournalID"
    },
    {
     "endpointOp": "GET /Overpayments",
     "pathTemplate": "/Overpayments/{OverpaymentID}/History",
     "idParam": "OverpaymentID"
    },
    {
     "endpointOp": "GET /Payments",
     "pathTemplate": "/Payments/{PaymentID}/History",
     "idParam": "PaymentID"
    },
    {
     "endpointOp": "GET /Prepayments",
     "pathTemplate": "/Prepayments/{PrepaymentID}/History",
     "idParam": "PrepaymentID"
    },
    {
     "endpointOp": "GET /PurchaseOrders",
     "pathTemplate": "/PurchaseOrders/{PurchaseOrderID}/History",
     "idParam": "PurchaseOrderID"
    },
    {
     "endpointOp": "GET /Quotes",
     "pathTemplate": "/Quotes/{QuoteID}/History",
     "idParam": "QuoteID"
    },
    {
     "endpointOp": "GET /Receipts",
     "pathTemplate": "/Receipts/{ReceiptID}/History",
     "idParam": "ReceiptID"
    },
    {
     "endpointOp": "GET /RepeatingInvoices",
     "pathTemplate": "/RepeatingInvoices/{RepeatingInvoiceID}/History",
     "idParam": "RepeatingInvoiceID"
    }
   ]
  },
  {
   "id": "xero_online_invoices",
   "api": "accounting",
   "endpointOp": "GET /Invoices/{InvoiceID}/OnlineInvoice",
   "path": "/api.xro/2.0/Invoices/{InvoiceID}/OnlineInvoice",
   "fanOutParam": "InvoiceID",
   "parentTable": "xero_invoices",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_organisation_cis_settings",
   "api": "accounting",
   "endpointOp": "GET /Organisation/{OrganisationID}/CISSettings",
   "path": "/api.xro/2.0/Organisation/{OrganisationID}/CISSettings",
   "fanOutParam": "OrganisationID",
   "parentTable": "xero_organisations",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_au_employee_home_addresses",
   "api": "payroll_au",
   "endpointOp": "GET /Employees/{EmployeeID}",
   "path": "/payroll.xro/1.0/Employees/{EmployeeID}",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_au_employees",
   "availability": "required",
   "members": [
    {
     "table": "xero_payroll_au_employee_bank_accounts",
     "projectFrom": "BankAccounts"
    },
    {
     "table": "xero_payroll_au_employee_leave_balances",
     "projectFrom": "LeaveBalances"
    },
    {
     "table": "xero_payroll_au_employee_tax_declarations",
     "projectFrom": "TaxDeclaration"
    },
    {
     "table": "xero_payroll_au_opening_balances",
     "projectFrom": "OpeningBalances"
    },
    {
     "table": "xero_payroll_au_employee_super_memberships",
     "projectFrom": "SuperMemberships"
    },
    {
     "table": "xero_payroll_au_pay_template_leave_lines",
     "projectFrom": "PayTemplate.LeaveLines"
    },
    {
     "table": "xero_payroll_au_pay_template_super_lines",
     "projectFrom": "PayTemplate.SuperLines"
    },
    {
     "table": "xero_payroll_au_pay_template_earnings_lines",
     "projectFrom": "PayTemplate.EarningsLines"
    },
    {
     "table": "xero_payroll_au_opening_balance_leave_lines",
     "projectFrom": "OpeningBalances.LeaveLines"
    },
    {
     "table": "xero_payroll_au_opening_balance_super_lines",
     "projectFrom": "OpeningBalances.SuperLines"
    },
    {
     "table": "xero_payroll_au_pay_template_deduction_lines",
     "projectFrom": "PayTemplate.DeductionLines"
    },
    {
     "table": "xero_payroll_au_opening_balance_earnings_lines",
     "projectFrom": "OpeningBalances.EarningsLines"
    },
    {
     "table": "xero_payroll_au_opening_balance_deduction_lines",
     "projectFrom": "OpeningBalances.DeductionLines"
    },
    {
     "table": "xero_payroll_au_pay_template_reimbursement_lines",
     "projectFrom": "PayTemplate.ReimbursementLines"
    },
    {
     "table": "xero_payroll_au_opening_balance_reimbursement_lines",
     "projectFrom": "OpeningBalances.ReimbursementLines"
    },
    {
     "table": "xero_payroll_au_opening_balance_paid_leave_lines",
     "projectFrom": "OpeningBalances.PaidLeaveEarningsLines"
    }
   ],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_au_payslips",
   "api": "payroll_au",
   "endpointOp": "GET /Payslip/{PayslipID}",
   "path": "/payroll.xro/1.0/Payslip/{PayslipID}",
   "fanOutParam": "PayslipID",
   "parentTable": "xero_payroll_au_pay_runs",
   "availability": "required",
   "members": [
    {
     "table": "xero_payroll_au_payslip_deduction_lines",
     "projectFrom": "DeductionLines"
    },
    {
     "table": "xero_payroll_au_payslip_earnings_lines",
     "projectFrom": "EarningsLines"
    },
    {
     "table": "xero_payroll_au_payslip_leave_accrual_lines",
     "projectFrom": "LeaveAccrualLines"
    },
    {
     "table": "xero_payroll_au_payslip_leave_earnings_lines",
     "projectFrom": "LeaveEarningsLines"
    },
    {
     "table": "xero_payroll_au_payslip_reimbursement_lines",
     "projectFrom": "ReimbursementLines"
    },
    {
     "table": "xero_payroll_au_payslip_superannuation_lines",
     "projectFrom": "SuperannuationLines"
    },
    {
     "table": "xero_payroll_au_payslip_tax_lines",
     "projectFrom": "TaxLines"
    },
    {
     "table": "xero_payroll_au_payslip_timesheet_earnings_lines",
     "projectFrom": "TimesheetEarningsLines"
    }
   ],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_au_super_fund_products",
   "api": "payroll_au",
   "endpointOp": "GET /SuperfundProducts",
   "path": "/payroll.xro/1.0/SuperfundProducts",
   "fanOutParam": "USI",
   "parentTable": "xero_payroll_au_super_funds",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_nz_employee_payment_methods",
   "api": "payroll_nz",
   "endpointOp": "GET /Employees/{EmployeeID}/PaymentMethods",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/PaymentMethods",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_nz_employees",
   "availability": "optional",
   "members": [
    {
     "table": "xero_payroll_nz_employee_bank_accounts",
     "projectFrom": "bankAccounts"
    }
   ],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_nz_employee_leave",
   "api": "payroll_nz",
   "endpointOp": "GET /Employees/{EmployeeID}/Leave",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/Leave",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_nz_employees",
   "availability": "optional",
   "members": [
    {
     "table": "xero_payroll_nz_employee_leave_periods",
     "projectFrom": "periods"
    }
   ],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_nz_employee_leave_balances",
   "api": "payroll_nz",
   "endpointOp": "GET /Employees/{EmployeeID}/LeaveBalances",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/LeaveBalances",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_nz_employees",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_nz_employee_leave_types",
   "api": "payroll_nz",
   "endpointOp": "GET /Employees/{EmployeeID}/LeaveTypes",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/LeaveTypes",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_nz_employees",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_nz_employee_opening_balances",
   "api": "payroll_nz",
   "endpointOp": "GET /Employees/{EmployeeID}/OpeningBalances",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/OpeningBalances",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_nz_employees",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_nz_employee_pay_template_earnings",
   "api": "payroll_nz",
   "endpointOp": "GET /Employees/{EmployeeID}/PayTemplates",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/PayTemplates",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_nz_employees",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_nz_employee_tax",
   "api": "payroll_nz",
   "endpointOp": "GET /Employees/{EmployeeID}/Tax",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/Tax",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_nz_employees",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_nz_employee_working_patterns",
   "api": "payroll_nz",
   "endpointOp": "GET /Employees/{EmployeeID}/Working-Patterns",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/Working-Patterns",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_nz_employees",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_nz_employee_working_weeks",
   "api": "payroll_nz",
   "endpointOp": "GET /Employees/{EmployeeID}/Working-Patterns/{EmployeeWorkingPatternID}",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/Working-Patterns/{EmployeeWorkingPatternID}",
   "fanOutParam": "EmployeeWorkingPatternID",
   "parentTable": "xero_payroll_nz_employee_working_patterns",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_nz_salary_and_wages",
   "api": "payroll_nz",
   "endpointOp": "GET /Employees/{EmployeeID}/SalaryAndWages",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/SalaryAndWages",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_nz_employees",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_employee_payment_methods",
   "api": "payroll_uk",
   "endpointOp": "GET /Employees/{EmployeeID}/PaymentMethods",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/PaymentMethods",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_uk_employees",
   "availability": "required",
   "members": [
    {
     "table": "xero_payroll_uk_employee_bank_accounts",
     "projectFrom": "bankAccounts"
    }
   ],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_employee_leave",
   "api": "payroll_uk",
   "endpointOp": "GET /Employees/{EmployeeID}/Leave",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/Leave",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_uk_employees",
   "availability": "required",
   "members": [
    {
     "table": "xero_payroll_uk_employee_leave_periods",
     "projectFrom": "periods"
    }
   ],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_employee_leave_balances",
   "api": "payroll_uk",
   "endpointOp": "GET /Employees/{EmployeeID}/LeaveBalances",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/LeaveBalances",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_uk_employees",
   "availability": "required",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_employee_leave_types",
   "api": "payroll_uk",
   "endpointOp": "GET /Employees/{EmployeeID}/LeaveTypes",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/LeaveTypes",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_uk_employees",
   "availability": "required",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_employee_opening_balances",
   "api": "payroll_uk",
   "endpointOp": "GET /Employees/{EmployeeID}/ukopeningbalances",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/ukopeningbalances",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_uk_employees",
   "availability": "required",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_employee_pay_template_earnings",
   "api": "payroll_uk",
   "endpointOp": "GET /Employees/{EmployeeID}/PayTemplates",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/PayTemplates",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_uk_employees",
   "availability": "required",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_employee_salary_and_wages",
   "api": "payroll_uk",
   "endpointOp": "GET /Employees/{EmployeeID}/SalaryAndWages",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/SalaryAndWages",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_uk_employees",
   "availability": "required",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_employee_statutory_leave_balances",
   "api": "payroll_uk",
   "endpointOp": "GET /Employees/{EmployeeID}/StatutoryLeaveBalance",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/StatutoryLeaveBalance",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_uk_employees",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_employee_tax",
   "api": "payroll_uk",
   "endpointOp": "GET /Employees/{EmployeeID}/Tax",
   "path": "/payroll.xro/2.0/Employees/{EmployeeID}/Tax",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_uk_employees",
   "availability": "required",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_payslips",
   "api": "payroll_uk",
   "endpointOp": "GET /Payslips",
   "path": "/payroll.xro/2.0/Payslips",
   "fanOutParam": "PayRunID",
   "parentTable": "xero_payroll_uk_pay_runs",
   "availability": "required",
   "members": [
    {
     "table": "xero_payroll_uk_payslip_benefit_lines",
     "projectFrom": "benefitLines"
    },
    {
     "table": "xero_payroll_uk_payslip_court_order_lines",
     "projectFrom": "courtOrderLines"
    },
    {
     "table": "xero_payroll_uk_payslip_deduction_lines",
     "projectFrom": "deductionLines"
    },
    {
     "table": "xero_payroll_uk_payslip_earnings_lines",
     "projectFrom": "earningsLines"
    },
    {
     "table": "xero_payroll_uk_payslip_employee_tax_lines",
     "projectFrom": "employeeTaxLines"
    },
    {
     "table": "xero_payroll_uk_payslip_employer_tax_lines",
     "projectFrom": "employerTaxLines"
    },
    {
     "table": "xero_payroll_uk_payslip_leave_accrual_lines",
     "projectFrom": "leaveAccrualLines"
    },
    {
     "table": "xero_payroll_uk_payslip_leave_earnings_lines",
     "projectFrom": "leaveEarningsLines"
    },
    {
     "table": "xero_payroll_uk_payslip_payment_lines",
     "projectFrom": "paymentLines"
    },
    {
     "table": "xero_payroll_uk_payslip_reimbursement_lines",
     "projectFrom": "reimbursementLines"
    },
    {
     "table": "xero_payroll_uk_payslip_timesheet_earnings_lines",
     "projectFrom": "timesheetEarningsLines"
    }
   ],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_statutory_leave_summaries",
   "api": "payroll_uk",
   "endpointOp": "GET /StatutoryLeaves/Summary/{EmployeeID}",
   "path": "/payroll.xro/2.0/StatutoryLeaves/Summary/{EmployeeID}",
   "fanOutParam": "EmployeeID",
   "parentTable": "xero_payroll_uk_employees",
   "availability": "required",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_payroll_uk_statutory_sick_leaves",
   "api": "payroll_uk",
   "endpointOp": "GET /StatutoryLeaves/Sick/{StatutorySickLeaveID}",
   "path": "/payroll.xro/2.0/StatutoryLeaves/Sick/{StatutorySickLeaveID}",
   "fanOutParam": "StatutorySickLeaveID",
   "parentTable": "xero_payroll_uk_statutory_leave_summaries",
   "availability": "optional",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_project_tasks",
   "api": "projects",
   "endpointOp": "GET /Projects/{projectId}/Tasks",
   "path": "/projects.xro/2.0/Projects/{projectId}/Tasks",
   "fanOutParam": "projectId",
   "parentTable": "xero_projects",
   "availability": "required",
   "members": [],
   "templatedParents": null
  },
  {
   "id": "xero_project_time_entries",
   "api": "projects",
   "endpointOp": "GET /Projects/{projectId}/Time",
   "path": "/projects.xro/2.0/Projects/{projectId}/Time",
   "fanOutParam": "projectId",
   "parentTable": "xero_projects",
   "availability": "required",
   "members": [],
   "templatedParents": null
  }
 ],
 "attachmentParents": [
  {
   "endpointOp": "GET /Accounts",
   "pathTemplate": "/Accounts/{AccountID}/Attachments",
   "idParam": "AccountID"
  },
  {
   "endpointOp": "GET /BankTransactions",
   "pathTemplate": "/BankTransactions/{BankTransactionID}/Attachments",
   "idParam": "BankTransactionID"
  },
  {
   "endpointOp": "GET /BankTransfers",
   "pathTemplate": "/BankTransfers/{BankTransferID}/Attachments",
   "idParam": "BankTransferID"
  },
  {
   "endpointOp": "GET /Contacts",
   "pathTemplate": "/Contacts/{ContactID}/Attachments",
   "idParam": "ContactID"
  },
  {
   "endpointOp": "GET /CreditNotes",
   "pathTemplate": "/CreditNotes/{CreditNoteID}/Attachments",
   "idParam": "CreditNoteID"
  },
  {
   "endpointOp": "GET /Invoices",
   "pathTemplate": "/Invoices/{InvoiceID}/Attachments",
   "idParam": "InvoiceID"
  },
  {
   "endpointOp": "GET /ManualJournals",
   "pathTemplate": "/ManualJournals/{ManualJournalID}/Attachments",
   "idParam": "ManualJournalID"
  },
  {
   "endpointOp": "GET /PurchaseOrders",
   "pathTemplate": "/PurchaseOrders/{PurchaseOrderID}/Attachments",
   "idParam": "PurchaseOrderID"
  },
  {
   "endpointOp": "GET /Quotes",
   "pathTemplate": "/Quotes/{QuoteID}/Attachments",
   "idParam": "QuoteID"
  },
  {
   "endpointOp": "GET /Receipts",
   "pathTemplate": "/Receipts/{ReceiptID}/Attachments",
   "idParam": "ReceiptID"
  },
  {
   "endpointOp": "GET /RepeatingInvoices",
   "pathTemplate": "/RepeatingInvoices/{RepeatingInvoiceID}/Attachments",
   "idParam": "RepeatingInvoiceID"
  }
 ],
 "historyParents": [
  {
   "endpointOp": "GET /BankTransactions",
   "pathTemplate": "/BankTransactions/{BankTransactionID}/History",
   "idParam": "BankTransactionID"
  },
  {
   "endpointOp": "GET /BankTransfers",
   "pathTemplate": "/BankTransfers/{BankTransferID}/History",
   "idParam": "BankTransferID"
  },
  {
   "endpointOp": "GET /BatchPayments",
   "pathTemplate": "/BatchPayments/{BatchPaymentID}/History",
   "idParam": "BatchPaymentID"
  },
  {
   "endpointOp": "GET /Contacts",
   "pathTemplate": "/Contacts/{ContactID}/History",
   "idParam": "ContactID"
  },
  {
   "endpointOp": "GET /CreditNotes",
   "pathTemplate": "/CreditNotes/{CreditNoteID}/History",
   "idParam": "CreditNoteID"
  },
  {
   "endpointOp": "GET /ExpenseClaims",
   "pathTemplate": "/ExpenseClaims/{ExpenseClaimID}/History",
   "idParam": "ExpenseClaimID"
  },
  {
   "endpointOp": "GET /Invoices",
   "pathTemplate": "/Invoices/{InvoiceID}/History",
   "idParam": "InvoiceID"
  },
  {
   "endpointOp": "GET /Items",
   "pathTemplate": "/Items/{ItemID}/History",
   "idParam": "ItemID"
  },
  {
   "endpointOp": "GET /ManualJournals",
   "pathTemplate": "/ManualJournals/{ManualJournalID}/History",
   "idParam": "ManualJournalID"
  },
  {
   "endpointOp": "GET /Overpayments",
   "pathTemplate": "/Overpayments/{OverpaymentID}/History",
   "idParam": "OverpaymentID"
  },
  {
   "endpointOp": "GET /Payments",
   "pathTemplate": "/Payments/{PaymentID}/History",
   "idParam": "PaymentID"
  },
  {
   "endpointOp": "GET /Prepayments",
   "pathTemplate": "/Prepayments/{PrepaymentID}/History",
   "idParam": "PrepaymentID"
  },
  {
   "endpointOp": "GET /PurchaseOrders",
   "pathTemplate": "/PurchaseOrders/{PurchaseOrderID}/History",
   "idParam": "PurchaseOrderID"
  },
  {
   "endpointOp": "GET /Quotes",
   "pathTemplate": "/Quotes/{QuoteID}/History",
   "idParam": "QuoteID"
  },
  {
   "endpointOp": "GET /Receipts",
   "pathTemplate": "/Receipts/{ReceiptID}/History",
   "idParam": "ReceiptID"
  },
  {
   "endpointOp": "GET /RepeatingInvoices",
   "pathTemplate": "/RepeatingInvoices/{RepeatingInvoiceID}/History",
   "idParam": "RepeatingInvoiceID"
  }
 ]
}''')
