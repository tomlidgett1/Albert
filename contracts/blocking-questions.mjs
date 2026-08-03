import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import envelope from "./blocking-questions.v1.json" with { type: "json" };

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256CanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function assertBlockingQuestionContractEnvelope(candidate) {
  assert.ok(candidate && typeof candidate === "object" && !Array.isArray(candidate));
  assert.equal(
    candidate.digestAlgorithm,
    "sha256",
    "The blocking-question contract must use SHA-256.",
  );
  assert.match(candidate.digest, /^[a-f0-9]{64}$/u);
  assert.equal(
    candidate.digest,
    sha256CanonicalJson(candidate.contract),
    "The blocking-question contract changed without a matching canonical SHA-256 digest.",
  );
  return candidate;
}

assertBlockingQuestionContractEnvelope(envelope);

export const ALBERT_BLOCKING_QUESTIONS_CONTRACT = envelope.contract;
export const ALBERT_BLOCKING_QUESTIONS_CONTRACT_CANONICAL_JSON = canonicalJson(
  ALBERT_BLOCKING_QUESTIONS_CONTRACT,
);
export const ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST = sha256CanonicalJson(
  ALBERT_BLOCKING_QUESTIONS_CONTRACT,
);

export const ALBERT_BLOCKING_QUESTIONS_CONTRACT_VERSION =
  ALBERT_BLOCKING_QUESTIONS_CONTRACT.contractVersion;

export function blockingQuestionContractSqlLiteral() {
  assert.equal(
    ALBERT_BLOCKING_QUESTIONS_CONTRACT_CANONICAL_JSON.includes("$blocking_questions$"),
    false,
    "The contract cannot contain its SQL dollar-quote delimiter.",
  );
  return `$blocking_questions$${ALBERT_BLOCKING_QUESTIONS_CONTRACT_CANONICAL_JSON}$blocking_questions$`;
}
