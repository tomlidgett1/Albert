# Governed ShopifyQL production runbook

This runbook operates the on-demand ShopifyQL report plane. It does not activate
or start ingestion. Store ingestion remains an explicit owner/manager action in
the Connections UI.

## Release prerequisites

1. Confirm the committed registry is pinned to Shopify 2026-07 and passes:
   `npm run shopifyql:schema:check` and `npm run test:shopifyql:schema`.
   The query-plane contract must additionally attest classification digest
   `08efc5b1de5f86319ac99c700a8c10a0feb62d15757e51de4450e9d78e0b8541`
   and exact counts: 1,668 allowed and 659 denied static fields, 149 allowed and
   62 denied MATCHES fields, and all five metafield patterns denied. A registry,
   definition or classification change requires a new privacy review; never
   update the digest merely to make a release pass.
2. Confirm the Shopify app requests `read_reports`. Existing stores missing the
   scope must reconnect; never treat missing access as zero data.
3. Confirm the production app has Shopify Level-2 protected-customer-data
   approval. Use Shopify's
   [`shopifyqlQuery` access contract](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/shopifyqlQuery)
   and [protected-customer-data requirements](https://shopify.dev/docs/apps/store/data-protection/protected-customer-data)
   as the authority.
4. Generate one random secret of at least 32 bytes for
   `ALBERT_SHOPIFYQL_SIGNING_SECRET`. Install the identical value in only the
   Vercel web runtime and sync-worker runtime. It must differ from every OAuth,
   semantic, Anthropic and operator-diagnostic signing secret. Never paste it
   into chat, logs, tickets or documentation.

## Deployment order

1. Apply `infra/migrations/control-plane/0133_m6_governed_shopifyql_query_plane.sql`
   as `albert_control_migration_owner`.
2. Record the reviewed Level-2 approval evidence as the migration owner. Hash
   the exact production `SHOPIFY_CLIENT_ID` with SHA-256 and store only that
   hash, a SHA-256 receipt digest and a non-secret ticket/receipt reference.
   Never store the client ID, secret, access token or customer data in the
   evidence table.
3. Deploy the sync worker with the dedicated signing secret and Shopify app
   configuration. `/readyz` must stay unavailable if migration 0133 or any
   required ShopifyQL column is missing.
4. Deploy Vercel with `SYNC_WORKER_INTERNAL_URL` and the same dedicated signing
   secret. The URL must resolve to the deployed sync-worker service.
5. Run the ShopifyQL contract/eval tests, then smoke-test as an owner or manager.
   Verify a bookkeeper, internal operator, actor from another tenant and an
   unsigned request are all denied.

The evidence record shape is deliberately explicit. Perform the write through
the controlled migration-owner SQL session, substituting hashes/references from
the approved operator process:

```sql
insert into control_plane.shopify_protected_data_approvals (
  app_client_id_sha256, protected_data_level, api_version,
  evidence_digest, evidence_reference, approved_at, expires_at
) values (
  '<64-lowercase-hex-client-id-sha256>', 2, '2026-07',
  '<64-lowercase-hex-receipt-sha256>', '<non-secret-ticket-reference>',
  '<approved-at-timestamptz>', '<optional-expiry-timestamptz>'
);
```

## Smoke checks

- Ask: “Show daily Shopify sessions and conversion rate for 1–31 July 2026.”
- Ask: “Which search queries converted best in July 2026?”
- Ask: “Compare first-click and last-click sales attribution by channel in July
  2026.”
- Ask: “Show Shopify profitability by product in July 2026.”

Each execution should expose the store label, API version `2026-07`, registry
digest, explicit time range, exact returned definitions and Shopify parse
errors. It must never expose a token, shop domain, GraphQL document or compiled
ShopifyQL. A catalogue search and execution must each appear in their
metadata-only control-plane ledger. No initial-backfill or incremental-sync job
should be created by these checks.

Also smoke-test a catalogue search for `customer email`, then attempt to run a
report with `customer_email` in each supported clause. Its official definition
must remain searchable and marked denied; execution must fail before Shopify is
called. Repeat with an `IDENTITY`, a merchant metafield and a high-precision
timestamp. Inspect the governed result and confirm every
`rowMetadata.rawResourceIds` array is empty even if Shopify returned resource
linkage metadata.

## Privacy limitation

This plane prevents direct identifiers, resource linkage, unbounded personal
text, exact event times and explicitly reviewed individual-customer behavior.
It does not provide formal anonymisation. A small merchant or a narrow filter
can still produce a singleton aggregate for an allowed coarse dimension such
as day, cohort, geography, product label or campaign category. There is no
k-anonymity threshold, noise, cell suppression or cross-query inference budget.
Do not claim anonymity, use this plane for external publication, or use repeated
queries to infer a protected value. Questions that require a formal disclosure
control must use a canonical aggregate with a separately approved publication
policy.

## Expected policy failures

- `shopifyql_actor_not_authorized`: caller is not an active owner/manager in
  the signed tenant, or the signed role does not match the database membership.
- `shopifyql_level2_approval_required`: evidence is absent, expired or revoked,
  or it is bound to a different production app client ID.
- `shopifyql_read_reports_required`: reconnect the store with the approved app
  scope; do not widen a stored scope manually.
- `shopifyql_connection_ambiguous`: select a specific connected store.
- `privacy_policy_registry_unreviewed`: stop the release. The official
  definitions or their reviewed classifications no longer match the pinned
  privacy digest/counts.
- `field_protected` or `match_condition_protected`: the definition remains
  searchable, but merchant values cannot be executed through this plane. Do
  not bypass the denial with raw GraphQL, metafields, URLs, or repeated filters.
- `shopifyql_turn_limit_exceeded`: the turn used all six report slots.
- `shopifyql_parse_error`: preserve Shopify's parse errors and update the pinned
  registry/compiler if the official versioned docs changed; do not bypass it
  with raw text.
- `shopifyql_timeout` or throttling: retry in a new bounded request after the
  vendor budget recovers. Do not raise limits ad hoc.

## Revocation and incident response

To withdraw app approval, set `revoked_at` on the exact app-client hash using a
migration-owner session. New reservations fail immediately. For a compromised
HMAC secret, rotate it in both runtimes in one release, restart them, and review
catalogue/query ledgers for unexpected actors, tenants, request volume or
digests. For a compromised Shopify credential, use the existing connection
revocation flow; do not inspect or copy the encrypted token. Preserve ledgers
for incident evidence because they contain only bounded metadata and hashes.
