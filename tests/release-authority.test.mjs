import assert from "node:assert/strict";
import test from "node:test";
import { validateReleaseAuthority } from "../scripts/assert-release-authority.mjs";

const authoritySha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const authorityRef = "refs/tags/albert-release-authority-v1";
const repository = "tomlidgett1/Albert";

function production(overrides = {}) {
  return {
    ALBERT_RELEASE_ENVIRONMENT: "production",
    ALBERT_RELEASE_CANDIDATE_SHA: candidateSha,
    ALBERT_RELEASE_AUTHORITY_TOOLING_SHA: authoritySha,
    ALBERT_RELEASE_AUTHORITY_REF: authorityRef,
    ALBERT_RELEASE_AUTHORITY_WORKFLOW_REF: `${repository}/.github/workflows/release-authority.yml@${authorityRef}`,
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: authorityRef,
    GITHUB_REF_TYPE: "tag",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: authoritySha,
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release-authority.yml@${authorityRef}`,
    ...overrides,
  };
}

test("production release authority binds workflow, tag, tooling checkout, and candidate", () => {
  assert.deepEqual(
    validateReleaseAuthority(production(), authoritySha),
    {
      environment: "production",
      candidateSha,
      authoritySha,
      authorityRef,
    },
  );
});

for (const [name, overrides, checkoutSha, message] of [
  ["staging mode", { ALBERT_RELEASE_ENVIRONMENT: "staging" }, authoritySha, /production-only/u],
  ["mutable branch ref", { GITHUB_REF: "refs/heads/main", ALBERT_RELEASE_AUTHORITY_REF: "refs/heads/main" }, authoritySha, /immutable Albert release-authority tag/u],
  ["wrong event ref", { GITHUB_REF: "refs/tags/albert-release-authority-v2" }, authoritySha, /not dispatched from the protected/u],
  ["wrong event SHA", { GITHUB_SHA: "c".repeat(40) }, authoritySha, /workflow commit does not match/u],
  ["wrong checkout", {}, "c".repeat(40), /trusted release checkout does not match/u],
  ["wrong workflow path", { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release.yml@${authorityRef}` }, authoritySha, /different repository, path, or ref/u],
  ["wrong repository", { GITHUB_REPOSITORY: "attacker/Albert" }, authoritySha, /untrusted repository/u],
  ["non-dispatch event", { GITHUB_EVENT_NAME: "push" }, authoritySha, /explicit workflow dispatch/u],
  ["rerun", { GITHUB_RUN_ATTEMPT: "2" }, authoritySha, /reruns are forbidden/u],
  ["abbreviated candidate", { ALBERT_RELEASE_CANDIDATE_SHA: "b".repeat(7) }, authoritySha, /full lowercase commit SHA/u],
]) {
  test(`production authority rejects ${name}`, () => {
    assert.throws(() => validateReleaseAuthority(production(overrides), checkoutSha), message);
  });
}
