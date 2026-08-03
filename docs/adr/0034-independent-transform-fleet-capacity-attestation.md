# ADR 0034: Independent transform fleet-capacity attestation

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert platform and release security
- Supersedes: ADR 0032 production blocker (not its diagnostic contract)
- Relates to: ADR 0006, ADR 0022, ADR 0030, ADR 0053
- Amended: 2026-08-04 to separate immutable release authority from the measured
  candidate identity

## Context

The schema-v2 transform diagnostic in ADR 0032 deliberately cannot unlock a
release. A distributed test also fails as evidence if candidate-controlled code
receives the signing key or trusted observer credentials: a compromised
candidate could sign invented measurements or exfiltrate the key. Ed25519 alone
does not make a producer independent.

The 20,000-tenant objective must exercise the candidate snapshot path at the
proposed Machine floor, on shared control and analytical databases, with
observable queue, pool, connection, lock, and autoscaler pressure. The result
must bind to one candidate and protected workflow attempt, and production must
apply the measured floor.

## Decision

Albert uses a dedicated Sydney `staging-capacity` cell and an independently
deployed capacity attestor. Its executable is built from a separately reviewed
release-security repository and pinned by an immutable
`owner/repository@40-character-commit` reference plus an OCI `sha256` build
digest. Fly, Prometheus, global database-observer, GitHub API, and Ed25519
private-key credentials exist only in that service. They are never exposed to
the candidate checkout, candidate image, or production promotion job.

The reference implementation lives under `services/capacity-attestor/` and is
mirrored into that trust repository; `docs/independent-capacity-attestor.md`
defines its bootstrap, deployment, credential, rotation, and incident runbook.

Under ADR 0053, the release-authority job receives a GitHub OIDC token for the
audience `albert-transform-capacity-attestor` and sends only public run
coordinates. Authority and candidate are separate identities: the attestor
validates the token signature, audience, exact repository, protected authority
tag/ref and SHA, `.github/workflows/release-authority.yml` path and SHA, run id,
attempt, protected environment, and hosted runner. It uses the Actions jobs API
check-run identity and parses that workflow at the authority SHA to prove this
is the only job admitted to `staging-capacity`. It separately binds the full
candidate SHA, the exact transform OCI image digest, and the content-addressed
release-plan digest supplied by the immutable authority. Request fields cannot
override trusted policy or OIDC claims. The attestor independently reads
GitHub, Fly Machines, Fly Prometheus, and both database observation endpoints
before signing.

Observation uses a durable asynchronous POST/poll protocol. The first short
request reserves the exact run in the trust database and returns 202; subsequent
short requests present refreshed GitHub OIDC and return 202 until the stored
envelope is complete. No release depends on an idle connection surviving the
47-minute observation window.

### Corpus and run isolation

The capacity cell contains exactly 20,000 active tenants and no customer or
non-`capacity-*` tenant. An independently approved SHA-256 fingerprint covers
each sorted tenant id and its latest source and canonical row counts. The fixed
corpus contract digest is
`82895eb48467068eabdb9b4c511e85242cedbc2584d0127ee700e791e4bdcf4a` and
requires at least 2,000 micro tenants (1–999 rows), 10,000 small tenants
(1,000–9,999), and 4,000 medium tenants (10,000 or more).

The protected job first stops the capacity autoscaler and all candidate
Machines. A deployer-bound preparation command rejects a non-capacity tenant,
active lease, empty source/canonical profile, count/stratum mismatch, or
fingerprint mismatch before clearing only prior capacity-run attribution.
Customer workers are never stopped because the cell and apps are capacity-only.
An `always()` cleanup stops both capacity apps after success, failure, or
cancellation; the next run verifies quiescence again.

Every candidate Machine must run the request's exact immutable transform image
digest and derives its participant id from Fly's immutable
`FLY_MACHINE_ID`, waits behind a common future barrier, executes the real
least-privilege `CanonicalTransformPipeline`, records its pool-acquire p95 and
outcome through a security-definer runtime function, and remains alive long
enough to observe a continuous five-minute autoscaler floor. Only run-prefixed
leases and post-start pipeline snapshots are included.

### Signed pass contract

The exact-shape Ed25519 payload passes only when:

- producer ref/build digest and signing key are pinned;
- authority repository, protected tag/ref, tooling SHA, workflow ref, and run
  id/attempt match the executing immutable workflow;
- candidate SHA, transform image digest, release-plan digest, staging cell,
  nonce, issue time, and at-most-two-hour expiry match;
- exactly 20,000 distinct tenants complete and the approved corpus fingerprint
  and fixed strata match actual post-run snapshots;
- the requested 2–40 Machine floor equals candidate participants, remains
  present through the sweep, and is the recommended production floor;
- p95/p99 are positive, participant errors are zero, and the sweep finishes in
  at most 2,520 seconds, preserving the one-hour objective at 70% utilisation;
- maintenance due work drains from 20,000 to zero, the normal transform queue
  is zero at both boundaries, leases remain within eight per Machine, and at
  least 20 queue samples exist;
- both databases remain at or below 70% connection use, pool-acquire p95 stays
  at or below 250 ms, lock waiters never exceed one, deadlock deltas are zero,
  and at least 20 samples exist; and
- the autoscaler reaches the floor, remains there at least 300 seconds without
  a failed operation, and every running Machine has the exact candidate SHA and
  one immutable image digest.

Production preflight verifies and consumes the schema-v2 envelope once, before
any production secret staging, migration, publication, or deployment. It
checks the public key, producer ref, producer OCI build digest, corpus
fingerprint, complete authority identity, complete candidate identity, cell,
and expiry and exposes only the attested floor downstream. The durable store
binds every retry to the authority SHA/ref and candidate SHA/image/plan plus the
canonical request digest; legacy protocol-v1 rows cannot be reused as v2
evidence. Workflow concurrency and run/attempt binding prevent cross-promotion
replay. Transform deployment raises capacity to that floor without scaling
down a larger fleet, and deploys the autoscaler with the same floor.

The single-process diagnostic remains available and always reports
`releaseEligible: false`; it is not input to this attestation.

## Consequences

- Candidate code is measured but cannot mint evidence, select its verifier, or
  read signing/observer credentials. OIDC proves immutable authority code is
  requesting the measurement; Fly and database observations prove which
  candidate actually ran.
- An unavailable attestor, stale envelope, corpus drift, insufficient
  throughput, saturation, queue contamination, or cleanup failure blocks
  production rather than degrading to an estimate.
- The independently deployed attestor, approved corpus fingerprint, public key,
  immutable tool ref, and protected staging credentials are operational
  prerequisites. Repository code cannot fabricate the live pass; the first
  protected run supplies deployment evidence.
- The full gate is intentionally expensive and runs only for an explicit
  production promotion against a dedicated non-customer cell.

## Alternatives considered

- **Give the candidate an Ed25519 private key:** rejected because it could forge
  or exfiltrate it.
- **Sign operator-authored JSON with KMS:** rejected because signing provenance
  is not measurement provenance.
- **Trust a mutable pass variable:** rejected because it proves no workload or
  saturation observation.
- **Load-test production:** rejected because customer data and availability are
  outside the experiment boundary.
- **Reuse an un-fingerprinted corpus:** rejected because fixture shrinkage would
  make successive passes incomparable.

## Verification

- `scripts/request-independent-capacity-attestation.mjs`
- `scripts/transform-fleet-capacity-attestation.mjs`
- `scripts/prepare-transform-capacity-cell.mjs`
- `scripts/release-preflight.mjs`
- `services/capacity-attestor/src/`
- `deploy/capacity/attestor-*.sql`
- `deploy/capacity/capacity-attestor.reference.toml`
- `docs/independent-capacity-attestor.md`
- `.github/workflows/release-authority.yml`
- `services/capacity-attestor/capacity-attestor.test.ts`
- `tests/contracts/transform-fleet-capacity-attestation.contract.test.ts`
- `tests/release-preflight.test.mjs`
- control-plane migration `0051`
