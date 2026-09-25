import assert from "node:assert/strict";
import test from "node:test";
import {
  collectVercelPlatformProvenance,
  verifyVercelDeploymentProvenance,
} from "../scripts/collect-vercel-platform-provenance.mjs";

const candidateSha = "a".repeat(40);
const projectId = "prj_l5faWCnDWxw7QB7nBWgr9zaKFxuL";
const teamId = "team_wx7OlK7ikXNuFcOSaewRxonA";
const deploymentId = "dpl_9rT2LFnsfT2RGbzwkgcvTzd8vcdH";
const source = {
  ALBERT_VERCEL_READ_TOKEN: "secret-never-rendered",
  ALBERT_VERCEL_PROJECT_ID: projectId,
  ALBERT_VERCEL_TEAM_ID: teamId,
  ALBERT_VERCEL_PROJECT_NAME: "albert",
  ALBERT_RELEASE_CANDIDATE_SHA: candidateSha,
  ALBERT_VERCEL_PRODUCTION_BRANCH: "main",
  ALBERT_PUBLIC_ORIGIN: "https://albert-chi.vercel.app",
  GITHUB_REPOSITORY: "tomlidgett1/Albert",
};

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
    alias: ["albert-chi.vercel.app", "albert-exact.vercel.app"],
    projectSettings: {
      framework: "nextjs",
      buildCommand: "next build --webpack",
      installCommand: "npm ci",
    },
  };
}

const project = {
  id: projectId,
  accountId: teamId,
  name: "albert",
  framework: "nextjs",
  autoExposeSystemEnvs: true,
};

test("Vercel provenance binds one exact ready main deployment", () => {
  const manifest = verifyVercelDeploymentProvenance(deployment(), project, {
    projectId,
    teamId,
    projectName: "albert",
    candidateSha,
    productionBranch: "main",
    publicOrigin: source.ALBERT_PUBLIC_ORIGIN,
    repositoryOwner: "tomlidgett1",
    repositoryName: "Albert",
    observedAt: "2026-08-10T00:00:00.000Z",
  });
  assert.equal(manifest.candidateSha, candidateSha);
  assert.equal(manifest.deployment.id, deploymentId);
  assert.match(manifest.provenanceDigest, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(manifest), /secret/u);
});

test("Vercel provenance rejects branch, candidate, alias, and system-env drift", () => {
  for (const changed of [
    { ...deployment(), gitSource: { type: "github", ref: "feature", sha: candidateSha } },
    { ...deployment(), meta: { ...deployment().meta, githubCommitSha: "b".repeat(40) } },
    { ...deployment(), alias: ["another.vercel.app"] },
  ]) {
    assert.throws(() =>
      verifyVercelDeploymentProvenance(changed, project, {
        projectId,
        teamId,
        projectName: "albert",
        candidateSha,
        productionBranch: "main",
        publicOrigin: source.ALBERT_PUBLIC_ORIGIN,
        repositoryOwner: "tomlidgett1",
        repositoryName: "Albert",
      }),
    );
  }
  assert.throws(() =>
    verifyVercelDeploymentProvenance(deployment(), { ...project, autoExposeSystemEnvs: false }, {
      projectId,
      teamId,
      projectName: "albert",
      candidateSha,
      productionBranch: "main",
      publicOrigin: source.ALBERT_PUBLIC_ORIGIN,
      repositoryOwner: "tomlidgett1",
      repositoryName: "Albert",
    }),
  );
});

test("collector queries metadata without returning its bearer token", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.authorization });
    const pathname = new URL(url).pathname;
    if (pathname === "/v6/deployments") {
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
    if (pathname === `/v13/deployments/${deploymentId}`)
      return Response.json(deployment());
    if (pathname === `/v9/projects/${projectId}`)
      return Response.json(project);
    return new Response(null, { status: 404 });
  };
  const manifest = await collectVercelPlatformProvenance({
    source,
    fetchImpl,
    observedAt: "2026-08-10T00:00:00.000Z",
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ authorization }) => authorization === "Bearer secret-never-rendered"));
  assert.doesNotMatch(JSON.stringify(manifest), /secret-never-rendered/u);
});

test("collector selects the one promoted deployment when a commit was redeployed", async () => {
  const oldDeploymentId = "dpl_7Gw5ZMBpQA8h9GF832KGp7nwbuh3";
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/v6/deployments") {
      return Response.json({
        deployments: [deploymentId, oldDeploymentId].map((uid) => ({
          uid,
          target: "production",
          readyState: "READY",
          meta: { githubCommitSha: candidateSha },
        })),
      });
    }
    if (pathname === `/v13/deployments/${deploymentId}`)
      return Response.json(deployment());
    if (pathname === `/v13/deployments/${oldDeploymentId}`)
      return Response.json({
        ...deployment(),
        id: oldDeploymentId,
        alias: ["albert-old.vercel.app"],
      });
    if (pathname === `/v9/projects/${projectId}`)
      return Response.json(project);
    return new Response(null, { status: 404 });
  };
  const manifest = await collectVercelPlatformProvenance({ source, fetchImpl });
  assert.equal(manifest.deployment.id, deploymentId);
});
