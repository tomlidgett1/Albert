# ADR 0039: User-bound organisation creation throttling

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert security, control-plane, and product
- Relates to: ADR 0024, ADR 0036, ADR 0037

## Context

Organisation creation previously used the ordinary tenant-scoped rate limiter.
That boundary is unavailable after a completed tenant deletion, precisely when
the requesting human is allowed to create a replacement. It also lets a user
reset the effective limit by selecting another organisation. Removing the
limit would expose a public authenticated resource-creation path; retaining a
tenant dependency would break deletion continuity.

## Decision

Explicit organisation creation consumes a fixed five-per-24-hour limit keyed
to the authenticated Supabase user before any tenant row is created. The key is
a domain-separated SHA-256 digest of the Auth UUID. The control plane never
stores the UUID in the limiter, and selection or deletion of a tenant cannot
reset or bypass the bucket. A per-user transaction advisory lock serialises
bootstrap, replacement, and deletion transitions.

The pseudonymous bucket table is outside tenant scope, has forced RLS, and is
accessible only to the migration owner through one fixed private consumer.
Authenticated, anonymous, service-role, and runtime identities have no table
or private-function privileges. Pre-0056 tenant-scoped creation buckets are
removed during upgrade.

Committed buckets older than three days are deleted by a fixed security-definer
function. A protected administrator upgrade schedules that no-argument function
hourly through pg_cron and consumes its temporary migration-owner scheduling
grant. The same upgrade repairs either valid ordering: upgrade-before-migration
or migration-before-upgrade.

## Consequences

- A user can create a replacement after terminal deletion without depending on
  a deleted tenant.
- Switching organisations, deleting one, or opening concurrent sessions cannot
  increase the creation allowance.
- Independent users have independent limits without storing a directly
  enumerable Auth identifier in the limiter.
- Quiet systems still enforce bounded pseudonymous retention; cleanup does not
  depend solely on the next organisation creation.

## Verification

- `infra/bootstrap-upgrades/control-plane/0007_user_rate_limit_retention_cron.sql`
- `infra/migrations/control-plane/0056_m1_user_bound_organisation_creation_rate_limit.sql`
- `tests/sql/control-plane-user-organisation-rate-limit.sql`
- `tests/sql/control-plane-tenant-deletion-receipt.sql`
- `tests/contracts/admin-bootstrap-upgrades.contract.test.ts`
- `tests/contracts/organisation-management.contract.test.ts`
