# ADR 0087: Shopify schema-driven Admin GraphQL ingestion and CubeCore semantics

- Status: Accepted
- Date: 2026-08-12
- Supersedes: the Shopify authorization-only admission in migrations 0085/0086
- Complements: ADR 0085 (generation-bound manual ingestion activation)

## Context

Shopify's REST Admin API is legacy. New public applications must use Admin
GraphQL, whose schema, access gates, cost model and analytics surfaces change by
version. A hand-maintained list of popular order fields cannot support Albert's
product promise: merchants must be able to ask about any documented Shopify
field without an inaccessible field being silently represented as null or zero.

The 2026-07 official Admin GraphQL schema contains thousands of output fields,
many of which are conditional on OAuth scopes, protected-customer-data approval,
shop plan/features, staff permissions, ownership by the calling app, required
arguments, or private/deprecated status. ShopifyQL is a separate official
analytics surface with its own schemas and requires `read_reports` plus Level 2
protected-customer-data approval. Direct `Order` access is limited to 60 days
unless `read_all_orders` is separately approved. Inventory states that do not
emit webhooks require scheduled API reconciliation.

## Decision

### Versioned sources of truth

Pin every vendor request to Admin GraphQL `2026-07`. Generate and commit an
offline, deterministic registry from Shopify's official schema proxy. The
registry captures the complete type graph, output/input fields, arguments,
enums, descriptions, deprecations, access requirements, protected-data markers,
interfaces and possible types, together with a SHA-256 drift identity. Generate
the ShopifyQL registry independently from the official 2026-07 schema pages.

Contract tests recompute registry counts and hashes and provide `--check` modes
against the official sources. An API version upgrade is therefore an explicit,
reviewable schema migration rather than an ambient runtime change.

### Read-only, manual-start ingestion

OAuth authorization and ingestion consent are separate lifecycle events.
Shopify uses `initialStart: manual`; a successful callback stores and may rotate
credentials but enqueues no source request. An owner or manager must select
**Start ingestion**. Activation is fenced to the current connection generation,
audited and published atomically with its idempotent initial-backfill request.
Reauthorization clears the fence, so stale consent cannot activate a new grant.

The production connector:

- binds every credential and request to one validated `*.myshopify.com` host;
- uses expiring offline access tokens and compare-and-swap refresh rotation;
- calls only `/admin/api/2026-07/graphql.json` with read-only scopes;
- uses bounded cursor pagination, holds each incremental high-water mark fixed
  until its opaque result-set cursor is exhausted, then advances the watermark
  atomically, with recent-first history and reconciliation sweeps;
- honours GraphQL calculated cost/throttle status and fails closed on partial
  GraphQL errors;
- verifies webhook HMAC, shop identity and event identity, while treating
  webhooks as accelerators rather than the authority for complete inventory;
- reports 60-day order history, protected data and optional modules as explicit
  coverage boundaries when the relevant approval is absent;
- fails closed when an order/return/refund nested selection reaches Shopify's
  fixed 250-item selection limit. Until a separately reviewed narrower query is
  implemented, the affected stream is explicitly unavailable rather than
  silently truncated or represented as complete.

### Typed staging and canonical integration

Land sixteen typed relations in tenant-isolated `source_shopify`. Curated
streams cover shop, locations, products, variants, customers, orders, lines,
transactions, refund lines, inventory levels, fulfilments, returns and
discounts. Cursor-paginated metafield-definition and metafield-value relations
cover the eight owner types inside the default least-privilege surface. All 26
official owner types have an explicit live/definition-only scope, plan,
permission, app-ownership, or enumerator disposition. A governed
`shopify_fields` relation materialises every official output-field definition,
all input-object fields, field arguments, and enum options before live
observations. Input/argument/enum rows are query-construction definitions, not
merchant values. Runtime observations preserve scalar kind, ordinal and JSON
pointer so repeated values cannot collide.

The same governed relation materialises every documented ShopifyQL metric,
dimension, MATCHES expression and MATCHES condition field, plus each official
FROM-only documentation gap. These remain definition-only unless a separately
approved and validated ShopifyQL query observes store results; metadata is
never represented as store data.

Every official field has a disposition. A field is answerable as either:

1. an observed, typed store value;
2. an official definition with its exact availability requirement; or
3. a read-only exclusion (for example mutation output or privately documented
   surface) with a precise reason.

Unknown or unresolved paths are redacted. Definition-only rows are never
treated as observed null values.

Metafield literals are ingested only into tenant/connection-bound private
staging. Because merchants can place personal or confidential content in any
namespace, every literal form is unclassified sensitive data. Cube projects
typed nulls for string, JSON, numeric, boolean, datetime, digest and raw forms;
the generic field EAV applies an independent source-object redaction guard.
Public semantics expose definition, presence, type, size and freshness only.

Project grain-safe commerce facts and conformed dimensions into the existing
canonical model: channels, locations/stock locations, products/variants,
customers, orders, order lines, payments, refund lines and daily inventory
snapshots. Fulfilment, return, discount and schema observations remain governed
lookup metadata until a canonical fact exists. Historical line cost remains
unavailable rather than substituting current inventory cost.

### CubeCore semantic contract

All physical Shopify source cubes are private. Public CubeCore views expose
grain-safe order, line, payment, refund, fulfilment, return, inventory, customer,
catalogue, variant, discount and field-coverage analytics. Joins are permitted
only where cardinality is proven; measures that cross grains are not published.
Protected data is private/redacted by default.

Agent routing rules prefer canonical cross-source entities, use Shopify-native
views for Shopify-only detail, and use the field registry for coverage and
availability questions. Certified queries define stable store-health,
merchandising, customer, fulfilment, refund, payment and inventory analyses.

## Consequences

- Shopify schema drift is visible and reviewable, and all 2026-07 output fields
  remain semantically addressable even when merchant access is unavailable.
- All 2,949 input-object fields, 4,321 field arguments and 5,404 enum options
  are definition-answerable without being misrepresented as live store values.
- Users initiate the first vendor read explicitly; no successful OAuth callback
  starts ingestion automatically.
- Optional scopes and Level 2 protected-data access must be approved and granted
  before Albert can return those store values. Albert explains the boundary
  instead of fabricating completeness.
- Definition census plus curated extraction costs more storage than a narrow
  connector, but preserves auditability and supports precise natural-language
  answers.
- A high-cardinality order, return or refund can block its affected stream at a
  250-item nested selection boundary. This is an explicit availability failure,
  not partial data. Shopify publishes ID lookups for several child objects, but
  a truncated parent list cannot discover the omitted child IDs, and the
  `Order.transactions` list has no cursor; an ID follow-up is therefore not a
  generic completeness repair. A separately reviewed discovery/pagination
  strategy is required per affected grain.
- ShopifyQL is an official metric-validation plane; direct Admin GraphQL remains
  the raw-detail plane. Neither is allowed to silently substitute for the other.
- A future API-version upgrade must regenerate both registries, validate every
  query, update staging/Cube contracts and pass the field-coverage gate before
  production release.

## Official sources

- <https://shopify.dev/docs/api/admin-graphql/2026-07>
- <https://shopify.dev/docs/api/usage/bulk-operations/queries>
- <https://shopify.dev/docs/api/usage/limits>
- <https://shopify.dev/docs/api/usage/versioning>
- <https://shopify.dev/docs/api/usage/access-scopes>
- <https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens>
- <https://shopify.dev/docs/apps/launch/protected-customer-data>
- <https://shopify.dev/docs/api/admin-graphql/2026-07/queries/shopifyqlQuery>
- <https://shopify.dev/docs/api/shopifyql/2026-07/schemas>
- <https://shopify.dev/docs/apps/build/graphql/migrate/learn-how>
