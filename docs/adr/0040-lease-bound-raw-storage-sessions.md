# ADR 0040: Lease-bound raw Storage sessions

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert platform and security
- Supersedes: ADR 0031 customer-object authorization only
- Relates to: ADR 0004, ADR 0006, ADR 0016, ADR 0020, ADR 0024, ADR 0036

## Context

ADR 0031 separated raw Storage into three protected Supabase Auth machine
identities and gave each identity a different command and path family. That
removed generated S3 keys and `service_role` from Albert runtimes, preserved
Storage RLS, and prevented one purpose from assuming another purpose's command
surface.

Purpose and path constraints are necessary but not sufficient for customer
objects. A valid sync session could still read any sync object or create any
syntactically valid batch for any tenant and connection. A webhook session
could do the equivalent for receipts. A deletion session could enumerate and
delete every governed raw object. Those ambient permissions outlived the
individual queue lease, write permit, verified receipt, or deletion attempt
that justified access. Compromise of one runtime therefore exposed the full
customer-data authority of that purpose.

Raw-object authority must have the same durable provenance and fencing as the
work that caused the operation. It must also preserve ADR 0031's real
Supabase S3 protocol, immutable-write behavior, fixed non-customer readiness
objects, machine-user rotation, and build-time separation of AWS commands.

## Decision

### Auth proves the machine; a live grant proves the work

Each process keeps one reusable, short-lived Supabase Auth session for its
purpose and replica. Concurrent operations may share that Auth session. The
JWT's immutable user identity proves which of the three protected machine
principals is calling, while its signed `session_id` identifies the exact Auth
session.

Customer-object access additionally requires an ephemeral database grant bound
to that `session_id` and independently durable work. The control plane has
three FORCE-RLS relations:

| Purpose | Grant scope | Maximum lifetime | Durable authority |
| --- | --- | --- | --- |
| Sync | One exact immutable object key | 5 minutes | Exact write permit, current queue attempt, running sync run, connection generation, and active tenant |
| Webhook | One exact receipt object key | 2 minutes | Signed receipt plus active Deputy verification material or the exact live Xero inbox lease |
| Deletion | One tenant or connection scope and one `purge` or `verify` operation | 5 minutes | Exact deletion request, queue message, worker, attempt, visibility lease, and workflow stage |

The runtime roles have no direct table privilege. Narrow SECURITY DEFINER
issuers and revokers require the exact fixed runtime login as `session_user`
and its one NOLOGIN purpose group as the active role. An issuer also verifies
that the presented Auth user is the currently active protected machine user
for that purpose. Possessing only a database credential or only a machine Auth
session is therefore insufficient.

An issuer derives or validates scope from durable state rather than trusting a
runtime-supplied tenant boundary:

- Sync derives the canonical batch key from the claimed job request and checks
  the exact permit, attempt, run, connection generation, tenant state, and
  deletion fences.
- Webhook derives the canonical receipt key. Deputy authority names active
  verification material; Xero authority names the exact processing inbox
  lease owner, token, version, and expiry.
- Deletion derives tenant versus connection scope from the deletion request.
  `purge` is available only while the request is `running`; `verify` is
  available only while it is `verifying`.

The issued expiry is the earliest of the Auth token expiry, durable lease or
permit expiry, and the purpose cap. Issuers reject grants with less than five
seconds remaining. Issuance boundedly reaps expired rows and revocation deletes
the exact grant, so normal operation does not accumulate an unbounded grant
ledger.

### Storage RLS revalidates authority at every statement

The six `storage.objects` policies retain ADR 0031's command split but remove
ambient customer access:

| Purpose | Customer-object policy |
| --- | --- |
| Sync | `SELECT` or `INSERT` only when the JWT user and `session_id` match an unexpired exact-key sync grant whose permit, attempt, run, connection, tenant, and deletion fences are still live |
| Webhook | `SELECT` or `INSERT` only when the JWT user and `session_id` match an unexpired exact-key webhook grant whose receipt and Deputy verifier or Xero inbox lease are still live |
| Deletion `purge` | `SELECT` and `DELETE` only inside the exact tenant or connection scope while the exact request and attempt remain live and `running` |
| Deletion `verify` | `SELECT` only inside the exact tenant or connection scope while the exact request and attempt remain live and `verifying` |

Grant expiry alone is not the revocation boundary. Each policy dynamically
joins the durable control-plane records on every Storage statement. Completion,
lease loss, a later attempt, connection generation change, tenant deletion
fence, verifier retirement, or workflow-stage transition immediately removes
authority even if both the Auth token and grant row have time remaining.

There is no Albert Storage `UPDATE` policy. Sync and webhook cannot delete.
Deletion cannot insert or update, and a verification grant cannot delete.
Multiple exact grants may coexist for one Auth `session_id`; revoking one does
not affect a sibling grant and never broadens its scope.

### Ambient authority is readiness-only

Without a live customer grant, each machine principal can access only the
fixed all-zero, non-customer readiness object or objects assigned in ADR 0031.
Unscoped adapters expose only those probes. Customer operations require a
scoped adapter, and the adapter validates the exact key or prefix before S3
I/O.

For each customer operation the service:

1. obtains or refreshes its reusable purpose-specific Auth session;
2. issues an exact grant using only the non-secret Auth user and session
   identity;
3. creates a purpose-specific S3 client whose effective credential lifetime is
   capped by the grant;
4. performs only the scoped operation; and
5. destroys the client and attempts revocation of every grant obtained,
   including refreshed grants, on success or failure.

No access token, refresh token, machine password, or provider response body is
sent to the control-plane issuer or written to a grant relation.

## Security invariants

1. A customer object is never visible solely because a caller is a mapped
   machine principal.
2. Customer authority is the intersection of the exact protected Auth user,
   exact signed Auth `session_id`, exact purpose, exact object or deletion
   scope, allowed command, unexpired grant, and still-live durable work.
3. Tenant, connection, object, operation, worker, attempt, and fencing values
   come from or are checked against control-plane state; JWT claims and runtime
   strings cannot self-select another tenant.
4. Sync and webhook grants are object-exact. Deletion grants are no broader
   than the request's tenant or connection and distinguish destructive purge
   from read-only verification.
5. Ending the durable lease or moving the workflow state denies the next S3
   statement without waiting for token expiry or cleanup.
6. The three runtime database logins, Auth machine users, adapters, environment
   secrets, and compiled AWS command surfaces remain mutually isolated.
7. The only grant-independent objects are immutable all-zero readiness
   sentinels containing no customer data.
8. No Albert runtime or browser receives `service_role`, a generated S3 key,
   migration credentials, or another purpose's machine identity; the explicit
   policies grant no customer raw-object path to other Albert runtimes.

## Failure modes and recovery

- **Issuer or control plane unavailable:** customer S3 work does not start.
  Readiness fails closed; retry follows the owning durable job's policy.
- **Missing, malformed, stale, or mismatched JWT identity:** no grant is issued
  and Storage RLS denies customer objects.
- **Lease, permit, verifier, connection, or tenant state changes after issue:**
  the next Storage statement is denied by the live policy join. The worker
  abandons the scoped client and lets the durable workflow retry or reconcile.
- **Auth token refresh during an operation:** the refreshed Auth session can
  receive its own exact grant. All grant IDs acquired by the operation are
  independently revoked during cleanup.
- **Explicit revocation fails or a process crashes:** client destruction removes
  the local credential path. The grant remains usable only by the same Auth
  session, for the same scope, and only until the earliest grant or durable
  lease expiry. Bounded cleanup on later issuance removes expired rows.
- **An S3 delete reports success for an RLS-hidden object:** deletion continues
  to re-list and verify through its separately issued `verify` grant; absence
  is not inferred from a purge response alone.
- **Administrator upgrade is present but migration 0057 is absent:** dynamic
  policy helpers detect the missing grant relations and deny all customer
  objects. Readiness sentinels remain available. This is a safe, temporarily
  unavailable intermediate state, not a compatibility mode.
- **Structural policy verification fails:** migration 0057 aborts and release
  is blocked. The verifier is sealed after the cross-schema graph passes.

Recovery never restores the former ambient customer policies. Operators repair
the durable lease, machine mapping, migration, or runtime configuration and
replay the owning idempotent job.

## Operational rollout

This is a coordinated, forward-only security migration:

1. Build and test the lease-aware runtimes and purpose-specific scoped
   adapters.
2. Apply administrator upgrade
   `control-plane/0008_lease_bound_raw_storage_deletion.sql` with the protected
   `postgres` login. It replaces the six Storage policies and installs
   fail-closed cross-schema helpers.
3. Apply control-plane migration
   `0057_m2_m7_m8_lease_bound_raw_storage_sessions.sql` through the migration
   owner. It creates the FORCE-RLS grant relations and exact-login
   issuer/revoker functions, verifies the final policy graph, and seals the
   verifier.
4. Provision and verify the three fixed runtime logins and ADR 0031 machine
   users, then deploy the lease-aware sync, webhook, and deletion services.
5. Run exact-runtime SQL proofs and the real Auth-plus-S3 protocol proof before
   promotion.

The interval between steps 2 and 3 deliberately denies customer operations.
The release must therefore keep the interval short and observable, but must
not reorder the two ownership streams or reintroduce an ambient fallback.
Older service builds are incompatible after step 2 and must not be rolled back
without a new reviewed forward migration.

Rotation of the three machine users remains generation-fenced as described in
ADR 0031. Existing grants for the prior user stop authorizing because policy
evaluation requires the active protected mapping; new work uses the rotated
identity and a newly issued grant.

## Testing and verification

- `tests/sql/control-plane-raw-storage-authority.sql` exercises the policy
  matrix, exact session and object/scope matching, concurrent grants,
  independent revocation, expired grants, stale durable work, and purge versus
  verify behavior.
- Runtime-login SQL proofs call each issuer and revoker through its real LOGIN
  plus `SET ROLE` against actual queue, permit, receipt, verifier, and deletion
  fixtures. Direct grant seeding is not a substitute for this proof.
- `tests/contracts/s3-raw-storage.contract.test.ts` verifies JWT `session_id`
  validation, shared Auth-session reuse, scoped adapter denial, command
  boundaries, and exact key or prefix enforcement.
- The sync, webhook, and deletion raw-storage service tests verify
  issue-before-I/O, success and failure cleanup, scope and expiry validation,
  parallel grants, refreshed-grant cleanup, and revocation failure handling.
- `npm run test:raw-storage-s3-session` uses real Supabase Auth and the real S3
  endpoint to prove sentinel-only ambient access and exact lease-bound customer
  operations.
- Administrator-upgrade, migration-history, configuration, source-boundary,
  runtime-secret, and compiled-bundle contracts prevent a purpose, credential,
  or AWS command surface from crossing service boundaries.

## Consequences

- Compromise of one purpose-specific service no longer grants ambient customer
  raw-object authority. The maximum live scope is the work that the control
  plane has already authorized for that service.
- One Auth login can support concurrent work without a password grant per
  object. The narrower database grants, not additional Auth users or sessions,
  provide concurrency-safe isolation.
- Every customer S3 operation now depends on the control plane and one extra
  issuance/revocation lifecycle. This latency and availability dependency is
  accepted for a materially smaller blast radius.
- Short TTLs and live policy joins bound crash residue, while bounded reap and
  expiry indexes keep the transient relations operationally finite.
- Administrator upgrade 0008 and migration 0057 form one release unit across
  different ownership streams. Partial application is safe but unavailable.

## Supersession

This ADR supersedes only the portions of ADR 0031 that gave a mapped purpose
principal ambient access to every customer key in its path family. ADR 0031
remains authoritative for:

- the three protected Supabase Auth users and their generation-fenced mapping;
- the Supabase S3 session-credential protocol and secret ownership;
- purpose-specific command modules and compiled-service boundary checks;
- immutable conditional writes and deletion re-listing;
- the fixed non-customer readiness sentinels; and
- machine-user provisioning, rotation, endpoint, project-reference, and region
  validation.

If Supabase changes the S3 session protocol or Storage policy evaluation model,
a new ADR and a real protocol proof are required.

## Rejected alternatives

- **Purpose-only RLS:** still grants ambient access to every tenant and
  connection in that purpose's path family.
- **Tenant claims supplied by the runtime:** a compromised process could
  self-select another tenant and no durable work would justify the claim.
- **One Auth login per object:** adds authentication load and password exposure
  without proving a live queue lease or workflow stage.
- **Grant expiry without live joins:** leaves useful authority after a job is
  completed, fenced, superseded, disconnected, or moved to verification.
- **Application-only scoping:** does not constrain a compromised process using
  the same S3 credential outside the intended adapter.
- **Immediate hard deletion without verification:** S3 delete responses cannot
  prove that RLS did not hide residual objects.
- **Restoring broad policies during an outage:** turns a control-plane failure
  into cross-tenant customer-data authority and defeats the security boundary.
