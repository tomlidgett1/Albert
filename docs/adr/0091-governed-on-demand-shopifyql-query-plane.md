# ADR 0091: Governed on-demand ShopifyQL query plane

- Status: Accepted
- Date: 2026-08-12
- Owners: Albert analytics and connector runtime
- Supersedes: None

## Context

The canonical CubeCore model remains the preferred interface for concepts it
already defines. Shopify also exposes store-calculated reports that cannot be
reconstructed safely from ingested objects alone: sessions, search behaviour,
conversion, attribution, cohorts, web performance and some profitability
calculations. Albert V3 needs those official values without giving a model,
browser, web process or Cube a Shopify credential or a free-form query channel.

The source of truth is Shopify's pinned 2026-07 documentation and the committed,
deterministically generated `shopifyql-2026-07.json` registry. In particular:

- [`shopifyqlQuery`](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/shopifyqlQuery)
  requires `read_reports`, requires Level-2 protected-customer-data access, and
  returns `parseErrors` plus table columns, rows and row metadata.
- [ShopifyQL syntax](https://shopify.dev/docs/api/shopifyql/2026-07/syntax)
  defines the only admitted schemas, clauses and operators.
- [`WHERE` and `MATCHES`](https://shopify.dev/docs/api/shopifyql/2026-07/syntax/where)
  define unquoted absolute date values and comma-separated, unique MATCHES
  parameters.
- [`GROUP BY`](https://shopify.dev/docs/api/shopifyql/2026-07/syntax/group-by),
  [`TIMESERIES`](https://shopify.dev/docs/api/shopifyql/2026-07/syntax/timeseries),
  and [`HAVING`](https://shopify.dev/docs/api/shopifyql/2026-07/syntax/having)
  define result-dimension and post-aggregation constraints.

## Decision

Albert uses a typed, read-only ShopifyQL intermediate representation. It admits
exact registry schema/field/MATCHES names and enumerated operators only. It
requires explicit calendar dates, caps the inclusive range at 366 days, caps
results at 250 rows and 512 KiB, caps the compiled query at 8 KiB, and allows at
most six catalogue searches and six executions per conversation turn. The
compiler escapes strings, renders registry-typed numeric/Boolean/timestamp
literals. A separately reviewed privacy policy classifies every official static
field, MATCHES parameter and queryable-metafield pattern. The compiler applies
the same denial to `SHOW`, `GROUP BY`, `TIMESERIES`, `WHERE`, `HAVING` and
`ORDER BY`, and applies it independently inside `MATCHES`. Registry identity,
all merchant-defined metafields, direct customer/person values, addresses,
payment/linkage values, URL/token/free-text values, individual-customer
behaviour and exact/minute/second timestamps fail closed. The public tool
contract contains no raw ShopifyQL, GraphQL, SQL, URL-as-endpoint, credential,
token or shop-domain parameter.

The privacy review is bound both to the official registry digest and to a
second digest over every definition plus its classification. Execution stops
if either digest or any exact count changes; catalogue search still returns the
official definition and its allowed/denied disposition so unsupported questions
can be explained without retrieving a merchant value.

The production call path is:

```text
authenticated /api/v3-conversation
  -> typed Albert V3 ShopifyQL tools
  -> HMAC-signed request bound to tenant/actor/role/conversation/turn
  -> sync-worker ShopifyQL endpoint
  -> active owner/manager membership revalidation
  -> app-client-bound Level-2 approval evidence + read_reports check
  -> explicit manual-activation + generation + deletion/readiness fence
  -> connection/generation reservation and durable per-turn ledger
  -> immediate pre-vendor and post-vendor binding revalidation
  -> credential-owning Shopify connector
  -> Admin GraphQL 2026-07 shopifyqlQuery
```

The sync worker is the only process that resolves the encrypted credential. The
HMAC secret is dedicated to this boundary and must differ from OAuth and
semantic-service secrets. Requests are one-use. A transaction-scoped advisory
lock serializes count-and-reserve for each tenant/conversation/turn. The
existing durable vendor-rate budget, bounded retry logic and a 35-second
application deadline govern vendor cost and throttling.

Both catalogue and query calls revalidate an active database membership and
permit only the signed role `owner` or `manager`. Caller-provided approval flags
are not accepted. Level-2 evidence is an operator-controlled, app-client-ID-hash
bound record protected by FORCE RLS. A successful Shopify execution remains the
final vendor-side proof that access is actually available.

Results retain the pinned API version, registry digest, query digest,
connection generation, approval evidence digest, field definitions, columns,
rows, privacy-minimised row metadata, parse errors, duration and response digest.
Shopify's `rawResourceIds` row-linkage metadata is stripped at the credential
boundary before the service or conversational runtime receives it. The audit ledger
stores only metadata and digests: never compiled query text, filter literals,
result rows, credentials or shop domains. Protected live results have no
Dashboard replay contract, preventing later background replay outside the
fresh authorization path.

ShopifyQL is complementary to CubeCore, not a second general query language.
V3 prefers canonical Cube views where they cover the question and uses this
plane for Shopify-native reporting values. No Shopify ingestion activation or
sync enqueue occurs anywhere in this path. The offline definition catalogue
remains available before activation, but no merchant connection is eligible and
no vendor request can be reserved until an owner or manager explicitly chooses
**Start ingestion** for the current generation. A deletion-continuity or
blocked-readiness state makes the binding stale. Post-vendor revalidation
suppresses a result when revocation races an in-flight request; only its
code-only failed audit status can then be terminalized. OAuth and manual
ingestion remain separate lifecycle events under ADR 0085.

## Consequences

- Shopify-native analytics can be answered from Shopify's own 2026-07 values
  even when they are not reconstructable from the canonical warehouse.
- Every one of the 2,327 static registry fields remains definition-searchable.
  Execution allows 1,668 fields (all 349 aggregate metrics and 1,319 reviewed
  dimensions) and denies 659 dimensions. Three FROM-only schemas remain
  non-executable because Shopify does not publish their field contracts. All
  five merchant-defined metafield patterns are definition-searchable but denied.
- Of 211 MATCHES condition fields, 149 are allowed and 62 resource-identity or
  coordinate fields are denied.
- This is a direct-identifier, linkage and high-granularity prevention boundary,
  not formal anonymisation. An allowed aggregate grouped by coarse dimensions
  (for example a day, cohort, geography, campaign category or product label)
  can still describe a single person or order in a small store or sparse slice.
  Albert does not currently add k-anonymity thresholds, noise, cell suppression
  or cross-query inference budgets; questions requiring that guarantee are out
  of scope for the live ShopifyQL plane and should use governed canonical
  aggregates with an appropriate publication policy.
- Deployment must apply control-plane migration 0133 and record current Level-2
  evidence before the worker/web release can be considered ready.
