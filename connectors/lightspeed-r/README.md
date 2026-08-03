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

The pack is deliberately R-Series-only. Successful `GET /API/V3/Account.json`
discovery is the variant check; X-Series uses different identity and API hosts.
The merchant still needs to confirm the open product decision that their live
shop is R-Series before M3 live-account acceptance can pass.

Albert only issues GET requests to the R-Series data API. Some resources have
no documented read-only scope, so the narrowest resource scopes are requested
and the absence of write methods is enforced in code. The authorization-code
flow is state-bound and uses S256 PKCE. R-Series' documented confidential-client
exchange binds the same registered redirect URI, client secret, short-lived code
and one-use PKCE verifier used by the authorization request.
Refresh tokens rotate and the new pair is committed with compare-and-swap before use;
disconnect calls the documented
`/auth/oauth/access_token` endpoint with `grant_type=revoke_refresh_token` and
destroys the local encrypted credential even if the remote call fails. R-Series
does not publish a webhook contract, so
scheduled incremental polling and nightly reconciliation recover changes and
deletes.

Pack 1.1.0 adds the documented `employee:vendors` grant. Connections created
with an earlier consent set expose `inventory.purchase_orders` as unavailable
until an owner re-consents; Albert does not attempt Order materialisation while
the Vendor dependency is incomplete.

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
