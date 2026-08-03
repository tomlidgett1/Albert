import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("deletion revocation evidence carries the exact connection generation", async () => {
  const [migration, store, processor] = await Promise.all([
    readFile(new URL("../../infra/migrations/control-plane/0054_m3_m8_protected_dogfood_acceptance.sql", import.meta.url), "utf8"),
    readFile(new URL("../../services/deletion-worker/src/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/deletion-worker/src/processor.ts", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /'connectionGeneration',connection\.connection_generation/u);
  assert.match(store, /connectionGeneration: number/u);
  assert.match(store, /deletion_revocation_generation_invalid/u);
  assert.match(processor, /connectionGeneration: target\.connectionGeneration/u);
});

test("tenant proof residuals cover every analytical and cross-store class", async () => {
  const [analytical, control, processor] = await Promise.all([
    readFile(new URL("../../infra/migrations/analytical/0092_m8_granular_deletion_residual_attestation.sql", import.meta.url), "utf8"),
    readFile(new URL("../../infra/migrations/control-plane/0054_m3_m8_protected_dogfood_acceptance.sql", import.meta.url), "utf8"),
    readFile(new URL("../../services/deletion-worker/src/processor.ts", import.meta.url), "utf8"),
  ]);
  const analyticalKeys = [
    "stagingRows", "canonicalRows", "bridgeRows", "linkRows",
    "embeddingRows", "cacheRows", "otherAnalyticalRows",
  ];
  for (const key of analyticalKeys) {
    assert.match(analytical, new RegExp(`'${key}'`));
    assert.doesNotMatch(
      analytical,
      new RegExp(`'${key}'\\s*,\\s*0(?:\\D|$)`),
      `${key} must be a measured counter, not a proof-shaped literal zero.`,
    );
  }
  assert.match(analytical, /information_schema\.columns[\s\S]*connection_columns/u);
  assert.match(analytical, /SELECT count\(\*\) FROM %I\.%I AS residual/u);
  assert.match(analytical, /legacy_remaining>total[\s\S]*other_rows:=other_rows\+\(legacy_remaining-total\)/u);
  assert.match(analytical, /'measurement','post_purge_row_counts_v1'/u);
  assert.doesNotMatch(analytical, /RETURN base\|\|jsonb_build_object/u);
  assert.match(processor, /normalizeAnalyticalAttestation\(analytical, claim\)/u);
  assert.match(processor, /remainingRows !== residualTotal/u);
  assert.match(processor, /hasExactKeys\(value, analyticalAttestationKeys\)/u);
  assert.match(processor, /hasExactKeys\(residuals, analyticalResidualKeys\)/u);
  assert.match(control, /CREATE TRIGGER deletion_proofs_require_measured_analytical/u);
  assert.match(control, /require_privacy_safe_remote_revocation\(NEW\.remote_revocation\)/u);
  assert.match(control, /require_privacy_safe_deletion_stores\([\s\S]*NEW\.store_verification,NEW\.scope/u);
  assert.match(control, /jsonb_object_keys\(p_analytical->'residuals'\)\)<>7/u);
  assert.match(control, /jsonb_object_keys\(p_analytical\)\)<>5/u);
  assert.match(control, /REVOKE ALL ON FUNCTION[\s\S]*require_measured_analytical_deletion\(jsonb,text\)[\s\S]*albert_deletion_control/u);
  assert.match(control, /analytical,measurement[\s\S]*post_purge_row_counts_v1/u);
  assert.match(control, /analytical,remainingRows[\s\S]*jsonb_each_text\(p_stores#>'\{analytical,residuals\}'\)/u);
  for (const key of [
    "rawObjects", "controlRows", "derivedArtifacts", "queueMessages",
    "credentialReferences", "credentialEnvelopes", "sessionEnvelopes",
  ]) assert.match(control, new RegExp(`'${key}'`));
  assert.match(control, /deletion proof contains residual customer data/u);
  assert.match(processor, /normalizeRemoteRevocation\(await this\.revoker\.revoke\(claim\)\)/u);
  assert.match(processor, /normalizeCredentialVerification\(finalCredentialVault\)/u);
  assert.match(processor, /normalizeRawVerification\(rawStorage\)/u);
  assert.match(processor, /normalizeControlVerification\(controlPlane\)/u);
  assert.match(processor, /normalizeRawPurge\(rawPurge, claim\)/u);
  assert.match(processor, /normalizeAnalyticalPurge\(analyticalPurge, claim\)/u);
  assert.match(processor, /value\.reconciliationRowsRemoved/u);
  assert.match(processor, /normalizeControlPurge\(controlPurge, claim\)/u);
  assert.match(processor, /storesVerified: Object\.keys\(storeVerification\)\.length/u);
  assert.match(control, /jsonb_object_keys\(p_remote\)\) NOT IN \(5,7\)/u);
  assert.match(control, /jsonb_object_keys\(p_stores\)\)<>4/u);
  assert.match(processor, /remoteFailureClasses\.get\(errorCode\) !== errorClass/u);
  assert.match(control, /CREATE OR REPLACE FUNCTION control_plane\.record_deletion_progress[\s\S]*require_privacy_safe_deletion_progress/u);
  assert.match(control, /CREATE OR REPLACE FUNCTION control_plane\.destroy_claimed_deletion_credentials[\s\S]*require_privacy_safe_remote_revocation/u);
  assert.match(control, /remote revocation targets do not match the deletion scope/u);
  assert.match(control, /EXCEPT ALL/u);
  assert.match(control, /credential_destroyed_at IS NOT NULL[\s\S]*prior_remote IS DISTINCT FROM p_remote_revocation[\s\S]*RETURN request_row\.credential_destroyed_at/u);
  assert.match(processor, /context\.targets\.length === 0[\s\S]*return normalizeRemoteRevocation\(priorRemote\)/u);
  assert.match(processor, /forcedLocalDestruction: true[\s\S]*remote_revocation_grace_expired/u);
  assert.match(control, /remote revocation progress is immutable after credential destruction/u);
  assert.match(control, /request\.progress->'remote_revocation'[\s\S]*expected_remote IS DISTINCT FROM NEW\.remote_revocation/u);
  assert.match(control, /p_stage='raw_storage'[\s\S]*jsonb_object_keys\(p_evidence\)\)<>2/u);
  assert.match(control, /service_version<>p_candidate_sha/u);
  assert.match(control, /target->>'provider' IN \('lightspeed-r','xero'\).*target->>'status'<>'succeeded'/su);
});
