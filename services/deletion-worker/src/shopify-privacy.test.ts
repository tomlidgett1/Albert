import assert from "node:assert/strict";
import test from "node:test";
import {
  ShopifyPrivacyProcessor,
  type ShopifyPrivacyClaim,
  type ShopifyPrivacyControlPort,
} from "./shopify-privacy.js";

const caseId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const claim = (topic: ShopifyPrivacyClaim["topic"]): ShopifyPrivacyClaim => Object.freeze({
  messageId: 19,
  readCount: 1,
  visibilityDeadline: "2026-08-12T01:15:00.000Z",
  inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  topic,
  caseIds: Object.freeze([caseId]),
  completeBy: "2026-09-11T01:00:00.000Z",
});

class MemoryPrivacyControl implements ShopifyPrivacyControlPort {
  readonly calls: string[] = [];
  dispatchCount = 1;
  prepareCount = 1;
  failDispatch = false;
  retryState: "retry_wait" | "attention_required" = "retry_wait";
  retryEvidence: Readonly<Record<string, unknown>> | null = null;

  claim() { return Promise.resolve(null); }
  dispatchRedaction() {
    this.calls.push("dispatch:redaction");
    if (this.failDispatch) throw Object.assign(new Error("private database detail"), { code: "40001" });
    return Promise.resolve(this.dispatchCount);
  }
  prepareDataRequest() { this.calls.push("prepare:data_request"); return Promise.resolve(this.prepareCount); }
  complete() { this.calls.push("complete:queue"); return Promise.resolve(); }
  retry(_claim: ShopifyPrivacyClaim, evidence: Readonly<Record<string, unknown>>) {
    this.calls.push("retry");
    this.retryEvidence = evidence;
    return Promise.resolve(this.retryState);
  }
  reconcile() { return Promise.resolve({}); }
  metrics() { return Promise.resolve({}); }
  preflight() { return Promise.resolve(); }
}

test("customer redaction dispatches verified deletion before acknowledging privacy queue", async () => {
  const control = new MemoryPrivacyControl();
  const outcome = await new ShopifyPrivacyProcessor(control).process(claim("customers/redact"));

  assert.deepEqual(control.calls, ["dispatch:redaction", "complete:queue"]);
  assert.deepEqual(outcome, { status: "dispatched", topic: "customers/redact" });
});

test("data request becomes operator-actionable before acknowledging privacy queue", async () => {
  const control = new MemoryPrivacyControl();
  const outcome = await new ShopifyPrivacyProcessor(control).process(claim("customers/data_request"));

  assert.deepEqual(control.calls, ["prepare:data_request", "complete:queue"]);
  assert.deepEqual(outcome, { status: "dispatched", topic: "customers/data_request" });
});

test("privacy retry evidence excludes exception messages and PII", async () => {
  const control = new MemoryPrivacyControl();
  control.failDispatch = true;
  const outcome = await new ShopifyPrivacyProcessor(control).process(claim("customers/redact"));

  assert.equal(outcome.status, "retry_scheduled");
  assert.equal(control.retryEvidence?.code, "database_serialization_conflict");
  assert.equal(JSON.stringify(control.retryEvidence).includes("private database detail"), false);
  assert.deepEqual(Object.keys(control.retryEvidence ?? {}).sort(), [
    "code","correlationId","errorClass","failedAt","retryable",
  ]);
});

test("cardinality mismatch is never represented as successful dispatch", async () => {
  const control = new MemoryPrivacyControl();
  control.prepareCount = 0;

  const outcome = await new ShopifyPrivacyProcessor(control).process(claim("customers/data_request"));

  assert.equal(outcome.status, "retry_scheduled");
  assert.deepEqual(control.calls, ["prepare:data_request", "retry"]);
});
