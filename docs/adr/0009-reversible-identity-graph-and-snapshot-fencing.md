# ADR 0009: Reversible identity graph and semantic snapshot fencing

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Supersedes: physical cross-source merge projection implied by section 11 of the V1 specification

## Context

Albert must let a human confirm and later reverse worker, location, product,
customer, and supplier matches. Facts can continue arriving while a match is
active. A physical rewrite of a source record's current `entity_source_link`,
or resolving a fact foreign key while it is ingested, loses the source-native
identity of facts written after the merge. Reversing the decision would then
require an error-prone replay of raw history and could not be atomic with live
queries.

The V1 specification describes user-confirmed, effective-dated source links and
requires every merge to be reversible. That representation is safe for manual
correction of a source record's native canonical target, but it is not a safe
representation of a cross-source equivalence relation. Equivalence is also
transitive: after confirming A-B and B-C, reversing A-B must leave B-C intact.

Semantic bundle hashes previously pinned the registry, tenant overlay, pack
versions, source watermarks, and IR, but not the identity interpretation used
to group rows. A decision could therefore race a query and let results computed
under graph V2 be audited or cached under a V1 bundle.

## Decision

### Preserve native anchors

- `core.entity_source_link` always maps one vendor record to its deterministic,
  source-owned canonical entity. Canonical fact foreign keys retain that same
  native ID, before and after a human match.
- A later source sync may refresh or tombstone its native link, but it never
  materialises a cross-source representative into a dimension or fact.
- The first decision for a review task captures the exact current native links
  in `semantic_internal.identity_link_baseline`. Historical rows are not
  eligible. Later versions must still reference those baselines, so a stale
  card cannot overwrite a genuine source remap.

### Represent human decisions as a tenant-local graph

- `core.entity_identity_edge` stores the current versioned decision for each
  review task. `semantic_internal.identity_decision_history` is append-only and
  retains every accepted, rejected, or proposed version and actor.
- Accepted edges form an undirected graph per tenant and entity type.
  `core.entity_resolution` is rebuilt transactionally from its connected
  components; the lexicographically smallest native ULID is the deterministic
  representative. Rejection or undo removes only that task's effective edge,
  so unrelated and transitive confirmations remain intact.
- The control plane records decisions and a leased projection outbox in one
  transaction. Commands for the same task cannot overtake an earlier version.
  The transform worker applies the analytical decision idempotently and marks
  the UI projection applied only after the data plane commits.
- Identity projection and deletion share the tenant deletion advisory lock.
  Projection deletes every tenant result-cache entry before commit. Connection
  deletion clears graph edges, resolutions, baselines, history, and graph state.

This deliberately narrows the specification's `user_confirmed`
`entity_source_link` mechanism to correction of a native source mapping. A
cross-source merge is instead superseded by a new immutable decision-history
row and a new effective graph edge version. It preserves the specification's
observable requirement—effective dating, auditability, and complete reversal—
without irreversible fact rewrites.

### Pin graph state into every governed answer

- `semantic_internal.identity_graph_state` holds a monotonically increasing
  tenant version and a deterministic hash of all effective edges and resolution
  rows. Every applied decision advances it, including an undo.
- The state is part of the semantic bundle hash and explicit response
  provenance. Cached answers from a prior graph are therefore unreachable even
  if invalidation is delayed.
- Governed database reads use one `REPEATABLE READ, READ ONLY` transaction,
  acquire the shared tenant deletion fence, compare the expected graph
  version/hash inside that transaction, and then run the compiled query in the
  same snapshot. A typed mismatch reloads semantic context and recompiles once;
  a second race fails closed.

## Consequences

- Merge and undo are O(edges plus resolved members) for one entity type and do
  not rewrite historical facts. This is intentionally conservative for V1; a
  future scale trigger may replace full component rebuilds with an incremental
  dynamic-connectivity implementation behind the same tables.
- Query compilation must resolve every governed entity key through
  `core.entity_resolution` before grouping, filtering, joining dimensions, or
  calculating customer lifecycle windows. Registry declarations identify the
  entity type of every such join and fail validation when the mapping is absent.
- A source sync, decision, deletion, cache lookup, and governed query have named
  linearisation points. Review cards that are no longer valid fail permanently
  instead of retrying as transient worker errors.
- Diagnostic history can reconstruct who decided what and when without using
  hidden model reasoning or mutable source links as the audit record.

## Alternatives considered

- Rewrite fact foreign keys on accept and replay raw data on undo: rejected
  because live post-merge facts become temporarily or permanently misassigned.
- Repoint current source links to the component representative: rejected because
  later candidate generation loses B's native anchor in an A-B-C graph and
  cannot safely reverse one edge.
- Store only pairwise accepted links and resolve recursively in every query:
  rejected because it complicates every compiler path and makes query cost and
  fan-out harder to bound.
- Invalidate cache without bundle versioning: rejected because invalidation and
  query execution can race across processes and stores.
