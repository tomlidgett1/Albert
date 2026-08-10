import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("owner review waivers are immutable and exact-release scoped", async () => {
  const migration = await read(
    "infra/migrations/control-plane/0111_semantic_v2_owner_review_waivers.sql",
  );
  assert.match(migration, /semantic_v2_owner_review_waivers_immutable/u);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(
    migration,
    /semantic_publication_tier_1_second_review/u,
  );
  assert.match(migration, /evaluation_subjective_human_review/u);
  assert.match(
    migration,
    /v_approvals=1 AND v_review_waiver_digest IS NOT NULL/u,
  );
  assert.match(
    migration,
    /v_required_tier='tier_2' AND v_approvals<1/u,
  );
  assert.match(migration, /requested review changes remain unresolved/u);
  assert.doesNotMatch(
    migration,
    /GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*authenticated/iu,
  );
});

test("waiver registration and grading never fabricate human reviews", async () => {
  const [registration, grading, qualifier] = await Promise.all([
    read("scripts/register-semantic-v2-owner-review-waiver.mts"),
    read("scripts/v2-evaluation-grading.ts"),
    read("scripts/qualify-semantic-v2-release.mts"),
  ]);
  assert.match(registration, /--execute/u);
  assert.match(registration, /enabled AND revoked_at IS NULL/u);
  assert.match(registration, /v2OwnerReviewWaiverDigest/u);
  assert.match(grading, /status: "owner_waived"/u);
  assert.match(grading, /subjectiveReviewRequirementSatisfied/u);
  assert.doesNotMatch(grading, /humanReviews\.push/u);
  assert.match(
    grading,
    /humanQuality:\s*reviewedHumanCases\.length === 0\s*\? null/u,
  );
  assert.match(qualifier, /semantic_v2_owner_review_waivers/u);
  assert.match(qualifier, /assertV2OwnerReviewWaiver/u);
});
