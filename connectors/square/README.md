# Square connector

Pinned against official Square documentation retrieved **2026-08-06**:

- [OAuth overview](https://developer.squareup.com/docs/oauth-api/overview)
- [Authorization URLs](https://developer.squareup.com/docs/oauth-api/create-urls-for-square-authorization)
- [OAuth permissions](https://developer.squareup.com/docs/oauth-api/square-permissions)
- [ObtainToken](https://developer.squareup.com/reference/square/o-auth-api/obtain-token)
- [RevokeToken](https://developer.squareup.com/reference/square/o-auth-api/revoke-token)
- [RetrieveMerchant](https://developer.squareup.com/reference/square/merchants-api/retrieve-merchant)
- [ListLocations](https://developer.squareup.com/reference/square/locations-api/list-locations)

## Authorization only

This pack is **authorization only**. It exchanges, refreshes and revokes the
seller grant and reads merchant and location identity. It declares no stream,
so nothing is extracted, staged, projected or answered from. `streams`,
`capabilities`, `fieldCoverage` and `sourceAuthority.defaults` are all empty by
construction, and `assertConnectorManifestReconciliationPolicy` now rejects a
stream-less pack that tries to claim source authority.

Every extraction entry point fails closed. `initial_sync`, `incremental_sync`
and `reconciliation_sync` raise `CAPABILITY_UNAVAILABLE` rather than returning
an empty page, because an empty page reads downstream as "synced, found
nothing" — which would be a false coverage claim. `handle_webhook` refuses for
the same reason. `mapSquareCanonical` throws if a staged row is ever routed to
Square, and `stagingSchema` throws rather than falling through to another
connector's schema.

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

All 24 documented read permissions are requested up front. Square scopes a
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
token exchange and which survives access-token rotation. Locations are recorded
as connection metadata only; they are never promoted to a canonical location
identity, because no stream extracts them.

## Configuration

| Variable | Where |
| --- | --- |
| `SQUARE_CLIENT_ID` | Vercel web + sync worker |
| `SQUARE_CLIENT_SECRET` | Sync worker only |

The redirect URL registered in the Square Developer Console must exactly match
`${ALBERT_PUBLIC_ORIGIN}/api/oauth/square/callback` — HTTPS, no trailing slash.
