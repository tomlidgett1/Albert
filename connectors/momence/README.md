# Momence connector

Pinned against official Momence documentation retrieved **2026-08-06**:

- [Getting started](https://api.docs.momence.com/docs/get-started)
- [Authentication](https://api.docs.momence.com/docs/getting-started)
- [OAuth2 authorize](https://api.docs.momence.com/reference/apiv2authcontroller_authorize)

**Authorization only.** No Momence data is extracted, staged or projected.

Momence publishes a single public API scope (`public-api-v2`) rather than
resource-specific read scopes. Only the authorization-code flow is used; the
documented password grant is never used because it would require handling staff
credentials directly.

Client credentials are sent as HTTP Basic auth rather than in the form body, so
the secret stays out of the payload. `prompt=login` forces Momence to sign the
user out first, so a shared browser session cannot silently connect the wrong
studio.

Access tokens expire within hours, so the exchange refuses a grant that arrives
without a refresh token rather than storing one that cannot survive unattended.
Momence rotates refresh tokens, so each new one is persisted with
compare-and-swap. Momence documents no revocation endpoint: disconnect destroys
the encrypted credential and the studio removes the API client in Momence.

| Variable | Where |
| --- | --- |
| `MOMENCE_CLIENT_ID` | Vercel web + sync worker |
| `MOMENCE_CLIENT_SECRET` | Sync worker only |
