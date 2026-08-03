import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
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

test("managed Supabase role updates fail closed without restating privileged attributes", async () => {
  const [upgrade, provisioner] = await Promise.all([
    readFile(new URL(
      "../../infra/bootstrap-upgrades/control-plane/0010_vendor_connection_attestor_authority.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../../scripts/provision-vendor-connection-attestor.ts", import.meta.url), "utf8"),
  ]);

  assert.match(upgrade, /existing vendor connection attestor role has unsafe attributes/u);
  assert.match(
    upgrade,
    /ALTER ROLE albert_vendor_connection_attestor NOLOGIN NOINHERIT;/u,
  );
  assert.doesNotMatch(
    upgrade,
    /ALTER ROLE albert_vendor_connection_attestor[^;]*(?:NOSUPERUSER|NOCREATEDB|NOCREATEROLE|NOREPLICATION|NOBYPASSRLS)/u,
  );
  assert.match(provisioner, /protected postgres will not rewrite a privileged role/u);
  assert.match(provisioner, /with nologin noinherit connection limit 4/u);
});
