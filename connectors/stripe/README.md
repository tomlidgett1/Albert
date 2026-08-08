# Stripe connector

Pinned against official Stripe documentation retrieved **2026-08-06**:

- [Connect OAuth reference](https://docs.stripe.com/connect/oauth-reference)
- [OAuth changes for standard platforms](https://docs.stripe.com/connect/oauth-changes-for-standard-platforms)

**Authorization only.** No Stripe data is extracted, staged or projected.

## Two vendor constraints worth knowing

**`read_only` is not available.** Stripe documents `read_only` as usable by
extensions only; a standard platform must request `read_write`. The grant is
therefore wider than Albert can use by vendor constraint, not by choice, and
the pack contains no Stripe write method.

**Per-connection tokens are deprecated.** Stripe now expects the platform
secret key plus a `Stripe-Account` header. The durable credential for a Stripe
connection is the connected account id (`stripe_user_id`), not a bearer token,
so the stored credential uses `tokenType: "StripeAccount"` — deliberately
distinct from `Bearer` so nothing can put it in an Authorization header and
expect it to authenticate.

Because there is no token to exchange, `renewCredential` re-verifies that the
platform can still retrieve the account and extends a 24-hour verification
horizon. That turns renewal into a periodic liveness check instead of letting a
revoked connection look healthy forever.

Authorization codes are single use and expire in five minutes; consuming one
twice revokes the connection, so the exchange is never retried.

| Variable | Where |
| --- | --- |
| `STRIPE_CLIENT_ID` | Vercel web + sync worker |
| `STRIPE_SECRET_KEY` | Sync worker only (platform secret key) |
