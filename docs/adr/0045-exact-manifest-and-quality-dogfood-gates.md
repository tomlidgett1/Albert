# ADR 0045: Exact connector-manifest and quality dogfood gates

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert connectors, data platform, and release engineering
- Relates to: ADR 0003, ADR 0011, ADR 0035, ADR 0042, ADR 0044

## Context

The original protected M3 collector derived its stream inventory from the
`sync_stream_phases` rows that happened to exist. A truncated plan could
therefore make its own denominator smaller: one successful stream could be
reported as every planned stream. It also treated optional availability as a
phase-state exception without proving that the selected plan contained every
required and optional stream in the reviewed connector release.

The original M4 quality gate accepted any map with at least twelve keys as long
as none was `failed` or `blocked`. Arbitrary keys, omitted mandatory checks, and
warnings in high-value reconciliation checks could therefore satisfy a release
gate that was intended to prove the governed V1 data model.

The gate runs with a narrow operator diagnostic credential. Preserving that
boundary matters: a hardened wrapper is ineffective if the credential can
still execute the older collector directly.

## Decision

The protected dogfood gate owns a reviewed expectation catalogue for the exact
released connector packs:

- Lightspeed Retail POS R-Series `1.1.0`: thirteen streams;
- Xero `1.0.0`: eleven streams; and
- Deputy `1.0.0`: seven streams.

The catalogue records all 31 stream identifiers and every connector-manifest
field that is persisted as release execution evidence: pack and API version,
required/optional policy, backfill strategy, canonical sorted product domains,
canonical sorted cross-stream dependencies, and reconciliation late-edit,
deletion, and source-total strategies. A repository contract compares those
values directly with the three TypeScript connector manifests. Adding,
removing, renaming, or reclassifying a stream—or changing one of those execution
semantics—therefore requires an explicit gate migration in the same reviewed
release.

Endpoint paths, record-id and pagination mechanics, canonical targets, and
source-authority policy are not duplicated into this control-plane catalogue.
They are code/analytical pack contracts rather than persisted M3 plan evidence
and remain covered by connector-pack activation, canonical mapping contracts,
and field/schema quality checks. Calling this gate “exact” refers to the full
durable release plan and raw/reconciliation evidence it can independently
verify, not to a second copy of every connector implementation constant.

Acceptance requires the selected current connection generation to have exactly
that stream set and the corresponding progressive or single-pass plan. Domain
and dependency arrays must equal the catalogue, the dependency plan must be
sealed, predecessor links must match the reviewed phase order, and dynamic
time-window ranges must be contiguous. Exact range timestamps are intentionally
not catalogue constants: the planner derives them from onboarding time and
verified inherited coverage. Connector `priority` is likewise not durable
plan state; it is a transient fan-out ordering hint, while the sealed dependency
DAG is the actual cross-stream execution fence. Every
required phase must have succeeded after the candidate deployment barrier. An
optional stream may stop only with durable `capability_unavailable` evidence;
failed or in-flight work cannot be relabelled optional. Every otherwise
available stream must have post-barrier raw landing evidence bearing the exact
pack and API versions, a complete current-generation cursor, and a completed
latest reconciliation sweep bearing the exact connector and reconciliation
strategies. The raw manifest's run is bound to the same selected
connection, stream, and generation; a tenant-scoped run foreign key is not
sufficient evidence.

M4 owns the exact set of all 28 final required, readiness-blocking analytical
quality expectations. Every row in the candidate's latest projected snapshot
must contain precisely those names with status `passed`. Missing checks,
unknown extra checks, warnings, and failures all fail closed. A contract test
derives the comparison set from the complete analytical migration history so a
new required check cannot silently escape dogfood.

The candidate transform uses a dedicated quality-attested pipeline snapshot
overload. It accepts the immutable sync run id, requires that exact run to have
one result for every required readiness-blocking check and no unreviewed extra,
and stamps every table-stat projection with that run id and the oldest check
time. The transform captures `snapshot_at` only after its final check and the
analytical overload rejects a timestamp earlier than the newest result. The
control-plane gate requires one consistent non-null attestation on
the entire latest snapshot, a check time after the deployment barrier, and a
succeeded sync run with a matching candidate raw landing on one of the selected
current connector generations. The analytical snapshot also stamps every row
with the total table-inventory cardinality and a SHA-256 digest of the
lexicographically sorted `(schema_name, table_name)` pairs. The worker carries
both values without deriving them. Before evaluating quality, the control-plane
gate recomputes the count and digest over the rows it actually received and
requires every row to carry the same analytical declaration. Omitted, extra,
or substituted projection rows therefore cannot turn a partially delivered
snapshot into release evidence; the existing snapshot/table primary key rejects
duplicate inventory identities before the gate. The analytical runtime retains
no access to the broad `extensions` schema: a migration-owned, data-free
security-definer helper exposes only the inventory SHA-256 operation to the
transform role. Connector rollups are refreshed again inside
the canonical transaction, after the control-plane run commit. Promotion then
requires the snapshot, its control-plane projection, and the oldest result in
its exact quality run to be no earlier than the latest terminal phase, raw
landing, cursor, or latest reconciliation evidence across the complete
reviewed inventory. An explicitly unavailable optional stream contributes its
durable terminal timestamp but does not require fabricated raw evidence.
Future-dated quality or candidate evidence fails closed. The four-argument
snapshot path remains available for hourly maintenance, but its attestation
fields are null and it deliberately cannot satisfy promotion.

The prior capture function is renamed to a private implementation function. A
new function with the original public signature calls it and then executes the
exact manifest/quality assertion in the same statement. Assertion failure
rolls back the append-only snapshot insert. Execute privilege on the prior
implementation is revoked from the diagnostic group and every application
role; only the hardened wrapper remains callable.

## Consequences

- A partial sync plan can no longer prove its own completeness.
- Connector pack drift and analytical quality-registry drift stop release until
  the protected expectation is reviewed.
- Optional vendor capability differences remain supportable, but only as
  explicit durable evidence rather than absence.
- A warning is useful operator evidence but is not a production acceptance
  pass.
- Republish-only maintenance cannot make pre-deployment quality results look
  candidate-era; promotion is bound to the exact run that executed the checks.
- A partial or substituted control-plane table-stat projection cannot satisfy
  M4 even when every row it did receive carries a passing quality map.
- An early stream's passing snapshot cannot attest later stream completion;
  promotion waits for a causally subsequent complete quality run.
- Connector and quality catalogue changes require a migration, test update,
  and review. This friction is intentional because both catalogues are release
  contracts.

## Alternatives considered

- **Continue counting whichever plan rows exist:** rejected because a missing
  stream reduces both numerator and denominator.
- **Require only required streams:** rejected because an omitted optional stream
  would be indistinguishable from an explicitly unavailable capability.
- **Accept any non-failing quality map above a minimum size:** rejected because
  names carry the quality semantics; cardinality does not.
- **Trust a projection snapshot timestamp without an inventory declaration:**
  rejected because transport can commit a strict subset under the same
  timestamp; a source-declared count plus deterministic content digest makes
  that loss or substitution observable at the promotion boundary.
- **Modify the historical migration in place:** rejected because applied
  migrations are immutable and production history must remain reproducible.
- **Leave the old collector executable for rollback:** rejected because it is a
  security-boundary bypass. Database rollback is a reviewed forward migration,
  not a second permissive entry point.

## Verification

- `infra/migrations/control-plane/0062_m3_m4_manifest_and_quality_dogfood_gate.sql`
- `infra/migrations/analytical/0102_m4_quality_run_bound_pipeline_snapshots.sql`
- `tests/contracts/protected-dogfood-manifest-quality.contract.test.ts`
- `tests/contracts/quality-run-bound-pipeline-stats.contract.test.ts`
- `tests/sql/control-plane-protected-dogfood-manifest-quality.sql`
- `tests/sql/analytical-quality-run-bound-pipeline-stats.sql`
- `.github/workflows/ci.yml`
