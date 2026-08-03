# ADR 0024: Managed Supabase Auth compatibility boundary

- Status: Accepted
- Date: 2026-08-03
- Decision owners: Albert platform
- Relates to: ADR 0003, ADR 0006, ADR 0023

## Context

Supabase's protected `postgres` login is intentionally not a PostgreSQL
superuser. On the managed Auth schema it receives `USAGE` and
`REFERENCES auth.users`, but not their grant options. Consequently a base
bootstrap executed by `postgres` can use those privileges while its `GRANT`s to
Albert's dedicated NOLOGIN migration owner produce warnings and confer
nothing. Migration `0001` then fails as soon as that owner creates its first
Auth user foreign key.

Using the inaccessible `supabase_admin` or `supabase_auth_admin` credentials is
not an operational design. Making every migration run as `postgres`, exposing
an arbitrary administrator-owned DDL function, granting a broad predefined
read role, or making the migration owner inherit `authenticated` would weaken
the dedicated ownership boundary. Rewriting historical migration files would
also invalidate the exact-checksum ledger of an existing database.

The same managed-role model affects pg_cron: protected `postgres` is not a
superuser, so passing the literal username `postgres` to
`schedule_in_database` is rejected as scheduling for another role. Omitting
the username lets pg_cron bind the current fixed SECURITY DEFINER identity.
Supabase Storage similarly grants table DML to `postgres` and the migration
owner, but `storage.buckets` has RLS with no application policy. Only protected
postgres has `BYPASSRLS`; a migration-owner bucket insert therefore fails even
though its table privilege check succeeds.

The same protection hook rejects an `ALTER ROLE` that merely restates
`NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, or
`NOBYPASSRLS`. Runtime-login provisioning therefore cannot use a broad
attribute-reset statement under managed `postgres`.

## Decision

The independently checksummed administrator-upgrade stream installs four
fixed capabilities as the protected `postgres` login:

1. `extensions.albert_auth_uid()` and `albert_auth_jwt()` expose only the same
   caller claims already available to Supabase policy roles.
2. `albert_auth_users_by_ids(uuid[])` returns only id, email, and confirmation
   time for a bounded set of exact UUIDs. The confirmed-email lookup returns
   those same fields for one validated normalized address. Only the NOLOGIN
   migration owner may execute these directory helpers; generic Supabase roles
   cannot.
3. `albert_install_auth_user_foreign_keys()` has no arguments and contains the
   fixed 28-table/column/constraint/delete-action allowlist reviewed for V1. It
   verifies existing definitions or installs missing constraints, requires
   every source table to remain migration-owned, removes the temporary direct
   column read, and revokes its own execution grant atomically.

Historical migration bytes and ledger checksums remain unchanged. The runner
has an explicit compatibility manifest for every historical file containing an
Auth dependency. Execution is permitted only when migration id, SHA-256, and
the exact counts of foreign keys, directory reads, `uid` calls, and `jwt` calls
all match. It removes the reviewed inline foreign-key clauses, redirects the
three exact directory reads and caller-claim calls to the fixed helpers, and
fails closed on every unknown or changed direct dependency. The ledger still
records the immutable source-file checksum.

Migration `0042_m0_m1_supabase_auth_compatibility_boundary.sql` replaces the
two organisation functions on already-migrated databases, consumes the fixed
foreign-key installer, and verifies the final boundary. Fresh databases and
databases with only the base-bootstrap ledger therefore converge to the same
schema; already-migrated databases retain their exact historical prefix and
only apply the additive boundary migration.

The migration owner remains `NOLOGIN NOINHERIT`, owns all Albert schema
objects, and has zero parent-role memberships. It cannot use the Auth schema,
read the Auth user table, create an arbitrary Auth foreign key, or impersonate
`authenticated` after migration `0042` completes.

Administrator upgrade `0003_managed_postgres_cron_identity.sql` supersedes the
legacy fixed cron installers without changing their original checksum. Each
wrapper still has no arguments and retains one hard-coded job name, schedule,
database and SQL command, but passes a NULL username so pg_cron derives the
current postgres definer. No wrapper accepts an arbitrary role or command.

Administrator upgrade `0004_raw_payload_bucket_installer.sql` exposes one
additional no-argument, postgres-owned capability. It can only converge the
`raw-payloads` bucket to its fixed private 50 MiB gzip-only definition and then
revokes itself. The exact-checksum compatibility rule removes the one legacy
inline Storage mutation from migration `0003`; migration `0042` consumes the
fixed installer for both fresh and already-migrated databases.

The runtime-login provisioner fails closed if a pre-existing Albert login has
any privileged role attribute. For a new login, all dangerous attributes are
set false at creation. Reconciliation then changes only `LOGIN`, `NOINHERIT`,
the fixed connection limit, and password—the ordinary attributes permitted by
managed `postgres`—and verifies every dangerous attribute remains false before
commit.

## Consequences

- Production needs only the normal protected Supabase `postgres` connection
  for the one-time/bootstrap-upgrade stream; no managed internal-role password
  is required.
- Administrator code is fixed-input and checksum-versioned. A future Auth user
  reference requires a new reviewed administrator helper and migration; adding
  a direct reference to an ordinary migration fails CI and the runner.
- Auth remains outside the Data API and outside runtime service identities.
  Only scoped public RPCs can indirectly resolve the minimal directory fields.
- The compatibility transformation is intentionally narrow and auditable. Any
  edit to a historical file or change in dependency count is a release error,
  not an automatic rewrite.
- Cron jobs retain the protected postgres execution identity without requiring
  superuser status or an impersonated role argument.
- Storage RLS remains closed to the migration owner and every runtime database
  role; ADR 0031 grants raw-object access only to three mapped, short-lived Auth
  machine sessions with purpose-specific `storage.objects` policies.
- Runtime login creation and rotation work with protected managed `postgres`;
  an unsafe pre-existing role requires explicit administrator investigation
  instead of being silently rewritten.

## Verification

- `tests/sql/supabase-auth-bootstrap-precondition.sql`
- `tests/sql/control-plane-auth-compatibility.sql`
- `tests/contracts/supabase-auth-bootstrap.contract.test.ts`
- `tests/contracts/admin-bootstrap-upgrades.contract.test.ts`
