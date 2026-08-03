import assert from "node:assert/strict";
import test from "node:test";
import { DeletionProcessor, type DeletionControlPort } from "./processor.js";
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

class MemoryControl implements DeletionControlPort {
  readonly calls: string[] = [];
  proof: Parameters<DeletionControlPort["complete"]>[1] | null = null;
  retried = false;
  retryEvidence: Readonly<Record<string, unknown>> | null = null;
  extend() { this.calls.push("extend"); return Promise.resolve(); }
  revocationContext() { return Promise.resolve({ priorStatus: "succeeded", priorProgress: {}, targets: [] }); }
  destroyCredentials() { this.calls.push("destroy"); return Promise.resolve(); }
  credentialVerification() { return Promise.resolve({ verified: true, tokenReferences: 0 }); }
  assertQuiescent() { this.calls.push("quiescent"); return Promise.resolve({ verified: true, activeWritePermits: 0 }); }
  progress(_claim: DeletionClaim, stage: string) { this.calls.push(`progress:${stage}`); return Promise.resolve(); }
  purge() { this.calls.push("control:purge"); return Promise.resolve({ verified: true }); }
  verify() { this.calls.push("control:verify"); return Promise.resolve({ verified: true }); }
  markVerifying() { this.calls.push("verifying"); return Promise.resolve(); }
  complete(_claim: DeletionClaim, proof: Parameters<DeletionControlPort["complete"]>[1]) {
    this.calls.push("complete"); this.proof = proof; return Promise.resolve();
  }
  retry(_claim: DeletionClaim, evidence: Readonly<Record<string, unknown>>) {
    this.retried = true;
    this.retryEvidence = evidence;
    return Promise.resolve();
  }
}

test("deletion processor orders quiescence, purge, cross-store verification, and immutable proof", async () => {
  const control = new MemoryControl();
  const processor = new DeletionProcessor(
    control,
    { purge: async () => ({ verified: true }), verify: async () => ({ verified: true }) },
    { purge: async () => ({ verified: true, objectsRemoved: 2 }), verify: async () => ({ verified: true, remainingObjects: 0 }) },
    { revoke: async () => ({ bestEffort: true, targets: [] }) },
    "a-production-proof-key-containing-more-than-32-bytes",
    "test-version",
  );

  await processor.process(claim);

  assert.equal(control.retried, false);
  assert.ok(control.calls.indexOf("quiescent") < control.calls.indexOf("control:purge"));
  assert.ok(control.calls.indexOf("verifying") < control.calls.indexOf("control:verify"));
  assert.equal(control.calls.at(-1), "complete");
  assert.match(control.proof?.tenantReferenceHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(control.proof?.proofDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(control.proof?.connectionReferenceHash?.length, 64);
});

test("a failed store verification is durably retried and never proven", async () => {
  const control = new MemoryControl();
  const processor = new DeletionProcessor(
    control,
    { purge: async () => ({ verified: true }), verify: async () => ({ verified: false, remainingRows: 1 }) },
    { purge: async () => ({ verified: true }), verify: async () => ({ verified: true }) },
    { revoke: async () => ({ bestEffort: true }) },
    "a-production-proof-key-containing-more-than-32-bytes",
    "test-version",
  );

  await processor.process(claim);

  assert.equal(control.retried, true);
  assert.equal(control.proof, null);
  assert.deepEqual(
    Object.keys(control.retryEvidence ?? {}).sort(),
    ["code", "correlationId", "errorClass", "failedAt", "retryable"],
  );
  assert.doesNotMatch(JSON.stringify(control.retryEvidence), /analytical_deletion_not_verified/);
});

test("retry evidence never persists arbitrary exception text", async () => {
  const control = new MemoryControl();
  const secretBearingMessage = "vendor failed for Bearer sk-super-secret account@example.com";
  const processor = new DeletionProcessor(
    control,
    { purge: async () => { throw new Error(secretBearingMessage); }, verify: async () => ({ verified: true }) },
    { purge: async () => ({ verified: true }), verify: async () => ({ verified: true }) },
    { revoke: async () => ({ bestEffort: true }) },
    "a-production-proof-key-containing-more-than-32-bytes",
    "test-version",
  );

  await processor.process(claim);

  const persisted = JSON.stringify(control.retryEvidence);
  assert.doesNotMatch(persisted, /sk-super-secret|account@example\.com|Bearer/);
  assert.match(String(control.retryEvidence?.correlationId), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(control.retryEvidence?.code, "unexpected_deletion_failure");
  assert.equal(control.retryEvidence?.errorClass, "internal");
});
