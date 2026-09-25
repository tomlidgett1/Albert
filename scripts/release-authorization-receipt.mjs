import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./create-release-plan.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const DIGITS = /^[1-9][0-9]{0,19}$/u;
const AUTHORITY_REF = /^refs\/tags\/albert-release-authority-v[1-9][0-9]*(?:\.[0-9]+){0,2}$/u;
const IMAGE = /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.\/-]+@sha256:[a-f0-9]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const MAX_LIFETIME_MS = 6 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} shape is invalid.`);
}

function decodeDer(value, kind) {
  assert.match(value ?? "", /^[A-Za-z0-9_-]+$/u, `${kind} key must be base64url DER.`);
  const decoded = Buffer.from(value, "base64url");
  assert.ok(decoded.length >= 32 && decoded.length <= 256, `${kind} key DER length is invalid.`);
  assert.equal(decoded.toString("base64url"), value, `${kind} key must use canonical base64url encoding.`);
  return decoded;
}

function keyId(keyInput) {
  const publicKey = keyInput.type === "public" ? keyInput : createPublicKey(keyInput);
  assert.equal(publicKey.asymmetricKeyType, "ed25519", "Release authorisation key must be Ed25519.");
  return `ed25519:${sha256(publicKey.export({ type: "spki", format: "der" }))}`;
}

export function parseReleasePlan(input) {
  const plan = typeof input === "string" ? JSON.parse(input) : input;
  exactKeys(plan, [
    "schemaVersion", "kind", "repository", "authority", "candidate", "evidence",
    "verification", "release", "planDigest",
  ], "Release plan");
  assert.equal(plan.schemaVersion, 3, "Release plan schema is invalid.");
  assert.equal(plan.kind, "albert.production-release-plan", "Release plan kind is invalid.");
  assert.match(plan.planDigest, SHA256, "Release plan digest is invalid.");
  const withoutDigest = { ...plan };
  delete withoutDigest.planDigest;
  assert.equal(plan.planDigest, sha256(canonicalJson(withoutDigest)), "Release plan digest is inconsistent.");
  assert.match(plan.authority?.sha ?? "", COMMIT_SHA, "Release plan authority SHA is invalid.");
  assert.match(plan.authority?.ref ?? "", AUTHORITY_REF, "Release plan authority ref is invalid.");
  exactKeys(plan.authority, ["ref", "sha", "workflowRef"], "Release plan authority");
  assert.match(plan.repository ?? "", REPOSITORY, "Release plan repository is invalid.");
  assert.equal(
    plan.authority.workflowRef,
    `${plan.repository}/.github/workflows/release-authority.yml@${plan.authority.ref}`,
    "Release plan authority workflow is invalid.",
  );
  exactKeys(plan.candidate, [
    "sha", "servicesImage", "cubeImage", "privilegedSurfaceDigest", "privilegedFileRecordCount",
    "privilegedByteCount",
  ], "Release plan candidate");
  assert.match(plan.candidate?.sha ?? "", COMMIT_SHA, "Release plan candidate SHA is invalid.");
  assert.match(plan.candidate?.servicesImage ?? "", IMAGE, "Release plan services image is invalid.");
  assert.match(plan.candidate?.cubeImage ?? "", IMAGE, "Release plan Cube image is invalid.");
  assert.match(plan.candidate?.privilegedSurfaceDigest ?? "", SHA256, "Release plan surface digest is invalid.");
  assert.ok(Number.isSafeInteger(plan.candidate.privilegedFileRecordCount) &&
    plan.candidate.privilegedFileRecordCount > 0, "Release plan file count is invalid.");
  assert.ok(Number.isSafeInteger(plan.candidate.privilegedByteCount) &&
    plan.candidate.privilegedByteCount > 0, "Release plan byte count is invalid.");
  exactKeys(plan.evidence, [
    "dogfoodRunId", "dogfoodArtifactId", "dogfoodArtifactDigest", "dogfoodToolingSha", "dogfoodWorkflowRef",
  ], "Release plan evidence");
  assert.match(plan.evidence.dogfoodRunId, DIGITS, "Release plan dogfood run ID is invalid.");
  assert.match(plan.evidence.dogfoodArtifactId, DIGITS, "Release plan dogfood artifact ID is invalid.");
  assert.match(plan.evidence.dogfoodArtifactDigest, /^sha256:[a-f0-9]{64}$/u,
    "Release plan dogfood artifact digest is invalid.");
  assert.equal(plan.evidence.dogfoodToolingSha, plan.authority.sha,
    "Dogfood tooling is not the immutable release authority.");
  assert.equal(
    plan.evidence.dogfoodWorkflowRef,
    `${plan.repository}/.github/workflows/dogfood-acceptance.yml@${plan.authority.ref}`,
    "Dogfood workflow is not from the immutable release authority tag.",
  );
  exactKeys(plan.verification, ["ciWorkflowId", "ciRunId", "ciRunAttempt", "ciCheckSuiteId"],
    "Release plan CI verification");
  assert.match(plan.verification.ciWorkflowId ?? "", DIGITS, "Release plan CI workflow ID is invalid.");
  assert.match(plan.verification.ciRunId ?? "", DIGITS, "Release plan CI run ID is invalid.");
  assert.equal(plan.verification.ciRunAttempt, 1,
    "Release plan CI must be from the first run attempt.");
  assert.match(plan.verification.ciCheckSuiteId ?? "", DIGITS,
    "Release plan CI check-suite ID is invalid.");
  exactKeys(plan.release, [
    "workflowRunId", "workflowRunAttempt", "workflowActorId", "workflowActorLogin",
  ], "Release plan run identity");
  assert.match(plan.release?.workflowRunId ?? "", DIGITS, "Release plan run id is invalid.");
  assert.equal(plan.release?.workflowRunAttempt, 1, "Release plan must be from the first run attempt.");
  assert.match(plan.release?.workflowActorId ?? "", DIGITS, "Release plan actor ID is invalid.");
  assert.match(plan.release?.workflowActorLogin ?? "", GITHUB_LOGIN, "Release plan actor login is invalid.");
  return plan;
}

function parseEnvelope(input, label) {
  const envelope = typeof input === "string" ? JSON.parse(input) : input;
  assert.ok(envelope && typeof envelope === "object" && !Array.isArray(envelope), `${label} must be an object.`);
  return envelope;
}

function parseApprovalRecord(input, plan) {
  const approval = parseEnvelope(input, "Production approval record");
  exactKeys(approval, [
    "schemaVersion", "kind", "repository", "workflowRunId", "workflowRunAttempt",
    "environment", "state", "reviewer",
  ], "Production approval record");
  assert.equal(approval.schemaVersion, 1, "Production approval schema is invalid.");
  assert.equal(approval.kind, "albert.production-environment-approval",
    "Production approval kind is invalid.");
  assert.equal(approval.repository, plan.repository, "Production approval repository differs.");
  assert.equal(approval.workflowRunId, plan.release.workflowRunId, "Production approval run differs.");
  assert.equal(approval.workflowRunAttempt, 1, "Production approval must be from the first run attempt.");
  assert.equal(approval.environment, "production", "Production approval environment is invalid.");
  assert.equal(approval.state, "approved", "Production approval was not approved.");
  exactKeys(approval.reviewer, ["id", "login", "type"], "Production reviewer");
  assert.match(approval.reviewer.id ?? "", DIGITS, "Production reviewer ID is invalid.");
  assert.match(approval.reviewer.login ?? "", GITHUB_LOGIN, "Production reviewer login is invalid.");
  assert.equal(approval.reviewer.type, "User", "Production approval must come from a human GitHub user.");
  assert.notEqual(approval.reviewer.id, plan.release.workflowActorId,
    "The release dispatcher cannot approve their own production release.");
  assert.notEqual(approval.reviewer.login.toLowerCase(), plan.release.workflowActorLogin.toLowerCase(),
    "The release dispatcher cannot approve their own production release.");
  return approval;
}

export function sealReleaseAuthorization({
  plan: planInput,
  capacityEnvelope: capacityInput,
  dogfoodEnvelope: dogfoodInput,
  encodedPrivateKey,
  githubAuthorityAuditDigest,
  approvalRecord: approvalInput,
  now = Date.now(),
}) {
  const plan = parseReleasePlan(planInput);
  const capacityEnvelope = parseEnvelope(capacityInput, "Capacity envelope");
  const dogfoodEnvelope = parseEnvelope(dogfoodInput, "Dogfood envelope");
  const approval = parseApprovalRecord(approvalInput, plan);
  assert.match(githubAuthorityAuditDigest ?? "", SHA256,
    "GitHub release-authority audit digest is invalid.");
  assert.equal(dogfoodEnvelope.attestation?.candidateSha, plan.candidate.sha,
    "Dogfood envelope candidate differs from the release plan.");
  assert.equal(dogfoodEnvelope.attestation?.repository, plan.repository,
    "Dogfood envelope repository differs from the release plan.");
  assert.equal(dogfoodEnvelope.attestation?.workflow?.runId, plan.evidence.dogfoodRunId,
    "Dogfood envelope workflow run differs from the release plan.");
  assert.equal(dogfoodEnvelope.attestation?.workflow?.runAttempt, 1,
    "Dogfood envelope must be from the first run attempt.");
  assert.equal(dogfoodEnvelope.attestation?.workflow?.file, "dogfood-acceptance.yml",
    "Dogfood envelope workflow file is invalid.");
  assert.equal(dogfoodEnvelope.attestation?.workflow?.ref, plan.authority.ref,
    "Dogfood envelope ref differs from the immutable authority.");
  assert.equal(dogfoodEnvelope.attestation?.workflow?.toolingSha, plan.authority.sha,
    "Dogfood envelope tooling differs from the immutable authority.");

  const capacityCandidate = capacityEnvelope.payload?.candidate;
  exactKeys(capacityCandidate, ["releasePlanDigest", "sha", "transformImageDigest"],
    "Capacity envelope candidate");
  assert.equal(capacityCandidate.sha, plan.candidate.sha,
    "Capacity envelope candidate differs from the release plan.");
  assert.equal(capacityCandidate.releasePlanDigest, plan.planDigest,
    "Capacity envelope release-plan digest differs.");
  assert.equal(plan.candidate.servicesImage, `${plan.candidate.servicesImage.split("@")[0]}@${capacityCandidate.transformImageDigest}`,
    "Capacity envelope image digest differs from the release plan.");
  const capacityAuthority = capacityEnvelope.payload?.authority;
  assert.equal(capacityAuthority?.repository, plan.repository, "Capacity envelope repository differs.");
  assert.equal(capacityAuthority?.sha, plan.authority.sha, "Capacity envelope authority SHA differs.");
  assert.equal(capacityAuthority?.ref, plan.authority.ref, "Capacity envelope authority ref differs.");
  assert.equal(capacityAuthority?.workflowRef, plan.authority.workflowRef,
    "Capacity envelope workflow differs.");
  assert.equal(capacityAuthority?.runId, plan.release.workflowRunId, "Capacity envelope run differs.");
  assert.equal(capacityAuthority?.runAttempt, 1, "Capacity envelope must be from the first run attempt.");

  const privateKey = createPrivateKey({
    key: decodeDer(encodedPrivateKey, "Private"),
    format: "der",
    type: "pkcs8",
  });
  assert.equal(privateKey.asymmetricKeyType, "ed25519", "Release authorisation private key must be Ed25519.");
  const issuedAt = new Date(now).toISOString();
  const receipt = {
    schemaVersion: 3,
    kind: "albert.production-release-authorization",
    authority: plan.authority,
    candidateSha: plan.candidate.sha,
    servicesImage: plan.candidate.servicesImage,
    cubeImage: plan.candidate.cubeImage,
    planDigest: plan.planDigest,
    workflowRunId: plan.release.workflowRunId,
    workflowRunAttempt: plan.release.workflowRunAttempt,
    workflowActor: {
      id: plan.release.workflowActorId,
      login: plan.release.workflowActorLogin,
    },
    reviewer: {
      id: approval.reviewer.id,
      login: approval.reviewer.login,
    },
    approvalRecordDigest: sha256(canonicalJson(approval)),
    githubAuthorityAuditDigest,
    dogfoodEnvelopeDigest: sha256(canonicalJson(dogfoodEnvelope)),
    capacityEnvelopeDigest: sha256(canonicalJson(capacityEnvelope)),
    issuedAt,
    expiresAt: new Date(now + MAX_LIFETIME_MS).toISOString(),
    nonce: randomBytes(32).toString("base64url"),
  };
  const signature = signBytes(null, Buffer.from(canonicalJson(receipt)), privateKey).toString("base64url");
  return Object.freeze({
    receipt: Object.freeze(receipt),
    signature: Object.freeze({ algorithm: "Ed25519", keyId: keyId(privateKey), value: signature }),
  });
}

export function verifyReleaseAuthorization(envelopeInput, expected, now = Date.now()) {
  const envelope = typeof envelopeInput === "string" ? JSON.parse(envelopeInput) : envelopeInput;
  exactKeys(envelope, ["receipt", "signature"], "Release authorisation envelope");
  const receipt = envelope.receipt;
  exactKeys(receipt, [
    "schemaVersion", "kind", "authority", "candidateSha", "servicesImage", "cubeImage", "planDigest",
    "workflowRunId", "workflowRunAttempt", "workflowActor", "reviewer", "approvalRecordDigest",
    "githubAuthorityAuditDigest", "dogfoodEnvelopeDigest", "capacityEnvelopeDigest", "issuedAt",
    "expiresAt", "nonce",
  ], "Release authorisation receipt");
  assert.equal(receipt.schemaVersion, 3, "Release authorisation schema is invalid.");
  assert.equal(receipt.kind, "albert.production-release-authorization", "Release authorisation kind is invalid.");
  exactKeys(receipt.authority, ["ref", "sha", "workflowRef"], "Release authorisation authority");
  assert.equal(receipt.authority.sha, expected.authoritySha, "Release authorisation authority SHA differs.");
  assert.equal(receipt.authority.ref, expected.authorityRef, "Release authorisation authority ref differs.");
  assert.equal(receipt.authority.workflowRef, expected.authorityWorkflowRef,
    "Release authorisation authority workflow differs.");
  assert.match(receipt.candidateSha, COMMIT_SHA, "Release authorisation candidate SHA is invalid.");
  assert.equal(receipt.candidateSha, expected.candidateSha, "Release authorisation candidate SHA differs.");
  assert.match(receipt.servicesImage, IMAGE, "Release authorisation image is invalid.");
  assert.equal(receipt.servicesImage, expected.servicesImage, "Release authorisation image differs.");
  assert.match(receipt.cubeImage, IMAGE, "Release authorisation Cube image is invalid.");
  assert.equal(receipt.cubeImage, expected.cubeImage, "Release authorisation Cube image differs.");
  assert.match(receipt.planDigest, SHA256, "Release authorisation plan digest is invalid.");
  assert.equal(receipt.planDigest, expected.planDigest, "Release authorisation plan differs.");
  assert.match(receipt.workflowRunId, DIGITS, "Release authorisation run ID is invalid.");
  assert.equal(receipt.workflowRunId, expected.workflowRunId, "Release authorisation run differs.");
  assert.equal(receipt.workflowRunAttempt, 1, "Release authorisation must be from the first attempt.");
  assert.equal(receipt.workflowRunAttempt, expected.workflowRunAttempt, "Release authorisation attempt differs.");
  exactKeys(receipt.workflowActor, ["id", "login"], "Release authorisation workflow actor");
  exactKeys(receipt.reviewer, ["id", "login"], "Release authorisation reviewer");
  assert.match(receipt.workflowActor.id, DIGITS, "Release authorisation actor ID is invalid.");
  assert.match(receipt.workflowActor.login, GITHUB_LOGIN, "Release authorisation actor login is invalid.");
  assert.match(receipt.reviewer.id, DIGITS, "Release authorisation reviewer ID is invalid.");
  assert.match(receipt.reviewer.login, GITHUB_LOGIN, "Release authorisation reviewer login is invalid.");
  assert.equal(receipt.workflowActor.id, expected.workflowActorId, "Release authorisation actor ID differs.");
  assert.equal(receipt.workflowActor.login, expected.workflowActorLogin, "Release authorisation actor login differs.");
  assert.equal(receipt.reviewer.id, expected.reviewerId, "Release authorisation reviewer ID differs.");
  assert.equal(receipt.reviewer.login, expected.reviewerLogin, "Release authorisation reviewer login differs.");
  assert.notEqual(receipt.reviewer.id, receipt.workflowActor.id,
    "Release dispatcher and production reviewer must be different users.");
  assert.match(receipt.approvalRecordDigest, SHA256, "Release approval record digest is invalid.");
  assert.equal(receipt.approvalRecordDigest, expected.approvalRecordDigest,
    "Release approval record digest differs.");
  assert.match(receipt.githubAuthorityAuditDigest, SHA256,
    "GitHub release-authority audit digest is invalid.");
  assert.equal(receipt.githubAuthorityAuditDigest, expected.githubAuthorityAuditDigest,
    "GitHub release-authority audit digest differs.");
  assert.match(receipt.dogfoodEnvelopeDigest, SHA256);
  assert.match(receipt.capacityEnvelopeDigest, SHA256);
  assert.match(receipt.nonce, /^[A-Za-z0-9_-]{43}$/u, "Release authorisation nonce is invalid.");
  const issuedAt = Date.parse(receipt.issuedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  assert.ok(Number.isFinite(issuedAt) && Number.isFinite(expiresAt), "Release authorisation time is invalid.");
  assert.ok(issuedAt <= now + CLOCK_SKEW_MS, "Release authorisation is issued in the future.");
  assert.ok(expiresAt > now && expiresAt - issuedAt === MAX_LIFETIME_MS,
    "Release authorisation is expired or has an invalid lifetime.");
  exactKeys(envelope.signature, ["algorithm", "keyId", "value"], "Release authorisation signature");
  assert.equal(envelope.signature.algorithm, "Ed25519", "Release authorisation signature algorithm is invalid.");
  assert.match(envelope.signature.value, /^[A-Za-z0-9_-]{86}$/u, "Release authorisation signature encoding is invalid.");
  const publicKey = createPublicKey({
    key: decodeDer(expected.encodedPublicKey, "Public"),
    format: "der",
    type: "spki",
  });
  assert.equal(envelope.signature.keyId, keyId(publicKey), "Release authorisation signer is not trusted.");
  assert.equal(verifyBytes(
    null,
    Buffer.from(canonicalJson(receipt)),
    publicKey,
    Buffer.from(envelope.signature.value, "base64url"),
  ), true, "Release authorisation signature is invalid.");
  return Object.freeze(receipt);
}

function required(source, name) {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required.`);
  return value;
}

async function main() {
  const mode = process.argv[2];
  if (mode === "seal") {
    const [plan, capacityEnvelope, dogfoodEnvelope, approvalRecord] = await Promise.all([
      readFile(process.argv[4], "utf8"),
      readFile(process.argv[5], "utf8"),
      readFile(process.argv[6], "utf8"),
      readFile(process.argv[7], "utf8"),
    ]);
    const envelope = sealReleaseAuthorization({
      plan,
      capacityEnvelope,
      dogfoodEnvelope,
      approvalRecord,
      githubAuthorityAuditDigest: required(process.env, "ALBERT_RELEASE_GITHUB_AUTHORITY_AUDIT_DIGEST"),
      encodedPrivateKey: required(process.env, "ALBERT_RELEASE_AUTHORIZATION_ED25519_PRIVATE_KEY_BASE64URL"),
    });
    await writeFile(process.argv[3], `${canonicalJson(envelope)}\n`, { mode: 0o600 });
    process.stdout.write(`release authorisation sealed for ${envelope.receipt.candidateSha}\n`);
    return;
  }
  if (mode === "verify") {
    const envelope = await readFile(process.argv[3], "utf8");
    verifyReleaseAuthorization(envelope, {
      encodedPublicKey: required(process.env, "ALBERT_RELEASE_AUTHORIZATION_ED25519_PUBLIC_KEY_BASE64URL"),
      authoritySha: required(process.env, "ALBERT_RELEASE_AUTHORITY_TOOLING_SHA"),
      authorityRef: required(process.env, "ALBERT_RELEASE_AUTHORITY_REF"),
      authorityWorkflowRef: required(process.env, "GITHUB_WORKFLOW_REF"),
      candidateSha: required(process.env, "ALBERT_RELEASE_CANDIDATE_SHA"),
      servicesImage: required(process.env, "ALBERT_RELEASE_SERVICES_IMAGE"),
      cubeImage: required(process.env, "ALBERT_RELEASE_CUBE_IMAGE"),
      planDigest: required(process.env, "ALBERT_RELEASE_PLAN_DIGEST"),
      workflowRunId: required(process.env, "GITHUB_RUN_ID"),
      workflowRunAttempt: Number(required(process.env, "GITHUB_RUN_ATTEMPT")),
      workflowActorId: required(process.env, "GITHUB_ACTOR_ID"),
      workflowActorLogin: required(process.env, "GITHUB_ACTOR"),
      reviewerId: required(process.env, "ALBERT_RELEASE_REVIEWER_ID"),
      reviewerLogin: required(process.env, "ALBERT_RELEASE_REVIEWER_LOGIN"),
      approvalRecordDigest: required(process.env, "ALBERT_RELEASE_APPROVAL_RECORD_DIGEST"),
      githubAuthorityAuditDigest: required(process.env, "ALBERT_RELEASE_GITHUB_AUTHORITY_AUDIT_DIGEST"),
    });
    process.stdout.write("release authorisation verified\n");
    return;
  }
  assert.fail("Usage: release-authorization-receipt.mjs seal <output> <plan> <capacity> <dogfood> <approval> | verify <receipt>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
