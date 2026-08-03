# ADR 0023: Narrow connection mutation capabilities

- Status: Accepted
- Date: 2026-08-03
- Decision owners: Albert platform
- Relates to: ADR 0003, ADR 0004, ADR 0016

## Context

The sync/OAuth runtime historically held unrestricted `INSERT` and `UPDATE`
privileges on `control_plane.connections`, backed by a cross-tenant RLS policy
with `USING (true)` and `WITH CHECK (true)`. That role must read connection and
credential-reference state, but generic connection mutation let any compromised
query path manufacture an authorised connection, retarget a source account,
advance a generation, reactivate a disconnected source, or bypass the durable
disconnect/deletion workflow.

OAuth completion and scheduled credential probes are the only production sync
paths that need to mutate a connection. Their authority evidence is already
durable: an OAuth session binds tenant, initiator, provider, selected account,
PKCE and exchanged-credential envelopes; a claimed sync job binds a queue lease,
tenant, connection, generation, provider, source account, and sync run.

## Decision

Migration `0040_m0_m8_narrow_connection_mutation_capabilities.sql` supersedes
the permissive connection grant and policy.

The sync role retains `SELECT` on `control_plane.connections` and receives two
`SECURITY DEFINER` mutation procedures only:

1. `control_plane.finalize_oauth_connection_identity(...)` locks and validates
   the exact live OAuth session, active owner/manager membership, provider,
   selected/offered source account, PKCE envelope, and provisional exchanged
   credential. It derives the existing connection by the provider/account
   identity; a proposed id is accepted only for a genuinely new identity.
   Active re-authorisation advances the connection generation. A disconnected
   connection can be restored only when the existing durable deletion intent is
   still reversible and its credential has not been destroyed. Direct access to
   the reconnect-cancellation helper is revoked from sync.
2. `control_plane.record_connection_auth_health(...)` requires the exact active
   PGMQ-backed job attempt and verifies every target field against the immutable
   job payload. It can update only `auth_health` and `last_checked_at` on the
   active, exact connection generation.

OAuth identity finalisation stores a SHA-256 request binding and immutable
connection id/generation result on the session. An exact retry after response
loss returns that result without incrementing the generation; any changed retry
fails closed. Display-only account metadata is size/depth bounded and rejects
credential-shaped keys.

`INSERT`, `UPDATE`, and `DELETE` on `control_plane.connections` are revoked from
`albert_sync_control`. The permissive `sync_runtime_access` policy is replaced
with a select-only policy. Browser disconnect, deletion-worker tombstoning, and
tenant-erasure procedures retain their separately derived authorities.

## Consequences

- OAuth and health callers must use the reviewed procedures; direct connection
  DML in sync-worker code is forbidden and contract-tested.
- A valid OAuth session cannot be reused to produce a second identity or a
  second generation after an uncertain response.
- Stale or retargeted sync attempts cannot overwrite credential health.
- Reconnect remains possible before deletion becomes irreversible, but the
  sync role cannot cancel deletion independently.
- Future connection mutations require a new narrowly evidenced procedure and
  an ADR update; expanding the generic table grant is not an accepted option.

## Verification

- `tests/contracts/connection-mutation-boundary.contract.test.ts`
- `tests/sql/control-plane-connection-mutation-boundary.sql`
- `tests/sql/control-plane-runtime-isolation.sql`
- `tests/contracts/oauth-session-authorization.contract.test.ts`
