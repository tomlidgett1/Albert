# ADR 0051: Content-addressed blocking-question approval boundary

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert product, onboarding, control plane, and release engineering
- Relates to: ADR 0001, ADR 0012, ADR 0038, ADR 0046

## Context

The V1 onboarding surface asks a small set of questions whose answers change
operative tenant behavior. The displayed sentence and choice label are product
copy, while each option also selects a governed metric, cutoff, or reconciliation
preference. Those parts were previously duplicated between the workspace
projection and `albert_answer_blocking_question`. A copy edit could therefore
leave the database applying a meaning the user did not approve, and a hand-built
RPC allowlist could drift from the options the UI offered.

The architecture and four candidate question families are accepted. The current
wording is not recorded as product-owner approved by this ADR or by its presence
in source control. Production needs an explicit, reviewable boundary that cannot
silently treat implementation as approval.

## Decision

`contracts/blocking-questions.v1.json` is the single code-owned contract. Its
versioned document contains every exact question label and sentence, every
option id and label, connector prerequisites, and ordered overlay mutations.
The envelope carries the SHA-256 of canonical JSON for that document: object
keys are lexicographically sorted, arrays retain their declared order, and the
UTF-8 representation contains no insignificant whitespace. The digest excludes
only the envelope metadata that declares the algorithm and digest itself.

The workspace parses the contract with a strict schema, filters questions using
the declared prerequisites, and returns an explicit UI projection. It does not
return overlay mutation details to the browser. It owns no local question or
prerequisite list.

Control-plane migration 0066 installs the exact canonical bytes and digest into
a singleton contract table. A database SHA-256 check binds those bytes to the
stored digest. The table has RLS enabled, no runtime role has direct access, and
update, delete, and truncate triggers make the installed snapshot immutable.
The authenticated RPC remains the only browser boundary. It locates the
question and option in the installed document, verifies every prerequisite
against current tenant connections, and applies the declared mutations
generically. No question-specific `IF` or `CASE` mapping remains. Each audit row
records the contract version and digest.

The migration payload is necessarily an immutable database snapshot. It is not
an independently maintained contract: CI canonicalizes the JSON source,
byte-compares it to the migration's delimited payload, and recomputes SHA-256.
Changing copy, options, prerequisites, or mutation paths or values without a
matching digest fails the contract suite.

Production web configuration requires
`ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST`. Package configuration inspection
and protected release preflight compare it byte for byte with the code-owned
digest. The value is a non-secret protected variable and appears in the Sites
runtime inventory. It must be absent until Tom has explicitly reviewed this
exact contract and chosen to set its digest. A missing or stale value fails
closed before production use. Neither this ADR, the migration, CI success, nor
deployment documentation constitutes that approval.

A future content change requires a new contract version, digest, forward-only
database migration, tests, product review, and protected-variable update. Old
response lineage remains interpretable through its recorded version and digest.

## Consequences

- The displayed meaning and operative overlay effect cannot drift independently.
- Direct RPC callers cannot answer a hidden question or bypass its live connector
  prerequisites.
- Production intentionally remains unavailable until the exact candidate copy
  is explicitly approved out of band and its digest is configured.
- Changing punctuation or an option label is a contract change, even when the
  underlying metric is unchanged.
- Runtime code never needs direct read authority over the private database
  contract table.

## Alternatives considered

- **Treat merged code as approval:** rejected because implementation review and
  product wording approval are different acts.
- **Keep UI and SQL allowlists in sync manually:** rejected because tests cannot
  make two mutable sources of meaning into one authority.
- **Store only option ids in the database:** rejected because it would not bind
  the user's exact displayed choice to the effect being applied.
- **Let the browser send an overlay patch:** rejected because an authenticated
  client must select an allowlisted option, never choose operative paths or
  values.
- **Use a mutable active-contract row:** rejected because in-place edits would
  destroy answer lineage and bypass forward-only review.
- **Publish the candidate digest as a default environment value:** rejected
  because a default would falsely turn repository presence into approval.

## Verification

- `contracts/blocking-questions.v1.json`
- `contracts/blocking-questions.mjs`
- `packages/config/src/blocking-questions.ts`
- `services/control-plane/src/connections-workspace.ts`
- `infra/migrations/control-plane/0066_m1_content_addressed_blocking_questions.sql`
- `tests/contracts/onboarding-defaults.contract.test.ts`
- `tests/sql/control-plane-blocking-question-contract.sql`
- `tests/runtime-health.test.mjs`
- `tests/release-preflight.test.mjs`
- `deploy/runtime-contract.json`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
