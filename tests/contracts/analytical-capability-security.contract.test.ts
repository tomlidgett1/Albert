import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadAnalyticalCapabilityProvisioningInput } from "../../scripts/provision-analytical-capability-key.js";

const baseEnvironment={
  CONTROL_PLANE_ADMIN_DATABASE_URL:"postgresql://postgres:secret@127.0.0.1:55439/control",
  ANALYTICAL_ADMIN_DATABASE_URL:"postgresql://postgres:secret@127.0.0.1:55440/analytical",
  ANALYTICAL_CAPABILITY_KEY_ID:"capability-2026-08",
  ANALYTICAL_CAPABILITY_SECRET_BASE64:Buffer.alloc(32,7).toString("base64"),
  ANALYTICAL_CAPABILITY_ACTIVE_AT:"2026-08-03T00:00:00.000Z",
  ANALYTICAL_CAPABILITY_RETIRE_AT:"2030-08-03T00:00:00.000Z",
} as const;

test("capability key input is canonical, dual-cell by default, and rotation is explicit",()=>{
  const input=loadAnalyticalCapabilityProvisioningInput(
    baseEnvironment as unknown as NodeJS.ProcessEnv,
    [],
  );
  assert.equal(input.target,"both");
  assert.equal(input.keyId,"capability-2026-08");
  assert.throws(()=>loadAnalyticalCapabilityProvisioningInput({
    ...baseEnvironment,
    ANALYTICAL_CAPABILITY_SECRET_BASE64:"not-a-key",
  } as unknown as NodeJS.ProcessEnv,[]),/canonical padded base64/);
  assert.throws(()=>loadAnalyticalCapabilityProvisioningInput({
    ...baseEnvironment,
    ANALYTICAL_CAPABILITY_PREVIOUS_KEY_ID:"old-key",
  } as unknown as NodeJS.ProcessEnv,[]),/provided together/);
  assert.equal(loadAnalyticalCapabilityProvisioningInput(
    baseEnvironment as unknown as NodeJS.ProcessEnv,
    ["--target=analytical"],
  ).target,"analytical");
});

test("runtime tenant scope is signed, audience-bound, exact-login, and deletion tokens are one-use",async()=>{
  const [control,analytical,ingest,transform,semanticMetadata]=await Promise.all([
    readFile(new URL("../../infra/migrations/control-plane/0038_m0_m8_signed_analytical_capabilities.sql",import.meta.url),"utf8"),
    readFile(new URL("../../infra/migrations/analytical/0083_m0_m8_signed_tenant_capability_enforcement.sql",import.meta.url),"utf8"),
    readFile(new URL("../../services/sync-workers/src/analytical-store.ts",import.meta.url),"utf8"),
    readFile(new URL("../../services/sync-workers/src/canonical-pipeline.ts",import.meta.url),"utf8"),
    readFile(new URL("../../services/semantic-query/src/postgres-adapters.ts",import.meta.url),"utf8"),
  ]);
  assert.match(control,/extensions\.hmac\(convert_to\(payload::text,'utf8'\),key_row\.secret,'sha256'\)/);
  assert.match(control,/session_user::name IS DISTINCT FROM p_login/);
  assert.match(control,/connection_generation=job\.connection_generation/);
  assert.match(control,/assert_sync_write_permit_and_issue_capability[\s\S]*FOR SHARE OF request,attempt,run,connection,tenant/);
  assert.match(control,/issue_deletion_analytical_capability[\s\S]*require_active_deletion_lease/);
  assert.match(control,/p_scope NOT IN \('deletion_purge','deletion_verify'\)[\s\S]*issuance is fenced by tenant deletion/);
  assert.match(analytical,/CASE session_user[\s\S]*albert_ingest_runtime[\s\S]*albert_deletion_analytical_runtime/);
  assert.match(analytical,/payload->>'audience' IS DISTINCT FROM binding\.audience/);
  assert.match(analytical,/consumed_deletion_nonces[\s\S]*EXCEPTION WHEN unique_violation/);
  assert.match(analytical,/tenant_revocation_watermarks[\s\S]*issued_epoch<=watermark\.revoked_through_epoch/);
  assert.match(analytical,
    /REVOKE ALL ON FUNCTION[\s\S]*deletion_internal\.purge_connection\(text,text\)[\s\S]*deletion_internal\.verify_tenant\(text\)[\s\S]*FROM PUBLIC/,
    "Capability-wrapped deletion entry points must never retain default PUBLIC execution.");
  assert.match(analytical,
    /ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA deletion_internal[\s\S]*REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/,
    "Future deletion security-definer functions must default private.");
  assert.equal(
    (analytical.match(/PERFORM capability_internal\.record_tenant_revocation\(p_tenant_id\)/g)??[]).length,
    2,
  );
  assert.doesNotMatch(
    analytical,
    /WHEN 'albert_(?:ingest|transform|semantic|operator|deletion)[^']*'[\s\S]{0,300}current_setting\('albert\.tenant_id'/,
  );
  const analyticalDeletionFence=/pg_advisory_xact_lock_shared\(hashtextextended\('deletion:'\|\|\$1,0\)\)/;
  assert.match(ingest,analyticalDeletionFence);
  assert.match(transform,analyticalDeletionFence);
  assert.match(semanticMetadata,analyticalDeletionFence);
});

test("release installs security state after migration and before any service deployment",async()=>{
  const release=await readFile(new URL("../../.github/workflows/release.yml",import.meta.url),"utf8");
  const bootstrap=release.indexOf("\n  upgrade-control-bootstrap:");
  const migrate=release.indexOf("\n  migrate:");
  const provision=release.indexOf("\n  provision-runtime-security:");
  const registry=release.indexOf("\n  publish-semantic-registry:");
  const deploy=release.indexOf("\n  deploy-services:");
  assert.ok(bootstrap>-1&&migrate>bootstrap&&provision>migrate&&registry>provision&&deploy>registry);
  assert.match(release,/provision:runtime-logins[\s\S]*provision:analytical-capability-key[\s\S]*provision:webhook-attestation-key/);
  assert.match(release,/ANALYTICAL_CAPABILITY_SECRET_BASE64: \$\{\{ secrets\.ANALYTICAL_CAPABILITY_SECRET_BASE64 \}\}/);
  assert.doesNotMatch(release,/--target=(?:control-plane|analytical)[\s\S]*provision:analytical-capability-key/);
});

test("every analytical runtime fails readiness closed without the shared keyring",async()=>{
  const sources=await Promise.all([
    readFile(new URL("../../services/sync-workers/src/main.ts",import.meta.url),"utf8"),
    readFile(new URL("../../services/transform-worker/src/main.ts",import.meta.url),"utf8"),
    readFile(new URL("../../services/semantic-query/src/composition.ts",import.meta.url),"utf8"),
    readFile(new URL("../../services/deletion-worker/src/store.ts",import.meta.url),"utf8"),
    readFile(new URL("../../services/operator-diagnostic/src/database.ts",import.meta.url),"utf8"),
  ]);
  for(const source of sources){
    assert.match(source,/assert_(?:analytical_capability_issuer_ready|verifier_ready)|assertReady|preflight/u);
  }
});
