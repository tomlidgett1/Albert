import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DIGITS = /^[1-9][0-9]{0,19}$/u;
const IMAGE = /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.\/-]+@sha256:[a-f0-9]{64}$/u;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const RELEASE_REPOSITORY = "tomlidgett1/Albert";
const RELEASE_WORKFLOW = ".github/workflows/release-authority.yml";
const DOGFOOD_WORKFLOW = ".github/workflows/dogfood-acceptance.yml";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SURFACE_BYTES = 256 * 1024 * 1024;

export const RELEASE_AUTHORITY_SURFACE_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  "Dockerfile.services",
  "connectors",
  "contracts",
  "deploy/capacity",
  "deploy/fly",
  "deploy/fly-autoscalers",
  "deploy/runtime-contract.json",
  "evals/golden",
  "infra/bootstrap-upgrades",
  "infra/migrations",
  "package-lock.json",
  "package.json",
  "packages",
  "scripts",
  "tsconfig.json",
]);

function required(source, name) {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required to create the release plan.`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function collect(root, relativePath, records, counter) {
  const absolute = path.resolve(root, relativePath);
  assert.ok(
    absolute === path.resolve(root) || absolute.startsWith(`${path.resolve(root)}${path.sep}`),
    "Release authority surface path escaped its root.",
  );
  const metadata = await lstat(absolute);
  assert.equal(metadata.isSymbolicLink(), false, `Release authority surface forbids symlink ${relativePath}.`);
  if (metadata.isDirectory()) {
    records.push(`directory\0${relativePath}\0${metadata.mode & 0o777}`);
    const entries = await readdir(absolute);
    entries.sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      await collect(root, path.posix.join(relativePath, entry), records, counter);
    }
    return;
  }
  assert.equal(metadata.isFile(), true, `Release authority surface contains non-file ${relativePath}.`);
  assert.ok(metadata.size <= MAX_FILE_BYTES, `Release authority surface file ${relativePath} is too large.`);
  counter.bytes += metadata.size;
  assert.ok(counter.bytes <= MAX_SURFACE_BYTES, "Release authority surface is too large.");
  const body = await readFile(absolute);
  records.push(`file\0${relativePath}\0${metadata.mode & 0o777}\0${metadata.size}\0${sha256(body)}`);
}

export async function digestReleaseAuthoritySurface(root) {
  const records = [];
  const counter = { bytes: 0 };
  for (const relativePath of RELEASE_AUTHORITY_SURFACE_PATHS) {
    await collect(root, relativePath, records, counter);
  }
  return Object.freeze({
    digest: sha256(`${records.join("\n")}\n`),
    fileRecordCount: records.filter((record) => record.startsWith("file\0")).length,
    byteCount: counter.bytes,
  });
}

function gitHead(root) {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function assertCleanCheckout(root, label) {
  const status = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  assert.equal(status, "", `${label} checkout contains uncommitted filesystem drift.`);
}

export async function createReleasePlan(source, outputPath) {
  assert.ok(outputPath, "Release plan output path is required.");
  const authorityRoot = path.resolve(required(source, "ALBERT_RELEASE_AUTHORITY_ROOT"));
  const candidateRoot = path.resolve(required(source, "ALBERT_RELEASE_CANDIDATE_ROOT"));
  assert.notEqual(authorityRoot, candidateRoot, "Authority and candidate checkouts must be separate paths.");
  assert.ok(
    !authorityRoot.startsWith(`${candidateRoot}${path.sep}`)
      && !candidateRoot.startsWith(`${authorityRoot}${path.sep}`),
    "Authority and candidate checkouts must be disjoint paths.",
  );

  const authoritySha = required(source, "ALBERT_RELEASE_AUTHORITY_TOOLING_SHA");
  const candidateSha = required(source, "ALBERT_RELEASE_CANDIDATE_SHA");
  assert.match(authoritySha, COMMIT_SHA, "Authority SHA must be a full lowercase commit SHA.");
  assert.match(candidateSha, COMMIT_SHA, "Candidate SHA must be a full lowercase commit SHA.");
  assert.equal(gitHead(authorityRoot), authoritySha, "Authority checkout SHA drifted before plan creation.");
  assert.equal(gitHead(candidateRoot), candidateSha, "Candidate checkout SHA drifted before plan creation.");
  assertCleanCheckout(authorityRoot, "Authority");
  assertCleanCheckout(candidateRoot, "Candidate");

  const authorityRef = required(source, "ALBERT_RELEASE_AUTHORITY_REF");
  assert.match(authorityRef, /^refs\/tags\/albert-release-authority-v[1-9][0-9]*(?:\.[0-9]+){0,2}$/u,
    "Authority ref is not an immutable release-authority tag.");
  const servicesImage = required(source, "ALBERT_RELEASE_SERVICES_IMAGE");
  assert.match(servicesImage, IMAGE, "Candidate services image must be a GHCR digest reference.");
  const releaseRunId = required(source, "GITHUB_RUN_ID");
  const dogfoodRunId = required(source, "ALBERT_DOGFOOD_RUN_ID");
  const dogfoodArtifactId = required(source, "ALBERT_DOGFOOD_ARTIFACT_ID");
  const dogfoodArtifactDigest = required(source, "ALBERT_DOGFOOD_ARTIFACT_DIGEST");
  assert.match(releaseRunId, DIGITS, "Release run ID is invalid.");
  assert.match(dogfoodRunId, DIGITS, "Dogfood run ID is invalid.");
  assert.match(dogfoodArtifactId, DIGITS, "Dogfood artifact ID is invalid.");
  assert.match(dogfoodArtifactDigest, ARTIFACT_DIGEST, "Dogfood artifact digest is invalid.");
  const repository = required(source, "GITHUB_REPOSITORY");
  assert.equal(repository, RELEASE_REPOSITORY, "Release plan repository is not trusted.");
  const workflowRef = required(source, "GITHUB_WORKFLOW_REF");
  assert.equal(workflowRef, `${repository}/${RELEASE_WORKFLOW}@${authorityRef}`,
    "Release plan workflow identity is invalid.");
  const workflowActorId = required(source, "GITHUB_ACTOR_ID");
  const workflowActorLogin = required(source, "GITHUB_ACTOR");
  assert.match(workflowActorId, DIGITS, "Release workflow actor ID is invalid.");
  assert.match(workflowActorLogin, GITHUB_LOGIN, "Release workflow actor login is invalid.");
  const releaseRunAttempt = required(source, "GITHUB_RUN_ATTEMPT");
  assert.match(releaseRunAttempt, DIGITS, "Release run attempt is invalid.");
  assert.equal(releaseRunAttempt, "1", "Release plans cannot be created by a rerun attempt.");
  const ciWorkflowId = required(source, "ALBERT_RELEASE_CI_WORKFLOW_ID");
  const ciRunId = required(source, "ALBERT_RELEASE_CI_RUN_ID");
  const ciRunAttempt = required(source, "ALBERT_RELEASE_CI_RUN_ATTEMPT");
  const ciCheckSuiteId = required(source, "ALBERT_RELEASE_CI_CHECK_SUITE_ID");
  for (const [name, value] of Object.entries({ ciWorkflowId, ciRunId, ciRunAttempt, ciCheckSuiteId })) {
    assert.match(value, DIGITS, `${name} is invalid.`);
  }
  assert.equal(ciRunAttempt, "1", "Release CI must be from its first run attempt.");

  const [authoritySurface, candidateSurface] = await Promise.all([
    digestReleaseAuthoritySurface(authorityRoot),
    digestReleaseAuthoritySurface(candidateRoot),
  ]);
  assert.equal(
    candidateSurface.digest,
    authoritySurface.digest,
    "Candidate privileged release surface differs from the immutable authority; mint a reviewed authority tag.",
  );
  assert.equal(candidateSurface.fileRecordCount, authoritySurface.fileRecordCount,
    "Candidate privileged release surface file inventory differs from authority.");
  assert.equal(candidateSurface.byteCount, authoritySurface.byteCount,
    "Candidate privileged release surface byte inventory differs from authority.");

  const planWithoutDigest = {
    schemaVersion: 2,
    kind: "albert.production-release-plan",
    repository,
    authority: {
      ref: authorityRef,
      sha: authoritySha,
      workflowRef,
    },
    candidate: {
      sha: candidateSha,
      servicesImage,
      privilegedSurfaceDigest: authoritySurface.digest,
      privilegedFileRecordCount: authoritySurface.fileRecordCount,
      privilegedByteCount: authoritySurface.byteCount,
    },
    evidence: {
      dogfoodRunId,
      dogfoodArtifactId,
      dogfoodArtifactDigest,
      dogfoodToolingSha: authoritySha,
      dogfoodWorkflowRef: `${repository}/${DOGFOOD_WORKFLOW}@${authorityRef}`,
    },
    verification: {
      ciWorkflowId,
      ciRunId,
      ciRunAttempt: Number(ciRunAttempt),
      ciCheckSuiteId,
    },
    release: {
      workflowRunId: releaseRunId,
      workflowRunAttempt: 1,
      workflowActorId,
      workflowActorLogin,
    },
  };
  const planDigest = sha256(canonicalJson(planWithoutDigest));
  assert.match(planDigest, SHA256);
  const plan = Object.freeze({ ...planWithoutDigest, planDigest });
  await writeFile(outputPath, `${canonicalJson(plan)}\n`, { mode: 0o600 });
  if (source.GITHUB_OUTPUT) {
    await appendFile(source.GITHUB_OUTPUT, `plan_digest=${planDigest}\nservices_image=${servicesImage}\n`);
  }
  return plan;
}

async function main() {
  const plan = await createReleasePlan(process.env, process.argv[2]);
  process.stdout.write(`release plan ${plan.planDigest} created for ${plan.candidate.sha}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
