# ADR 0020: Independently attest verified webhook dispositions

## Status

Accepted

## Context

The webhook gateway previously inserted `signature_verified = true` and wrote reconciliation identities while using the same database credential that could edit the receipt table. A leaked database password could therefore manufacture a verified Deputy receipt and enqueue source tombstones without possessing a Deputy verifier secret. Application code having run a verifier was not independently provable at the database boundary.

## Decision

The public edge and control plane use an independent, rotatable 256-bit HMAC key solely for webhook attestations. The key is installed through a parameterized administrator-only provisioner and is never readable through the webhook runtime role. The gateway signs the exact UTF-8 JSON document it submits, binding the operation, receipt identity, document digest, issuance second and a random 128-bit nonce. The control plane verifies the proof, enforces a five-minute lifetime, and consumes the nonce once in the same transaction as the receipt mutation.

The proof boundary covers the whole edge surface, not only the final receipt. Deputy verifier-material resolution, Xero ingress acceptance, claims, renewal, sequence and gap recording, connection resolution, receipt reservation, raw attachment, fan-out, completion, failure, and health are separate exact-document operations. All legacy Xero procedures and direct Deputy resolver/readiness procedures are revoked from the runtime role.

Each Xero claim generates a new random 128-bit lease token and increments a monotonic lease version. Every post-claim document binds the inbox, worker, token, and version; every database mutation locks and revalidates that exact unexpired lease. Reusing a worker name cannot revive a stale process after a reclaim. Receipt reservation validates the exact active Deputy verification material or the exact leased Xero inbox before writing. Deputy finalization parses only the signed document, validates its stream and tombstone schema, and enqueues through the fixed wrapper. Raw attachment is restricted to the one deterministic tenant/connection/receipt object key. Xero connection lookup is a bounded exact-reference resolver.

HMAC material is independent from OAuth, payload encryption, vendor signature and deletion-proof keys. At most three verification keys can overlap during rotation, and install/retire operations serialize the key ring so concurrent rotation cannot exceed the overlap bound or retire the last active key. Readiness signs and consumes a fresh challenge; it therefore fails when the configured runtime secret does not match the active database key, rather than checking only a key ID.

Administrator-owned helpers needed after initial database creation are delivered as immutable, checksummed privileged-bootstrap upgrades. Ordinary migrations continue under the non-login migration owner and can invoke only the fixed helper. This gives an already-bootstrapped environment an upgrade path without changing its one-time bootstrap checksum or granting general scheduling authority to the deployer.

## Consequences

- A database credential alone cannot claim that a vendor signature passed or invent a tombstone disposition.
- A stale Xero replica cannot continue writing after lease expiry or reclaim, even if it reuses the same configured worker ID.
- Exact signed documents and one-use nonces make mutation proofs replay-safe and auditable without storing vendor secrets.
- Compromise of the complete gateway process remains inside the public-edge threat boundary; key rotation and connection reconciliation are required after such an incident.
- Deployment must provision the same independently generated key in the control plane and gateway secret store before traffic is admitted.
