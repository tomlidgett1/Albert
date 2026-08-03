import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  assert.ok(Number.isInteger(parsed) && parsed > 0, `${name} must be a positive integer.`);
  return parsed;
}

export async function verifyReleaseReadiness({
  origin,
  pathname,
  expectedSha,
  expectedDeploymentId,
  attempts = 12,
  delayMs = 5_000,
  fetcher = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  assert.match(expectedSha, /^[a-f0-9]{40}$/u, "The expected release SHA is invalid.");
  assert.match(
    expectedDeploymentId,
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u,
    "The expected deployment ID is invalid.",
  );
  const url = new URL(pathname, origin.endsWith("/") ? origin : `${origin}/`);
  assert.equal(url.protocol, "https:", "Release readiness must use HTTPS.");
  assert.equal(url.username, "", "Release readiness URL must not contain credentials.");
  assert.equal(url.password, "", "Release readiness URL must not contain credentials.");
  assert.equal(url.search, "", "Release readiness URL must not contain a query.");
  assert.equal(url.hash, "", "Release readiness URL must not contain a fragment.");

  let lastFailure = "readiness endpoint did not respond";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(url, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      const payload = await response.json();
      if (
        response.ok && payload && typeof payload === "object" &&
        payload.releaseSha === expectedSha &&
        payload.deploymentId === expectedDeploymentId &&
        (payload.ready === true || payload.status === "ready")
      ) {
        return Object.freeze({
          url: url.toString(),
          releaseSha: expectedSha,
          deploymentId: expectedDeploymentId,
        });
      }
      lastFailure = `status ${response.status}; ready=${String(payload?.ready ?? payload?.status)}; releaseSha=${String(payload?.releaseSha)}; deploymentId=${String(payload?.deploymentId)}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : "readiness request failed";
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`Exact release readiness failed after ${attempts} attempts (${lastFailure}).`);
}

async function main() {
  const [origin, pathname, expectedSha, expectedDeploymentId] = process.argv.slice(2);
  assert.ok(
    origin && pathname && expectedSha && expectedDeploymentId,
    "Usage: verify-release-readiness <origin> <path> <sha> <deployment-id>",
  );
  const result = await verifyReleaseReadiness({
    origin,
    pathname,
    expectedSha,
    expectedDeploymentId,
    attempts: positiveInteger(process.env.ALBERT_RELEASE_READINESS_ATTEMPTS, 12, "ALBERT_RELEASE_READINESS_ATTEMPTS"),
    delayMs: positiveInteger(process.env.ALBERT_RELEASE_READINESS_DELAY_MS, 5_000, "ALBERT_RELEASE_READINESS_DELAY_MS"),
  });
  process.stdout.write(`exact release ready at ${result.url}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
