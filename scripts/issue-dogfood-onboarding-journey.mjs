import assert from "node:assert/strict";
import {
  createCipheriv,
  createHash,
  createPublicKey,
  constants as cryptoConstants,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;

const SHA = /^[a-f0-9]{40}$/u;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

function required(source, name) {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required.`);
  return value;
}

function httpsUrl(value, label) {
  const url = new URL(value);
  assert.equal(url.protocol, "https:", `${label} must use HTTPS.`);
  assert.equal(url.username, "", `${label} must not contain credentials.`);
  assert.equal(url.password, "", `${label} must not contain credentials.`);
  assert.equal(url.search, "", `${label} must not contain a query.`);
  assert.equal(url.hash, "", `${label} must not contain a fragment.`);
  return url;
}

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is invalid.`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} shape is invalid.`);
}

function recipientPublicKey(encoded) {
  assert.match(encoded, BASE64URL, "Recipient public key must be base64url DER.");
  const der = Buffer.from(encoded, "base64url");
  assert.ok(der.length >= 256 && der.length <= 1_024, "Recipient public key length is invalid.");
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  assert.equal(key.asymmetricKeyType, "rsa", "Recipient key must be RSA.");
  assert.ok((key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2_048, "Recipient RSA key is too small.");
  return { key, der };
}

function encryptOperatorPayload(payload, encodedPublicKey) {
  const { key, der } = recipientPublicKey(encodedPublicKey);
  const dataKey = randomBytes(32);
  const nonce = randomBytes(12);
  const aad = Buffer.from("albert.protected-dogfood-onboarding-journey/v1", "utf8");
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  const encryptedKey = publicEncrypt({
    key,
    oaepHash: "sha256",
    padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
  }, dataKey);
  dataKey.fill(0);
  return Object.freeze({
    schemaVersion: 1,
    kind: "albert.protected-dogfood-onboarding-journey.encrypted",
    algorithm: "RSA-OAEP-SHA256+A256GCM",
    keyId: `rsa:${createHash("sha256").update(der).digest("hex")}`,
    encryptedKey: encryptedKey.toString("base64url"),
    nonce: nonce.toString("base64url"),
    authenticationTag: authenticationTag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

export async function issueProtectedOnboardingJourney(source = process.env) {
  const candidateSha = required(source, "ALBERT_DOGFOOD_CANDIDATE_SHA");
  const deploymentId = required(source, "ALBERT_DOGFOOD_DEPLOYMENT_ID");
  assert.match(candidateSha, SHA, "Candidate SHA must be a full lowercase commit SHA.");
  assert.match(deploymentId, DEPLOYMENT_ID, "Deployment id is invalid.");
  const publicOrigin = httpsUrl(required(source, "ALBERT_DOGFOOD_PUBLIC_ORIGIN"), "Public origin");
  assert.equal(publicOrigin.pathname, "/", "Public origin must not contain a path.");
  const rawCode = randomBytes(32).toString("base64url");
  assert.equal(rawCode.length, 43, "Generated journey code is invalid.");
  const nonceHash = createHash("sha256").update(rawCode, "utf8").digest("hex");
  const client = new Client({
    connectionString: required(source, "ALBERT_DOGFOOD_CONTROL_DATABASE_URL"),
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    application_name: "albert-protected-dogfood-onboarding-issuer",
  });
  let journey;
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE albert_operator_diagnostic_control");
    const result = await client.query(
      `SELECT control_plane.issue_protected_dogfood_onboarding_journey(
         $1::text,$2::text,$3::text,$4::integer
       ) AS journey`,
      [candidateSha, deploymentId, nonceHash, 5_400],
    );
    journey = result.rows[0]?.journey;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  exactKeys(
    journey,
    ["journeyId", "candidateSha", "deploymentId", "barrierAt", "issuedAt", "expiresAt"],
    "Journey",
  );
  assert.match(journey.journeyId, ULID, "Journey id is invalid.");
  assert.equal(journey.candidateSha, candidateSha, "Journey candidate differs.");
  assert.equal(journey.deploymentId, deploymentId, "Journey deployment differs.");
  assert.ok(Date.parse(journey.barrierAt) <= Date.parse(journey.issuedAt), "Journey predates deployment barrier.");
  assert.ok(Date.parse(journey.issuedAt) < Date.parse(journey.expiresAt), "Journey expiry is invalid.");
  const url = new URL("/dash/acceptance", publicOrigin);
  url.searchParams.set("journey", journey.journeyId);
  return encryptOperatorPayload({
    schemaVersion: 1,
    url: url.toString(),
    code: rawCode,
    candidateSha,
    deploymentId,
    issuedAt: journey.issuedAt,
    expiresAt: journey.expiresAt,
  }, required(source, "ALBERT_DOGFOOD_ONBOARDING_RECIPIENT_RSA_PUBLIC_KEY_BASE64URL"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputPath = process.argv[2];
  assert.ok(outputPath, "Issuer requires an encrypted output file path.");
  const encrypted = await issueProtectedOnboardingJourney();
  await writeFile(outputPath, `${JSON.stringify(encrypted)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write("protected onboarding journey issued; encrypted operator envelope created\n");
}
