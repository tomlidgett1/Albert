# ADR 0011: Canonical capability observations

- Status: Accepted
- Date: 2026-08-03

## Context

The semantic registry, connector manifests, live connector probes, canonical
publisher, and agent tools previously used overlapping but different capability
names. A connector could therefore advertise useful data while a Topic remained
unavailable, or a static manifest could make a metric appear available before
its scopes and observed data supported that claim. Optional metric requirements
were also treated as Topic-level requirements, preventing otherwise answerable
Topics from becoming available.

Capability state must be an auditable observation, not a UI promise. It must
also fail closed when a scope is missing, a governed field has no measured
coverage, or a connector pack reclassifies a field as unsupported or sensitive.

## Decision

Albert uses one version-controlled capability vocabulary in the connector SDK.
The semantic registry consumes the semantic subset of that vocabulary, and CI
asserts exact producer/consumer compatibility. Connector manifests may only
declare vocabulary identifiers and must name the streams and fields that provide
the evidence.

Capability publication has two complementary evidence lanes:

1. A connector publishes its live, source-observed support after a successful
   sync page. This includes support level, explicit reason code, granted or
   missing scopes, and connector-specific observations.
2. The canonical transform publishes field and row coverage from the committed
   governed staging batch. A capability that requires observed coverage is not
   promoted from `unknown` until that evidence exists.

`full` and `partial` are answerable support states. `partial` remains visible to
the semantic and agent layers with its coverage and reason; `unknown` and
`unavailable` fail closed. A later `unknown` live probe cannot erase previously
observed availability, while an explicit `unavailable` observation can revoke
it.

Topics are gated only by their base requirements. Optional metrics retain their
own capability requirements and are rejected by the compiler when selected
without support. This lets every V1 Topic become available when its base data is
present without overstating optional metric coverage.

The capability vocabulary and observations are persisted in the analytical
store with foreign-key and support-state invariants. Connector sync runs also
publish the seven required connector quality checks from run evidence. Missing
evidence is recorded as `warning` or `blocked`; it is never silently converted
to a passing result. Page- and stream-level results are retained separately and
rolled up to the existing run-level quality key using the worst status and a
stable, ordered evidence list. A later successful stream therefore cannot erase
an earlier blocked result from the same run.

Source-field publication is exact-set reconciliation for each connector stream.
Before the new governed set is activated, all prior fields for that source are
transactionally deactivated. Fields removed from the pack or reclassified as
unsupported or sensitive therefore become inaccessible in the same transaction.

## Consequences

- A spelling or naming mismatch between connector producers and semantic
  consumers fails registry validation and CI.
- Availability can be explained to users with source, scope, support, reason,
  coverage, watermark, and pack-version evidence.
- Adding a capability requires updating the canonical vocabulary and declaring
  at least one valid producer before a registry change can ship.
- Connector packs must explicitly retire or reclassify fields; stale allowlist
  rows cannot remain queryable after an upgrade.
- Some capabilities remain unavailable until a real source observation proves
  them, even when the vendor API generally supports the feature.
