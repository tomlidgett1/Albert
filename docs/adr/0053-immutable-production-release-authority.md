# ADR 0053: Immutable production release authority

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert engineering
- Supersedes: the release entry point, release ordering, fixed two-Machine
  baseline, and prior-image rollback clauses in ADR 0006

## Context

The original `.github/workflows/release.yml` checked out a caller-selected
candidate and ran candidate-owned preflight and evidence-consumption code while
protected environment credentials were available. A malicious or merely broken
candidate could therefore alter the verifier that decided whether that same
candidate was safe to promote. Branch review did not make the executing verifier
independent of the artifact it was authorising, workflow reruns could mint fresh
one-use evidence, and name-based artifact lookup did not bind consumption to one
exact producer output.

Production also depends on independently collected capacity, live-vendor,
browser, human-onboarding, and semantic dogfood evidence. Each producer and
consumer needs an immutable tooling identity distinct from the release candidate,
and the final authorisation must remain independently verifiable after the
workflow has finished.

## Decision

### One immutable production entry point

`.github/workflows/release-authority.yml` is the only production release entry
point. The old `.github/workflows/release.yml` is a credential-free, checkout-free
dispatcher that always fails and points operators to the authority workflow. It
cannot select an environment or a candidate.

An authority run must be an original `workflow_dispatch` run in
`tomlidgett1/Albert` with `github.run_attempt == 1`, dispatched from an annotated
tag matching `albert-release-authority-v*`. The tag, workflow ref, event SHA,
configured tooling SHA, and trusted checkout SHA must all identify the same
commit. GitHub's REST tag-object response must prove the exact annotated tag name,
exact commit target, `verification.verified == true`, a `verification.reason` of
`valid`, and the pinned tagger email.

The tag namespace has two independent active rulesets:

- creation is allowed only to the configured release-authority GitHub App; and
- update and deletion are denied with no bypass actors.

The creator App ID, environment deployment policies, reviewer configuration,
self-review prevention, administrator-bypass prohibition, required main-branch
checks, and tag rulesets are read from GitHub again inside the protected
authorisation job. Configuration asserted only by repository files is not
sufficient.

The production and vendor-attestor trust environments each store the
configuration-audit credential independently. It belongs to a non-dispatcher,
non-issuer audit principal and is used only for metadata reads. Because GitHub
can omit `bypass_actors` when the caller lacks sufficient visibility, both
audits require that property to be present before accepting either an exact
issuer bypass or an exact empty immutability bypass list.

### Authority and candidate isolation

The candidate is a separate full commit SHA and is never used as the workflow
identity. Before candidate code executes, authority-owned code proves all of the
following:

1. `main` points at the candidate and exactly one successful push run of the
   pinned CI workflow exists for that SHA.
2. The CI workflow ID, run ID, run attempt, check-suite ID, required check names,
   GitHub Actions App identity, repository, event, workflow path, and original
   run attempt are exact; CI reruns are not release evidence.
3. A credential-free authority checkout and a separate candidate checkout have
   byte-identical privileged release, deployment, migration, and build surfaces.
4. Candidate dependencies and the complete candidate check suite run without a
   protected environment, package-write permission, production credentials, or
   persisted Git credentials.
5. Image construction occurs on a fresh runner that does not execute candidate
   package scripts and publishes a content-addressed image digest.

Every job in the authority workflow rejects attempts other than attempt one.
Protected jobs check out only `github.sha`, the authority tooling commit. Candidate
deployment content is reached only after authorisation and only through the
already-proven immutable surface.

### Exact evidence and human authorisation

Capacity, dogfood, and release-plan evidence is downloaded by exact artifact ID,
not by mutable name or latest-run lookup. The workflow binds each producer's
repository, workflow path and ID, run ID, run attempt, tool SHA, candidate SHA,
artifact ID, GitHub API artifact digest, expected file set, and bounded file size.
The dogfood acceptance collector and human-onboarding journey issuer run from the
same `albert-release-authority-v*` root, use the same direct signed-tag proof, and
reject reruns.

The `production`, `staging-capacity`, and `dogfood-staging` environments accept
only the authority tag namespace, require a reviewer, prevent self-review, and
set `can_admins_bypass` to false.
The independent live-vendor attestor uses a separate signed and immutable
`vendor-attestor-v*` namespace, protected environment, creator App, and split
creation/immutability rulesets so the release authority cannot impersonate an
independent vendor observer. Its environment also disables administrator bypass.

The production approval history is fetched from GitHub. Exactly one approved
production deployment record is accepted, the reviewer must be a human GitHub
user distinct from the dispatcher, and a redacted canonical approval record is
hashed into the authorisation.

Authority-owned code atomically consumes the exact one-use evidence and emits a
short-lived signed authorisation receipt. The receipt binds the authority and
candidate identities, image digest, plan, capacity and dogfood digests, live
GitHub configuration-audit digest, approval digest and reviewer, actor, run ID,
run attempt, and expiry. The deployment schema job downloads that receipt by exact
artifact ID and verifies every binding before migrations or deployment can begin.
The vendor-attestation relay's complete private-origin, TLS, expected-tool, and
expected-build trust material is staged before the sync service is deployed.

### Release availability and recovery

Production promotion is enabled only through the immutable authority path.
Mutable staging release dispatch is disabled until it can provide an equivalent
authority and evidence boundary; staging dogfood and capacity collection remain
protected evidence producers, not alternate deployment entry points.

The operational floor is at least two healthy Machines per service, but fleet
size is not fixed at two. Candidate-bound independent capacity evidence, queue
pressure, and reviewed autoscaling bounds decide the release fleet size.

Database migrations remain forward-only. Recovery never relabels or directly
redeploys a prior image under an old authorisation. A rollback is a new forward
release decision, dispatched from immutable authority tooling, with a fresh
candidate SHA or repair commit, fresh compatibility proof, fresh evidence, a new
human approval, and a new signed receipt. Immutable semantic snapshots may be
selected again only through that new release.

These decisions supersede only ADR 0006's named release, fixed-capacity, and
rollback clauses. ADR 0006's Sydney cell, network, credential, migration, health,
and runtime-isolation decisions remain in force.

## Consequences

- A candidate cannot edit the workflow, CI provenance verifier, evidence
  consumer, or receipt verifier that authorises it.
- A workflow rerun cannot mint a second journey, acceptance envelope, or
  production authorisation for the same original run.
- Every production deployment records independent authority, candidate, CI,
  evidence, reviewer, configuration, image, and deployment identities.
- Updating release logic requires a reviewed new annotated authority tag and the
  corresponding protected-environment pin.
- Failed, expired, or consumed evidence is not reusable. A new run must collect
  candidate-bound evidence and obtain a new human approval.
- Recovery is slower than an unaudited image rollback because it deliberately
  preserves the same release proof and schema-compatibility boundary.

## Verification

- `tests/release-authority.test.mjs` rejects mutable refs, repository/event/run
  substitution, reruns, SHA drift, checkout substitution, workflow substitution,
  staging dispatch, and abbreviated candidates.
- `tests/release-plan.test.mjs` proves clean, disjoint authority/candidate
  checkouts and exact CI, artifact, actor, and workflow bindings.
- `tests/release-authorization-receipt.test.mjs` proves canonical signed receipt,
  approval, reviewer, capacity, dogfood, audit, expiry, and identity bindings.
- `tests/production-environment-audit.test.mjs` proves exact environment
  inventories, human-review controls, the disabled legacy workflow, single-run
  dogfood producers, and split no-bypass tag rulesets.
- `scripts/validate-deployment.mjs` proves the pinned deployment toolchain,
  protected job inventory and ordering, and vendor-relay staging boundary.
