# ADR 0047: Manifest-owned connector data-plane policy

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert engineering
- Extends: ADR 0028 (effective scoped source authority), ADR 0041 (Lightspeed supplier integrity), ADR 0042 (atomic connector-pack activation)

## Context

The V1 connector boundary requires source-specific behavior to live in the
connector pack. The generic sync and canonical runtimes still contained eight
exceptions: connector-to-authority maps, Xero's legal-entity default scope,
Lightspeed's legacy Vendor/Order repair, the unchanged ItemShop snapshot rule,
Xero's daily request budget, Deputy's verified-delete envelope semantics,
Xero's source-schema GL-code lookup, and Xero's organisation dossier evidence.

Those branches preserved correct behavior for the initial three sources, but
made a fourth connector a change to shared runtime code. They also allowed the
declarative manifest and the executable behavior to disagree. The one-time
Lightspeed compatibility repair was particularly unsuitable for a generic
module: its SQL and lineage assertions deliberately understand pack 1.0 and
1.1 source records.

## Decision

Connector packs own their data-plane policy through two reviewed mechanisms.

First, `ConnectorManifest` contains declarative, serializable policy:

- every stream declares its source-authority concept;
- authority defaults declare their concepts and either connection-account or
  canonical-dimension scope;
- staging streams may declare that an identical projection in a new immutable
  batch is itself a material observation;
- durable request reservations declare fixed or allowlisted window-budget
  intervals, and response cooldowns declare the headers they interpret; and
- verified webhook tombstones declare the accepted job reason, mandatory
  receipt binding, and immutable payload signal type.

The SDK validates these policies as part of the existing manifest contract.
Concepts must be canonical, stream concepts must have a default, canonical
scope targets must be produced by the pack, rate keys and options must be
bounded, cooldown headers must be explicitly observable, and webhook deletion
policy must remain receipt-bound.

Every stream also declares a non-empty, unique list of exact emitted targets.
This is a closed SDK union of supported canonical dimension/fact tables plus
the special `category_assignment`, `event_link`, `identity_hint`, and
`metadata` outputs. Product-readiness domains are not write targets. The
generic runtime derives the target for every command kind and rejects an
undeclared target before invoking any command-specific executor. Fact commands
must additionally match the exact stream authority concept.

Second, connector-specific executable behavior is exposed through narrow pack
hooks. The Xero pack owns its source-schema natural-key lookup and organisation
dossier evidence collector. The generic pipeline owns canonical ID generation,
target existence checks, contribution validation, tenant transaction scope, and
dossier publication. Connector hooks therefore cannot replace canonical
admission or publish arbitrary control-plane state.

The Lightspeed 1.0-to-1.1 Vendor/Order replay now lives under
`connectors/lightspeed-r`. A small explicit composition registry selects the
hook. The generic canonical pipeline retains the transaction, tenant lock,
capability, mapper, target admission, lineage assertion, canonical write, mart
refresh, invariant, and retry lifecycle. The connector hook receives only
runtime-minted opaque candidate handles. It cannot inspect, replace, or forge a
staging row and receives no canonical-write callback. The generic runtime alone
resolves a handle to its frozen predecessor row, proves exact predecessor pack,
API, schema and source-stream lineage, derives the source job, maps the row, and
checkpoints the candidate after all expected commands are materialised.

Pack hooks never receive the analytical `transform_rw` Postgres client. Each
individual hook registration receives a distinct opaque `CanonicalHookDatabase`
operation port whose operation names,
exact SQL, parameter count, value bounds, connector ownership, and maximum
result cardinality are code-owned in `connectors/canonical-registry.ts`.
Caller-authored SQL, unknown operation names, malformed arguments, and excess
rows fail closed before a hook can use the result. One hook cannot borrow an
operation registered for another hook from the same connector. Tenant and, where relevant,
connection, batch, sync-run, and mapping-version parameters must also equal the
generic runtime's immutable invocation scope. This keeps source-specific
reads and the bounded legacy replay functions reviewable without granting a
pack arbitrary access to tenant data or canonical write functions.

Canonical transform jobs carry the immutable control-plane connection
generation inherited from their sync run. Enqueue and claim require that the
connection still has that generation and is connected or degraded; analytical
capability issuance rechecks the same fence for every replay transaction. The
replay operation port binds eligibility, candidate audit selection, and
checkpointing to that exact generation. Disconnect or reconnect therefore
invalidates an old transform claim instead of allowing an old generation to
repair current canonical state.

Compatibility replay is bounded to one candidate/command-limited analytical
transaction per worker invocation. When more work remains, migration 0064
releases the exact lease back to the durable transform queue without consuming
the bounded failure-attempt budget. The generic runtime computes a SHA-256
progress token from the exact commands and checkpoints made durable in that
transaction. The control plane accepts only non-zero progress, stores cumulative
counts and every per-job token, and rejects a token that has ever appeared for
that job. A legitimate backlog can therefore continue for an arbitrary number
of chunks, while zero or repeated progress enters the normal bounded
retry/failure path rather than hot-looping.

Dossier contributors run once per active connector connection and exact
generation. Their source query must join generation-fenced page evidence, and
each contributor declares the bounded keys it owns. The generic runtime rejects
unowned keys, oversized sources/values/arrays, invalid timestamps, and invalid
confidence or merge values before deterministic dossier assembly.

Generic runtimes consume policy rather than connector IDs:

- canonical facts must carry an explicit mapper-owned authority concept; the
  former table fallback map is removed, and the runtime compares that concept
  to the exact producing stream's manifest authority before any canonical
  version claim or write;
- source exploration derives authority from the exact stream manifest;
- legal-entity and account defaults use the declared scope policy;
- connector natural-key references are dispatched to the active pack while
  canonical identity generation and target validation remain generic;
- source-specific dossier evidence is collected by installed pack hooks and
  merged through a bounded, provenance-required generic contribution contract;
- typed staging reads the stream's identical-batch policy;
- the durable rate budget resolves manifest reservations and rejects an
  option outside the pack's allowlist; and
- webhook tombstone construction reads the manifest policy and verifies that
  the job, manifest, receipt, stream, and source object agree.

`connectors/registry.ts` and `connectors/canonical-registry.ts` are the explicit
composition roots. Importing and selecting installed packs there is allowed;
business conditions in generic runtime modules are not. A static contract test
scans the affected runtime files and permits no installed connector name in the
generic sync or canonical data-plane modules.

## Consequences

- Adding a connector or changing its budgets, snapshot semantics, webhook
  deletion behavior, or source-authority defaults no longer requires a vendor
  branch in shared worker code.
- Manifest review now covers executable data-plane policy in addition to field
  coverage and reconciliation behavior.
- Xero's configured daily tier remains an operator setting, but the accepted
  values and conversion to a durable GCRA interval are owned by the Xero pack.
- Xero's source tables and evidence labels are no longer coupled to the generic
  canonical pipeline; adding another source lookup or dossier contributor does
  not add a branch there.
- Lightspeed compatibility SQL stays visibly coupled to the pack versions it
  repairs, while canonical admission remains inside the generic transaction.
- Executable connector hooks can use only the reviewed operations registered
  for that exact hook; possession of a hook does not confer a general SQL
  capability.
- Fixture and tombstone coverage asserts every command kind is declared by the
  exact stream and every fact agrees with stream authority; negative contracts
  prove wrong targets, wrong authority, forged replay handles, cross-hook
  operations, stale generations, zero progress, and repeated progress fail closed.
- A malformed manifest or unrecognised runtime override fails before a source
  request or canonical write.
- The composition registries are intentionally code-owned and release-bound;
  tenants and source payloads cannot install hooks or mutate policy.

## Alternatives considered

- **Keep the initial three connector branches in generic workers:** rejected
  because it violates the connector-pack boundary and makes future connectors
  changes to shared runtime behavior.
- **Encode the Lightspeed replay as a large generic SQL manifest:** rejected
  because function names, legacy schema identities, and supplier-lineage rules
  are executable compatibility code, not portable configuration.
- **Move transaction and canonical write ownership into each pack hook:**
  rejected because a pack must not bypass tenant locks, authority assertions,
  lineage claims, quality checks, or mart refresh.
- **Accept arbitrary numeric rate overrides:** rejected because a typo or
  hostile configuration could silently exceed a vendor contract.
- **Infer source authority from canonical table names:** rejected because
  authority is concept- and stream-scoped, and the pack mapper already knows
  the meaning of each emitted fact.
