# ADR 0035: Protected live dogfood acceptance attestations

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert product, data platform, and release engineering
- Relates to: ADR 0003, ADR 0004, ADR 0006, ADR 0012, ADR 0022, ADR 0034

## Context

Contract tests and fixture evaluations prove deterministic behavior but cannot
prove that a release candidate has completed real OAuth, ingestion, canonical
projection, governed analysis, onboarding, provider revocation, and erasure
against protected staging accounts. A human checklist or editable JSON file is
not release evidence. It can omit failures, drift from the candidate, be
replayed, or expose customer payloads.

The release candidate is also an untrusted signing subject. Giving a symmetric
signing secret or private key to candidate code would let the code under test
forge the observations that authorize it. Production must be able to verify an
attestation without possessing any signing capability.

Deletion adds another boundary. A reconnect creates a new authorization epoch,
so a provider revocation that is not bound to `connection_generation` can prove
the wrong credential. A single aggregate analytical row count also cannot show
that staging, canonical, bridges, identity links, embeddings, and caches are all
empty.

## Decision

Albert has a protected `dogfood-staging` workflow whose signing path proceeds
only from an immutable attestor tag. Environment-scoped configuration becomes
available only after the job enters the protected environment, so the first
post-approval shell step fails unless both `github.ref` and `github.sha` equal
the protected tag and independently reviewed tooling pin, before any secret-
bearing collection or signing step.
Checking out trusted code from a candidate-editable workflow is not a trust
boundary, so the secret-bearing workflow itself is pinned. The candidate SHA
is only a measurement target and is never checked out into the signer job.

The exact production runtime set -- web, sync worker, transform worker,
webhook gateway, semantic query, operator diagnostic, and deletion worker --
must return the candidate SHA and one unique staging deployment id. The five
public services self-identify at distinct HTTPS origins, and semantic cases
execute only against the origin that passed the semantic probe. Transform and
deletion remain private, without public IPs; the collector uses a short-lived,
read-only Fly organization token to verify their Sydney Machines, candidate
environment, deployment id, configured `/readyz` check, and current passing
platform check. The two Fly apps must be distinct and every Machine must carry
the runtime-specific transform or deletion worker identity. The control plane
independently derives a durable deployment
barrier from fresh, ready sync/transform/deletion heartbeats bearing that SHA
and deployment id. An append-only trigger records the first such observation
with the database clock and binds it to the exact service runtime login, so one
worker credential cannot impersonate the other two; worker-supplied start
times cannot backdate the barrier.
M3, M4, M6, M7, and M8 evidence transitions must occur after that barrier;
running a new collector cannot reuse a prior release's successful state.

The control-plane diagnostic runtime invokes one `SECURITY DEFINER` capture
function. Its inputs are only exact tenant, connection, artifact, and proof
selectors plus reviewed expectations. It does not accept milestone results.
The function derives M3, M4, M6, M7, and M8 from live immutable/control state,
stores an append-only privacy-safe snapshot, and returns counts, generations,
booleans, timestamps, and content digests only. The trusted collector derives
M5 by executing every protected golden/composite semantic case twice through
the signed production semantic endpoint. Before each call, the diagnostic
boundary issues a one-use, three-minute durable conversation-turn lease for
that exact workflow/case/pass. The semantic capability issuer therefore sees
the same real running-turn evidence required for user traffic; arbitrary ids
are not a bypass. Results and bundle digests must repeat and equal the protected
expected result digest.

Acceptance requires:

- M3: every current required stream has a post-barrier landed raw manifest,
  current-generation completed cursor/backfill, terminal phase plan, completed
  latest reconciliation sweep, and non-failing quality map;
- M4: populated canonical and mart projections, at least twelve current
  invariants, a Lightspeed-to-Deputy identity suggestion, and passed Xero
  posting-bridge coverage;
- M5: at least one numeric golden and one composite live query, repeatable on
  two executions, with governed lineage and provenance;
- M6: immutable finalized flagship and category answer artifacts with governed
  IR, provenance, sequential narrative/table events, and a table-backed chart
  for the category case;
- M7: a post-barrier tenant with exactly one healthy OAuth-backed
  Lightspeed R-Series, Xero, and Deputy connection, current partial readiness
  inside the target, four blocking answers, and a published overlay digest;
- M8: a real Lightspeed or Xero disconnect with successful provider revocation,
  plus a separate all-provider tenant deletion, both produced by the candidate
  and finalized with zero raw, staging, canonical, bridge, link, embedding,
  cache, other analytical, control, derived, queue, token-reference, credential-
  envelope, and OAuth-session-envelope residuals.

Revocation targets now carry their exact connection generation. The analytical
deletion verifier emits granular residual counts; the control-plane combines
them with raw storage, credential-vault, queue, and control-store counts in the
immutable deletion proof.

The trusted collector signs the strict envelope with Ed25519. Only the staging
environment receives the PKCS#8 private key and the independent HMAC key used
to pseudonymize subject identifiers. Production receives only the SPKI public
key. The envelope binds the exact candidate, repository, immutable workflow
tag/tooling SHA/run, staging deployment id and barrier, exact seven-runtime set,
staging-to-production direction, snapshot digest, connection generations,
random nonce digest, issued time, and a maximum two-hour expiry.

Expiry is not the replay control. Production verification must immediately and
atomically insert an append-only consumption row keyed by snapshot id through
the staging diagnostic login. The first exact release run succeeds; any later
or concurrent use fails. This verification-and-consumption step is a dependency
of every production mutation, including migrations, secret staging, scaling,
and deployment.

No attestation or durable snapshot contains OAuth material, provider response
bodies, row values, questions, answers, SQL, tenant ids, connection ids, or
user ids. Subject references are domain-separated keyed digests.

## Consequences

- Production fails closed until authentic live-account evidence for M3-M8
  exists for the exact candidate.
- Pre-deployment sync, pipeline, artifact, onboarding, and deletion evidence
  cannot authorize an unexercised candidate.
- A candidate cannot sign its own evidence, and production cannot forge a
  staging attestation with its public key.
- Short expiry limits stale evidence; the database consumption ledger prevents
  actual replay even within that window.
- A failed deployment consumes its evidence and requires a new protected
  dogfood run. This is intentional: release retries are new release decisions.
- Real-account setup and protected expected digests remain operational secrets,
  while the signed artifact is safe to retain briefly in GitHub Actions.
- Existing deletion proofs without connection generations or granular
  analytical residuals cannot satisfy this gate; no inference upgrades them.

## Alternatives considered

- **Symmetric HMAC release signatures:** rejected because production or
  candidate code holding the verifier secret could also forge evidence.
- **Run the collector from the candidate checkout:** rejected because the code
  under test could replace the collector before accessing the private key.
- **Check out trusted code from candidate-owned workflow YAML:** rejected
  because candidate YAML could change secret-bearing steps before checkout.
- **Use arbitrary semantic conversation ids:** rejected because analytical
  capability issuance intentionally requires a live durable turn lease.
- **Trust a nonce and TTL without state:** rejected because the same valid
  envelope could authorize multiple releases during its lifetime.
- **Accept operator-authored milestone JSON:** rejected because selectors and
  expectations are acceptable inputs, but observed outcomes must come from live
  databases, providers, runtimes, and the semantic service.
- **Retain sampled rows for audit:** rejected because immutable hashes and
  store-owned lineage prove the gate without creating another customer-data
  store.

## Verification

- `.github/workflows/dogfood-acceptance.yml`
- `scripts/collect-dogfood-acceptance.mjs`
- `scripts/dogfood-acceptance-attestation.mjs`
- `infra/migrations/control-plane/0054_m3_m8_protected_dogfood_acceptance.sql`
- `infra/migrations/analytical/0092_m8_granular_deletion_residual_attestation.sql`
- `tests/contracts/dogfood-acceptance-attestation.contract.test.ts`
- `tests/sql/control-plane-protected-dogfood-acceptance-seed.sql`
- `tests/sql/control-plane-protected-dogfood-acceptance-runtime.sql`
- `tests/sql/control-plane-protected-dogfood-acceptance-verify.sql`
- `services/deletion-worker/src/processor.test.ts`
