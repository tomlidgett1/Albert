# 0144 — Partner API clients: Albert as another product's analytics engine

Date: 2026-09-23. Status: implemented and deployed the same day.

## Why

Yellow Jersey (the bike-shop platform, repo `tomlidgett1/yellow-jersey`) now
ships Albert as its **Analytics** tab: the Omni harness, its research trail,
value lookups, governed query cards, pivots, charts and answers, rendered in
Yellow Jersey's own interface for the stores it serves. Ashburton Cycles is the
first store. Albert stays its own product, repo and Supabase pair; Yellow
Jersey is a client of it.

Two things stood in the way:

1. Albert's web API was reachable only by its own browser pages. Every route
   authenticated through the session cookie and every mutation demanded the
   app's own `Origin` (the CSRF guard). A server-side client had no honest way
   in: it would have had to forge a browser — a cookie in `@supabase/ssr`'s
   private format plus a spoofed `Origin`.
2. Nothing could give a partner an Albert identity without handing it Albert's
   service-role key, which the web env contract already refuses to hold on
   Vercel (`webForbiddenProductionValues`). A partner's Vercel project must
   not hold it either.

## Decision

**Bearer API clients on the existing web API.** `utils/supabase/server.ts`
accepts `Authorization: Bearer <Supabase access token>`. A bearer request is
authenticated by that token alone: the Supabase client carries it as its
`Authorization` header, `requireUser()` verifies it with GoTrue
(`auth.getUser(token)`), and the request's cookies are never read, so the two
credential paths cannot mix. `assertSameOriginMutation` (and the multipart
variant) skip the `Origin` comparison for bearer requests only: they carry no
ambient credential and browsers cannot send an `Authorization` header
cross-site without a CORS preflight Albert never grants. The content-type and
bounded-body guards still apply. Only a JWT-shaped bearer counts; anything else
leaves the request on the cookie path with the guard intact
(`utils/supabase/bearer.ts`, tests in `request-security.contract.test.ts`).

Every Albert RPC a bearer client triggers runs under the token's own member
policies, the same as a browser session. The Omni route, conversation
list/history and `/api/session` work unchanged.

**A session broker that owns the privilege.** `supabase/functions/partner-session`
is a Supabase Edge Function on the control project. A partner authenticates
with an API key (`albert_pk_` + 32 random bytes, base64url). The broker:

- hashes the key and matches the SHA-256 against `ALBERT_PARTNER_CLIENTS`
  (an edge-function secret: `clientId`, `partner`, `keySha256`, `tenantId`,
  `actingUserId`, `enabled`). The key itself is stored nowhere in Albert;
- mints a session for the client's acting member with GoTrue's admin API
  (magic link generated and verified in-process, no email sent), which is the
  iMessage bridge's proven headless-session mechanism;
- refuses (and signs out) any session that `current_albert_context()` does
  not resolve to the client's bound tenant, so a member who switches
  organisations can never route a partner's questions into another tenant;
- returns the access token and its expiry only. No refresh token leaves the
  function; the partner re-mints before expiry.

The service-role key is used for the GoTrue admin API only. The broker reads
no control-plane table, so it adds no grant back to `service_role` (all
retired by 0172).

**Acting identity.** The first client, `yellow-jersey-ashburton`, acts as the
Ashburton tenant's owner, the same identity the iMessage bridge acts as. That
needed no new account. Its turns carry `created_by` = the owner and appear in
the owner's Albert conversation list. Yellow Jersey keeps its own per-user
index of the conversations its users start, so its users see only their own.
A dedicated least-privilege member (role `manager`) is a config change:
create it, add its membership, and point the client's `actingUserId` at it.

## Operating it

- New client: generate a key, append `{clientId, partner, keySha256: sha256(key),
  tenantId, actingUserId, enabled: true}` to the secret with
  `supabase secrets set --project-ref jjiugnriaypjoxsupjft ALBERT_PARTNER_CLIENTS=…`,
  and give the key to the partner. Only the digest ever reaches Albert.
- Revoke: set `enabled: false` (or remove the entry) and re-set the secret.
  Minted tokens then die at their expiry (≤ 1 hour).
- Audit: the function logs `partner_session_minted` / `_rejected` /
  `_tenant_mismatch` / `_failed` with client and tenant ids, never tokens.
- Each mint creates one auth session for the acting member. Partners cache the
  token until shortly before it expires (Yellow Jersey keeps a 20-minute
  margin, longer than any turn), so this is a handful of sessions per hour at most.
