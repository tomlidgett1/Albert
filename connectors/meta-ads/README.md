# Meta Ads connector

Pinned against official Meta documentation retrieved **2026-08-06**:

- [Marketing API authorization](https://developers.facebook.com/docs/marketing-api/overview/authorization)
- [Long-lived access tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived)

**Authorization only.** No Meta Ads data is extracted, staged or projected.

Albert requests `ads_read`, `read_insights` and `business_management` —
deliberately not `ads_management`, which would grant campaign mutation the pack
has no method for. Meta separates permissions with commas, not spaces.

## No refresh token

Meta issues no refresh token. The short-lived code-exchange token is
immediately upgraded via `grant_type=fb_exchange_token` to a ~60-day long-lived
token, so a connection never persists a token that dies within hours. Renewal
re-exchanges a token that is *still valid*; once one has lapsed there is nothing
to exchange, so `renewCredential` fails closed with a re-authorization
requirement rather than retrying a doomed call. When Meta omits `expires_in`,
the documented 60-day lifetime is assumed rather than treating the token as
permanent — a dead token that looks healthy is worse than a conservative expiry.

Tokens are sent as `Authorization: Bearer`, never as a query parameter, so they
cannot leak into request logs.

**Production requires App Review.** Advanced Access must be approved per
permission; Standard Access only covers ad accounts the app itself owns. Without
it `/me/adaccounts` returns 403, which the pack treats as a permission state
rather than a broken connection, so identity still resolves.

| Variable | Where |
| --- | --- |
| `META_ADS_CLIENT_ID` | Vercel web + sync worker |
| `META_ADS_CLIENT_SECRET` | Sync worker only |
