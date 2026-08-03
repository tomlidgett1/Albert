# ADR 0008: Xero webhook durable ACK-first inbox

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Supersedes: synchronous Xero routing in the M2 webhook gateway and the webhook trust assumptions in ADR 0003

## Context

Xero configures webhooks per application and can include events for every organisation connected to that application. Its endpoint contract requires HTTPS on port 443, a 2xx response within five seconds for a valid signature, no response cookies, and a 401 for an invalid signature. Failed deliveries are retried for up to 24 hours; events accumulated while a subscription is retrying or disabled can be replayed in order for up to 31 days. Xero also requires consumers to be idempotent and replay-safe.

Resolving every Xero organisation to Albert tenants, writing tenant raw objects and enqueueing every stream before acknowledgment makes the five-second contract depend on the slowest database lookup, object-store write and queue fan-out. A single multi-organisation payload also cannot be written unchanged beneath one tenant's raw prefix without disclosing another organisation's data.

The current Xero webhook schema has an app-level envelope with `firstEventSequence`, `lastEventSequence`, `entropy`, and an events array. Contacts and Invoices retain the original event shape. Credit Notes were added in March 2026 with a new category-specific `data` object containing credit-note type and status. The gateway must accept that current schema while retaining bounded forward compatibility for additive fields.

## Decision

### Acknowledge only after tenant-neutral durability

- The synchronous `/v1/webhooks/xero` path buffers at most 1 MiB, verifies `x-xero-signature` as base64 HMAC-SHA256 over the exact request bytes, validates the current bounded schema, encrypts the exact body, and commits one tenant-neutral inbox row. It performs no connection lookup, Supabase Storage call or queue fan-out.
- The ingress database has a pool isolated from background routing. Connection acquisition is bounded to 1.25 seconds, PostgreSQL statements to 2.5 seconds, and the whole inbox persistence to 3.5 seconds. A timeout returns a retryable non-2xx response before Xero's five-second limit. A commit that races the timeout remains safe because the body hash is unique.
- The inbox uses AES-256-GCM with a random 96-bit nonce, a 128-bit authentication tag, and associated data binding schema version, inbox ULID, encryption key ID and body SHA-256. `WEBHOOK_INBOX_ENCRYPTION_KEY` is an unpadded base64url encoding of exactly 32 random bytes. It is independent from OAuth, Xero's signing key, and Deputy's verifier key.
- Exact retries increment `delivery_count` on the existing body-hash row and receive 2xx without creating another processing item. The plaintext signature and request headers are never stored.

### Lease, partition and route asynchronously

- An always-on loop claims one item with `FOR UPDATE SKIP LOCKED`, a 30–300 second renewable lease, bounded attempts and exponential retry. Every claim rotates a random 128-bit lease token and increments a lease version. Every subsequent control-plane mutation must present an independent signed document containing the exact worker, token and version and revalidate the unexpired lease. An expired lease is reclaimable after a crash without allowing its stale worker to keep writing. Graceful shutdown stops new claims and waits for the active lease before closing database and Storage clients.
- The processor decrypts and authenticates the body, verifies its hash, revalidates the schema, and compares event count and sequence metadata with the inbox row before any tenant operation.
- Events are partitioned first by Xero `tenantId`, then by category. `CONTACT`, `INVOICE`, and `CREDITNOTE` map only to `contacts`, `invoices`, and `credit_notes`. Subscription events are acknowledged but do not enter an accounting connection stream.
- Only an active Xero connection whose `external_account_reference` exactly equals that partition's Xero tenant ID is resolved. Each tenant/category partition is serialized independently and written under only that Albert tenant and connection's immutable raw prefix. The original multi-organisation body is never copied into a tenant object.
- Each partition has a stable receipt identity derived from inbox and stream. Conditional object writes, receipt attachment, the fixed `enqueue_xero_webhook_incremental` wrapper and queue idempotency make every crash boundary replay-safe. Connection sequence state is recorded only after all of that connection's matching stream receipts are queued.

### Treat sequence state as app-wide, then persist connection observations

- Xero documents the webhook as app-wide and puts sequence numbers on the app-level envelope. Albert therefore treats the sequence high-water mark as app-wide. This is an inference from the documented topology and schema; using local per-tenant contiguity would create false gaps whenever intervening events belonged only to another organisation.
- Every inbox gets an immutable sequence observation: `intent`, `initial`, `contiguous`, `gap`, `overlap`, or `out_of_order`. Exact-body duplicates are detected separately by the inbox unique hash.
- For every matched Albert connection, Albert persists the first and last envelope sequence seen, delivery count, last inbox, and overlap/out-of-order/gap counters. This gives Fleet and tenant-pipeline views their required per-connection webhook health without redefining the vendor's global sequence.
- A true global gap is stored once and atomically enqueues idempotent 32-day `ReconciliationSweep` jobs for Contacts, Invoices, and Credit Notes on every active Xero connection. This intentionally favours a bounded extra read over an undetected missing update. Nightly polling and reconciliation remain mandatory because webhooks are accelerators, not the source of completeness.

### Bound retention and privileges

- Unprocessed encrypted bodies expire after three days (configurable only from one to seven days). Successful processing cryptographically erases nonce, ciphertext and authentication tag immediately; permanent or exhausted failures do the same instead of retaining source payloads for operator inspection. A minute-cadence bounded sweep erases any remaining ciphertext at the cryptographic deadline even when webhook traffic is idle. Tenant-neutral, non-payload operational metadata remains for 14 days by default and is bounded to 30 days. The shorter privacy window deliberately does not mirror Xero's longer vendor replay horizon: scheduled polling and reconciliation sweeps, not retained webhook payloads, are the completeness mechanism.
- Rotation uses one current encryption key ID plus at most four explicitly configured decrypt-only previous keys. Readiness fails if a still-active inbox item references an unavailable key.
- `albert_webhook_control` has no OAuth token-reference or envelope access, no direct Xero inbox/sequence table grants, and no generic queue function. It receives only proof-gated, exact-document webhook procedures; all original Xero lifecycle functions, direct Deputy resolver/readiness functions, and direct enqueue functions are revoked. `service_role`, browsers, semantic, transform and deletion runtimes receive none of them.
- Persisted failures contain a bounded internal error code only. Logs contain inbox/attempt/disposition metadata, never plaintext body, tenant event content, signature, ciphertext, nonce, tag or raw database error messages.

## Consequences

### Positive

- Valid Xero deliveries are acknowledged against one fast durable dependency instead of an unbounded cross-system critical path.
- A multi-organisation payload cannot cross an Albert tenant raw boundary.
- Retries, process death, lease expiry, object-write ambiguity, duplicate queue publication and out-of-order delivery all have explicit idempotent recovery behavior.
- The current Credit Note webhook schema is supported without weakening Contacts or Invoices validation.
- Gap recovery is measurable per connection and automatically restores completeness through the same governed reconciliation path as scheduled polling.
- Compromising the public webhook database login does not grant OAuth credentials or an arbitrary job-enqueue primitive.

### Costs and risks

- The webhook gateway now includes a small always-on processor and a second database pool. Both must be included in health, capacity and shutdown testing.
- A true app-wide gap schedules three sweeps per active Xero connection. Keys make this idempotent, and Xero rate budgets can defer the work, but a large fleet may recover gradually.
- Key rotation must retain prior decrypt-only keys until no active inbox row references them. Removing one early deliberately fails readiness instead of silently discarding data.
- Sequence scope is inferred from Xero's app-wide delivery topology and envelope schema because the public guide does not separately define tenant-local sequence semantics. If Xero later documents a different scope, this ADR and migration must be superseded rather than silently changing the state machine.

## Alternatives considered

- Resolve and route synchronously: rejected because database lookup, S3 and fan-out cannot be kept inside Xero's five-second contract under failure or fleet growth.
- Store the original body beneath every matching tenant: rejected because each copy would contain other organisations' events and violate tenant isolation.
- Store plaintext temporarily in Postgres: rejected because delivery content can contain customer/accounting identifiers and the ingress database is a public-edge trust zone.
- Detect gaps independently per connection: rejected because app-wide sequence numbers can legitimately skip between two payloads containing the same organisation.
- Drop payloads without first persisting bounded failure evidence and scheduling reconciliation: rejected because it would turn an implementation failure into an invisible freshness gap. Permanent failures erase ciphertext immediately but retain non-payload status evidence and are recovered through governed polling/reconciliation.
- Give the webhook role generic `enqueue_sync_job` access: rejected because a compromised edge could construct work for arbitrary tenant/connection pairs. Fixed wrappers validate connector, connection, receipt, stream and identity internally.

## References

- [Xero webhook overview, signature, five-second response contract, retries and replay](https://developer.xero.com/documentation/guides/webhooks/overview/)
- [Xero Webhooks OpenAPI 15.0.0](https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero-webhooks.yaml)
- [Xero Credit Note webhook schema](https://developer.xero.com/documentation/guides/webhooks/credit-notes)
- [Xero March 2026 webhook changelog](https://developer.xero.com/changelog)
- [Xero guidance on reducing polling](https://developer.xero.com/documentation/best-practices/api-call-efficiencies/reducing-polling/)
