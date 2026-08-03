# Albert infrastructure

Production uses two Sydney PostgreSQL cells: Supabase for Auth, control, queues, semantic catalogue, and raw Storage; and a separate managed PostgreSQL 17 analytical host.

For a new environment, enable `pgmq`, `pg_cron`, and `vector` in Supabase, then run the one-time administrator bootstrap:

```bash
npm run migrate -- --target=control-plane --bootstrap
npm run migrate -- --target=analytical --bootstrap
npm run provision:runtime-logins
npm run provision:raw-storage-machine-users
npm run provision:analytical-capability-key
npm run provision:webhook-attestation-key
```

`--bootstrap` requires the exact `postgres` administrator login, creates NOLOGIN
migration/runtime groups, records the one-time base checksum, applies the
independently checksummed administrator-upgrade stream, and only then activates
the NOLOGIN migration owner. It is used only for a new database. Routine
releases never rerun or re-checksum the base bootstrap: first run
`CONTROL_PLANE_ADMIN_DATABASE_URL=... npm run bootstrap:upgrade:control-plane`,
then run ordinary migrations with the deployer URLs. Remote administrator URLs
must require TLS. The provisioner reconciles fixed NOINHERIT LOGIN identities,
removes unexpected memberships, and grants exactly one group per credential.
On managed Supabase it fails closed on any pre-existing privileged login and
uses only the ordinary role alterations permitted to protected `postgres`;
dangerous attributes are verified false after every reconciliation.
The administrator stream also owns Albert's fixed Supabase Auth compatibility
bridge. Managed `postgres` cannot delegate its non-grantable Auth privileges,
so immutable legacy migrations redirect only their exact checksum-reviewed Auth
dependencies through bounded claim/directory helpers; migration 0042 installs
the fixed foreign keys and removes direct Auth reads. The migration owner stays
NOINHERIT with no parent roles. The same administrator stream fixes pg_cron's
managed non-superuser identity semantics and installs the single private raw
payload bucket without opening Storage RLS. See ADR 0024.
CI grants the local `postgres` role five fixed, SET-only runtime-group
memberships so transaction-scoped SQL tests can exercise each runtime policy.
That grant is isolated in `tests/sql/control-plane-test-role-delegation.sql`,
requires the explicit `albert.test_role_delegation=on` session setting, and is
only for disposable test databases. Never run it in staging or production.
The capability provisioner installs one out-of-band HMAC key in both cells in
verifier-first order and verifies matching fingerprints. Runtime processes
never receive that key: they receive only signed, short-lived, audience-bound
capabilities for an exact live control-plane lease. Issuer and verifier
readiness remain closed while no shared active key exists.

Sync, webhook, transform, semantic, operator diagnostic, and deletion each receive distinct control-plane identities. Connector landing, canonical transform, semantic reads, semantic metadata, operator diagnostic reads, and deletion each receive distinct analytical identities. The final isolation migration revokes Albert private-schema access from Supabase's generic `service_role`; it is not an application deployment credential. The migration runner switches to a NOLOGIN migration owner, takes an advisory lock, verifies immutable SHA-256 checksums, and commits each migration with its ledger row atomically.

The Supabase Data API exposes `public` only. `control_plane`, `pgmq`, `cron`, Auth internals, and raw objects are service-only. Sync, webhook, and deletion use separate short-lived Auth-backed S3 sessions. A mapped user JWT grants ambient access only to fixed all-zero, non-customer readiness sentinels; every customer operation additionally requires an ephemeral exact-session grant joined by Storage RLS to the still-live sync permit, webhook receipt and verifier lease, or deletion request and queue attempt. One Auth session may be reused by concurrent operations, but each exact object or deletion scope has an independently revocable grant. Generated S3 keys are forbidden because they bypass RLS. The protected provisioner owns the three Auth users and generation-fenced mapping; no runtime receives an Auth Admin or database-administrator credential. See ADRs 0031 and 0040. Semantic publication runs `npm run registry:publish` with the control deployer and OpenAI credentials; every 1,536-dimension `text-embedding-3-large` document commits as one immutable snapshot.

Lease-bound raw Storage authority spans the two immutable ownership streams and
must be promoted as one forward-only release unit:

| Order | Stream | Ledger entry | Responsibility |
| --- | --- | --- | --- |
| 1 | Protected administrator upgrades | `control-plane/0008_lease_bound_raw_storage_deletion.sql` | Replaces the six customer-object policies with fail-closed, live-work authorization helpers; only readiness sentinels remain ambient |
| 2 | Ordinary control-plane migrations | `0057_m2_m7_m8_lease_bound_raw_storage_sessions.sql` | Creates the FORCE-RLS grant relations and exact-runtime issuer/revoker functions, verifies the cross-schema graph, and seals the verifier |

The intermediate state after 0008 intentionally denies customer raw-object
operations until 0057 commits. Keep that interval short, but never reverse the
order or restore the former purpose-wide customer policies as a fallback.

Build the always-on service image with:

```bash
docker build -f Dockerfile.services -t albert-services .
```

The image contains six separately deployed commands:

- `node --enable-source-maps services/semantic-query.js`
- `node --enable-source-maps services/sync-worker.js`
- `node --enable-source-maps services/transform-worker.js`
- `node --enable-source-maps services/webhook-gateway.js`
- `node --enable-source-maps services/deletion-worker.js`
- `node --enable-source-maps services/operator-diagnostic.js`

Transform and deletion have internal top-level health checks and no public Fly service. Sync exposes non-sensitive health plus HMAC-authenticated OAuth routes; semantic exposes non-sensitive health plus independently signed tool routes; operator diagnostic exposes non-sensitive health plus an independently signed, one-use row-sample route; webhook is the signature-verifying vendor edge. A browser must never call any service directly.

See [the production runbook](../deploy/README.md) for exact regions, identities, secret ownership, release gates, rotation, recovery, and human acceptance.
