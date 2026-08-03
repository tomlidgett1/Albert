# Control-plane migrations

This directory contains the Supabase control-plane migration stream. It does
not contain analytical schemas or select an analytical database provider.

## Role boundary

- **Migration owner:** applies migrations and owns DDL. Its credentials are
  deployment-only and must not be available to any runtime process.
- **`service_role`:** trusted backend and worker identity. It owns no DDL, but
  may maintain control-plane state, append audit records, and resolve OAuth
  token references. It must never be sent to a browser or model.
- **`authenticated`:** Supabase user role. Explicit table grants are narrowed
  by RLS. Tenant access is derived from an active `memberships` row using
  `auth.uid()`; a client-provided `tenant_id` is never sufficient.
- **`anon`:** has no access to the `control_plane` schema.

Tenant bootstrap is a trusted server transaction: create the tenant and its
first owner membership with `service_role`. Subsequent browser-visible access
is membership-scoped. Tables containing worker/operator metadata have RLS but
no authenticated policy.

`oauth_token_refs` contains only a reference to separately envelope-encrypted
credential material, the encryption-key version, scopes, and lifecycle dates.
Token bodies, vendor client secrets, and decryption keys are prohibited from
the relational control plane.

Migrations must remain transactional and rerunnable. Lookup rows use conflict
handling, objects use idempotent DDL, and policies/triggers are replaced by
name. Apply files as the migration owner through the migration pipeline only.
