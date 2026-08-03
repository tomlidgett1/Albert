# ADR 0036: User-bound receipts for tenant deletion continuity

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert security, control-plane, and product
- Relates to: ADR 0004, ADR 0014, ADR 0035

## Context

Approving tenant deletion immediately suspends every membership and fences new
writes. That is the correct security boundary, but it also removes the active
tenant context used by the dashboard. A naïve session reload consequently
looks identical to a new account and may silently bootstrap a replacement
tenant. It also leaves the requesting human unable to observe deletion progress
or retrieve the terminal proof after the tenant anchor has been erased.

Keeping a membership or tenant-scoped status row readable during deletion would
weaken the erasure boundary. Adding user identity to the global deletion-proof
ledger would make its privacy-minimised, non-enumerable evidence less narrow.
The continuity mechanism therefore needs to survive tenant erasure without
retaining a tenant id, organisation name, source identifier, or customer data.

## Decision

The control plane maintains a dedicated `tenant_deletion_receipts` table keyed
by deletion request id and the requesting Supabase Auth user. An owner-only
trigger mirrors lifecycle state from the governed deletion request. A second
trigger binds the exact immutable proof id and digest before the tenant request
and tenant anchor are removed. The retained receipt contains only timestamps,
status, a bounded error code, and the hash-only terminal proof reference.

Authenticated users cannot read the table. Two fixed `SECURITY DEFINER` RPCs
derive the caller solely from `auth.uid()` and return either an exact receipt or
the caller's current receipt. Cross-user discovery returns no row. Runtime,
service-role, anonymous, and public table access is revoked; forced RLS admits
only the migration owner used by the fixed trigger and RPC implementations.

Deletion request, automatic bootstrap, and explicit organisation creation take
the same per-user advisory boundary and select context only after acquiring it.
Creation fails closed while a receipt is active or failed. One atomic session
RPC reads context and receipt from the same database snapshot; any nonterminal
post-approval receipt dominates another active organisation until erasure is
terminal. The dashboard therefore detects the user-bound receipt before
bootstrapping, renders the durable lifecycle independently of tenant context,
polls through completion, and allows the proof JSON to be downloaded. A new
organisation can be created only through an explicit human action after the
prior deletion is terminal.

The receipt does not replace the append-only deletion proof. It is a narrow,
user-bound continuity index to that proof; the deletion worker remains the only
production authority that can complete the underlying job.

## Consequences

- Reloading after approval cannot create an unintended replacement tenant.
- The requester can observe queued, running, retry, verification, failure, and
  terminal states after all memberships have been suspended.
- Completion remains demonstrable without preserving tenant-identifying data in
  the receipt or adding a user id to the global proof ledger.
- A failed deletion remains fenced until operators resolve and complete or
  cancel the governed request; failure never re-enables ordinary onboarding.
- Auth-account deletion also removes its user-bound receipt through the Auth
  foreign key, while the non-enumerable global proof remains append-only.

## Verification

- `infra/migrations/control-plane/0053_m8_user_bound_tenant_deletion_receipts.sql`
- `tests/sql/control-plane-tenant-deletion-receipt.sql`
- `tests/contracts/tenant-deletion-receipt.contract.test.ts`
- `app/api/session/route.ts`
- `app/api/tenant/deletion/route.ts`
- `app/dash/components/TenantDeletionWorkspace.tsx`
