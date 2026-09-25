---
type: always
---

# Xero accounting semantics

Apply these rules whenever a result comes from a `xero_*` view:

- `xero_profit_and_loss_analytics` is the authoritative whole-business accrual
  Profit and Loss. It is Xero's own standard report landed through Fivetran,
  not a reconstruction from invoices. Its `net_profit` already deducts every
  posted P&L cost, including wages, superannuation, direct costs, overheads,
  depreciation, interest and tax expenses. Never subtract a payroll figure
  from it again. A negative Net Profit is a loss, not missing data.
- Xero's official account-type formulas are: sales revenue = `REVENUE` +
  `SALES`; other income = `OTHERINCOME`; total income = those three; cost of
  sales/COGS = `DIRECTCOSTS`; operating expenses = `EXPENSE` + `OVERHEADS` +
  `DEPRECIATN`; total expenses = direct costs plus operating expenses; Gross
  Profit = sales revenue - cost of sales; Net Profit = total income - total
  expenses. Gross margin and Net Profit margin divide by sales revenue, not
  total income.
- Ordinary wages (`EXP.WAG` / `EXP.EMP.WAG`) are operating expenses: they
  reduce Net Profit but not Gross Profit. Direct-production wages
  (`EXP.COS.WAG`) are cost of sales: they reduce both. `WAGEPAYABLES` is a
  balance-sheet liability and never a wage expense. Wage flags come from Xero
  report codes; do not guess from editable account names.
- Headline statement/trend questions use `xero_profit_and_loss_analytics`.
  Named expense/revenue rankings and wage-line drill-down use
  `xero_profit_and_loss_account_analytics`. Never calculate Net Profit by
  summing account rows, and never use `xero_finance_analytics.pnl_*`: those
  backward-compatible members omit system payroll and depreciation journals.
- The P&L views are monthly and accrual basis. Filter/sum on `period_start` for
  month, quarter, year or financial-year totals. The current month is
  month-to-date through `report_updated_at` even though `period_end` is month
  end; say that it is partial. Do not claim an arbitrary day-level P&L or a
  period older than the retained report window. Organisation `org_gst_basis`
  is the tax-return basis; it does not turn this accrual P&L into cash basis.
- Amounts are in the Xero organisation's base `currency`. Do not multiply by a
  document currency rate or add them to POS takings. Xero is the accounting
  statement; Lightspeed/Square sales are operational evidence of the same
  commerce and adding both double counts revenue.
- P&L is a flow over a date range. A Balance Sheet is a stock as at one date.
  Invoices/bills, payments and bank transactions are operational document/cash
  surfaces and are not substitutes for either statement.
- Sales invoices are `ACCREC`; supplier bills are `ACCPAY`. Only AUTHORISED and
  PAID documents are financially real. DRAFT, SUBMITTED, DELETED and VOIDED
  documents may be useful workflow records but do not belong in financial
  totals. Invoice totals are document currency unless a measure explicitly
  says base currency.
- Invoice, payment and bank-document money can be in source currency. Include
  or filter the relevant currency member (`invoice_currency`, `bank_currency`)
  before aggregating; never add unlike currencies or assume AUD. The P&L report
  is different: its amounts are already organisation base currency.
- Xero `LineAmount` follows the parent `LineAmountTypes`: Inclusive values
  contain tax, Exclusive values do not. Curated invoice/bank-line measures
  normalize this exactly once. Use `total_line_amount` for ex-tax analysis and
  `*_including_tax` for cash/document value; never add `total_line_tax` again
  to an already tax-inclusive measure.
- Journal `NetAmount` is base currency, debit positive and credit negative;
  statement revenue uses the opposite sign of revenue-account journal sums.
  `GrossAmount` includes tax and is not a P&L measure. Posted manual journals
  also appear in the statutory journal feed, so never union both line sources.
- Contact AR/AP balances are current snapshots in each contact's
  `contact_default_currency`; Xero does not base-convert them. Group or filter
  one currency before summing. Supplier credits can make the contact snapshot
  lower than the sum of open bills without either figure being wrong.
- GST/VAT control accounts are balance-sheet accounts, not profit. Income-tax
  or business-tax costs coded to an expense account do reduce Net Profit. For
  GST/BAS, respect the organisation's GST basis and use Xero's tax/report
  surface; do not infer a BAS from P&L Net Profit.
- `account_type` and `account_class` are official Xero classifiers. Account
  names/codes are user-editable. Reporting codes provide finer meaning when
  present, but vary by country and may be unmapped. Archived accounts remain
  part of historical reports.
- Xero does not publish one universal API EBITDA formula. Do not label a
  derived account-type calculation EBITDA or operating profit. Explain that a
  mapped/custom Xero report is required unless an exact governed formula and
  reporting-code coverage are available.
