# ADR 0028: Effective scoped multi-account source authority

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering

## Context

Albert permits more than one account for a connector. A tenant can legitimately
connect two Xero organisations, multiple Lightspeed accounts, or separate
Deputy estates. The first canonical implementation automatically inserted one
open tenant-scoped authority row per concept. Every later fact was compared to
that single connection. A second account could complete OAuth and ingestion but
all of its facts then failed as non-authoritative.

The semantic side had the inverse error. Capability availability was true when
any connection published a successful observation, while governed SQL read all
tenant facts. It also collapsed authority to one connection per concept. One
healthy Xero organisation could therefore bless data from an unavailable peer,
and the peer disappeared from the answer bundle and provenance.

## Decision

### Authority scopes and effective time

- Statutory finance and cash settlement authority is scoped to the canonical
  `legal_entity` owned by the Xero connection.
- Operational sales, planned shifts, and worked hours are scoped to canonical
  `location` when the fact has one. Stock facts resolve their stock location to
  its canonical location before authority is checked.
- `account` scope is the deterministic fallback for product/customer masters
  and for operational, stock, or workforce records whose source contract has no
  location. Its scope ID is exactly the connection ID.
- The transform does not create automatic tenant-wide authority. `tenant`
  remains available only for an explicitly governed, genuinely singular
  concept and as readable legacy history.
- Authority intervals are half-open and non-overlapping per tenant, concept,
  scope type, and scope ID. The fact's canonical event timestamp—not transform
  wall-clock time—selects the interval.

### Safe canonical admission

- Source references are resolved before a fact may claim canonical record
  state. The resulting authority scope is therefore the scope actually written
  to the fact.
- A connection may install a default location or legal-entity authority only
  when `canonical_record_state` proves that the connection owns that exact
  canonical dimension. Account authority can only name the connection itself.
- Default installation is idempotent and only occurs when the exact scope has
  no authority history. It never overwrites a reviewed assignment or creates a
  new interval after an explicit interval ended.
- The scoped authority assertion occurs before canonical state or fact writes.
  Tombstone-only updates recover their scope from the existing fact; a
  tombstone for a fact that does not exist is a no-op.
- Legacy open automatic tenant defaults are closed during migration. Existing
  canonical facts and completed transform commits backfill deterministic
  account, location, and legal-entity authority without changing fact lineage.

### Semantic contributor proof

- The semantic context loads all effective authority intervals and a narrow,
  secret-free control-plane inventory of current connections. The inventory
  exposes connection identity, connector, display label, lifecycle/auth health,
  and eligibility; it exposes no OAuth reference or account metadata.
- For a compiled query and comparison range, every overlapping precise
  authority scope contributes. Legacy tenant rows are ignored whenever a
  precise scope exists. Contributors are deduplicated by connection only after
  retaining scope-level invariant evidence.
- A required capability is available only when every authoritative contributor
  for that capability's concept is control-plane eligible and has its own full
  or partial capability observation. Availability from one account cannot
  satisfy another account.
- Progressive coverage is evaluated for every contributor and for the union of
  Topic and requested-metric capabilities. Only current connection-generation
  coverage is visible; pending, degraded, missing planned streams, or an
  uncovered requested start block the query.
- Answer bundle hashes, freshness checks, authority invariants, source details,
  and watermarks include every contributing connection. This makes an
  aggregate across two Xero organisations auditable as a two-source result.

### Connections workspace presentation

- The authenticated workspace groups records by provider but exposes every
  current connection inside that provider group. It never selects one record
  as the provider-wide connection. Disconnected history remains in the control
  plane and audit trail, but is not presented as a current account.
- Account labels, auth health, readiness domains, watermarks, Manage actions,
  and readiness panels remain bound to the connection ID. Domain presentation
  IDs include the connection ID so equal domain names from two Xero
  organisations cannot collide. Disconnect confirmation names and purges only
  the selected connection.
- Once Xero has a current connection, the provider group offers an explicit
  **Add another Xero organisation** action. It starts a fresh Xero OAuth flow;
  the existing account-selection and identity finalizer decide whether the
  authorized external organisation reconnects its existing connection or
  creates a distinct connection. Other providers still render every returned
  account and retain their existing connect/manage behavior.
- Control-plane readiness progress is canonically stored as a fraction from
  zero through one. The web presentation mapper converts it once to a zero
  through one-hundred percentage for progress bars and aggregate setup
  progress; UI components do not reinterpret the stored fraction.

## Consequences

- Multiple organisations from the same provider can transform and query
  together without sharing or competing for one tenant-wide source slot.
- Owners can see and manage each connected organisation independently; adding
  a second Xero organisation no longer hides the first in onboarding.
- A mapper cannot claim another account's location or legal entity merely by
  constructing its canonical ID.
- Queries fail closed when any contributing account is disconnected,
  unauthorised, stale, missing a pack/watermark, or lacks a required capability.
- Effective authority changes remain historical and auditable. Overlap is
  rejected under a scope-specific transaction lock.
- Contributor checks can be conservative when a query spans an authority
  transition, but they cannot omit a source whose facts governed the range.

## Alternatives considered

- Keep one tenant authority row and designate a primary Xero organisation:
  rejected because V1 explicitly supports multiple organisations and facts are
  source-owned.
- Treat capability availability as existential across the tenant: rejected
  because governed SQL reads rows from every connection.
- Filter semantic SQL to a single selected connection: rejected because it
  silently drops legitimate cross-account facts and produces incomplete totals.
- Trust mapper-provided scope IDs without ownership evidence: rejected because
  a malformed or compromised mapper could cross an account boundary.
- Add provider account columns to every fact: rejected because legal entity and
  location are the governed canonical scopes, while immutable primary
  connection lineage already identifies the source account.
