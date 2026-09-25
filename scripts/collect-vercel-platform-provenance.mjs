import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const SHA = /^[a-f0-9]{40}$/u;
const PROJECT_ID = /^prj_[A-Za-z0-9]{16,}$/u;
const TEAM_ID = /^team_[A-Za-z0-9]{16,}$/u;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{16,}$/u;

function required(source, name) {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required.`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function vercelProvenanceDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function cleanOrigin(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "https:", "Vercel production origin must use HTTPS.");
  assert.equal(url.username, "", "Vercel production origin must not contain credentials.");
  assert.equal(url.password, "", "Vercel production origin must not contain credentials.");
  assert.equal(url.pathname, "/", "Vercel production origin must not contain a path.");
  assert.equal(url.search, "", "Vercel production origin must not contain a query.");
  assert.equal(url.hash, "", "Vercel production origin must not contain a fragment.");
  return url;
}

function exactString(value, expected, label) {
  assert.equal(value, expected, `${label} drifted.`);
  return value;
}

export function verifyVercelDeploymentProvenance(
  deployment,
  project,
  expected,
) {
  assert.ok(deployment && typeof deployment === "object" && !Array.isArray(deployment));
  assert.ok(project && typeof project === "object" && !Array.isArray(project));
  assert.match(deployment.id ?? "", DEPLOYMENT_ID, "Vercel deployment ID is invalid.");
  exactString(deployment.projectId, expected.projectId, "Vercel deployment project");
  exactString(deployment.name, expected.projectName, "Vercel deployment project name");
  exactString(deployment.target, "production", "Vercel deployment target");
  exactString(deployment.readyState, "READY", "Vercel deployment readiness");
  exactString(deployment.gitSource?.type, "github", "Vercel Git provider");
  exactString(deployment.gitSource?.ref, expected.productionBranch, "Vercel production branch");
  exactString(deployment.gitSource?.sha, expected.candidateSha, "Vercel Git commit");
  exactString(deployment.meta?.githubCommitSha, expected.candidateSha, "Vercel deployment metadata commit");
  exactString(deployment.meta?.githubCommitRef, expected.productionBranch, "Vercel deployment metadata branch");
  exactString(deployment.meta?.githubCommitOrg, expected.repositoryOwner, "Vercel repository owner");
  exactString(deployment.meta?.githubCommitRepo, expected.repositoryName, "Vercel repository name");
  const publicOrigin = cleanOrigin(expected.publicOrigin);
  assert.ok(
    Array.isArray(deployment.alias) && deployment.alias.includes(publicOrigin.hostname),
    "The exact Vercel deployment does not own the production origin.",
  );
  assert.equal(
    deployment.projectSettings?.framework,
    "nextjs",
    "The Vercel deployment must use the Next.js framework.",
  );
  assert.equal(
    deployment.projectSettings?.buildCommand,
    "next build --webpack",
    "The Vercel build command drifted.",
  );
  assert.equal(
    deployment.projectSettings?.installCommand,
    "npm ci",
    "The Vercel install command drifted.",
  );
  exactString(project.id, expected.projectId, "Vercel project");
  exactString(project.accountId, expected.teamId, "Vercel project team");
  exactString(project.name, expected.projectName, "Vercel project name");
  exactString(project.framework, "nextjs", "Vercel project framework");
  assert.equal(
    project.autoExposeSystemEnvs,
    true,
    "Vercel system environment variables must be exposed for immutable release identity.",
  );

  const observedAt = expected.observedAt ?? new Date().toISOString();
  const body = Object.freeze({
    schemaVersion: 1,
    kind: "albert.vercel-platform-provenance",
    observedAt,
    repository: `${expected.repositoryOwner}/${expected.repositoryName}`,
    candidateSha: expected.candidateSha,
    productionBranch: expected.productionBranch,
    project: Object.freeze({
      id: expected.projectId,
      teamId: expected.teamId,
      name: expected.projectName,
      autoExposeSystemEnvs: true,
    }),
    deployment: Object.freeze({
      id: deployment.id,
      url: deployment.url,
      aliases: Object.freeze([...deployment.alias].sort()),
      target: deployment.target,
      readyState: deployment.readyState,
      createdAt: deployment.createdAt,
      gitSource: Object.freeze({
        type: deployment.gitSource.type,
        ref: deployment.gitSource.ref,
        sha: deployment.gitSource.sha,
      }),
    }),
  });
  return Object.freeze({ ...body, provenanceDigest: vercelProvenanceDigest(body) });
}

async function vercelJson(fetchImpl, token, pathname, teamId) {
  const url = new URL(pathname, "https://api.vercel.com");
  url.searchParams.set("teamId", teamId);
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.ok, true, `Vercel metadata request failed with status ${response.status}.`);
  return response.json();
}

export async function collectVercelPlatformProvenance({
  source = process.env,
  fetchImpl = fetch,
  observedAt = new Date().toISOString(),
} = {}) {
  const token = required(source, "ALBERT_VERCEL_READ_TOKEN");
  const projectId = required(source, "ALBERT_VERCEL_PROJECT_ID");
  const teamId = required(source, "ALBERT_VERCEL_TEAM_ID");
  const projectName = required(source, "ALBERT_VERCEL_PROJECT_NAME");
  const candidateSha = required(source, "ALBERT_RELEASE_CANDIDATE_SHA");
  const productionBranch = required(source, "ALBERT_VERCEL_PRODUCTION_BRANCH");
  const publicOrigin = required(source, "ALBERT_PUBLIC_ORIGIN");
  const repository = required(source, "GITHUB_REPOSITORY").split("/");
  assert.equal(repository.length, 2, "GITHUB_REPOSITORY is invalid.");
  assert.match(projectId, PROJECT_ID, "ALBERT_VERCEL_PROJECT_ID is invalid.");
  assert.match(teamId, TEAM_ID, "ALBERT_VERCEL_TEAM_ID is invalid.");
  assert.match(candidateSha, SHA, "ALBERT_RELEASE_CANDIDATE_SHA is invalid.");
  assert.equal(productionBranch, "main", "Vercel production branch must be main.");

  const listed = await vercelJson(
    fetchImpl,
    token,
    `/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&state=READY&limit=100`,
    teamId,
  );
  const matching = (Array.isArray(listed?.deployments) ? listed.deployments : []).filter(
    (deployment) =>
      deployment?.meta?.githubCommitSha === candidateSha &&
      deployment?.target === "production" &&
      deployment?.readyState === "READY",
  );
  assert.ok(matching.length > 0, "No ready Vercel production deployment exists for the candidate.");
  assert.ok(matching.length <= 20, "Too many candidate deployments exist for bounded provenance collection.");
  const deploymentIds = matching.map((item) => item.uid ?? item.id);
  for (const deploymentId of deploymentIds) assert.match(deploymentId ?? "", DEPLOYMENT_ID);
  const [deployments, project] = await Promise.all([
    Promise.all(
      deploymentIds.map((deploymentId) =>
        vercelJson(fetchImpl, token, `/v13/deployments/${deploymentId}`, teamId),
      ),
    ),
    vercelJson(fetchImpl, token, `/v9/projects/${projectId}`, teamId),
  ]);
  const productionHostname = cleanOrigin(publicOrigin).hostname;
  const promoted = deployments.filter(
    (deployment) =>
      Array.isArray(deployment?.alias) && deployment.alias.includes(productionHostname),
  );
  assert.equal(promoted.length, 1, "Expected one exact candidate deployment to own the Vercel production origin.");
  return verifyVercelDeploymentProvenance(promoted[0], project, {
    projectId,
    teamId,
    projectName,
    candidateSha,
    productionBranch,
    publicOrigin,
    repositoryOwner: repository[0],
    repositoryName: repository[1],
    observedAt,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = await collectVercelPlatformProvenance();
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}
