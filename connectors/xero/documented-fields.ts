/**
 * Top-level response fields from Xero's official Accounting OpenAPI at the
 * immutable revision below. Nested objects remain inside their dispositioned
 * parent JSON field (for example LineItems and JournalLines).
 *
 * Source: https://github.com/XeroAPI/Xero-OpenAPI/blob/45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f/xero_accounting.yaml
 */
export const XERO_ACCOUNTING_OPENAPI_REVISION = "45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f";

export const XERO_DOCUMENTED_FIELDS = Object.freeze({
  organisation: Object.freeze([
    "OrganisationID", "APIKey", "Name", "LegalName", "PaysTax", "Version",
    "OrganisationType", "BaseCurrency", "CountryCode", "IsDemoCompany",
    "OrganisationStatus", "RegistrationNumber", "EmployerIdentificationNumber",
    "TaxNumber", "FinancialYearEndDay", "FinancialYearEndMonth", "SalesTaxBasis",
    "SalesTaxPeriod", "DefaultSalesTax", "DefaultPurchasesTax", "PeriodLockDate",
    "EndOfYearLockDate", "CreatedDateUTC", "Timezone", "OrganisationEntityType",
    "ShortCode", "Class", "Edition", "LineOfBusiness", "Addresses", "Phones",
    "ExternalLinks", "PaymentTerms",
  ]),
  accounts: Object.freeze([
    "Code", "Name", "AccountID", "Type", "BankAccountNumber", "Status",
    "Description", "BankAccountType", "CurrencyCode", "TaxType",
    "EnablePaymentsToAccount", "ShowInExpenseClaims", "Class", "SystemAccount",
    "ReportingCode", "ReportingCodeName", "HasAttachments", "UpdatedDateUTC",
    "AddToWatchlist", "ValidationErrors",
  ]),
  contacts: Object.freeze([
    "ContactID", "MergedToContactID", "ContactNumber", "AccountNumber",
    "ContactStatus", "Name", "FirstName", "LastName", "CompanyNumber",
    "EmailAddress", "ContactPersons", "BankAccountDetails", "TaxNumber",
    "TaxNumberType", "AccountsReceivableTaxType", "AccountsPayableTaxType",
    "Addresses", "Phones", "IsSupplier", "IsCustomer",
    "SalesDefaultLineAmountType", "PurchasesDefaultLineAmountType", "DefaultCurrency",
    "XeroNetworkKey", "SalesDefaultAccountCode", "PurchasesDefaultAccountCode",
    "SalesTrackingCategories", "PurchasesTrackingCategories", "TrackingCategoryName",
    "TrackingCategoryOption", "PaymentTerms", "UpdatedDateUTC", "ContactGroups",
    "Website", "BrandingTheme", "BatchPayments", "Discount", "Balances",
    "Attachments", "HasAttachments", "ValidationErrors", "HasValidationErrors",
    "StatusAttributeString",
  ]),
  invoices: Object.freeze([
    "Type", "Contact", "LineItems", "Date", "DueDate", "LineAmountTypes",
    "InvoiceNumber", "Reference", "BrandingThemeID", "Url", "CurrencyCode",
    "CurrencyRate", "Status", "SentToContact", "ExpectedPaymentDate",
    "PlannedPaymentDate", "CISDeduction", "CISRate", "SubTotal", "TotalTax",
    "Total", "TotalDiscount", "InvoiceID", "RepeatingInvoiceID", "HasAttachments",
    "IsDiscounted", "Payments", "Prepayments", "Overpayments", "AmountDue",
    "AmountPaid", "FullyPaidOnDate", "AmountCredited", "UpdatedDateUTC",
    "UpdatedDateUTCString", "CreditNotes", "Attachments", "HasErrors",
    "StatusAttributeString", "ValidationErrors", "Warnings", "InvoiceAddresses",
  ]),
  credit_notes: Object.freeze([
    "Type", "Contact", "Date", "DueDate", "Status", "LineAmountTypes",
    "LineItems", "SubTotal", "TotalTax", "Total", "CISDeduction", "CISRate",
    "UpdatedDateUTC", "UpdatedDateUTCString", "CurrencyCode", "FullyPaidOnDate",
    "CreditNoteID", "CreditNoteNumber", "Reference", "SentToContact", "CurrencyRate",
    "RemainingCredit", "Allocations", "AppliedAmount", "Payments", "BrandingThemeID",
    "StatusAttributeString", "HasAttachments", "HasErrors", "ValidationErrors",
    "Warnings", "InvoiceAddresses",
  ]),
  payments: Object.freeze([
    "Invoice", "CreditNote", "Prepayment", "Overpayment", "InvoiceNumber",
    "CreditNoteNumber", "BatchPayment", "Account", "Code", "Date", "CurrencyRate",
    "Amount", "BankAmount", "Reference", "IsReconciled", "Status", "PaymentType",
    "UpdatedDateUTC", "UpdatedDateUTCString", "PaymentID", "BatchPaymentID",
    "BankAccountNumber", "Particulars", "Details", "HasAccount",
    "HasValidationErrors", "StatusAttributeString", "ValidationErrors", "Warnings",
  ]),
  bank_transactions: Object.freeze([
    "Type", "Contact", "LineItems", "BankAccount", "IsReconciled", "Date",
    "Reference", "CurrencyCode", "CurrencyRate", "Url", "Status", "LineAmountTypes",
    "SubTotal", "TotalTax", "Total", "BankTransactionID", "PrepaymentID",
    "OverpaymentID", "UpdatedDateUTC", "HasAttachments", "StatusAttributeString",
    "ValidationErrors",
  ]),
  manual_journals: Object.freeze([
    "Narration", "JournalLines", "Date", "LineAmountTypes", "Status", "Url",
    "ShowOnCashBasisReports", "HasAttachments", "UpdatedDateUTC", "ManualJournalID",
    "StatusAttributeString", "Warnings", "ValidationErrors", "Attachments",
  ]),
  journals: Object.freeze([
    "JournalID", "JournalDate", "JournalNumber", "CreatedDateUTC", "Reference",
    "SourceID", "SourceType", "JournalLines",
  ]),
  tax_rates: Object.freeze([
    "Name", "TaxType", "TaxComponents", "Status", "ReportTaxType",
    "CanApplyToAssets", "CanApplyToEquity", "CanApplyToExpenses",
    "CanApplyToLiabilities", "CanApplyToRevenue", "DisplayTaxRate", "EffectiveRate",
  ]),
  tracking_categories: Object.freeze([
    "TrackingCategoryID", "TrackingOptionID", "Name", "Option", "Status", "Options",
  ]),
} as const);

export type XeroDocumentedStream = keyof typeof XERO_DOCUMENTED_FIELDS;
