import assert from "node:assert/strict";
import test from "node:test";

import { verifyReleaseReadiness } from "../scripts/verify-release-readiness.mjs";

const sha = "a".repeat(40);
const deploymentId = "12345-1";

test("release readiness accepts only a healthy exact-SHA runtime", async () => {
  let calls = 0;
  const result = await verifyReleaseReadiness({
    origin: "https://service.example",
    pathname: "/readyz",
    expectedSha: sha,
    expectedDeploymentId: deploymentId,
    attempts: 3,
    delayMs: 1,
    sleep: async () => undefined,
    fetcher: async () => {
      calls += 1;
      return Response.json(calls === 1
        ? { ready: true, releaseSha: "b".repeat(40), deploymentId }
        : { ready: true, releaseSha: sha, deploymentId });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.releaseSha, sha);
  assert.equal(result.deploymentId, deploymentId);
});

test("release readiness rejects old, unready, malformed, and non-TLS deployments", async () => {
  for (const payload of [
    { ready: false, releaseSha: sha, deploymentId },
    { status: "not_ready", releaseSha: sha, deploymentId },
    { ready: true, releaseSha: "b".repeat(40), deploymentId },
    { ready: true, releaseSha: sha, deploymentId: "older-release" },
    { ready: true },
  ]) {
    await assert.rejects(() => verifyReleaseReadiness({
      origin: "https://service.example",
      pathname: "/readyz",
      expectedSha: sha,
      expectedDeploymentId: deploymentId,
      attempts: 1,
      delayMs: 1,
      fetcher: async () => Response.json(payload),
    }), /Exact release readiness failed/u);
  }
  await assert.rejects(() => verifyReleaseReadiness({
    origin: "http://service.example",
    pathname: "/readyz",
    expectedSha: sha,
    expectedDeploymentId: deploymentId,
  }), /HTTPS/u);
});
