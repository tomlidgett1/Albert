# 0106 — Xero dashboard parity and API-budget discipline

Date: 2026-08-19
Status: Accepted

## Context

Tom's live Xero dashboard is the source of truth for Albert's accounting
answers. A battery of plain-language questions ("what do we owe suppliers",
"how much cash came in and went out over the last six months", "show me the
balance sheet") run against production on 2026-08-19 found three classes of
mismatch:

1. **Stale contact snapshots.** "What do we owe / what is owed to us" used
   `xero_contacts` balance snapshots (`total_payable_outstanding` 22,487 vs
   Xero's 5,276; receivables 2,000 vs 500). Fivetran refreshes a contact row
   only when the *contact* changes, so balances never move when invoices are
   paid.
2. **Cash in and out.** Xero's "Cash in and out" tile is bank transactions
   **plus** invoice/bill/refund payments, transfers between own accounts
   excluded. Albert summed bank transactions only (and on another pass added
   transfers), and read "last 6 months" as Cube does (six complete months
   before this one) rather than as Xero and the owner do (six calendar months
   including the current one).
3. **Live statements unavailable.** Balance sheet, trial balance and bank
   balances all returned "Xero could not produce that". The root cause was
   not the MCP: the organisation's Xero allowance (1,000 calls/day for this
   uncertified app) was exhausted. Albert's Fivetran SDK connector synced
   hourly at ~130 calls per run — 49 endpoint groups plus twelve Payroll AU
   endpoints that answered 5xx on every run and were retried six times each
   (~70 wasted calls/hour). The same allowance serves the live report tools
   and the connector's own Reports refresh, so the balance-sheet / bank-
   summary / trial-balance tables had never landed and the prior-year P&L
   window was missing.

## Decision

**Semantic layer (Cube, deployed to `albert-cube`).**

- `xero_cash_movements` cube: `xo_bank_transactions` (non-transfer, not
  DELETED) UNION `xo_payments` (not DELETED), direction fixed per row
  (RECEIVE*/ACCRECPAYMENT/AP*refunds = Cash in; SPEND*/ACCPAYPAYMENT/AR*refunds
  = Cash out). Exposed in `xero_finance_analytics` as `cash_in`, `cash_out`,
  `net_cash_movement`, `cash_date`, `cash_bank_account`, `cash_source`.
  Reproduces Xero's tile to the cent (Mar–Aug 2026: 274,097.79 / 291,791.57;
  July 67,025.91 / 56,078.51).
- Headline AR/AP measures on the invoice grain (`payable_outstanding`,
  `payable_overdue`, `payable_open_count`, `payable_overdue_count`,
  `receivable_*`, `draft_bills_total`, `submitted_bills_total`, …). The
  contact snapshot totals are kept for per-contact ranking but `ai_hidden`.
- Recipes rewritten to the new members; new `recipe-payables-by-supplier` and
  `recipe-receivables-by-customer` so "who do we owe" names suppliers.
- Analytical migration 0175 + cubes/views `xero_balance_sheet_analytics`,
  `xero_bank_balances_analytics`, `xero_trial_balance_analytics` over the
  Fivetran-landed Balance Sheet / Bank Summary / Trial Balance reports, so
  month-end positions and "balance in Xero" per bank account are answerable
  from the warehouse and are the fallback when the live tool is rate-limited.

**Engine.** "last N months" is resolved in code (`resolveLastMonthsRange`) to
the N calendar months ending with the current partial month, and `todayLine`
states the convention for every lane.

**Connector (`connectors/xero-fivetran-sdk`, package `sleet_dynamite`).**

- Schedule 180 min (new Xero SDK connections default to 180 in
  `fivetran-http.ts`).
- `SERVER_ERROR_ATTEMPTS = 3` for 5xx/timeouts (was 6).
- Per-endpoint circuit breaker in Fivetran state: an unavailable (401/403/404)
  group is re-probed after 24 h, an erroring group after 6 h doubling to 24 h.
- `XeroClient` tracks `X-DayLimit-Remaining` on every response and refuses to
  spend below `xero_daily_reserve` (200) plus `xero_reports_headroom` (60)
  while a Reports refresh is due; the walk stops cleanly
  (`BudgetReserveReached` ⊂ `DailyLimitReached`) and the Reports step still
  runs within its headroom. Reports run per-step resilient and record
  `state.reports.last_summary`.

## Consequences

- Dashboard-tile questions (bills to pay, invoices owed, cash in/out, net
  profit FYTD, last-12-month income/expenses, operating expenses) now match
  Xero exactly; the only residual difference is sync freshness.
- Xero data is at most ~3 h old instead of ~1 h; in exchange the live balance
  sheet / bank balances keep ≥200 calls/day and the statements land.
- Payroll AU endpoints still return 5xx for this organisation; they now cost
  ≤36 calls per day instead of ~1,700. Diagnosing the 5xx is follow-up work.
