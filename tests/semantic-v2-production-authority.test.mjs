import assert from "node:assert/strict";
import test from "node:test";
import {
  validateSemanticV2ProductionAuthority,
} from "../scripts/assert-semantic-v2-production-authority.mjs";

const authoritySha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const publicationHash = "c".repeat(64);
const authorityRef = "refs/tags/albert-release-authority-v2";
const repository = "tomlidgett1/Albert";
const workflowRef = `${repository}/.github/workflows/semantic-v2-production.yml@${authorityRef}`;

function production(overrides = {}) {
  return {
    ALBERT_RELEASE_CANDIDATE_SHA: candidateSha,
    ALBERT_SEMANTIC_V2_PUBLICATION_HASH: publicationHash,
    ALBERT_RELEASE_AUTHORITY_TOOLING_SHA: authoritySha,
    ALBERT_RELEASE_AUTHORITY_REF: authorityRef,
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: authorityRef,
    GITHUB_REF_TYPE: "tag",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: authoritySha,
    GITHUB_WORKFLOW_REF: workflowRef,
    ...overrides,
  };
}

test("Semantic V2 production authority binds the immutable workflow and exact inputs", () => {
  assert.deepEqual(validateSemanticV2ProductionAuthority(production(), authoritySha), {
    candidateSha,
    publicationHash,
    authorityRef,
    authoritySha,
  });
});

for (const [name, overrides, checkoutSha, message] of [
  ["mutable branch", { ALBERT_RELEASE_AUTHORITY_REF: "refs/heads/main", GITHUB_REF: "refs/heads/main" }, authoritySha, /immutable Albert release-authority tag/u],
  ["wrong event ref", { GITHUB_REF: "refs/tags/albert-release-authority-v3" }, authoritySha, /not dispatched from the protected authority/u],
  ["wrong event SHA", { GITHUB_SHA: "d".repeat(40) }, authoritySha, /does not match the protected authority SHA/u],
  ["wrong checkout", {}, "d".repeat(40), /trusted authority checkout does not match/u],
  ["wrong workflow path", { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release-authority.yml@${authorityRef}` }, authoritySha, /different repository, path, or ref/u],
  ["wrong repository", { GITHUB_REPOSITORY: "attacker/Albert" }, authoritySha, /untrusted repository/u],
  ["non-dispatch event", { GITHUB_EVENT_NAME: "push" }, authoritySha, /explicit workflow dispatch/u],
  ["rerun", { GITHUB_RUN_ATTEMPT: "2" }, authoritySha, /reruns are forbidden/u],
  ["abbreviated candidate", { ALBERT_RELEASE_CANDIDATE_SHA: "b".repeat(7) }, authoritySha, /full lowercase commit SHA/u],
  ["abbreviated publication", { ALBERT_SEMANTIC_V2_PUBLICATION_HASH: "c".repeat(12) }, authoritySha, /exact SHA-256/u],
]) {
  test(`Semantic V2 production authority rejects ${name}`, () => {
    assert.throws(
      () => validateSemanticV2ProductionAuthority(production(overrides), checkoutSha),
      message,
    );
  });
}
