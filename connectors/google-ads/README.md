# Google Ads connector

Pinned against official Google documentation retrieved **2026-08-06**:

- [OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Ads API OAuth cloud project](https://developers.google.com/google-ads/api/docs/oauth/cloud-project)

**Authorization only.** No Google Ads data is extracted, staged or projected.

Google Ads publishes exactly one OAuth scope
(`https://www.googleapis.com/auth/adwords`) with no read-only variant. Read-only
separation comes from the developer-token access level and from this pack
containing no mutate method.

`access_type=offline` and `prompt=consent` are both always sent. This is not
cosmetic: without `prompt=consent` Google omits the refresh token on every
re-authorization after the first, silently leaving a connection that cannot be
renewed unattended. The exchange refuses a grant that arrives without a refresh
token rather than storing one that will die in an hour.

Google omits `refresh_token` on refresh responses, so the existing one is
retained; a rotated value would still be adopted if that ever changes.
Disconnect revokes the refresh token, which invalidates the whole grant —
revoking only the access token would leave a renewable grant behind.

**Calling the Google Ads API additionally requires an approved developer
token**, which is separate from OAuth and which this pack does not hold. Account
identity is therefore the authorising Google account (the OpenID subject), not
an enumerated customer list.

| Variable | Where |
| --- | --- |
| `GOOGLE_ADS_CLIENT_ID` | Vercel web + sync worker |
| `GOOGLE_ADS_CLIENT_SECRET` | Sync worker only |
