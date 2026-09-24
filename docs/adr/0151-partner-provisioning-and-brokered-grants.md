# 0151 — Partner provisioning and partner-brokered grants

Date: 2026-09-24. Status: implemented; deploy recorded below.

## Why

ADR 0144 made Albert Yellow Jersey's **Analytics** engine, one store at a
time and by hand: someone created a tenant while signed in as a person, added
a partner client to the `ALBERT_PARTNER_CLIENTS` edge secret, put the partner
key in a per-store Vercel env var on Yellow Jersey and redeployed, then
connected each vendor again through Albert's own OAuth apps.

Yellow Jersey's new `/start` sign-up now asks a bike shop to connect
Lightspeed, Xero and Deputy once. Feeding Albert from that same connect ran
into one hard rule: **Lightspeed, Xero and Deputy refresh tokens are
single-use and rotating, so each grant may have exactly one refresher.**
Copying Yellow Jersey's grant into Albert's vault and letting Albert refresh
it revokes Yellow Jersey's connection. It happened before, with
`scripts/bootstrap-lightspeed-from-bike.mts`. A second Albert-side consent,
on the other hand, is exactly the friction `/start` exists to remove.

## Decision

**1. Server-to-server provisioning with a platform key.** A new edge function,
`supabase/functions/partner-provision`, authenticates a partner **platform
key** (`albert_pp_` + 32 random bytes). Only its SHA-256 is stored, in the
`ALBERT_PARTNER_PLATFORMS` edge secret (`[{partner, keySha256, enabled}]`).
`{action: "provision", accountRef, displayName, timezone, keySha256,
tokenBroker}` then:

- creates the **acting member**: an auth user with a deterministic UUIDv5 id
  (from partner + account, so a retry finds it) and an undeliverable
  `…@partner-members.albert.invalid` address. It is created with the GoTrue
  admin API and has no password; sessions are only ever minted for it
  in-process;
- creates the **tenant as that member**, through `albert_create_organisation`
  under the member's own session. That is the path a person takes, so the
  owner membership, overlay, placement and active tenant are all standard. No
  control-plane table is written with elevated rights;
- records the **partner client** in `control_plane.partner_clients` (0195)
  with the key digest the partner sent. The partner generates and keeps the
  key; Albert never sees it.

The call is idempotent per `(partner, accountRef)`. A retry reuses the member
and tenant, and a new digest for an active client rotates its key.
`{action: "disable"}` switches a client off without touching its tenant or
data. A disabled client can be provisioned again by its partner. To cut a
partner off entirely, set its platform to `enabled: false`.

**2. DB-backed partner clients.** `partner-session` still matches
`ALBERT_PARTNER_CLIENTS` first (Ashburton is unchanged). For any other key it
now calls `albert_partner_client_by_digest(digest)`. The tenant check still
guards every mint. The broker keeps its no-control-plane-grants posture:
service_role gains EXECUTE on five narrow `public.albert_partner_*` RPCs and
no table grant.

**3. Partner-brokered grants.** A partner client (a bearer session from
`partner-session`) calls `POST /api/partner/sources {provider}`. That route
accepts bearer requests only, and only from an owner or manager. It calls the
existing worker start path, `/v1/fivetran/{service}/start`, with
`grantSource: "partner"` in place of `nativeConnectionId`.

The worker resolves the tenant's binding (`partner_clients` with
`token_broker`; the partner's account ref comes from that binding, never from
the request) and uses a `PartnerGrantBridge` everywhere the native vault
bridge would be used:

- **SDK connectors (Xero, Lightspeed R-Series):** the connector still asks
  this worker's `/v1/fivetran/token`. For a partner row, the worker asks the
  partner's broker instead of refreshing locally, and asks for at least 5
  minutes of validity.
- **Deputy (Fivetran's native connector):** the start and the 6-hourly relay
  push the partner's token to Fivetran. They ask for at least 8 hours of
  validity so Fivetran's static copy outlives a relay cycle.

The broker call is `POST <partner url>` with `{tenantId, clientId,
accountRef, provider, minValiditySeconds}`, HMAC-signed with Albert's
internal-request scheme and the partner's shared secret. Brokers are
configured in `ALBERT_PARTNER_TOKEN_BROKERS` on the worker
(`[{partner, url, secret}]`).

A partner row records `partnerClientId`, `partner` and
`credentialSource: "partner"` in place of `nativeConnectionId`. A new partial
unique index, `(tenant_id, service)`, makes a duplicate registration converge
on the winner. A repeat registration returns the live row and changes nothing
at Fivetran: no package upload, no secret rotation, no forced sync.

If a partner row's binding changes (client switched off or replaced), its
connector gets no further tokens, and the row is marked `expired`/`degraded`.
The partner's refusals map to worker codes the partner can act on:

| Broker answer | Worker code | HTTP |
| --- | --- | --- |
| 404/409/410 | `fivetran_partner_grant_expired` (the shop must reconnect on the partner's side) | 409 |
| 401/403 | `fivetran_partner_broker_invalid` | 409 |
| other | `fivetran_partner_broker_unavailable` | 503 |

**4. Lightspeed revocations mid-walk.** The partner's refresher runs on its
own schedule. Lightspeed revokes a rotated-away access token with a 403
("Access token has been revoked"), not a 401. The SDK connector now treats
that 403 like a 401: it fetches the current token once and retries. A plain
403 still means "not available".

## Security posture

- The platform key, partner keys and connector secrets are all stored as
  digests only. The broker secret is a shared HMAC key; tokens never travel
  in a URL and are never logged.
- The worker role reads only the binding columns (a column grant). The key
  digest stays behind the service_role RPCs, and the RLS policy exposes only
  active, brokered clients.
- Tenant creation never bypasses `albert_create_organisation`. Activation
  checks that the acting member owns the tenant, and a client never moves to
  another tenant.
- Yellow Jersey's broker serves only stores it provisioned with
  `token_broker_enabled`, and only when Albert's tenant and client id match
  its own record.

## Limits the owner should know about

- **Xero coverage through Yellow Jersey's grant.** Its granular scopes cover
  every accounting-document, contact, settings, budget and report call the
  SDK connector makes. They do not cover these: `Journals` (restricted
  `accounting.journals.read`; Albert's own grant lacks it too),
  `PaymentServices`, Assets, Files, Projects and AU Payroll. The connector
  skips those walks with a 24-hour cooldown, so the tables stay empty for
  partner tenants. Covering them needs Yellow Jersey to request those scopes
  and every shop to re-consent; Journals also needs Xero's approval.
- **Shared vendor allowances.** Albert's syncs spend Yellow Jersey's app
  allowance for the shop: Xero's per-organisation daily calls and
  Lightspeed's request bucket. The Xero connector stops at
  `X-DayLimit-Remaining` minus a 200-call reserve.
- **Fivetran spend.** Every provisioned store is a new set of Fivetran
  connections (MAR). Yellow Jersey keeps this behind its own kill switch,
  `ALBERT_AUTO_PROVISION` (off by default), and skips a vendor account
  another store already feeds into Albert.
- **Fivetran's plan.** It has had no account tier (`AccountTierLimit`) since
  19 Sep 2026. Until the owner restores it, nothing syncs, and new
  connections cannot start.

## Operating it

- **Onboard a partner:** generate a platform key, store its digest in
  `ALBERT_PARTNER_PLATFORMS`
  (`supabase secrets set --project-ref jjiugnriaypjoxsupjft …`), and give the
  key to the partner. If it brokers grants, add
  `{partner, url, secret}` to `ALBERT_PARTNER_TOKEN_BROKERS` on the worker
  (`fly secrets set --stage` plus a deploy, so it is one rollout).
- **Switch a store off:** the partner calls `disable`, or run
  `update control_plane.partner_clients set status = 'disabled'`.
- **Audit:** `partner.client_provisioned`, `partner.client_updated` and
  `partner.client_disabled` in `control_plane.audit_log`. The functions log
  `partner_client_provisioned` and `partner_provision_*`; nothing is logged
  with a key or token.
- **Deploy:**
  - Migration 0195: the checksummed runner, as the deployer.
  - Edge functions: `supabase functions deploy partner-session --no-verify-jwt`
    and `… partner-provision --no-verify-jwt`, with
    `--project-ref jjiugnriaypjoxsupjft`.
  - Worker: `fly deploy -c deploy/fly/sync-worker.dogfood.toml`.
  - Web: `vercel deploy --prod`.

## Deploy (2026-09-24)

- **Control plane:** migration 0195 was applied by the checksummed runner
  with the migration-owner role, using the local administrator login because
  no dedicated deployer URL was configured. The five RPCs are executable by
  `service_role` only. `partner_clients` grants nothing to client roles, and
  the worker cannot read `key_sha256`.
- **Edge functions:** `partner-provision` (new) and `partner-session` were
  deployed with `--use-api`. `ALBERT_PARTNER_PLATFORMS` holds Yellow Jersey's
  platform-key digest. Ashburton still mints through `ALBERT_PARTNER_CLIENTS`
  (checked live).
- **Worker:** `albert-sync-worker-dogfood`, deployment
  `fly-sync-worker-0249cfec-20260924T071942Z`, built from 0249cfe, with
  `ALBERT_PARTNER_TOKEN_BROKERS` staged into the same rollout. Nothing on the
  worker's code paths changed between the image it replaced (3e42311) and
  this branch's base.
- **Web:** `dpl_ArjV7dWkcA2ZpePuG5gMBLez2bgA`, release SHA 0249cfe. A first
  attempt from a git **worktree** (`dpl_8s2JE9dqBxGSKafeNkuMV9SCW2Jt`)
  shipped without Vercel git metadata. That left the release identity empty,
  and every authenticated route answered 503 for about three minutes. It was
  rolled back to `dpl_GT5DYszt58QaEWTLJxvqFQ2XuuHB`, then redeployed from a
  plain clone. **Deploy the web from a normal checkout, never a worktree.**
- **Verified live with a made-up store** (Yellow Jersey "Albert Provisioning
  Test Shop"):
  - provisioning created tenant `01M395QZ8S6G72EY21RXT8AFT8`, and a repeat
    run was idempotent;
  - the DB-backed client minted a session (`/api/session` 200 as owner);
  - `POST /api/partner/sources` for Lightspeed went through the worker to
    Yellow Jersey's broker and back with an honest
    `fivetran_partner_grant_expired: not_connected`, because the test store
    has no grant;
  - a tenant without a binding (Ashburton) was refused with
    `fivetran_partner_binding_not_found`.

  No Fivetran connection was created. Fivetran's plan is still paused, and
  the only real grants belong to Ashburton, which would be a duplicate copy.
- **Cleanup found a pre-existing bug:** this was the project's first
  tenant-scope deletion. `purge_tenant_control` fails with 42501 on
  `managed_agent_sessions` (0193): its FORCE RLS actor policy calls
  `require_current_tenant_id()`, which raises "authentication required" in
  the deletion worker's context. `partner_clients` purges cleanly. Until that
  policy is fixed, no tenant can be erased. The test tenant is disabled and
  waits in `deleting` (request `01M3962W58HKB38S1XCBH2KVD6`, `retry_wait`).
