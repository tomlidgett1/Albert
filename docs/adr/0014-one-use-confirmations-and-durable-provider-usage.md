# ADR 0014: One-use clarification receipts and durable provider usage

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Complements: ADR 0001 and ADR 0012

## Context

Two M6 side effects cannot be authorized by model prose or depend on answer
finalization succeeding. First, a clarification selection may authorize a
tenant-overlay preference write. A browser-supplied value alone cannot prove
which question or preference the user confirmed, and the same prompt must not
be replayable through a sibling option. Second, OpenAI has billable usage as
soon as a provider run completes. If immutable answer finalization later
fails, times out, or loses its client stream, that usage still requires exact
tenant attribution and an honest terminal outcome.

## Decision

Clarification options use a fixed database-owned vocabulary. The agent chooses
only opaque option IDs. When the public clarification event is appended, a
trigger verifies the canonical IDs and labels and persists one prompt receipt
with its exact allowlisted preference key/value choices. The next request may
submit only the offered turn ID and option ID. `begin_albert_turn` locks the
finalized clarification receipt, atomically binds the selected option to the
new turn, and consumes the entire prompt. Exact request retries return the
same binding; sibling, cross-conversation, changed, and second-turn replays
fail. `remember` checks the returned key and value at the conversation,
signed semantic-service, and storage layers, while a tenant-overlay trigger is
the final database allowlist boundary.

Provider usage is checkpointed through the signed semantic service before
answer construction and artifact finalization continue. A constrained
control-plane function writes the existing append-only cost ledger plus one
provider-completion receipt. It is digest-idempotent and rejects divergent
replays. A second append-only stage records exactly one terminal outcome:
answer finalized, client disconnected, timeout, runtime failure, or artifact
finalization failure. The checkpoint call deliberately does not inherit the
browser stream abort signal. ADR 0012's finalizer continues to verify and bind
the same metering digest into successful artifacts; an existing identical
ledger row is expected.

## Consequences

- Model text and browser JSON are never preference-write capabilities.
- Choosing any option burns the complete prompt while exact transport retries
  remain safe.
- Completed provider usage survives failed finalization and post-response
  disconnects with one immutable failure outcome.
- A successful answer still binds provider usage and cost into its immutable
  artifact; the earlier checkpoint does not weaken lineage finalization.
- New remembered preferences require a coordinated option-vocabulary and
  database-allowlist migration.

## Alternatives considered

- Trust `{preference, value}` or `{question, value}` from the browser: rejected
  because one confirmed value could authorize another key or be replayed.
- Consume only the selected option row: rejected because a sibling option from
  the same prompt would remain a second capability.
- Record usage only inside answer finalization: rejected because finalization
  failure would erase already-incurred provider cost and its operational
  outcome.
