# Lightspeed Retail POS (R-Series) connector

Pinned against the official documentation retrieved **2026-08-03**:

- [OAuth authentication](https://developers.lightspeedhq.com/retail/authentication/authentication-overview/)
- [Access scopes](https://developers.lightspeedhq.com/retail/authentication/scopes/)
- [V3 cursor pagination](https://developers.lightspeedhq.com/retail/introduction/pagination/)
- [Leaky-bucket and burst limits](https://developers.lightspeedhq.com/retail/introduction/ratelimits/)
- [Relations](https://developers.lightspeedhq.com/retail/introduction/relations/)
- [Query parameters and timestamp operators](https://developers.lightspeedhq.com/retail/introduction/parameters/)
- [Vendor endpoint](https://developers.lightspeedhq.com/retail/endpoints/Vendor/)
- [Official R-Series authentication collection](https://www.postman.com/lightspeedhq/r-series-api/documentation/j3gxxum/r-series-authentication)

## Spec-driven 90-stream architecture (pack 2.0.0)

The pack is generated from `tables.json` — 90 tables, 949 columns, distilled
from the pinned documentation build. One spec produces every artifact:
`streams.ts` derives the 90 stream contracts (each stream's `resource` is its
OWN vendor object, taken from the api owner of its record-id column, so a
nested child can never conflate its identity with its parent's),
`field-coverage.ts` derives staging coverage plus explicit `unsupported`
dispositions for documented fields outside scope, `schemas.ts` derives row
validation, and `scripts/generate-connector-staging.ts --all-new` renders the
staging DDL (`0121` + the projected parent-context columns in `0125`).

Fetching is a per-stream walk (`spec-sync.ts`) under the worker's
one-job-per-stream contract, but every member of a scan group requests the
group's byte-identical relation union, so the connector's bounded page cache
serves all six Sale-derived streams from one `Sale.json` walk — the HTTP
count, which the one-drip-per-second budget constrains, does not multiply
with the stream count. Nested rows carry projected parent context
(`Sale.completed` on a sale line, `Order.vendorID` on a purchase-order line)
so each maps standalone in `canonical.ts`: the sale header owns the order,
lines own order lines and refund reversals, payments own tenders, and every
mapper-less stream records a lookup-only metadata observation.

The pack is deliberately R-Series-only. Successful `GET /API/V3/Account.json`
discovery is the variant check; X-Series uses different identity and API hosts.
The merchant still needs to confirm the open product decision that their live
shop is R-Series before M3 live-account acceptance can pass.

Albert only issues GET requests to the R-Series data API. Consent requests
`employee:all` (same as Nest/bike-dashboard) so one grant covers every
extraction domain; the absence of write methods remains enforced in code. The
authorization-code flow is state-bound for a confidential server client:
authorize sends `response_type`, `client_id`, `scope`, `state`, and the
registered `redirect_uri` with no PKCE. Token exchange uses JSON with
`client_id`, `client_secret`, `grant_type`, `code`, and `redirect_uri`.
Refresh tokens rotate and the new pair is committed with compare-and-swap before use;
disconnect calls the documented
`/auth/oauth/revoke` endpoint with the current refresh token and
destroys the local encrypted credential even if the remote call fails. R-Series
does not publish a webhook contract, so
scheduled incremental polling and nightly reconciliation recover changes and
deletes.

Every paged response follows vendor-provided `next` URLs after validating the
origin and account path. Timestamp-sortable resources use inclusive watermarks;
InventoryLog uses its sortable numeric ID while retaining `createTime` as the
event watermark. Shop and PaymentType are safely refreshed as full snapshots.
The pack observes bucket, burst, drip-rate, request-cost and `Retry-After`
headers; it does not use a fixed vendor sleep.

Unknown additive fields are preserved in immutable raw storage, raise a schema-
drift finding, and are excluded from the approved staging projection. Malformed
required fields or invalid decimals remain quarantined and cannot enter staging.

Purchase-order truth is materialised only from `Order.json` with the requested
`OrderLines` relation. `Vendor.json` is ingested and transformed first so the
parent order's `vendorID` resolves to a real canonical supplier; the parent also
carries the shop, lifecycle dates, status, and currency. The standalone `OrderLine` stream is retained for
typed identity scans and verified deletion tombstones, but active standalone
rows cannot overwrite complete canonical lines with absent header fields. The
result is deterministic whichever stream is scheduled first.
