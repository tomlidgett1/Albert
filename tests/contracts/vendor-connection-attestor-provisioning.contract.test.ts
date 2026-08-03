import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { parseVendorAttestorPublicKey } from "../../scripts/provision-vendor-connection-attestor.js";

test("vendor attestor provisioner parses a real Ed25519 SPKI DER key and derives its pinned id", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const exported = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const material = parseVendorAttestorPublicKey(exported.toString("base64"));

  assert.deepEqual(material.publicKeyDer, exported);
  assert.match(material.keyId, /^ed25519:[a-f0-9]{64}$/u);
  assert.throws(
    () => parseVendorAttestorPublicKey("not-base64"),
    /canonical padded base64/u,
  );

  const { publicKey: rsaPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaDer = Buffer.from(rsaPublicKey.export({ format: "der", type: "spki" }));
  assert.throws(
    () => parseVendorAttestorPublicKey(rsaDer.toString("base64")),
    /must be Ed25519/u,
  );
});
