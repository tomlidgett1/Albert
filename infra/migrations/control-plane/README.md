# Control-plane migrations

This directory contains the Supabase control-plane migration stream. It does
not contain analytical schemas or select an analytical database provider.

## Role boundary

- **Migration owner:** applies migrations and owns DDL. Its credentials are
  deployment-only and must never be available to a runtime process.
- **Named service groups:** `albert_sync_control`, `albert_webhook_control`,
  `albert_transform_control`, `albert_semantic_control`, and
  `albert_deletion_control` are NOLOGIN, non-inheriting capability boundaries.
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

`xero_webhook_inbox` is the durable, acknowledgement-first Xero boundary. The
public gateway can insert and lease only through narrowly granted functions; it
cannot scan the encrypted inbox, sequence state, OAuth references, or generic
queues. Exact signed bodies are encrypted with the dedicated Xero-inbox key,
then an asynchronous leased processor partitions tenant/category events, writes
tenant-scoped immutable raw objects, records first/last delivery sequences per
connection, and requests a bounded reconciliation sweep when it detects a gap.
Ciphertext expires after 31–35 days and is erased immediately after successful
processing; bounded metadata is purged no later than day 45.

Migrations must remain transactional and rerunnable. Lookup rows use conflict
handling, objects use idempotent DDL, and policies/triggers are replaced by
name. Apply files as the migration owner through the migration pipeline only.
