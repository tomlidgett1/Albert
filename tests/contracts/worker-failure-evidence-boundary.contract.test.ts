import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SYNC_FAILURE_CODES } from "../../packages/queue/src/contracts.js";

const root=new URL("../../",import.meta.url);
const source=(path:string)=>readFile(new URL(path,root),"utf8");

test("worker failure SQL accepts exact allowlisted code-only documents",async()=>{
  const migration=await source(
    "infra/migrations/control-plane/0058_m2_code_only_worker_failure_evidence.sql",
  );
  const vocabulary=await source(
    "infra/migrations/control-plane/0102_m2_database_lock_timeout_failure_code.sql",
  );

  for(const code of SYNC_FAILURE_CODES){
    assert.match(`${migration}\n${vocabulary}`,new RegExp(`'${code}'`,"u"),`SQL allowlist is missing ${code}`);
  }
  for(const code of [
    "canonical_mapping_version_mismatch",
    "database_unavailable",
    "transform_internal_error",
    "transform_operation_timeout",
    "unexpected_transform_failure",
    "identity_projection_candidate_stale",
    "identity_projection_database_unavailable",
    "identity_projection_internal_error",
    "identity_projection_timeout",
    "unexpected_identity_projection_failure",
  ]){
    assert.match(migration,new RegExp(`'${code}'`,"u"),`SQL allowlist is missing ${code}`);
  }

  assert.match(migration,/worker_failure_document_has_exact_keys_0058[\s\S]*jsonb_object_keys/iu);
  assert.match(migration,/retry_or_fail_sync_job[\s\S]*ARRAY\['code','retryable'\][\s\S]*jsonb_typeof\(p_error->'retryable'\)<>'boolean'/iu);
  assert.match(migration,/defer_sync_job[\s\S]*ARRAY\['code'\][\s\S]*sync_failure_code_valid_0058/iu);
  assert.match(migration,/block_reconciliation_phase[\s\S]*NOT IN \('code','retryable','optional','attempt'\)[\s\S]*jsonb_typeof\(p_error->'attempt'\)<>'number'/iu);
  assert.match(migration,/mark_sync_stream_phase_unavailable[\s\S]*ARRAY\['code','retryable'\][\s\S]*capability_unavailable/iu);
  assert.doesNotMatch(migration,/p_(?:error|reason)->>'(?:detail|message|stack)'/iu);
  assert.match(vocabulary,/CREATE OR REPLACE FUNCTION control_plane\.sync_failure_code_valid_0058/u);
  assert.doesNotMatch(vocabulary,/message|detail|stack/iu);
});

test("validated wrappers preserve grants while implementations stay private",async()=>{
  const [migration,defaults,sqlTest,ci]=await Promise.all([
    source("infra/migrations/control-plane/0058_m2_code_only_worker_failure_evidence.sql"),
    source("infra/migrations/control-plane/0041_m0_default_deny_private_routines.sql"),
    source("tests/sql/control-plane-code-only-worker-failure-evidence.sql"),
    source(".github/workflows/ci.yml"),
  ]);

  for(const implementation of [
    "retry_or_fail_sync_job_unvalidated_0058",
    "defer_sync_job_unvalidated_0058",
    "block_reconciliation_phase_unvalidated_0058",
    "fail_identity_projection_unvalidated_0058",
    "retry_or_fail_transform_job_unvalidated_0058",
    "mark_stream_phase_unavailable_unvalidated_0058",
  ]){
    assert.match(migration,new RegExp(`RENAME TO ${implementation}`,"u"));
    assert.match(migration,new RegExp(`REVOKE ALL ON FUNCTION[\\s\\S]*${implementation}`,"u"));
    assert.match(sqlTest,new RegExp(implementation,"u"));
  }
  assert.match(migration,/GRANT EXECUTE ON FUNCTION[\s\S]*retry_or_fail_sync_job[\s\S]*TO albert_sync_control/iu);
  assert.match(migration,/GRANT EXECUTE ON FUNCTION[\s\S]*retry_or_fail_canonical_transform_job[\s\S]*TO albert_transform_control/iu);
  assert.match(migration,/has_function_privilege[\s\S]*private worker failure routine/iu);
  assert.match(defaults,/ALTER DEFAULT PRIVILEGES FOR ROLE albert_control_migration_owner[\s\S]*REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role/iu);
  assert.match(sqlTest,/free-text failure evidence[\s\S]*unknown failure code[\s\S]*SQLSTATE '55000'/iu);
  assert.match(ci,/control-plane-code-only-worker-failure-evidence\.sql/iu);
});

test("worker failure wrappers fail closed without schema-qualified COALESCE",async()=>{
  const correction=await source(
    "infra/migrations/control-plane/0059_m2_worker_failure_coalesce_runtime.sql",
  );

  for(const wrapper of [
    "retry_or_fail_sync_job",
    "defer_sync_job",
    "block_reconciliation_phase",
    "fail_identity_decision_projection",
    "retry_or_fail_canonical_transform_job",
    "mark_sync_stream_phase_unavailable",
  ]){
    assert.match(
      correction,
      new RegExp(`CREATE OR REPLACE FUNCTION control_plane\\.${wrapper}\\(`,"u"),
      `runtime correction is missing ${wrapper}`,
    );
  }
  assert.equal(
    correction.match(/IS DISTINCT FROM true/gu)?.length,
    10,
    "all nullable validation predicates must fail closed",
  );
  assert.doesNotMatch(correction,/pg_catalog\.coalesce/iu);
});
