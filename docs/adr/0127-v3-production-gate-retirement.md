# ADR 0127: Retire superseded architecture tests from the V3 production gate

- Status: accepted
- Date: 2026-08-25
- Depends on: ADR 0105, ADR 0110

## Context

V3, Cube and the Analytics raw/source views are the production source of
truth. Analytical migrations 0157 and 0158 removed the canonical `core`/`mart`
layer. The isolated semantic-query promotion relay and Semantic Execution V2
production path are also retired.

The contract runner still discovered test files that imported those deleted
services and tables. They failed before exercising current code and prevented
the protected release gate from reporting failures in the V3 runtime that is
actually deployed.

## Decision

Remove only contract files whose complete subject is a retired architecture:

- canonical replay and Lightspeed canonical supplier replay;
- canonical quarantine recovery;
- the semantic-query promotion relay;
- Semantic V2 persistence, production authority, waiver and snapshot receipt.
- the pre-V3 Agents SDK factory and `createLiveAlbertAgent` helper contracts.
- the removed Admin architecture-map/plan-preview and retired transform or
  semantic-query runtime readiness checks.
- pre-V3 canonical connector mappers and the removed V1 large-result
  summarizer contract.
- Semantic-query V1 quality and canonical snapshot worker assertions; current
  manifest, ingestion and analytical SQL gates remain.
- post-migration SQL harnesses whose only target was a removed `core` or
  canonical table. Current source-staging RLS, deletion capability,
  reconciliation and connector-activation SQL remains in CI.
- the V1 `quality.run_all_invariants` SQL harness removed with the canonical
  quality runner; current ingestion and connector-quality contracts remain.
- the canonical pipeline-snapshot attestation harness whose snapshot function
  was explicitly dropped by analytical migration 0157.
- the durable canonical reconciliation-finding harness and its historical
  migration contract, whose materialiser reads the `mart` schema removed by
  analytical migration 0158. Current source reconciliation lifecycle and
  connector-quality gates remain in CI.
- control-plane Semantic V2 review/qualification and semantic-query promotion
  relay SQL, whose services and customer path are retired.
- the progressive canonical-transform dependency SQL harness. Its complete
  subject is the retired transform worker and `canonical_transform_jobs` path;
  current raw landing, sync lifecycle and V3 source-readiness gates remain.

Do not blanket-exclude failing tests. V3 routing, Cube, connector ingestion,
security, release authority, deletion, Swarm and Codex contracts remain in the
normal test discovery path and must be fixed when they drift.

## Consequences

- CI no longer treats the absence of deliberately deleted services as a
  regression.
- Historical migrations and ADRs remain immutable evidence; this decision
  removes obsolete executable tests, not history.
- Any future replacement for a retired capability needs a new V3 contract and
  an explicit architecture decision.
