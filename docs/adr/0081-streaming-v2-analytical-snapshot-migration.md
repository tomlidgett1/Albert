# ADR 0081: Streaming V2 analytical snapshot migration

- Status: accepted
- Date: 2026-08-10
- Extends: ADR 0077 and ADR 0079

## Context

The predecessor production cell contains real Lightspeed and Xero analytical
data while the designated Sydney V2 analytical project has the complete schema
but no tenant rows. Replaying vendors is the long-term freshness path, but a
governed release evaluation also needs a stable production-shaped snapshot.
Writing a plaintext database dump to a workstation would create an unnecessary
PII copy, and copying rotating OAuth tokens while another worker can refresh
them risks invalid credentials.

## Decision

Albert provides an explicit, one-time streaming analytical snapshot migration.
It copies only tenant-scoped tables in `source_lightspeed`, `source_xero`,
`core`, and `mart` from one exact Supabase project to another. Before transfer
it proves:

- source and target project identities;
- an exact allowlisted tenant-table set and physical column contract;
- one declared source tenant;
- non-empty Lightspeed and Xero source data;
- a completely empty target table set.

The source preflight exports a repeatable-read PostgreSQL snapshot, and
`pg_dump` is required to consume that exact snapshot while the exporting
read-only transaction remains open. Both source sessions bind the declared
`albert.tenant_id`, and `pg_dump` explicitly enables row security so the
least-privilege deployer cannot export a different tenant. `pg_dump` streams
directly into `psql` over required TLS. The target restore transaction locks every selected table,
rechecks that the target is empty, restores the rows, and remaps the tenant with
`ON_ERROR_STOP`. A failed or interrupted dump injects a deliberately invalid
statement so even a syntactically valid partial stream must roll back. No
customer data is written to disk. Post-transfer verification requires exact
per-schema counts, no residual source tenant identifiers, and emits a
content-addressed receipt. The source is read-only throughout.

## Consequences

- V2 qualification can use the real Lightspeed/Xero snapshot in the designated
  Sydney analytical cell without weakening project binding.
- A failed restore rolls back the target atomically; a non-empty target is
  rejected rather than merged or overwritten.
- The snapshot does not prove ongoing freshness or vendor authorization.
  Lightspeed and Xero must still be reconnected, or their credentials migrated
  under a separately quiesced and reviewed procedure, before customer cutover.
