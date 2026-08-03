# Deputy connector

Pinned against official Deputy documentation retrieved **2026-08-03**:

- [OAuth 2.0 and rotating refresh tokens](https://developer.deputy.com/docs/using-oauth-20)
- [Resource API query contract](https://developer.deputy.com/docs/resource-api-objects)
- [500-record paging and filtering](https://developer.deputy.com/docs/getting-data-resources-api)
- [Webhook authentication](https://developer.deputy.com/docs/webhook-overview)
- [Webhook action list](https://developer.deputy.com/docs/webhook-action-list)
- [Webhook resource creation](https://developer.deputy.com/reference/addawebhookurl)
- [Documented custom-header representation](https://developer.deputy.com/docs/aws-sqs)
- [Employee](https://developer.deputy.com/docs/employee), [Roster](https://developer.deputy.com/docs/roster), [Timesheet](https://developer.deputy.com/docs/timesheet), [Leave](https://developer.deputy.com/docs/leave), [OperationalUnit](https://developer.deputy.com/docs/operational-unit-1), and [Company](https://developer.deputy.com/docs/company) resources
- [Contact](https://developer.deputy.com/docs/contact) and [Address](https://developer.deputy.com/docs/address) identity evidence

OAuth tokens are bound one-to-one to the install hostname returned during code
exchange. The pack validates that hostname against Deputy's documented AU, EU,
UK and US regional domains before making a request, preventing credential-
metadata SSRF. Access tokens last roughly 24 hours; every refresh rotates the
refresh token and is persisted with compare-and-swap semantics.

All source-data extraction uses POST only on `/resource/{name}/QUERY`, which
Deputy documents as its read query operation. The only vendor configuration
write is `/resource/Webhook` during OAuth completion; no employee, roster,
timesheet, leave, contact, or company business object is ever mutated. Resource
pages are capped at the documented 500 records, filtered incrementally with
inclusive Modified watermarks, and deduplicated downstream for at-least-once
delivery.

Deputy does not publish a fixed global request budget in the pinned docs. The
pack therefore obeys `Retry-After`, bounds concurrency locally, and applies
full-jitter exponential retry without inventing a fixed vendor sleep.

OAuth completion reconciles the documented Webhook actions Albert consumes:
`Company.Update`, plus Insert/Update/Delete for OperationalUnit, Employee,
Roster, Timesheet, and Leave. Deputy's current Webhook action catalogue does
not list Contact, so Contact changes remain on incremental polling and nightly
reconciliation instead of making the entire webhook setup depend on an
undocumented action. Every callback carries a generated 256-bit
`X-Albert-Webhook-Secret` unique to that connection. Its verification material
is encrypted under `DEPUTY_WEBHOOK_ENCRYPTION_KEY`, a KEK that is distinct from
OAuth token encryption; the public gateway can resolve and decrypt only the
material named by the two ULIDs in that callback URL. A 401/403 or vendor-plan
block leaves OAuth connected but marks webhook setup as recoverable/degraded,
so reconnecting safely retries the idempotent reconciliation while scheduled
polling continues.

Deputy Enterprise also emits `X-Deputy-Secret`, an HMAC-SHA256 of the exact raw
body using the install API-signing private key. When that per-connection key is
installed, Albert requires both the custom connection secret and the official
HMAC. `X-Deputy-Generation-Time` is required within the configured freshness
window. Deputy documents its HMAC as covering the body, not that timestamp, so
replay identity is derived from the authenticated body and topic and never from
mutable request IDs or unsigned headers. Contact Resource access is
Premium/Enterprise, while Timesheet cost depends on payroll visibility; both
remain explicit capability gates.

Unknown additive fields remain in immutable raw storage, raise schema-drift,
and are excluded from the manifest-approved staging projection. Invalid core
schemas or exact-decimal normalization failures are quarantined.

Identity evidence remains connector-owned and source-neutral at the canonical
boundary. An Employee hint references its separate Contact observation so the
contact work email enriches the Employee regardless of stream arrival order;
Contact itself is evidence-only and cannot become a worker candidate. Company
and OperationalUnit Resource queries request Deputy's documented
`AddressObject` join. The pack emits the same normalized `work_email` and
`location_name_address` keys as other packs, so the matcher contains no
Deputy/Lightspeed pairwise branch and candidate links remain source-native.
