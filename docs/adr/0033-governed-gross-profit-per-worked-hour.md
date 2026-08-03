# ADR 0033: Governed gross profit per worked hour for the flagship employee lens

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert product and semantic platform
- Supersedes: the 46-contract count in ADR 0013; the employee sales-per-hour clarification choice
- Relates to: ADR 0009, ADR 0010, ADR 0015

## Context

The founding worked trace asks what “performed best” means and requires exactly
three choices: net sales, gross profit, or gross profit per worked hour. The
runtime previously offered sales per worked hour as the third choice. Renaming
that choice would be incorrect because the governed metric used net sales as
its numerator and did not require POS line-cost coverage.

Gross profit and worked hours have different facts and grains. Joining order
lines directly to timesheet rows would fan out both measures. Worker labels are
also not stable identity keys, so an employee roster must hand canonical worker
values into the follow-up filter without guessing identifiers from names.

Lightspeed R-Series exposes the necessary line cost and employee attribution
through Albert's pinned manifest as `commerce.order_lines.cost` and
`commerce.order_lines.worker_attribution`. Deputy supplies governed worked time
through `workforce.time_entries`. The calculation is therefore supportable,
but only when all three observed capabilities and canonical identity coverage
are present.

## Decision

The registry adds `composites.gross_profit_per_labour_hour` and advances to
version 1.4.0 with 47 metrics across the existing seven Topics. The contract is:

`operational gross margin / worked hours`

The compiler must execute it only as aggregate-then-align IR:

1. aggregate `commerce.gross_margin` from the sales event fact by canonical
   worker for the requested period;
2. aggregate `workforce.worked_hours` from the workforce fact by canonical
   worker for the same period;
3. `FULL OUTER JOIN` the aggregates on their hidden canonical worker key; and
4. divide the aligned columns with `NULLIF(worked_hours, 0)`.

The metric requires order lines, observed line cost, worker attribution, and
worked-time capabilities. Its result carries aggregate-then-align, cost
coverage, worker-attribution, non-zero-denominator, identity, refund, freshness,
currency, and source provenance evidence through the existing compiler and
semantic validation paths. Missing capability fails closed; Albert must name
the missing capability and must never substitute sales per hour.

Clarification and onboarding surfaces now display exactly “Net sales”, “Gross
profit”, and “Gross profit per worked hour”. The trusted option id resolves the
third choice to the new composite metric. Historical sales-per-hour preferences
remain database-readable for migration compatibility but are ignored by the
semantic default loader and are no longer accepted from the live agent schema.
A user with that historical default is asked the corrected clarification.

Governed result rows expose row-parallel `filterRefs` containing exact canonical
dimension values. They are separate from display rows and are not rendered in
tables. The agent may copy these values into later governed filters and is
explicitly forbidden from guessing an id from a display label.

The compatibility `mart.workforce_sales_aligned` view adds gross margin from
an independently aggregated sales CTE before full-outer alignment with the
labour CTE. Production composite execution continues to compile the two source
facts independently; it does not query or directly join their raw rows.

## Consequences

- The flagship choices and stored defaults match the founding product contract.
- Cost or employee-attribution scope denial makes the productivity lens
  unavailable rather than silently changing its numerator.
- Duplicate worker display names cannot broaden the rostered cohort because
  follow-up filters reuse canonical worker values.
- The denominator guard returns null for a worker with no worked hours; no
  infinity or model-side arithmetic is possible.
- Existing sales-per-worked-hour analysis remains governed for explicit user
  questions such as the V1 location productivity seed, but it is no longer an
  employee-performance clarification choice.

## Verification

- `tests/contracts/flagship-employee-agent-loop.contract.test.ts`
- `tests/contracts/clarification-confirmation.contract.test.ts`
- `tests/contracts/onboarding-defaults.contract.test.ts`
- `evals/m4-m5.test.ts`
- `evals/golden-suite.test.ts`
- `infra/migrations/analytical/0091_m4_flagship_gross_profit_productivity.sql`
- `infra/migrations/control-plane/0052_m6_flagship_employee_performance_lenses.sql`
