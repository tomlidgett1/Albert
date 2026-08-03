# ADR 0022: signed cross-cell analytical capabilities and stale-writer fencing

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert platform
- Refines: ADR 0002 (control/analytical cell separation)
- Extends: ADR 0016 (generation-fenced sync lifecycle)
- Supersedes in part: ADR 0017's caller-selected analytical tenant context
- Composes with: ADR 0004 (durable deletion and cryptographic erasure)

## Context

Albert deliberately separates authoritative tenant, connection, queue, lease,
conversation, and deletion state in the control plane from customer analytical
rows in a second PostgreSQL cell. The original analytical boundary selected a
tenant with the session setting `albert.tenant_id`. PostgreSQL custom settings
are caller-controlled. A stolen runtime database credential could therefore
choose another tenant even when every table had row-level security.

Checking control state immediately before an analytical write was also
insufficient. A reconnect, deletion approval, queue visibility expiry, or
worker lease loss could commit after the check but before the analytical
transaction. That time-of-check/time-of-use window admits a stale raw landing,
canonical transform, metadata update, diagnostic read, or deletion operation.
The two databases cannot share one atomic transaction.

The boundary must preserve separate least-privilege credentials, fail closed
on a fresh deployment, support key rotation without downtime, and avoid giving
runtime processes a signing key or generic tenant-minting RPC.

## Decision

The control plane is the sole capability issuer. The analytical cell accepts a
tenant context from a signed capability, never from a runtime-selected tenant
setting. A capability is a canonical JSON envelope containing exactly:

- version and key id;
- tenant id, audience, scope, subject, and one random nonce;
- integer issue and expiry epochs; and
- immutable evidence identifying the live control-plane authority.

The envelope is authenticated with HMAC-SHA-256 and expires after at most five
minutes or the underlying lease, whichever is earlier. The analytical verifier
checks exact envelope shape, signature, key validity, clock window, audience,
scope, and the fixed `session_user` mapping. Every runtime login is NOINHERIT,
has no privileged PostgreSQL attributes, and belongs to exactly one group:

| Exact login | Audience | Scope |
| --- | --- | --- |
| `albert_ingest_runtime` | `analytical:ingest` | `ingest` |
| `albert_transform_analytical_runtime` | `analytical:transform` | `transform` |
| `albert_semantic_read_runtime` | `analytical:semantic-read` | `semantic_read` |
| `albert_semantic_metadata_runtime` | `analytical:semantic-metadata` | `semantic_metadata` |
| `albert_operator_diagnostic_analytical_runtime` | `analytical:diagnostic` | `diagnostic` |
| `albert_deletion_analytical_runtime` | `analytical:deletion` | `deletion_purge` or `deletion_verify` |

Issuer evidence is purpose-specific:

- semantic read/metadata: exact running conversation and turn lease;
- ingest: queue name, message id, request id, read count, worker, sync run,
  connection id, and connection generation;
- canonical transform: transform job, worker, lease token, source batch, sync
  run, connection, and generation;
- identity projection: exact decision projection and lease plus the locked
  tenant connection generations;
- maintenance snapshot: exact maintenance lease and the claimed connection
  generation map;
- diagnostic: the already one-use reveal id and bounded table target; and
- deletion: exact deletion request, PGMQ attempt, worker, scope, target, and
  operation.

For ingest and every transform writer, issuing a token and committing an
analytical transaction occur while the service keeps the issuing control-plane
transaction open. The issuer revalidates and takes row locks on the exact queue
attempt, job/maintenance lease, tenant, connection, generation, and deletion
fence. Reconnect, deletion, lease completion, or generation mutation must wait
for the analytical commit; if it wins first, issuance fails. A crash rolls back
the analytical transaction and releases the control locks. Every analytical
read or write in those workers goes through this authorization wrapper,
including raw landing metadata, outbox publication markers, pipeline snapshots,
identity projections, and dossier inputs.

Deletion capabilities are additionally one-use. The analytical cell consumes
the nonce transactionally before calling the reviewed purge or verification
implementation. The replay ledger retains only nonce, token digest, operation,
and expiry—no tenant or connection identifier—so it can outlive customer
erasure without retaining customer data.

Every analytical data transaction also takes the shared form of the same
tenant advisory lock used exclusively by purge. Purge records a tenant-wide
revocation watermark before deleting either a tenant or one connection. The
watermark stores only SHA-256 of the random tenant ULID and an epoch second,
never the tenant or connection identifier. The verifier rejects any ordinary
capability issued at or before that watermark. Consequently, a transaction
that wins the shared lock is included in the subsequent purge, while one that
starts after purge cannot replay a pre-purge token and recreate rows. A
connection purge revokes all outstanding tenant tokens because semantic
capabilities are tenant-wide; new tokens may be issued after deletion reaches
a terminal state. The control signer refuses all non-deletion scopes while an
approved deletion is active.

Migration-owner sessions retain an explicit fixture/migration path using
`albert.tenant_id`. Fixed production runtime logins never take that path, even
if they set the same custom variable. Runtime roles cannot read either keyring
or call installation, signing, retirement, or pruning internals.

## Key lifecycle and release ordering

The same 32-64 byte secret is installed out of band in the analytical verifier
keyring first and the control signer keyring second. The parameterized
provisioner connects to both cells before changing either, uses bound query
parameters, verifies identical SHA-256 fingerprints, runs both readiness
checks, zeroes its local decoded buffer, and never prints the secret. A key id
is immutable and cannot be reused with different material.

Rotation installs a new key in the same verifier-first order. Signing selects
the newest active key. Optional retirement stops the old control signer before
shortening analytical verification to the identical timestamp, with at least a
ten-minute drain and an overlapping replacement. Expired key material is
pruned only after the five-minute token lifetime plus a ten-minute margin.

Protected release order is: reviewed administrator bootstrap upgrades,
ordinary migrations, exact runtime login reconciliation, dual-cell capability
key provisioning, webhook attestation key provisioning, semantic publication,
then service deployment. Sync, transform, semantic, diagnostic, and deletion
readiness all fail closed when their issuer or verifier has no active key.

## Consequences

- Possession of a runtime database password no longer authorizes an arbitrary
  tenant; the caller also needs a live, purpose-bound control-plane lease.
- A stale worker cannot cross a reconnect/deletion generation change while an
  analytical commit is in flight.
- A pre-purge capability cannot be replayed after purge; the irreversible,
  identifier-free watermark survives cryptographic tenant erasure.
- Both databases contain HMAC material, but only migration owners can read it.
  Compromise of either database administrator remains a full trust-boundary
  event and requires key rotation.
- Control locks remain open during a cross-cell analytical transaction. The
  operations are deliberately bounded by lease, lock, and statement timeouts;
  contention fails the job closed and retries from durable evidence.
- Key absence or a partial signer-first deployment cannot silently degrade to
  caller-controlled tenant scope.

## Rejected alternatives

- **Trust `albert.tenant_id`:** any PostgreSQL client can set a custom session
  variable; RLS around that value does not authenticate it.
- **Check control state and close the transaction before writing:** reconnect or
  deletion can win the gap between the check and analytical commit.
- **Give each runtime the HMAC key:** a compromised worker could mint arbitrary
  tenants, audiences, and evidence.
- **Use a generic `issue_for_tenant` RPC:** the runtime credential would still
  be a tenant-selection oracle. Every issuer instead joins immutable live
  evidence and rejects caller-only claims.
- **Use long-lived JWTs:** they outlive queue visibility and generation state
  and add claim formats unrelated to Albert's exact database leases.
- **Use asymmetric signatures immediately:** PostgreSQL 17's deployed extension
  set does not provide a reviewed, portable Ed25519 verification primitive for
  this path. HMAC inside ACL-isolated key tables is deployable now; a future KMS
  or asymmetric verifier may supersede it without changing capability claims.
