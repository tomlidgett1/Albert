import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  "infra/migrations/control-plane/0101_semantic_execution_v2.sql",
  "utf8",
);
const adminRoute = readFileSync("app/api/admin/semantic/route.ts", "utf8");
const releaseQualifier = readFileSync(
  "scripts/qualify-semantic-v2-release.mts",
  "utf8",
);
const deterministicQualifier = readFileSync(
  "scripts/run-v2-deterministic-qualification.mts",
  "utf8",
);

test("V2 semantic publications and execution evidence are immutable", () => {
  for (const trigger of [
    "semantic_v2_draft_revisions_immutable",
    "semantic_v2_validations_immutable",
    "semantic_v2_profile_receipts_immutable",
    "semantic_v2_publications_immutable",
    "query_workspace_revisions_v2_immutable",
    "query_execution_snapshots_v2_immutable",
    "evidence_artifacts_v2_immutable",
    "semantic_result_cache_v2_immutable",
    "business_context_snapshots_v2_immutable",
    "semantic_runtime_events_v2_immutable",
  ])
    assert.match(migration, new RegExp(`CREATE TRIGGER ${trigger}`, "u"));
});

test("V2 runtime state remains tenant scoped and does not add a customer role system", () => {
  for (const table of [
    "query_workspaces_v2",
    "query_workspace_revisions_v2",
    "query_execution_snapshots_v2",
    "evidence_artifacts_v2",
    "semantic_result_cache_v2",
    "business_context_v2",
    "business_context_snapshots_v2",
    "insight_ledger_v2",
    "semantic_runtime_events_v2",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `CREATE POLICY ${table.replace(/_v2$/u, "_v2")}[\\s\\S]*tenant_id=current_setting\\('albert\\.tenant_id'`,
        "u",
      ),
    );
  }
  assert.doesNotMatch(migration, /semantic_v2_(role|permission|entitlement)/iu);
});

test("immutable tenant artifacts remain erasable only by the approved deletion capability", () => {
  assert.match(
    migration,
    /TG_OP='DELETE'[\s\S]*current_setting\('albert\.deletion_authorized',true\)='on'[\s\S]*to_jsonb\(OLD\) \? 'tenant_id'/u,
  );
});

test("workspace derivation, cache identity, context snapshots, and insight novelty are durable", () => {
  assert.match(
    migration,
    /derived_from_workspace_id[\s\S]*query_workspaces_v2_derivation_fkey/u,
  );
  assert.match(
    migration,
    /CREATE TABLE control_plane\.semantic_result_cache_v2[\s\S]*PRIMARY KEY \(tenant_id,cache_key\)/u,
  );
  assert.match(
    migration,
    /cache_key text NOT NULL[\s\S]*cached_from_execution_id/u,
  );
  assert.match(
    migration,
    /CREATE TABLE control_plane\.business_context_snapshots_v2/u,
  );
  assert.match(
    migration,
    /insight_ledger_v2[\s\S]*evidence_digest[\s\S]*occurrences/u,
  );
  assert.match(
    migration,
    /CREATE TABLE control_plane\.semantic_runtime_events_v2/u,
  );
  assert.match(migration, /reason_code text NOT NULL/u);
  assert.match(migration, /question_digest text NOT NULL CHECK/u);
});

test("admin draft mutations require optimistic revisions", () => {
  assert.match(migration, /p_expected_revision integer/u);
  assert.match(migration, /IF v_revision<>p_expected_revision/u);
  assert.match(migration, /ERRCODE='40001'/u);
});

test("activation is bound to the exact publication and full release commit after both qualification stages", () => {
  assert.match(
    migration,
    /commit_sha text NOT NULL CHECK \(commit_sha~'\^\[a-f0-9\]\{40\}\$'\)/u,
  );
  assert.match(
    migration,
    /WHERE publication_hash=p_publication_hash AND commit_sha=p_commit_sha AND status='passed'/u,
  );
  assert.match(
    adminRoute,
    /resolveWebReleaseIdentity\(process\.env\)\.releaseSha/u,
  );
  assert.match(adminRoute, /\^\[a-f0-9\]\{40\}\$/u);
  assert.match(
    releaseQualifier,
    /deterministic\.publicationHash !== publicationHash\s*\|\|\s*deterministic\.commit !== commit/u,
  );
  assert.match(releaseQualifier, /launch\.model !== "gpt-5\.6-luna"/u);
  assert.match(releaseQualifier, /launch\.reasoningEffort !== "max"/u);
  assert.match(releaseQualifier, /grade\.status !== "passed"/u);
  assert.match(releaseQualifier, /gradeBinding\.runId !== launch\.runId/u);
  assert.match(releaseQualifier, /goldManifestHash/u);
  assert.match(releaseQualifier, /datasetWatermarkHash/u);
  assert.match(deterministicQualifier, /"all-contracts"/u);
  assert.match(deterministicQualifier, /"test:contracts"/u);
  assert.match(deterministicQualifier, /"all-evaluations"/u);
  assert.match(deterministicQualifier, /"test:evals"/u);
  assert.match(deterministicQualifier, /"semantic-v2-static-lint"/u);
  assert.match(deterministicQualifier, /"lint:v2"/u);
  assert.match(deterministicQualifier, /"physical-staging-contract"/u);
  assert.match(deterministicQualifier, /--require-project-ref/u);
  assert.match(deterministicQualifier, /analyticalProjectRef/u);
  assert.match(deterministicQualifier, /unresolvedRelationships\.length/u);
  assert.match(deterministicQualifier, /semantic_v2_publications/u);
  assert.match(
    deterministicQualifier,
    /SELECT publication_hash,artifact,source_draft_id,source_draft_revision/u,
  );
  assert.doesNotMatch(
    deterministicQualifier,
    /SELECT publication_hash,manifest\s+FROM control_plane\.semantic_v2_publications/u,
  );
  assert.match(deterministicQualifier, /expectedProfilePublication/u);
  assert.match(deterministicQualifier, /initial_manifest_hash/u);
  assert.match(
    deterministicQualifier,
    /verifySemanticProfileReceiptAttestationV2/u,
  );
  assert.match(deterministicQualifier, /semanticProfileReceiptDigestV2/u);
  assert.match(deterministicQualifier, /maximumTargetMatches/u);
  assert.match(deterministicQualifier, /duplicateTargetKeyGroups/u);
  assert.match(deterministicQualifier, /profileCoverageComplete/u);
  assert.match(
    deterministicQualifier,
    /must cite exactly one valid profile receipt/u,
  );
  assert.match(
    deterministicQualifier,
    /canonical repository artifact and manifest digest/u,
  );
});
