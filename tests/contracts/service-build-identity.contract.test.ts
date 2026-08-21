import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertEmbeddedServiceBuildIdentity } from "../../packages/config/src/build-identity.js";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);

test("production services cannot relabel a compiled image", () => {
  const runtime: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    ALBERT_SERVICE_VERSION: shaA,
  };
  const captured = assertEmbeddedServiceBuildIdentity(runtime, shaA);
  assert.equal(captured, shaA);

  runtime.ALBERT_SERVICE_VERSION = shaB;
  assert.equal(captured, shaA, "the captured code identity must not follow runtime mutation");
  assert.throws(
    () => assertEmbeddedServiceBuildIdentity(runtime, shaA),
    /does not match the service image build identity/,
  );
  for (const value of [undefined, "", "A".repeat(40), "development", "abc123"]) {
    assert.throws(
      () => assertEmbeddedServiceBuildIdentity({
        NODE_ENV: "production",
        ALBERT_SERVICE_VERSION: value,
      }, shaA),
      /ALBERT_SERVICE_VERSION/,
    );
  }
  assert.throws(
    () => assertEmbeddedServiceBuildIdentity({
      NODE_ENV: "production",
      ALBERT_SERVICE_VERSION: shaA,
    }, "development"),
    /does not contain a valid embedded release Git SHA/,
  );
});

test("source development has an explicit unversioned sentinel", () => {
  assert.equal(assertEmbeddedServiceBuildIdentity({ NODE_ENV: "development" }, "development"), "development");
  assert.equal(assertEmbeddedServiceBuildIdentity({ NODE_ENV: "test" }, shaA), shaA);
});

test("all release runtimes start with and report the captured image identity", async () => {
  const root = new URL("../../", import.meta.url);
  const startupFiles = [
    "services/sync-workers/src/main.ts",
    "services/deletion-worker/src/main.ts",
    "services/webhook-gateway/src/main.ts",
    "services/operator-diagnostic/src/main.ts",
    "services/codex-runtime/src/main.ts",
  ];
  for (const file of startupFiles) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.match(source, /assertEmbeddedServiceBuildIdentity/u, `${file} must fail closed on image relabelling`);
  }

  const readinessFiles = [
    "services/sync-workers/src/main.ts",
    "services/deletion-worker/src/main.ts",
    "services/webhook-gateway/src/main.ts",
    "services/operator-diagnostic/src/main.ts",
    "services/codex-runtime/src/main.ts",
  ];
  for (const file of readinessFiles) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.match(source, /releaseSha/u, `${file} must identify the code in readiness`);
    assert.doesNotMatch(
      source,
      /releaseSha\s*:\s*(?:process\.env\.ALBERT_SERVICE_VERSION|config\.serviceVersion)/u,
      `${file} must not report a mutable runtime release label`,
    );
  }
});

test("the OCI and release build path inject the trusted checkout SHA", async () => {
  const [builder, dockerfile, workflow] = await Promise.all([
    readFile(new URL("../../scripts/build-services.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../Dockerfile.services", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/release-authority.yml", import.meta.url), "utf8"),
  ]);
  assert.match(builder, /__ALBERT_SERVICE_BUILD_SHA__:\s*JSON\.stringify\(buildSha\)/u);
  assert.match(builder, /GITHUB_ACTIONS[\s\S]*GitHub Actions service builds require GITHUB_SHA/u);
  assert.match(dockerfile, /ARG ALBERT_BUILD_SHA=development[\s\S]*ENV ALBERT_BUILD_SHA=\$ALBERT_BUILD_SHA[\s\S]*npm run build:services/u);
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.revision=\$ALBERT_BUILD_SHA/u);
  assert.match(
    dockerfile,
    /ENV SSL_CERT_FILE=\/etc\/ssl\/certs\/ca-certificates\.crt[\s\S]*apt-get install -y --no-install-recommends ca-certificates/u,
    "The Linux Codex websocket client requires the system CA bundle and its explicit path.",
  );
  assert.match(workflow, /docker buildx build candidate[\s\S]*--build-arg "ALBERT_BUILD_SHA=\$ALBERT_RELEASE_CANDIDATE_SHA"/u);
  assert.match(workflow, /flyctl deploy[\s\S]*--image "\$SERVICES_IMAGE"/u);
});
