# Xero connector

Pinned against official Xero documentation retrieved **2026-08-03**:

- [PKCE flow](https://developer.xero.com/documentation/guides/oauth2/pkce-flow)
- [Granular OAuth scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/)
- [Refresh-token rotation and revocation](https://developer.xero.com/documentation/guides/oauth2/token-types)
- [API limits](https://developer.xero.com/documentation/guides/oauth2/limits/)
- [Paging](https://developer.xero.com/documentation/best-practices/api-call-efficiencies/paging)
- [Webhook signing and delivery](https://developer.xero.com/documentation/guides/webhooks/overview/)
- [July 2026 changelog](https://developer.xero.com/changelog)
- [Official Accounting API SDK reference](https://xeroapi.github.io/xero-node/accounting/index.html)

Albert V1 supports only Xero's public **Auth Code with PKCE** grant. Registering
a confidential client or supplying a client secret is rejected rather than
silently changing the OAuth boundary. Refresh tokens rotate on every refresh
and the encrypted credential vault must compare-and-swap the new pair;
Xero's documented 30-minute old-token grace window is only a recovery window,
not normal operation. Disconnect deletes the selected Xero connection by its
connection ID (without surprising the user by revoking unrelated tenants) and
then destroys Albert's local credential.

Xero introduced granular Accounting API scopes in March 2026. Albert requests
only read scopes plus `offline_access`. The general-ledger Journals endpoint is
an Advanced-tier feature requiring initial and annual security assessment plus
use-case approval. Its scope is omitted by default and is requested only when
`XERO_ENABLE_ADVANCED_JOURNALS=true`. Merely having other finance streams is not
treated as ledger coverage: `finance.general_ledger` remains Unknown until a
live Journals request succeeds, and is Unavailable if its scope is absent or the
endpoint returns 403. This must map to an Unavailable or explicitly Qualified
answer, never a silent partial result.

Official webhook coverage currently includes Contacts, Invoices and Credit
Notes (the founding spec's Contacts/Invoices list was planning-grade). Webhooks
are verified over the exact raw body with HMAC-SHA256/base64, act only as sync
accelerators, and never replace polling or reconciliation. Xero's 5 concurrent,
60/minute and tier-dependent 1,000/5,000 daily limits are respected with a
concurrency gate, response-aware retries, compact paging and raw replay.
Paged endpoints use the documented 1,000-record page size and continue until an
empty page; Journals continue by monotonic `JournalNumber` offset as required.
Incremental filter watermarks are held fixed until the whole page window closes,
preventing records from being skipped between pages.

The production webhook route follows [ADR 0008](../../docs/adr/0008-xero-webhook-durable-ack-first-inbox.md).
It returns 2xx only after the bounded, schema-valid exact body has been
HMAC-verified, AES-256-GCM encrypted and committed to the tenant-neutral inbox.
Tenant lookup, category partitioning, immutable raw writes and fixed-function
queue publication happen under a renewable database lease afterwards. This
keeps Xero's documented five-second acknowledgement independent from S3 and
fan-out latency. App-level sequence gaps enqueue idempotent 32-day
reconciliation sweeps; per-connection first/last sequence and gap counters are
retained for operational health.

Credit Note events use Xero's March 2026 category-specific schema and require
the documented `data.Type` and `data.Status`. Contacts and Invoices retain the
base event schema. Subscription events are valid at the app endpoint but are
not routed into an Albert accounting stream.

Xero contractually restricts using API data for AI training. This connector
inherits Albert's mandatory platform-wide no-training policy.

Unknown additive fields remain in immutable raw storage, raise schema-drift,
and are excluded from the manifest-approved staging projection. Invalid core
schemas or exact-decimal normalization failures are quarantined.
