import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const AUTHORITY_REF = /^refs\/tags\/albert-release-authority-v[1-9][0-9]*(?:\.[0-9]+){0,2}$/u;
const RELEASE_WORKFLOW = ".github/workflows/release-authority.yml";
const RELEASE_REPOSITORY = "tomlidgett1/Albert";

function required(source, name) {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required by the release authority boundary.`);
  return value;
}

export function validateReleaseAuthority(source, checkoutSha) {
  const environment = required(source, "ALBERT_RELEASE_ENVIRONMENT");
  assert.equal(environment, "production", "Immutable release authority is production-only.");

  const candidateSha = required(source, "ALBERT_RELEASE_CANDIDATE_SHA");
  assert.match(candidateSha, COMMIT_SHA, "ALBERT_RELEASE_CANDIDATE_SHA must be a full lowercase commit SHA.");

  const repository = required(source, "GITHUB_REPOSITORY");
  assert.equal(repository, RELEASE_REPOSITORY, "The release authority ran in an untrusted repository.");
  assert.equal(required(source, "GITHUB_EVENT_NAME"), "workflow_dispatch",
    "The release authority must be started by an explicit workflow dispatch.");
  assert.equal(required(source, "GITHUB_REF_TYPE"), "tag",
    "The release authority must run from a tag ref.");
  assert.match(required(source, "GITHUB_RUN_ID"), RUN_ID, "The release authority run ID is invalid.");
  assert.equal(required(source, "GITHUB_RUN_ATTEMPT"), "1",
    "Release-authority reruns are forbidden; dispatch a fresh candidate-bound run.");
  const authoritySha = required(source, "ALBERT_RELEASE_AUTHORITY_TOOLING_SHA");
  assert.match(authoritySha, COMMIT_SHA, "ALBERT_RELEASE_AUTHORITY_TOOLING_SHA must be a full lowercase commit SHA.");
  const authorityRef = required(source, "ALBERT_RELEASE_AUTHORITY_REF");
  assert.match(authorityRef, AUTHORITY_REF, "Production releases must run from an immutable Albert release-authority tag.");
  const authorityWorkflowRef = required(source, "ALBERT_RELEASE_AUTHORITY_WORKFLOW_REF");

  assert.equal(
    required(source, "GITHUB_REF"),
    authorityRef,
    "The production workflow was not dispatched from the protected release-authority ref.",
  );
  assert.equal(
    required(source, "GITHUB_SHA"),
    authoritySha,
    "The production workflow commit does not match the protected release-authority tooling SHA.",
  );
  assert.match(checkoutSha, COMMIT_SHA, "The trusted checkout did not resolve to a full commit SHA.");
  assert.equal(
    checkoutSha,
    authoritySha,
    "The trusted release checkout does not match the protected release-authority tooling SHA.",
  );
  assert.equal(
    required(source, "GITHUB_WORKFLOW_REF"),
    authorityWorkflowRef,
    "GitHub resolved the release workflow from a different repository, path, or ref.",
  );
  assert.equal(
    authorityWorkflowRef,
    `${repository}/${RELEASE_WORKFLOW}@${authorityRef}`,
    "The protected authority workflow ref does not match its repository, path, and tag.",
  );

  return Object.freeze({ environment, candidateSha, authoritySha, authorityRef });
}

function currentCheckoutSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function main() {
  const result = validateReleaseAuthority(process.env, currentCheckoutSha());
  process.stdout.write(
    `release authority verified for ${result.environment} candidate ${result.candidateSha}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
