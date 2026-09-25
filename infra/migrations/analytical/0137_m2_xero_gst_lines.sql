BEGIN;

-- 0137: derived GST lines for Xero (XER_OFFICIAL).
--
-- The Reports API (including GST/BAS reports) is refused for this app tier,
-- so GST questions are answered from document lines instead. This view unions
-- every tax-bearing line from invoices/bills, spend/receive bank transactions
-- and credit notes, splitting tax into gst_collected (on income documents)
-- and gst_paid (on purchase documents). Credit notes reverse their document
-- direction. Manual journal lines are excluded deliberately: in this dataset
-- they carry no GST breakdown (system-posted sales journals arrive tax-blind),
-- which is why the semantic layer must disclose that GST collected can be
-- understated when sales are posted via journals.
--
-- Unlike xo_pnl_lines, this view keeps lines coded to ANY account class:
-- GST on capital purchases (asset-coded bills) is claimable and must appear.

CREATE OR REPLACE VIEW source_xero_official.xo_gst_lines
WITH (security_barrier = true) AS
WITH accounts AS (
  SELECT
    a."AccountID"   AS account_id,
    a."Code"        AS account_code,
    a."Name"        AS account_name,
    a."Class"       AS account_class,
    a."Type"        AS account_type
  FROM "XER_OFFICIAL"."accounting_accounts__payload__Accounts" a
),
tax_lines AS (
  -- Invoice and bill lines. ACCREC collects GST, ACCPAY pays it.
  SELECT
    'invoice_line'::text AS source_kind,
    i."InvoiceID"        AS source_id,
    l."_dlt_id"          AS line_uid,
    source_xero_official.xero_ts(i."Date")::date AS occurred_on,
    i."Contact__Name"    AS contact_name,
    l."Description"      AS description,
    l."AccountID"        AS account_id,
    l."AccountCode"      AS account_code,
    l."TaxType"          AS tax_type,
    CASE WHEN i."LineAmountTypes" = 'Inclusive'
         THEN l."LineAmount" - COALESCE(l."TaxAmount", 0)
         ELSE l."LineAmount" END AS taxable_amount,
    CASE WHEN i."Type" = 'ACCREC' THEN COALESCE(l."TaxAmount", 0) ELSE 0 END AS gst_collected,
    CASE WHEN i."Type" = 'ACCPAY' THEN COALESCE(l."TaxAmount", 0) ELSE 0 END AS gst_paid
  FROM "XER_OFFICIAL"."accounting_invoices__payload__Invoices__LineItems" l
  JOIN "XER_OFFICIAL"."accounting_invoices__payload__Invoices" i
    ON i."_dlt_id" = l."_dlt_parent_id"
  WHERE i."Status" IN ('AUTHORISED', 'PAID')
    AND COALESCE(l."TaxAmount", 0) <> 0

  UNION ALL

  -- Spend / receive money lines.
  SELECT
    'bank_line',
    t."BankTransactionID",
    l."_dlt_id",
    source_xero_official.xero_ts(t."Date")::date,
    t."Contact__Name",
    l."Description",
    l."AccountID",
    l."AccountCode",
    l."TaxType",
    CASE WHEN t."LineAmountTypes" = 'Inclusive'
         THEN l."LineAmount" - COALESCE(l."TaxAmount", 0)
         ELSE l."LineAmount" END,
    CASE WHEN t."Type" = 'RECEIVE' THEN COALESCE(l."TaxAmount", 0) ELSE 0 END,
    CASE WHEN t."Type" = 'SPEND' THEN COALESCE(l."TaxAmount", 0) ELSE 0 END
  FROM "XER_OFFICIAL"."accounting_banktransactions__vrhabg_BankTransactions__LineItems" l
  JOIN "XER_OFFICIAL"."accounting_banktransactions__payload__BankTransactions" t
    ON t."_dlt_id" = l."_dlt_parent_id"
  WHERE t."Status" = 'AUTHORISED'
    AND t."Type" IN ('SPEND', 'RECEIVE')
    AND COALESCE(l."TaxAmount", 0) <> 0

  UNION ALL

  -- Credit note lines reverse their document: a customer credit note
  -- (ACCRECCREDIT) reduces GST collected, a supplier one reduces GST paid.
  SELECT
    'credit_note_line',
    cn."CreditNoteID",
    l."_dlt_id",
    source_xero_official.xero_ts(cn."Date")::date,
    cn."Contact__Name",
    l."Description",
    l."AccountID",
    l."AccountCode",
    l."TaxType",
    -1 * (CASE WHEN cn."LineAmountTypes" = 'Inclusive'
               THEN l."LineAmount" - COALESCE(l."TaxAmount", 0)
               ELSE l."LineAmount" END),
    CASE WHEN cn."Type" = 'ACCRECCREDIT' THEN -COALESCE(l."TaxAmount", 0) ELSE 0 END,
    CASE WHEN cn."Type" = 'ACCPAYCREDIT' THEN -COALESCE(l."TaxAmount", 0) ELSE 0 END
  FROM "XER_OFFICIAL"."accounting_creditnotes__payload__CreditNotes__LineItems" l
  JOIN "XER_OFFICIAL"."accounting_creditnotes__payload__CreditNotes" cn
    ON cn."_dlt_id" = l."_dlt_parent_id"
  WHERE cn."Status" IN ('AUTHORISED', 'PAID')
    AND COALESCE(l."TaxAmount", 0) <> 0
)
SELECT
  b.tenant_id,
  b.tenant_id || ':' || t.source_kind || ':' || t.line_uid AS row_key,
  t.source_kind,
  t.source_id,
  t.occurred_on,
  t.contact_name,
  t.description,
  t.tax_type,
  a.account_code,
  a.account_name,
  a.account_class,
  a.account_type,
  t.taxable_amount,
  t.gst_collected,
  t.gst_paid,
  t.gst_collected - t.gst_paid AS net_gst
FROM tax_lines t
LEFT JOIN accounts a
  ON (t.account_id IS NOT NULL AND a.account_id = t.account_id)
  OR (t.account_id IS NULL AND a.account_code = t.account_code)
CROSS JOIN source_xero_official.tenant_binding b
WHERE b.tenant_id = (SELECT ingestion.current_tenant_id());

GRANT SELECT ON source_xero_official.xo_gst_lines TO semantic_ro;

COMMIT;
