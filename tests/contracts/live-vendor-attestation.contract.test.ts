import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

function functionBody(sql: string, qualifiedName: string): string {
  const declaration = sql.indexOf(`CREATE FUNCTION ${qualifiedName}`);
  assert.ok(declaration >= 0, `missing ${qualifiedName}`);
  const opening = sql.indexOf("AS $$", declaration);
  const closing = sql.indexOf("$$;", opening + 5);
  assert.ok(opening >= 0 && closing > opening, `malformed ${qualifiedName}`);
  return sql.slice(opening + 5, closing);
}

test("administrator hand-off exact-pins every independent evidence capability once", async () => {
  const [bootstrap, migration, onboarding] = await Promise.all([
    read("infra/bootstrap-upgrades/control-plane/0010_vendor_connection_attestor_authority.sql"),
    read("infra/migrations/control-plane/0067_m7_independent_live_vendor_attestation.sql"),
    read("infra/migrations/control-plane/0065_m7_nonce_bound_human_onboarding_acceptance.sql"),
  ]);
  const functions = [
    [migration, "control_plane.issue_live_vendor_connection_attestation", "845ed1031cc95ae5718c7a7f2cc24f5ce03efaac8aa4f12a0a4483f14807bce7"],
    [migration, "control_plane.claim_live_vendor_attestation_relay", "4ffdf5882b0d776301d14121bbe21de62a04cef460f3ba2f5dad3e57f26cbd68"],
    [migration, "control_plane.claim_live_vendor_connection_attestation", "25a9deb323151eac030a97ddae805f09d003ae2279d87f703d64596721e91a98"],
    [migration, "control_plane.prepare_live_vendor_connection_attestation_result", "1c6ddd56c6c39d7f6b4c5d37d05b1ca44200dd806b6aeee7a07aa5a1957a7707"],
    [migration, "control_plane.complete_live_vendor_connection_attestation", "532905bfcd799801631a6f42bd43b7d2ee12cc858553d9311c83750a89af0623"],
    [migration, "control_plane.live_vendor_connection_attestation_status", "9eec362e0f7431f045594400a6e57bcd75a3e44530de34a0c2da0f1f2d2d29bd"],
    [migration, "control_plane.consume_live_vendor_connection_attestations", "5c2b13b714995c33607e5a07422014495399a4c19bd2425d28af576b5776a992"],
    [migration, "control_plane.assert_consumed_live_vendor_connection_attestations", "755f3fec5a7b60af75213203588b1927c2b318355ce35b7ea5229e7c8400ca2e"],
    [migration, "control_plane.assert_live_vendor_attestation_boundary_ready", "530e787d7d006e81a4a723940c3908f729368df7e41f4263cae24828ed59315f"],
    [onboarding, "control_plane.capture_protected_dogfood_acceptance", "c1d138a2b42f878c92ba2541579215e161d87e781bca210b3693d7635a24dd56"],
    [onboarding, "control_plane.consume_protected_dogfood_acceptance", "b0ecce21a200bab095aaee1f6f231f229786703ba14a627ba7385aef1a301503"],
  ] as const;
  for (const [source, name, expected] of functions) {
    const actual = createHash("sha256").update(functionBody(source, name)).digest("hex");
    assert.equal(actual, expected, `${name} changed without protected bootstrap review`);
    assert.match(bootstrap, new RegExp(expected, "u"));
  }
  assert.match(bootstrap, /albert_vendor_attestor_boundary_state/u);
  assert.match(bootstrap, /FOR UPDATE;[\s\S]*already finalized/u);
  assert.match(bootstrap, /contract_digest='f42b873c652f097a00f4feb730378b2f5030e8eb2b6f36ee590c936c5e915b24'/u);
  assert.match(bootstrap, /TRUNCATE TABLE[\s\S]*ALTER TABLE control_plane\.live_vendor_attestation_challenges OWNER TO postgres/u);
  assert.match(bootstrap, /capture_protected_dogfood_acceptance\([\s\S]*\) OWNER TO postgres/u);
  assert.match(bootstrap, /REVOKE ALL ON FUNCTION extensions\.albert_finalize_vendor_attestation_boundary\(\)/u);
});

test("live probes, relay, collector, and M7 consumption form one real fail-closed path", async () => {
  const [migration, probes, relay, server, collector, runtime, workflow, ci] = await Promise.all([
    read("infra/migrations/control-plane/0067_m7_independent_live_vendor_attestation.sql"),
    read("services/vendor-connection-attestor/src/probes.ts"),
    read("services/sync-workers/src/vendor-attestation-relay.ts"),
    read("services/vendor-connection-attestor/src/node-server.ts"),
    read("scripts/collect-dogfood-acceptance.mjs"),
    read("deploy/runtime-contract.json"),
    read(".github/workflows/vendor-connection-attestor.yml"),
    read(".github/workflows/ci.yml"),
  ]);
  assert.match(migration, /expires_at=issued_at\+interval '2 minutes'/u);
  assert.match(migration, /p_provider NOT IN \('lightspeed-r','xero','deputy'\)/u);
  assert.match(migration, /admission_hmac_key/u);
  assert.match(migration, /provider_count<>3/u);
  assert.match(probes, /https:\/\/api\.xero\.com\/connections/u);
  assert.match(probes, /api\.xro\/2\.0\/Organisation/u);
  assert.match(probes, /https:\/\/api\.lightspeedapp\.com\/API\/V3\/Account\.json/u);
  assert.match(probes, /api\/v1\/me/u);
  assert.match(relay, /credential\.secret\.accessToken/u);
  assert.doesNotMatch(relay, /credential\.secret\.refreshToken/u);
  assert.match(relay, /path: "\/readyz", method: "GET"/u);
  assert.match(relay, /expectedToolRef/u);
  assert.match(server, /request\.method === "GET" && path === "\/readyz"/u);
  const issueAt = collector.indexOf("completeLiveVendorAttestations(config)");
  const captureAt = collector.indexOf("captureControlEvidence(config)", issueAt);
  assert.ok(issueAt >= 0 && captureAt > issueAt);
  assert.match(collector, /Independent live vendor attestations did not complete before expiry/u);
  assert.match(runtime, /ALBERT_VENDOR_ATTESTOR_EXPECTED_TOOL_REF/u);
  assert.match(runtime, /ALBERT_VENDOR_ATTESTOR_EXPECTED_BUILD_DIGEST/u);
  assert.match(workflow, /GITHUB_WORKFLOW_REF/u);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT/u);
  assert.match(workflow, /tagObject\.tagger\?\.email/u);
  assert.match(workflow, /environment\.can_admins_bypass/u);
  assert.match(workflow, /secrets\.ALBERT_GITHUB_CONFIGURATION_AUDIT_TOKEN/u);
  assert.match(workflow, /Object\.hasOwn\(creationRulesets\[0\], "bypass_actors"\)/u);
  assert.match(workflow, /ALBERT_VENDOR_ATTESTOR_TAG_SIGNER_EMAIL/u);
  assert.match(workflow, /vendor-attestor-v\*/u);
  assert.match(workflow, /TAG_ISSUER_APP_ID/u);
  for (const rule of ["creation", "update", "deletion"]) {
    assert.match(workflow, new RegExp(`"${rule}"`, "u"));
  }
  assert.match(workflow, /docker buildx imagetools inspect/u);
  assert.match(ci, /provision:vendor-connection-attestor/u);
  assert.match(ci, /control-plane-live-vendor-attestation-boundary\.sql/u);
  assert.match(ci, /control-plane-live-vendor-attestation-runtime\.sql/u);
});
