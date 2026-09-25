# Shopify production connector

The connector is pinned to Shopify Admin GraphQL `2026-07`. REST Admin is not
used. Its source contracts were reviewed against Shopify's official docs on
**2026-08-12**:

- [Admin GraphQL 2026-07](https://shopify.dev/docs/api/admin-graphql/2026-07)
- [Authorization code grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant)
- [Expiring offline access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens)
- [Access scopes](https://shopify.dev/docs/api/usage/access-scopes)
- [GraphQL limits](https://shopify.dev/docs/api/usage/limits)
- [Bulk query limits](https://shopify.dev/docs/api/usage/bulk-operations/queries)
- [Protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)
- [ShopifyQL schemas](https://shopify.dev/docs/api/shopifyql/2026-07/schemas)

## Connection and explicit activation

OAuth authorization and data ingestion are intentionally separate. A
successful callback stores the credential and shows the store as connected,
but does not enqueue or execute a Shopify data request. An owner or manager must
choose **Start ingestion**. The activation RPC fences consent to the current
connection generation and publishes its idempotent `InitialBackfill` job in the
same transaction. Reauthorization advances the generation and requires another
explicit activation.

That consent boundary also governs the live question-time planes. Before
**Start ingestion**, the offline Admin GraphQL and ShopifyQL schema catalogues
remain searchable because they contain only pinned official definitions, but
the store selector returns no inactive store and neither the Admin nor
ShopifyQL runtime may reserve or execute a vendor request. Every reservation is
bound to `ingestion_start_mode='manual'`, a non-null activation timestamp, the
current activated generation, and an empty block reason. Membership, activation,
generation, protected-data approval, and blocked readiness are revalidated
immediately before and after a vendor call; a concurrent revocation or
deletion-continuity block suppresses the response. Only the code-only failed
audit outcome may be terminalized after such a block—merchant result values are
never written to the audit ledger.

Shopify retains its Admin events ledger for only one year. Albert preserves an
independent destroy-event watermark and checks it before each deletion-enabled
resource request. If the watermark is missing, older than the retention window,
or cannot be proven continuous across a connection generation, ingestion stops
and an analytical publication fence immediately hides every row for that exact
store from all private Shopify Cubes. Rotating or reauthorizing the token does
not clear either fence and **Start ingestion** remains unavailable.

The executable recovery path is deliberately destructive: choose **Disconnect**,
wait until Albert reports that verified local deletion has completed,
reconnect the Shopify store, then explicitly choose **Start ingestion**. The
verified purge removes the old credential, raw, typed, canonical, derived and
queryability state; reconnect creates a fresh connection identity. Do not
reconnect while deletion is pending, and do not treat a successful OAuth refresh
as deletion-continuity recovery.

The shop's normalized `*.myshopify.com` domain is bound to the OAuth session,
encrypted credential metadata, connection identity, callback HMAC check, and
every API request. A custom domain or attacker-controlled look-alike cannot be
used as an OAuth or token host.

## Credentials and access

### Compliance and lifecycle webhooks

Shopify's three mandatory privacy topics and `app/uninstalled` use the
always-on gateway endpoint `/v1/webhooks/shopify/compliance`. The app-specific
subscription template is in `shopify.app.toml.example`; deploying that app
configuration is a separate operator release step. The endpoint validates the
raw-body HMAC with the app client secret, accepts only API version `2026-07`,
deduplicates with `X-Shopify-Webhook-Id`, and persists only a minimal attested
identifier/hash envelope. It never stores the source payload or enqueues a data
sync. Invalid HMACs return `401`.

Customer data access/redaction requests enter the dedicated durable privacy
queue with Shopify's 30-day due date; receipt is not evidence of fulfilment.
The existing least-privilege deletion worker claims that queue. A
`customers/redact` request immediately fences the exact connection generation
and, because immutable raw JSONL is connection/batch-grain, conservatively
purges the entire Shopify connection through the normal proof-producing
deletion workflow. This destroys Albert's local OAuth credential, typed and
canonical data, derived artefacts, raw objects and indexes. It is deliberately
disruptive: the merchant must reconnect, explicitly select **Start ingestion**,
and rebuild after completion. Albert does not claim remote Shopify token
revocation; ordinary app uninstall is a separate lifecycle event.

`customers/data_request` creates one durable case per bound connection. An
internal operator requests a one-use, ten-minute export grant; the signed
operator-diagnostic service runs only fixed Shopify customer/order queries and
returns a no-store JSON artifact with a persisted SHA-256 digest and record
count. Typed `raw_node`, the long-tail field plane and matching normalized
source records carry the queried source payload values into the artifact.
Customer-owned metafield literals are included with namespace, key, type and
every stored typed/JSON value form; the
export is not limited to curated scalar columns. The exporter preflights an
explicit 50,000-record / 32 MiB bound and fails to operator attention rather
than truncating. HMAC-only identities that cannot address stored analytical
rows also fail closed. Producing the artifact moves the case only to
`awaiting_delivery`.
Completion requires separate evidence that an operator delivered that exact
artifact through an approved secure channel. Open, overdue and
attention-required cases are exposed in worker metrics and the operator API.
`shop/redact` and `app/uninstalled` atomically revoke the connection's ingestion
activation and enqueue the existing full connection-deletion workflow. No
operational Shopify webhook is registered by this connector: API polling and
reconciliation begin only after the explicit **Start ingestion** action.

Official references: [privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance),
[webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries),
[delivery headers](https://shopify.dev/docs/apps/build/webhooks/delivery-structure),
and [subscription configuration](https://shopify.dev/docs/apps/build/webhooks/subscribe).

The browser request omits `grant_options[]`, which is Shopify's documented
offline-access default. Code exchange requests `expiring=1` using form encoding.
Access tokens are treated as 60-minute credentials and refresh tokens as
rotating, one-use 90-day credentials. Refresh writes use the credential vault's
compare-and-swap lease so concurrent workers cannot overwrite a newer token.

Only reviewed `read_*` scopes are accepted. The ordinary-store default includes
products, orders, customers, inventory, locations, fulfilments, returns,
discounts, price rules, and reports. `read_all_orders`, payments, B2B,
subscriptions, POS cash, store credit, staff, gift cards, and other gated
modules remain optional. Missing scope, plan, protected-data approval, or staff
permission is an explicit availability boundary and is never represented as a
zero.

`SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` must be configured together in
the Vercel web and sync-worker environments. The redirect URI is derived from
`ALBERT_PUBLIC_ORIGIN` and validated by the worker. Never place a Shopify access
or refresh token in application configuration; both are stored only by the
encrypted credential vault.

## Ingestion and completeness

Sixteen tenant-isolated typed streams cover shop, locations, products,
variants, customers, orders, lines, transactions, refund lines, inventory
levels, fulfilments, returns, discounts, metafield definitions, metafield
values, and the schema-driven long-tail field plane. All requests target:

```text
https://{shop}.myshopify.com/admin/api/2026-07/graphql.json
```

The runtime uses bounded cursor pages, modified-time watermarks, exact decimal
money values, source totals, reconciliation, calculated-query-cost throttling,
and fail-closed handling for partial GraphQL responses. A nested Shopify list
that reaches its fixed safety limit blocks completion instead of being silently
truncated. Orders with 250 or more transactions or fulfilments, returns whose
nested return/refund lists reach 250, and refunds or refund-line lists reaching
250 are therefore an explicit availability boundary: that stream remains
blocked until a narrower reviewed query is shipped. Direct order history is
labelled as 60-day-only unless the grant has the separately approved
`read_all_orders` scope.

Metafield definitions and values use two independent, cursor-paginated typed
streams. The live least-privilege scan covers eight owner types already inside
Albert's default grant: shop, product, variant, collection, location, order,
discount, and customer. Every one of the 26 official `MetafieldOwnerType`
values has a machine-readable live/definition-only policy with its exact scope,
plan, permission, app-ownership, or enumerator boundary. Definition/value
pagination completes each owner and each definition before advancing its
cursor. Literal strings, parsed JSON, numbers, booleans, dates, digests, and
raw nodes remain tenant/connection-bound in typed staging and are classified as
untrusted sensitive data. Public Cube views expose only definition and
presence/type/size/freshness metadata; every literal form is null by
construction and again redacted in the generic field EAV model.

Operational Shopify data webhooks are not registered by the current production
app configuration. Polling and reconciliation begin only after manual
activation and remain the completeness authority, particularly for inventory
states that do not emit webhooks. Any future operational subscription manager
must be separately generation-bound to that activation; OAuth completion may
not register it. Privacy and uninstall topics are always accepted by the
dedicated compliance boundary and never trigger fresh extraction.

## Complete field and analytics registries

`generated/admin-graphql-2026-07.json` is a deterministic offline registry of
the official schema: 3,544 named types and 9,291 object/interface output
fields, plus deprecations, access gates, protected-data metadata, interfaces,
and possible types. Every output field receives an exact merchant-value
disposition. The `shopify_fields` stream also materializes all 2,949
input-object fields, 4,321 field arguments, and 5,404 enum options as
definition-only query-construction records. Those 12,674 definitions are
searchable but never counted as store-value observations. Definitions are
materialized offline before the first vendor request; live observations then
preserve type, JSON pointer, repeated-value ordinal, access requirements, and
an exact availability reason.

`generated/shopifyql-2026-07.json` indexes all 41 official `FROM` names: 38
field-reference schemas and three explicitly field-undocumented names. The
`shopify_fields` stream materializes its 349 metrics, 1,978 dimensions,
MATCHES conditions, formulas, deprecations, and official documentation gaps as
definition-only semantic records before any store request. ShopifyQL requires
`read_reports` plus Level 2 protected-customer-data approval. It is metric
semantics and validation metadata; because Shopify documents no cursor or
incremental contract for its table response, it is not misrepresented as a
generic raw-ingestion substitute or as observed store values.

## Canonical and CubeCore projection

Shopify products, taxonomy assignments, variants, customers, orders, lines,
payments, refund lines, locations, channels, and daily inventory balances map
into Albert's existing canonical model. Shopify-specific fulfilment, return,
discount, catalogue, and exhaustive-field details remain at their correct
native grains. Current inventory cost is never substituted for historical line
cost.

All physical Cube models are private. Public, grain-safe views cover sales,
product sales, payments, refunds, fulfilment, returns, inventory, customers,
catalogue, variants, discounts, store configuration, and governed field
coverage. Metafield views expose safe catalogue and populated-owner metadata,
never merchant-defined literals. Protected and unclassified values are
private/redacted by default, and certified queries plus agent rules select the
correct view without cross-grain fan-out.

## Verification

Run the deterministic vendor checks and focused production contracts with:

```sh
npm run shopify:schema:check
npm run shopify:queries:check
npm run shopifyql:schema:check
node --import tsx --test tests/contracts/shopify-*.contract.test.ts
```

The `--check` commands contact only Shopify's official versioned documentation
surfaces. Contract tests themselves are deterministic and do not require a
merchant credential.
