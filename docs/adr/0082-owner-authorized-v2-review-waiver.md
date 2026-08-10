# ADR 0082: Owner-authorized V2 review waiver

- Status: accepted
- Date: 2026-08-10
- Amends: ADR 0077

## Context

The first Lightspeed/Xero V2 release has no recorded semantic object reviews.
The locked 200-case model evaluation also requires independent subjective
scoring of diagnosis and recommendation quality, but the product owner
explicitly authorized proceeding without either form of human review.

Treating missing review as completed would falsify release evidence. Removing
the review controls globally would silently weaken every later publication.
Neither is acceptable.

## Decision

Albert supports three narrowly scoped owner-review waivers:

1. `semantic_publication_human_review` replaces semantic object review for one
   exact draft revision and publication hash. It records that human review was
   absent; it does not create object approvals. Deterministic validation,
   unresolved change requests and all semantic safety checks remain mandatory.
2. `semantic_publication_tier_1_second_review` replaces only the second
   independent Tier 1 approval for one exact draft revision and publication
   hash. Every Tier 1 object must still have one real approval. Tier 2 approval,
   deterministic validation, unresolved change requests and all semantic
   safety checks remain mandatory.
3. `evaluation_subjective_human_review` replaces only subjective human scoring
   for one exact publication, 40-character commit and evaluation run. It does
   not create human ratings. The grade records `owner_waived`, leaves human
   coverage and quality metrics truthful, and still requires every numerical,
   structural, isolation, fan-out, grounding, runtime, latency and safety gate.

Each waiver is an immutable, content-addressed control-plane artifact tied to
an enabled internal operator, a specific reason and its complete release
binding. A waiver can be appended only through the release-only registration
path. It cannot be edited, deleted, reused for another release or created by a
browser/runtime identity. Final release qualification independently reloads
the evaluation waiver from the control plane and verifies its digest and exact
binding.

## Consequences

- The first V2 release can proceed without fabricating object approvals,
  reviewers or scores.
- Release evidence explicitly discloses the accepted subjective-review gap.
- The waiver cannot bypass deterministic correctness or security gates.
- Later releases remain subject to normal review unless the owner records a
  new exact-release waiver.
