# ADR 0064: Record-scoped canonical reference isolation

- Status: Accepted
- Date: 2026-08-05
- Owners: Albert platform
- Supersedes: ADR 0063's terminal handling for deterministic source references
- Related: ADR 0029 (quarantine and replay), ADR 0059 (immutable batch
  quarantine lineage), ADR 0060 (immutable transform input envelopes), ADR
  0063 (reference-aware transform retries), Albert v1 sections 11, 17, and 18

## Context

A canonical transform page commits in one database transaction, while a typed
source row is the established atomic mapping and quarantine boundary. The
Lightspeed backfill exposed a conflict between those two boundaries: one
refund with an unavailable original sale line caused PostgreSQL to reject the
whole transaction. Valid peer sales, including sale lines needed by other
refunds, rolled back with it.

Retry ordering could not break this closed dependency set. Sixty unavailable
parents were present in immutable staging, but some shared a page with a
refund that depended on another unavailable parent. The page could neither
publish its valid parents nor become independent of those parents by waiting.

## Decision

Before executing canonical commands, the transform pipeline performs one
set-based existence lookup for every deterministic, non-nullable source
reference in the page.

1. A reference is eligible when its canonical row already exists or an active
   command in the same transaction produces its deterministic canonical ID.
2. A typed source row with any other required reference is removed from the
   command set and recorded through the existing immutable quarantine seam
   with path `$projection` and code
   `canonical.canonical_reference_missing`.
3. The active command set is recomputed to a fixed point. Removing a producer
   therefore also isolates dependants that would otherwise rely on that
   producer; no hidden batch rollback remains.
4. Valid peer rows commit, including same-page parents ordered before their
   children. Exact immutable batch replay later heals quarantined rows when
   their references become durable.
5. A genuinely absent parent remains an explicit, qualified quarantine and a
   canonical quality warning. It does not disguise the valid portion of a
   completed backfill as an eternally failed transform job.

Connector-owned lookup references still use ADR 0063's bounded dependency
retry barrier because their resolution is not a deterministic canonical-ID
existence check.

## Consequences

- One malformed historical refund cannot roll back unrelated sales or create
  a dependency deadlock across pages.
- Reference admission costs a bounded query per referenced canonical table,
  not a network round trip per row.
- Quarantined omissions remain exact, durable, auditable, and replayable from
  immutable staging and raw lineage.
- Terminal readiness distinguishes qualified data quality from operational
  incompleteness: all transform jobs can finish while the warning remains
  visible until a later replay heals it.
