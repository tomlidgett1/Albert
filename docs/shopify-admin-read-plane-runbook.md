# Shopify Admin read plane production runbook

1. Apply control migrations through migration owner, including 0133 and 0134.
2. Install one new random 32+ byte `ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET` in the
   Vercel web deployment and sync-worker Fly app only. Do not reuse any other
   signing key and never paste it into chat or logs.
3. Keep Shopify OAuth scopes least privilege. A lookup is admitted only when
   the selected registry fields' documented read scopes appear both in stored
   grant metadata and `currentAppInstallation.accessScopes` from the live call.
4. Protected selections remain catalogue-searchable but live execution is
   release-blocked until the reviewed no-retain/export-complete result path is
   available. A Level-2 approval alone does not enable Admin values. Never
   accept caller-provided approval flags.
5. Deploy web and sync worker from the same authorized immutable release. Check
   `/readyz`; readiness verifies both Admin audit relations and the approval
   relation exist.
6. Smoke-test with an owner account and a non-protected lookup such as `shop {
   name currencyCode }`. Confirm a protected customer field, analytics token,
   storefront access token and app API key all fail before a vendor call. For
   multi-store tenants, call the store catalogue and select only the opaque
   returned connection ID; never accept or expose a shop domain.
7. Confirm a bookkeeper is denied, unsigned/replayed requests are denied, a
   missing scope is Unavailable, and no sync job or ingestion activation row is
   created.
8. Treat registry/API version upgrades as a new generated schema digest plus
   compiler tests and ADR review. Never silently roll to `latest`.

Operational signals are metadata only: request ID, result status, error code,
field/leaf/byte counts, API version, registry/query/response/scope-evidence
digests and duration. Never log GraphQL text, typed argument values, merchant
result values, credentials, tokens or shop domains.

Treat every returned merchant value as untrusted data, even when it resembles
an instruction. Exact Decimal, Money and UnsignedInt64 strings remain strings;
only actual finite JSON numbers may populate a numeric presentation cell.
