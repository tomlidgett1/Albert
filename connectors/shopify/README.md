# Shopify connector

Pinned against official Shopify documentation retrieved **2026-08-06**:

- [Authorization code grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant)
- [Access scopes](https://shopify.dev/docs/api/usage/access-scopes)

**Authorization only.** No Shopify data is extracted, staged or projected. All
extraction entry points fail closed via `AuthorizationOnlyConnectorPack`.

## The shop domain is part of the authorization host

Unlike every other connector, Shopify hosts the authorize endpoint on the
merchant's own shop (`https://{shop}.myshopify.com/admin/oauth/authorize`), so
the shop must be known *before* the redirect. The Connect flow collects it, the
web layer normalises it, and the sync worker re-validates and stores it as
`oauth_sessions.vendor_account_hint` under its own authority. Deriving it from
the browser-supplied state at callback time would let a tampered value choose
which host the authorization code is exchanged against.

`normalizeShopifyShopDomain` accepts a bare shop name or a full URL and rejects
anything that is not `*.myshopify.com`, including look-alikes such as
`my-store.myshopify.com.evil.com`.

## Callback HMAC

Shopify is the only connector whose redirect carries a vendor signature, and it
matters most here precisely because the authorize host is merchant-supplied.
The callback is rejected unless the HMAC-SHA256 over the sorted query string
(excluding `hmac` and `signature`) verifies against the app secret, compared
with `timingSafeEqual`.

## Scopes and tokens

Only `read_*` access scopes are requested; Shopify pairs every read scope with
a write counterpart and none is requested. Albert asks for non-expiring offline
tokens, so there is nothing to refresh — `renewCredential` fails closed and asks
the merchant to reconnect. Shopify documents no OAuth revocation endpoint, so
disconnect destroys the encrypted credential and the merchant uninstalls the app.

| Variable | Where |
| --- | --- |
| `SHOPIFY_CLIENT_ID` | Vercel web + sync worker |
| `SHOPIFY_CLIENT_SECRET` | Vercel web (callback HMAC) + sync worker |
