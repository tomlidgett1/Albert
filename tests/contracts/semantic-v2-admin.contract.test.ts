import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  attestSemanticProfileReceiptV2,
  verifySemanticProfileReceiptAttestationV2,
} from "../../packages/semantic-registry/src/profile-receipt-attestation.js";

const route = readFileSync("app/api/admin/semantic/route.ts", "utf8");
const workspace = readFileSync(
  "app/dash/components/SemanticAdminWorkspace.tsx",
  "utf8",
);
const measureBuilder = readFileSync(
  "app/dash/components/SemanticMeasureBuilder.tsx",
  "utf8",
);
const topicBuilder = readFileSync(
  "app/dash/components/SemanticTopicBuilder.tsx",
  "utf8",
);
const relationshipGraph = readFileSync(
  "app/dash/components/SemanticRelationshipGraph.tsx",
  "utf8",
);
const styles = readFileSync(
  "app/dash/components/semantic-admin.module.css",
  "utf8",
);
const receiptAttestation = readFileSync(
  "packages/semantic-registry/src/profile-receipt-attestation.ts",
  "utf8",
);
const adminPostgrestBoundary = readFileSync(
  "infra/migrations/control-plane/0106_m6_semantic_admin_postgrest_boundary.sql",
  "utf8",
);
const adminValidationReplay = readFileSync(
  "infra/migrations/control-plane/0107_m6_semantic_admin_validation_replay.sql",
  "utf8",
);
const releaseQualificationRls = readFileSync(
  "infra/migrations/control-plane/0108_m6_semantic_release_qualification_rls.sql",
  "utf8",
);

test("semantic administration is internal-only and uses immutable draft/publication workflows", () => {
  assert.match(route, /isInternalOperator/u);
  for (const action of [
    "create_draft",
    "update_object",
    "register_profile_receipt",
    "promote_relationship_candidate",
    "reject_relationship_candidate",
    "batch_relationship_decisions",
    "validate_draft",
    "review_object",
    "publish_draft",
    "activate_publication",
    "rollback_publication",
    "set_business_context_value",
    "preview_topic_context",
  ])
    assert.match(route, new RegExp(`literal\\(\"${action}\"\\)`, "u"));
  assert.match(route, /expectedRevision/u);
  assert.match(route, /draftRevision/u);
  assert.match(route, /profileReceiptHash/u);
  assert.match(route, /targetFieldId/u);
  assert.match(route, /promoteRelationshipCandidate/u);
  assert.match(route, /rejectRelationshipCandidate/u);
  assert.match(route, /governed promotion or rejection workflows/u);
  assert.match(route, /operator_review:/u);
  assert.match(route, /relationshipResolutionEvidence/u);
  assert.match(route, /planSemanticRelationshipResolutionsV2/u);
  assert.match(route, /diffDraftFromBase/u);
  assert.match(route, /diffSemanticRegistryV2/u);
  assert.match(route, /content-addressed integrity check/u);
  assert.match(route, /albert_semantic_v2_admin_profile_receipt/u);
  assert.doesNotMatch(route, /\.schema\("control_plane"\)/u);
  assert.match(
    route,
    /registered profile does not prove a safe many-to-one target/iu,
  );
  assert.match(route, /Draft revision conflict/u);
  assert.match(route, /createSemanticPublicationV2/u);
  assert.match(route, /modelEvaluationTriggered: false/u);
  assert.match(route, /compileQueryWorkspaceV2/u);
  assert.match(route, /executableSqlDisclosed: false/u);
  assert.match(route, /evaluationCorpusSummary/u);
  assert.match(route, /\.length\(200\)/u);
  assert.match(route, /albert_semantic_v2_admin_state/u);
  assert.match(route, /privacy-preserving V2 runtime event/u);
});

test("semantic administration stays behind narrow public RPCs without exposing the control schema", () => {
  for (const routine of [
    "albert_semantic_v2_admin_state",
    "albert_semantic_v2_admin_profile_receipt",
    "albert_semantic_v2_admin_load_draft",
    "albert_semantic_v2_admin_load_publication",
    "albert_semantic_v2_admin_load_initial_revision",
    "albert_semantic_v2_create_draft_from_current",
    "albert_semantic_v2_admin_register_profile_receipt",
    "albert_semantic_v2_admin_record_validation",
  ]) {
    assert.match(adminPostgrestBoundary, new RegExp(routine, "u"));
  }
  assert.match(adminPostgrestBoundary, /control_plane\.is_internal_operator\(\)/u);
  assert.match(
    adminPostgrestBoundary,
    /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC,anon,service_role/u,
  );
  assert.doesNotMatch(adminPostgrestBoundary, /GRANT[^;]+TO (?:anon|service_role)/iu);
});

test("semantic validation replay is immutable, exact, and idempotent", () => {
  assert.match(
    adminValidationReplay,
    /FROM control_plane\.semantic_v2_drafts[\s\S]*FOR UPDATE/u,
  );
  assert.match(
    adminValidationReplay,
    /semantic_v2_validation_reports[\s\S]*draft_revision=p_expected_revision/u,
  );
  assert.match(adminValidationReplay, /idempotentReplay',true/u);
  assert.match(adminValidationReplay, /idempotentReplay',false/u);
  assert.match(
    adminValidationReplay,
    /immutable validation replay does not match the existing report/u,
  );
  assert.match(route, /semanticAdminValidationResultSchema\.parse\(data\)/u);
  assert.match(route, /idempotentReplay: persistedValidation\.idempotentReplay/u);
});

test("release qualification can read only immutable semantic evidence and append its receipt", () => {
  for (const table of [
    "semantic_v2_drafts",
    "semantic_v2_draft_revisions",
    "semantic_v2_profile_receipts",
    "semantic_v2_publications",
  ]) {
    assert.match(
      releaseQualificationRls,
      new RegExp(
        `ON control_plane\\.${table}[\\s\\S]*?FOR SELECT TO albert_control_migration_owner[\\s\\S]*?USING \\(true\\)`,
        "u",
      ),
    );
  }
  assert.match(
    releaseQualificationRls,
    /ON control_plane\.semantic_v2_activation_qualifications[\s\S]*?FOR INSERT TO albert_control_migration_owner[\s\S]*?WITH CHECK \(true\)/u,
  );
  assert.doesNotMatch(
    releaseQualificationRls,
    /(?:anon|authenticated|service_role|albert_semantic_control)/u,
  );
  assert.doesNotMatch(releaseQualificationRls, /FOR (?:ALL|UPDATE|DELETE)/u);
});

test("the admin surface can edit every semantic object contract and version tenant context", () => {
  for (const objectType of [
    "sourceObject",
    "field",
    "view",
    "dimension",
    "measure",
    "relationship",
    "relationshipCandidate",
    "topic",
    "businessContext",
  ]) {
    assert.match(workspace, new RegExp(`${objectType}: \\[`, "u"));
  }
  assert.match(workspace, /Edit contract/u);
  assert.match(workspace, /Promote profiled join/u);
  assert.match(workspace, /Reject candidate/u);
  assert.match(workspace, /EXPLICIT UNSUPPORTED JOIN/u);
  assert.match(workspace, /Latest authenticated live profile/u);
  assert.match(workspace, /promote_review_candidate/u);
  assert.match(workspace, /Object-aware semantic draft diff/u);
  assert.match(workspace, /Tier 1 impact/u);
  assert.match(workspace, /Register profile receipt/u);
  assert.match(workspace, /Apply reviewed decisions/u);
  assert.match(workspace, /ATOMIC RELATIONSHIP REVIEW/u);
  assert.match(workspace, /Set tenant value/u);
  assert.match(workspace, /Preview .*selected\.label/u);
  assert.match(workspace, /DETERMINISTIC PREVIEW/u);
  assert.match(workspace, /compiled plan/u);
  assert.match(workspace, /200-case Luna Max corpus/u);
  assert.match(workspace, /hidden prompts remain sealed/iu);
  assert.match(workspace, /semanticOffset/u);
  assert.match(workspace, /visibleItems/u);
  assert.match(workspace, /Publications and rollback/u);
});

test("semantic health is aggregate-only and exposes operational distributions without customer payloads", () => {
  const migration = readFileSync(
    "infra/migrations/control-plane/0103_semantic_v2_admin_health.sql",
    "utf8",
  );
  const qualification = readFileSync(
    "scripts/run-v2-deterministic-qualification.mts",
    "utf8",
  );
  assert.match(migration, /albert_semantic_v2_admin_health/u);
  assert.match(migration, /SECURITY DEFINER/u);
  assert.match(migration, /is_internal_operator/u);
  assert.match(migration, /answerability/u);
  assert.match(migration, /percentile_cont\(0\.95\)/u);
  assert.match(migration, /normalizedIr'[\s\S]*topicIds/u);
  assert.match(migration, /normalizedIr'[\s\S]*dimensionIds/u);
  assert.match(migration, /normalizedIr'[\s\S]*measureIds/u);
  assert.doesNotMatch(migration, /question_text|answer_text|result_rows/u);
  assert.match(qualification, /albert_semantic_v2_admin_health\(timestamptz\)/u);
  assert.match(workspace, /Thirty-day, privacy-preserving V2 telemetry/u);
  assert.match(workspace, /Top unavailable and failure reasons/u);
  assert.match(workspace, /Most-used Topics/u);
  assert.match(workspace, /Active publication drift/u);
});

test("measure authoring uses a bounded typed formula builder with impact visibility", () => {
  assert.match(workspace, /Open measure builder/u);
  assert.match(workspace, /measureDraftChanges/u);
  assert.match(route, /measureAuthoringContext/u);
  assert.match(route, /expressionReferences/u);
  assert.match(route, /MAX_MEASURE_EXPRESSION_NODES_V2/u);
  assert.match(route, /MAX_MEASURE_EXPRESSION_DEPTH_V2/u);
  assert.match(measureBuilder, /GOVERNED MEASURE BUILDER/u);
  assert.match(measureBuilder, /Formula builder/u);
  for (const operation of [
    "field",
    "literal",
    "metric",
    "aggregate",
    "binary",
    "coalesce",
    "conditional",
    "weighted_average",
  ])
    assert.match(measureBuilder, new RegExp(`"${operation}"`, "u"));
  assert.match(measureBuilder, /Dependent measures/u);
  assert.match(measureBuilder, /Topic exposure/u);
  assert.match(measureBuilder, /Save governed revision/u);
  assert.doesNotMatch(measureBuilder, /Physical SQL.*textarea/iu);
});

test("Topic authoring is structured, graph-aware, and preserves membership invariants", () => {
  assert.match(workspace, /Open Topic builder/u);
  assert.match(workspace, /topicDraftChanges/u);
  assert.match(route, /topicAuthoringContext/u);
  assert.match(topicBuilder, /GOVERNED TOPIC BUILDER/u);
  assert.match(topicBuilder, /Model-visible surface/u);
  assert.match(topicBuilder, /Default root view/u);
  assert.match(topicBuilder, /Composite alignment dimensions/u);
  assert.match(topicBuilder, /Default filters/u);
  assert.match(topicBuilder, /Sample questions, one per line/u);
  assert.match(topicBuilder, /Ambiguity notes, one per line/u);
  assert.match(topicBuilder, /Unsupported questions, one per line/u);
  assert.match(topicBuilder, /nextDimensionIds/u);
  assert.match(topicBuilder, /relationshipIds: initialDraft\.relationshipIds\.filter/u);
  assert.match(topicBuilder, /defaultFilters: initialDraft\.defaultFilters\.filter/u);
  assert.match(topicBuilder, /Composite Topics need one conformed key aligned across two views/u);
  assert.match(topicBuilder, /Save Topic revision/u);
  assert.doesNotMatch(topicBuilder, /Semantic contract JSON/u);
});

test("relationship administration exposes a complete navigable graph without authorizing candidates", () => {
  assert.match(route, /relationshipGraphData/u);
  assert.match(route, /document\.relationshipCandidates\.flatMap/u);
  assert.match(route, /status: "supported" as const/u);
  assert.match(route, /conflicts: document\.relationshipCandidates/u);
  assert.match(workspace, /SemanticRelationshipGraph/u);
  assert.match(relationshipGraph, /Navigable semantic graph/u);
  assert.match(relationshipGraph, /A visible candidate is\s*not executable/u);
  assert.match(relationshipGraph, /Search graph views/u);
  assert.match(relationshipGraph, /Graph relationship status/u);
  assert.match(relationshipGraph, /Focused relationship edges/u);
  assert.match(relationshipGraph, /onSelectObject/u);
});

test("relationship review batches are bounded, explicit, profile-gated, and atomically revisioned", () => {
  assert.match(route, /\.max\(100\)/u);
  assert.match(route, /A relationship candidate may appear only once in a batch/u);
  const batchBranch = route.match(
    /if \(input\.action === "batch_relationship_decisions"\)([\s\S]*?)if \(input\.action === "reject_relationship_candidate"\)/u,
  )?.[1];
  assert.ok(batchBranch, "batch mutation branch must exist");
  assert.match(batchBranch, /requirePromotionProfile/u);
  assert.match(batchBranch, /promoteRelationshipCandidate/u);
  assert.match(batchBranch, /rejectRelationshipCandidate/u);
  assert.equal(
    batchBranch.match(/albert_semantic_v2_replace_draft/gu)?.length,
    1,
    "the batch must persist exactly one optimistic draft revision",
  );
  assert.match(batchBranch, /p_expected_revision: input\.expectedRevision/u);
  assert.match(workspace, /up to 100 explicit promotions or rejections/iu);
  assert.match(workspace, /entire batch fails together/iu);
});

test("risk-tier review enforcement is computed from the pinned manifest", () => {
  const migration = readFileSync(
    "infra/migrations/control-plane/0101_semantic_execution_v2.sql",
    "utf8",
  );
  assert.match(migration, /review tier does not match the semantic contract/u);
  assert.match(migration, /object_type='relationship'/u);
  assert.match(migration, /object_type='topic'/u);
  assert.match(migration, /object_type='field'/u);
  assert.match(migration, /count\(DISTINCT reviewer_id\)/u);
  assert.match(migration, /risk_tier=v_required_tier/u);
});

test("relationship promotion requires canonical immutable live-profile evidence", () => {
  const profiler = readFileSync(
    "scripts/profile-semantic-v2-inventory.mts",
    "utf8",
  );
  assert.match(
    profiler,
    /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/u,
  );
  assert.match(profiler, /duplicate_target_key_groups/u);
  assert.match(profiler, /source_foreign_keys/u);
  assert.match(profiler, /profileCoverageComplete/u);
  assert.match(profiler, /withProfileSavepoint/u);
  assert.match(profiler, /semantic_profile_progress/u);
  assert.match(profiler, /durationMs/u);
  assert.match(profiler, /semanticProfileReceiptDigestV2\(receipt\)/u);
  assert.match(profiler, /attestSemanticProfileReceiptV2/u);
  assert.match(receiptAttestation, /createHmac\("sha256", secret\)/u);
  assert.match(receiptAttestation, /albert-semantic-v2-profile-receipt/u);
  assert.match(route, /targetProfile\.duplicateTargetKeyGroups > 0/u);
  assert.match(
    route,
    /targetProfile\.sampledForeignKeys <= targetProfile\.orphanRows/u,
  );
  assert.match(route, /targetProfile\.maximumTargetMatches !== 1/u);
  const qualification = readFileSync(
    "scripts/run-v2-deterministic-qualification.mts",
    "utf8",
  );
  assert.match(
    qualification,
    /Number\(targetProfile\.sampledForeignKeys\) <=[\s\S]*Number\(targetProfile\.orphanRows\)/u,
  );
  assert.match(
    qualification,
    /Number\(targetProfile\.maximumTargetMatches\) !== 1/u,
  );
  assert.match(route, /targetFieldId === input\.targetFieldId/u);
  assert.match(route, /targetProfile\.profileCoverageComplete/u);
  assert.match(route, /targetProfile\.nullForeignKeys > 0/u);
  assert.match(
    route,
    /receipt\.publicationHash !== expectedProfilePublication/u,
  );
  assert.match(route, /verifySemanticProfileReceiptAttestationV2/u);
  assert.match(route, /semantic profiling receipt attestation is invalid/iu);
});

test("profile receipt attestation rejects mutation and a different signing authority", () => {
  const secret = "profile-authority-a".repeat(3);
  const unsigned = {
    schemaVersion: 2,
    status: "complete",
    publicationHash: "a".repeat(64),
    relationshipProfiles: [{ candidateId: "candidate", targets: [] }],
  };
  const receipt = {
    ...unsigned,
    attestation: attestSemanticProfileReceiptV2(unsigned, secret),
  };
  assert.equal(
    verifySemanticProfileReceiptAttestationV2(receipt, secret),
    true,
  );
  assert.equal(
    verifySemanticProfileReceiptAttestationV2(
      { ...receipt, status: "incomplete" },
      secret,
    ),
    false,
  );
  assert.equal(
    verifySemanticProfileReceiptAttestationV2(
      receipt,
      "profile-authority-b".repeat(3),
    ),
    false,
  );
  const timestamped = {
    ...unsigned,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
  };
  const persisted = JSON.parse(
    JSON.stringify({
      ...timestamped,
      attestation: attestSemanticProfileReceiptV2(timestamped, secret),
    }),
  );
  assert.equal(
    verifySemanticProfileReceiptAttestationV2(persisted, secret),
    true,
  );
});

test("semantic admin controls inherit the dash design system and reduced-motion behavior", () => {
  assert.match(styles, /height: var\(--dash-control-height\)/u);
  assert.match(styles, /border-radius: 28px/u);
  assert.match(styles, /cubic-bezier\(0?\.22,\s*1,\s*0?\.36,\s*1\)/u);
  assert.match(styles, /var\(--dash-surface\)/u);
  assert.match(styles, /var\(--dash-text-body\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.doesNotMatch(styles, /background:\s*#fff(?:fff)?/iu);
});
