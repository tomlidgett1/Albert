# ADR 0004: Durable cross-store deletion and cryptographic erasure

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert platform
- Supersedes: None

## Context

Albert V1 stores a connected account's data in several independently durable
places: encrypted OAuth envelopes, Supabase Storage raw objects, control-plane
operational tables and PGMQ messages, typed analytical staging, canonical
facts and dimensions, marts, semantic caches, query evidence, and UI answer
artifacts. Marking a connection `disconnected` cannot satisfy the V1 deletion
contract. A deletion must finish across every store, tolerate crashes and
retries, prevent late sync writes from resurrecting data, and retain proof
without retaining the deleted identity.

Remote OAuth revocation is also not uniformly available. Lightspeed and Xero
provide revocation/disconnect operations; Deputy relies on user-managed consent
removal. A vendor outage must not retain locally usable credentials forever.

## Decision

Albert uses a dedicated `albert_deletion` PGMQ queue and deletion worker.
Requests, visibility-fenced attempts, progress, retry state, and a maximum
completion deadline are durable in the control plane. Deletion messages are
deleted, never archived, because their routing fields contain tenant and
connection identifiers. Failed attempt cycles are re-enqueued by the fixed
`pg_cron` scheduler until cross-store verification succeeds.

The control-plane login is a member only of the NOLOGIN
`albert_deletion_control` group and explicitly activates it with `SET LOCAL
ROLE` for every transaction. That role has no direct table or PGMQ grants.
Credential reads, refresh rotations, destruction, revocation context, and
verification are exposed only through fixed `SECURITY DEFINER` functions that
prove the current queue message, worker, read count, visibility deadline, and
tenant/connection scope. The analytical login is independently injected as
`DELETION_ANALYTICAL_DATABASE_URL`, belongs only to `deletion_rw`, and also
activates that role per transaction. Raw deletion uses a storage-only S3 key,
never the Supabase service-role JWT.

Connection disconnect is one authenticated owner/manager action. Remote
revocation is attempted first by the existing connector pack, the per-secret
wrapped data key and ciphertext are destroyed, the connection becomes a
non-sensitive tombstone, and purge is queued immediately. The organisation,
memberships, overlays, and other connections remain.

Full tenant erasure uses two authenticated owner confirmations with a short
approval expiry. Approval fences the tenant immediately and queues deletion.
The worker gets a bounded opportunity to perform vendor revocations first. A
database-side 15-minute deadline destroys all wrapped credential keys and OAuth
session envelopes even if the worker or a vendor is unavailable. Remote failure
is evidence in the proof, not a reason to retain local credentials.

Sync workers acquire a short-lived, row-locked write permit immediately before
writing raw Storage. Disconnect or tenant approval closes new permit
acquisition. The deletion worker will not begin raw purge while an unexpired
permit exists, which closes the in-flight vendor-response race; crashed permits
expire after a bounded interval.

The worker purges and independently verifies four required stores:

1. Credential vault: token references, ciphertext, wrapped DEKs, and OAuth
   session envelopes.
2. Raw Storage: every object beneath the exact tenant or connection prefix,
   removed through the Storage API and then re-listed.
3. Analytical cell: typed staging and ingestion lineage, source-owned canonical
   rows plus their FK dependency closure, cross-source bridges, quality evidence,
   marts, query audit, capabilities, and caches. Remaining-connection marts are
   rebuilt from retained canonical facts.
4. Control plane: sync/webhook/quarantine state, queue and archive messages,
   answer artefacts and caches, source-derived dossier/review evidence, and
   either a scrubbed connection tombstone or the physical tenant anchor.

Completion is allowed only when all four verification objects say `verified`.
The worker then writes one append-only proof containing the request id, scope,
timestamps, remote-revocation outcome, per-store counts, service version, and a
digest. Tenant and connection references in the proof are HMAC-SHA-256 values
under a secret dedicated to deletion evidence. No display name, user id, source
payload, SQL, tenant id, or connection id is retained in the proof. Full tenant
completion deletes the request, attempts, queue message, and tenant row in the
same transaction that commits the proof.

Retry records never contain exception or vendor response text. The application
maps failures to an exact allowlist of bounded code/class pairs and attaches a
ULID correlation id; the database rejects extra keys or non-allowlisted values.
Operator logs carry the same correlation id without the raw exception message.

## Consequences

- A disconnected connection's data is normally removed immediately; the
  30-day V1 bound is a monitored maximum, not a retention period.
- Deletion is idempotent. Storage removal, analytical deletes, control-plane
  deletes, and proof insertion are safe to repeat after a crash.
- Query history and source-derived review/dossier evidence are invalidated
  tenant-wide on connection deletion because they may combine multiple sources
  and cannot safely be attributed to one connection.
- A tenant loses interactive access as soon as the second confirmation commits.
  This prevents new work during erasure and means the approval response is the
  final browser-visible status for that tenant.
- Operators can prove completion by request id and proof digest, but cannot use
  the proof table to enumerate deleted tenant identities without the separate
  HMAC secret.
- Production deployment must provide a control login that is a member only of
  `albert_deletion_control`, a `DELETION_ANALYTICAL_DATABASE_URL` login that is
  a member only of `deletion_rw`, storage-only S3 credentials,
  `DELETION_PROOF_HMAC_KEY`, and the provider credentials needed for remote
  revocation. It must run the worker continuously and alert on requests
  approaching their purge deadline, repeated failure cycles, or stale worker
  heartbeats.

## Rejected alternatives

- **Soft-delete flags only:** leave raw, analytical, queue, and credential data
  intact and do not meet the V1 contract.
- **Best-effort HTTP deletion in the web request:** cannot survive process
  failure and cannot provide fenced retries or cross-store verification.
- **Waiting indefinitely for vendor revocation:** lets an external outage retain
  locally usable credentials and violates cryptographic-erasure requirements.
- **Unkeyed identifier hashes in proofs:** permit offline confirmation of known
  tenant or connection ids; keyed HMAC references avoid that disclosure.
- **Deleting all canonical data for a connection and waiting for a future
  incremental sync:** can strand retained connections with incomplete history;
  dependency-closure deletion and mart rebuild preserve retained source data.
