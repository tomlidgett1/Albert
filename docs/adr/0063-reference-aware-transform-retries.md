# ADR 0063: Reference-aware transform retries

- Status: Accepted
- Date: 2026-08-05
- Owners: Albert platform
- Related: ADR 0027 (progressive readiness), ADR 0058 (set-based transform
  pages), ADR 0060 (immutable transform input envelopes), Albert v1 sections
  10, 17, and 18

## Context

Lightspeed refunds can be returned before the page containing their original
sale line has transformed. Extraction is complete and every immutable page is
already queued, but page order follows vendor modification order rather than
canonical parent-before-child order.

`canonical_reference_missing` previously used the ordinary twelve-attempt
failure budget with a fifteen-second delay. A child page could exhaust that
budget while valid parent pages were still in the same stream backlog. The
overnight dogfood run ended with 33 such sales batches dead-lettered even
though every required parent existed in the durable backlog.

## Decision

When a lease-fenced transform reports `canonical_reference_missing`, the
control plane checks the same tenant, connection generation, stream, and
mapping version for ordinary queued or retrying sibling pages.

- While ordinary siblings remain, the child is returned to `retry_wait`, the
  claim-time attempt increment is compensated, and the delay is at least
  thirty seconds.
- Siblings already waiting on the same missing-reference condition do not keep
  each other alive indefinitely.
- Once the ordinary sibling backlog is empty, the normal bounded retry budget
  resumes. A genuinely absent reference therefore still fails closed and
  blocks readiness.

The lookup uses a tenant-first partial index over active stream backlog. No
raw or canonical data is inspected by the control plane.

## Consequences

- Valid out-of-order parent/child pages wait for deterministic dependencies
  without being mislabeled as failed transforms.
- Broken references remain bounded and visible after the backlog drains.
- The transform worker protocol and code-only error contract are unchanged;
  dependency waiting is decided at the durable queue boundary where sibling
  state is authoritative.

