import assert from "node:assert/strict";
import test from "node:test";

import type { SemanticRegistryDocumentV2 } from "../../packages/semantic-registry/src/v2.js";
import {
  planSemanticRelationshipResolutionsV2,
  summarizeSemanticRelationshipResolutionsV2,
  type RelationshipProfileReceiptV2,
} from "../../scripts/lib/semantic-v2-relationship-resolution.js";

const registry = {
  relationshipCandidates: [
    {
      id: "candidate.source.parent_id",
      fromViewId: "source.child",
      fromFieldId: "child.parent_id",
      targets: [
        {
          viewId: "source.parent",
          fieldId: "parent.parent_id",
          matchKind: "exact_key_name",
        },
      ],
      candidateViewIds: ["source.parent"],
      disposition: "unresolved",
      reason: "Pending profile.",
      evidence: [],
    },
    {
      id: "candidate.source.unmapped_id",
      fromViewId: "source.child",
      fromFieldId: "child.unmapped_id",
      targets: [],
      candidateViewIds: [],
      disposition: "unresolved",
      reason: "No target.",
      evidence: [],
    },
  ],
} as unknown as SemanticRegistryDocumentV2;

function receipt(
  overrides: Partial<RelationshipProfileReceiptV2> = {},
): RelationshipProfileReceiptV2 {
  return {
    status: "complete",
    publicationHash: "a".repeat(64),
    errors: [],
    sourceProfiles: [],
    relationshipProfiles: [
      {
        candidateId: "candidate.source.parent_id",
        targets: [
          {
            targetViewId: "source.parent",
            targetFieldId: "parent.parent_id",
            sourceRows: 12,
            sourceForeignKeys: 10,
            nullForeignKeys: 2,
            sampledForeignKeys: 10,
            profileCoverageComplete: true,
            orphanRows: 1,
            maximumTargetMatches: 1,
            ambiguousRows: 0,
            duplicateTargetKeyGroups: 0,
            recommendedCardinality: "many_to_one",
            recommendedDisposition: "review_candidate",
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("relationship resolution proposes only an exact, structurally safe target", () => {
  const resolutions = planSemanticRelationshipResolutionsV2(
    registry,
    receipt(),
  );
  assert.equal(resolutions[0]?.status, "promote_review_candidate");
  assert.equal(resolutions[0]?.proposal?.targetViewId, "source.parent");
  assert.equal(resolutions[0]?.proposal?.optional, true);
  assert.equal(resolutions[1]?.status, "no_declared_target");
  assert.deepEqual(summarizeSemanticRelationshipResolutionsV2(resolutions), {
    promote_review_candidate: 1,
    ambiguous_targets: 0,
    unsafe_multiplicity: 0,
    no_profiled_data: 0,
    no_profiled_match: 0,
    no_declared_target: 1,
    profile_missing: 0,
    profile_error: 0,
  });
});

test("duplicate target keys are classified as unsafe rather than promoted", () => {
  const unsafe = receipt({
    relationshipProfiles: [
      {
        candidateId: "candidate.source.parent_id",
        targets: [
          {
            ...receipt().relationshipProfiles[0]!.targets[0]!,
            maximumTargetMatches: 2,
            ambiguousRows: 3,
            duplicateTargetKeyGroups: 1,
            recommendedCardinality: "unsupported",
            recommendedDisposition: "unresolved",
          },
        ],
      },
    ],
  });
  const [resolution] = planSemanticRelationshipResolutionsV2(registry, unsafe);
  assert.equal(resolution?.status, "unsafe_multiplicity");
  assert.equal(resolution?.proposal, undefined);
});

test("profiling errors and sparse data never become rejection evidence", () => {
  const [failed] = planSemanticRelationshipResolutionsV2(
    registry,
    receipt({
      errors: [
        {
          objectId: "candidate.source.parent_id:source.parent",
          error: "statement timeout",
        },
      ],
    }),
  );
  assert.equal(failed?.status, "profile_error");

  const [sparse] = planSemanticRelationshipResolutionsV2(
    registry,
    receipt({
      relationshipProfiles: [
        {
          candidateId: "candidate.source.parent_id",
          targets: [
            {
              ...receipt().relationshipProfiles[0]!.targets[0]!,
              sourceForeignKeys: 0,
              sampledForeignKeys: 0,
              orphanRows: 0,
              maximumTargetMatches: 0,
              recommendedDisposition: "unresolved",
            },
          ],
        },
      ],
    }),
  );
  assert.equal(sparse?.status, "no_profiled_data");

  const [allOrphans] = planSemanticRelationshipResolutionsV2(
    registry,
    receipt({
      relationshipProfiles: [
        {
          candidateId: "candidate.source.parent_id",
          targets: [
            {
              ...receipt().relationshipProfiles[0]!.targets[0]!,
              orphanRows: 10,
              maximumTargetMatches: 0,
              recommendedCardinality: "unsupported",
              recommendedDisposition: "unresolved",
            },
          ],
        },
      ],
    }),
  );
  assert.equal(allOrphans?.status, "no_profiled_match");
  assert.equal(allOrphans?.proposal, undefined);
});
