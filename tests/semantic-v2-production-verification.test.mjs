import assert from "node:assert/strict";
import test from "node:test";
import { verifySemanticV2Production } from "../scripts/verify-semantic-v2-production.mjs";

const candidateSha = "a".repeat(40);
const publicationHash = "b".repeat(64);
const projectId = "prj_l5faWCnDWxw7QB7nBWgr9zaKFxuL";
const teamId = "team_wx7OlK7ikXNuFcOSaewRxonA";
const deploymentId = "dpl_9rT2LFnsfT2RGbzwkgcvTzd8vcdH";
const source = {
  ALBERT_RELEASE_CANDIDATE_SHA: candidateSha,
  ALBERT_SEMANTIC_V2_PUBLICATION_HASH: publicationHash,
  CONTROL_PLANE_ADMIN_DATABASE_URL: "postgresql://test.invalid/albert",
  SEMANTIC_QUERY_SERVICE_URL: "https://semantic.example",
  ALBERT_PUBLIC_ORIGIN: "https://albert-chi.vercel.app",
  ALBERT_VERCEL_READ_TOKEN: "never-render-this-token",
  ALBERT_VERCEL_PROJECT_ID: projectId,
  ALBERT_VERCEL_TEAM_ID: teamId,
  ALBERT_VERCEL_PROJECT_NAME: "albert",
  ALBERT_VERCEL_PRODUCTION_BRANCH: "main",
  GITHUB_REPOSITORY: "tomlidgett1/Albert",
};

function qualification(overrides = {}) {
  return {
    qualification_id: "01KZ0000000000000000000000",
    publication_hash: publicationHash,
    commit_sha: candidateSha,
    status: "passed",
    active_publication_hash: publicationHash,
    deterministic_receipt: {
      status: "passed",
      publicationHash,
      commit: candidateSha,
      suites: [{ name: "physical-staging-contract", status: "passed" }],
    },
    model_evaluation_receipt: {
      launch: {
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        processingMode: "standard",
        fastMode: false,
        proMode: false,
        caseCount: 200,
        publicationHash,
        commit: candidateSha,
      },
      grade: {
        status: "passed",
        caseCount: 200,
        gates: { numericalAccuracy: true, humanReview: true },
        releaseBinding: { publicationHash, commit: candidateSha },
      },
    },
    ...overrides,
  };
}

function databaseClientFactory(row) {
  return () => ({
    async connect() {},
    async end() {},
    async query(text) {
      if (/^SELECT q\.qualification_id/u.test(text.trim())) return { rows: [row] };
      return { rows: [] };
    },
  });
}

function deployment() {
  return {
    id: deploymentId,
    name: "albert",
    url: "albert-exact.vercel.app",
    target: "production",
    readyState: "READY",
    createdAt: 1_786_227_922_658,
    projectId,
    meta: {
      githubCommitSha: candidateSha,
      githubCommitRef: "main",
      githubCommitOrg: "tomlidgett1",
      githubCommitRepo: "Albert",
    },
    gitSource: { type: "github", ref: "main", sha: candidateSha },
    alias: ["albert-chi.vercel.app"],
    projectSettings: {
      framework: "nextjs",
      buildCommand: "next build --webpack",
      installCommand: "npm ci",
    },
  };
}

function fetchFixture() {
  return async (input) => {
    const url = new URL(input);
    if (url.pathname === "/v6/deployments") {
      return Response.json({
        deployments: [
          {
            uid: deploymentId,
            target: "production",
            readyState: "READY",
            meta: { githubCommitSha: candidateSha },
          },
        ],
      });
    }
    if (url.pathname === `/v13/deployments/${deploymentId}`)
      return Response.json(deployment());
    if (url.pathname === `/v9/projects/${projectId}`) {
      return Response.json({
        id: projectId,
        accountId: teamId,
        name: "albert",
        framework: "nextjs",
        autoExposeSystemEnvs: true,
      });
    }
    if (url.hostname === "semantic.example") {
      return Response.json({
        status: "ready",
        analyticalRuntime: "v2",
        v2PublicationHash: publicationHash,
        releaseSha: candidateSha,
        deploymentId: "fly-semantic-release-1",
      });
    }
    if (url.hostname === "albert-chi.vercel.app") {
      return Response.json({
        status: "ready",
        releaseSha: candidateSha,
        deploymentId,
      });
    }
    return new Response(null, { status: 404 });
  };
}

test("production verification binds active qualification, Luna Max, Vercel, and V2 readiness", async () => {
  const receipt = await verifySemanticV2Production({
    source,
    fetchImpl: fetchFixture(),
    databaseClientFactory: databaseClientFactory(qualification()),
    now: new Date("2026-08-10T00:00:00.000Z"),
  });
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.candidateSha, candidateSha);
  assert.equal(receipt.publicationHash, publicationHash);
  assert.equal(receipt.web.deploymentId, deploymentId);
  assert.match(receipt.verificationDigest, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(receipt), /never-render-this-token/u);
});

test("production verification rejects inactive publications and failed independent grading", async () => {
  await assert.rejects(
    verifySemanticV2Production({
      source,
      fetchImpl: fetchFixture(),
      databaseClientFactory: databaseClientFactory(
        qualification({ active_publication_hash: "c".repeat(64) }),
      ),
    }),
    /not active/u,
  );
  const failedGrade = qualification();
  failedGrade.model_evaluation_receipt.grade.gates.humanReview = false;
  await assert.rejects(
    verifySemanticV2Production({
      source,
      fetchImpl: fetchFixture(),
      databaseClientFactory: databaseClientFactory(failedGrade),
    }),
    /human-review gate/u,
  );
});
