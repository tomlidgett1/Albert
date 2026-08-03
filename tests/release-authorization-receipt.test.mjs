import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  sealReleaseAuthorization,
  verifyReleaseAuthorization,
} from "../scripts/release-authorization-receipt.mjs";
import { canonicalJson } from "../scripts/create-release-plan.mjs";

const authoritySha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const imageDigest = `sha256:${"c".repeat(64)}`;
const servicesImage = `ghcr.io/tomlidgett1/albert-services@${imageDigest}`;
const authorityRef = "refs/tags/albert-release-authority-v1";
const repository = "tomlidgett1/Albert";
const authorityWorkflowRef = `${repository}/.github/workflows/release-authority.yml@${authorityRef}`;
const githubAuthorityAuditDigest = "f".repeat(64);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const encodedPrivateKey = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
const encodedPublicKey = publicKey.export({ type: "spki", format: "der" }).toString("base64url");

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function plan() {
  const body = {
    schemaVersion: 2,
    kind: "albert.production-release-plan",
    repository,
    authority: {
      ref: authorityRef,
      sha: authoritySha,
      workflowRef: authorityWorkflowRef,
    },
    candidate: {
      sha: candidateSha,
      servicesImage,
      privilegedSurfaceDigest: "d".repeat(64),
      privilegedFileRecordCount: 10,
      privilegedByteCount: 100,
    },
    evidence: {
      dogfoodRunId: "12",
      dogfoodArtifactId: "34",
      dogfoodArtifactDigest: `sha256:${"e".repeat(64)}`,
      dogfoodToolingSha: authoritySha,
      dogfoodWorkflowRef: `${repository}/.github/workflows/dogfood-acceptance.yml@${authorityRef}`,
    },
    verification: { ciWorkflowId: "70", ciRunId: "71", ciRunAttempt: 1, ciCheckSuiteId: "72" },
    release: {
      workflowRunId: "56",
      workflowRunAttempt: 1,
      workflowActorId: "42",
      workflowActorLogin: "release-operator",
    },
  };
  return { ...body, planDigest: digest(body) };
}

function expected(value) {
  const approvalRecord = approval();
  return {
    encodedPublicKey,
    authoritySha,
    authorityRef,
    authorityWorkflowRef,
    candidateSha,
    servicesImage,
    planDigest: value.planDigest,
    workflowRunId: "56",
    workflowRunAttempt: 1,
    workflowActorId: "42",
    workflowActorLogin: "release-operator",
    reviewerId: "84",
    reviewerLogin: "production-reviewer",
    approvalRecordDigest: digest(approvalRecord),
    githubAuthorityAuditDigest,
  };
}

function approval() {
  return {
    schemaVersion: 1,
    kind: "albert.production-environment-approval",
    repository,
    workflowRunId: "56",
    workflowRunAttempt: 1,
    environment: "production",
    state: "approved",
    reviewer: { id: "84", login: "production-reviewer", type: "User" },
  };
}

function capacity(value, overrides = {}) {
  return {
    payload: {
      authority: {
        repository,
        sha: authoritySha,
        ref: authorityRef,
        workflowRef: authorityWorkflowRef,
        runId: "56",
        runAttempt: 1,
      },
      candidate: {
        sha: candidateSha,
        releasePlanDigest: value.planDigest,
        transformImageDigest: imageDigest,
        ...overrides,
      },
    },
    signature: { value: "capacity" },
  };
}

function dogfood() {
  return {
    attestation: {
      candidateSha,
      repository,
      workflow: {
        runId: "12",
        runAttempt: 1,
        file: "dogfood-acceptance.yml",
        ref: authorityRef,
        toolingSha: authoritySha,
      },
    },
    signature: { value: "dogfood" },
  };
}

test("signed release authorisation binds one plan, capacity result, and dogfood result", () => {
  const value = plan();
  const envelope = sealReleaseAuthorization({
    plan: value,
    capacityEnvelope: capacity(value),
    dogfoodEnvelope: dogfood(),
    approvalRecord: approval(),
    githubAuthorityAuditDigest,
    encodedPrivateKey,
    now: Date.parse("2026-08-04T00:00:00.000Z"),
  });
  const receipt = verifyReleaseAuthorization(
    envelope,
    expected(value),
    Date.parse("2026-08-04T01:00:00.000Z"),
  );
  assert.equal(receipt.planDigest, value.planDigest);
  assert.equal(receipt.servicesImage, servicesImage);
});

test("release authorisation rejects a different candidate image or plan", () => {
  const value = plan();
  assert.throws(() => sealReleaseAuthorization({
    plan: value,
    capacityEnvelope: capacity(value, { releasePlanDigest: "e".repeat(64) }),
    dogfoodEnvelope: dogfood(),
    approvalRecord: approval(),
    githubAuthorityAuditDigest,
    encodedPrivateKey,
  }), /release-plan digest differs/u);
});

test("release authorisation signature cannot be replayed for another workflow run", () => {
  const value = plan();
  const envelope = sealReleaseAuthorization({
    plan: value,
    capacityEnvelope: capacity(value),
    dogfoodEnvelope: dogfood(),
    approvalRecord: approval(),
    githubAuthorityAuditDigest,
    encodedPrivateKey,
  });
  assert.throws(() => verifyReleaseAuthorization(envelope, {
    ...expected(value),
    workflowRunId: "57",
  }), /run differs/u);
});

test("release authorisation refuses dispatcher self-approval", () => {
  const value = plan();
  assert.throws(() => sealReleaseAuthorization({
    plan: value,
    capacityEnvelope: capacity(value),
    dogfoodEnvelope: dogfood(),
    approvalRecord: {
      ...approval(),
      reviewer: { id: "42", login: "release-operator", type: "User" },
    },
    githubAuthorityAuditDigest,
    encodedPrivateKey,
  }), /cannot approve their own/u);
});

test("release authorisation requires exact capacity image and first-attempt dogfood provenance", () => {
  const value = plan();
  const capacityWithoutImage = capacity(value);
  delete capacityWithoutImage.payload.candidate.transformImageDigest;
  assert.throws(() => sealReleaseAuthorization({
    plan: value,
    capacityEnvelope: capacityWithoutImage,
    dogfoodEnvelope: dogfood(),
    approvalRecord: approval(),
    githubAuthorityAuditDigest,
    encodedPrivateKey,
  }), /Capacity envelope candidate shape/u);
  const replayedDogfood = dogfood();
  replayedDogfood.attestation.workflow.runAttempt = 2;
  assert.throws(() => sealReleaseAuthorization({
    plan: value,
    capacityEnvelope: capacity(value),
    dogfoodEnvelope: replayedDogfood,
    approvalRecord: approval(),
    githubAuthorityAuditDigest,
    encodedPrivateKey,
  }), /first run attempt/u);
});
