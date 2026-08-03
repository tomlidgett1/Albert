# ADR 0013: Deterministic POS-to-bank settlement evidence

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Complements: ADR 0005 and the M4 governed reconciliation contract

## Context

Albert must answer reconciliation questions such as whether POS tenders agree
with bank receipts. A POS payment and a bank transaction are different business
events: batching and processor delays can move a receipt to a later date, while
fees, refunds, cash handling, and partial deposits can change its amount. An
amount-only or same-day join would manufacture evidence, double count ambiguous
candidates, and make a numerical answer look more certain than its sources
allow.

The semantic layer also needs to retain the seven V1 governed Topics. Adding a
new user-facing Topic solely to expose the bridge would duplicate the existing
reconciliation surface and make cross-source logic available outside its
governed composite path.

## Decision

### Settlement matching is conservative, deterministic, and durable

The canonical refresh pipeline rebuilds settlement evidence for the changed
window plus a bounded seven-day lookback. It groups eligible captured or
refunded POS payments and positive posted, paid, authorised, or reconciled bank
transactions by tenant, resolved location, currency, and business date.

A bank group is linked to a POS group only when all of the following hold:

- the canonical location identity and currency agree;
- the bank date is on or after the tender date and no more than seven days
  later;
- the absolute amount difference is within the configured tolerance; and
- each group is the other's unique best candidate after deterministic ranking.

Successful matches are recorded as append-only `settlement_of` event links
from bank transactions to their component POS payments, with the matching rule,
window, amounts, dates, tolerance, and sync run in the evidence document.
Ambiguous or partial matches are not linked. In particular, a coincidental
amount is never treated as proof of settlement.

### The reconciliation mart separates links from observations

`mart.settlement_reconciliation_aligned` exposes linked delayed settlements at
the originating tender date. It also retains an unlinked same-day bank
observation as qualified evidence so Albert can report a visible shortfall,
such as $165 of Tuesday tenders against $150 received, without asserting that
the bank row settles those tenders. Every row states its evidence status and
linked and eligible tender counts.

The semantic registry adds governed tender and POS-to-bank variance metrics to
the existing reconciliation Topic. A composite query may use a single-fact
component subquery only inside that governed composite Topic; ordinary Topics
retain their one-fact boundary. Runtime validation measures settlement-link
coverage for the requested slice. Incomplete coverage qualifies the answer and
surfaces a warning rather than silently verifying it.

This explicitly supersedes the founding specification's initial 44-contract
count with a 46-contract registry: `commerce.tender_amount` and
`composites.pos_to_bank_variance` are the two additions. They are required to
keep captured tender distinct from order value and to keep variance arithmetic
inside deterministic software. Generated registry documentation remains the
source of truth for counts; the seven-Topic boundary is unchanged.

ADR 0033 subsequently supersedes the count, but not this settlement decision,
by adding the flagship `composites.gross_profit_per_labour_hour` contract.

Currency is never converted implicitly. A request that would aggregate more
than one currency fails closed unless currency is part of the result grain.

## Consequences

- Exact delayed settlements can be traced from a displayed variance to durable
  canonical event-link evidence.
- Same-day shortfalls remain answerable, but their unlinked nature is explicit
  and the answer state cannot be `Verified`.
- Ambiguous, fee-netted, split, or many-day settlements remain unlinked until a
  connector supplies stronger evidence or a later matching rule is separately
  reviewed and versioned.
- Reconciliation refresh and quality gates must run after canonical and mart
  refreshes. Nightly reconciliation sweeps provide a bounded repair path for
  late-arriving source data.
- The V1 public surface remains seven governed Topics; the settlement bridge is
  an evidence and fact boundary, not an eighth Topic.

## Alternatives considered

- Join POS and bank rows by date and amount: rejected because processor delays
  and non-unique amounts create false links.
- Treat every same-day bank observation as a settlement: rejected because it
  confuses a useful comparison with source-backed lineage.
- Use fuzzy many-to-many allocation in V1: rejected because allocation choices
  cannot be justified without processor batch identifiers, fee schedules, or
  reviewed user mappings.
- Add a dedicated settlement Topic: rejected because the existing governed
  reconciliation Topic is the correct user-facing boundary.
