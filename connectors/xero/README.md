# Xero connector

## The semantic spec

`tables.json` is the pack's governing artifact: the complete Xero semantic
dictionary — **197 tables, 2,035 columns** — generated from the official
XeroAPI/Xero-OpenAPI specifications at immutable revision
`45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f`, covering accounting, assets,
projects, files, payroll AU/UK/NZ and identity.

Coverage is computed, never claimed. `field-census.json` records the
denominator — every one of the **1,802 read-reachable fields** across those
eight specifications, extracted mechanically and committed so the proof runs
offline — and `coverage.ts` recomputes the numerator from `tables.json` on
every test run:

| | fields | how it is accounted for |
|---|---:|---|
| mapped | 1,739 | a typed staging column citing `api:Object.field`, or a jsonb column declaring it in `coversNested` |
| excluded | 62 | the artifact's `exclusions` ledger, with a reason (rendered-report cells behind the vendor-refused `accounting.reports.read` scope; transport envelopes; RFC 7807 error payloads) |
| unaccounted | 1 | the artifact's `unaccounted` ledger, with a reason (a container array whose contents are materialised by a dedicated scan) |
| **missing** | **0** | — a missing field fails the build |

`tests/contracts/xero-coverage.contract.test.ts` asserts missing is empty, that
no column invents provenance the specification does not document, and that a
gutted artifact would fail — a proof that cannot pass vacuously.

Everything else is derived from that one artifact so nothing can drift from the
dictionary: the scan planner (`scan-plan.ts`), stream contracts (`streams.ts`),
field coverage (`field-coverage.ts`), Zod schemas (`schemas.ts`), the analytical
staging DDL, the sanitized fixtures and the sync engine (`spec-sync.ts` +
`index.ts`). `curated-coverage.ts` is the one hand-reviewed input: the exact
canonical targets and PII classifications of the eleven founding streams, which
no payload shape can imply.

Streams walk each endpoint once per stream: leaders project records 1:1, nested
streams explode declared array paths from the same walk, and fan-out streams
(attachments, history, online invoices, per-employee payroll sub-resources, AU
payslips) iterate parent ids under the org's budget with resumable mid-page
cursors. Explode paths may descend through several arrays —
`Budget.BudgetLines.BudgetBalances` — and each row keeps its enclosing objects
reachable, because a budget balance is meaningless without the AccountID that
lives on its line. Fan-out chains may be more than one link deep (a working
week hangs off a working pattern, which hangs off an employee) and the cursor
records the index at every level, so a claim that exhausts its request budget
resumes at the next unvisited parent rather than replaying the traversal.

UK/NZ payroll share one base path and are gated on the organisation's region
before any request is issued; assets walk one pass per required status filter;
the granted TenNinetyNine report walks one pass per amendable filing year;
contacts include archived records and bank transfers include deleted legs, so
merge and deletion truth is never lost.

`tests/contracts/xero-full-backfill.contract.test.ts` drives all 197 streams
through the real engine against the sanitized recording and fails on any stream
that walks its endpoint and projects nothing — the failure mode where a
connector reports success while a staging table stays empty forever.

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
silently changing the OAuth boundary. Xero's PKCE token, refresh, and revocation
contracts authenticate the public client with
`Authorization: Basic base64(client_id + ":")`; the trailing colon is required
and no client secret is sent. Token and refresh bodies also carry the documented
`client_id`. Refresh tokens rotate on every refresh
and the encrypted credential vault must compare-and-swap the new pair;
Xero's documented 30-minute old-token grace window is only a recovery window,
not normal operation. Disconnect deletes the selected Xero connection by its
connection ID (without surprising the user by revoking unrelated tenants) and
then destroys Albert's local credential.

Xero introduced granular Accounting API scopes in March 2026. Albert requests
every read scope the app is entitled to plus `offline_access`, and no write
scope at any tier — the pack contains no source write method, so a write grant
could only exceed what the code can use. The set is deliberately wider than V1
extraction (payroll, files, assets, projects, budgets, attachments and 1099
reports have no declared stream yet) so that widening ingestion later never
forces customers back through a re-consent. Verified against the live authorize
endpoint on 2026-08-06: Xero refuses `accounting.transactions[.read]`,
`bankfeeds` and `finance.*` for granular-scope apps, so requesting any of them
would fail the whole authorization. `accounting.reports.read` is refused on the
same Advanced-tier basis as Journals and is omitted until Xero grants it.

The general-ledger Journals endpoint is
an Advanced-tier feature requiring initial and annual security assessment plus
use-case approval. Its scope is omitted by default and is requested only when
`XERO_ENABLE_ADVANCED_JOURNALS=true`; until that approval exists Xero rejects
the authorization outright, so the flag must stay `false`. Merely having other finance streams is not
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

## Observed on a live tenant (2026-08-08)

Facts from a full backfill of a real organisation, recorded because two of them
contradict the vendor documentation and all four change how a backfill is
planned:

- **The daily allowance did not reset at midnight UTC.** Xero documents a
  midnight-UTC reset; `X-DayLimit-Remaining` was observed decrementing straight
  through 00:00 UTC without refilling, so it behaves as a rolling window. Plan a
  backfill against a budget that refills gradually, not one that returns in full
  at a known hour, and probe before spending.
- **The daily allowance is 1,000, not 5,000.** This is the uncertified-app tier.
  A complete pull is therefore budget-bound, not latency-bound: walking each of
  the 197 streams separately would spend ~800 calls on page verification alone
  and still not finish. `scripts/xero-full-ingest.mts` walks each endpoint once
  and projects every table from that payload — the scan plan's whole purpose.
- **Four endpoints answer 401, not 403, when the scope is absent.** `Journals`
  (Advanced tier), `ExpenseClaims`, `Receipts` and `PaymentServices` all need
  scopes Xero refuses to granular-scope apps. Classify 401 alongside 403/404 as
  an unavailable capability; treating it as a failure retries something that can
  never succeed without a change to the app registration itself.
- **History costs one call per document and has no "do I have any" flag.** For a
  tenant with ~35,600 documents that is roughly five weeks of the entire daily
  allowance, so it is opt-in (`--include-history`). Attachments are gated on
  `HasAttachments` and cost almost nothing by comparison — two documents in that
  whole organisation had one.

Payroll region matters at the transport layer: UK and NZ share
`/payroll.xro/2.0`, so a driver that walks payroll endpoints without first
reading the organisation's `CountryCode` will stage one region's payroll into
all three regions' tables. The connector gates on region before any payroll
request; any other driver must do the same.

Xero contractually restricts using API data for AI training. This connector
inherits Albert's mandatory platform-wide no-training policy.

Unknown additive fields remain in immutable raw storage, raise schema-drift,
and are excluded from the manifest-approved staging projection. Invalid core
schemas or exact-decimal normalization failures are quarantined.
