-- 0173: make Xero's own Fivetran-landed Profit and Loss report the governed
-- CubeCore statement source.
--
-- The former xo_pnl_lines view reconstructs document-coded activity from
-- invoices, bank transactions, credit notes and manual journals. It cannot
-- see Xero's system payroll and fixed-asset journals, so its apparent
-- "net profit" omits wages, superannuation and automatic depreciation.
-- Albert's Fivetran SDK connector now lands Xero's standard-layout
-- ProfitAndLoss report directly. These views expose the newest complete
-- snapshot of each monthly report period and a one-row-per-period summary
-- using Xero's documented account taxonomy.

BEGIN;

DO $$
BEGIN
  IF to_regclass('source_xero_fivetran.xero_report_profit_and_loss_lines') IS NULL THEN
    -- Fresh databases and tenants connected before the report table's first
    -- landing still need a compile-stable Cube contract. The v4 Fivetran
    -- union builder replaces this typed empty view (and restores its dependent
    -- official views) as soon as a real SDK table exists.
    CREATE VIEW source_xero_fivetran.xero_report_profit_and_loss_lines AS
    SELECT
      NULL::text AS tenant_id,
      NULL::varchar AS source_record_id,
      NULL::varchar AS report_id,
      NULL::varchar AS report_name,
      NULL::timestamptz AS report_updated_at,
      NULL::timestamptz AS _albert_synced_at,
      NULL::varchar AS basis,
      NULL::date AS period_start,
      NULL::date AS period_end,
      NULL::varchar AS column_label,
      NULL::varchar AS section,
      NULL::varchar AS row_title,
      NULL::varchar AS row_type,
      NULL::varchar AS account_id,
      NULL::numeric AS amount,
      NULL::integer AS ordinal,
      NULL::timestamptz AS _fivetran_synced,
      NULL::boolean AS _fivetran_deleted,
      NULL::text AS namespaced_source_key
    WHERE false;
    GRANT SELECT
      ON source_xero_fivetran.xero_report_profit_and_loss_lines
      TO transform_rw, diagnostic_ro;
  END IF;
END $$;

CREATE OR REPLACE VIEW source_xero_official.xo_profit_and_loss_lines
WITH (security_barrier = true) AS
WITH report_rows AS (
  SELECT
    report.*,
    max(report._albert_synced_at) OVER (
      PARTITION BY report.tenant_id, report.basis,
                   report.period_start, report.period_end
    ) AS snapshot_synced_at
  FROM source_xero_fivetran.xero_report_profit_and_loss_lines AS report
  WHERE report.tenant_id = (SELECT ingestion.current_tenant_id())
    AND NOT COALESCE(report._fivetran_deleted, false)
),
accounts AS (
  SELECT DISTINCT ON (account.tenant_id, account.account_id)
    account.tenant_id,
    account.account_id,
    account.account_code,
    account.account_name,
    account.account_type,
    account.account_class,
    account.status AS account_status,
    account.system_account,
    account.reporting_code,
    account.reporting_code_name
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
  report.basis,
  report.period_start,
  report.period_end,
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
  account.reporting_code,
  account.reporting_code_name,
  report.amount,
  report.ordinal,
  report.account_id IS NOT NULL AS is_account_line,
  CASE
    WHEN lower(btrim(report.row_title)) IN ('net profit', 'net profit (loss)', 'profit (loss)')
      THEN 'NET_PROFIT'
    WHEN lower(btrim(report.row_title)) IN ('gross profit', 'gross profit (loss)')
      THEN 'GROSS_PROFIT'
    WHEN lower(btrim(report.row_title)) = 'total income'
      THEN 'TOTAL_INCOME'
    WHEN lower(btrim(report.row_title)) IN ('total cost of sales', 'total cost of goods sold')
      THEN 'TOTAL_COST_OF_SALES'
    WHEN lower(btrim(report.row_title)) = 'total operating expenses'
      THEN 'TOTAL_OPERATING_EXPENSES'
    WHEN lower(btrim(report.row_title)) = 'total other income'
      THEN 'TOTAL_OTHER_INCOME'
    WHEN report.account_id IS NOT NULL
      THEN 'ACCOUNT'
    ELSE 'OTHER_SUMMARY'
  END AS semantic_line,
  CASE
    WHEN account.account_type IN ('REVENUE', 'SALES') THEN 'SALES_REVENUE'
    WHEN account.account_type = 'OTHERINCOME' THEN 'OTHER_INCOME'
    WHEN account.account_type = 'DIRECTCOSTS' THEN 'COST_OF_SALES'
    WHEN account.account_type IN ('EXPENSE', 'OVERHEADS', 'DEPRECIATN')
      THEN 'OPERATING_EXPENSE'
    WHEN account.account_type IS NULL
         AND report.account_id IS NOT NULL
         AND lower(btrim(report.section)) = 'income' THEN 'SALES_REVENUE'
    WHEN account.account_type IS NULL
         AND report.account_id IS NOT NULL
         AND lower(btrim(report.section)) LIKE '%other income%' THEN 'OTHER_INCOME'
    WHEN account.account_type IS NULL
         AND report.account_id IS NOT NULL
         AND lower(btrim(report.section)) LIKE '%cost of sales%' THEN 'COST_OF_SALES'
    WHEN account.account_type IS NULL
         AND report.account_id IS NOT NULL
         AND lower(btrim(report.section)) LIKE '%operating expense%' THEN 'OPERATING_EXPENSE'
    WHEN report.account_id IS NOT NULL THEN 'UNCLASSIFIED_ACCOUNT'
    ELSE 'SUMMARY'
  END AS profit_category,
  account.reporting_code IN ('EXP.WAG', 'EXP.EMP.WAG', 'EXP.COS.WAG')
    AS is_wage_expense,
  account.reporting_code = 'EXP.COS.WAG' AS is_direct_wage_expense,
  account.reporting_code IN ('EXP.SUP', 'EXP.EMP.SUP', 'EXP.COS.SUP')
    AS is_employer_super_expense
FROM report_rows AS report
LEFT JOIN accounts AS account
  ON account.tenant_id = report.tenant_id
 AND account.account_id = report.account_id
WHERE report._albert_synced_at = report.snapshot_synced_at;

COMMENT ON VIEW source_xero_official.xo_profit_and_loss_lines IS
  'Newest Fivetran snapshot of Xero standard-layout monthly ProfitAndLoss rows. Report amounts retain Xero display signs; account rows and formula/summary rows coexist and must never be summed together.';

CREATE OR REPLACE VIEW source_xero_official.xo_profit_and_loss_periods
WITH (security_barrier = true) AS
SELECT
  line.tenant_id,
  line.tenant_id || ':' || line.basis || ':' || line.period_start::text
    || ':' || line.period_end::text AS row_key,
  line.basis,
  line.period_start,
  line.period_end,
  max(line.report_updated_at) AS report_updated_at,
  max(line.synced_at) AS synced_at,
  count(*) AS statement_line_count,
  count(*) FILTER (WHERE line.is_account_line) AS account_line_count,
  count(*) FILTER (WHERE line.profit_category = 'UNCLASSIFIED_ACCOUNT')
    AS unclassified_account_line_count,
  count(*) FILTER (WHERE line.semantic_line = 'NET_PROFIT')
    AS net_profit_line_count,
  count(*) FILTER (WHERE line.semantic_line = 'GROSS_PROFIT')
    AS gross_profit_line_count,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line
      AND line.profit_category = 'SALES_REVENUE'
  ), 0) AS sales_revenue,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line
      AND line.profit_category = 'OTHER_INCOME'
  ), 0) AS other_income,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line
      AND line.profit_category IN ('SALES_REVENUE', 'OTHER_INCOME')
  ), 0) AS total_income,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line
      AND line.profit_category = 'COST_OF_SALES'
  ), 0) AS cost_of_sales,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line
      AND line.profit_category = 'OPERATING_EXPENSE'
  ), 0) AS operating_expenses,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line
      AND line.profit_category IN ('COST_OF_SALES', 'OPERATING_EXPENSE')
  ), 0) AS total_expenses,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line AND line.is_wage_expense
  ), 0) AS wage_expenses,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line AND line.is_direct_wage_expense
  ), 0) AS direct_wage_expenses,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line
      AND line.is_wage_expense
      AND NOT line.is_direct_wage_expense
  ), 0) AS operating_wage_expenses,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line AND line.is_employer_super_expense
  ), 0) AS employer_super_expenses,
  max(line.amount) FILTER (WHERE line.semantic_line = 'GROSS_PROFIT')
    AS gross_profit,
  max(line.amount) FILTER (WHERE line.semantic_line = 'NET_PROFIT')
    AS net_profit,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line
      AND line.profit_category IN ('SALES_REVENUE', 'OTHER_INCOME')
  ), 0)
  - COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line
      AND line.profit_category IN ('COST_OF_SALES', 'OPERATING_EXPENSE')
  ), 0) AS calculated_net_profit,
  COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line AND line.profit_category = 'SALES_REVENUE'
  ), 0)
  - COALESCE(sum(line.amount) FILTER (
    WHERE line.is_account_line AND line.profit_category = 'COST_OF_SALES'
  ), 0) AS calculated_gross_profit,
  max(line.amount) FILTER (WHERE line.semantic_line = 'NET_PROFIT')
  - (
      COALESCE(sum(line.amount) FILTER (
        WHERE line.is_account_line
          AND line.profit_category IN ('SALES_REVENUE', 'OTHER_INCOME')
      ), 0)
      - COALESCE(sum(line.amount) FILTER (
        WHERE line.is_account_line
          AND line.profit_category IN ('COST_OF_SALES', 'OPERATING_EXPENSE')
      ), 0)
    ) AS net_profit_reconciliation_variance,
  max(line.amount) FILTER (WHERE line.semantic_line = 'GROSS_PROFIT')
  - (
      COALESCE(sum(line.amount) FILTER (
        WHERE line.is_account_line AND line.profit_category = 'SALES_REVENUE'
      ), 0)
      - COALESCE(sum(line.amount) FILTER (
        WHERE line.is_account_line AND line.profit_category = 'COST_OF_SALES'
      ), 0)
    ) AS gross_profit_reconciliation_variance
FROM source_xero_official.xo_profit_and_loss_lines AS line
GROUP BY line.tenant_id, line.basis, line.period_start, line.period_end;

COMMENT ON VIEW source_xero_official.xo_profit_and_loss_periods IS
  'One row per Xero P&L basis and month. Net/gross profit are Xero report totals; income and expense components use official Xero account types and reconcile back to those totals.';

GRANT USAGE ON SCHEMA source_xero_official TO semantic_ro;
GRANT SELECT ON source_xero_official.xo_profit_and_loss_lines TO semantic_ro;
GRANT SELECT ON source_xero_official.xo_profit_and_loss_periods TO semantic_ro;

DO $$
DECLARE
  active_tenant record;
  bad_periods bigint;
BEGIN
  FOR active_tenant IN
    SELECT DISTINCT binding.tenant_id
    FROM ingestion.fivetran_destination_bindings AS binding
    WHERE binding.retired_at IS NULL
      AND binding.destination_schema LIKE 'xero\_%'
  LOOP
    PERFORM set_config('albert.tenant_id', active_tenant.tenant_id, true);
    SELECT count(*) INTO bad_periods
    FROM source_xero_official.xo_profit_and_loss_periods
    WHERE net_profit_line_count <> 1
       OR gross_profit_line_count <> 1
       OR abs(net_profit_reconciliation_variance) > 0.01
       OR abs(gross_profit_reconciliation_variance) > 0.01;
    IF bad_periods > 0 THEN
      RAISE EXCEPTION
        '0173 found % Xero P&L periods that do not reconcile for tenant %',
        bad_periods, active_tenant.tenant_id;
    END IF;
  END LOOP;
END $$;

COMMIT;
