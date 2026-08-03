import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import {
  DOGFOOD_SEED_OUTCOME_SUITE_DIGEST,
  DOGFOOD_SEED_OUTCOME_SUITE_VERSION,
  buildDogfoodSeedOutcomeManifestEvidence,
  validateDogfoodSeedObservedOutcomeEvidence,
} from "../evals/golden/seed-outcome-suite.mjs";
import { dogfoodSemanticPlanSchema, stableJson } from "./dogfood-acceptance-attestation.mjs";

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const MAX_LIFETIME_MS = 6 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} shape is invalid.`);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function decodeDer(value, kind) {
  assert.match(value ?? "", BASE64URL, `${kind} key must be base64url DER.`);
  const decoded = Buffer.from(value, "base64url");
  assert.ok(decoded.length >= 32 && decoded.length <= 256, `${kind} key DER length is invalid.`);
  assert.equal(decoded.toString("base64url"), value, `${kind} key encoding is not canonical.`);
  return decoded;
}

export function dogfoodReferenceKeyId(keyInput) {
  const publicKey = keyInput.type === "public" ? keyInput : createPublicKey(keyInput);
  assert.equal(publicKey.asymmetricKeyType, "ed25519", "Dogfood reference key must be Ed25519.");
  return `ed25519:${sha256(publicKey.export({ type: "spki", format: "der" }))}`;
}

function parseBody(input) {
  exactKeys(input, [
    "schemaVersion", "kind", "candidateSha", "semanticPlan", "semanticPlanDigest",
    "seedOutcomeManifest", "seedOutcomeEvidence", "seedOutcomeEvidenceDigest",
    "issuedAt", "expiresAt",
  ], "Dogfood reference plan");
  assert.equal(input.schemaVersion, 1, "Dogfood reference plan schema is invalid.");
  assert.equal(input.kind, "albert.dogfood-reference-plan", "Dogfood reference plan kind is invalid.");
  assert.match(input.candidateSha, COMMIT_SHA, "Dogfood reference-plan candidate SHA is invalid.");
  dogfoodSemanticPlanSchema.parse(input.semanticPlan);
  assert.match(input.semanticPlanDigest, SHA256, "Dogfood semantic plan digest is invalid.");
  assert.equal(input.semanticPlanDigest, sha256(input.semanticPlan), "Dogfood semantic plan digest is inconsistent.");
  const expectedManifest = buildDogfoodSeedOutcomeManifestEvidence();
  assert.deepEqual(input.seedOutcomeManifest, expectedManifest,
    "Dogfood reference plan does not contain the exact code-owned 25-case manifest.");
  assert.equal(input.seedOutcomeManifest.suiteVersion, DOGFOOD_SEED_OUTCOME_SUITE_VERSION);
  assert.equal(input.seedOutcomeManifest.suiteDigest, DOGFOOD_SEED_OUTCOME_SUITE_DIGEST);
  const seedOutcomeEvidence = validateDogfoodSeedObservedOutcomeEvidence(input.seedOutcomeEvidence);
  assert.match(input.seedOutcomeEvidenceDigest, SHA256, "Dogfood seed outcome evidence digest is invalid.");
  assert.equal(input.seedOutcomeEvidenceDigest, sha256(seedOutcomeEvidence),
    "Dogfood seed outcome evidence digest is inconsistent.");
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);
  assert.ok(Number.isFinite(issuedAt) && Number.isFinite(expiresAt), "Dogfood reference-plan time is invalid.");
  assert.ok(expiresAt > issuedAt && expiresAt - issuedAt <= MAX_LIFETIME_MS,
    "Dogfood reference-plan lifetime is invalid.");
  return Object.freeze(structuredClone(input));
}

export function signDogfoodReferencePlan(bodyInput, encodedPrivateKey) {
  dogfoodSemanticPlanSchema.parse(bodyInput.semanticPlan);
  const seedOutcomeEvidence = validateDogfoodSeedObservedOutcomeEvidence(bodyInput.seedOutcomeEvidence);
  const body = parseBody({
    schemaVersion: 1,
    kind: "albert.dogfood-reference-plan",
    candidateSha: bodyInput.candidateSha,
    semanticPlan: bodyInput.semanticPlan,
    semanticPlanDigest: sha256(bodyInput.semanticPlan),
    seedOutcomeManifest: buildDogfoodSeedOutcomeManifestEvidence(),
    seedOutcomeEvidence,
    seedOutcomeEvidenceDigest: sha256(seedOutcomeEvidence),
    issuedAt: bodyInput.issuedAt,
    expiresAt: bodyInput.expiresAt,
  });
  const privateKey = createPrivateKey({
    key: decodeDer(encodedPrivateKey, "Dogfood reference private"),
    format: "der",
    type: "pkcs8",
  });
  assert.equal(privateKey.asymmetricKeyType, "ed25519", "Dogfood reference private key must be Ed25519.");
  const signature = signBytes(null, Buffer.from(stableJson(body)), privateKey).toString("base64url");
  return Object.freeze({
    plan: body,
    signature: Object.freeze({ algorithm: "Ed25519", keyId: dogfoodReferenceKeyId(privateKey), value: signature }),
  });
}

export function verifyDogfoodReferencePlan(envelopeInput, options) {
  const envelope = typeof envelopeInput === "string" ? JSON.parse(envelopeInput) : envelopeInput;
  exactKeys(envelope, ["plan", "signature"], "Dogfood reference-plan envelope");
  const body = parseBody(envelope.plan);
  exactKeys(envelope.signature, ["algorithm", "keyId", "value"], "Dogfood reference-plan signature");
  assert.equal(envelope.signature.algorithm, "Ed25519", "Dogfood reference-plan signature algorithm is invalid.");
  assert.match(envelope.signature.value, BASE64URL, "Dogfood reference-plan signature is invalid.");
  const publicKey = createPublicKey({
    key: decodeDer(options?.encodedPublicKey, "Dogfood reference public"),
    format: "der",
    type: "spki",
  });
  assert.equal(publicKey.asymmetricKeyType, "ed25519", "Dogfood reference public key must be Ed25519.");
  const keyId = dogfoodReferenceKeyId(publicKey);
  assert.equal(envelope.signature.keyId, keyId, "Dogfood reference-plan signer is not trusted.");
  assert.notEqual(keyId, options.forbiddenDogfoodSignerKeyId,
    "Dogfood reference-plan authority must be separate from the acceptance signer.");
  assert.equal(verifyBytes(
    null,
    Buffer.from(stableJson(body)),
    publicKey,
    Buffer.from(envelope.signature.value, "base64url"),
  ), true, "Dogfood reference-plan signature is invalid.");
  assert.equal(body.candidateSha, options.candidateSha, "Dogfood reference plan is for another candidate.");
  const now = options.now ?? Date.now();
  assert.ok(Date.parse(body.issuedAt) <= now + CLOCK_SKEW_MS, "Dogfood reference plan is issued in the future.");
  assert.ok(Date.parse(body.expiresAt) > now, "Dogfood reference plan has expired.");
  const semanticPlan = dogfoodSemanticPlanSchema.parse(body.semanticPlan);
  return Object.freeze({
    referencePlanDigest: sha256(body),
    semanticPlan,
    semanticPlanDigest: body.semanticPlanDigest,
    seedOutcomeManifest: body.seedOutcomeManifest,
    seedOutcomeManifestDigest: sha256(body.seedOutcomeManifest),
    seedOutcomeEvidence: body.seedOutcomeEvidence,
    seedOutcomeEvidenceDigest: body.seedOutcomeEvidenceDigest,
    signerKeyId: keyId,
  });
}
