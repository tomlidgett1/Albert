# ADR 0012: Cross-store immutable answer artefact finalization

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Complements: ADR 0001 and the M5/M6 auditable-answer contract

## Context

Albert already writes deterministic query evidence to
`semantic_internal.query_audit` and streams a sanitized, append-only public
trace to the control plane. The original `answer_artifacts` schema, however,
was not connected to live turn completion. A completed turn therefore had no
single immutable record binding its question, visible plan, normalized IR,
query audits, result digests, validations, provenance, runtime profile, and
final narrative.

The two ledgers live in separate databases by design. The web application must
not gain analytical database credentials, the browser must not be able to
assert that an arbitrary query supports an answer, and compiled SQL must not
be returned to either the model or the tenant UI. Finalization also has to
survive transport retries without creating two artefacts or allowing a
different payload to replace the first.

## Decision

### The semantic service is the finalization trust boundary

- Each executed semantic or source-exploration query receives a ULID before
  its immutable analytical audit insert. The signed tool response carries a
  server-only receipt: query-audit ID, route, bundle hash, registry version,
  result digest, and compiled-SQL hash.
- The conversation runtime records only the query-audit IDs while it runs. It
  does not return the receipt to the model or include it in the public trace.
- After the final visible answer or clarification event is persisted, the web
  application calls a signed internal semantic-service finalization endpoint.
  The semantic service resolves every referenced audit row under
  `semantic_meta_rw`, verifies tenant/conversation/turn ownership, and derives
  the SQL hash inside the server trust zone.
- The semantic service then invokes one fixed `SECURITY DEFINER` control-plane
  function as the constrained `albert_semantic_control` role. That function is
  the only runtime path that can complete a successful turn.

### Finalization is atomic, content-addressed, and append-only

The control-plane function locks the tenant turn and atomically:

1. validates the answer state against the last visible event and the evidence
   routes;
2. verifies that every visible table's bundle has referenced query evidence;
3. derives the interpreted plan only from public `progress`, `narrative`, and
   `query` events;
4. records normalized IR, analytical audit references, SQL hashes, result
   digests, bundle hashes, registry versions, and query validations;
5. copies the exact ordered public trace to `answer_execution_events` and
   binds it with a SHA-256 trace digest;
6. records model metering, provider usage, and the resolved runtime profile;
7. inserts a canonical SHA-256-addressed answer artefact, completes the turn,
   and appends an audit-log event.

The analytical evidence read takes the same tenant-scoped shared advisory
lock used by governed queries, while analytical erasure takes the exclusive
form. Control-plane finalization locks the active tenant and its connections
and rejects any active deletion request. This linearizes finalization against
both tenant erasure and connection disconnect: an artefact either commits
before deletion and is subsequently purged, or finalization fails closed.

There is one artefact per turn. Repeating the exact finalization returns the
existing ID and digest; a different replay fails. Updates and ordinary deletes
on both answer ledgers are rejected by triggers. The existing fenced deletion
worker remains the only lawful erasure path.

The former authenticated `complete_albert_turn` and
`record_albert_model_usage` RPC grants are revoked because they cannot prove
cross-store query lineage.

### Public explanation is a safe projection

`albert_answer_lineage` and its server API expose the visible plan, answer,
validation, provenance, trace/artefact digests, and opaque query references
with bundle, result, and compiled-SQL hashes. The projection deliberately
removes normalized IR and never returns compiled SQL, prompts, raw tool
arguments, provider payloads, or private chain-of-thought. Access is limited to
the authenticated creator of the tenant conversation.

The live SSE response carries the server-issued conversation and turn ULIDs,
and restored conversation history carries the same turn ULID. The dash retains
those identifiers with each assistant message and resolves the immutable
turn-lineage endpoint only after the stream has finalized. Its presentation
boundary allowlists bounded receipt metadata (artefact and trace digests,
answer state, registry version, and query hashes) and discards narrative,
plans, validation payloads, SQL-like fields, and any unknown response fields.
This gives every Explain action a direct path to the sealed record without
making the public trace itself an assertion of immutability.

## Consequences

- Every successful numerical answer is reproducible from an immutable answer
  record and the referenced immutable analytical audits.
- A compromised browser cannot forge completion or attach unrelated query
  evidence; the signed semantic service and fixed database function establish
  that binding.
- Cross-database finalization is not a distributed transaction. This is safe
  because analytical audits are committed append-only before finalization and
  control-plane finalization is idempotent. An orphan query audit after a
  failed turn is valid operational evidence, not a false completed answer.
- SQL remains available to constrained operators in the analytical audit while
  tenants receive enough hashes and provenance to verify lineage without
  gaining a query surface.
- Schema/runtime releases must test idempotency, divergent replay rejection,
  tenant isolation, immutable mutation rejection, and safe projection.

## Alternatives considered

- Finalize directly from the authenticated Supabase client: rejected because a
  browser session could forge evidence for its own turn.
- Give the web deployment a control-plane or analytical database credential:
  rejected because it collapses the established trust zones.
- Copy compiled SQL into the public trace or lineage API: rejected because it
  creates an unnecessary disclosure and conflicts with the no-agent-SQL
  boundary.
- Use a distributed transaction across both Postgres databases: rejected as
  operationally disproportionate; immutable-before-finalize evidence plus an
  idempotent content-addressed commit provides the required correctness.
