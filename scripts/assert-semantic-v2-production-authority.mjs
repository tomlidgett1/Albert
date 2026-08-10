import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const AUTHORITY_REF = /^refs\/tags\/albert-release-authority-v[1-9][0-9]*(?:\.[0-9]+){0,2}$/u;
const REPOSITORY = "tomlidgett1/Albert";
const WORKFLOW = ".github/workflows/semantic-v2-production.yml";

function required(source, name) {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required by the Semantic V2 production authority boundary.`);
  return value;
}

export function validateSemanticV2ProductionAuthority(source, checkoutSha) {
  const candidateSha = required(source, "ALBERT_RELEASE_CANDIDATE_SHA");
  assert.match(candidateSha, COMMIT_SHA, "ALBERT_RELEASE_CANDIDATE_SHA must be a full lowercase commit SHA.");
  const publicationHash = required(source, "ALBERT_SEMANTIC_V2_PUBLICATION_HASH");
  assert.match(publicationHash, SHA256, "ALBERT_SEMANTIC_V2_PUBLICATION_HASH must be an exact SHA-256 hash.");

  const repository = required(source, "GITHUB_REPOSITORY");
  assert.equal(repository, REPOSITORY, "The Semantic V2 production verifier ran in an untrusted repository.");
  assert.equal(required(source, "GITHUB_EVENT_NAME"), "workflow_dispatch",
    "Semantic V2 production verification requires an explicit workflow dispatch.");
  assert.equal(required(source, "GITHUB_REF_TYPE"), "tag",
    "Semantic V2 production verification must run from a tag ref.");
  assert.match(required(source, "GITHUB_RUN_ID"), RUN_ID, "The Semantic V2 production run ID is invalid.");
  assert.equal(required(source, "GITHUB_RUN_ATTEMPT"), "1",
    "Semantic V2 production verifier reruns are forbidden; dispatch a fresh candidate-bound run.");

  const authorityRef = required(source, "ALBERT_RELEASE_AUTHORITY_REF");
  assert.match(authorityRef, AUTHORITY_REF,
    "Semantic V2 production verification requires an immutable Albert release-authority tag.");
  const authoritySha = required(source, "ALBERT_RELEASE_AUTHORITY_TOOLING_SHA");
  assert.match(authoritySha, COMMIT_SHA,
    "ALBERT_RELEASE_AUTHORITY_TOOLING_SHA must be a full lowercase commit SHA.");
  assert.equal(required(source, "GITHUB_REF"), authorityRef,
    "The Semantic V2 production workflow was not dispatched from the protected authority ref.");
  assert.equal(required(source, "GITHUB_SHA"), authoritySha,
    "The Semantic V2 production workflow commit does not match the protected authority SHA.");
  assert.match(checkoutSha, COMMIT_SHA, "The trusted authority checkout did not resolve to a full commit SHA.");
  assert.equal(checkoutSha, authoritySha,
    "The trusted authority checkout does not match the protected authority SHA.");

  const expectedWorkflowRef = `${repository}/${WORKFLOW}@${authorityRef}`;
  assert.equal(required(source, "GITHUB_WORKFLOW_REF"), expectedWorkflowRef,
    "GitHub resolved the Semantic V2 production workflow from a different repository, path, or ref.");

  return Object.freeze({ candidateSha, publicationHash, authorityRef, authoritySha });
}

function currentCheckoutSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function main() {
  const result = validateSemanticV2ProductionAuthority(process.env, currentCheckoutSha());
  process.stdout.write(
    `Semantic V2 production authority verified for candidate ${result.candidateSha} and publication ${result.publicationHash}.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
