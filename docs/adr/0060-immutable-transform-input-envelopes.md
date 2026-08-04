# ADR 0060: Immutable transform input envelopes

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert platform
- Related: ADR 0056 (multi-page InitialBackfill claims), ADR 0058
  (set-based transform pages), ADR 0059 (canonical quarantine lineage), Albert
  v1 sections 2, 3, 11, and 17

## Context

Raw payloads and their manifests are immutable, but vendor `source_*` staging
tables are current-state projections keyed by source identity. Canonical work
runs asynchronously. If a newer snapshot lands before an old transform claim,
the typed row's batch ID, hash, and projected values can be replaced.

Joining the transform to current `source_records` made this visible as a
quarantine-lineage failure. Removing that join fixed pages whose typed rows
still existed, but a deeper race remained: a fully replaced page appeared to
contain zero rows. The old pipeline could commit that page as a successful
empty transform even when its immutable landing commit said 100 rows.

Albert v1 requires mapping fixes and reprocessing to rebuild from immutable
storage rather than vendor APIs. A transform therefore needs durable typed
input at the same batch boundary; mutable current staging is not sufficient.

## Decision

1. Landing writes one append-only `canonical_staging_batch_records` envelope
   for every valid typed record in the same analytical transaction as current
   staging and the landing commit.
2. The envelope is keyed by tenant, batch, mapping version, and namespaced
   source identity. It stores the exact typed mapper row plus explicit
   connection, sync, connector, stream, source identity, and payload-hash
   fences. Runtime roles receive no update or delete authority.
3. Transform reads the immutable envelope first. Current `source_*` staging is
   a compatibility fallback for batches landed before this decision; streams
   requiring per-batch reprocessing fail closed when loaded row count differs
   from the immutable landing count.
4. Existing typed rows are snapshotted during migration before the new write
   path starts. Historical gaps are replayed from their exact raw object,
   content hash verified, and inserted only into the immutable envelope.
5. Canonical quarantine creation and healing must match the exact immutable
   envelope record, in addition to manifest and committed landing evidence.

## Consequences

- A later snapshot may advance current staging without changing the inputs of
  an already queued transform.
- Transform retains no raw-storage credential and still cannot read connector
  credentials. Ingestion is the only normal writer of immutable envelopes.
- Typed input is retained per batch while the tenant is active and cascades
  with its batch manifest during governed deletion.
- Historical dogfood pages that were falsely committed as empty have their
  false completion attestations removed and are replayed idempotently from raw
  storage; canonical version fences prevent older observations overwriting
  newer truth.

