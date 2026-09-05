import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  RELEASE_AUTHORITY_SURFACE_PATHS,
  createReleasePlan,
  digestReleaseAuthoritySurface,
} from "../scripts/create-release-plan.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "albert-release-plan-"));
  const authority = path.join(root, "authority");
  const candidate = path.join(root, "candidate");
  for (const checkout of [authority, candidate]) {
    await mkdir(checkout, { recursive: true });
    for (const relative of RELEASE_AUTHORITY_SURFACE_PATHS) {
      const target = path.join(checkout, relative);
      if (path.extname(relative) || relative.startsWith("Dockerfile")) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `${relative}\n`);
      } else {
        await mkdir(target, { recursive: true });
        await writeFile(path.join(target, "fixture.txt"), `${relative}\n`);
      }
    }
    execFileSync("git", ["init", "-q"], { cwd: checkout });
    execFileSync("git", ["config", "user.email", "release-test@invalid.example"], { cwd: checkout });
    execFileSync("git", ["config", "user.name", "Albert release test"], { cwd: checkout });
    execFileSync("git", ["add", "."], { cwd: checkout });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: checkout });
  }
  const authoritySha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: authority, encoding: "utf8" }).trim();
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidate, encoding: "utf8" }).trim();
  return { root, authority, candidate, authoritySha, candidateSha };
}

function source(value) {
  return {
    ALBERT_RELEASE_AUTHORITY_ROOT: value.authority,
    ALBERT_RELEASE_CANDIDATE_ROOT: value.candidate,
    ALBERT_RELEASE_AUTHORITY_TOOLING_SHA: value.authoritySha,
    ALBERT_RELEASE_CANDIDATE_SHA: value.candidateSha,
    ALBERT_RELEASE_AUTHORITY_REF: "refs/tags/albert-release-authority-v1",
    ALBERT_RELEASE_SERVICES_IMAGE: `ghcr.io/tomlidgett1/albert-services@sha256:${"c".repeat(64)}`,
    ALBERT_RELEASE_CUBE_IMAGE: `ghcr.io/tomlidgett1/albert-cube@sha256:${"d".repeat(64)}`,
    ALBERT_DOGFOOD_RUN_ID: "123",
    ALBERT_DOGFOOD_ARTIFACT_ID: "456",
    ALBERT_DOGFOOD_ARTIFACT_DIGEST: `sha256:${"e".repeat(64)}`,
    ALBERT_RELEASE_CI_WORKFLOW_ID: "11",
    ALBERT_RELEASE_CI_RUN_ID: "12",
    ALBERT_RELEASE_CI_RUN_ATTEMPT: "1",
    ALBERT_RELEASE_CI_CHECK_SUITE_ID: "13",
    GITHUB_REPOSITORY: "tomlidgett1/Albert",
    GITHUB_WORKFLOW_REF: "tomlidgett1/Albert/.github/workflows/release-authority.yml@refs/tags/albert-release-authority-v1",
    GITHUB_RUN_ID: "789",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_ACTOR_ID: "42",
    GITHUB_ACTOR: "release-operator",
  };
}

test("release plan binds a separately checked out candidate to the exact authority surface", async () => {
  const value = await fixture();
  const output = path.join(value.root, "release-plan.json");
  const plan = await createReleasePlan(source(value), output);
  assert.equal(plan.authority.sha, value.authoritySha);
  assert.equal(plan.candidate.sha, value.candidateSha);
  assert.match(plan.planDigest, /^[a-f0-9]{64}$/u);
  assert.equal(plan.schemaVersion, 3);
  assert.equal(
    plan.candidate.cubeImage,
    `ghcr.io/tomlidgett1/albert-cube@sha256:${"d".repeat(64)}`,
  );
  assert.deepEqual(plan.verification, {
    ciWorkflowId: "11",
    ciRunId: "12",
    ciRunAttempt: 1,
    ciCheckSuiteId: "13",
  });
  assert.equal(plan.candidate.privilegedSurfaceDigest, (await digestReleaseAuthoritySurface(value.authority)).digest);
});

test("release plan rejects candidate drift in privileged tooling", async () => {
  const value = await fixture();
  await writeFile(path.join(value.candidate, "scripts", "fixture.txt"), "candidate drift\n");
  execFileSync("git", ["add", "."], { cwd: value.candidate });
  execFileSync("git", ["commit", "-qm", "drift"], { cwd: value.candidate });
  value.candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: value.candidate,
    encoding: "utf8",
  }).trim();
  await assert.rejects(
    createReleasePlan(source(value), path.join(value.root, "release-plan.json")),
    /privileged release surface differs/u,
  );
});

test("release plan rejects Cube model drift from immutable authority", async () => {
  const value = await fixture();
  await writeFile(path.join(value.candidate, "cube-playground", "fixture.txt"), "Cube model drift\n");
  execFileSync("git", ["add", "."], { cwd: value.candidate });
  execFileSync("git", ["commit", "-qm", "Cube drift"], { cwd: value.candidate });
  value.candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: value.candidate,
    encoding: "utf8",
  }).trim();
  await assert.rejects(
    createReleasePlan(source(value), path.join(value.root, "release-plan.json")),
    /privileged release surface differs/u,
  );
});

test("release plan refuses symlinks instead of following candidate-controlled paths", async () => {
  const value = await fixture();
  await symlink("fixture.txt", path.join(value.candidate, "scripts", "escape"));
  execFileSync("git", ["add", "."], { cwd: value.candidate });
  execFileSync("git", ["commit", "-qm", "symlink"], { cwd: value.candidate });
  value.candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: value.candidate,
    encoding: "utf8",
  }).trim();
  await assert.rejects(
    createReleasePlan(source(value), path.join(value.root, "release-plan.json")),
    /forbids symlink/u,
  );
});

test("release plan rejects dirty checkout drift even when HEAD still matches", async () => {
  const value = await fixture();
  await writeFile(path.join(value.candidate, "scripts", "fixture.txt"), "uncommitted drift\n");
  await assert.rejects(
    createReleasePlan(source(value), path.join(value.root, "release-plan.json")),
    /uncommitted filesystem drift/u,
  );
});

test("release plan rejects a rerun CI attempt", async () => {
  const value = await fixture();
  await assert.rejects(
    createReleasePlan(
      { ...source(value), ALBERT_RELEASE_CI_RUN_ATTEMPT: "2" },
      path.join(value.root, "release-plan.json"),
    ),
    /CI must be from its first run attempt/u,
  );
});

test("release plan requires an immutable Cube image digest", async () => {
  const value = await fixture();
  await assert.rejects(
    createReleasePlan(
      { ...source(value), ALBERT_RELEASE_CUBE_IMAGE: "ghcr.io/tomlidgett1/albert-cube:latest" },
      path.join(value.root, "release-plan.json"),
    ),
    /Cube image must be a GHCR digest reference/u,
  );
});
