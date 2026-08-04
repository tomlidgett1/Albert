import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const analytical = readFileSync(
  "infra/migrations/analytical/0085_m4_m5_quarantine_and_invariant_recovery.sql","utf8",
);
const canonicalHardening = readFileSync(
  "infra/migrations/analytical/0088_m4_canonical_record_hardening.sql","utf8",
);
const canonicalLineageRepair = readFileSync(
  "infra/migrations/analytical/0105_m4_immutable_canonical_quarantine_lineage.sql","utf8",
);
const immutableTransformInput = readFileSync(
  "infra/migrations/analytical/0106_m4_immutable_transform_staging_envelopes.sql","utf8",
);
const control = readFileSync(
  "infra/migrations/control-plane/0044_m2_quarantine_replay_recovery.sql","utf8",
);
const landing = readFileSync("services/sync-workers/src/analytical-store.ts","utf8");
const worker = readFileSync("services/sync-workers/src/worker.ts","utf8");
const canonicalPipeline = readFileSync("services/sync-workers/src/canonical-pipeline.ts","utf8");

test("valid replay healing is durable in both cells and idempotent across a crash", () => {
  assert.match(landing,/update ingestion\.quarantine_records[\s\S]*status='resolved'[\s\S]*resolution_reason='validated_replay'/iu);
  assert.match(landing,/replayed_in_sync_run_id=\$5/iu);
  assert.match(landing,/if \(committed\.rows\[0\]\)[\s\S]*existingResolutions/iu);
  assert.match(worker,/landing\.resolved\.length > 0[\s\S]*resolveQuarantineIndex/iu);
  assert.match(control,/UPDATE control_plane\.quarantine_items[\s\S]*status='resolved'/iu);
  assert.match(control,/quarantine\.status='open'/iu);
});

test("control quarantine healing is fenced to the exact active queue attempt", () => {
  assert.match(control,/assert_sync_write_permit_and_issue_capability/iu);
  assert.match(control,/sync_job_requests[\s\S]*request\.payload->>'stream'=p_stream/iu);
  assert.match(control,/jsonb_array_length\(p_resolutions\) NOT BETWEEN 1 AND 500/iu);
  assert.match(control,/count\(DISTINCT \([\s\S]*sourceObjectType[\s\S]*sourceRecordId/iu);
  assert.match(control,/GRANT EXECUTE ON FUNCTION control_plane\.resolve_quarantine_items[\s\S]*TO albert_sync_control/iu);
  assert.doesNotMatch(control,/GRANT (?:UPDATE|ALL)[\s\S]*quarantine_items[\s\S]*albert_sync_control/iu);
});

test("canonical quality measures exact authoritative coverage and full continuity", () => {
  assert.match(analytical,/observation\.relationship='authoritative'/iu);
  assert.match(analytical,/canonical_table='commerce_payment'/iu);
  assert.match(analytical,/canonical_table='commerce_refund_line'/iu);
  assert.match(analytical,/CASE WHEN missing_observations=0 THEN 'passed' ELSE 'failed'/iu);
  assert.match(analytical,/coverage,1,/iu);
  assert.match(analytical,/header_failures/iu);
  assert.match(analytical,/refund_reversal_link_failures/iu);
  assert.match(analytical,/missing_snapshot_days/iu);
  assert.match(analytical,/movement_balance_mismatches/iu);
});

test("canonical mapper quarantine is record-scoped, durable, and replay-healed", () => {
  assert.match(canonicalPipeline,/isolateCanonicalMappings\([\s\S]*for \(const row of rows\)[\s\S]*catch \(error\)/u);
  assert.match(canonicalPipeline,/isolateCanonicalProjectionReferences\([\s\S]*while \(accepted\.length\)/u);
  assert.match(canonicalPipeline,/recordCanonicalMappingQuarantines[\s\S]*commands\.sort/u);
  assert.match(canonicalPipeline,/recordCanonicalMappingQuarantines[\s\S]*jsonb_to_recordset\(\$6::jsonb\)/u);
  assert.match(canonicalPipeline,/input\.error_code,\$7::text,input\.error_summary/u);
  assert.match(canonicalPipeline,/resolveCanonicalMappingQuarantines\([\s\S]*projected\.accepted\.map/u);
  assert.match(canonicalPipeline,/quarantinedRows:rejectedRows\.length/u);
  assert.match(canonicalLineageRepair,/record_canonical_mapping_quarantine[\s\S]*ingestion\.batch_manifests[\s\S]*ingestion\.landing_commits/iu);
  assert.match(canonicalLineageRepair,/landing\.mapping_version=p_mapping_version[\s\S]*landing\.status='committed'/iu);
  assert.doesNotMatch(canonicalLineageRepair,/JOIN ingestion\.source_records/iu);
  assert.match(immutableTransformInput,/canonical_staging_batch_records[\s\S]*PRIMARY KEY \(tenant_id,batch_id,mapping_version,namespaced_source_key\)/iu);
  assert.match(immutableTransformInput,/record_canonical_mapping_quarantine[\s\S]*JOIN ingestion\.canonical_staging_batch_records/iu);
  assert.match(immutableTransformInput,/resolve_canonical_mapping_quarantine[\s\S]*resolution_reason='canonical_projection_recovered'/iu);
  const stagingLoader=canonicalPipeline.slice(
    canonicalPipeline.indexOf("async function loadStagingRows"),
    canonicalPipeline.indexOf("async function recordCanonicalMappingQuarantines"),
  );
  assert.match(stagingLoader,/from ingestion\.canonical_staging_batch_records/u);
  assert.match(stagingLoader,/select s\.\*,\$6::text as source_object_type/u);
  assert.doesNotMatch(stagingLoader,/ingestion\.source_records/u);
  assert.match(canonicalPipeline,/reprocessIdenticalPayloadOnNewBatch&&rows\.length!==landedRows/u);
  assert.match(canonicalHardening,/canonical_mapping_total[\s\S]*open_canonical_mapping_quarantine/iu);
  assert.match(landing,/error_code not like 'canonical\.%'/iu);
  assert.doesNotMatch(
    canonicalHardening,
    /GRANT (?:INSERT|UPDATE|DELETE|ALL)[\s\S]*ingestion\.quarantine_records[\s\S]*transform_rw/iu,
  );
});
