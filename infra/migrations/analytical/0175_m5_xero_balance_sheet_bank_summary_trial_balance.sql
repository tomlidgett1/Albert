-- 0175: expose Xero's own Fivetran-landed Balance Sheet, Bank Summary and
-- Trial Balance reports as governed CubeCore sources.
--
-- Until now only the Profit and Loss report (0173) had official views; the
-- balance sheet, bank summary and trial balance landed by the SDK connector
-- (connectors/xero-fivetran-sdk/xero_reports.py) had none, so "what's our
-- balance sheet", "how much is in the bank", "what do we owe on the van
-- loan" and "what's our inventory worth" depended entirely on a live Xero
-- API call - which shares the organisation's 1,000-call daily allowance with
-- the sync and was exhausted for most of 2026-08-19. These views expose the
-- newest complete snapshot of each report date/period, joined to the chart
-- of accounts so lines can be classified by Xero's own account types and
-- system-account roles (DEBTORS, CREDITORS, GST ...).
--
-- The landed tables have not yet received Fivetran's `_fivetran_deleted`
-- column (it appears only after a row is soft-deleted), so these views do
-- not reference it: report rows are re-emitted in full on every refresh and
-- the newest-snapshot filter discards stale rows.

BEGIN;

DO $$
BEGIN
  IF to_regclass('source_xero_fivetran.xero_report_balance_sheet_lines') IS NULL THEN
    CREATE VIEW source_xero_fivetran.xero_report_balance_sheet_lines AS
    SELECT
      NULL::text AS tenant_id, NULL::varchar AS source_record_id, NULL::varchar AS report_id,
      NULL::varchar AS report_name, NULL::timestamptz AS report_updated_at,
      NULL::timestamptz AS _albert_synced_at, NULL::date AS as_at, NULL::varchar AS column_label,
      NULL::varchar AS section, NULL::varchar AS row_title, NULL::varchar AS row_type,
      NULL::varchar AS account_id, NULL::numeric AS amount, NULL::integer AS ordinal,
      NULL::timestamptz AS _fivetran_synced, NULL::text AS namespaced_source_key
    WHERE false;
    GRANT SELECT ON source_xero_fivetran.xero_report_balance_sheet_lines TO transform_rw, diagnostic_ro;
  END IF;
  IF to_regclass('source_xero_fivetran.xero_report_bank_summary_lines') IS NULL THEN
    CREATE VIEW source_xero_fivetran.xero_report_bank_summary_lines AS
    SELECT
      NULL::text AS tenant_id, NULL::varchar AS source_record_id, NULL::varchar AS report_id,
      NULL::varchar AS report_name, NULL::timestamptz AS report_updated_at,
      NULL::timestamptz AS _albert_synced_at, NULL::date AS period_start, NULL::date AS period_end,
      NULL::varchar AS section, NULL::varchar AS row_title, NULL::varchar AS row_type,
      NULL::varchar AS account_id, NULL::numeric AS opening_balance, NULL::numeric AS cash_received,
      NULL::numeric AS cash_spent, NULL::numeric AS closing_balance, NULL::integer AS ordinal,
      NULL::timestamptz AS _fivetran_synced, NULL::text AS namespaced_source_key
    WHERE false;
    GRANT SELECT ON source_xero_fivetran.xero_report_bank_summary_lines TO transform_rw, diagnostic_ro;
  END IF;
  IF to_regclass('source_xero_fivetran.xero_report_trial_balance_lines') IS NULL THEN
    CREATE VIEW source_xero_fivetran.xero_report_trial_balance_lines AS
    SELECT
      NULL::text AS tenant_id, NULL::varchar AS source_record_id, NULL::varchar AS report_id,
      NULL::varchar AS report_name, NULL::timestamptz AS report_updated_at,
      NULL::timestamptz AS _albert_synced_at, NULL::date AS as_at,
      NULL::varchar AS section, NULL::varchar AS row_title, NULL::varchar AS row_type,
      NULL::varchar AS account_id, NULL::numeric AS debit, NULL::numeric AS credit,
      NULL::numeric AS ytd_debit, NULL::numeric AS ytd_credit, NULL::integer AS ordinal,
      NULL::timestamptz AS _fivetran_synced, NULL::text AS namespaced_source_key
    WHERE false;
    GRANT SELECT ON source_xero_fivetran.xero_report_trial_balance_lines TO transform_rw, diagnostic_ro;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Balance sheet lines: newest snapshot of every as-at date, account-classified
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW source_xero_official.xo_balance_sheet_lines
WITH (security_barrier = true) AS
WITH report_rows AS (
  SELECT
    report.*,
    max(report._albert_synced_at) OVER (PARTITION BY report.tenant_id, report.as_at) AS snapshot_synced_at
  FROM source_xero_fivetran.xero_report_balance_sheet_lines AS report
  WHERE report.tenant_id = (SELECT ingestion.current_tenant_id())
),
accounts AS (
  SELECT DISTINCT ON (account.tenant_id, account.account_id)
    account.tenant_id, account.account_id, account.account_code, account.account_name,
    account.account_type, account.account_class, account.status AS account_status,
    account.system_account, account.is_bank_account, account.bank_account_type,
    account.reporting_code, account.reporting_code_name
  FROM source_xero_official.xo_accounts AS account
  ORDER BY account.tenant_id, account.account_id
)
SELECT
  report.tenant_id,
  report.tenant_id || ':' || report.source_record_id AS row_key,
  report.source_record_id,
  report.report_id,
  report.report_name,
  report.report_updated_at,
  report._albert_synced_at AS synced_at,
  report.as_at,
  report.column_label,
  report.section,
  report.row_title,
  report.row_type,
  report.account_id,
  account.account_code,
  COALESCE(account.account_name, report.row_title) AS account_name,
  account.account_type,
  account.account_class,
  account.account_status,
  account.system_account,
  account.is_bank_account,
  account.bank_account_type,
  account.reporting_code,
  account.reporting_code_name,
  report.amount,
  report.ordinal,
  report.account_id IS NOT NULL AS is_account_line,
  CASE
    WHEN lower(btrim(report.row_title)) = 'total assets' THEN 'TOTAL_ASSETS'
    WHEN lower(btrim(report.row_title)) = 'total liabilities' THEN 'TOTAL_LIABILITIES'
    WHEN lower(btrim(report.row_title)) = 'net assets' THEN 'NET_ASSETS'
    WHEN lower(btrim(report.row_title)) = 'total equity' THEN 'TOTAL_EQUITY'
    WHEN lower(btrim(report.row_title)) = 'total bank' THEN 'TOTAL_BANK'
    WHEN lower(btrim(report.row_title)) = 'total current assets' THEN 'TOTAL_CURRENT_ASSETS'
    WHEN lower(btrim(report.row_title)) = 'total fixed assets' THEN 'TOTAL_FIXED_ASSETS'
    WHEN lower(btrim(report.row_title)) = 'total non-current assets' THEN 'TOTAL_NON_CURRENT_ASSETS'
    WHEN lower(btrim(report.row_title)) = 'total current liabilities' THEN 'TOTAL_CURRENT_LIABILITIES'
    WHEN lower(btrim(report.row_title)) = 'total non-current liabilities' THEN 'TOTAL_NON_CURRENT_LIABILITIES'
    WHEN lower(btrim(report.row_title)) = 'current year earnings' THEN 'CURRENT_YEAR_EARNINGS'
    WHEN report.account_id IS NOT NULL THEN 'ACCOUNT'
    ELSE 'OTHER_SUMMARY'
  END AS semantic_line,
  CASE
    WHEN report.account_id IS NULL THEN 'SUMMARY'
    WHEN account.account_type = 'BANK' OR lower(btrim(report.section)) = 'bank' THEN 'BANK'
    WHEN account.account_type IN ('CURRENT', 'INVENTORY', 'PREPAYMENT') THEN 'CURRENT_ASSET'
    WHEN account.account_type = 'FIXED' THEN 'FIXED_ASSET'
    WHEN account.account_type = 'NONCURRENT' THEN 'NON_CURRENT_ASSET'
    WHEN account.account_type IN ('CURRLIAB', 'PAYGLIABILITY', 'SUPERANNUATIONLIABILITY', 'WAGESPAYABLELIABILITY') THEN 'CURRENT_LIABILITY'
    WHEN account.account_type IN ('LIABILITY', 'TERMLIAB', 'SUPERANNUATIONEXPENSE') THEN 'NON_CURRENT_LIABILITY'
    WHEN account.account_type = 'EQUITY' THEN 'EQUITY'
    WHEN lower(btrim(report.section)) LIKE '%current asset%' THEN 'CURRENT_ASSET'
    WHEN lower(btrim(report.section)) LIKE '%fixed asset%' THEN 'FIXED_ASSET'
    WHEN lower(btrim(report.section)) LIKE '%non-current asset%' THEN 'NON_CURRENT_ASSET'
    WHEN lower(btrim(report.section)) LIKE '%current liabilit%' AND lower(btrim(report.section)) NOT LIKE '%non-current%' THEN 'CURRENT_LIABILITY'
    WHEN lower(btrim(report.section)) LIKE '%non-current liabilit%' THEN 'NON_CURRENT_LIABILITY'
    WHEN lower(btrim(report.section)) LIKE '%equity%' THEN 'EQUITY'
    ELSE 'UNCLASSIFIED_ACCOUNT'
  END AS balance_category,
  CASE
    WHEN report.account_id IS NULL THEN NULL
    WHEN lower(btrim(report.section)) LIKE '%liabilit%' OR account.account_class = 'LIABILITY' THEN 'LIABILITY'
    WHEN lower(btrim(report.section)) LIKE '%equity%' OR account.account_class = 'EQUITY' THEN 'EQUITY'
    ELSE 'ASSET'
  END AS statement_side,
  account.system_account = 'DEBTORS' AS is_accounts_receivable,
  account.system_account = 'CREDITORS' AS is_accounts_payable,
  account.system_account = 'GST' AS is_gst_control,
  account.account_type = 'INVENTORY' AS is_inventory
FROM report_rows AS report
LEFT JOIN accounts AS account
  ON account.tenant_id = report.tenant_id
 AND account.account_id = report.account_id
WHERE report._albert_synced_at = report.snapshot_synced_at;

COMMENT ON VIEW source_xero_official.xo_balance_sheet_lines IS
  'Newest Fivetran snapshot of Xero standard-layout Balance Sheet rows per as-at date, classified by Xero account type and system role. Amounts keep Xero display signs; account rows and summary rows must never be summed together.';

-- ---------------------------------------------------------------------------
-- Balance sheet positions: one row per as-at date with Xero's own totals
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW source_xero_official.xo_balance_sheet_positions
WITH (security_barrier = true) AS
SELECT
  line.tenant_id,
  line.tenant_id || ':' || line.as_at::text AS row_key,
  line.as_at,
  max(line.report_updated_at) AS report_updated_at,
  max(line.synced_at) AS synced_at,
  count(*) AS statement_line_count,
  count(*) FILTER (WHERE line.is_account_line) AS account_line_count,
  max(line.amount) FILTER (WHERE line.semantic_line = 'TOTAL_ASSETS') AS total_assets,
  max(line.amount) FILTER (WHERE line.semantic_line = 'TOTAL_LIABILITIES') AS total_liabilities,
  max(line.amount) FILTER (WHERE line.semantic_line = 'NET_ASSETS') AS net_assets,
  max(line.amount) FILTER (WHERE line.semantic_line = 'TOTAL_EQUITY') AS total_equity,
  max(line.amount) FILTER (WHERE line.semantic_line = 'TOTAL_BANK') AS total_bank,
  max(line.amount) FILTER (WHERE line.semantic_line = 'TOTAL_CURRENT_ASSETS') AS total_current_assets,
  max(line.amount) FILTER (WHERE line.semantic_line = 'TOTAL_FIXED_ASSETS') AS total_fixed_assets,
  max(line.amount) FILTER (WHERE line.semantic_line = 'TOTAL_NON_CURRENT_ASSETS') AS total_non_current_assets,
  max(line.amount) FILTER (WHERE line.semantic_line = 'TOTAL_CURRENT_LIABILITIES') AS total_current_liabilities,
  max(line.amount) FILTER (WHERE line.semantic_line = 'TOTAL_NON_CURRENT_LIABILITIES') AS total_non_current_liabilities,
  max(line.amount) FILTER (WHERE line.semantic_line = 'CURRENT_YEAR_EARNINGS') AS current_year_earnings,
  COALESCE(sum(line.amount) FILTER (WHERE line.is_account_line AND line.balance_category = 'BANK'), 0) AS bank_accounts_total,
  COALESCE(sum(line.amount) FILTER (WHERE line.is_accounts_receivable), 0) AS accounts_receivable,
  COALESCE(sum(line.amount) FILTER (WHERE line.is_accounts_payable), 0) AS accounts_payable,
  COALESCE(sum(line.amount) FILTER (WHERE line.is_gst_control), 0) AS gst_balance,
  COALESCE(sum(line.amount) FILTER (WHERE line.is_inventory), 0) AS inventory,
  COALESCE(sum(line.amount) FILTER (WHERE line.is_account_line AND line.statement_side = 'ASSET'), 0) AS calculated_total_assets,
  COALESCE(sum(line.amount) FILTER (WHERE line.is_account_line AND line.statement_side = 'LIABILITY'), 0) AS calculated_total_liabilities,
  max(line.amount) FILTER (WHERE line.semantic_line = 'TOTAL_ASSETS')
    - max(line.amount) FILTER (WHERE line.semantic_line = 'TOTAL_LIABILITIES')
    - max(line.amount) FILTER (WHERE line.semantic_line = 'NET_ASSETS') AS net_assets_reconciliation_variance
FROM source_xero_official.xo_balance_sheet_lines AS line
GROUP BY line.tenant_id, line.as_at;

COMMENT ON VIEW source_xero_official.xo_balance_sheet_positions IS
  'One row per Xero Balance Sheet as-at date (month ends). Total assets/liabilities/net assets are Xero report totals; receivable, payable, GST, inventory and bank components come from official system-account roles and account types.';

-- ---------------------------------------------------------------------------
-- Bank summary: per bank account per month - opening, received, spent, closing
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW source_xero_official.xo_bank_summary_lines
WITH (security_barrier = true) AS
WITH report_rows AS (
  SELECT
    report.*,
    max(report._albert_synced_at) OVER (
      PARTITION BY report.tenant_id, report.period_start, report.period_end
    ) AS snapshot_synced_at
  FROM source_xero_fivetran.xero_report_bank_summary_lines AS report
  WHERE report.tenant_id = (SELECT ingestion.current_tenant_id())
),
accounts AS (
  SELECT DISTINCT ON (account.tenant_id, account.account_id)
    account.tenant_id, account.account_id, account.account_code, account.account_name,
    account.account_type, account.status AS account_status, account.bank_account_type,
    account.currency_code
  FROM source_xero_official.xo_accounts AS account
  ORDER BY account.tenant_id, account.account_id
)
SELECT
  report.tenant_id,
  report.tenant_id || ':' || report.source_record_id AS row_key,
  report.source_record_id,
  report.report_id,
  report.report_name,
  report.report_updated_at,
  report._albert_synced_at AS synced_at,
  report.period_start,
  report.period_end,
  report.section,
  report.row_title,
  report.row_type,
  report.account_id,
  account.account_code,
  COALESCE(account.account_name, report.row_title) AS bank_account_name,
  account.bank_account_type,
  account.account_status,
  account.currency_code,
  report.opening_balance,
  report.cash_received,
  report.cash_spent,
  report.closing_balance,
  report.ordinal,
  report.account_id IS NOT NULL AS is_account_line,
  report.account_id IS NULL AND lower(btrim(report.row_title)) LIKE 'total%' AS is_total_line
FROM report_rows AS report
LEFT JOIN accounts AS account
  ON account.tenant_id = report.tenant_id
 AND account.account_id = report.account_id
WHERE report._albert_synced_at = report.snapshot_synced_at;

COMMENT ON VIEW source_xero_official.xo_bank_summary_lines IS
  'Newest Fivetran snapshot of Xero Bank Summary rows: one row per bank account per calendar month with opening balance, cash received, cash spent and closing balance (Xero balance, not the bank feed statement balance). Account rows and the Total row must never be summed together.';

-- ---------------------------------------------------------------------------
-- Trial balance: per account per as-at date
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW source_xero_official.xo_trial_balance_lines
WITH (security_barrier = true) AS
WITH report_rows AS (
  SELECT
    report.*,
    max(report._albert_synced_at) OVER (PARTITION BY report.tenant_id, report.as_at) AS snapshot_synced_at
  FROM source_xero_fivetran.xero_report_trial_balance_lines AS report
  WHERE report.tenant_id = (SELECT ingestion.current_tenant_id())
),
accounts AS (
  SELECT DISTINCT ON (account.tenant_id, account.account_id)
    account.tenant_id, account.account_id, account.account_code, account.account_name,
    account.account_type, account.account_class, account.status AS account_status,
    account.system_account, account.reporting_code, account.reporting_code_name
  FROM source_xero_official.xo_accounts AS account
  ORDER BY account.tenant_id, account.account_id
)
SELECT
  report.tenant_id,
  report.tenant_id || ':' || report.source_record_id AS row_key,
  report.source_record_id,
  report.report_id,
  report.report_name,
  report.report_updated_at,
  report._albert_synced_at AS synced_at,
  report.as_at,
  report.section,
  report.row_title,
  report.row_type,
  report.account_id,
  account.account_code,
  COALESCE(account.account_name, report.row_title) AS account_name,
  account.account_type,
  account.account_class,
  account.account_status,
  account.system_account,
  account.reporting_code,
  account.reporting_code_name,
  report.debit,
  report.credit,
  report.ytd_debit,
  report.ytd_credit,
  COALESCE(report.debit, 0) - COALESCE(report.credit, 0) AS net_balance,
  COALESCE(report.ytd_debit, 0) - COALESCE(report.ytd_credit, 0) AS ytd_net_balance,
  report.ordinal,
  report.account_id IS NOT NULL AS is_account_line,
  report.account_id IS NULL AND lower(btrim(report.row_title)) LIKE 'total%' AS is_total_line
FROM report_rows AS report
LEFT JOIN accounts AS account
  ON account.tenant_id = report.tenant_id
 AND account.account_id = report.account_id
WHERE report._albert_synced_at = report.snapshot_synced_at;

COMMENT ON VIEW source_xero_official.xo_trial_balance_lines IS
  'Newest Fivetran snapshot of Xero Trial Balance rows per as-at date: every ledger account with period and YTD debit/credit. net_balance is debit minus credit (assets/expenses positive, liabilities/equity/income negative).';

GRANT USAGE ON SCHEMA source_xero_official TO semantic_ro;
GRANT SELECT ON source_xero_official.xo_balance_sheet_lines TO semantic_ro;
GRANT SELECT ON source_xero_official.xo_balance_sheet_positions TO semantic_ro;
GRANT SELECT ON source_xero_official.xo_bank_summary_lines TO semantic_ro;
GRANT SELECT ON source_xero_official.xo_trial_balance_lines TO semantic_ro;

COMMIT;
