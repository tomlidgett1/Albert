import type { SemanticRegistryDocumentV2 } from "../../packages/semantic-registry/src/v2.js";

export type RelationshipTargetProfileV2 = Readonly<{
  targetViewId: string;
  targetFieldId: string;
  sourceRows: number;
  sourceForeignKeys: number;
  nullForeignKeys: number;
  sampledForeignKeys: number;
  profileCoverageComplete: boolean;
  orphanRows: number;
  maximumTargetMatches: number;
  ambiguousRows: number;
  duplicateTargetKeyGroups: number;
  recommendedCardinality: string;
  recommendedDisposition: string;
}>;

export type RelationshipProfileReceiptV2 = Readonly<{
  status: "complete" | "incomplete";
  publicationHash: string;
  sourceProfiles: readonly Readonly<{
    sourceObjectId: string;
    rowCount: number;
    sampledRows: number;
    missingColumns: readonly string[];
    typeMismatches: readonly unknown[];
  }>[];
  relationshipProfiles: readonly Readonly<{
    candidateId: string;
    targets: readonly RelationshipTargetProfileV2[];
  }>[];
  errors: readonly Readonly<{ objectId?: string; error?: string }>[];
}>;

export type RelationshipResolutionStatusV2 =
  | "promote_review_candidate"
  | "ambiguous_targets"
  | "unsafe_multiplicity"
  | "no_profiled_data"
  | "no_profiled_match"
  | "no_declared_target"
  | "profile_missing"
  | "profile_error";

export type RelationshipResolutionV2 = Readonly<{
  candidateId: string;
  fromViewId: string;
  fromFieldId: string;
  status: RelationshipResolutionStatusV2;
  reason: string;
  proposal?: Readonly<{
    targetViewId: string;
    targetFieldId: string;
    cardinality: "many_to_one";
    optional: boolean;
    temporalBehavior: "not_applicable";
    topicIds: readonly string[];
    notes: string;
  }>;
  targets: readonly Readonly<{
    targetViewId: string;
    targetFieldId: string;
    sampledForeignKeys: number;
    orphanRows: number;
    maximumTargetMatches: number;
    ambiguousRows: number;
    duplicateTargetKeyGroups: number;
    safeManyToOne: boolean;
  }>[];
}>;

function isSafeManyToOne(target: RelationshipTargetProfileV2): boolean {
  return (
    target.sampledForeignKeys > 0 &&
    target.sampledForeignKeys > target.orphanRows &&
    target.maximumTargetMatches === 1 &&
    target.ambiguousRows === 0 &&
    target.duplicateTargetKeyGroups === 0 &&
    target.recommendedCardinality === "many_to_one" &&
    target.recommendedDisposition === "review_candidate"
  );
}

export function planSemanticRelationshipResolutionsV2(
  registry: SemanticRegistryDocumentV2,
  receipt: RelationshipProfileReceiptV2,
): readonly RelationshipResolutionV2[] {
  const profiles = new Map(
    receipt.relationshipProfiles.map((profile) => [
      profile.candidateId,
      profile,
    ]),
  );
  return Object.freeze(
    registry.relationshipCandidates.map((candidate) => {
      const candidateErrors = receipt.errors.filter(
        ({ objectId }) =>
          objectId?.startsWith(`${candidate.id}:`) || objectId === candidate.id,
      );
      const profile = profiles.get(candidate.id);
      const exactTargets = (profile?.targets ?? []).filter((profileTarget) =>
        candidate.targets.some(
          (candidateTarget) =>
            candidateTarget.viewId === profileTarget.targetViewId &&
            candidateTarget.fieldId === profileTarget.targetFieldId,
        ),
      );
      const targets = exactTargets.map((target) => ({
        targetViewId: target.targetViewId,
        targetFieldId: target.targetFieldId,
        sampledForeignKeys: target.sampledForeignKeys,
        orphanRows: target.orphanRows,
        maximumTargetMatches: target.maximumTargetMatches,
        ambiguousRows: target.ambiguousRows,
        duplicateTargetKeyGroups: target.duplicateTargetKeyGroups,
        safeManyToOne: isSafeManyToOne(target),
      }));
      const base = {
        candidateId: candidate.id,
        fromViewId: candidate.fromViewId,
        fromFieldId: candidate.fromFieldId,
        targets,
      };
      if (candidateErrors.length > 0)
        return {
          ...base,
          status: "profile_error" as const,
          reason: `Live profiling failed for this candidate or one of its declared targets: ${candidateErrors.map(({ error }) => error ?? "unspecified error").join("; ")}`,
        };
      if (candidate.targets.length === 0)
        return {
          ...base,
          status: "no_declared_target" as const,
          reason:
            "No exact governed target is declared. Domain review must document a target or reject the candidate; absence of an inferred target is not rejection evidence.",
        };
      if (!profile)
        return {
          ...base,
          status: "profile_missing" as const,
          reason:
            "The receipt has no profile for this candidate. It cannot authorize promotion or rejection.",
        };
      const safeTargets = exactTargets.filter(isSafeManyToOne);
      if (safeTargets.length > 1)
        return {
          ...base,
          status: "ambiguous_targets" as const,
          reason:
            "More than one declared target is structurally safe. Domain semantics must choose exactly one; matching data alone cannot select the relationship.",
        };
      if (safeTargets.length === 1) {
        const target = safeTargets[0]!;
        const optional =
          !target.profileCoverageComplete ||
          target.nullForeignKeys > 0 ||
          target.orphanRows > 0;
        return {
          ...base,
          status: "promote_review_candidate" as const,
          reason:
            "Exactly one declared target has sampled foreign keys, a unique target key, and no ambiguous matches. Domain and temporal review are still required before promotion.",
          proposal: {
            targetViewId: target.targetViewId,
            targetFieldId: target.targetFieldId,
            cardinality: "many_to_one" as const,
            optional,
            temporalBehavior: "not_applicable" as const,
            topicIds: [],
            notes: `Receipt evidence shows ${target.sampledForeignKeys} sampled foreign keys, ${target.orphanRows} orphan rows, maximum target multiplicity ${target.maximumTargetMatches}, and ${target.duplicateTargetKeyGroups} duplicate target-key groups. A domain reviewer must confirm identity, temporal behavior, and Topic exposure.`,
          },
        };
      }
      if (
        exactTargets.every(({ sampledForeignKeys }) => sampledForeignKeys === 0)
      )
        return {
          ...base,
          status: "no_profiled_data" as const,
          reason:
            "No non-null source foreign key was observed. Sparse data cannot prove or disprove the documented relationship.",
        };
      if (
        exactTargets.every(
          ({ sampledForeignKeys, orphanRows }) =>
            sampledForeignKeys === orphanRows,
        )
      )
        return {
          ...base,
          status: "no_profiled_match" as const,
          reason:
            "Non-null source keys were observed, but none matched a declared governed target. This profile cannot authorize promotion; domain review must correct the target or leave the relationship unsupported.",
        };
      return {
        ...base,
        status: "unsafe_multiplicity" as const,
        reason:
          "Observed target multiplicity or duplicate target keys prevent a safe many-to-one relationship. Review the source contract before explicitly rejecting or remodelling it.",
      };
    }),
  );
}

export function summarizeSemanticRelationshipResolutionsV2(
  resolutions: readonly RelationshipResolutionV2[],
): Readonly<Record<RelationshipResolutionStatusV2, number>> {
  const counts: Record<RelationshipResolutionStatusV2, number> = {
    promote_review_candidate: 0,
    ambiguous_targets: 0,
    unsafe_multiplicity: 0,
    no_profiled_data: 0,
    no_profiled_match: 0,
    no_declared_target: 0,
    profile_missing: 0,
    profile_error: 0,
  };
  for (const resolution of resolutions) counts[resolution.status] += 1;
  return Object.freeze(counts);
}
