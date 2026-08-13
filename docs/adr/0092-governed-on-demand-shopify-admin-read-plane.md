# ADR 0092: Governed on-demand Shopify Admin read plane

- Status: Accepted
- Date: 2026-08-12
- Owners: Albert analytics and connector runtime
- Supersedes: None

## Context

CubeCore is authoritative for canonical business concepts and ShopifyQL is the
governed route for Shopify-calculated reports. Shopify Admin GraphQL still has
thousands of merchant object fields that are not sensible to ingest eagerly.
Answering exact store-object questions requires a live route, but raw GraphQL
in a browser, model, Cube process or web process would violate Albert's typed
execution boundary and expose a mutation-capable schema.

The sole schema authority is the committed Shopify Admin GraphQL 2026-07
registry generated from Shopify's official introspection proxy. It contains
3,544 types, 9,291 output fields, 2,949 input fields, 4,321 field arguments and
5,404 enum options. Shopify documents access scopes and protected data on the
schema; actual availability still depends on the installed app's current
grant, staff permissions, plan, feature availability and app ownership.

Sources:

- [Admin GraphQL API 2026-07](https://shopify.dev/docs/api/admin-graphql/2026-07)
- [GraphQL pagination](https://shopify.dev/docs/api/usage/pagination-graphql)
- [API rate limits](https://shopify.dev/docs/api/usage/limits)
- [Access scopes](https://shopify.dev/docs/api/usage/access-scopes)
- [Protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)

## Decision

Albert exposes three owner/manager-only tools: tenant-bound store metadata,
registry catalogue search and a typed Admin read query. The store catalogue
returns only a display name, opaque connection ULID and generation; an explicit
connection ID is accepted only after that catalogue was authorized in the same
tenant, conversation and turn. Shop domains and vendor identifiers never reach
the model. The query input can name only registered fields,
registered arguments and registered interface/union members. Every argument is
represented as a discriminated typed value and decoded against its registry
type. No input accepts GraphQL text, a mutation, token, shop domain, HTTP
endpoint, SQL, alias, directive or executable fragment.

The production path is:

```text
authenticated /api/v3-conversation
  -> typed Shopify Admin tools
  -> dedicated HMAC client
  -> sync-worker Admin endpoint
  -> active owner/manager membership revalidation
  -> explicit manual-activation + generation + deletion/readiness fence
  -> connection + credential generation reservation
  -> protected-member deny gate (catalogue definitions remain searchable)
  -> stored-grant scope validation
  -> credential-owning Shopify connector
  -> live currentAppInstallation access-scope validation
  -> Admin GraphQL 2026-07 query
  -> pre-vendor and post-vendor authorization/activation revalidation
  -> metadata-only audit finalization
```

The dedicated `ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET` must differ from OAuth,
ShopifyQL and semantic secrets. Requests are one-use and limited to four live
queries and six registry searches per turn. Each query has at most six nested
selection levels, 40 selected registry fields, 100 connection-node exposure,
200 returned leaves, 256 KiB and a 25-second worker deadline. Connections must
use explicit forward `first` pagination of at most 50. Shopify's normal cost
throttle and Albert's durable vendor budget remain authoritative.

Only `QueryRoot` is usable. Mutations, generic `node`/`nodes`, ShopifyQL,
privately documented or access-restricted members, mutation payloads, raw JSON
payload fields, theme bodies and unclassified `Metafield.value`,
`Metafield.jsonValue` and `Metafield.compareDigest` fail closed. This prevents
the generic runtime from bypassing Cube's metafield redaction policy.

Shopify-marked protected parent types, fields, or returned types are
definition-answerable but are not live-executable in this release, even when a
durable Level-2 approval exists. The ordinary conversation event and privacy
export architecture does not yet provide a reviewed no-retain/export-complete
path for these values. Failing closed prevents a protected value from entering
model context or a persisted trace. Credential-bearing members and objects
(`Shop.analyticsToken`, storefront/delegate access tokens, app/client keys and
Shop Pay receipt tokens) are separately denied at every nested path.

Stored OAuth scopes are an early gate; a
`currentAppInstallation.accessScopes` selection in the same vendor operation
proves the live grant. Official access alternatives are evaluated as OR within
each documented group and AND across independent groups. Permission, plan,
ownership and feature restrictions that are not mechanically decidable remain
explicit limitations; Shopify's access error becomes Unavailable, never a zero
or null claim.

Audit rows retain only tenant/actor/role/turn identity, connection generation,
API/registry/query digests, selected-field count, required scopes, protection
status, approval/scope evidence digests, result counts, byte counts, duration
and outcome. GraphQL text, variables, result values, credentials, tokens and
shop domains are never stored in the audit ledger. Admitted public results are
never dashboard-replayable. Every merchant-supplied result value (including
names, notes, URLs, text and HTML) is untrusted data, never an instruction.
Exact decimal/money/unsigned-integer strings stay strings and are never coerced
into lossy JavaScript numbers.

This route is question-time read execution only. It does not activate manual
ingestion, enqueue a sync or write to Shopify. The pinned definition catalogue
remains searchable before **Start ingestion**, because it contains no merchant
data. Store listing and execution require manual activation for the exact
current generation with no block reason or blocked readiness. If revocation or
a deletion-continuity block races an in-flight request, post-vendor validation
suppresses the result; only the code-only failed audit outcome may be finalized
without the now-stale live binding.

## Consequences

- Every public 2026-07 query field and nested output definition is discoverable;
  values are callable when its typed arguments, access, permissions, plan,
  ownership and privacy constraints can be satisfied safely.
- CubeCore remains preferred for canonical metrics; ShopifyQL remains preferred
  for reports; this plane closes long-tail merchant-object value gaps.
- Inputs that cannot be represented from official type metadata fail closed.
  In particular, opaque Shopify search strings and generic node access are not
  accepted until a separately parsed, documented grammar exists.
- Production readiness requires control migration 0134 and the independent
  signing secret in both web and sync-worker deployments.
