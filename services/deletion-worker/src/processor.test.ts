import assert from "node:assert/strict";
import test from "node:test";
import {
  DeletionProcessor,
  ProductionCredentialRevoker,
  type DeletionControlPort,
} from "./processor.js";
import type { DeletionClaim } from "./store.js";

const claim: DeletionClaim = Object.freeze({
  messageId: 7,
  readCount: 1,
  visibilityDeadline: new Date(Date.now() + 60_000).toISOString(),
  requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  tenantId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  scope: "connection",
});

const emptyAnalyticalVerification = Object.freeze({
  verified: true,
  scope: "connection",
  measurement: "post_purge_row_counts_v1",
  remainingRows: 0,
  residuals: Object.freeze({
    stagingRows: 0,
    canonicalRows: 0,
    bridgeRows: 0,
    linkRows: 0,
    embeddingRows: 0,
    cacheRows: 0,
    otherAnalyticalRows: 0,
  }),
});
const emptyRemoteRevocation = Object.freeze({
  attemptedAt: "2026-08-04T00:00:00.000Z",
  priorStatus: "pending",
  targetCount: 0,
  targets: Object.freeze([]),
  bestEffort: true,
});
const emptyCredentialVerification = Object.freeze({
  verified: true,
  tokenReferences: 0,
  credentialEnvelopes: 0,
  sessionEnvelopes: 0,
});
const emptyRawVerification = Object.freeze({ verified: true, remainingObjects: 0 });
const emptyControlVerification = Object.freeze({
  verified: true,
  remainingTenantOrConnectionRows: 0,
  remainingDerivedArtifacts: 0,
  remainingQueueMessages: 0,
});
const emptyRawPurge = Object.freeze({
  verified: true,
  prefix: `tenant/${claim.tenantId}/connection/${claim.connectionId}/`,
  objectsRemoved: 0,
});
const emptyAnalyticalPurge = Object.freeze({
  verified: true,
  scope: "connection",
  rowsRemoved: 0,
  canonicalDependencyRowsAdded: 0,
  canonicalResidual: 0,
  reconciliationRowsRemoved: 0,
  marts: Object.freeze({ refreshed: true, chunks: 0, from: null, to: null }),
});
const emptyControlPurge = Object.freeze({
  scope: "connection",
  rowsRemoved: 0,
  connectionTombstoned: true,
});

class MemoryControl implements DeletionControlPort {
  readonly calls: string[] = [];
  proof: Parameters<DeletionControlPort["complete"]>[1] | null = null;
  retried = false;
  retryEvidence: Readonly<Record<string, unknown>> | null = null;
  readonly progressEvidence: Record<string, Readonly<Record<string, unknown>>> = {};
  credentialEvidence: Readonly<Record<string, unknown> & { verified: boolean }> = emptyCredentialVerification;
  controlPurgeEvidence: Readonly<Record<string, unknown>> = emptyControlPurge;
  controlEvidence: Readonly<Record<string, unknown>> = emptyControlVerification;
  extend() { this.calls.push("extend"); return Promise.resolve(); }
  revocationContext() { return Promise.resolve({ priorStatus: "succeeded", priorProgress: {}, targets: [] }); }
  destroyCredentials() { this.calls.push("destroy"); return Promise.resolve(); }
  credentialVerification() { return Promise.resolve(this.credentialEvidence); }
  assertQuiescent() { this.calls.push("quiescent"); return Promise.resolve({ verified: true, activeWritePermits: 0 }); }
  progress(_claim: DeletionClaim, stage: string, value: Readonly<Record<string, unknown>>) {
    this.calls.push(`progress:${stage}`);
    this.progressEvidence[stage] = value;
    return Promise.resolve();
  }
  purge() { this.calls.push("control:purge"); return Promise.resolve(this.controlPurgeEvidence); }
  verify() { this.calls.push("control:verify"); return Promise.resolve(this.controlEvidence); }
  markVerifying() { this.calls.push("verifying"); return Promise.resolve(); }
  issueAnalyticalCapability(_claim: DeletionClaim, operation: "purge" | "verify") {
    this.calls.push(`capability:${operation}`);
    return Promise.resolve(`capability-${operation}-${"x".repeat(100)}`);
  }
  complete(_claim: DeletionClaim, proof: Parameters<DeletionControlPort["complete"]>[1]) {
    this.calls.push("complete"); this.proof = proof; return Promise.resolve();
  }
  retry(_claim: DeletionClaim, evidence: Readonly<Record<string, unknown>>) {
    this.retried = true;
    this.retryEvidence = evidence;
    return Promise.resolve();
  }
}

test("remote revocation evidence survives a post-destruction retry", async () => {
  const revoker = new ProductionCredentialRevoker(
    {
      revocationContext: async () => ({
        priorStatus: "succeeded",
        priorProgress: { remote_revocation: emptyRemoteRevocation },
        targets: [],
      }),
    },
    () => { throw new Error("the destroyed vault must not be reopened"); },
    { lightspeedClientId: "test", lightspeedClientSecret: "test", xeroClientId: "test" },
  );

  const evidence = await revoker.revoke(claim);

  assert.deepEqual(evidence, emptyRemoteRevocation);
  assert.notEqual(evidence, emptyRemoteRevocation);
});

test("watchdog credential destruction remains explicit on retry", async () => {
  const revoker = new ProductionCredentialRevoker(
    {
      revocationContext: async () => ({
        priorStatus: "failed",
        priorProgress: {
          remote_revocation: {
            forcedLocalDestruction: true,
            reason: "remote_revocation_grace_expired",
          },
          credential_vault: {
            verified: true,
            completedAt: "2026-08-04 00:00:00+00",
          },
        },
        targets: [],
      }),
    },
    () => { throw new Error("the forcibly destroyed vault must not be reopened"); },
    { lightspeedClientId: "test", lightspeedClientSecret: "test", xeroClientId: "test" },
  );

  const evidence = await revoker.revoke(claim);

  assert.deepEqual(evidence, {
    attemptedAt: "2026-08-04T00:00:00.000Z",
    priorStatus: "failed",
    targetCount: 0,
    targets: [],
    bestEffort: true,
    forcedLocalDestruction: true,
    reason: "remote_revocation_grace_expired",
  });
});

test("deletion processor orders quiescence, purge, cross-store verification, and immutable proof", async () => {
  const control = new MemoryControl();
  const processor = new DeletionProcessor(
    control,
    { purge: async () => emptyAnalyticalPurge, verify: async () => emptyAnalyticalVerification },
    { purge: async () => ({ ...emptyRawPurge, objectsRemoved: 2 }), verify: async () => emptyRawVerification },
    { revoke: async () => emptyRemoteRevocation },
    "a-production-proof-key-containing-more-than-32-bytes",
    "test-version",
  );

  const outcome = await processor.process(claim);

  assert.deepEqual(outcome, { status: "completed" });
  assert.equal(control.retried, false);
  assert.ok(control.calls.indexOf("quiescent") < control.calls.indexOf("control:purge"));
  assert.ok(control.calls.indexOf("verifying") < control.calls.indexOf("control:verify"));
  assert.equal(control.calls.at(-1), "complete");
  assert.match(control.proof?.tenantReferenceHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(control.proof?.proofDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(control.proof?.connectionReferenceHash?.length, 64);
  assert.deepEqual(control.proof?.remoteRevocation, emptyRemoteRevocation);
  assert.notEqual(control.proof?.remoteRevocation, emptyRemoteRevocation);
  assert.deepEqual(control.proof?.storeVerification, {
    credential_vault: emptyCredentialVerification,
    raw_storage: emptyRawVerification,
    analytical: emptyAnalyticalVerification,
    control_plane: emptyControlVerification,
  });
  assert.deepEqual(control.progressEvidence.raw_storage, { verified: true, objectsRemoved: 2 });
  assert.deepEqual(control.progressEvidence.analytical, {
    verified: true,
    scope: "connection",
    rowsRemoved: 0,
  });
  assert.deepEqual(control.progressEvidence.control_plane, {
    verified: true,
    scope: "connection",
    rowsRemoved: 0,
  });
  assert.deepEqual(control.progressEvidence.verification, { verified: true, storesVerified: 4 });
  assert.doesNotMatch(JSON.stringify(control.progressEvidence), /tenant\//u);
});

test("tenant deletion uses the same normalized progress and proof boundary", async () => {
  const tenantClaim: DeletionClaim = Object.freeze({
    ...claim,
    connectionId: null,
    scope: "tenant",
  });
  const control = new MemoryControl();
  control.controlPurgeEvidence = {
    scope: "tenant",
    rowsRemoved: 3,
    tenantAnchorPendingProof: true,
  };
  const processor = new DeletionProcessor(
    control,
    {
      purge: async () => ({
        verified: true,
        scope: "tenant",
        rowsRemoved: 5,
        remainingRows: 0,
      }),
      verify: async () => ({ ...emptyAnalyticalVerification, scope: "tenant" }),
    },
    {
      purge: async () => ({
        verified: true,
        prefix: `tenant/${claim.tenantId}/`,
        objectsRemoved: 2,
      }),
      verify: async () => emptyRawVerification,
    },
    { revoke: async () => emptyRemoteRevocation },
    "a-production-proof-key-containing-more-than-32-bytes",
    "test-version",
  );

  const outcome = await processor.process(tenantClaim);

  assert.deepEqual(outcome, { status: "completed" });
  assert.equal(control.proof?.connectionReferenceHash, null);
  assert.deepEqual(control.progressEvidence.analytical, {
    verified: true,
    scope: "tenant",
    rowsRemoved: 5,
  });
  assert.deepEqual(control.progressEvidence.control_plane, {
    verified: true,
    scope: "tenant",
    rowsRemoved: 3,
  });
});

test("a failed store verification is durably retried and never proven", async () => {
  const control = new MemoryControl();
  const processor = new DeletionProcessor(
    control,
    {
      purge: async () => emptyAnalyticalPurge,
      verify: async () => ({
        ...emptyAnalyticalVerification,
        verified: false,
        remainingRows: 1,
        residuals: { ...emptyAnalyticalVerification.residuals, stagingRows: 1 },
      }),
    },
    { purge: async () => emptyRawPurge, verify: async () => emptyRawVerification },
    { revoke: async () => emptyRemoteRevocation },
    "a-production-proof-key-containing-more-than-32-bytes",
    "test-version",
  );

  const outcome = await processor.process(claim);

  assert.equal(outcome.status, "retry_scheduled");
  assert.equal(outcome.status === "retry_scheduled" ? outcome.failure.code : null, "unexpected_deletion_failure");
  assert.equal(outcome.status === "retry_scheduled" ? outcome.retryDelaySeconds : null, 10);
  assert.equal(control.retried, true);
  assert.equal(control.proof, null);
  assert.deepEqual(
    Object.keys(control.retryEvidence ?? {}).sort(),
    ["code", "correlationId", "errorClass", "failedAt", "retryable"],
  );
  assert.doesNotMatch(JSON.stringify(control.retryEvidence), /analytical_deletion_not_verified/);
});

test("a synthetic analytical boolean cannot enter the immutable proof", async () => {
  const control = new MemoryControl();
  const processor = new DeletionProcessor(
    control,
    { purge: async () => emptyAnalyticalPurge, verify: async () => ({ verified: true }) },
    { purge: async () => emptyRawPurge, verify: async () => emptyRawVerification },
    { revoke: async () => emptyRemoteRevocation },
    "a-production-proof-key-containing-more-than-32-bytes",
    "test-version",
  );

  const outcome = await processor.process(claim);

  assert.equal(outcome.status, "retry_scheduled");
  assert.equal(control.retried, true);
  assert.equal(control.proof, null);
});

test("extra analytical proof fields are rejected before persistence", async () => {
  const candidates = [
    { ...emptyAnalyticalVerification, detail: "customer@example.com" },
    {
      ...emptyAnalyticalVerification,
      residuals: { ...emptyAnalyticalVerification.residuals, detailRows: 0 },
    },
  ];
  for (const candidate of candidates) {
    const control = new MemoryControl();
    const processor = new DeletionProcessor(
      control,
      { purge: async () => emptyAnalyticalPurge, verify: async () => candidate },
      { purge: async () => emptyRawPurge, verify: async () => emptyRawVerification },
      { revoke: async () => emptyRemoteRevocation },
      "a-production-proof-key-containing-more-than-32-bytes",
      "test-version",
    );

    const outcome = await processor.process(claim);

    assert.equal(outcome.status, "retry_scheduled");
    assert.equal(control.proof, null);
    assert.doesNotMatch(JSON.stringify(control.retryEvidence), /customer@example\.com/u);
  }
});

test("free-text fields cannot enter any durable deletion proof object", async () => {
  const secret = "customer@example.com";
  const candidates = [
    {
      configure: () => undefined,
      raw: emptyRawVerification,
      remote: { ...emptyRemoteRevocation, detail: secret },
    },
    {
      configure: (control: MemoryControl) => {
        control.credentialEvidence = { ...emptyCredentialVerification, detail: secret };
      },
      raw: emptyRawVerification,
      remote: emptyRemoteRevocation,
    },
    {
      configure: () => undefined,
      raw: { ...emptyRawVerification, detail: secret },
      remote: emptyRemoteRevocation,
    },
    {
      configure: (control: MemoryControl) => {
        control.controlEvidence = { ...emptyControlVerification, detail: secret };
      },
      raw: emptyRawVerification,
      remote: emptyRemoteRevocation,
    },
  ];
  for (const candidate of candidates) {
    const control = new MemoryControl();
    candidate.configure(control);
    const processor = new DeletionProcessor(
      control,
      { purge: async () => emptyAnalyticalPurge, verify: async () => emptyAnalyticalVerification },
      { purge: async () => emptyRawPurge, verify: async () => candidate.raw },
      { revoke: async () => candidate.remote },
      "a-production-proof-key-containing-more-than-32-bytes",
      "test-version",
    );

    const outcome = await processor.process(claim);

    assert.equal(outcome.status, "retry_scheduled");
    assert.equal(control.proof, null);
    assert.doesNotMatch(JSON.stringify(control.retryEvidence), /customer@example\.com/u);
  }
});

test("purge progress is reduced to exact count-only summaries", async () => {
  const secret = "customer@example.com";
  const candidates = [
    {
      configure: () => undefined,
      analyticalPurge: { ...emptyAnalyticalPurge, detail: secret },
      rawPurge: emptyRawPurge,
    },
    {
      configure: () => undefined,
      analyticalPurge: emptyAnalyticalPurge,
      rawPurge: { ...emptyRawPurge, detail: secret },
    },
    {
      configure: (control: MemoryControl) => {
        control.controlPurgeEvidence = { ...emptyControlPurge, detail: secret };
      },
      analyticalPurge: emptyAnalyticalPurge,
      rawPurge: emptyRawPurge,
    },
  ];
  for (const candidate of candidates) {
    const control = new MemoryControl();
    candidate.configure(control);
    const processor = new DeletionProcessor(
      control,
      { purge: async () => candidate.analyticalPurge, verify: async () => emptyAnalyticalVerification },
      { purge: async () => candidate.rawPurge, verify: async () => emptyRawVerification },
      { revoke: async () => emptyRemoteRevocation },
      "a-production-proof-key-containing-more-than-32-bytes",
      "test-version",
    );

    const outcome = await processor.process(claim);

    assert.equal(outcome.status, "retry_scheduled");
    assert.equal(control.proof, null);
    assert.doesNotMatch(JSON.stringify(control.progressEvidence), /customer@example\.com/u);
    assert.doesNotMatch(JSON.stringify(control.retryEvidence), /customer@example\.com/u);
  }
});

test("retry evidence never persists arbitrary exception text", async () => {
  const control = new MemoryControl();
  const secretBearingMessage = "vendor failed for Bearer sk-super-secret account@example.com";
  const processor = new DeletionProcessor(
    control,
    { purge: async () => { throw new Error(secretBearingMessage); }, verify: async () => ({ verified: true }) },
    { purge: async () => emptyRawPurge, verify: async () => emptyRawVerification },
    { revoke: async () => emptyRemoteRevocation },
    "a-production-proof-key-containing-more-than-32-bytes",
    "test-version",
  );

  const outcome = await processor.process(claim);

  assert.equal(outcome.status, "retry_scheduled");
  const persisted = JSON.stringify(control.retryEvidence);
  assert.doesNotMatch(persisted, /sk-super-secret|account@example\.com|Bearer/);
  assert.match(String(control.retryEvidence?.correlationId), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(control.retryEvidence?.code, "unexpected_deletion_failure");
  assert.equal(control.retryEvidence?.errorClass, "internal");
});

test("a retry scheduling failure propagates and cannot be reported as completion", async () => {
  const control = new MemoryControl();
  control.retry = () => Promise.reject(Object.assign(new Error("database unavailable"), { code: "08006" }));
  const processor = new DeletionProcessor(
    control,
    { purge: async () => { throw new Error("purge failed"); }, verify: async () => ({ verified: true }) },
    { purge: async () => emptyRawPurge, verify: async () => emptyRawVerification },
    { revoke: async () => emptyRemoteRevocation },
    "a-production-proof-key-containing-more-than-32-bytes",
    "test-version",
  );

  await assert.rejects(processor.process(claim), /database unavailable/);
  assert.equal(control.proof, null);
});
