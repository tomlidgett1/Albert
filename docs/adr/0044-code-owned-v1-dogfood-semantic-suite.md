# ADR 0044: Code-owned V1 dogfood semantic suite

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert semantic platform and release engineering
- Supersedes in part: ADR 0035's minimum M5 case policy
- Relates to: ADR 0003, ADR 0012, ADR 0034, ADR 0035, ADR 0046

## Context

ADR 0035 required the protected dogfood collector to execute every case in an
environment secret, but accepted any two to twenty unique cases as long as one
was labelled `golden` and one `composite`. The protected environment owned the
expected result digests, which is necessary because they describe live customer
data, but it also owned case ids, kinds, order, and semantic inputs. An operator
could therefore replace the reviewed M5 suite with two easier queries and still
produce a schema-valid production promotion attestation.

The V1 specification defines 25 seed questions. Twenty have executable governed
semantic IR today. Of those, sixteen are numeric golden cases and four are
aggregate-then-align composite cases. `sales-refund-rate` has both a primary IR
and an explicit prior-quarter like-for-like `comparisonIr`, so the 20 cases
contain 21 required query inputs. The remaining five are exactly two
Clarification cases, two Unavailable cases, and one governed source-exploration
case. They exercise real agent routes but are not M5 direct-IR acceptance cases.

The first registry implementation replaced every absolute range `from` and `to`
with the same marker before hashing. That retained the rest of the IR but erased
the question's period semantics: an environment editor could shorten a
month-to-date, six-month, 30-day, or 90-day question and update the protected
expected digest without a code review. It also executed only each question's
primary `ir`, omitted `sales-refund-rate.comparisonIr`, and imposed a global
positive-row requirement even when an empty set is a valid governed answer.

The second implementation added deterministic period shapes, comparison
execution, and per-query row contracts, but shape alone did not establish
freshness. A month-to-date range from August 1 to August 2 remained shape-valid
when collection occurred on August 4; quarter-to-date and year-to-date had the
same gap. Exact rolling, full-month, week, day, and minimum-history windows could
also be moved into the past without changing their shape.

## Decision

The protected M5 gate uses one code-owned, ordered registry in
`evals/golden/dogfood-semantic-suite.mjs`. Version
`albert-v1-m5-semantic-suite@3` contains exactly the 20 executable semantic seed
questions from `evals/golden/questions.ts`, in source order. Each case owns its
kind, expected governed answer state, ordered query contracts, cross-range
relations, and per-query row requirement. Each query contract owns its query id,
semantic-input digest, and every dynamic absolute-period path, shape, and
collection-anchor policy.

Dynamic instants are normalized only after deterministic validation against the
code-owned period shape. The reviewed shapes cover month-, quarter-, and year-
to-date calendar boundaries; a complete prior calendar month; an inclusive six-
calendar-month trend; exact 30-, 90-, seven-, and one-calendar-day windows; a
minimum 180-day customer-history window; UTC midnight alignment; and reviewed
weekday alignment where the question names a weekday or week. Composite
subquery periods must be identical. The refund comparison must be the primary
period shifted back exactly three calendar months, including end-of-month
clamping.

Before any semantic query executes, the trusted collector derives one UTC
midnight exclusive collection anchor from its process clock and retains it for
the entire run. The registry relates every period to that anchor:

- month-, quarter-, and year-to-date ranges end at the anchor and begin at the
  applicable current calendar boundary;
- rolling-day and rolling-calendar-month ranges end at the anchor with their
  exact governed duration;
- minimum-history ranges end at the anchor and retain at least their governed
  lookback;
- last-month, last-week, yesterday, and named-Tuesday questions resolve to the
  immediately applicable prior calendar unit or weekday; and
- the refund comparison remains the exact calendar shift of its anchored
  primary range.

The collector rejects the whole protected plan before issuing a turn lease if
any period is shortened or stale. It signs the collection anchor into M5
evidence, and the attestation schema requires that UTC day boundary to be
contemporaneous with evidence issuance. The anchor is only a calendar boundary,
not customer data. Consequently live dates can advance, but an environment
editor cannot redefine freshness, duration, boundary, or calendar alignment.
The semantic compiler and deterministic fixture evaluator both treat the
anchor as an exclusive upper bound (`value < to`). A next-midnight anchor
therefore includes every available row from the collection day without
requiring a row at that future boundary.

The input digest includes the complete normalized IR and the code-owned period
contracts. It therefore continues to bind topics, metrics, dimensions,
composite subqueries and alignment, filters, sort, limits, parameters, and
comparison behavior. The registry's reviewed, pinned SHA-256 covers its version
and ordered cases, including every period, anchor, relation, row, and input-digest
contract. A module-load assertion fails if any contract changes without a
corresponding reviewed version/digest update.

The complete seed-surface contract is a second code-owned, ordered registry in
`evals/golden/seed-outcome-suite.mjs`. Version
`albert-v1-seed-outcome-suite@1`, digest
`sha256:e067582fc9a2ecb7660400a7dad9a9ed04a9e80b93db127d857be8671ffebf3f`,
binds all 25 case ids in source order, each exact user prompt and prompt digest,
the required route and answer state, and a route-specific required-outcome
digest. The semantic and source-exploration requirements explicitly require a
live candidate-tenant evidence source and forbid fixture values. This manifest
therefore binds acceptance policy; it neither embeds fixture rows nor claims
that deterministic fixture results were observed in production.

For the four non-query critical cases, production code derives the route from
the actual current user message before constructing the Agents SDK agent. A
trusted current-turn instruction tells the model the exact route. Trusted tool
guards then prohibit semantic/source queries for all four, require the exact
server-owned question and ordered option ids for Clarification, prohibit
`ask_user` for Unavailable, and reject a completed turn that ignored or
substituted the route. Unavailable copy is server-owned and names the missing
observation and unlock. The prompt-route case, route, and required detail are
included in the turn result digest.

The executable eval runs those four prompts through the real production
`runLiveAlbertTurn` and OpenAI Agents SDK `Runner`, using only a deterministic
model-provider seam. That provider reads the actual `ModelRequest.input` and
trusted `systemInstructions`; it is not a script detached from the prompt.
Negative tests prove that ignored or substituted prompts, missing `ask_user`,
wrong route semantics, a missing manifest case, reordered cases, substituted
prompt digests, and false outcome pass flags fail closed. The deterministic
golden runner now reports all 25 cases as executable: 20 semantic, one source
exploration, and four prompt-sensitive agent routes.

Protected outcome evidence is an exact tuple for all 25 cases. Its immutable
manifest shape contains only suite version/digest plus ordered case id, prompt
digest, expected route/state, and required-outcome digest. Its observed shape
adds the actual route/state/outcome digest and `passed: true` for every case.
Both validators reject omissions, additions, reordering, substitutions, and
outcome mismatches. The separately protected M5 evidence remains responsible
for exact live semantic result digests and rows; the 25-case outcome manifest
does not relabel deterministic fixture values as live evidence.

The protected environment secret is data, not policy. It must provide the
literal suite version and digest, then exactly 20 ordered case objects
containing only:

- the registry-owned case id;
- an exact ordered query tuple with the registry-owned query id, protected
  expected result digest, and live `run_semantic_query` IR input.

The schema rejects missing, additional, duplicated, renamed, or reordered
cases or queries; operator-supplied kinds, expected states, period policies, and
row requirements are extra keys and are also rejected. A composite registry
query must carry composite IR, while a golden query must not. Every supplied IR
must match its query's input-contract digest and period validators, and all
cross-range relations must pass. Protected inputs remain necessary because live
absolute evaluation windows and their exact result digests are sensitive and
change independently of the reviewed suite policy.

The collector executes every required query twice and requires the complete
query result object to repeat, its exact result digest to equal the protected
expectation, and its answer state to equal the code-owned expectation. The
comparison query uses a distinct append-only turn lease id for each pass, so it
cannot be omitted or conflated with the primary. A query with `nonempty` policy
must return a positive row count. A query with `allow-empty` policy may return
zero rows, but must still return a table, governed state, provenance, validation,
bundle hash, and the exact protected result digest.

The signed M5 evidence contains the suite version, suite digest, exact case
count, protected plan digest, and nested ordered case/query results including
each row policy, row count, result digest, and bundle hash. The attestation
schema also signs the collection anchor and uses exact tuples at both levels,
so neither a stale/shortened plan, partial/reordered case suite, nor an
omitted/reordered comparison can be signed for production. The signer and
verifier independently recompute the nested M5 evidence digest from those exact
fields and reject a supplied digest that does not match; the outer signed digest
then binds that verified subdigest and content to the complete attestation.
These fields remain part of the unreleased schema-version-2 replacement for
version 1; version 1 evidence cannot authorize a release.

A contract test derives the executable subset from `seedGoldenQuestions` and
compares ids, kinds, states, and order with the registry. Changes to the seed
suite therefore fail CI until the dogfood registry receives an explicit new
reviewed version and digest. It also constructs a collection-anchored 21-query
plan and proves that shorter to-date ranges and stale rolling, full-month,
history, week, and day ranges fail closed. Further negative contracts prove
that past and future issuance/anchor skew and an inconsistent nested M5 digest
are rejected, and that fixtures contain no row at or beyond the exclusive
collection anchor.

## Consequences

- Production promotion requires all 20 reviewed V1 semantic cases and all 21
  reviewed query inputs, including the refund comparison and all four composite
  cases, plus an exact complete 25-case route/state/outcome contract; two
  operator-selected smoke queries cannot pass.
- Live expected values and IR remain protected, and returned customer rows are
  still neither logged nor attested.
- The signed collection anchor discloses only the UTC collection-day boundary;
  it contains no tenant identifiers, row values, or operational measures.
- Any deliberate suite change requires a code review, version/digest rotation,
  trusted attestor release, and protected secret update.
- The workflow allows 60 minutes because 21 queries run sequentially twice
  through the real candidate service with one-use durable turn leases.
- Clarification, Unavailable, source exploration, and agent-surface behavior
  are bound by the complete outcome manifest and their agent/M6 acceptance
  evidence rather than being mislabeled as direct M5 semantic IR cases.

## Alternatives considered

- **Keep a minimum golden/composite pair:** rejected because it proves the
  mechanism but not the V1 semantic surface.
- **Keep registry policy in the protected JSON secret:** rejected because an
  environment editor could redefine the gate without a repository review.
- **Normalize every absolute timestamp without validating its range:** rejected
  because it makes materially shorter questions hash-identical.
- **Validate only duration and calendar shape:** rejected because a correctly
  shaped range can still be shortened or moved into the past relative to the
  collection run.
- **Supply an operator-owned `asOf` in the protected secret:** rejected because
  the same editor who can rotate expected values could backdate the gate. The
  trusted collector derives the anchor from its own clock instead.
- **Require a positive row count globally:** rejected because “none found” is a
  valid result for reviewed set-valued questions; row cardinality is governed
  per query instead.
- **Commit live expected values and IR:** rejected because tenant-local inputs
  and exact result digests can disclose operational characteristics and need a
  separate protected rotation lifecycle.
- **Run all 25 seed questions as M5 IR:** rejected because five intentionally
  exercise clarification, Unavailable, or source-exploration routes and do not
  have governed M5 semantic IR.

## Verification

- `evals/golden/dogfood-semantic-suite.mjs`
- `evals/golden/seed-outcome-suite.mjs`
- `evals/golden/questions.ts`
- `evals/golden-suite.test.ts`
- `evals/prompt-routing-agent.test.ts`
- `evals/seed-outcome-suite.test.ts`
- `services/conversation/src/prompt-routing.ts`
- `services/conversation/src/live.ts`
- `scripts/dogfood-acceptance-attestation.mjs`
- `scripts/collect-dogfood-acceptance.mjs`
- `.github/workflows/dogfood-acceptance.yml`
- `tests/contracts/dogfood-acceptance-attestation.contract.test.ts`
- `docs/protected-dogfood-acceptance.md`
