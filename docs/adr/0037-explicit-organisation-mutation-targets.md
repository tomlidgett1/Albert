# ADR 0037: Explicit organisation targets for human mutations

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert security, control-plane, and product
- Relates to: ADR 0004, ADR 0036

## Context

Albert persists one active organisation per user so every ordinary server read
can derive tenant scope without trusting a browser-supplied tenant id. That is
appropriate for navigation, but it is insufficient for a mutation submitted
from a browser tab that has become stale. A second tab may change the persisted
selection after the first tab rendered. If rename, membership, or deletion RPCs
resolve only the mutable current selection at submit time, an action intended
for the stale tab's organisation can be applied to a different organisation.
Identical display names make confirmation text unable to distinguish the two.

This is a confused-deputy boundary, not merely a user-experience race. A stale
member grant can disclose a different tenant, and a stale final deletion
approval can irreversibly erase it.

## Decision

Every human organisation mutation carries the exact tenant ULID returned in
the loaded organisation settings as `tenantId`. The API validates it and the
repository passes it to an `p_expected_tenant_id` RPC parameter. The database
does not treat that identifier as authority. A private fixed helper:

1. derives the authenticated actor from the managed Auth compatibility bridge;
2. acquires the same per-user transaction advisory lock used by organisation
   selection, bootstrap, creation, and deletion;
3. independently resolves the actor's persisted active organisation;
4. rejects with SQLSTATE `55000` unless it exactly equals the expected ULID;
5. locks the active tenant row; and
6. rechecks active membership and the required role after the lock.

Selection now takes the same user advisory lock and tenant-row lock. Every
rename, member add/update, deletion request, final approval, and cancellation
uses the helper. Membership operations retain the tenant row as their
roster-wide mutex and preserve the final-active-owner invariant. All legacy
context-only overloads are revoked and dropped, so PostgREST and direct callers
cannot omit the expected target. A conflict returns HTTP 409 with an instruction
to refresh; it is never silently retried against newly selected context.

The tenant id is therefore an optimistic concurrency precondition, not a
tenant authorization claim. Server-derived membership and role checks remain
the sole authority.

## Consequences

- Two browser tabs cannot rename, grant, revoke, request deletion, approve
  erasure, or cancel against one another's selected organisations.
- Same-named organisations remain unambiguous because the confirmation is
  bound to an exact ULID before its text is checked.
- Selection and mutation have one serial order for each human user.
- A legitimate stale action requires refresh and deliberate resubmission.
- Service-owned operations remain separately capability-scoped and do not use
  this human UI boundary.

## Verification

- `infra/migrations/control-plane/0055_m1_m8_explicit_organisation_mutation_targets.sql`
- `tests/sql/control-plane-explicit-organisation-targets.sql`
- `tests/contracts/organisation-management.contract.test.ts`
- `services/control-plane/src/organisation-repository.ts`
- `app/api/organisations/route.ts`
- `app/api/organisations/members/route.ts`
- `app/api/tenant/deletion/route.ts`
- `app/dash/components/OrganizationWorkspace.tsx`
