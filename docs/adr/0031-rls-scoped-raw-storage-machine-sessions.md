# ADR 0031: RLS-scoped raw Storage machine sessions

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert platform and security
- Supersedes: Raw-storage credential portions of ADR 0004, ADR 0006, and ADR 0024
- Superseded by: ADR 0040 for customer-object authorization only

## Partial supersession

ADR 0040 replaces the ambient customer-key authority described in this ADR.
A mapped purpose principal now has grant-independent access only to its fixed
all-zero readiness sentinel or sentinels. Every customer read, insert, list, or
delete additionally requires an ephemeral exact Auth-session grant joined to
the still-live sync permit, webhook receipt and verifier lease, or deletion
request and attempt. This ADR remains authoritative for the three machine
identities, Supabase S3 session protocol, secret ownership, command-module
separation, immutable writes, readiness sentinels, provisioning, and rotation.

## Context

Albert's sync worker, webhook gateway, and deletion worker need mutually
incompatible access to the private `raw-payloads` bucket. Ingestion must create
immutable evidence and verify exact retries but must never update or delete it.
Deletion must enumerate and remove governed evidence but must never create or
replace it. Sync polling and webhook receipt evidence must also be invisible to
one another.

Supabase-generated S3 access keys are unsuitable for that boundary. Generated
keys bypass Storage row-level security and grant full bucket operations. Giving
one to any Albert runtime would make an application-level split cosmetic: a
compromised ingestion process could delete evidence and a deletion process
could manufacture it. A Supabase `service_role` credential has the same RLS
bypass problem and additionally crosses the Storage-only trust boundary.

Supabase's S3-compatible API also has a distinct session-credential protocol.
Its access key ID is the project reference, its secret access key is the legacy
`anon` JWT, and its session token is a signed-in user's short-lived access JWT.
Supabase publishable keys cannot be used as the S3 secret access key.

## Decision

### Three Auth principals are the authority

The protected provisioner owns exactly three deterministic Supabase Auth users:

| Purpose | Auth identity | Baseline command family |
| --- | --- | --- |
| Sync | `raw-storage-sync@machine.albert.invalid` | `INSERT`, `SELECT` for non-webhook `*.jsonl.gz` batches |
| Webhook | `raw-storage-webhook@machine.albert.invalid` | `INSERT`, `SELECT` for Xero/Deputy webhook `*.json.gz` receipts |
| Deletion | `raw-storage-deletion@machine.albert.invalid` | `SELECT`, `DELETE` for either governed raw format |

Each Auth user has immutable application metadata naming the exact purpose and
`albert_machine_principal=true`. The administrator-owned
`albert_bootstrap.raw_storage_machine_principal` table binds each purpose to one
Auth user ID and one monotonically increasing credential generation. No
browser, runtime database role, migration role, `authenticated`, or
`service_role` identity can read or change that mapping.

Six explicit `storage.objects` policies consult both the signed JWT claims and
the protected mapping. Under ADR 0040, the table above is only a command-family
ceiling: customer-object branches also require an exact, ephemeral grant for
the JWT `session_id` and live durable work. The policies constrain bucket,
canonical tenant/connection path, stream family, suffix, and SQL command. There
is no Albert `UPDATE` policy, no ingestion `DELETE` policy, and no deletion
`INSERT` policy. The administrator bootstrap owns the mapping and authorization
helpers; an immutable control-plane migration verifies and seals the policy
set.

### Runtime credentials are short-lived sessions

Each storage-enabled runtime receives only:

- the direct project S3 endpoint and locked region;
- the project reference as `SUPABASE_STORAGE_S3_ACCESS_KEY_ID`;
- the legacy anon JWT as `SUPABASE_STORAGE_S3_LEGACY_ANON_KEY`; and
- that process's one machine password.

The runtime signs in through Supabase Auth's password grant, validates the
returned user ID, `authenticated` role/audience, expiry, and exact application
metadata, and supplies the user access JWT as the AWS `sessionToken`. It caches
the session in memory, refreshes before expiry, serializes concurrent refreshes,
and falls back to the protected password only when a refresh token is rejected.
Tokens, passwords, and provider response bodies are never logged.

The Auth Admin service-role JWT, protected `postgres` URL, credential generation,
and the other two machine passwords are provisioner-only. They are globally
forbidden in runtime contracts. Generated S3 key vocabulary is also forbidden.

### Command surfaces are split at build time

Ingestion and deletion use different adapters and entry-point imports. The
ingestion module imports only S3 get/put commands and exposes only conditional
create/read operations. The deletion module imports only list/delete commands
and exposes only bounded prefix enumeration and deletion. Service-bundle checks
fail if a forbidden command class, another purpose's password name, an Auth
Admin credential, or a generated S3 credential appears in the artifact.

All raw writes use `If-None-Match: *`. An existing batch is accepted only after
the service reads and verifies its immutable bytes. Deletion remains
idempotent, and the deletion workflow re-lists the prefix after every bounded
page because S3 can report a successful delete for an RLS-hidden object.

### Provisioning, readiness, and rotation are release gates

`npm run provision:raw-storage-machine-users` runs only in the protected release
context. It requires the exact managed `postgres` login and Auth Admin
credential, takes a transaction advisory lock, refuses generation rollback or
reserved-identity disagreement, creates or rotates the three users, commits the
mapping, and verifies the same S3 session path used by production runtimes.

The sync and webhook sessions create or read two fixed gzip readiness objects
under the all-zero, non-customer tenant/connection prefix. The deletion session
must enumerate both. A missing or RLS-hidden sentinel fails closed; a corrupt
sentinel also fails. These objects are outside every database-backed tenant
deletion claim and contain no customer data. They let readiness distinguish a
working mapped session from the otherwise indistinguishable empty result that
Storage returns for an RLS-hidden object.

Rotation generates three new distinct 32-to-256-byte passwords, stages each
password only in its owning Fly app, increments
`ALBERT_RAW_STORAGE_CREDENTIAL_GENERATION`, and reruns the provisioner before
rolling deployment. Reusing a generation is idempotent and deliberately does
not change passwords. Decreasing a generation is rejected.

For local Supabase only, the documented S3 access key ID is `stub` and the
region is `local`. Production accepts only the direct HTTPS
`<project-ref>.storage.supabase.co/storage/v1/s3` endpoint, a matching project
reference, the Sydney Storage region, and a legacy anon JWT for that project.

## Verification

- `tests/sql/control-plane-raw-storage-authority.sql` proves the mapping ACL,
  exact policy matrix, path and session isolation, live-work fencing,
  unmapped-JWT denial, and absence of update/write escalation in PostgreSQL.
- `npm run test:raw-storage-s3-session` uses real Supabase Auth and the real S3
  protocol to prove sentinel-only ambient access, lease-bound sync/webhook
  isolation, immutable writes, forbidden ingestion deletion, forbidden
  deletion writes, and deletion verification.
- CI provisions the three users in a disposable local Supabase project and runs
  both proofs after administrator upgrades and migrations.
- Deployment, source-boundary, configuration, and service-bundle contracts
  prevent admin or cross-purpose credentials and command implementations from
  reaching a runtime.

## Consequences

- A compromise of one raw-storage runtime is limited by database-enforced
  purpose and command policies and, under ADR 0040, by exact short-lived grants
  joined to still-live durable work rather than TypeScript interfaces alone.
- The legacy anon JWT is shared session-envelope material, not authorization;
  the short-lived mapped user JWT is the Storage authority. It remains a secret
  because Supabase currently requires it for S3 session credentials.
- Raw-storage password rotation is a coordinated protected-release operation,
  not an ad hoc Fly secret edit.
- Two small immutable readiness objects remain in the bucket. This is an
  intentional operational proof, contains no tenant data, and avoids giving an
  ingestion runtime delete authority merely to clean up health probes.
- A future Supabase change that supports publishable keys or a different S3
  session exchange requires a new ADR, contract update, and real protocol proof.

## Rejected alternatives

- **Generated S3 access keys:** bypass RLS and grant every bucket operation.
- **A service-role key per process:** still bypasses RLS and expands authority
  beyond Storage.
- **One shared machine user:** cannot enforce sync/webhook isolation or separate
  immutable ingestion from destructive deletion.
- **Static TypeScript interfaces only:** do not constrain a compromised process
  or an accidentally imported AWS command.
- **A missing-object readiness read:** returns the same visible result when RLS
  hides all rows and therefore cannot prove the principal mapping.
- **Per-startup temporary probes:** ingestion cannot clean them up without
  violating the no-delete invariant and would create unbounded bucket litter.

## References

- [Supabase S3 authentication](https://supabase.com/docs/guides/storage/s3/authentication)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
