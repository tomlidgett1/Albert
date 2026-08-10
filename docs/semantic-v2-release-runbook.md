# Semantic V2 qualification and cutover runbook

This runbook operationalises ADR 0077. It does not relax any release gate and
must be executed from a clean, reviewed release commit. Never use it from a
dirty development worktree, never place secrets or the hidden holdout in the
repository, and never run the Luna evaluation until every deterministic gate
has passed for the exact commit and publication.

ADR 0078 is also authoritative: V2 deploys the web application on Vercel and
uses only Lightspeed/Xero qualification. The legacy V1 protected-dogfood Sites
envelope and Deputy onboarding journey are not V2 launch evidence.

## 1. Freeze the release identity

1. Review and commit the intended V2 change set on a release branch.
2. Record the 40-character commit SHA.
3. Run `npm run registry:v2:check` and record the 64-character publication hash
   from `packages/semantic-registry/registry/publication.v2.json`.
4. Confirm `git status --porcelain` is empty. The deterministic qualification
   runner refuses to create a receipt from a dirty worktree.

The publication, commit, dataset watermark, deterministic receipt, evaluation
launch, grade, and activation qualification must all bind to these same exact
identities.

Confirm that every source object and source-backed view in the publication pins
the connector pack's exact semantic mapping version. The generated compiler
plan and SQL must apply that mapping version to every root, snapshot and joined
source. Staging may retain rows from older mappings for auditability; a V2
result must not combine them.

## 2. Apply the control-plane migrations

Use the dedicated deployer credentials and the normal checksummed migration
runner:

```sh
npm run migrate -- --target=control-plane
```

Do not run SQL manually. Confirm the migration ledger includes
`0101_semantic_execution_v2.sql`,
`0102_m2_database_lock_timeout_failure_code.sql`, and
`0103_semantic_v2_admin_health.sql`, and confirm these relations and functions
exist:

- `control_plane.semantic_v2_publications`
- `control_plane.semantic_v2_profile_receipts`
- `control_plane.query_workspaces_v2`
- `control_plane.query_execution_snapshots_v2`
- `control_plane.semantic_v2_activation_qualifications`
- `public.albert_semantic_v2_admin_health(timestamptz)`

The health function is internal-operator-only and returns aggregate counts,
rates, usage and latency. It must never expose tenant identifiers, question
text, claims, result rows or evidence payloads.

Import and publish the canonical repository artifact through the governed
internal-admin workflow. Reload it by content hash before proceeding.

## 3. Produce durable live-profile evidence

Provision `ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET` through the deployment secret
manager. It must be stable, at least 32 characters, unavailable to browsers,
and shared only by the profiler and receipt verifier. An ephemeral key makes a
receipt non-reproducible and is not release evidence.

Run the read-only profiler against the qualification tenant and exact
publication:

```sh
npm run registry:v2:profile -- --execute --tenant=<tenant-id> --sample-size=10000
```

Register the signed receipt through the semantic admin. Generate the resolution
plan with `npm run registry:v2:relationship-plan -- --receipt=<receipt-path>`.
The plan is advisory only.

Review all relationship candidates in the admin dashboard:

- Promote only a unique, domain-correct path with live multiplicity evidence,
  the correct temporal behaviour, allowed direction, and explicit Topic scope.
- Reject unsafe or semantically incorrect candidates with a durable reason.
- Do not reject sparse candidates merely because the qualification tenant has
  no rows.
- Do not infer a target for candidates that have no declared target.
- Resolve multiple structurally safe targets through domain review, never by
  row counts alone.

The profiler constrains both sides of every candidate relationship to their
publication-pinned mapping versions. Any change to either mapping version makes
the receipt stale even when table and field names are unchanged.

For reviewed sets, use **Apply reviewed decisions** to submit at most 100
explicit decisions per draft revision. The operation is all-or-nothing:
duplicate candidate IDs are rejected, every promotion is rechecked against its
registered profile receipt, and the final manifest is written with one
optimistic-concurrency mutation. A promotion decision uses
`disposition: "promote"` plus the same target, cardinality, optionality,
temporal, Topic, notes, and profile-receipt fields as the individual workflow.
A rejection uses `disposition: "reject"`, a specific reason, and reviewed
evidence. Never turn advisory profiler output into an unreviewed automatic
decision.

Complete Tier 1 and Tier 2 reviews, validate the exact draft revision, publish
an immutable artifact, and rerun profiling if any profiled source, candidate,
target, key, or physical mapping changes after the receipt was produced. The
receipt is deliberately bound to the draft's immutable base publication; adding
the receipt reference changes the candidate publication hash, so requiring the
receipt to name that resulting hash would create an impossible content-hash
cycle. Deterministic qualification instead verifies the final publication's
source-draft lineage, the registered receipt hash and HMAC, and the exact
candidate/target and mapping-version proof. Release qualification requires zero unresolved
relationship candidates and one valid `profile_receipt:` reference on every
supported relationship.

## 4. Prepare evaluation assets outside the repository

Prepare two access-controlled files outside the repository:

- `ALBERT_V2_EVALUATION_HOLDOUT_PATH`: exactly 40 cases with
  `visibility: "hidden"`; no Deputy questions.
- `ALBERT_V2_EVALUATION_GOLD_PATH`: deterministic gold values bound to the exact
  publication and qualification dataset watermark.

The committed corpus contributes exactly 160 visible cases. The runner ignores
its 40 placeholder holdout cases and replaces them with the sealed external
holdout. The resulting execution set is exactly 200 cases: 80 Lightspeed, 80
Xero, and 40 composite, with the locked difficulty, question-class, and
terminal-state allocations.

Have a reviewer who did not author the model answers own the human grading
manifest for causal, diagnostic, recommendation, usefulness, and
controllability judgements.

## 5. Run deterministic qualification

When an existing production analytical snapshot must move to the designated V2
cell, use `npm run migrate:v2:snapshot` before qualification. The migration is
explicitly execution-gated, accepts only the Lightspeed/Xero source, canonical,
and mart schemas plus `ingestion.batch_manifests`, requires an empty target,
proves identical physical column, foreign-key, trigger, and referenced lookup
contracts, streams directly between TLS PostgreSQL sessions, remaps only the
declared tenant, and verifies exact row counts. It never writes customer rows
to a local dump file. Preserve its content-addressed receipt with the release
evidence. Ongoing ingestion still requires a fresh or safely migrated vendor
connection; a snapshot receipt is not OAuth evidence.

Point the release environment at the exact publication and migrated control
plane. Set `ALBERT_ANALYTICAL_PROJECT_REF` to the exact production analytical
Supabase project ref; the live audit rejects a direct endpoint or pooler login
owned by any other project. From the clean release commit run:

```sh
npm run qualify:v2:deterministic -- --execute --publication=<publication-hash>
```

This reruns the live physical-schema audit, generated-artifact checks, contract
and evaluation-unit suites, V2-scoped lint, typecheck, service/application
builds, rendered HTML, and browser accessibility. It writes a content-addressed
receipt under `.albert-agent-qa-out/qualification/` only when every suite
passes. The receipt records the analytical project ref, and the model-backed
runner rejects a receipt from another cell. Set
`ALBERT_V2_DETERMINISTIC_RECEIPT_PATH` to that receipt.

Repository-wide `npm run lint` remains a separate health signal. The V2 release
receipt uses `npm run lint:v2`, whose explicit surface includes every V2
contract, compiler, runtime, admin, evaluation, and release-control file; it
does not hide unrelated legacy failures by globally disabling lint rules.

## 6. Preflight the exact V2 runtime

Deploy the candidate services without changing customer routing. Set the
server-owned candidate runtime to V2 and pin the exact publication. `/readyz`
must report:

- `status: "ready"`
- `analyticalRuntime: "v2"`
- the expected `v2PublicationHash`

Keep customer turns on V1. There is no within-answer fallback from V2 to V1.

Deploy the web candidate through the Git-connected Vercel project. Confirm
system environment variables are exposed and collect candidate-bound metadata:

```sh
npm run provenance:vercel > "$VERCEL_PROVENANCE_RECEIPT"
```

The collector must prove one ready production deployment for the exact commit,
from protected `main`, in the project/team recorded by
`deploy/vercel-project.json`, owning `ALBERT_PUBLIC_ORIGIN`. Never use a mutable
`ALBERT_SERVICE_VERSION` value as Vercel deployment proof.

## 7. Spend the one-time Luna budget

The runner fails closed unless the processing contract is exactly:

- model `gpt-5.6-luna`
- reasoning effort `max`
- standard processing
- Fast disabled
- Pro disabled
- Sol and Terra absent
- exactly 200 cases

Run once:

```sh
npm run eval:v2:model -- --execute --confirm-budget=200
```

The runner creates an exclusive budget lock keyed by commit and publication
before the first request. A failed or interrupted run consumes that reservation;
automatic reruns are prohibited. Preserve the launch, result, usage, latency,
cost, grade, corpus, holdout, gold, watermark, and deterministic-receipt hashes.

Do not qualify a release unless independent review is complete and every gate
in `grade.json` is `true`.

## 8. Record activation qualification

With an enabled internal-operator identity, bind the passed deterministic and
model receipts to the exact publication and commit:

```sh
npm run qualify:v2:release -- \
  --execute \
  --publication=<publication-hash> \
  --commit=<commit-sha> \
  --actor-user-id=<internal-operator-uuid> \
  --deterministic-receipt=<path> \
  --evaluation-launch-receipt=<path> \
  --evaluation-grade-receipt=<path>
```

The activation RPC independently rejects any publication and commit without a
passing immutable qualification record.

## 9. Single controlled cutover

1. Freeze semantic edits.
2. Recheck the active publication, release commit, V2 readiness, data
   watermarks, and global V1 rollback switch.
3. Activate the qualified publication.
4. Change the server-owned turn route from V1 to V2 once.
5. Monitor terminal-state distribution, incorrect Unavailable outcomes,
   interpretation, compiler and evidence failures, latency, cost, cache
   isolation, and tenant isolation.
6. Roll back globally on any critical correctness, isolation, fan-out, or
   evidence failure. Never silently continue an in-flight V2 answer on V1.

Keep V1 runnable for 30 stable days. Remove model-authored SQL and compatibility
paths only in a separate reviewed change after that period.
