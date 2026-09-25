# ADR 0099: Fivetran-landed Xero report is Profit and Loss authority

- Status: Accepted
- Date: 2026-08-18
- Owners: Albert engineering
- Supersedes in part: the Xero P&L native-tool routing in ADR 0097
- Extends: ADR 0089, ADR 0095, ADR 0096

## Context

V3 exposed `xero_finance_analytics.pnl_net_profit` from a derived union of
invoice lines, bank-transaction lines, credit-note lines and posted *manual*
journals. Its own contract admitted that Xero's system payroll and fixed-asset
journals were absent. The resulting number omitted wages, employer super and
automatic depreciation while being titled "Net profit". A prompt caveat could
not make that numerical contract safe.

Xero documents that journal `NetAmount` is base-currency, debit-positive and
credit-negative, and that payroll creates P&L expense debits plus balance-sheet
liability credits. Xero also recommends its Reports API instead of reconstructing
statements from individual documents. Albert's Fivetran Connector SDK already
lands Xero's standard-layout monthly ProfitAndLoss rows, including Xero's own
Gross Profit and Net Profit formula rows.

Authoritative references:

- [Xero Reports API](https://developer.xero.com/documentation/api/accounting/reports)
- [Xero Journals API](https://developer.xero.com/documentation/api/accounting/journals)
- [Xero Accounts API](https://developer.xero.com/documentation/api/accounting/accounts)
- [Xero account types and journal source codes](https://developer.xero.com/documentation/api/accounting/types/)
- [Xero business-health formulas](https://central.xero.com/0/article/About-business-health-calculations-in-Analytics-powered-by-Syft)
- [Xero Analytics widget formulas](https://central.xero.com/s/article/About-Cards-in-Analytics-powered-by-Syft)
- [Xero Pay Run Journal](https://central.xero.com/0/article/Review-payments-using-the-Pay-Run-Journal)

## Decision

1. `source_xero_official.xo_profit_and_loss_lines` selects only the newest
   Fivetran report snapshot for each tenant, basis and monthly period. This
   prevents renamed/removed report lines from surviving an upsert-only refresh.
2. `xo_profit_and_loss_periods` emits one row per month and basis. Xero's own
   formula rows are the authoritative Gross Profit and Net Profit. Leaf account
   rows are classified by Xero `Account.Type`, with the standard report section
   used only when a formula/FX-group row lacks an account mapping.
3. The governed definitions follow Xero's published taxonomy:
   - sales revenue: `REVENUE` + `SALES`;
   - other income: `OTHERINCOME`;
   - cost of sales: `DIRECTCOSTS`;
   - operating expenses: `EXPENSE` + `OVERHEADS` + `DEPRECIATN`;
   - total income: sales revenue + other income;
   - total expenses: cost of sales + operating expenses;
   - Gross Profit: sales revenue - cost of sales;
   - Net Profit: total income - total expenses;
   - margins divide by sales revenue, not total income.
4. Wage semantics use Xero reporting codes, never editable account names.
   `EXP.WAG`/`EXP.EMP.WAG` are operating wages; `EXP.COS.WAG` is direct-cost
   labour. Both reduce Net Profit, but only direct wages reduce Gross Profit.
   `WAGEPAYABLES` is a balance-sheet liability and never a P&L expense.
5. `xero_profit_and_loss_analytics` is the headline monthly accrual view.
   `xero_profit_and_loss_account_analytics` contains leaf account rows only for
   rankings/drill-down, preventing account plus subtotal double counting.
6. V3 no longer routes P&L/Net Profit to the legacy live statement tool. The
   Fivetran-landed Xero report is queried through CubeCore like every other V3
   governed source. Balance Sheet and Trial Balance keep their native route
   until their currently empty Fivetran report tables have production data and
   equivalent deterministic qualification.
7. The old `xero_finance_analytics.pnl_*` members remain queryable only for
   backward-compatible replay. Cube publishes `meta.aiHidden`; V3 retains them
   for validation/provenance but removes them from catalogue search and hydrated
   model schemas. Their titles/descriptions also mark them as partial.
8. The default qualified view is accrual basis. Cash and accrual are never
   combined. A cash-basis view will not become public until Fivetran has live
   cash rows and a separate reconciliation gate.
9. Report data is monthly and bounded by the connector's retention window.
   Current-month figures are month-to-date through `report_updated_at`, despite
   a month-end `period_end`. Arbitrary day ranges and older periods must return
   an honest limitation rather than a partial statement.
   Certified-query phrases such as "this financial year" resolve to explicit
   Australian FY start/end dates before Cube execution.
10. EBITDA is not inferred. Xero publishes no universal Accounting API EBITDA
    formula, and its custom report templates are organisation-specific. A future
    EBITDA measure requires explicit report-code coverage and its own governed
    definition.

## Consequences

- Wages, super and automatic depreciation reduce Net Profit exactly once.
- A payroll liability credit cannot be mistaken for another wage expense.
- Gross Profit remains distinct from Net Profit and ordinary operating wages do
  not silently contaminate Gross Margin.
- Xero report results carry organisation base-currency, basis, period and
  freshness definitions in Cube metadata and evidence.
- P&L account rankings reconcile to the Xero statement instead of invoice/bill
  document totals.
- The monthly report cannot answer day-level P&L or periods outside retention;
  those are explicit capability limits.

## Verification

- `infra/migrations/analytical/0173_m5_xero_authoritative_profit_and_loss.sql`
- `cube-playground/model/cubes/xero_reports.yml`
- `cube-playground/model/views/xero_profit_and_loss_analytics.yml`
- `cube-playground/agents/rules/xero-accounting-semantics.md`
- `tests/contracts/xero-cubecore-semantic.contract.test.ts`
- focused V3 Luna Max, standard-tier Xero P&L evaluation corpus
