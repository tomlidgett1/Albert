import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWebReleaseIdentity,
  withWebReleaseIdentity,
} from "../packages/config/src/vercel-runtime.ts";

const sha = "a".repeat(40);
const deploymentId = "dpl_9rT2LFnsfT2RGbzwkgcvTzd8vcdH";
const projectId = "prj_l5faWCnDWxw7QB7nBWgr9zaKFxuL";

test("Vercel system identity overrides mutable Albert release labels", () => {
  const source = {
    VERCEL: "1",
    VERCEL_GIT_COMMIT_SHA: sha,
    VERCEL_DEPLOYMENT_ID: deploymentId,
    VERCEL_PROJECT_ID: projectId,
    ALBERT_SERVICE_VERSION: "b".repeat(40),
    ALBERT_DEPLOYMENT_ID: "mutable-release",
  };
  assert.deepEqual(resolveWebReleaseIdentity(source), {
    releaseSha: sha,
    deploymentId,
    projectId,
    source: "vercel",
  });
  const effective = withWebReleaseIdentity(source);
  assert.equal(effective.ALBERT_SERVICE_VERSION, sha);
  assert.equal(effective.ALBERT_RELEASE_SHA, sha);
  assert.equal(effective.ALBERT_DEPLOYMENT_ID, deploymentId);
});

test("invalid Vercel system identity fails closed instead of using mutable labels", () => {
  const identity = resolveWebReleaseIdentity({
    VERCEL: "1",
    VERCEL_GIT_COMMIT_SHA: "invalid",
    VERCEL_DEPLOYMENT_ID: "mutable-release",
    VERCEL_PROJECT_ID: "invalid",
    ALBERT_SERVICE_VERSION: sha,
    ALBERT_DEPLOYMENT_ID: deploymentId,
  });
  assert.deepEqual(identity, {
    releaseSha: "",
    deploymentId: "",
    projectId: null,
    source: "vercel",
  });
});

test("Vercel build configuration cannot fall back to a mutable Albert SHA", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
  );
  assert.match(
    source,
    /process\.env\.VERCEL === "1"[\s\S]*VERCEL_GIT_COMMIT_SHA[\s\S]*process\.env\.GITHUB_SHA[\s\S]*ALBERT_BUILD_SHA/u,
  );
});

test("non-Vercel runtimes retain the declared identity contract", () => {
  const source = {
    ALBERT_SERVICE_VERSION: sha,
    ALBERT_DEPLOYMENT_ID: "release-1",
  };
  assert.deepEqual(resolveWebReleaseIdentity(source), {
    releaseSha: sha,
    deploymentId: "release-1",
    projectId: null,
    source: "declared",
  });
  assert.equal(withWebReleaseIdentity(source), source);
});
