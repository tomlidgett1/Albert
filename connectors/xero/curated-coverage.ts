/**
 * Reviewed canonical targets and PII classifications carried forward from the
 * founding Xero pack.
 *
 * The spec generates a table's coverage mechanically, but two things cannot be
 * inferred from a payload's shape:
 *
 *   - WHICH canonical slot a field feeds. `Payment.BankAmount` is not merely
 *     event_link; it is the settlement evidence's bank amount, and the
 *     transform asserts that exact target. Coarsening it to the table's first
 *     canonical target would silently widen what each field claims to be.
 *   - WHOSE personal data a field exposes. A prepayment stub embeds a CUSTOMER
 *     contact; a batch-payment stub embeds a SUPPLIER's banking details. Both
 *     are jsonb blobs of identical shape, so only a reviewed decision can tell
 *     them apart — and that decision governs who may read the column.
 *
 * These entries were reviewed against the vendor documentation for the eleven
 * founding streams and are applied verbatim; every other stream falls through
 * to the generic spec-driven rules in field-coverage.ts.
 */
import type { PiiClass } from "../../packages/connector-sdk/src/contract.js";

/** stream -> vendor field -> exact canonical target the transform asserts. */
export const XERO_CURATED_TARGETS: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    "xero_organisations": {
      "OrganisationID": "legal_entity.source_id",
      "Name": "legal_entity.name",
      "LegalName": "legal_entity.legal_name",
      "BaseCurrency": "legal_entity.currency",
      "SalesTaxBasis": "dossier.tax_basis",
      "FinancialYearEndDay": "dossier.financial_year_end_day",
      "FinancialYearEndMonth": "dossier.financial_year_end_month",
      "TaxNumber": "legal_entity.tax_number",
      "UpdatedDateUTC": "legal_entity.source_updated_at"
    },
    "xero_accounts": {
      "AccountID": "gl_account.source_id",
      "Code": "gl_account.code",
      "Name": "gl_account.name",
      "Type": "gl_account.type",
      "TaxType": "tax_code.source_id",
      "Status": "gl_account.status",
      "UpdatedDateUTC": "gl_account.source_updated_at"
    },
    "xero_contacts": {
      "ContactID": "customer_account.source_id",
      "Name": "customer_account.name",
      "FirstName": "person.first_name",
      "LastName": "person.last_name",
      "EmailAddress": "entity_source_link.email",
      "ContactStatus": "customer_account.status",
      "IsSupplier": "supplier.is_supplier",
      "IsCustomer": "customer_account.is_customer",
      "UpdatedDateUTC": "customer_account.source_updated_at"
    },
    "xero_invoices": {
      "InvoiceID": "finance_invoice_line.invoice_source_id",
      "InvoiceNumber": "finance_invoice_line.invoice_number",
      "Type": "finance_invoice_line.invoice_type",
      "Contact": "customer_account.source_observation",
      "Date": "finance_invoice_line.posted_at",
      "DueDate": "finance_invoice_line.due_at",
      "Status": "finance_invoice_line.status",
      "LineAmountTypes": "finance_invoice_line.tax_basis",
      "SubTotal": "finance_invoice_line.net_amount_ex_tax",
      "TotalTax": "finance_invoice_line.tax_amount",
      "Total": "finance_invoice_line.net_amount_inc_tax",
      "AmountDue": "finance_invoice_line.amount_due",
      "AmountPaid": "finance_invoice_line.amount_paid",
      "CurrencyCode": "finance_invoice_line.currency",
      "UpdatedDateUTC": "finance_invoice_line.source_updated_at",
      "LineItems": "finance_invoice_line.observations"
    },
    "xero_credit_notes": {
      "CreditNoteID": "finance_invoice_line.invoice_source_id",
      "CreditNoteNumber": "finance_invoice_line.invoice_number",
      "Type": "finance_invoice_line.invoice_type",
      "Contact": "customer_account.source_observation",
      "Date": "finance_invoice_line.posted_at",
      "Status": "finance_invoice_line.status",
      "LineAmountTypes": "finance_invoice_line.tax_basis",
      "SubTotal": "finance_invoice_line.net_amount_ex_tax",
      "TotalTax": "finance_invoice_line.tax_amount",
      "Total": "finance_invoice_line.net_amount_inc_tax",
      "RemainingCredit": "finance_invoice_line.amount_due",
      "CurrencyCode": "finance_invoice_line.currency",
      "UpdatedDateUTC": "finance_invoice_line.source_updated_at",
      "LineItems": "finance_invoice_line.observations"
    },
    "xero_payments": {
      "PaymentID": "event_link.from.source_record_id",
      "Date": "event_link.evidence.paid_date",
      "Amount": "event_link.evidence.amount",
      "BankAmount": "event_link.evidence.bank_amount",
      "PaymentType": "event_link.evidence.payment_type",
      "Status": "event_link.evidence.status",
      "Invoice": "event_link.to.source_record_id",
      "CreditNote": "event_link.to.source_record_id",
      "Prepayment": "event_link.to.source_record_id",
      "Overpayment": "event_link.to.source_record_id",
      "Account": "event_link.evidence.bank_account_id",
      "BatchPaymentID": "event_link.to.source_record_id",
      "BatchPayment": "event_link.to.source_record_id",
      "Reference": "event_link.evidence.reference",
      "IsReconciled": "event_link.evidence.reconciled"
    },
    "xero_bank_transactions": {
      "BankTransactionID": "finance_bank_transaction.source_id",
      "Type": "finance_bank_transaction.type",
      "Contact": "customer_account.source_observation",
      "Date": "finance_bank_transaction.posted_at",
      "Status": "finance_bank_transaction.status",
      "LineAmountTypes": "finance_bank_transaction.tax_basis",
      "SubTotal": "finance_bank_transaction.net_amount_ex_tax",
      "TotalTax": "finance_bank_transaction.tax_amount",
      "Total": "finance_bank_transaction.net_amount_inc_tax",
      "CurrencyCode": "finance_bank_transaction.currency",
      "UpdatedDateUTC": "finance_bank_transaction.source_updated_at",
      "LineItems": "finance_bank_transaction.line_observations"
    },
    "xero_manual_journals": {
      "ManualJournalID": "finance_journal_line.journal_source_id",
      "Date": "finance_journal_line.posted_at",
      "Status": "finance_journal_line.status",
      "LineAmountTypes": "finance_journal_line.tax_basis",
      "Narration": "finance_journal_line.narration",
      "JournalLines": "finance_journal_line.observations",
      "UpdatedDateUTC": "finance_journal_line.source_updated_at"
    },
    "xero_journals": {
      "JournalID": "finance_journal_line.journal_source_id",
      "JournalNumber": "finance_journal_line.journal_number",
      "JournalDate": "finance_journal_line.posted_at",
      "CreatedDateUTC": "finance_journal_line.source_updated_at",
      "SourceID": "finance_journal_line.source_document_id",
      "SourceType": "finance_journal_line.source_document_type",
      "JournalLines": "finance_journal_line.observations"
    },
    "xero_tax_rates": {
      "TaxType": "tax_code.source_id",
      "Name": "tax_code.name",
      "Status": "tax_code.status",
      "DisplayTaxRate": "tax_code.display_rate",
      "EffectiveRate": "tax_code.effective_rate",
      "TaxComponents": "tax_code.components"
    },
    "xero_tracking_categories": {
      "TrackingCategoryID": "location.source_id",
      "Name": "location.name",
      "Status": "location.status",
      "Options": "location.source_options",
      "UpdatedDateUTC": "location.source_updated_at"
    }
  });

/** stream -> vendor field -> reviewed PII classification. */
export const XERO_CURATED_PII: Readonly<Record<string, Readonly<Record<string, PiiClass>>>> =
  Object.freeze({
    "xero_accounts": {
      "BankAccountNumber": "business_contact"
    },
    "xero_contacts": {
      "Name": "customer_contact",
      "FirstName": "customer_contact",
      "LastName": "customer_contact",
      "EmailAddress": "customer_contact",
      "Addresses": "customer_contact",
      "Phones": "customer_contact",
      "BankAccountDetails": "customer_contact"
    },
    "xero_invoices": {
      "Reference": "free_text_untrusted"
    },
    "xero_credit_notes": {
      "Reference": "free_text_untrusted"
    },
    "xero_payments": {
      "Reference": "free_text_untrusted",
      "Invoice": "customer_contact",
      "CreditNote": "customer_contact",
      "Prepayment": "customer_contact",
      "Overpayment": "customer_contact",
      "BatchPayment": "business_contact",
      "Account": "business_contact"
    },
    "xero_bank_transactions": {
      "Reference": "free_text_untrusted"
    },
    "xero_manual_journals": {
      "Narration": "free_text_untrusted"
    }
  } as Record<string, Record<string, PiiClass>>);
