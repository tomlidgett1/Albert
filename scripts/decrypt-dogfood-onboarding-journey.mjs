import assert from "node:assert/strict";
import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  constants as cryptoConstants,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function required(source, name) {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required.`);
  return value;
}

function exactKeys(value, keys) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Encrypted envelope is invalid.");
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "Encrypted envelope shape is invalid.");
}

export async function decryptProtectedOnboardingJourney(inputPath, outputPath, source = process.env) {
  const encodedPrivateKey = required(source, "ALBERT_DOGFOOD_ONBOARDING_RECIPIENT_RSA_PRIVATE_KEY_BASE64URL");
  assert.match(encodedPrivateKey, BASE64URL, "Recipient private key must be base64url DER.");
  const privateKey = createPrivateKey({
    key: Buffer.from(encodedPrivateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  assert.equal(privateKey.asymmetricKeyType, "rsa", "Recipient private key must be RSA.");
  const encrypted = JSON.parse(await readFile(inputPath, "utf8"));
  exactKeys(encrypted, [
    "schemaVersion", "kind", "algorithm", "keyId", "encryptedKey", "nonce",
    "authenticationTag", "ciphertext",
  ]);
  assert.equal(encrypted.schemaVersion, 1);
  assert.equal(encrypted.kind, "albert.protected-dogfood-onboarding-journey.encrypted");
  assert.equal(encrypted.algorithm, "RSA-OAEP-SHA256+A256GCM");
  for (const field of ["encryptedKey", "nonce", "authenticationTag", "ciphertext"]) {
    assert.match(encrypted[field], BASE64URL, `Encrypted ${field} is invalid.`);
  }
  const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  assert.equal(
    encrypted.keyId,
    `rsa:${createHash("sha256").update(publicDer).digest("hex")}`,
    "Encrypted journey targets another recipient.",
  );
  const dataKey = privateDecrypt({
    key: privateKey,
    oaepHash: "sha256",
    padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
  }, Buffer.from(encrypted.encryptedKey, "base64url"));
  assert.equal(dataKey.length, 32, "Encrypted journey data key is invalid.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    dataKey,
    Buffer.from(encrypted.nonce, "base64url"),
  );
  decipher.setAAD(Buffer.from("albert.protected-dogfood-onboarding-journey/v1", "utf8"));
  decipher.setAuthTag(Buffer.from(encrypted.authenticationTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final(),
  ]);
  dataKey.fill(0);
  const payload = JSON.parse(plaintext.toString("utf8"));
  plaintext.fill(0);
  exactKeys(payload, ["schemaVersion", "url", "code", "candidateSha", "deploymentId", "issuedAt", "expiresAt"]);
  assert.equal(payload.schemaVersion, 1);
  assert.match(payload.code, /^[A-Za-z0-9_-]{43}$/u, "Decrypted journey code is invalid.");
  const url = new URL(payload.url);
  assert.equal(url.protocol, "https:");
  assert.match(url.searchParams.get("journey") ?? "", /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.equal(url.searchParams.has("code"), false, "Journey code must never be in the URL.");
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2] && process.argv[3], "Decryptor requires encrypted input and new output paths.");
  await decryptProtectedOnboardingJourney(process.argv[2], process.argv[3]);
  process.stdout.write("protected onboarding journey decrypted to the requested mode-0600 file\n");
}
