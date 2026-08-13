# ADR 0085: Shopify generation-bound manual ingestion activation

- Status: Accepted
- Date: 2026-08-12
- Amends: Albert v1 section 5, ADR 0002, and ADR 0003
- Related: ADR 0016 (generation-fenced lifecycle), ADR 0047 (manifest-owned data-plane policy)

## Context

Albert's original OAuth contract finalizes a connection and immediately
publishes its first backfill. Shopify onboarding requires a separate consent
step: successful authorization must store the rotating credential and expose
the connected shop, but must not request store data until an owner or manager
chooses **Start ingestion**.

An environment-only suppression list is not sufficient authority. It can drift
between workers, does not bind consent to a credential generation, and does not
protect scheduler, recovery, webhook, or future trusted publication paths.

## Decision

The connection records `ingestion_activated_generation`. Existing ingesting
connectors retain automatic post-OAuth behavior. Shopify requires this value to
equal its current `connection_generation` before any sync job can be published.
Reauthorization advances the connection generation and therefore requires a
new explicit activation.

OAuth finalization suppresses Shopify's initial backfill by code default. The
owner/manager manual-sync capability locks the tenant-scoped connection,
activates its current generation, and publishes an `InitialBackfill`
coordinator in the same database transaction. The request ledger supplies the
idempotent job and sync identities returned to retries.

`control_plane.enqueue_sync_job` is the authoritative fail-closed gate for all
producers. Scheduled incremental, authentication-recovery, reconciliation and
phase-recovery selection also skip unactivated Shopify rows so one intentionally
idle store cannot abort work for other connections.

The Connections workspace projects only non-secret activation state. It shows
Start ingestion directly on an authorized Shopify store and never infers user
consent from missing cursors, readiness, or data.

## Consequences

- Connecting Shopify and ingesting Shopify are distinct, auditable actions.
- No deployment setting can accidentally turn Shopify OAuth into automatic
  ingestion.
- Reauthorization cannot reuse consent given to an older credential generation.
- After activation, Shopify participates in the normal progressive backfill,
  incremental and reconciliation lifecycle without a Shopify-specific job type.
- The environment suppression list remains an emergency kill switch for other
  connectors, not Shopify's product-policy authority.
