# ADR 0067: Preserve originating canonical-link lineage

## Status

Accepted.

## Context

Canonical rows carry the `sync_run_id` that first materialised their stable
identity. `core.protect_canonical_sync_run()` rejects later attempts to rewrite
that origin. Incremental dimension transforms correctly preserved this field on
the dimension itself, but the direct `core.entity_source_link` upsert replaced
`sync_run_id` on conflict. Re-observing an employee, customer, location, or
product in a later sync therefore rolled back the whole transform with
`canonical row lineage is immutable`.

## Decision

Direct entity-link inserts continue to record the creating sync run. Conflict
updates may refresh mutable link evidence, status, confidence, canonical target,
and validity, but must not replace `sync_run_id`. Both the set-based page path
and the sequential compatibility path follow this rule.

The worker maps the database trigger message to the bounded permanent code
`canonical_lineage_immutable`; raw exception text remains outside durable queue
evidence.

## Consequences

- Incremental source observations update stable entity links without violating
  their original lineage.
- Retry queues no longer churn on a deterministic data-lineage violation.
- The immutable origin remains auditable while current payload and mapping
  evidence can advance.
