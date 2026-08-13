BEGIN;

-- 0136: derived P&L lines for Xero (XER_OFFICIAL).
--
-- Xero refuses the accounting.reports.read and accounting.journals.read
-- scopes for this app tier, so neither the Reports API nor the Journals
-- endpoint can provide ledger truth. This view derives the profit-and-loss
-- ledger from every financially-real, GL-coded line the granted scopes do
-- expose: invoice/bill lines, spend/receive bank transaction lines, posted
-- manual journal lines and credit note lines, restricted to REVENUE and
-- EXPENSE class accounts.
--
-- Each line is normalised to a signed ledger movement (debit positive), so
-- profit_impact = -movement holds for every row:
--   revenue_amount  = -movement on REVENUE-class accounts (credits earn)
--   expense_amount  = +movement on EXPENSE-class accounts (debits spend)
--   profit_impact   = revenue_amount - expense_amount    = -movement
--
-- Known exclusions (impossible without journal access, disclosed in the
-- semantic layer): Xero system journals such as payroll posting runs,
-- fixed-asset depreciation runs and unrealised FX. Wage costs are available
-- authoritatively from the payroll API instead.

CREATE OR REPLACE VIEW source_xero_official.xo_pnl_lines
WITH (security_barrier = true) AS
WITH pnl_accounts AS (
  SELECT
    a."AccountID"   AS account_id,
    a."Code"        AS account_code,
    a."Name"        AS account_name,
    a."Class"       AS account_class,
    a."Type"        AS account_type,
    a."ReportingCode" AS reporting_code
  FROM "XER_OFFICIAL"."accounting_accounts__payload__Accounts" a
  WHERE a."Class" IN ('REVENUE', 'EXPENSE')
),
movements AS (
  -- Sales invoice and bill lines. ACCPAY debits the coded account,
  -- ACCREC credits it.
  SELECT
    'invoice_line'::text AS source_kind,
    i."InvoiceID"        AS source_id,
    l."_dlt_id"          AS line_uid,
    source_xero_official.xero_ts(i."Date")::date AS occurred_on,
    i."Contact__Name"    AS contact_name,
    l."Description"      AS description,
    l."AccountID"        AS account_id,
    l."AccountCode"      AS account_code,
    (CASE WHEN i."LineAmountTypes" = 'Inclusive'
          THEN l."LineAmount" - COALESCE(l."TaxAmount", 0)
          ELSE l."LineAmount" END)
      * (CASE i."Type" WHEN 'ACCPAY' THEN 1 ELSE -1 END) AS movement
  FROM "XER_OFFICIAL"."accounting_invoices__payload__Invoices__LineItems" l
  JOIN "XER_OFFICIAL"."accounting_invoices__payload__Invoices" i
    ON i."_dlt_id" = l."_dlt_parent_id"
  WHERE i."Status" IN ('AUTHORISED', 'PAID')

  UNION ALL

  -- Spend / receive money lines (excludes transfers, overpayments and
  -- prepayments, which are balance-sheet movements).
  SELECT
    'bank_line',
    t."BankTransactionID",
    l."_dlt_id",
    source_xero_official.xero_ts(t."Date")::date,
    t."Contact__Name",
    l."Description",
    l."AccountID",
    l."AccountCode",
    (CASE WHEN t."LineAmountTypes" = 'Inclusive'
          THEN l."LineAmount" - COALESCE(l."TaxAmount", 0)
          ELSE l."LineAmount" END)
      * (CASE WHEN t."Type" = 'SPEND' THEN 1 ELSE -1 END)
  FROM "XER_OFFICIAL"."accounting_banktransactions__vrhabg_BankTransactions__LineItems" l
  JOIN "XER_OFFICIAL"."accounting_banktransactions__payload__BankTransactions" t
    ON t."_dlt_id" = l."_dlt_parent_id"
  WHERE t."Status" = 'AUTHORISED'
    AND t."Type" IN ('SPEND', 'RECEIVE')

  UNION ALL

  -- Posted manual journal lines: LineAmount is already debit-positive.
  SELECT
    'journal_line',
    j."ManualJournalID",
    l."_dlt_id",
    source_xero_official.xero_ts(j."Date")::date,
    NULL,
    COALESCE(l."Description", j."Narration"),
    l."AccountID",
    l."AccountCode",
    CASE WHEN j."LineAmountTypes" = 'Inclusive'
         THEN l."LineAmount" - COALESCE(l."TaxAmount", 0)
         ELSE l."LineAmount" END
  FROM "XER_OFFICIAL"."accounting_manualjournals__papjwmrwManualJournals__JournalLines" l
  JOIN "XER_OFFICIAL"."accounting_manualjournals__payload__ManualJournals" j
    ON j."_dlt_id" = l."_dlt_parent_id"
  WHERE j."Status" = 'POSTED'
    AND NOT COALESCE(l."IsBlank", false)

  UNION ALL

  -- Credit note lines reverse their document direction: a customer credit
  -- note (ACCRECCREDIT) debits revenue, a supplier one credits expense.
  SELECT
    'credit_note_line',
    cn."CreditNoteID",
    l."_dlt_id",
    source_xero_official.xero_ts(cn."Date")::date,
    cn."Contact__Name",
    l."Description",
    l."AccountID",
    l."AccountCode",
    (CASE WHEN cn."LineAmountTypes" = 'Inclusive'
          THEN l."LineAmount" - COALESCE(l."TaxAmount", 0)
          ELSE l."LineAmount" END)
      * (CASE cn."Type" WHEN 'ACCRECCREDIT' THEN 1 ELSE -1 END)
  FROM "XER_OFFICIAL"."accounting_creditnotes__payload__CreditNotes__LineItems" l
  JOIN "XER_OFFICIAL"."accounting_creditnotes__payload__CreditNotes" cn
    ON cn."_dlt_id" = l."_dlt_parent_id"
  WHERE cn."Status" IN ('AUTHORISED', 'PAID')
)
SELECT
  b.tenant_id,
  b.tenant_id || ':' || m.source_kind || ':' || m.line_uid AS row_key,
  m.source_kind,
  m.source_id,
  m.occurred_on,
  m.contact_name,
  m.description,
  a.account_id,
  a.account_code,
  a.account_name,
  a.account_class,
  a.account_type,
  a.reporting_code,
  m.movement,
  CASE WHEN a.account_class = 'REVENUE' THEN -m.movement ELSE 0 END AS revenue_amount,
  CASE WHEN a.account_class = 'EXPENSE' THEN m.movement ELSE 0 END AS expense_amount,
  -m.movement AS profit_impact
FROM movements m
JOIN pnl_accounts a
  ON (m.account_id IS NOT NULL AND a.account_id = m.account_id)
  OR (m.account_id IS NULL AND a.account_code = m.account_code)
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

GRANT SELECT ON source_xero_official.xo_pnl_lines TO semantic_ro;

COMMIT;
