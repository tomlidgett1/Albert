import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import test from "node:test";
import type { ProbeHttpResponse, ProbeTransport } from "./src/probes.js";
import {
  isPrivateOrReserved,
  runLiveIdentityProbe,
  validatedDeputyHostname,
} from "./src/probes.js";
import { VendorConnectionAttestorService } from "./src/service.js";
import type { VendorAttestorClaim, VendorResultBinding } from "./src/contracts.js";

const digest = "a".repeat(64);
const now = "2026-08-04T01:00:00.000Z";

function claim(provider: VendorAttestorClaim["provider"], selectedExternalAccount: string): VendorAttestorClaim {
  return {
    schemaVersion: 1,
    challengeId: "01K1Z0F0W6A1B2C3D4E5F6G7H8",
    challengeNonceDigest: digest,
    journeyId: "01K1Z0F0W6A1B2C3D4E5F6G7H9",
    candidateSha: "b".repeat(40),
    deploymentId: "production-2026-08-04",
    tenantId: "01K1Z0F0W6A1B2C3D4E5F6G7HA",
    provider,
    connectionId: "01K1Z0F0W6A1B2C3D4E5F6G7HB",
    connectionGeneration: 3,
    selectedExternalAccount,
    selectedExternalAccountDigest: "c".repeat(64),
    credentialReferenceDigest: "d".repeat(64),
    tokenExpiresAt: "2026-08-04T02:00:00.000Z",
    issuedAt: "2026-08-04T00:59:30.000Z",
    expiresAt: "2026-08-04T01:01:30.000Z",
    claimedAt: "2026-08-04T00:59:40.000Z",
  };
}

function response(value: unknown, offset = 0): ProbeHttpResponse {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "x-request-id": `request-${offset}` },
    body: Buffer.from(JSON.stringify(value)),
    requestedAt: new Date(Date.parse(now) + offset).toISOString(),
    respondedAt: new Date(Date.parse(now) + offset + 20).toISOString(),
  };
}

test("fixed Xero proof calls connections then tenant-bound Organisation and retains only digests", async () => {
  const urls: string[] = [];
  const tenantHeaders: Array<string | undefined> = [];
  const bodies: Buffer[] = [];
  const transport: ProbeTransport = async (url, _token, headers) => {
    urls.push(url.toString());
    tenantHeaders.push(headers?.["xero-tenant-id"]);
    const result = urls.length === 1
      ? response([{ id: "connection-1", tenantId: "6e91a9e7-f5b2-45db-afe9-60bca7dc3075", tenantType: "ORGANISATION", tenantName: "Private name" }])
      : response({ Organisations: [{ OrganisationID: "b5afaa51-71c3-4d57-9af3-602c7d66ab2d", Name: "Private name" }] }, 30);
    bodies.push(result.body);
    return result;
  };
  const outcome = await runLiveIdentityProbe(
    claim("xero", "6e91a9e7-f5b2-45db-afe9-60bca7dc3075"),
    Buffer.from("short-lived-access-token"), transport,
  );
  assert.equal(outcome.status, "passed");
  assert.deepEqual(urls, [
    "https://api.xero.com/connections",
    "https://api.xero.com/api.xro/2.0/Organisation",
  ]);
  assert.deepEqual(tenantHeaders, [undefined, "6e91a9e7-f5b2-45db-afe9-60bca7dc3075"]);
  assert.deepEqual(outcome.probeEvidence.map((item) => item.endpointId), [
    "xero.connections.v1", "xero.accounting.organisation.v2",
  ]);
  assert.ok(outcome.probeEvidence.every((item) => /^[a-f0-9]{64}$/u.test(item.bodyDigest)));
  assert.ok(bodies.every((body) => body.every((byte) => byte === 0)), "response buffers must be zeroed");
  assert.equal(JSON.stringify(outcome).includes("Private name"), false);
});

test("Lightspeed R and Deputy proofs are pinned to their documented identity endpoints", async () => {
  const observed: string[] = [];
  const transport: ProbeTransport = async (url) => {
    observed.push(url.toString());
    return url.hostname === "api.lightspeedapp.com"
      ? response({ Account: [{ accountID: "42", name: "Private shop" }] })
      : response({ Id: 77, DisplayName: "Private user" });
  };
  assert.equal((await runLiveIdentityProbe(
    claim("lightspeed-r", "42"), Buffer.from("token"), transport,
  )).status, "passed");
  assert.equal((await runLiveIdentityProbe(
    claim("deputy", "sample.au.deputy.com"), Buffer.from("token"), transport,
  )).status, "passed");
  assert.deepEqual(observed, [
    "https://api.lightspeedapp.com/API/V3/Account.json",
    "https://sample.au.deputy.com/api/v1/me",
  ]);
  assert.throws(() => validatedDeputyHostname("127.0.0.1"), /allowlist/u);
  assert.throws(() => validatedDeputyHostname("sample.au.deputy.com.evil.test"), /allowlist/u);
  assert.equal(isPrivateOrReserved("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateOrReserved("::ffff:7f00:1"), true);
  assert.equal(isPrivateOrReserved("::ffff:8.8.8.8"), false);
});

test("attestor signs the DB-canonical digest, proves admission possession, and zeroes token bytes", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const admissionKey = Buffer.alloc(32, 7);
  const token = Buffer.from("the-only-access-token");
  let completed: Readonly<{
    binding: VendorResultBinding;
    digest: string;
    signature: string;
    admissionMac: string;
  }> | undefined;
  const store = {
    claim: async () => claim("lightspeed-r", "42"),
    prepare: async (_challengeId: string, binding: VendorResultBinding) =>
      createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
    complete: async (_challengeId: string, binding: VendorResultBinding, resultDigest: string, signature: string, admissionMac: string) => {
      completed = { binding, digest: resultDigest, signature, admissionMac };
      return { status: "passed", resultDigest };
    },
  };
  const service = new VendorConnectionAttestorService({
    store,
    signingKey: privateKey,
    keyId: `ed25519:${"e".repeat(64)}`,
    toolRef: `trust/albert-vendor-attestor@${"f".repeat(40)}`,
    buildDigest: `sha256:${"1".repeat(64)}`,
    admissionHmacKey: admissionKey,
    transport: async () => response({ Account: { accountID: "42" } }),
  });
  await service.attest(claim("lightspeed-r", "42").challengeId, "n".repeat(43), token);
  assert.ok(completed);
  assert.equal(verify(null, Buffer.from(completed.digest, "hex"), publicKey, Buffer.from(completed.signature, "base64url")), true);
  assert.equal(completed.admissionMac,
    createHmac("sha256", admissionKey).update(Buffer.from(completed.digest, "hex")).digest("hex"));
  assert.ok(token.every((byte: number) => byte === 0), "incoming token buffer must be zeroed");
  assert.equal(JSON.stringify(completed.binding).includes("access-token"), false);
});
