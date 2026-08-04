# ADR 0059: Immutable batch lineage for canonical quarantine

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert platform
- Related: ADR 0056 (multi-page InitialBackfill claims), ADR 0058
  (set-based transform pages), Albert v1 sections 11 and 17

## Context

Canonical transforms run asynchronously after analytical landing. The
`ingestion.source_records` table is intentionally a current-state seam keyed by
source identity, so a later snapshot replaces its batch ID, sync run, and
payload hash. Typed staging has the same current-state shape.

Canonical mapping quarantine originally joined an old batch manifest to this
mutable row to authenticate the rejected source identity. When transform lag
allowed a newer snapshot to land first, a valid old typed row no longer matched
that join. PostgreSQL raised a foreign-key-style integrity error, the complete
transform page rolled back, and the queue marked it permanently failed.

## Decision

1. Authenticate a canonical quarantine write with the exact append-only batch
   manifest and committed landing record: tenant, connection, sync run, batch,
   stream, and mapping version must agree. The manifest supplies the immutable
   raw object key.
2. Never use the mutable current-state `source_records` seam as proof of a
   historical transform page. The typed row supplies its source identity and
   payload hash inside the same tenant-fenced transform transaction; the exact
   payload remains recoverable from immutable raw storage.
3. Bind staging `source_object_type` to the reviewed connector stream contract
   instead of joining a historical page to the latest source row.
4. Record independent mapping rejections through one JSON recordset call per
   page. The security-definer function retains row-scoped validation and
   deterministic idempotency for each rejection.
5. Healing follows the same immutable batch/landing boundary and remains
   identity-scoped, so a valid later projection resolves prior open canonical
   mapping findings.

## Consequences

- A backlog page remains transformable after a newer snapshot replaces current
  source state, provided its typed staging row and immutable landing evidence
  still exist.
- Quarantine records retain the exact historical batch, payload hash, and raw
  object key without granting `transform_rw` direct write access.
- Mapper-rejection pages no longer pay one Fly-to-PostgreSQL round trip per
  rejected row.
- A historical typed row that has itself been replaced cannot be reconstructed
  from current-state staging. Streams that require per-batch reprocessing
  compare typed-row count with their immutable landing count and fail closed;
  the missing page must be replayed from immutable raw storage.
