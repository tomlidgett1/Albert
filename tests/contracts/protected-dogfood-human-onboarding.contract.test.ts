import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("protected onboarding binds one browser continuity nonce at claim and receipt", async () => {
  const [migration, repository, claimRoute, receiptRoute, ui] = await Promise.all([
    read("infra/migrations/control-plane/0065_m7_nonce_bound_human_onboarding_acceptance.sql"),
    read("services/control-plane/src/protected-dogfood-onboarding-repository.ts"),
    read("app/api/acceptance/onboarding/claim/route.ts"),
    read("app/api/acceptance/onboarding/receipt/route.ts"),
    read("app/dash/acceptance/protected-onboarding-acceptance.tsx"),
  ]);

  assert.doesNotMatch(migration, /auth\.uid\(\)/u);
  assert.match(migration, /DECLARE actor uuid:=extensions\.albert_auth_uid\(\)/u);
  assert.match(migration, /claim\.browser_nonce_hash IS DISTINCT FROM p_browser_nonce_hash/u);
  assert.match(migration, /claim\.user_agent_hash IS DISTINCT FROM p_user_agent_hash/u);
  assert.match(migration, /receipt\.browser_nonce_hash IS DISTINCT FROM claim\.browser_nonce_hash/u);
  assert.match(migration, /receipt\.user_agent_hash IS DISTINCT FROM claim\.user_agent_hash/u);
  assert.match(migration, /public\.albert_claim_protected_dogfood_onboarding_journey\(text,text,text,text\)/u);

  assert.match(claimRoute, /browserNonce: z\.string\(\)\.regex/u);
  assert.match(claimRoute, /userAgent: request\.headers\.get\("user-agent"\)/u);
  assert.match(receiptRoute, /browserNonce: z\.string\(\)\.regex/u);
  assert.match(repository, /p_browser_nonce_hash: await sha256\(parsed\.browserNonce\)/u);
  assert.match(repository, /p_user_agent_hash: await sha256\(parsed\.userAgent\)/u);

  const nonceGeneration = ui.indexOf("const continuityNonce = browserNonce()");
  const claimFetch = ui.indexOf('fetch("/api/acceptance/onboarding/claim"');
  assert.ok(nonceGeneration >= 0 && nonceGeneration < claimFetch, "continuity nonce must exist before claim");
  assert.match(ui, /body: JSON\.stringify\(\{ journeyId, code, browserNonce: continuityNonce \}\)/u);
  assert.match(ui, /sessionStorage\.setItem\(storageKey\(journey\.journeyId\), JSON\.stringify\(journey\)\)/u);
  assert.match(ui, /body: JSON\.stringify\(\{ journeyId, browserNonce: stored\.browserNonce \}\)/u);
  assert.doesNotMatch(ui, /sessionStorage\.(?:setItem|removeItem)\([^\n]*code/iu);
  assert.doesNotMatch(ui, /browser signature/iu);
});

test("M7 seals exact OAuth, recent-domain readiness, and independent live-vendor proof", async () => {
  const [migration, worker, collector, schema] = await Promise.all([
    read("infra/migrations/control-plane/0065_m7_nonce_bound_human_onboarding_acceptance.sql"),
    read("services/sync-workers/src/control-plane-store.ts"),
    read("scripts/collect-dogfood-acceptance.mjs"),
    read("scripts/dogfood-acceptance-attestation.mjs"),
  ]);

  assert.match(migration, /coordinator_job_request_id/u);
  assert.match(migration, /coordinator_sync_run_id/u);
  assert.match(migration, /coordinator_batch_id/u);
  assert.match(worker, /job\.jobRequestId,[\s\S]*job\.syncRunId,[\s\S]*job\.batchId/u);
  assert.match(migration, /VALUES \('lightspeed-r','sales'\),\('lightspeed-r','inventory'\),[\s\S]*\('deputy','workforce'\),\('xero','accounting'\)/u);
  assert.match(migration, /readiness\.data_ready_through>=binding\.range_to/u);
  assert.match(migration, /coverage\.status IS DISTINCT FROM 'queryable'/u);
  assert.match(migration, /transform\.status IS DISTINCT FROM 'succeeded'/u);
  assert.match(migration, /readinessBindingDigest/u);

  assert.match(migration, /consume_live_vendor_connection_attestations\(text,text,text,text\)/u);
  assert.match(migration, /assert_consumed_live_vendor_connection_attestations\(text,text,text,text,text\)/u);
  assert.match(migration, /liveVendorAttestationProviderCount/u);
  const vendorConsume = migration.indexOf("consume_live_vendor_connection_attestations($1,$2,$3,$4)");
  const captureClock = migration.indexOf("captured:=clock_timestamp()", vendorConsume);
  const m7Capture = migration.indexOf("strong_m7:=control_plane.protected_dogfood_m7_journey_evidence", captureClock);
  assert.ok(vendorConsume >= 0 && vendorConsume < captureClock && captureClock < m7Capture,
    "capture time must be taken only after independent vendor evidence is consumed");
  assert.match(migration, /live_vendor_consumed_at>p_captured_at/u);
  assert.match(collector, /liveVendorAttestationConsumptionRef/u);
  assert.match(schema, /liveVendorAttestationProviderCount: z\.literal\(3\)/u);
  assert.match(schema, /M7 evidence digest is inconsistent with its signed content/u);
});

test("final consumption validates immutable evidence without rereading mutable projections", async () => {
  const migration = await read(
    "infra/migrations/control-plane/0065_m7_nonce_bound_human_onboarding_acceptance.sql",
  );
  const consume = migration.slice(
    migration.indexOf("CREATE FUNCTION control_plane.consume_protected_dogfood_acceptance("),
    migration.indexOf("REVOKE ALL ON TABLE", migration.indexOf(
      "CREATE FUNCTION control_plane.consume_protected_dogfood_acceptance(",
    )),
  );
  assert.match(consume, /protected_dogfood_acceptance_snapshots/u);
  assert.match(consume, /claim\.claim_digest<>m7->>'claimDigest'/u);
  assert.match(consume, /assert_consumed_live_vendor_connection_attestations/u);
  assert.doesNotMatch(consume, /protected_dogfood_m7_journey_evidence\(/u);
  assert.doesNotMatch(consume, /FROM control_plane\.readiness/iu);
  assert.doesNotMatch(consume, /FROM control_plane\.tenant_overlays/iu);
});

test("operator issuance never publishes the raw code to workflow output", async () => {
  const [issuer, decryptor, workflow] = await Promise.all([
    read("scripts/issue-dogfood-onboarding-journey.mjs"),
    read("scripts/decrypt-dogfood-onboarding-journey.mjs"),
    read(".github/workflows/dogfood-onboarding-journey.yml"),
  ]);
  assert.match(issuer, /aes-256-gcm/u);
  assert.match(issuer, /RSA-OAEP-SHA256\+A256GCM/u);
  assert.match(issuer, /mode: 0o600/u);
  assert.doesNotMatch(issuer, /GITHUB_OUTPUT/u);
  assert.match(decryptor, /mode: 0o600/u);
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /recipient-encrypted/u);
  assert.doesNotMatch(workflow, /GITHUB_OUTPUT/u);
});
