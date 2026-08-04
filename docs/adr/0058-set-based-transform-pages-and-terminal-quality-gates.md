# ADR 0058: Set-based transform pages and terminal quality gates

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert platform
- Related: ADR 0056 (multi-page InitialBackfill claims), ADR 0057
  (bounded identity candidate generation), Albert v1 sections 11 and 17

## Context

The first large Lightspeed dogfood backfill exposed two costs hidden by small
fixtures. A 100-row page issued hundreds of independent PostgreSQL commands
for reference checks, version claims, typed upserts, authority checks, source
observations, identity evidence, and quarantine healing. Even with Fly and the
analytical database in Tokyo, network latency dominated the application CPU.

After removing that round-trip amplification, tenant-wide work became visible.
`quality.run_all_invariants` scans every canonical grain and grew to roughly
6.2 seconds while it was still being called after every page. Pipeline-stat
snapshots and dossier generation were also per-page even though the product
contract defines them as post-sync and hourly projections. Inventory pages
additionally rebuilt sales/labour marts and settlement links they cannot
affect.

## Decision

1. Group independent dimension and fact commands by canonical table and typed
   value shape after dependency ranking. Resolve deterministic references in
   bounded table lookups, then execute version claims and typed upserts from
   JSON recordsets.
2. Preserve source-authority semantics for facts. Effective-dated authority
   installation and assertion execute set-wise before writes; stock-location
   scopes resolve in one bounded lookup. Order and line observations remain in
   the same transaction.
3. Batch direct source links, category assignments, identity observations, and
   quarantine healing. A duplicate canonical identity in one SQL conflict set
   falls back to the original ordered path.
4. Refresh derived state only when a page changed one of its inputs. Inventory
   pages materialize calendar dates but do not rebuild sales/labour day marts
   or POS-to-bank settlement links.
5. Treat global invariants and readiness as post-sync release gates. Durable
   connector-page `cursorComplete` evidence triggers the full invariant scan,
   readiness projection, pipeline-stat snapshot, and dossier refresh.
   Intermediate pages remain fenced by database constraints, reference checks,
   version ordering, source authority, and canonical mapping-quality evidence.
6. Keep the independent hourly pipeline-stat maintenance lease required by the
   specification. Terminal gating changes execution cadence, not evidence
   semantics or the visibility of a completed sync.

## Consequences

- Database round trips scale with the number of command shapes and referenced
  tables, rather than with source-row or nested-fact count.
- Global quality evidence observes the complete sync boundary instead of an
  arbitrary prefix. Intermediate transform results are deliberately marked
  `blocked` until terminal quality evidence exists; they do not publish a
  readiness transition.
- Terminal pages are slower than intermediate pages because they pay the
  governed release cost once. A missing or malformed terminal-page evidence
  row fails closed.
- All batching remains connector-neutral and tenant-local. RLS, capability
  fencing, immutable lineage, source ownership, and transaction rollback
  behavior are unchanged.
