# ADR 0065: Set-based capability-aware domain invariants

- Status: Accepted
- Date: 2026-08-05
- Owners: Albert platform
- Related: ADR 0058 (set-based transform pages and terminal quality gates),
  ADR 0061 (bounded terminal quality gate), Albert v1 sections 11 and 17

## Context

The terminal quality gate runs as `transform_rw` under a signed tenant
capability and forced row-level security.  A production-equivalent profile of
the Lightspeed backfill found that `quality.run_domain_invariants` consumed
77.4 of the 91.3 seconds spent in `quality.run_all_invariants`.

The invariant was logically tenant-scoped but physically correlated.  It
recalculated line totals once per order, performed two anti-lookups once per
order and order line, and resolved effective authority once per payment and
refund.  The line-observation check alone touched more than 3.2 million cached
buffers and took 45.3 seconds.  Even empty terminal source pages consequently
spent about 100 seconds validating canonical history.

Benchmarking as the migration owner understated this cost.  The runtime role,
signed capability, and forced-RLS path are part of the performance contract and
must be represented in profiling.

## Decision

1. Materialise each tenant-scoped observation, canonical-state, line-total,
   and effective-authority relation once inside the invariant invocation.
2. Reconcile facts through set joins and grouped aggregates.  Do not use a
   correlated lateral aggregate or per-fact observation/authority function
   call for a tenant-wide quality gate.
3. Preserve fail-closed semantics.  Effective authority still requires
   exactly one active interval and the exact canonical-state connection;
   missing state, duplicate authority, or a different authority owner fails.
4. Validate equivalence and latency through the real transform runtime with a
   signed capability and forced RLS, not through an owner-only shortcut.
5. Keep the gate synchronous and terminal-only.  The optimisation changes how
   evidence is derived, never which evidence is required.

## Validation

Against the live dogfood tenant, the five replaced query shapes returned the
same counts as the superseded function: 36,657 order-header failures and zero
missing order, line, payment, or refund observations.  Their combined runtime
fell from approximately 75 seconds to 2.37 seconds.  The largest individual
query fell from 45.3 seconds to 0.69 seconds.

## Consequences

- Terminal quality cost grows with tenant rows rather than multiplying rows by
  correlated lookups.
- Forced-RLS runtime behaviour is explicitly covered by the operational
  performance proof.
- Mandatory failures remain visible.  Faster evaluation does not turn the
  existing line-maths failure into a pass; canonical correctness must be
  repaired separately before complete readiness can be asserted.
