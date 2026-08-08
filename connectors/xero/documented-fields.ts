/**
 * Top-level response fields from Xero's official Accounting OpenAPI at the
 * immutable revision below, keyed by the spec-driven successor streams of the
 * founding pack. Nested objects remain dispositioned on the root stream (for
 * example LineItems and JournalLines) and are additionally normalized into
 * child tables by the table spec.
 *
 * Source: https://github.com/XeroAPI/Xero-OpenAPI/blob/45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f/xero_accounting.yaml
 */
export const XERO_ACCOUNTING_OPENAPI_REVISION = "45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f";

export const XERO_DOCUMENTED_FIELDS = Object.freeze({
  xero_organisations: Object.freeze([
    "OrganisationID", "APIKey", "Name", "LegalName", "PaysTax", "Version",
    "OrganisationType", "BaseCurrency", "CountryCode", "IsDemoCompany",
    "OrganisationStatus", "RegistrationNumber", "EmployerIdentificationNumber",
    "TaxNumber", "FinancialYearEndDay", "FinancialYearEndMonth", "SalesTaxBasis",
    "SalesTaxPeriod", "DefaultSalesTax", "DefaultPurchasesTax", "PeriodLockDate",
    "EndOfYearLockDate", "CreatedDateUTC", "Timezone", "OrganisationEntityType",
    "ShortCode", "Class", "Edition", "LineOfBusiness", "Addresses", "Phones",
    "ExternalLinks", "PaymentTerms",
  ]),
  xero_accounts: Object.freeze([
    "Code", "Name", "AccountID", "Type", "BankAccountNumber", "Status",
    "Description", "BankAccountType", "CurrencyCode", "TaxType",
    "EnablePaymentsToAccount", "ShowInExpenseClaims", "Class", "SystemAccount",
    "ReportingCode", "ReportingCodeName", "HasAttachments", "UpdatedDateUTC",
    "AddToWatchlist", "ValidationErrors",
  ]),
  xero_contacts: Object.freeze([
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
  xero_invoices: Object.freeze([
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
  xero_credit_notes: Object.freeze([
    "Type", "Contact", "Date", "DueDate", "Status", "LineAmountTypes",
    "LineItems", "SubTotal", "TotalTax", "Total", "CISDeduction", "CISRate",
    "UpdatedDateUTC", "UpdatedDateUTCString", "CurrencyCode", "FullyPaidOnDate",
    "CreditNoteID", "CreditNoteNumber", "Reference", "SentToContact", "CurrencyRate",
    "RemainingCredit", "Allocations", "AppliedAmount", "Payments", "BrandingThemeID",
    "StatusAttributeString", "HasAttachments", "HasErrors", "ValidationErrors",
    "Warnings", "InvoiceAddresses",
  ]),
  xero_payments: Object.freeze([
    "Invoice", "CreditNote", "Prepayment", "Overpayment", "InvoiceNumber",
    "CreditNoteNumber", "BatchPayment", "Account", "Code", "Date", "CurrencyRate",
    "Amount", "BankAmount", "Reference", "IsReconciled", "Status", "PaymentType",
    "UpdatedDateUTC", "UpdatedDateUTCString", "PaymentID", "BatchPaymentID",
    "BankAccountNumber", "Particulars", "Details", "HasAccount",
    "HasValidationErrors", "StatusAttributeString", "ValidationErrors", "Warnings",
  ]),
  xero_bank_transactions: Object.freeze([
    "Type", "Contact", "LineItems", "BankAccount", "IsReconciled", "Date",
    "Reference", "CurrencyCode", "CurrencyRate", "Url", "Status", "LineAmountTypes",
    "SubTotal", "TotalTax", "Total", "BankTransactionID", "PrepaymentID",
    "OverpaymentID", "UpdatedDateUTC", "HasAttachments", "StatusAttributeString",
    "ValidationErrors",
  ]),
  xero_manual_journals: Object.freeze([
    "Narration", "JournalLines", "Date", "LineAmountTypes", "Status", "Url",
    "ShowOnCashBasisReports", "HasAttachments", "UpdatedDateUTC", "ManualJournalID",
    "StatusAttributeString", "Warnings", "ValidationErrors", "Attachments",
  ]),
  xero_journals: Object.freeze([
    "JournalID", "JournalDate", "JournalNumber", "CreatedDateUTC", "Reference",
    "SourceID", "SourceType", "JournalLines",
  ]),
  xero_tax_rates: Object.freeze([
    "Name", "TaxType", "TaxComponents", "Status", "ReportTaxType",
    "CanApplyToAssets", "CanApplyToEquity", "CanApplyToExpenses",
    "CanApplyToLiabilities", "CanApplyToRevenue", "DisplayTaxRate", "EffectiveRate",
  ]),
  xero_tracking_categories: Object.freeze([
    "TrackingCategoryID", "TrackingOptionID", "Name", "Option", "Status", "Options",
  ]),
} as const);

export type XeroDocumentedStream = keyof typeof XERO_DOCUMENTED_FIELDS;
