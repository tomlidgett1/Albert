# ADR 0128: turn lease renewal must be reachable

- Status: accepted
- Date: 2026-08-26
- Repairs: migration 0084's renewal path (ADR 0110/0111/0120 runtimes)

## Context

Migration 0084 made conversation turn leases renewable so the six-minute lease
could reap dead runners without capping how long a live analytical turn may
run. The web runtime renews on a 120-second interval through
`supabase.rpc("renew_albert_turn_lease")` — but PostgREST resolves RPC names in
the exposed `public` schema only, and 0084 created the function solely in the
private `control_plane` schema. Every renewal since then returned 404, the
helper swallowed the error, and any turn longer than the initial 360-second
lease lost it mid-analysis. The semantic layer then rejected each later
governed query ("semantic turn lease is not active") and the turn surfaced the
generic hard-failure message.

Production evidence (2026-08-25, run 01M0XMB1YAQETJV0JQEF81VK0J): 23
consecutive `POST 404 /rest/v1/rpc/renew_albert_turn_lease` edge-log entries
while two swarm children died at the six-minute mark. The swarm heartbeat and
agent lifecycle routes renew the parent turn's lease through the same helper,
so ADR 0120's lease-gated reconciliation would also have misread every live
run as stranded.

## Decision

1. Migration 0174 adds `public.renew_albert_turn_lease`, following the
   established public turn-RPC pattern (`fail_albert_turn`): SECURITY DEFINER,
   scoped by `require_current_tenant_id()` and the turn's `created_by` actor,
   with 0084's bounds check and the status/lease predicates that refuse to
   revive settled or reaped turns. `conversation_turns` carries no
   authenticated RLS policy, so an invoker-delegating wrapper would silently
   update zero rows — the definer pattern is the reachable one.
2. `renewConversationTurnLease` logs a warning on every failed renewal. The
   defect survived for months because the only failure signal was swallowed;
   a renewal that fails while a turn streams is now visible in web logs.

## Update — 2026-08-26: the 0084 body was also broken

An impersonated functional test on production (renew as the owner over a
temporarily revived turn, rolled back) failed with 42703:
`conversation_turns.updated_at` does not exist. 0084's body — copied into
0174's wrapper — always referenced a column the table never had, so even a
reachable renewal would have raised on first call. Migration 0176 rewrites
both bodies to touch only `lease_expires_at`. The same test now returns a
lease exactly `p_lease_seconds` ahead of `clock_timestamp()`.

## Consequences

- Long analytical turns — swarm children at max effort, Pro reasoning runs —
  survive past six minutes; the reaper still recovers turns whose runner died,
  because a dead runner stops renewing.
- The lease gate in `albert_swarm_reconcile_run` (migration 0175) becomes
  trustworthy: a held lease now proves a live orchestrator.
- Grants stay least-privilege: `authenticated` only; `anon` and
  `service_role` are revoked, matching 0105/0172's posture.
