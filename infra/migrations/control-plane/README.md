# Control-plane migrations

This directory contains the Supabase control-plane migration stream. It does
not contain analytical schemas or select an analytical database provider.

## Role boundary

- **Migration owner:** applies migrations and owns DDL. Its credentials are
  deployment-only and must never be available to a runtime process.
- **Named service groups:** `albert_sync_control`, `albert_webhook_control`,
  `albert_transform_control`, `albert_semantic_control`,
  `albert_operator_diagnostic_control`, and `albert_deletion_control` are
  NOLOGIN, non-inheriting capability boundaries.
  A process LOGIN belongs to exactly one and activates it with `SET LOCAL ROLE`.
- **`service_role`:** remains a Supabase platform role but has no final-state
  access to Albert's private schema. It is not an Albert runtime credential.
- **`authenticated`:** Supabase user role. Explicit table grants are narrowed
  by RLS. Tenant access is derived from an active `memberships` row using
  `auth.uid()`; a client-provided `tenant_id` is never sufficient.
- **`anon`:** has no access to the `control_plane` schema.

Tenant bootstrap is an authenticated SECURITY DEFINER transaction that creates
the tenant and first owner membership for `auth.uid()`. Subsequent browser
access remains membership-scoped. Tables containing worker/operator metadata
have RLS but no authenticated policy.

`oauth_token_refs` contains only a reference to separately envelope-encrypted
credential material, the encryption-key version, scopes, and lifecycle dates.
Ciphertext envelopes are worker-only; plaintext token bodies, vendor client
secrets, and decryption keys are prohibited from the relational control plane.
`oauth_credential_refresh_leases` serializes rotating-token exchange across
replicas using tenant/scope keys, crash expiry, renewal and monotonically
increasing fencing tokens. Runtime roles have no direct table access; the sync
role uses fixed functions and deletion uses active-claim-scoped wrappers.

`deputy_webhook_material` is a separate trust zone: one AES-GCM envelope per
Deputy connection, sealed with a webhook-only key and tenant/connection/material
associated data. The webhook identity cannot scan that table or read OAuth
references. It can resolve only the two ULIDs presented by a callback and can
enqueue only a fixed Deputy incremental-sync request after a verified receipt.
Material preparation is an explicit owner/operator installation procedure;
OAuth and sync never list, create, update, or delete Deputy Webhook resources.
Verified DELETE identities are bounded on `webhook_receipts`, linked to the
exact raw object, and carried as tombstone-reconciliation signals in that fixed
job so a vanished Resource cannot remain active after a read-only query.

`xero_webhook_inbox` is the durable, acknowledgement-first Xero boundary. The
public gateway can insert and lease only through narrowly granted functions; it
cannot scan the encrypted inbox, sequence state, OAuth references, or generic
queues. Exact signed bodies are encrypted with the dedicated Xero-inbox key,
then an asynchronous leased processor partitions tenant/category events, writes
tenant-scoped immutable raw objects, records first/last delivery sequences per
connection, and requests a bounded reconciliation sweep when it detects a gap.
Ciphertext expires after 31–35 days and is erased immediately after successful
processing; bounded metadata is purged no later than day 45.

## Lease-bound raw Storage authority

Customer raw-object access is not implied by possession of a purpose-specific
Supabase Auth machine session. Protected administrator upgrade
`0008_lease_bound_raw_storage_deletion.sql` leaves only fixed all-zero
readiness sentinels available without a grant and makes every customer branch
join live control-plane authority. Migration
`0057_m2_m7_m8_lease_bound_raw_storage_sessions.sql` is the corresponding
ordinary migration ledger entry. It creates three FORCE-RLS grant relations:

- sync grants bind one exact immutable batch key to a live write permit, queue
  attempt, running sync run, connection generation, and active tenant for at
  most five minutes;
- webhook grants bind one exact receipt key to a signed receipt and either
  active Deputy verifier material or the exact live Xero inbox lease for at
  most two minutes; and
- deletion grants bind one tenant or connection scope and one `purge` or
  `verify` operation to the exact live deletion request and queue attempt for
  at most five minutes.

Runtime roles have no direct access to the grant tables. Their narrow
SECURITY DEFINER issue/revoke functions require the exact fixed runtime LOGIN
and its purpose group, verify the active protected Auth user and signed Auth
`session_id`, and derive or validate scope against durable state. Storage RLS
rechecks that durable state on every statement, so lease loss, a later attempt,
connection fencing, deletion fencing, or a workflow-stage change denies access
before grant expiry. Concurrent exact grants may share one Auth session and are
revoked independently. See ADR 0040.

Upgrade 0008 must run before migration 0057 because Storage policies are owned
by the protected administrator while grant relations and runtime functions are
owned by the migration stream. The gap fails closed for customer operations.
Do not restore the earlier purpose-wide policies or deploy a pre-0057 runtime
after the administrator upgrade.

Operator row samples are mediated by short-lived, one-use reveal grants. The
authenticated issuer must be an allowlisted `internal_operator`, and the exact
stage/schema/table must already exist in `pipeline_stats`. The dedicated
operator-diagnostic control identity can only claim a grant and append its
completed/failed outcome; it has no direct table privilege. See ADR 0017.

Migrations must remain transactional and rerunnable. Lookup rows use conflict
handling, objects use idempotent DDL, and policies/triggers are replaced by
name. Apply files as the migration owner through the migration pipeline only.
