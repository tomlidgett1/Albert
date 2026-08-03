import {
  inferStagingType,
  stagingColumnName,
  type ConnectorManifest,
  type FieldCoverage,
} from "../../packages/connector-sdk/src/index.js";
import {
  XERO_ACCOUNTING_OPENAPI_REVISION,
  XERO_DOCUMENTED_FIELDS,
  type XeroDocumentedStream,
} from "./documented-fields.js";

export const XERO_DEFAULT_SCOPES = [
  "offline_access",
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.banktransactions.read",
  "accounting.manualjournals.read",
] as const;

export const XERO_ADVANCED_SCOPES = ["accounting.journals.read"] as const;
export const XERO_ALLOWED_SCOPES = [...XERO_DEFAULT_SCOPES, ...XERO_ADVANCED_SCOPES] as const;

export function xeroRequestedScopes(includeAdvancedJournals: boolean): readonly string[] {
  return includeAdvancedJournals ? XERO_ALLOWED_SCOPES : XERO_DEFAULT_SCOPES;
}

const coverage = (
  stream: XeroDocumentedStream,
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
    stagingType: inferStagingType("xero", field, target),
    target,
    pii: pii[field] ?? ("none" as const),
    })),
    ...extensions.map((field) => ({
    stream,
    field,
    disposition: "governed_extension" as const,
    stagingType: inferStagingType("xero", field),
    target: `source_xero.${stream}.${stagingColumnName(field)}`,
    pii: pii[field] ?? ("none" as const),
    })),
    ...XERO_DOCUMENTED_FIELDS[stream]
      .filter((field) => !explicitlyDispositioned.has(field))
      .map((field) => ({
        stream,
        field,
        disposition: "unsupported" as const,
        stagingType: inferStagingType("xero", field),
        reason: "Documented by the pinned Xero Accounting OpenAPI but outside Albert V1 canonical and governed source-extension scope; retained only in immutable encrypted raw storage.",
        pii: pii[field] ?? unsupportedPii(stream, field),
      })),
  ];
};

function unsupportedPii(
  stream: XeroDocumentedStream,
  field: string,
): FieldCoverage["pii"] {
  if (/ValidationErrors|Warnings|Attachments|Reference|Particulars|Details|Url/u.test(field)) {
    return "free_text_untrusted";
  }
  if (/Contact|Address|Phone|Email|BankAccount|TaxNumber|Website|CompanyNumber|AccountNumber/u.test(field)) {
    return stream === "contacts" || stream === "invoices" || stream === "credit_notes"
      ? "customer_contact"
      : "business_contact";
  }
  return "none";
}

export const xeroManifest: ConnectorManifest = {
  id: "xero",
  displayName: "Xero Accounting",
  packVersion: "1.0.0",
  apiVersion: `Accounting API 2.0; OpenAPI ${XERO_ACCOUNTING_OPENAPI_REVISION}; granular OAuth scopes (March 2026)`,
  releasedAt: "2026-08-03",
  documentation: [
    "https://developer.xero.com/documentation/guides/oauth2/pkce-flow",
    "https://developer.xero.com/documentation/guides/oauth2/scopes/",
    "https://developer.xero.com/documentation/guides/oauth2/token-types",
    "https://developer.xero.com/documentation/guides/oauth2/limits/",
    "https://developer.xero.com/documentation/best-practices/api-call-efficiencies/paging",
    "https://developer.xero.com/documentation/guides/webhooks/overview/",
    "https://developer.xero.com/changelog",
    "https://xeroapi.github.io/xero-node/accounting/index.html",
    `https://github.com/XeroAPI/Xero-OpenAPI/blob/${XERO_ACCOUNTING_OPENAPI_REVISION}/xero_accounting.yaml`,
  ],
  oauth: {
    scopes: XERO_DEFAULT_SCOPES,
    leastPrivilegeNotes: [],
    refreshTokenRotation: true,
    remoteRevocation: "supported",
  },
  streams: [
    { id: "organisation", resource: "Organisations", endpoint: "Organisation", recordIdField: "OrganisationID", modifiedField: "UpdatedDateUTC", pagination: "none", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: [], productDomains: ["accounting"], canonicalTargets: ["legal_entity"] },
    { id: "accounts", resource: "Accounts", endpoint: "Accounts", recordIdField: "AccountID", modifiedField: "UpdatedDateUTC", pagination: "none", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["organisation"], productDomains: ["accounting"], canonicalTargets: ["gl_account"] },
    { id: "contacts", resource: "Contacts", endpoint: "Contacts", recordIdField: "ContactID", modifiedField: "UpdatedDateUTC", pagination: "page", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["organisation"], productDomains: ["accounting"], canonicalTargets: ["supplier", "customer_account"] },
    { id: "invoices", resource: "Invoices", endpoint: "Invoices", recordIdField: "InvoiceID", modifiedField: "UpdatedDateUTC", pagination: "page", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["organisation", "accounts", "contacts", "tax_rates", "tracking_categories"], productDomains: ["accounting"], canonicalTargets: ["finance_invoice_line"] },
    { id: "credit_notes", resource: "CreditNotes", endpoint: "CreditNotes", recordIdField: "CreditNoteID", modifiedField: "UpdatedDateUTC", pagination: "page", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["organisation", "accounts", "contacts", "tax_rates", "tracking_categories"], productDomains: ["accounting"], canonicalTargets: ["finance_invoice_line"] },
    { id: "payments", resource: "Payments", endpoint: "Payments", recordIdField: "PaymentID", modifiedField: "UpdatedDateUTC", pagination: "page", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["organisation", "accounts", "contacts"], productDomains: ["accounting"], canonicalTargets: ["event_link"] },
    { id: "bank_transactions", resource: "BankTransactions", endpoint: "BankTransactions", recordIdField: "BankTransactionID", modifiedField: "UpdatedDateUTC", pagination: "page", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["organisation", "accounts", "tax_rates", "tracking_categories"], productDomains: ["accounting"], canonicalTargets: ["finance_bank_transaction"] },
    { id: "manual_journals", resource: "ManualJournals", endpoint: "ManualJournals", recordIdField: "ManualJournalID", modifiedField: "UpdatedDateUTC", pagination: "page", backfillStrategy: "time_windowed", lateEditStrategy: "modified_field", deletionStrategy: "soft_delete", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["organisation", "accounts", "tax_rates", "tracking_categories"], productDomains: ["accounting"], canonicalTargets: ["finance_journal_line"] },
    { id: "journals", resource: "Journals", endpoint: "Journals", recordIdField: "JournalID", modifiedField: "CreatedDateUTC", pagination: "offset", backfillStrategy: "exhaustive_offset", lateEditStrategy: "append_only", deletionStrategy: "immutable_append_only", sourceTotalStrategy: "count_distinct_complete_scan", availability: "optional", dependencies: ["organisation", "accounts", "tax_rates", "tracking_categories"], productDomains: ["accounting"], canonicalTargets: ["finance_journal_line"] },
    { id: "tax_rates", resource: "TaxRates", endpoint: "TaxRates", recordIdField: "TaxType", pagination: "none", backfillStrategy: "snapshot", lateEditStrategy: "full_snapshot", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: [], productDomains: ["accounting"], canonicalTargets: ["tax_code"] },
    { id: "tracking_categories", resource: "TrackingCategories", endpoint: "TrackingCategories", recordIdField: "TrackingCategoryID", modifiedField: "UpdatedDateUTC", pagination: "none", backfillStrategy: "snapshot", lateEditStrategy: "modified_field", deletionStrategy: "authoritative_identity_scan", sourceTotalStrategy: "count_distinct_complete_scan", dependencies: ["organisation"], productDomains: ["accounting"], canonicalTargets: ["location"] },
  ],
  rateLimit: {
    algorithm: "per-organisation concurrent, minute, daily and app-minute budgets",
    concurrency: 5,
    budgets: {
      callsPerMinutePerOrganisation: 60,
      starterCallsPerDayPerOrganisation: 1000,
      higherTierCallsPerDayPerOrganisation: 5000,
      pageSize: 1000,
    },
    responseHeaders: [
      "X-MinLimit-Remaining",
      "X-DayLimit-Remaining",
      "X-AppMinLimit-Remaining",
      "Retry-After",
    ],
  },
  capabilities: {
    "finance.settings": {
      support: "full", streams: ["organisation", "accounts", "tax_rates"],
      reason: "Organisation, Accounts and TaxRates provide the accounting configuration used by the dossier and semantic model.",
    },
    "finance.invoices": {
      support: "full", streams: ["invoices", "credit_notes"],
      reason: "Invoices and CreditNotes map to canonical finance invoice lines.",
    },
    "finance.payments": {
      support: "full", streams: ["payments"],
      reason: "Payments provide source-native settlement allocation evidence.",
    },
    "finance.bank_transactions": {
      support: "full", streams: ["bank_transactions"],
      reason: "BankTransactions map to canonical bank transaction facts.",
    },
    "finance.journals": {
      support: "unknown", streams: ["journals"],
      reason: "Posted Journals require the Advanced accounting.journals.read grant and a successful live endpoint probe.",
    },
    "finance.journals.tax": {
      support: "unknown", streams: ["journals"], coverageFields: ["JournalLines"],
      reason: "Journal tax analysis is confirmed with the Advanced Journals stream and its line tax fields.",
    },
    "source.webhooks.contacts": {
      support: "full", streams: [],
      reason: "Xero documents Contacts webhook events.",
    },
    "source.webhooks.invoices": {
      support: "full", streams: [],
      reason: "Xero documents Invoices webhook events.",
    },
    "source.webhooks.credit_notes": {
      support: "full", streams: [],
      reason: "Xero documents Credit Notes webhook events.",
    },
  },
  identityRules: [
    "Contact email is a deterministic cross-source suggestion only; an owner confirms ambiguous customer matches.",
    "Contact TaxNumber/ABN may deterministically link suppliers within the tenant when present and exact.",
    "Tracking categories are source-native dimensions until explicitly mapped by a tenant overlay.",
  ],
  topology: [
    "Journals are authoritative statutory ledger observations, including POS summary journals.",
    "BankTransactions and Payments ground cash settlement and reconciliation independently of POS tenders.",
    "Invoices and CreditNotes map into one source-neutral finance invoice-line domain with reversal semantics.",
  ],
  fieldCoverage: [
    ...coverage("organisation", { OrganisationID: "legal_entity.source_id", Name: "legal_entity.name", LegalName: "legal_entity.legal_name", BaseCurrency: "legal_entity.currency", SalesTaxBasis: "dossier.tax_basis", FinancialYearEndDay: "dossier.financial_year_end_day", FinancialYearEndMonth: "dossier.financial_year_end_month", TaxNumber: "legal_entity.tax_number", UpdatedDateUTC: "legal_entity.source_updated_at" }, ["OrganisationStatus", "Version", "CountryCode", "ShortCode"]),
    ...coverage("accounts", { AccountID: "gl_account.source_id", Code: "gl_account.code", Name: "gl_account.name", Type: "gl_account.type", TaxType: "tax_code.source_id", Status: "gl_account.status", UpdatedDateUTC: "gl_account.source_updated_at" }, ["Class", "SystemAccount", "EnablePaymentsToAccount", "BankAccountNumber", "CurrencyCode"], { BankAccountNumber: "business_contact" }),
    ...coverage("contacts", { ContactID: "customer_account.source_id", Name: "customer_account.name", FirstName: "person.first_name", LastName: "person.last_name", EmailAddress: "entity_source_link.email", ContactStatus: "customer_account.status", IsSupplier: "supplier.is_supplier", IsCustomer: "customer_account.is_customer", UpdatedDateUTC: "customer_account.source_updated_at" }, ["TaxNumber", "ContactNumber", "Addresses", "Phones", "BankAccountDetails", "DefaultCurrency"], { Name: "customer_contact", FirstName: "customer_contact", LastName: "customer_contact", EmailAddress: "customer_contact", Addresses: "customer_contact", Phones: "customer_contact", BankAccountDetails: "customer_contact" }),
    ...coverage("invoices", { InvoiceID: "finance_invoice_line.invoice_source_id", InvoiceNumber: "finance_invoice_line.invoice_number", Type: "finance_invoice_line.invoice_type", Contact: "customer_account.source_observation", Date: "finance_invoice_line.posted_at", DueDate: "finance_invoice_line.due_at", Status: "finance_invoice_line.status", LineAmountTypes: "finance_invoice_line.tax_basis", SubTotal: "finance_invoice_line.net_amount_ex_tax", TotalTax: "finance_invoice_line.tax_amount", Total: "finance_invoice_line.net_amount_inc_tax", AmountDue: "finance_invoice_line.amount_due", AmountPaid: "finance_invoice_line.amount_paid", CurrencyCode: "finance_invoice_line.currency", UpdatedDateUTC: "finance_invoice_line.source_updated_at", LineItems: "finance_invoice_line.observations" }, ["UpdatedDateUTCString", "Reference", "CurrencyRate", "FullyPaidOnDate", "HasAttachments"], { Reference: "free_text_untrusted" }),
    ...coverage("credit_notes", { CreditNoteID: "finance_invoice_line.invoice_source_id", CreditNoteNumber: "finance_invoice_line.invoice_number", Type: "finance_invoice_line.invoice_type", Contact: "customer_account.source_observation", Date: "finance_invoice_line.posted_at", Status: "finance_invoice_line.status", LineAmountTypes: "finance_invoice_line.tax_basis", SubTotal: "finance_invoice_line.net_amount_ex_tax", TotalTax: "finance_invoice_line.tax_amount", Total: "finance_invoice_line.net_amount_inc_tax", RemainingCredit: "finance_invoice_line.amount_due", CurrencyCode: "finance_invoice_line.currency", UpdatedDateUTC: "finance_invoice_line.source_updated_at", LineItems: "finance_invoice_line.observations" }, ["UpdatedDateUTCString", "Reference", "CurrencyRate", "Allocations"], { Reference: "free_text_untrusted" }),
    ...coverage("payments", {
      PaymentID: "event_link.from.source_record_id",
      Date: "event_link.evidence.paid_date",
      Amount: "event_link.evidence.amount",
      BankAmount: "event_link.evidence.bank_amount",
      PaymentType: "event_link.evidence.payment_type",
      Status: "event_link.evidence.status",
      Invoice: "event_link.to.source_record_id",
      CreditNote: "event_link.to.source_record_id",
      Prepayment: "event_link.to.source_record_id",
      Overpayment: "event_link.to.source_record_id",
      Account: "event_link.evidence.bank_account_id",
      BatchPaymentID: "event_link.to.source_record_id",
      BatchPayment: "event_link.to.source_record_id",
      Reference: "event_link.evidence.reference",
      IsReconciled: "event_link.evidence.reconciled",
    }, [
      "UpdatedDateUTC", "UpdatedDateUTCString", "DateString", "CurrencyRate",
      "HasAccount", "HasValidationErrors",
    ], {
      Reference: "free_text_untrusted",
      Invoice: "customer_contact",
      CreditNote: "customer_contact",
      Prepayment: "customer_contact",
      Overpayment: "customer_contact",
      BatchPayment: "business_contact",
      Account: "business_contact",
    }),
    ...coverage("bank_transactions", { BankTransactionID: "finance_bank_transaction.source_id", Type: "finance_bank_transaction.type", Contact: "customer_account.source_observation", Date: "finance_bank_transaction.posted_at", Status: "finance_bank_transaction.status", LineAmountTypes: "finance_bank_transaction.tax_basis", SubTotal: "finance_bank_transaction.net_amount_ex_tax", TotalTax: "finance_bank_transaction.tax_amount", Total: "finance_bank_transaction.net_amount_inc_tax", CurrencyCode: "finance_bank_transaction.currency", UpdatedDateUTC: "finance_bank_transaction.source_updated_at", LineItems: "finance_bank_transaction.line_observations" }, ["UpdatedDateUTCString", "Reference", "CurrencyRate", "BankAccount", "IsReconciled"], { Reference: "free_text_untrusted" }),
    ...coverage("manual_journals", { ManualJournalID: "finance_journal_line.journal_source_id", Date: "finance_journal_line.posted_at", Status: "finance_journal_line.status", LineAmountTypes: "finance_journal_line.tax_basis", Narration: "finance_journal_line.narration", JournalLines: "finance_journal_line.observations", UpdatedDateUTC: "finance_journal_line.source_updated_at" }, ["UpdatedDateUTCString", "ShowOnCashBasisReports", "Url"], { Narration: "free_text_untrusted" }),
    ...coverage("journals", { JournalID: "finance_journal_line.journal_source_id", JournalNumber: "finance_journal_line.journal_number", JournalDate: "finance_journal_line.posted_at", CreatedDateUTC: "finance_journal_line.source_updated_at", SourceID: "finance_journal_line.source_document_id", SourceType: "finance_journal_line.source_document_type", JournalLines: "finance_journal_line.observations" }),
    ...coverage("tax_rates", { TaxType: "tax_code.source_id", Name: "tax_code.name", Status: "tax_code.status", DisplayTaxRate: "tax_code.display_rate", EffectiveRate: "tax_code.effective_rate", TaxComponents: "tax_code.components" }, ["CanApplyToAssets", "CanApplyToEquity", "CanApplyToExpenses", "CanApplyToLiabilities", "CanApplyToRevenue"]),
    ...coverage("tracking_categories", { TrackingCategoryID: "location.source_id", Name: "location.name", Status: "location.status", Options: "location.source_options", UpdatedDateUTC: "location.source_updated_at" }),
  ],
  qualityAssertions: [
    "cursor_completeness",
    "scope_available",
    "retention_limit_recorded",
    "webhook_gap_recovered",
    "delete_handling",
    "schema_drift",
    "enum_drift",
    "journal_balances_source",
    "invoice_totals_source",
  ],
  limitations: [
    "The Journals endpoint and accounting.journals.read scope require an Advanced-tier app, initial and annual security assessment, and use-case approval. Albert omits that scope unless XERO_ENABLE_ADVANCED_JOURNALS=true; ledger-backed answers remain Unavailable until approval and a live endpoint probe both succeed.",
    "Daily request allowance is tier dependent (1,000 Starter; 5,000 higher tiers), so the worker records response budgets and replays immutable raw data instead of re-pulling.",
    "Webhooks accelerate Contacts, Invoices and Credit Notes only; all streams continue to poll and reconcile.",
    "Xero API data must never be used to train AI models. Albert applies its platform-wide no-training policy to all providers.",
  ],
  unknownFieldPolicy: "quarantine_schema_drift",
};
