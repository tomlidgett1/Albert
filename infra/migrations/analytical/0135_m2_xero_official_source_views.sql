-- 0135_m2_xero_official_source_views.sql
--
-- Curated, tenant-secured surface over the raw Xero ingest (XER_OFFICIAL),
-- following the Deputy pattern from 0134 exactly:
--   1. stamp tenant_id from source_xero_official.tenant_binding,
--   2. enforce the capability check (rows appear only when
--      ingestion.current_tenant_id() matches),
--   3. rename Xero's PascalCase to snake_case and parse the legacy
--      /Date(ms+tz)/ values to timestamptz,
--   4. join dlt child tables back to their parents so line-level views carry
--      their document context (invoice id, date, status, contact).
--
-- Privacy: employee Tax File Numbers and bank account / BSB digits are
-- deliberately never exposed to the semantic layer.
--
-- semantic_ro receives SELECT on the xo_* views only, never on XER_OFFICIAL.

BEGIN;

CREATE SCHEMA IF NOT EXISTS source_xero_official;

CREATE TABLE IF NOT EXISTS source_xero_official.tenant_binding (
  tenant_id text PRIMARY KEY
);

INSERT INTO source_xero_official.tenant_binding (tenant_id)
VALUES ('01KZ4ZMVF5QNQ4TX35VF3WDJBM')
ON CONFLICT DO NOTHING;

-- Xero's legacy JSON dates arrive as '/Date(1525305600000+0000)/'.
CREATE OR REPLACE FUNCTION source_xero_official.xero_ts(value text)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT to_timestamp(((regexp_match(value, '^/Date\((-?\d+)'))[1])::bigint / 1000.0)
$$;

-- Organisation -----------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_organisation
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || o."OrganisationID" AS row_key,
  o."OrganisationID"       AS organisation_id,
  o."Name"                 AS organisation_name,
  o."LegalName"            AS legal_name,
  o."OrganisationType"     AS organisation_type,
  o."OrganisationEntityType" AS entity_type,
  o."LineOfBusiness"       AS line_of_business,
  o."BaseCurrency"         AS base_currency,
  o."CountryCode"          AS country_code,
  o."Timezone"             AS timezone,
  o."RegistrationNumber"   AS abn,
  o."TaxNumber"            AS tax_number,
  o."PaysTax"              AS pays_tax,
  o."SalesTaxBasis"        AS gst_basis,
  o."SalesTaxPeriod"       AS gst_period,
  o."DefaultSalesTax"      AS default_sales_tax,
  o."DefaultPurchasesTax"  AS default_purchases_tax,
  o."FinancialYearEndDay"   AS financial_year_end_day,
  o."FinancialYearEndMonth" AS financial_year_end_month,
  source_xero_official.xero_ts(o."PeriodLockDate")::date    AS period_lock_date,
  source_xero_official.xero_ts(o."EndOfYearLockDate")::date AS end_of_year_lock_date,
  o."IsDemoCompany"        AS is_demo_company,
  o."OrganisationStatus"   AS organisation_status,
  o."Edition"              AS edition,
  source_xero_official.xero_ts(o."CreatedDateUTC") AS created_at
FROM "XER_OFFICIAL"."accounting_organisation__payload__Organisations" o
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Chart of accounts --------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_accounts
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || a."AccountID" AS row_key,
  a."AccountID"    AS account_id,
  a."Code"         AS account_code,
  a."Name"         AS account_name,
  a."Status"       AS status,
  a."Type"         AS account_type,
  a."Class"        AS account_class,
  a."TaxType"      AS tax_type,
  a."Description"  AS description,
  a."SystemAccount" AS system_account,
  a."BankAccountNumber" IS NOT NULL AS is_bank_account,
  a."BankAccountType" AS bank_account_type,
  a."CurrencyCode" AS currency_code,
  a."ReportingCode" AS reporting_code,
  a."ReportingCodeName" AS reporting_code_name,
  a."EnablePaymentsToAccount" AS enable_payments,
  a."ShowInExpenseClaims" AS show_in_expense_claims,
  a."AddToWatchlist" AS on_watchlist,
  source_xero_official.xero_ts(a."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_accounts__payload__Accounts" a
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Contacts ------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_contacts
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || c."ContactID" AS row_key,
  c."ContactID"     AS contact_id,
  c."Name"          AS contact_name,
  c."FirstName"     AS first_name,
  c."LastName"      AS last_name,
  c."EmailAddress"  AS email,
  c."ContactNumber" AS contact_number,
  c."ContactStatus" AS status,
  c."IsCustomer"    AS is_customer,
  c."IsSupplier"    AS is_supplier,
  c."DefaultCurrency" AS default_currency,
  c."Balances__AccountsReceivable__Outstanding" AS receivable_outstanding,
  c."Balances__AccountsReceivable__Overdue"     AS receivable_overdue,
  c."Balances__AccountsPayable__Outstanding"    AS payable_outstanding,
  c."Balances__AccountsPayable__Overdue"        AS payable_overdue,
  c."PaymentTerms__Sales__Day"  AS sales_payment_terms_day,
  c."PaymentTerms__Sales__Type" AS sales_payment_terms_type,
  c."PaymentTerms__Bills__Day"  AS bills_payment_terms_day,
  c."PaymentTerms__Bills__Type" AS bills_payment_terms_type,
  source_xero_official.xero_ts(c."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_contacts__payload__Contacts" c
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_contact_addresses
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || a."_dlt_id" AS row_key,
  c."ContactID"    AS contact_id,
  a."AddressType"  AS address_type,
  a."AddressLine1" AS address_line1,
  a."City"         AS city,
  a."Region"       AS region,
  a."PostalCode"   AS postal_code,
  a."Country"      AS country,
  a."AttentionTo"  AS attention_to
FROM "XER_OFFICIAL"."accounting_contacts__payload__Contacts__Addresses" a
JOIN "XER_OFFICIAL"."accounting_contacts__payload__Contacts" c
  ON c."_dlt_id" = a."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_contact_phones
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || p."_dlt_id" AS row_key,
  c."ContactID"     AS contact_id,
  p."PhoneType"     AS phone_type,
  p."PhoneNumber"   AS phone_number,
  p."PhoneAreaCode" AS phone_area_code,
  p."PhoneCountryCode" AS phone_country_code
FROM "XER_OFFICIAL"."accounting_contacts__payload__Contacts__Phones" p
JOIN "XER_OFFICIAL"."accounting_contacts__payload__Contacts" c
  ON c."_dlt_id" = p."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Invoices (sales invoices ACCREC and bills ACCPAY) --------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_invoices
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || i."InvoiceID" AS row_key,
  i."InvoiceID"      AS invoice_id,
  i."InvoiceNumber"  AS invoice_number,
  i."Type"           AS invoice_type,
  CASE i."Type" WHEN 'ACCREC' THEN 'Sales invoice' WHEN 'ACCPAY' THEN 'Bill' ELSE i."Type" END AS document_kind,
  i."Reference"      AS reference,
  i."Status"         AS status,
  i."LineAmountTypes" AS line_amount_types,
  i."Contact__ContactID" AS contact_id,
  i."Contact__Name"  AS contact_name,
  source_xero_official.xero_ts(i."Date")::date    AS issued_on,
  source_xero_official.xero_ts(i."DueDate")::date AS due_on,
  source_xero_official.xero_ts(i."FullyPaidOnDate")::date AS fully_paid_on,
  i."SubTotal"       AS subtotal,
  i."TotalTax"       AS total_tax,
  i."Total"          AS total,
  i."AmountDue"      AS amount_due,
  i."AmountPaid"     AS amount_paid,
  i."AmountCredited" AS amount_credited,
  i."CurrencyCode"   AS currency_code,
  i."CurrencyRate"   AS currency_rate,
  i."IsDiscounted"   AS is_discounted,
  i."SentToContact"  AS sent_to_contact,
  i."RepeatingInvoiceID" AS repeating_invoice_id,
  i."BrandingThemeID" AS branding_theme_id,
  i."HasAttachments" AS has_attachments,
  source_xero_official.xero_ts(i."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_invoices__payload__Invoices" i
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_invoice_line_items
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || l."_dlt_id" AS row_key,
  l."LineItemID"  AS line_item_id,
  i."InvoiceID"   AS invoice_id,
  i."Type"        AS invoice_type,
  i."Status"      AS invoice_status,
  source_xero_official.xero_ts(i."Date")::date AS issued_on,
  i."Contact__ContactID" AS contact_id,
  i."Contact__Name" AS contact_name,
  l."Description" AS description,
  l."Quantity"    AS quantity,
  l."UnitAmount"  AS unit_amount,
  l."LineAmount"  AS line_amount,
  l."TaxAmount"   AS tax_amount,
  l."TaxType"     AS tax_type,
  l."AccountCode" AS account_code,
  l."AccountID"   AS account_id,
  l."ItemCode"    AS item_code,
  l."Item__ItemID" AS item_id,
  l."Item__Name"  AS item_name
FROM "XER_OFFICIAL"."accounting_invoices__payload__Invoices__LineItems" l
JOIN "XER_OFFICIAL"."accounting_invoices__payload__Invoices" i
  ON i."_dlt_id" = l."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_invoice_payments
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || p."_dlt_id" AS row_key,
  p."PaymentID"   AS payment_id,
  i."InvoiceID"   AS invoice_id,
  i."Type"        AS invoice_type,
  source_xero_official.xero_ts(p."Date")::date AS paid_on,
  p."Amount"      AS amount,
  p."Reference"   AS reference,
  p."CurrencyRate" AS currency_rate,
  p."BatchPaymentID" AS batch_payment_id
FROM "XER_OFFICIAL"."accounting_invoices__payload__Invoices__Payments" p
JOIN "XER_OFFICIAL"."accounting_invoices__payload__Invoices" i
  ON i."_dlt_id" = p."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_invoice_credit_notes
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || cn."_dlt_id" AS row_key,
  cn."CreditNoteID"   AS credit_note_id,
  cn."CreditNoteNumber" AS credit_note_number,
  i."InvoiceID"       AS invoice_id,
  source_xero_official.xero_ts(cn."Date")::date AS applied_on,
  cn."AppliedAmount"  AS applied_amount,
  cn."Total"          AS credit_note_total
FROM "XER_OFFICIAL"."accounting_invoices__payload__Invoices__CreditNotes" cn
JOIN "XER_OFFICIAL"."accounting_invoices__payload__Invoices" i
  ON i."_dlt_id" = cn."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Payments --------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_payments
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || p."PaymentID" AS row_key,
  p."PaymentID"   AS payment_id,
  source_xero_official.xero_ts(p."Date")::date AS paid_on,
  p."Amount"      AS amount,
  p."BankAmount"  AS bank_amount,
  p."CurrencyRate" AS currency_rate,
  p."PaymentType" AS payment_type,
  p."Status"      AS status,
  p."IsReconciled" AS is_reconciled,
  p."Reference"   AS reference,
  p."Invoice__InvoiceID"     AS invoice_id,
  p."Invoice__InvoiceNumber" AS invoice_number,
  p."Invoice__Type"          AS invoice_type,
  p."Invoice__Contact__ContactID" AS contact_id,
  p."Invoice__Contact__Name" AS contact_name,
  p."Account__AccountID" AS account_id,
  p."Account__Code"      AS account_code,
  p."BatchPaymentID"     AS batch_payment_id,
  source_xero_official.xero_ts(p."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_payments__payload__Payments" p
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Credit notes ------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_credit_notes
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || cn."CreditNoteID" AS row_key,
  cn."CreditNoteID"     AS credit_note_id,
  cn."CreditNoteNumber" AS credit_note_number,
  cn."Type"             AS credit_note_type,
  CASE cn."Type" WHEN 'ACCRECCREDIT' THEN 'Customer credit note' WHEN 'ACCPAYCREDIT' THEN 'Supplier credit note' ELSE cn."Type" END AS document_kind,
  cn."Status"           AS status,
  cn."Reference"        AS reference,
  cn."Contact__ContactID" AS contact_id,
  cn."Contact__Name"    AS contact_name,
  source_xero_official.xero_ts(cn."Date")::date AS issued_on,
  source_xero_official.xero_ts(cn."FullyPaidOnDate")::date AS fully_paid_on,
  cn."SubTotal"         AS subtotal,
  cn."TotalTax"         AS total_tax,
  cn."Total"            AS total,
  cn."RemainingCredit"  AS remaining_credit,
  cn."CurrencyCode"     AS currency_code,
  cn."CurrencyRate"     AS currency_rate,
  source_xero_official.xero_ts(cn."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_creditnotes__payload__CreditNotes" cn
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_credit_note_line_items
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || l."_dlt_id" AS row_key,
  l."LineItemID"  AS line_item_id,
  cn."CreditNoteID" AS credit_note_id,
  cn."Type"       AS credit_note_type,
  source_xero_official.xero_ts(cn."Date")::date AS issued_on,
  cn."Contact__Name" AS contact_name,
  l."Description" AS description,
  l."Quantity"    AS quantity,
  l."UnitAmount"  AS unit_amount,
  l."LineAmount"  AS line_amount,
  l."TaxAmount"   AS tax_amount,
  l."TaxType"     AS tax_type,
  l."AccountCode" AS account_code,
  l."AccountID"   AS account_id
FROM "XER_OFFICIAL"."accounting_creditnotes__payload__CreditNotes__LineItems" l
JOIN "XER_OFFICIAL"."accounting_creditnotes__payload__CreditNotes" cn
  ON cn."_dlt_id" = l."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_credit_note_allocations
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || a."_dlt_id" AS row_key,
  a."AllocationID" AS allocation_id,
  cn."CreditNoteID" AS credit_note_id,
  a."Invoice__InvoiceID" AS invoice_id,
  a."Invoice__InvoiceNumber" AS invoice_number,
  source_xero_official.xero_ts(a."Date")::date AS allocated_on,
  a."Amount"       AS amount
FROM "XER_OFFICIAL"."accounting_creditnotes__payload__CreditNotes__Allocations" a
JOIN "XER_OFFICIAL"."accounting_creditnotes__payload__CreditNotes" cn
  ON cn."_dlt_id" = a."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Bank transactions ---------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_bank_transactions
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || t."BankTransactionID" AS row_key,
  t."BankTransactionID" AS bank_transaction_id,
  t."Type"           AS transaction_type,
  CASE
    WHEN t."Type" LIKE 'RECEIVE%' THEN 'Money in'
    WHEN t."Type" LIKE 'SPEND%' THEN 'Money out'
    ELSE t."Type"
  END AS money_direction,
  t."Status"         AS status,
  t."IsReconciled"   AS is_reconciled,
  t."Reference"      AS reference,
  t."Contact__ContactID" AS contact_id,
  t."Contact__Name"  AS contact_name,
  t."BankAccount__AccountID" AS bank_account_id,
  t."BankAccount__Code"      AS bank_account_code,
  t."BankAccount__Name"      AS bank_account_name,
  source_xero_official.xero_ts(t."Date")::date AS occurred_on,
  t."SubTotal"       AS subtotal,
  t."TotalTax"       AS total_tax,
  t."Total"          AS total,
  t."CurrencyCode"   AS currency_code,
  t."LineAmountTypes" AS line_amount_types,
  t."BatchPayment__BatchPaymentID" AS batch_payment_id,
  t."OverpaymentID"  AS overpayment_id,
  source_xero_official.xero_ts(t."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_banktransactions__payload__BankTransactions" t
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_bank_transaction_line_items
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || l."_dlt_id" AS row_key,
  l."LineItemID"  AS line_item_id,
  t."BankTransactionID" AS bank_transaction_id,
  t."Type"        AS transaction_type,
  source_xero_official.xero_ts(t."Date")::date AS occurred_on,
  t."Contact__Name" AS contact_name,
  t."BankAccount__Name" AS bank_account_name,
  l."Description" AS description,
  l."Quantity"    AS quantity,
  l."UnitAmount"  AS unit_amount,
  l."LineAmount"  AS line_amount,
  l."TaxAmount"   AS tax_amount,
  l."TaxType"     AS tax_type,
  l."AccountCode" AS account_code,
  l."AccountID"   AS account_id
FROM "XER_OFFICIAL"."accounting_banktransactions__vrhabg_BankTransactions__LineItems" l
JOIN "XER_OFFICIAL"."accounting_banktransactions__payload__BankTransactions" t
  ON t."_dlt_id" = l."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Bank transfers -------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_bank_transfers
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || t."BankTransferID" AS row_key,
  t."BankTransferID" AS bank_transfer_id,
  source_xero_official.xero_ts(t."Date")::date AS transferred_on,
  t."Amount"         AS amount,
  t."CurrencyRate"   AS currency_rate,
  t."Reference"      AS reference,
  t."Status"         AS status,
  t."FromBankAccount__AccountID" AS from_account_id,
  t."FromBankAccount__Name"      AS from_account_name,
  t."ToBankAccount__AccountID"   AS to_account_id,
  t."ToBankAccount__Name"        AS to_account_name,
  t."FromIsReconciled" AS from_is_reconciled,
  t."ToIsReconciled"   AS to_is_reconciled,
  source_xero_official.xero_ts(t."CreatedDateUTC") AS created_at
FROM "XER_OFFICIAL"."accounting_banktransfers__payload__BankTransfers" t
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Batch payments ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_batch_payments
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || p."BatchPaymentID" AS row_key,
  p."BatchPaymentID" AS batch_payment_id,
  source_xero_official.xero_ts(p."Date")::date AS paid_on,
  p."Type"           AS batch_type,
  p."Status"         AS status,
  p."TotalAmount"    AS total_amount,
  p."IsReconciled"   AS is_reconciled,
  p."Details"        AS details,
  p."Account__AccountID" AS account_id,
  source_xero_official.xero_ts(p."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_batchpayments__payload__BatchPayments" p
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_batch_payment_members
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || m."_dlt_id" AS row_key,
  m."PaymentID"   AS payment_id,
  p."BatchPaymentID" AS batch_payment_id,
  source_xero_official.xero_ts(p."Date")::date AS paid_on,
  m."Amount"      AS amount,
  m."BankAmount"  AS bank_amount,
  m."Details"     AS details,
  m."Invoice__InvoiceID" AS invoice_id
FROM "XER_OFFICIAL"."accounting_batchpayments__payload__BatchPayments__Payments" m
JOIN "XER_OFFICIAL"."accounting_batchpayments__payload__BatchPayments" p
  ON p."_dlt_id" = m."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Manual journals ------------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_manual_journals
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || j."ManualJournalID" AS row_key,
  j."ManualJournalID" AS manual_journal_id,
  j."Narration"      AS narration,
  j."Status"         AS status,
  source_xero_official.xero_ts(j."Date")::date AS journal_on,
  j."DebitTotal"     AS debit_total,
  j."CreditTotal"    AS credit_total,
  j."LineAmountTypes" AS line_amount_types,
  j."ShowOnCashBasisReports" AS show_on_cash_basis_reports,
  source_xero_official.xero_ts(j."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_manualjournals__payload__ManualJournals" j
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_manual_journal_lines
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || l."_dlt_id" AS row_key,
  j."ManualJournalID" AS manual_journal_id,
  j."Narration"    AS narration,
  j."Status"       AS journal_status,
  source_xero_official.xero_ts(j."Date")::date AS journal_on,
  l."Description"  AS description,
  l."LineAmount"   AS line_amount,
  l."TaxAmount"    AS tax_amount,
  l."TaxType"      AS tax_type,
  l."AccountCode"  AS account_code,
  l."AccountID"    AS account_id,
  CASE WHEN l."LineAmount" >= 0 THEN l."LineAmount" ELSE 0 END AS debit_amount,
  CASE WHEN l."LineAmount" < 0 THEN -l."LineAmount" ELSE 0 END AS credit_amount
FROM "XER_OFFICIAL"."accounting_manualjournals__papjwmrwManualJournals__JournalLines" l
JOIN "XER_OFFICIAL"."accounting_manualjournals__payload__ManualJournals" j
  ON j."_dlt_id" = l."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id())
  AND NOT COALESCE(l."IsBlank", false);

-- Overpayments --------------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_overpayments
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || o."OverpaymentID" AS row_key,
  o."OverpaymentID" AS overpayment_id,
  o."Type"          AS overpayment_type,
  o."Status"        AS status,
  o."Contact__ContactID" AS contact_id,
  o."Contact__Name" AS contact_name,
  source_xero_official.xero_ts(o."Date")::date AS occurred_on,
  o."SubTotal"      AS subtotal,
  o."TotalTax"      AS total_tax,
  o."Total"         AS total,
  o."RemainingCredit" AS remaining_credit,
  o."CurrencyCode"  AS currency_code,
  source_xero_official.xero_ts(o."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_overpayments__payload__Overpayments" o
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_overpayment_allocations
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || a."_dlt_id" AS row_key,
  a."AllocationID" AS allocation_id,
  o."OverpaymentID" AS overpayment_id,
  a."Invoice__InvoiceID" AS invoice_id,
  a."Invoice__InvoiceNumber" AS invoice_number,
  source_xero_official.xero_ts(a."Date")::date AS allocated_on,
  a."Amount"       AS amount
FROM "XER_OFFICIAL"."accounting_overpayments__payload__Overpayments__Allocations" a
JOIN "XER_OFFICIAL"."accounting_overpayments__payload__Overpayments" o
  ON o."_dlt_id" = a."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Items, tax rates, currencies, users, branding, budgets -----------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_items
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || i."ItemID" AS row_key,
  i."ItemID"       AS item_id,
  i."Code"         AS item_code,
  i."Name"         AS item_name,
  i."Description"  AS description,
  i."PurchaseDescription" AS purchase_description,
  i."IsSold"       AS is_sold,
  i."IsPurchased"  AS is_purchased,
  i."IsTrackedAsInventory" AS is_tracked_as_inventory,
  i."SalesDetails__UnitPrice"   AS sales_unit_price,
  i."SalesDetails__AccountCode" AS sales_account_code,
  i."SalesDetails__TaxType"     AS sales_tax_type,
  i."PurchaseDetails__UnitPrice"   AS purchase_unit_price,
  i."PurchaseDetails__AccountCode" AS purchase_account_code,
  i."PurchaseDetails__TaxType"     AS purchase_tax_type,
  source_xero_official.xero_ts(i."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_items__payload__Items" i
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_tax_rates
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || t."TaxType" AS row_key,
  t."TaxType"       AS tax_type,
  t."Name"          AS tax_name,
  t."ReportTaxType" AS report_tax_type,
  t."Status"        AS status,
  t."DisplayTaxRate" AS display_tax_rate,
  t."EffectiveRate" AS effective_rate,
  t."CanApplyToAssets"      AS can_apply_to_assets,
  t."CanApplyToEquity"      AS can_apply_to_equity,
  t."CanApplyToExpenses"    AS can_apply_to_expenses,
  t."CanApplyToLiabilities" AS can_apply_to_liabilities,
  t."CanApplyToRevenue"     AS can_apply_to_revenue
FROM "XER_OFFICIAL"."accounting_taxrates__payload__TaxRates" t
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_currencies
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || c."Code" AS row_key,
  c."Code"        AS currency_code,
  c."Description" AS description
FROM "XER_OFFICIAL"."accounting_currencies__payload__Currencies" c
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_users
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || u."UserID" AS row_key,
  u."UserID"       AS user_id,
  u."FirstName"    AS first_name,
  u."LastName"     AS last_name,
  u."EmailAddress" AS email,
  u."OrganisationRole" AS organisation_role,
  u."IsSubscriber" AS is_subscriber,
  source_xero_official.xero_ts(u."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_users__payload__Users" u
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_branding_themes
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || t."BrandingThemeID" AS row_key,
  t."BrandingThemeID" AS branding_theme_id,
  t."Name"            AS theme_name,
  t."Type"            AS theme_type,
  t."SortOrder"       AS sort_order,
  source_xero_official.xero_ts(t."CreatedDateUTC") AS created_at
FROM "XER_OFFICIAL"."accounting_brandingthemes__payload__BrandingThemes" t
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_budgets
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || g."BudgetID" AS row_key,
  g."BudgetID"    AS budget_id,
  g."Type"        AS budget_type,
  g."Description" AS description,
  g."Status"      AS status,
  source_xero_official.xero_ts(g."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."accounting_budgets__payload__Budgets" g
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_repeating_invoices
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || r."RepeatingInvoiceID" AS row_key,
  r."RepeatingInvoiceID" AS repeating_invoice_id,
  r."Type"           AS invoice_type,
  r."Status"         AS status,
  r."Reference"      AS reference,
  r."Contact__ContactID" AS contact_id,
  r."Contact__Name"  AS contact_name,
  r."SubTotal"       AS subtotal,
  r."TotalTax"       AS total_tax,
  r."Total"          AS total,
  r."CurrencyCode"   AS currency_code,
  r."Schedule__Period" AS schedule_period,
  r."Schedule__Unit"   AS schedule_unit,
  r."Schedule__DueDate" AS schedule_due_day,
  r."Schedule__DueDateType" AS schedule_due_date_type,
  source_xero_official.xero_ts(r."Schedule__StartDate")::date AS schedule_starts_on,
  source_xero_official.xero_ts(r."Schedule__EndDate")::date   AS schedule_ends_on,
  source_xero_official.xero_ts(r."Schedule__NextScheduledDate")::date AS next_scheduled_on,
  r."ApprovedForSending" AS approved_for_sending
FROM "XER_OFFICIAL"."accounting_repeatinginvoices__payload__RepeatingInvoices" r
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_repeating_invoice_line_items
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || l."_dlt_id" AS row_key,
  l."LineItemID"  AS line_item_id,
  r."RepeatingInvoiceID" AS repeating_invoice_id,
  r."Type"        AS invoice_type,
  r."Contact__Name" AS contact_name,
  l."Description" AS description,
  l."Quantity"    AS quantity,
  l."UnitAmount"  AS unit_amount,
  l."LineAmount"  AS line_amount,
  l."TaxAmount"   AS tax_amount,
  l."TaxType"     AS tax_type,
  l."AccountCode" AS account_code,
  l."ItemCode"    AS item_code
FROM "XER_OFFICIAL"."accounting_repeatinginvoices_zy9knaRepeatingInvoices__LineItems" l
JOIN "XER_OFFICIAL"."accounting_repeatinginvoices__payload__RepeatingInvoices" r
  ON r."_dlt_id" = l."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Fixed assets ------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_assets
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || a."assetId" AS row_key,
  a."assetId"       AS asset_id,
  a."assetName"     AS asset_name,
  a."assetNumber"   AS asset_number,
  a."assetStatus"   AS status,
  a."purchaseDate"::date AS purchased_on,
  a."purchasePrice" AS purchase_price,
  a."disposalPrice" AS disposal_price,
  a."accountingBookValue" AS book_value,
  a."assetTypeId"   AS asset_type_id,
  a."bookDepreciationSetting__depreciationMethod" AS depreciation_method,
  a."bookDepreciationSetting__depreciationCalculationMethod" AS depreciation_calculation_method,
  a."bookDepreciationDetail__depreciationStartDate"::date AS depreciation_started_on,
  a."bookDepreciationDetail__priorAccumDepreciationAmount"   AS prior_accumulated_depreciation,
  a."bookDepreciationDetail__currentAccumDepreciationAmount" AS current_accumulated_depreciation,
  a."bookDepreciationDetail__currentGainLoss" AS current_gain_loss
FROM "XER_OFFICIAL"."assets_assets__payload__items" a
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_asset_types
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || t."assetTypeId" AS row_key,
  t."assetTypeId"   AS asset_type_id,
  t."assetTypeName" AS asset_type_name,
  t."fixedAssetAccountId" AS fixed_asset_account_id,
  t."depreciationExpenseAccountId" AS depreciation_expense_account_id,
  t."accumulatedDepreciationAccountId" AS accumulated_depreciation_account_id,
  t."bookDepreciationSetting__depreciationMethod" AS depreciation_method,
  t."bookDepreciationSetting__depreciationRate"   AS depreciation_rate
FROM "XER_OFFICIAL"."assets_assettypes__payload" t
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Files ----------------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_files
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || f."Id" AS row_key,
  f."Id"        AS file_id,
  f."Name"      AS file_name,
  f."MimeType"  AS mime_type,
  f."Size"      AS size_bytes,
  f."FolderId"  AS folder_id,
  f."User__Name" AS uploaded_by,
  f."CreatedDateUtc" AS created_at,
  f."UpdatedDateUtc" AS updated_at
FROM "XER_OFFICIAL"."files_files__payload__Items" f
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_file_associations
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || a."_dlt_id" AS row_key,
  a."FileId"      AS file_id,
  a."ObjectId"    AS object_id,
  a."ObjectType"  AS object_type,
  a."ObjectGroup" AS object_group
FROM "XER_OFFICIAL"."files_associations__payload" a
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- AU payroll --------------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW source_xero_official.xo_payroll_employees
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || e."EmployeeID" AS row_key,
  e."EmployeeID"   AS employee_id,
  e."FirstName"    AS first_name,
  e."LastName"     AS last_name,
  e."FirstName" || ' ' || e."LastName" AS full_name,
  e."Status"       AS status,
  e."Email"        AS email,
  source_xero_official.xero_ts(e."DateOfBirth")::date AS date_of_birth,
  e."Gender"       AS gender,
  e."JobTitle"     AS job_title,
  e."Classification" AS classification,
  e."EmploymentType" AS employment_type,
  e."IncomeType"   AS income_type,
  source_xero_official.xero_ts(e."StartDate")::date AS started_on,
  e."OrdinaryEarningsRateID" AS ordinary_earnings_rate_id,
  e."PayrollCalendarID" AS payroll_calendar_id,
  e."IsAuthorisedToApproveLeave" AS approves_leave,
  e."IsAuthorisedToApproveTimesheets" AS approves_timesheets,
  -- Tax declaration flags (the Tax File Number itself is deliberately excluded).
  e."TaxDeclaration__EmploymentBasis" AS employment_basis,
  e."TaxDeclaration__AustralianResidentForTaxPurposes" AS australian_tax_resident,
  e."TaxDeclaration__TaxFreeThresholdClaimed" AS tax_free_threshold_claimed,
  e."TaxDeclaration__HasLoanOrStudentDebt" AS has_loan_or_student_debt,
  e."HomeAddress__City"   AS home_city,
  e."HomeAddress__Region" AS home_region,
  e."HomeAddress__PostalCode" AS home_postal_code,
  source_xero_official.xero_ts(e."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."payroll_au_employees_detail__payload__Employees" e
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_pay_runs
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || p."PayRunID" AS row_key,
  p."PayRunID"    AS pay_run_id,
  p."PayrollCalendarID" AS payroll_calendar_id,
  source_xero_official.xero_ts(p."PayRunPeriodStartDate")::date AS period_started_on,
  source_xero_official.xero_ts(p."PayRunPeriodEndDate")::date   AS period_ended_on,
  source_xero_official.xero_ts(p."PaymentDate")::date           AS paid_on,
  p."Wages"        AS wages,
  p."Deductions"   AS deductions,
  p."Tax"          AS tax,
  p."Super"        AS super,
  p."Reimbursement" AS reimbursements,
  p."NetPay"       AS net_pay,
  p."PayRunStatus" AS status,
  source_xero_official.xero_ts(p."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."payroll_au_payruns__payload__PayRuns" p
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_payslip_summaries
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || s."PayslipID" AS row_key,
  s."PayslipID"   AS payslip_id,
  s."EmployeeID"  AS employee_id,
  s."FirstName" || ' ' || s."LastName" AS employee_name,
  r."PayRunID"    AS pay_run_id,
  source_xero_official.xero_ts(r."PayRunPeriodStartDate")::date AS period_started_on,
  source_xero_official.xero_ts(r."PayRunPeriodEndDate")::date   AS period_ended_on,
  source_xero_official.xero_ts(r."PaymentDate")::date           AS paid_on,
  r."PayRunStatus" AS pay_run_status,
  s."Wages"        AS wages,
  s."Deductions"   AS deductions,
  s."Tax"          AS tax,
  s."Super"        AS super,
  s."Reimbursements" AS reimbursements,
  s."NetPay"       AS net_pay
FROM "XER_OFFICIAL"."payroll_au_pay_runs_detail__payload__PayRuns__Payslips" s
JOIN "XER_OFFICIAL"."payroll_au_pay_runs_detail__payload__PayRuns" r
  ON r."_dlt_id" = s."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_payroll_timesheets
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || t."TimesheetID" AS row_key,
  t."TimesheetID" AS timesheet_id,
  t."EmployeeID"  AS employee_id,
  source_xero_official.xero_ts(t."StartDate")::date AS period_started_on,
  source_xero_official.xero_ts(t."EndDate")::date   AS period_ended_on,
  t."Status"      AS status,
  t."Hours"       AS total_hours,
  source_xero_official.xero_ts(t."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."payroll_au_timesheets__payload__Timesheets" t
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- One row per timesheet line per day: the NumberOfUnits child array is indexed
-- by day offset from the timesheet period start.
CREATE OR REPLACE VIEW source_xero_official.xo_timesheet_day_units
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || u."_dlt_id" AS row_key,
  t."TimesheetID" AS timesheet_id,
  t."EmployeeID"  AS employee_id,
  l."EarningsRateID" AS earnings_rate_id,
  (source_xero_official.xero_ts(t."StartDate")::date + u."_dlt_list_idx"::int)::date AS worked_on,
  u."value"       AS hours
FROM "XER_OFFICIAL"."payroll_au_timesheets__payloariroiwimesheetLines__NumberOfUnits" u
JOIN "XER_OFFICIAL"."payroll_au_timesheets__payload__Timesheets__TimesheetLines" l
  ON l."_dlt_id" = u."_dlt_parent_id"
JOIN "XER_OFFICIAL"."payroll_au_timesheets__payload__Timesheets" t
  ON t."_dlt_id" = l."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_earnings_rates
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || e."EarningsRateID" AS row_key,
  e."EarningsRateID" AS earnings_rate_id,
  e."Name"          AS rate_name,
  e."EarningsType"  AS earnings_type,
  e."RateType"      AS rate_type,
  e."RatePerUnit"   AS rate_per_unit,
  e."TypeOfUnits"   AS type_of_units,
  e."AccountCode"   AS account_code,
  e."IsExemptFromTax"   AS is_exempt_from_tax,
  e."IsExemptFromSuper" AS is_exempt_from_super,
  e."AllowanceType" AS allowance_type,
  e."CurrentRecord" AS is_current
FROM "XER_OFFICIAL"."payroll_au_payitems__payload__PayItems__EarningsRates" e
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_deduction_types
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || d."DeductionTypeID" AS row_key,
  d."DeductionTypeID" AS deduction_type_id,
  d."Name"            AS deduction_name,
  d."DeductionCategory" AS category,
  d."AccountCode"     AS account_code,
  d."ReducesTax"      AS reduces_tax,
  d."ReducesSuper"    AS reduces_super,
  d."CurrentRecord"   AS is_current
FROM "XER_OFFICIAL"."payroll_au_payitems__payload__PayItems__DeductionTypes" d
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_leave_types
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || l."LeaveTypeID" AS row_key,
  l."LeaveTypeID"  AS leave_type_id,
  l."Name"         AS leave_name,
  l."TypeOfUnits"  AS type_of_units,
  l."NormalEntitlement" AS normal_entitlement,
  l."IsPaidLeave"  AS is_paid_leave,
  l."ShowOnPayslip" AS show_on_payslip,
  l."LeaveCategoryCode" AS leave_category_code,
  l."CurrentRecord" AS is_current
FROM "XER_OFFICIAL"."payroll_au_payitems__payload__PayItems__LeaveTypes" l
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_reimbursement_types
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || r."ReimbursementTypeID" AS row_key,
  r."ReimbursementTypeID" AS reimbursement_type_id,
  r."Name"        AS reimbursement_name,
  r."AccountCode" AS account_code,
  r."CurrentRecord" AS is_current
FROM "XER_OFFICIAL"."payroll_au_payitems__payload__PayItems__ReimbursementTypes" r
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_payroll_calendars
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || c."PayrollCalendarID" AS row_key,
  c."PayrollCalendarID" AS payroll_calendar_id,
  c."Name"         AS calendar_name,
  c."CalendarType" AS calendar_type,
  source_xero_official.xero_ts(c."StartDate")::date   AS starts_on,
  source_xero_official.xero_ts(c."PaymentDate")::date AS payment_date
FROM "XER_OFFICIAL"."payroll_au_payrollcalendars__payload__PayrollCalendars" c
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_super_funds
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || f."SuperFundID" AS row_key,
  f."SuperFundID" AS super_fund_id,
  f."Name"        AS fund_name,
  f."Type"        AS fund_type,
  f."USI"         AS usi,
  source_xero_official.xero_ts(f."UpdatedDateUTC") AS updated_at
FROM "XER_OFFICIAL"."payroll_au_superfunds__payload__SuperFunds" f
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_super_memberships
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || m."SuperMembershipID" AS row_key,
  m."SuperMembershipID" AS super_membership_id,
  e."EmployeeID"   AS employee_id,
  m."SuperFundID"  AS super_fund_id,
  m."EmployeeNumber" AS employee_number
FROM "XER_OFFICIAL"."payroll_au_employees_detail__pglaug_Employees__SuperMemberships" m
JOIN "XER_OFFICIAL"."payroll_au_employees_detail__payload__Employees" e
  ON e."_dlt_id" = m."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_employee_pay_template_earnings
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || l."_dlt_id" AS row_key,
  e."EmployeeID"   AS employee_id,
  l."EarningsRateID" AS earnings_rate_id,
  l."CalculationType" AS calculation_type,
  l."AnnualSalary" AS annual_salary,
  l."RatePerUnit"  AS rate_per_unit,
  l."NormalNumberOfUnits" AS normal_number_of_units,
  l."NumberOfUnitsPerWeek" AS units_per_week
FROM "XER_OFFICIAL"."payroll_au_employees_detail__vzfcoa__PayTemplate__EarningsLines" l
JOIN "XER_OFFICIAL"."payroll_au_employees_detail__payload__Employees" e
  ON e."_dlt_id" = l."_dlt_parent_id"
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

CREATE OR REPLACE VIEW source_xero_official.xo_payroll_settings_accounts
WITH (security_barrier = true) AS
SELECT
  b.tenant_id,
  b.tenant_id || ':' || a."AccountID" AS row_key,
  a."AccountID" AS account_id,
  a."Type"      AS account_purpose,
  a."Code"      AS account_code,
  a."Name"      AS account_name
FROM "XER_OFFICIAL"."payroll_au_settings__payload__Settings__Accounts" a
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

-- Grants -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA source_xero_official TO semantic_ro;
GRANT EXECUTE ON FUNCTION source_xero_official.xero_ts(text) TO semantic_ro;
GRANT SELECT ON
  source_xero_official.xo_organisation,
  source_xero_official.xo_accounts,
  source_xero_official.xo_contacts,
  source_xero_official.xo_contact_addresses,
  source_xero_official.xo_contact_phones,
  source_xero_official.xo_invoices,
  source_xero_official.xo_invoice_line_items,
  source_xero_official.xo_invoice_payments,
  source_xero_official.xo_invoice_credit_notes,
  source_xero_official.xo_payments,
  source_xero_official.xo_credit_notes,
  source_xero_official.xo_credit_note_line_items,
  source_xero_official.xo_credit_note_allocations,
  source_xero_official.xo_bank_transactions,
  source_xero_official.xo_bank_transaction_line_items,
  source_xero_official.xo_bank_transfers,
  source_xero_official.xo_batch_payments,
  source_xero_official.xo_batch_payment_members,
  source_xero_official.xo_manual_journals,
  source_xero_official.xo_manual_journal_lines,
  source_xero_official.xo_overpayments,
  source_xero_official.xo_overpayment_allocations,
  source_xero_official.xo_items,
  source_xero_official.xo_tax_rates,
  source_xero_official.xo_currencies,
  source_xero_official.xo_users,
  source_xero_official.xo_branding_themes,
  source_xero_official.xo_budgets,
  source_xero_official.xo_repeating_invoices,
  source_xero_official.xo_repeating_invoice_line_items,
  source_xero_official.xo_assets,
  source_xero_official.xo_asset_types,
  source_xero_official.xo_files,
  source_xero_official.xo_file_associations,
  source_xero_official.xo_payroll_employees,
  source_xero_official.xo_pay_runs,
  source_xero_official.xo_payslip_summaries,
  source_xero_official.xo_payroll_timesheets,
  source_xero_official.xo_timesheet_day_units,
  source_xero_official.xo_earnings_rates,
  source_xero_official.xo_deduction_types,
  source_xero_official.xo_leave_types,
  source_xero_official.xo_reimbursement_types,
  source_xero_official.xo_payroll_calendars,
  source_xero_official.xo_super_funds,
  source_xero_official.xo_super_memberships,
  source_xero_official.xo_employee_pay_template_earnings,
  source_xero_official.xo_payroll_settings_accounts
TO semantic_ro;

COMMIT;
