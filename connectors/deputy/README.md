# Deputy connector

Pinned against official Deputy documentation retrieved **2026-08-03**:

- [OAuth 2.0 and rotating refresh tokens](https://developer.deputy.com/docs/using-oauth-20)
- [Resource API query contract](https://developer.deputy.com/docs/resource-api-objects)
- [500-record paging and filtering](https://developer.deputy.com/docs/getting-data-resources-api)
- [Webhook authentication](https://developer.deputy.com/docs/webhook-overview)
- [Webhook action list](https://developer.deputy.com/docs/webhook-action-list)
- [Manual webhook installation](https://developer.deputy.com/docs/manually-adding-webhooks-to-a-deputy)
- [Documented custom-header representation](https://developer.deputy.com/docs/aws-sqs)
- [Employee](https://developer.deputy.com/docs/employee), [Roster](https://developer.deputy.com/docs/roster), [Timesheet](https://developer.deputy.com/docs/timesheet), [Leave](https://developer.deputy.com/docs/leave), [OperationalUnit](https://developer.deputy.com/docs/operational-unit-1), and [Company](https://developer.deputy.com/docs/company) resources
- [Contact](https://developer.deputy.com/docs/contact) and [Address](https://developer.deputy.com/docs/address) identity evidence

OAuth tokens are bound one-to-one to the install hostname returned during code
exchange. The pack validates that hostname against Deputy's documented AU, EU,
UK and US regional domains before making a request, preventing credential-
metadata SSRF. Access tokens last roughly 24 hours; every refresh rotates the
refresh token and is persisted with compare-and-swap semantics.

Every non-OAuth vendor call is read-only: `GET /me` or `POST` only to a path
ending in `/QUERY`, which Deputy documents as its Resource query operation.
Albert contains no Webhook-resource or business-resource create, update, or
delete request. Resource pages are capped at the documented 500 records,
filtered incrementally with inclusive Modified watermarks, and deduplicated
downstream for at-least-once delivery.

Deputy does not publish a fixed global request budget in the pinned docs. The
pack therefore obeys `Retry-After`, bounds concurrency locally, and applies
full-jitter exponential retry without inventing a fixed vendor sleep.

OAuth completion connects the install and starts scheduled polling without
listing, creating, or updating Deputy Webhook resources. Polling and nightly
reconciliation are the complete ingestion baseline. The optional webhook
accelerator is reported as `operator_installation_required` and never degrades
the connection. If an owner or operator explicitly chooses to install it in
Deputy, the callback uses a generated 256-bit `X-Albert-Webhook-Secret` unique
to that connection. Its verification material is encrypted under
`DEPUTY_WEBHOOK_ENCRYPTION_KEY`, a KEK distinct from OAuth token encryption;
the public gateway resolves only the material named by the two ULIDs in the
callback URL. Deputy's action catalogue does not list Contact, so Contact
always remains polling- and reconciliation-driven.

Deputy Enterprise also emits `X-Deputy-Secret`, an HMAC-SHA256 of the exact raw
body using the install API-signing private key. When that per-connection key is
installed, Albert requires both the custom connection secret and the official
HMAC. `X-Deputy-Generation-Time` is required within the configured freshness
window. Deputy documents its HMAC as covering the body, not that timestamp, so
replay identity is derived from the authenticated body and topic and never from
mutable request IDs or unsigned headers. Contact Resource access is
Premium/Enterprise, while Timesheet cost depends on payroll visibility; both
remain explicit capability gates.

Verified `*.Delete` events must contain each affected Resource `Id`. Albert
stores those identities with the webhook receipt, carries them in the fixed
incremental-sync job, and lands identity-only tombstones linked back to the
exact raw webhook object. This avoids a read-after-delete race: if `/QUERY` no
longer returns the removed Resource, prior typed fields are retained only to
retire the existing canonical row. A missing or malformed deletion identity is
rejected rather than acknowledged and discarded.

Unknown additive fields remain in immutable raw storage, raise schema-drift,
and are excluded from the manifest-approved staging projection. Invalid core
schemas or exact-decimal normalization failures are quarantined.
The exported `DEPUTY_REVIEWED_UNSUPPORTED_FIELDS` catalogue records documented
top-level Company, OperationalUnit INFO, Employee, Roster, Timesheet, and
Contact fields reviewed against the pinned pages but deliberately excluded
from V1. Each has an explicit reason and PII class, so a legitimate documented
field is retained raw without becoming false schema drift.

Identity evidence remains connector-owned and source-neutral at the canonical
boundary. An Employee hint references its separate Contact observation so the
contact work email enriches the Employee regardless of stream arrival order;
Contact itself is evidence-only and cannot become a worker candidate. Company
and OperationalUnit Resource queries request Deputy's documented
`AddressObject` join. The pack emits the same normalized `work_email` and
`location_name_address` keys as other packs, so the matcher contains no
Deputy/Lightspeed pairwise branch and candidate links remain source-native.

Employee identity and employment history have different grains. Person and
worker remain stable on Deputy Employee ID, while each employment episode is
keyed by Employee ID plus its source-reported start date. A rehire therefore
creates a new non-overlapping episode, and roster, timesheet, and leave facts
resolve the episode effective on their business date instead of pointing at a
mutable current-employment row.
