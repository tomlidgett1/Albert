# Xero Profit and Loss semantic evaluation — Luna Max

- Date: 2026-08-19 (Australia/Melbourne)
- Runtime: current Albert V3 engine from this worktree
- Model: `gpt-5.6-luna`
- Owner preference: `reasoningEffort: max`
- OpenAI service tier: `default` (standard processing)
- Fast mode: `false`
- Semantic runtime: pinned CubeCore `1.7.16`
- Ingestion contract: Albert Fivetran Connector SDK Xero report rows

## Purpose

Regression-test the failure where the legacy document-union member called Net
Profit omitted Xero system payroll journals and therefore failed to deduct
wages. These tests exercise V3 query selection and owner-facing answers, not
only SQL arithmetic.

## Exact accounting fixture

| Xero P&L line | Amount |
| --- | ---: |
| Sales revenue (`REVENUE`) | $1,000 |
| Cost of sales (`DIRECTCOSTS`) | $300 |
| Wages and Salaries (`EXP.EMP.WAG`) | $200 |
| Rent (`OVERHEADS`) | $100 |
| Depreciation (`DEPRECIATN`) | $50 |
| Xero Gross Profit | $700 |
| Xero Net Profit | $350 |

Expected invariants:

- total expenses = $650;
- wages reduce Net Profit exactly once;
- Net Profit before mapped wages = $550;
- Gross Margin = 70%;
- `WAGEPAYABLES` is a liability and cannot affect P&L;
- account rows and Xero formula rows are never summed together.

## Live V3 model cases

Four real Responses API turns ran through `runAlbertV3Turn` with Luna Max and
standard processing against the pinned local Cube runtime and PostgreSQL
fixture.

| Case | Required result | V3 result |
| --- | --- | --- |
| Accrual Net Profit for July; did it include wages? | `$350`, explicitly wage-inclusive | Passed; `Verified`; queried only `xero_profit_and_loss_analytics` |
| Wage impact and before-wage scenario | `$200` wages and `$550` before mapped wages | Passed; queried only `xero_profit_and_loss_analytics` |
| Gross Profit and margin | `$700` and `70%` | Passed; queried only `xero_profit_and_loss_analytics` |
| Expense accounts ranked | Purchases, Wages and Salaries, Rent, Depreciation in descending value | Passed; `Verified`; queried only `xero_profit_and_loss_account_analytics`; attached table contained the full ranking |

Every case rejected `xero_finance_analytics` as a P&L source. The fourth case
was rerun with a table-aware assertion because the concise prose named only the
two leading accounts while the full ranking correctly lived in the attached
table.

## Current Fivetran production-data proof

A read-only query applied the same account-type and latest-snapshot rules to the
current live tenant's landed Xero report rows:

| FY2026-27 through current report month | Amount |
| --- | ---: |
| Report months | 2 |
| Total income | $56,489.79 |
| Total expenses | $55,149.81 |
| Mapped wages | $21,128.80 |
| Mapped employer super | $2,535.45 |
| Xero Net Profit | $1,339.98 |
| Net Profit reconciliation variance | $0.00 |

This proves the live source data contains the wages the old Cube member omitted.
It does not prove production deployment of the new model.

## Deterministic and compilation gates

- Migration 0173 executed successfully on PostgreSQL 17 with a stale-snapshot
  row and the fixture above; both report views were created and every assertion
  passed.
- CubeCore 1.7.16 compiled both public Xero P&L views and returned the exact
  fixture values through `/cubejs-api/v1/load`.
- Focused contract suite: 78 tests, 76 passed, 2 intentional live-schema skips,
  0 failures.
- Agent configuration generation and `git diff --check` passed.
- The provider-settings contracts prove Luna + literal `max` + `default` tier
  + non-Fast and reject aliases, Fast and Pro.
- Certified-query fiscal language is normalized to explicit Australian FY
  dates; `this financial year` and `last financial year` are contract-tested.
- Invoice and bank-line Inclusive/Exclusive values are normalized exactly once
  into separate ex-tax and tax-inclusive measures with source currency/basis.
- Legacy `pnl_*` remains query-valid for saved replay but carries `aiHidden`;
  a real Cube metadata check proved it is absent from model schemas.
- `npm run verify:xero-pnl-production` is the fail-closed post-release gate for
  migration checksum, Cube members, wage/account reconciliation and legacy
  visibility behavior.

## Production gate still open

At the time of this report:

- production analytical migration ledger ends at `0172`;
- production Cube metadata does not expose
  `xero_profit_and_loss_analytics` or
  `xero_profit_and_loss_account_analytics`;
- local `.env.local` has no `ANALYTICAL_MIGRATION_URL`, and the migration runner
  correctly rejects the broader admin login.

Production qualification must therefore be repeated after migration 0173 is
applied with `albert_analytical_deployer` and the protected Cube release is live.
