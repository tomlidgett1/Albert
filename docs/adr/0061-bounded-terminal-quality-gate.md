# ADR 0061: Bounded terminal quality gate

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert platform
- Related: ADR 0058 (set-based transform pages and terminal quality gates),
  Albert v1 sections 11 and 17

## Context

Moving tenant-wide quality work to cursor-complete pages removed it from the
backfill hot path, but a live terminal page still spent 34.7 seconds inside
`quality.run_all_invariants`. Two query shapes accounted for most of that
time.

Tender reconciliation correlated every completed order with
`core.commerce_payment`. PostgreSQL does not automatically index foreign-key
columns, so the query scanned the tenant's payment table once per order. On
the dogfood tenant, one check touched 2.4 million payment buffers and took
11.0 seconds for 7,787 eligible orders.

POS-to-ledger quality read `mart.reconciliation_aligned` twice. Its POS branch
regrouped `mart.commerce_sales_event` from canonical facts even though
`mart.sales_day_location` is refreshed transactionally from the same governed
measure before terminal quality runs. Each rebuild took about 7.4 seconds.

## Decision

1. Index payments by `(tenant_id, order_id, status)` and include `amount`, so
   the terminal tender aggregate is a bounded tenant-and-order lookup.
2. Build the POS branch of `mart.reconciliation_aligned` from
   `mart.sales_day_location`, retaining the existing day/location grain,
   finance branch, security-barrier behavior, columns, and identifier rule.
3. Keep terminal quality fail-closed and synchronous. This change reduces the
   cost of deriving its evidence; it does not weaken, cache, or skip a check.

## Validation

Before replacement, the proposed day-mart view and the existing event-derived
view produced 689 rows each for the live Lightspeed tenant, with zero rows in
either direction of an `EXCEPT` comparison. The migration is remeasured using
the complete invariant function, not only isolated query plans.

## Consequences

- Ordinary transform pages remain unaffected and terminal pages no longer
  repeatedly scan all payments or rebuild the POS event aggregate.
- Reconciliation depends explicitly on the governed day-mart refresh that
  already precedes terminal quality in the same canonical transaction.
- The payment index also bounds other order-scoped payment lookups while
  retaining tenant-first isolation.
