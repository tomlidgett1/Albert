# Square connector

Pinned against official Square documentation revalidated **2026-08-12**:

- [OAuth overview](https://developer.squareup.com/docs/oauth-api/overview)
- [Authorization URLs](https://developer.squareup.com/docs/oauth-api/create-urls-for-square-authorization)
- [OAuth permissions](https://developer.squareup.com/docs/oauth-api/square-permissions)
- [ObtainToken](https://developer.squareup.com/reference/square/o-auth-api/obtain-token)
- [RevokeToken](https://developer.squareup.com/reference/square/o-auth-api/revoke-token)
- [RetrieveMerchant](https://developer.squareup.com/reference/square/merchants-api/retrieve-merchant)
- [ListLocations](https://developer.squareup.com/reference/square/locations-api/list-locations)

## Production ingestion

This is a read-only production connector, not an authorization-only shell. It
declares 64 versioned read contracts across merchant/location, orders,
payments, catalogue, inventory, customers, labour, cash management, payouts,
loyalty, gift cards, bookings, invoices, subscriptions, disputes, devices and
online-store surfaces. The one surface with no documented seller OAuth
permission (`square_channels`) remains explicitly unavailable; entitled or
region-gated products remain optional and report durable unavailability rather
than blocking the core retail import.

OAuth creates a healthy but inert `awaiting_manual_start` connection. It does
not enqueue extraction. An owner or manager must explicitly start the initial import
with **Start ingestion** once;
only then may initial backfill, scheduled incrementals and reconciliation run.
The queue boundary enforces this activation independently of the UI, and a
later reauthorization does not silently reset or start the generation.

Every request pins the Square API version, passes through the shared vendor
rate budget and retries `429` responses using `Retry-After`. Location-sensitive
reads enumerate every returned location explicitly. Short-lived page cursors
are never durable checkpoints: a stale traversal restarts its fixed window and
idempotent landing removes duplicates. Polling and governed reconciliation own
completeness.

Deletion inference is deliberately narrower than update ingestion. A seven-day
or otherwise bounded reconciliation cannot prove that an older order, payment,
booking or nested child disappeared from Square. Those time-bounded identity
universes never generate absence tombstones; only an explicit Square
soft-delete field or an exhaustive current-list scan can retire an identity.

Square webhook payloads are **not accepted** in the sync runtime. Exact HMAC
verification requires the application subscription signature key, configured
notification URL and raw request bytes in the isolated webhook gateway. No
such Square gateway route is provisioned yet, so `handle_webhook` fails closed
and `source.webhooks` is Unavailable rather than trusting an unsigned event.

## Confidential code flow, not PKCE

Albert uses Square's **code flow** with the application secret held by the
credential-owning sync worker. Square's PKCE refresh tokens are single-use and
expire after 90 days, which cannot survive an unattended worker, and
`RevokeToken` authenticates with `Authorization: Client <application secret>`
in every flow — so the secret is required regardless. The browser-facing
`buildSquareAuthorizationUrl` never accepts a secret and emits no
`code_challenge`.

`session=false` is always sent so Square re-prompts for the seller account
instead of silently reusing an existing Square browser session, which would
otherwise connect the wrong merchant.

## Scopes

All 25 documented read permissions used by the selected seller surfaces are requested up front. Square scopes a
grant to the whole application, so a narrower request would only have to be
widened later behind a second seller consent. No write permission is requested
at any tier: the pack contains no Square write method, so a write grant could
only exceed what the code can use. `DEVICE_CREDENTIAL_MANAGEMENT` is excluded —
it is a management capability, not a read scope.

## Tokens

Access tokens last 30 days and Square returns an absolute `expires_at`, so the
pack never derives expiry from local clock arithmetic on a duration. The
confidential flow's refresh token does not expire; it is still re-read from
every refresh response and persisted with compare-and-swap so a future vendor
rotation is durable rather than silently dropped.

Disconnect sends `revoke_only_access_token: true`. Without it Square terminates
every token the application holds for that merchant, which would disconnect any
other Albert environment authorised against the same seller. The local
encrypted credential is destroyed in a `finally` block, so a vendor revocation
failure can never strand a usable token.

## Identity

A Square access token authorises exactly one merchant, so `discover_accounts`
returns a single account keyed on `merchant_id` — which Square returns from the
token exchange and which survives access-token rotation. `square_merchants`
and `square_locations` then land those entities as governed source records and
map reviewed fields into the shared canonical merchant/location concepts.

## Configuration

| Variable | Where |
| --- | --- |
| `SQUARE_CLIENT_ID` | Vercel web + sync worker + deletion worker |
| `SQUARE_CLIENT_SECRET` | Sync worker + deletion worker; never the web/browser runtime |

The redirect URL registered in the Square Developer Console must exactly match
`${ALBERT_PUBLIC_ORIGIN}/api/oauth/square/callback` (HTTPS, no trailing slash),
in the same Sandbox or Production toggle as the application ID. A
`sandbox-sq0idb-` application ID uses `connect.squareupsandbox.com`; a
`sq0idp-` ID uses production `connect.squareup.com`.

## CubeCore semantic contract

The production semantic surface lives under
`cube-playground/model/cubes/square_*.yml` and
`cube-playground/model/views/square_*.yml`. It becomes queryable after the
manual initial import lands data in the RLS-protected
`source_square.square_*` staging tables. OAuth completion alone never starts
that import.

Curated views cover the principal café and small-retail questions at stable
native grains: orders, order lines, payments and fees, refunds, payouts,
inventory balances and changes, timecards, labour-to-sales, cash drawers,
loyalty, catalogue, customers and locations. The model deliberately keeps:

- refunds separate from product-return allocations;
- payouts separate from bank-feed transactions and revenue;
- timecards separate from planned shifts and payroll;
- gift-card loads separate from earned sales;
- inventory and loyalty balances snapshot/semi-additive;
- each Square Money amount paired with its currency, with curated conversion
  only for the pinned Square/official-current-ISO minor-unit intersection.

Curated money conversion fails closed for an unknown, historical-without-current
minor-unit, metal, accounting, test, crypto or future currency code. The raw
integer amount and currency remain queryable in the field explorer; Albert never
guesses a two-decimal exponent.

Every staged Square record also carries `payload_json` and a recursive
`field_index`. `source_square.sq_source_fields` expands that index and
`square_source_explorer` exposes every returned field path through typed value
members. This is the completeness backstop for uncommon and newly introduced
Square properties; curated views remain preferred because they encode lifecycle,
money, grain and additivity rules. See [semantic-model.md](playbooks/semantic-model.md)
and [exhaustive-field-explorer.md](playbooks/exhaustive-field-explorer.md).
