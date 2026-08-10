# ADR 0079: Two-project Supabase production topology

- Status: accepted
- Date: 2026-08-10
- Extends: ADR 0024, ADR 0077, and ADR 0078

## Context

Albert requires two independently isolated Sydney PostgreSQL cells: a control
plane for Auth, queues, semantic governance, conversations and raw Storage, and
an analytical database whose ingest and query workloads cannot contend with
customer login or control traffic. The founding specification explicitly
permits a second Supabase project for the analytical cell. The production
provider had remained an operator-owned decision.

The production bootstrap was exercised against two new Supabase projects in
`ap-southeast-2`. That proved the intended workload and credential separation,
but also exposed a provider-specific difference: Supabase's protected
`postgres` identity is not a superuser and cannot activate a newly created
NOLOGIN migration owner until it receives explicit membership.

## Decision

Production uses two separate Supabase projects in Sydney:

1. **Control project** — Supabase Auth, `pgmq`, `pg_cron`, `vector`, the Albert
   control-plane schemas and private `raw-payloads` Storage bucket.
2. **Analytical project** — Albert staging, canonical, mart, semantic metadata,
   evidence and cache schemas only. Its Auth, Storage and Data API are not Albert
   runtime boundaries.

The projects use separate administrator credentials, migration owners, runtime
logins, connection limits, backups and release evidence. No Albert runtime may
receive an administrator credential. Connections use required TLS and the
strongest provider-supported endpoint: the control cell may use Sydney
Supavisor session pooling, while analytical runtimes use the project's direct
IPv6 endpoint because the production pooler's external-auth query did not
reliably admit the custom NOINHERIT roles. The cache, tenant-capability and RLS
boundaries remain unchanged.

During a fresh analytical bootstrap, the migration runner checks whether the
administrator can `SET` the exact `albert_migration_owner` role. Only when the
stream is analytical and both `current_user` and `session_user` are the exact
protected `postgres` identity may it add the bounded membership already used by
the control bootstrap. The runner verifies the resulting `SET` capability
before applying any migration. No runtime identity receives that membership.

Provider project references, endpoints, role passwords and deployment tokens
remain environment-owned configuration. This ADR records the provider and
security model, not credential material.

## Consequences

- Control and analytical workloads remain physically isolated even though the
  provider is shared.
- One provider supplies Sydney residency, managed backups and operational
  consistency for both cells; an incident affecting the provider remains a
  correlated availability risk.
- The analytical project carries unused Supabase product surfaces. They are not
  granted to Albert runtimes and must not be advertised as application APIs.
- Migrating analytics to another PostgreSQL 17 provider remains possible
  because semantic execution, capabilities and role contracts depend on
  PostgreSQL rather than Supabase APIs.
