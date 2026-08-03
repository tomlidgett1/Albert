import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const security = await import("../packages/security/src/index.ts");

test("credential envelopes require matching associated data", async () => {
  const key = security.bytesToBase64Url(webcrypto.getRandomValues(new Uint8Array(32)));
  const envelope = await security.sealSecret({
    plaintext: "refresh-token",
    encodedKey: key,
    keyId: "key-2026-08",
    associatedData: "tenant-1/connection-1",
  });
  assert.equal(await security.openSecret({ envelope, encodedKey: key, associatedData: "tenant-1/connection-1" }), "refresh-token");
  await assert.rejects(
    security.openSecret({ envelope, encodedKey: key, associatedData: "tenant-2/connection-1" }),
  );
});

test("signed payloads reject expiry and nonce substitution", async () => {
  const secret = "a-signing-secret-that-is-longer-than-thirty-two-bytes";
  const payload = { issuedAt: 1_000, expiresAt: 2_000, nonce: "nonce", tenantId: "tenant" };
  const token = await security.signPayload(payload, secret);
  assert.deepEqual(
    await security.verifySignedPayload(token, secret, { now: 1_500, expectedNonce: "nonce" }),
    payload,
  );
  await assert.rejects(security.verifySignedPayload(token, secret, { now: 2_001 }));
  await assert.rejects(security.verifySignedPayload(token, secret, { now: 1_500, expectedNonce: "other" }));
});

test("internal request signatures bind method, path, body, and timestamp", async () => {
  const secret = "an-internal-signing-secret-long-enough-for-production";
  const body = JSON.stringify({ tenantId: "01" });
  const headers = await security.signInternalRequest({
    method: "POST",
    path: "/v1/sync",
    body,
    secret,
    timestamp: 1_000,
  });
  assert.equal(await security.verifyInternalRequest({
    method: "POST",
    path: "/v1/sync",
    body,
    secret,
    timestamp: headers[security.INTERNAL_TIMESTAMP_HEADER],
    signature: headers[security.INTERNAL_SIGNATURE_HEADER],
    now: 1_500,
  }), true);
  assert.equal(await security.verifyInternalRequest({
    method: "POST",
    path: "/v1/sync",
    body: "{}",
    secret,
    timestamp: headers[security.INTERNAL_TIMESTAMP_HEADER],
    signature: headers[security.INTERNAL_SIGNATURE_HEADER],
    now: 1_500,
  }), false);
});
