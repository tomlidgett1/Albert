import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import {
  CAPACITY_ATTESTATION_DEPLOYMENT_ALLOWANCE_MS,
  CAPACITY_ATTESTATION_HARNESS_HOLD_MS,
  CAPACITY_ATTESTATION_JOB_TIMEOUT_MS,
  CAPACITY_ATTESTATION_POLL_WINDOW_MS,
} from "./capacity-attestation-timing.mjs";

const services = Object.freeze({
  "codex-runtime.toml": Object.freeze({
    runtime: "codex-runtime",
    command: "services/codex-runtime.js",
    port: 8792,
    exposure: "signed-public",
    source: "services/codex-runtime/src/http.ts",
  }),
  "cube.toml": Object.freeze({
    runtime: "cube",
    port: 4000,
    exposure: "signed-public",
    source: "cube-playground/cube.js",
    customImage: true,
    dockerfile: "../../cube-playground/Dockerfile",
    artifact: "cube-playground/Dockerfile",
  }),
  "deletion-worker.toml": Object.freeze({
    runtime: "deletion-worker",
    command: "services/deletion-worker.js",
    port: 8083,
    exposure: "private",
    source: "services/deletion-worker/src/main.ts",
  }),
  "operator-diagnostic.toml": Object.freeze({
    runtime: "operator-diagnostic",
    command: "services/operator-diagnostic.js",
    port: 8790,
    exposure: "signed-public",
    source: "services/operator-diagnostic/src/node-server.ts",
  }),
  "sync-worker.toml": Object.freeze({
    runtime: "sync-worker",
    command: "services/sync-worker.js",
    port: 8080,
    exposure: "signed-public",
    source: "services/sync-workers/src/main.ts",
  }),
  "webhook-gateway.toml": Object.freeze({
    runtime: "webhook-gateway",
    command: "services/webhook-gateway.js",
    port: 8081,
    exposure: "vendor-public",
    source: "services/webhook-gateway/src/main.ts",
  }),
});

const cubeDockerfile = await readFile(
  new URL("../cube-playground/Dockerfile", import.meta.url),
  "utf8",
);
assert.match(
  cubeDockerfile,
  /^FROM cubejs\/cube:v1\.7\.16@sha256:7a33cdc4469ccde403fae519441b06bdcd80e60032d1d793739eb860a0ea3bcc$/mu,
  "Cube must use the reviewed Linux/amd64 base-image digest.",
);
assert.equal(
  [...cubeDockerfile.matchAll(/^FROM\s+/gmu)].length,
  1,
  "Cube must have exactly one reviewed base-image stage.",
);

const secretNames = Object.freeze([
  "API_KEY",
  "CLIENT_SECRET",
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "SIGNING_KEY",
  "SIGNING_SECRET",
  "ACCESS_KEY",
  "SERVICE_ROLE",
]);

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function section(body, name) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (start === -1) return "";
  const endOffset = lines
    .slice(start + 1)
    .findIndex((line) => /^\s*\[/.test(line));
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join("\n");
}

function includesAssignment(body, name, value) {
  const escapedName = escapeRegularExpression(name);
  const escapedValue = escapeRegularExpression(String(value));
  return new RegExp(
    `^\\s*${escapedName}\\s*=\\s*"?${escapedValue}"?\\s*$`,
    "mu",
  ).test(body);
}

const directory = new URL("../deploy/fly/", import.meta.url);
const contract = JSON.parse(
  await readFile(
    new URL("../deploy/runtime-contract.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(
  contract.schemaVersion,
  1,
  "Deployment contract version is unsupported.",
);
assert.deepEqual(
  Object.keys(contract.runtimes).sort(),
  ["web", ...Object.values(services).map(({ runtime }) => runtime)].sort(),
  "Every production runtime must have exactly one deployment contract.",
);
assert.deepEqual(contract.lockedRegions, {
  controlPlane: "ap-southeast-2",
  analytical: "ap-southeast-2",
  storage: "ap-southeast-2",
  modelDataResidency: "au",
});
const actualFiles = (await readdir(directory))
  .filter((name) => name.endsWith(".toml") && !name.endsWith(".dogfood.toml"))
  .sort();
assert.deepEqual(
  actualFiles,
  Object.keys(services).sort(),
  "Fly service manifest set drifted.",
);

for (const [file, expected] of Object.entries(services)) {
  const body = await readFile(new URL(file, directory), "utf8");
  assert.doesNotMatch(
    body.split(/^\s*\[/mu, 1)[0],
    /^\s*app\s*=/mu,
    `${file} must receive its exact production app target from protected release authority.`,
  );
  const runtime = contract.runtimes[expected.runtime];
  assert.equal(
    runtime.platform,
    "fly",
    `${expected.runtime} must remain a Fly runtime.`,
  );
  assert.equal(
    runtime.manifest,
    `deploy/fly/${file}`,
    `${expected.runtime} manifest drifted.`,
  );
  assert.equal(
    runtime.artifact,
    expected.artifact ?? `.albert-build/${expected.command}`,
    `${expected.runtime} artifact drifted.`,
  );
  assert.equal(
    runtime.healthPath,
    "/readyz",
    `${expected.runtime} readiness path drifted.`,
  );
  assert.ok(
    Array.isArray(runtime.requiredSecretNames) &&
      runtime.requiredSecretNames.length > 0,
    `${expected.runtime} must declare required secrets.`,
  );
  assert.equal(
    new Set(runtime.requiredSecretNames).size,
    runtime.requiredSecretNames.length,
    `${expected.runtime} has duplicate required secrets.`,
  );
  assert.equal(
    new Set(runtime.optionalSecretNames ?? []).size,
    (runtime.optionalSecretNames ?? []).length,
    `${expected.runtime} has duplicate optional secrets.`,
  );
  assert.deepEqual(
    runtime.requiredSecretNames.filter((name) =>
      (runtime.optionalSecretNames ?? []).includes(name),
    ),
    [],
    `${expected.runtime} has ambiguous required/optional secrets.`,
  );
  assert.match(
    body,
    /^primary_region\s*=\s*"syd"$/mu,
    `${file} must remain in Sydney.`,
  );
  assert.match(
    body,
    /^kill_signal\s*=\s*"SIGTERM"$/mu,
    `${file} must drain on SIGTERM.`,
  );
  assert.match(
    body,
    new RegExp(
      `^\\s*dockerfile\\s*=\\s*"${escapeRegularExpression(
        expected.dockerfile ?? "../../Dockerfile.services",
      )}"$`,
      "mu",
    ),
    `${file} must use the hardened service image.`,
  );
  if (!expected.customImage) {
    assert.match(
      body,
      new RegExp(
        `^\\s*app\\s*=\\s*"node --enable-source-maps ${escapeRegularExpression(expected.command)}"$`,
        "mu",
      ),
      `${file} has the wrong process command.`,
    );
  }
  assert.match(
    body,
    /^\s*policy\s*=\s*"always"$/mu,
    `${file} must restart continuously.`,
  );
  assert.match(
    body,
    /^\s*cpu_kind\s*=\s*"shared"$/mu,
    `${file} must declare an explicit CPU class.`,
  );
  assert.match(
    body,
    /^\s*memory\s*=\s*"(?:512mb|1gb)"$/mu,
    `${file} must declare bounded memory.`,
  );
  assert.match(
    body,
    new RegExp(
      `^\\s*path\\s*=\\s*"${escapeRegularExpression(runtime.livenessPath)}"$`,
      "mu",
    ),
    `${file} requires a platform liveness check.`,
  );

  const environment = section(body, "env");
  assert.ok(
    includesAssignment(environment, "NODE_ENV", "production"),
    `${file} must run in production mode.`,
  );
  assert.ok(
    includesAssignment(
      environment,
      "ALBERT_CONTROL_PLANE_REGION",
      "ap-southeast-2",
    ),
    `${file} must lock the control plane to Sydney.`,
  );
  if (
    [
      "sync-worker",
      "transform-worker",
      "semantic-query",
      "operator-diagnostic",
      "deletion-worker",
      "cube",
    ].includes(expected.runtime)
  ) {
    assert.ok(
      includesAssignment(
        environment,
        "ALBERT_ANALYTICAL_REGION",
        "ap-southeast-2",
      ),
      `${file} must lock analytics to Sydney.`,
    );
  }
  if (
    ["sync-worker", "webhook-gateway", "deletion-worker"].includes(
      expected.runtime,
    )
  ) {
    assert.ok(
      includesAssignment(
        environment,
        "SUPABASE_STORAGE_S3_REGION",
        "ap-southeast-2",
      ),
      `${file} must lock raw storage to Sydney.`,
    );
  }
  if (["semantic-query", "anthropic-analytics"].includes(expected.runtime)) {
    assert.ok(
      includesAssignment(
        environment,
        "ALBERT_MODEL_DATA_RESIDENCY_REGION",
        "au",
      ),
      `${file} must lock model data residency to AU.`,
    );
  }
  assert.equal(
    environment.includes("ALBERT_SERVICE_VERSION"),
    false,
    `${file} must receive its exact release SHA from CI.`,
  );
  assert.equal(
    environment.includes("ALBERT_DEPLOYMENT_ID"),
    false,
    `${file} must receive its deployment ID from CI.`,
  );
  for (const secretName of secretNames) {
    assert.equal(
      environment.includes(secretName),
      false,
      `${file} must not commit ${secretName} in [env].`,
    );
  }

  if (expected.exposure === "private") {
    assert.equal(
      body.includes("[http_service]"),
      false,
      `${file} must not create a public Fly service.`,
    );
    assert.match(
      body,
      /^\s*\[checks\.readiness\]\s*$/mu,
      `${file} requires an internal readiness check.`,
    );
    assert.ok(
      includesAssignment(body, "port", expected.port),
      `${file} readiness port drifted.`,
    );
    assert.match(
      body,
      /^\s*type\s*=\s*"http"$/mu,
      `${file} readiness check must use HTTP.`,
    );
  } else {
    assert.match(
      body,
      /^\[http_service\]\s*$/mu,
      `${file} requires an explicit public service.`,
    );
    assert.ok(
      includesAssignment(body, "internal_port", expected.port),
      `${file} public port drifted.`,
    );
    assert.match(
      body,
      /^\s*force_https\s*=\s*true$/mu,
      `${file} must force HTTPS.`,
    );
    assert.match(
      body,
      /^\s*auto_stop_machines\s*=\s*"off"$/mu,
      `${file} must not cold-start.`,
    );
    assert.match(
      body,
      /^\s*min_machines_running\s*=\s*[1-9][0-9]*$/mu,
      `${file} must keep capacity running.`,
    );
    assert.match(
      body,
      /^\s*path\s*=\s*"\/readyz"$/mu,
      `${file} requires a readiness route.`,
    );
  }

  const serviceSource = await readFile(
    new URL(`../${expected.source}`, import.meta.url),
    "utf8",
  );
  if (!expected.customImage) {
    assert.ok(
      serviceSource.includes(runtime.healthPath),
      `${expected.runtime} does not implement ${runtime.healthPath}.`,
    );
    assert.ok(
      serviceSource.includes(runtime.livenessPath),
      `${expected.runtime} does not implement ${runtime.livenessPath}.`,
    );
  }
  if (["sync-worker", "transform-worker"].includes(expected.runtime)) {
    assert.match(
      body,
      /^\[metrics\]\s*$/mu,
      `${file} must publish private Fly metrics.`,
    );
    assert.ok(
      includesAssignment(section(body, "metrics"), "port", 9091),
      `${file} metrics port drifted.`,
    );
    assert.match(
      serviceSource,
      /queue_(?:depth|oldest_age_seconds)/u,
      `${expected.runtime} must expose queue pressure.`,
    );
    assert.match(
      environment,
      /^\s*ALBERT_WORKER_CONCURRENCY\s*=\s*"[1-9][0-9]*"\s*$/mu,
      `${file} must declare bounded execution concurrency.`,
    );
  }
}

for (const [name, metricPrefix, targetFloor] of [
  ["sync-worker.toml", "albert_sync_queue", 300],
]) {
  const autoscaler = await readFile(
    new URL(`../deploy/fly-autoscalers/${name}`, import.meta.url),
    "utf8",
  );
  assert.match(
    autoscaler,
    /^primary_region\s*=\s*"syd"$/mu,
    `${name} autoscaler must run in Sydney.`,
  );
  assert.match(
    autoscaler,
    /^\s*image\s*=\s*"flyio\/fly-autoscaler@sha256:8befadf6269dd637e3f3759f61039bd8e1543e9ec3d06523e974e76a80c207df"$/mu,
    `${name} autoscaler image must be pinned by OCI index digest.`,
  );
  assert.ok(
    autoscaler.includes(`${metricPrefix}_depth`),
    `${name} autoscaler must consume queue depth.`,
  );
  assert.ok(
    autoscaler.includes(`${metricPrefix}_oldest_age_seconds`),
    `${name} autoscaler must consume queue lag.`,
  );
  assert.ok(
    autoscaler.includes(`/ ${targetFloor}`),
    `${name} autoscaler queue-lag target drifted.`,
  );
  assert.match(
    autoscaler,
    /FAS_CREATED_MACHINE_COUNT\s*=\s*"min\(40, 2 \+ queue_pressure\)"/u,
    `${name} autoscaler must retain an HA floor and bounded ceiling.`,
  );
  assert.equal(
    autoscaler.includes("FAS_API_TOKEN"),
    false,
    `${name} autoscaler must not commit its scaling token.`,
  );
}

const [vercelManifest, vercelProject] = await Promise.all([
  readFile(new URL("../vercel.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../deploy/vercel-project.json", import.meta.url), "utf8").then(JSON.parse),
]);
assert.deepEqual(
  vercelManifest,
  {
    $schema: "https://openapi.vercel.sh/vercel.json",
    framework: "nextjs",
    buildCommand: "next build --webpack",
    installCommand: "npm ci",
  },
  "Vercel project configuration drifted.",
);
assert.equal(vercelProject.schemaVersion, 1);
assert.match(vercelProject.projectId, /^prj_[A-Za-z0-9]{16,}$/u);
assert.match(vercelProject.teamId, /^team_[A-Za-z0-9]{16,}$/u);
assert.equal(vercelProject.projectName, "albert");
assert.equal(vercelProject.productionBranch, "main");

const web = contract.runtimes.web;
assert.equal(web.platform, "vercel");
assert.equal(web.manifest, "vercel.json");
assert.equal(web.project, "deploy/vercel-project.json");
assert.equal(web.buildCommand, "next build --webpack");
assert.equal(web.artifact, ".next/BUILD_ID");
assert.equal(web.healthPath, "/api/health");
assert.deepEqual(web.requiredBuildValues, []);
assert.deepEqual(web.requiredPlatformValues, [
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_GIT_PROVIDER",
  "VERCEL_GIT_COMMIT_REF",
  "VERCEL_GIT_COMMIT_SHA",
]);
assert.deepEqual(web.platformValueAliases, {
  ALBERT_SERVICE_VERSION: "VERCEL_GIT_COMMIT_SHA",
  ALBERT_DEPLOYMENT_ID: "VERCEL_DEPLOYMENT_ID",
});
assert.ok(web.requiredRuntimeValues.includes("ALBERT_ALLOW_FIXTURE_RUNTIME"));
assert.ok(
  web.requiredRuntimeValues.includes(
    "ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST",
  ),
);
assert.ok(
  web.requiredRuntimeValues.includes("OPERATOR_DIAGNOSTIC_SERVICE_URL"),
);
assert.ok(
  web.requiredRuntimeValues.includes(
    "ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET",
  ),
);
assert.ok(
  web.requiredRuntimeValues.includes("ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET"),
);
assert.ok(web.requiredRuntimeValues.includes("ALBERT_ANALYTICAL_RUNTIME"));
assert.ok(!web.requiredRuntimeValues.includes("ALBERT_SERVICE_VERSION"));
assert.ok(!web.requiredRuntimeValues.includes("ALBERT_DEPLOYMENT_ID"));
assert.ok(web.forbiddenRuntimeValues.includes("CONTROL_PLANE_DATABASE_URL"));
assert.ok(
  web.forbiddenRuntimeValues.includes(
    "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL",
  ),
);
assert.ok(web.forbiddenRuntimeValues.includes("SUPABASE_SERVICE_ROLE_KEY"));
assert.ok(
  contract.globallyForbiddenRuntimeValues.includes(
    "ANALYTICAL_CAPABILITY_SECRET_BASE64",
  ),
);

const [
  packageJson,
  buildServices,
  dockerfile,
  capacityDockerfile,
  nextConfig,
  webHealth,
  webDependencyHealth,
  releaseWorkflow,
  dogfoodWorkflow,
  migrationRunner,
  webProxy,
  supabaseServer,
] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8").then(
    JSON.parse,
  ),
  readFile(new URL("./build-services.mjs", import.meta.url), "utf8"),
  readFile(new URL("../Dockerfile.services", import.meta.url), "utf8"),
  readFile(new URL("../Dockerfile.capacity-attestor", import.meta.url), "utf8"),
  readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8"),
  readFile(
    new URL("../packages/config/src/health.ts", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../.github/workflows/release-authority.yml", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../.github/workflows/dogfood-acceptance.yml", import.meta.url),
    "utf8",
  ),
  readFile(new URL("./migrate.ts", import.meta.url), "utf8"),
  readFile(new URL("../proxy.ts", import.meta.url), "utf8"),
  readFile(new URL("../utils/supabase/server.ts", import.meta.url), "utf8"),
]);
assert.equal(
  packageJson.scripts["release:preflight"],
  "node scripts/release-preflight.mjs",
);
assert.equal(
  packageJson.scripts["build:capacity-attestor"],
  "node scripts/build-capacity-attestor.mjs",
);
assert.match(
  buildServices,
  /__ALBERT_SERVICE_BUILD_SHA__:\s*JSON\.stringify\(buildSha\)/u,
  "Service bundles must receive a compile-time code identity.",
);
assert.equal(vercelManifest.buildCommand, web.buildCommand);
for (const { command } of Object.values(services).filter(
  (service) => typeof service.command === "string",
)) {
  const artifact = command.replace(/^services\//u, "").replace(/\.js$/u, "");
  assert.match(
    buildServices,
    new RegExp(`"${escapeRegularExpression(artifact)}"\\s*:`),
    `Service build is missing ${artifact}.`,
  );
}
assert.match(
  dockerfile,
  /FROM node:22\.23\.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime/u,
);
assert.match(
  dockerfile,
  /ENV SSL_CERT_FILE=\/etc\/ssl\/certs\/ca-certificates\.crt[\s\S]*apt-get install -y --no-install-recommends ca-certificates/u,
  "The service image must trust the CA bundle used by the Codex Responses websocket.",
);
assert.match(
  releaseWorkflow,
  /provision:runtime-logins[\s\S]*ALBERT_ANTHROPIC_CONTROL_DB_PASSWORD:\s*\$\{\{\s*secrets\.ALBERT_ANTHROPIC_CONTROL_DB_PASSWORD\s*\}\}/u,
  "Production runtime-login reconciliation must receive the dedicated Anthropic control password.",
);
assert.match(
  capacityDockerfile,
  /FROM node:22\.23\.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime/u,
);
assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/u);
const serviceNpmCaches = [
  ...dockerfile.matchAll(
    /--mount=type=cache,id=([^,\s]+),target=\/root\/\.npm,sharing=locked/gu,
  ),
].map((match) => match[1]);
assert.equal(
  serviceNpmCaches.length >= 2,
  true,
  "Every service image npm operation must use a locked, explicitly named cache.",
);
assert.equal(
  new Set(serviceNpmCaches).size,
  2,
  "Parallel service image stages must never mutate the same npm cache.",
);
const capacityNpmCaches = [
  ...capacityDockerfile.matchAll(
    /--mount=type=cache,id=([^,\s]+),target=\/root\/\.npm,sharing=locked/gu,
  ),
].map((match) => match[1]);
assert.equal(
  capacityNpmCaches.length,
  2,
  "Both capacity-attestor image stages must use locked, explicitly named npm caches.",
);
assert.equal(
  new Set(capacityNpmCaches).size,
  2,
  "Parallel capacity-attestor image stages must never mutate the same npm cache.",
);
assert.match(
  dockerfile,
  /ARG ALBERT_BUILD_SHA=development[\s\S]*ENV ALBERT_BUILD_SHA=\$ALBERT_BUILD_SHA[\s\S]*npm run build:services/u,
  "The image build must compile the candidate checkout SHA into every service.",
);
assert.match(
  dockerfile,
  /LABEL org\.opencontainers\.image\.revision=\$ALBERT_BUILD_SHA/u,
  "The service OCI image must carry the candidate revision label.",
);
assert.match(
  dockerfile,
  /^USER node$/mu,
  "Service image must run as a non-root user.",
);
assert.match(webHealth, /inspectWebDependencies/u);
assert.match(webHealth, /status:\s*readiness\.ready\s*\?\s*200\s*:\s*503/u);
assert.match(
  webHealth,
  /releaseSha/u,
  "Vercel health must identify the exact release SHA.",
);
assert.match(
  nextConfig,
  /process\.env\.VERCEL === "1"[\s\S]*process\.env\.VERCEL_GIT_COMMIT_SHA[\s\S]*process\.env\.GITHUB_SHA[\s\S]*process\.env\.ALBERT_BUILD_SHA/u,
);
assert.match(
  nextConfig,
  /env:\s*\{[\s\S]*ALBERT_BUILD_SHA:\s*embeddedBuildSha/u,
);
assert.match(
  webDependencyHealth,
  /process\.env\.ALBERT_BUILD_SHA/u,
  "Vercel health must report the compile-time bundle identity.",
);
assert.match(
  webDependencyHealth,
  /buildSha === runtimeSha/u,
  "Vercel readiness must reject runtime relabelling of an old bundle.",
);
assert.match(
  webDependencyHealth,
  /readiness\.releaseSha === expectedSha[\s\S]*typeof readiness\.deploymentId === "string"/u,
  "Vercel readiness must bind dependency code and require each platform deployment identity.",
);
assert.match(
  webProxy,
  /"\/reset-password"/u,
  "Password recovery must pass through the production web guard.",
);
assert.match(
  supabaseServer,
  /assertRuntimeEnvironment\("web"\)/u,
  "Server-side Supabase access must fail closed on invalid production configuration.",
);

const flyctlSetupRef =
  "superfly/flyctl-actions/setup-flyctl@ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1";
const flyctlVersion = "0.4.61";
function validateFlyctlPins(workflow, expectedJobs, name) {
  const reviewedSetupCount = [
    ...workflow.matchAll(
      new RegExp(escapeRegularExpression(flyctlSetupRef), "gu"),
    ),
  ].length;
  const setupCount = [
    ...workflow.matchAll(/superfly\/flyctl-actions\/setup-flyctl@[^\s]+/gu),
  ].length;
  const pinnedVersions = [
    ...workflow.matchAll(
      new RegExp(
        `^\\s*-\\s+uses:\\s+${escapeRegularExpression(flyctlSetupRef)}\\s*\\n` +
          "\\s+with:\\s*\\n\\s+version:\\s+([0-9]+\\.[0-9]+\\.[0-9]+)\\s*$",
        "gmu",
      ),
    ),
  ].map((match) => match[1]);
  const jobsSource = workflow.slice(
    workflow.indexOf("\njobs:\n") + "\njobs:\n".length,
  );
  const jobHeaders = [...jobsSource.matchAll(/^  ([a-z][a-z0-9-]+):\s*$/gmu)];
  const flyJobs = [];
  for (const [index, header] of jobHeaders.entries()) {
    const jobName = header[1];
    const bodyStart = (header.index ?? 0) + header[0].length;
    const bodyEnd =
      index + 1 < jobHeaders.length
        ? (jobHeaders[index + 1].index ?? jobsSource.length)
        : jobsSource.length;
    const body = jobsSource.slice(bodyStart, bodyEnd);
    const jobSetupCount = [
      ...body.matchAll(
        new RegExp(escapeRegularExpression(flyctlSetupRef), "gu"),
      ),
    ].length;
    if (!/(?:^|\s)flyctl\s/u.test(body) && jobSetupCount === 0) continue;
    flyJobs.push(jobName);
    const jobPinCount = [
      ...body.matchAll(
        new RegExp(
          `${escapeRegularExpression(flyctlSetupRef)}\\s*\\n` +
            `\\s+with:\\s*\\n\\s+version:\\s+${escapeRegularExpression(flyctlVersion)}\\s*$`,
          "gmu",
        ),
      ),
    ].length;
    assert.equal(
      jobSetupCount,
      1,
      `${name} job ${jobName} must install Fly CLI exactly once.`,
    );
    assert.equal(
      jobPinCount,
      1,
      `${name} job ${jobName} must use the reviewed Fly CLI version.`,
    );
  }
  assert.deepEqual(
    flyJobs.sort(),
    [...expectedJobs].sort(),
    `${name} Fly CLI job inventory drifted.`,
  );
  assert.equal(
    setupCount,
    flyJobs.length,
    `${name} Fly CLI setup count drifted.`,
  );
  assert.equal(
    reviewedSetupCount,
    setupCount,
    `${name} must use only the reviewed immutable Fly setup action commit.`,
  );
  assert.equal(
    pinnedVersions.length,
    setupCount,
    `${name} must pin a Fly CLI version on every setup step.`,
  );
  assert.ok(
    pinnedVersions.every((version) => version === flyctlVersion),
    `${name} Fly CLI versions must match the reviewed ${flyctlVersion} toolchain.`,
  );
}
validateFlyctlPins(
  releaseWorkflow,
  [
    "activate-and-smoke",
    "attest-transform-fleet-capacity",
    "deploy-autoscalers",
    "deploy-services",
    "stage-raw-storage-sessions",
    "stage-vendor-attestor-relay",
  ],
  "Release authority workflow",
);
validateFlyctlPins(dogfoodWorkflow, ["collect-and-sign"], "Dogfood workflow");

const releasePreflightIndex = releaseWorkflow.indexOf("\n  authorize:");
const capacityAttestationIndex = releaseWorkflow.indexOf(
  "\n  attest-transform-fleet-capacity:",
);
const bootstrapUpgradeIndex = releaseWorkflow.indexOf("\n  schema:");
const migrationIndex = releaseWorkflow.indexOf(
  "Apply immutable migrations with deployer identities",
);
const securityProvisionIndex = releaseWorkflow.indexOf("\n  runtime-security:");
const rawStorageStageIndex = releaseWorkflow.indexOf(
  "\n  stage-raw-storage-sessions:",
);
const vendorRelayStageIndex = releaseWorkflow.indexOf(
  "\n  stage-vendor-attestor-relay:",
);
const deployServicesIndex = releaseWorkflow.indexOf("\n  deploy-services:");
assert.ok(
  capacityAttestationIndex > -1 &&
    releasePreflightIndex > capacityAttestationIndex &&
    bootstrapUpgradeIndex > releasePreflightIndex &&
    migrationIndex > bootstrapUpgradeIndex &&
    securityProvisionIndex > migrationIndex &&
    rawStorageStageIndex > securityProvisionIndex &&
    vendorRelayStageIndex > rawStorageStageIndex &&
    deployServicesIndex > vendorRelayStageIndex,
  "Release security bootstrap, migrations, key provisioning, and deployment staging are out of order.",
);
const capacityAttestationJob = releaseWorkflow.slice(
  capacityAttestationIndex,
  releasePreflightIndex,
);
assert.match(
  capacityAttestationJob,
  /timeout-minutes:\s*90/u,
  "Protected capacity job must retain its reviewed 90-minute cleanup boundary.",
);
assert.match(
  capacityAttestationJob,
  /CAPACITY_ATTESTATION_HARNESS_HOLD_MS[\s\S]*hold_until=.*CAPACITY_ATTESTATION_HARNESS_HOLD_MS/u,
  "Capacity harness lifetime must use the shared protected timing contract.",
);
assert.ok(
  CAPACITY_ATTESTATION_HARNESS_HOLD_MS >=
    CAPACITY_ATTESTATION_DEPLOYMENT_ALLOWANCE_MS +
      CAPACITY_ATTESTATION_POLL_WINDOW_MS &&
    CAPACITY_ATTESTATION_HARNESS_HOLD_MS < CAPACITY_ATTESTATION_JOB_TIMEOUT_MS,
  "Capacity harness hold must cover deployment plus polling and still permit always-cleanup.",
);
assert.match(
  releaseWorkflow,
  /SUPABASE_MANAGEMENT_TOKEN:\s*\$\{\{ secrets\.SUPABASE_MANAGEMENT_TOKEN \}\}/u,
);
assert.match(
  releaseWorkflow,
  /ALBERT_TRANSFORM_FLEET_CAPACITY_ATTESTATION_BASE64=.*transform-fleet-capacity-attestation\.json/u,
  "Production preflight must consume the same-workflow signed capacity envelope.",
);
assert.match(
  releaseWorkflow,
  /id-token:\s*write/u,
  "Capacity attestation requests require GitHub OIDC.",
);
assert.match(
  releaseWorkflow,
  /ALBERT_CAPACITY_ATTESTOR_URL[\s\S]*request-independent-capacity-attestation\.mjs/u,
  "Candidate capacity work must be observed by an independent attestor.",
);
const capacityRequestStepIndex = releaseWorkflow.indexOf(
  "- name: Ask the independently pinned attestor to observe and sign the run",
);
const capacityRequestStepEnd = releaseWorkflow.indexOf(
  "\n      - name:",
  capacityRequestStepIndex + 1,
);
const capacityRequestStep = releaseWorkflow.slice(
  capacityRequestStepIndex,
  capacityRequestStepEnd,
);
assert.ok(
  capacityRequestStepIndex > -1,
  "Protected capacity request step is absent.",
);
assert.match(
  capacityRequestStep,
  /ALBERT_CAPACITY_CORPUS_FINGERPRINT:\s*\$\{\{ vars\.ALBERT_CAPACITY_CORPUS_FINGERPRINT \}\}/u,
  "Independent attestor request must receive the approved corpus fingerprint in its own scope.",
);
assert.match(
  capacityRequestStep,
  /STAGING_CELL_ID:[^\n]*ALBERT_CAPACITY_STAGING_CELL_ID/u,
  "Independent attestor request must bind the protected staging cell in its own scope.",
);
assert.doesNotMatch(
  releaseWorkflow,
  /ALBERT_CAPACITY_ED25519_PRIVATE_KEY/u,
  "The candidate release workflow must never receive the capacity signing key.",
);
assert.match(
  releaseWorkflow,
  /ALBERT_CAPACITY_CORPUS_FINGERPRINT[\s\S]*ALBERT_CAPACITY_ATTESTOR_TOOL_REF/u,
  "Production must pin the capacity corpus and independent producer tooling.",
);
assert.match(
  releaseWorkflow,
  /ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST:\s*\$\{\{ vars\.ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST \}\}/u,
  "Production preflight must pin the independent attestor OCI build digest.",
);
assert.match(
  releaseWorkflow,
  /release:preflight[\s\S]*dogfood-acceptance-attestation\.mjs[\s\S]*schema:/u,
  "One-use dogfood acceptance must be consumed before production mutation.",
);
assert.match(
  releaseWorkflow,
  /flyctl secrets list[\s\S]*validate-runtime-secrets\.mjs/u,
);
assert.match(
  releaseWorkflow,
  /stage-raw-storage-sessions:[\s\S]*runtime-security/u,
);
assert.match(
  releaseWorkflow,
  /flyctl secrets set[\s\S]*--stage[\s\S]*SUPABASE_STORAGE_S3_LEGACY_ANON_KEY/u,
);
assert.match(
  releaseWorkflow,
  /stage-vendor-attestor-relay:[\s\S]*ALBERT_VENDOR_ATTESTOR_RELAY_ENABLED=true[\s\S]*ALBERT_VENDOR_ATTESTOR_TLS_SERVER_CA_BASE64/u,
  "Release authority must stage the complete private mTLS vendor-attestor relay before deploying sync.",
);
assert.match(
  releaseWorkflow,
  /bootstrap:upgrade:control-plane[\s\S]*CONTROL_PLANE_ADMIN_DATABASE_URL/u,
);
assert.match(
  releaseWorkflow,
  /deploy-autoscalers:[\s\S]*FAS_PROMETHEUS_TOKEN/u,
);
assert.match(
  releaseWorkflow,
  /TARGET_FLOOR[\s\S]*running_count[\s\S]*-lt "\$TARGET_FLOOR"/u,
  "Worker deployment must apply the preflight-attested floor without scaling down.",
);
assert.doesNotMatch(
  releaseWorkflow,
  /name:\s*Maintain two production Machines/u,
);
assert.match(
  releaseWorkflow,
  /schema:[\s\S]*bootstrap:upgrade:control-plane[\s\S]*npm run migrate/u,
);
assert.match(releaseWorkflow, /runtime-security:[\s\S]*schema/u);
assert.match(
  releaseWorkflow,
  /provision:runtime-logins[\s\S]*provision:raw-storage-machine-users[\s\S]*provision:analytical-capability-key[\s\S]*provision:webhook-attestation-key/u,
);
assert.match(
  releaseWorkflow,
  /provision:raw-storage-machine-users[\s\S]*SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY[\s\S]*ALBERT_RAW_STORAGE_CREDENTIAL_GENERATION/u,
);
assert.doesNotMatch(releaseWorkflow, /publish-registry:|registry:publish/u);
assert.match(releaseWorkflow, /deploy-services:[\s\S]*needs:[\s\S]*- runtime-security/u);
assert.match(releaseWorkflow, /ALBERT_REQUIRE_DEPLOYER_LOGIN:\s*"true"/u);
assert.match(
  releaseWorkflow,
  /--env "ALBERT_SERVICE_VERSION=\$ALBERT_RELEASE_CANDIDATE_SHA"/u,
);
assert.match(
  releaseWorkflow,
  /--build-arg "ALBERT_BUILD_SHA=\$ALBERT_RELEASE_CANDIDATE_SHA"/u,
  "Every production service deploy must compile the trusted checkout SHA into its image.",
);
assert.match(
  releaseWorkflow,
  /--env "ALBERT_DEPLOYMENT_ID=\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u,
);
assert.match(
  releaseWorkflow,
  /verify-release-readiness\.mjs[\s\S]*"\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/u,
  "Release readiness must bind the exact deployment attempt as well as SHA.",
);
assert.match(
  migrationRunner,
  /requestedRole !== target\.defaultRole/u,
  "Migration runner must reject every non-owner role.",
);
assert.match(
  migrationRunner,
  /sessionUser !== target\.deployerLogin/u,
  "Release migrations must verify the actual deployer login.",
);
const [
  attestorMain,
  attestorOidc,
  attestorGithub,
  attestorCollector,
  attestorManifest,
  attestorDockerfile,
  attestorStoreSql,
  attestorControlSql,
  attestorAnalyticalSql,
] = await Promise.all([
  readFile(
    new URL("../services/capacity-attestor/src/main.ts", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../services/capacity-attestor/src/oidc.ts", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL(
      "../services/capacity-attestor/src/external-observers.ts",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL("../services/capacity-attestor/src/collector.ts", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL(
      "../deploy/capacity/capacity-attestor.reference.toml",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(new URL("../Dockerfile.capacity-attestor", import.meta.url), "utf8"),
  readFile(
    new URL("../deploy/capacity/attestor-store.sql", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL(
      "../deploy/capacity/attestor-control-observer.sql",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL(
      "../deploy/capacity/attestor-analytical-observer.sql",
      import.meta.url,
    ),
    "utf8",
  ),
]);
assert.match(
  attestorMain,
  /ALBERT_CAPACITY_ED25519_PRIVATE_KEY_BASE64/u,
  "Independent attestor must own its signer instead of candidate CI.",
);
assert.match(
  attestorOidc,
  /token\.actions\.githubusercontent\.com\/\.well-known\/jwks/u,
);
assert.match(
  attestorOidc,
  /workflow_sha/u,
  "GitHub OIDC must bind the exact workflow SHA.",
);
assert.match(
  attestorGithub,
  /check_run_id/u,
  "Independent attestor must bind the active Actions check-run.",
);
assert.match(
  attestorGithub,
  /Only the exact capacity attestation job may enter staging-capacity/u,
  "Independent attestor must reject another protected-environment job.",
);
for (const source of [attestorGithub, attestorCollector]) {
  assert.match(
    source,
    /Prometheus|prometheus/u,
    "Independent attestor must observe Fly Prometheus.",
  );
  assert.match(
    source,
    /Fly|fly/u,
    "Independent attestor must observe Fly Machines.",
  );
}
assert.match(
  attestorCollector,
  /createTransformFleetCapacityAttestation/u,
  "Independent attestor must produce the exact reviewed envelope.",
);
assert.match(
  attestorMain,
  /producerBuildDigest:\s*required\(environment, "ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST"\)/u,
  "Independent attestor must sign its protected OCI build digest.",
);
const capacityRequestClient = await readFile(
  new URL("./request-independent-capacity-attestation.mjs", import.meta.url),
  "utf8",
);
assert.match(
  capacityRequestClient,
  /response\.status === 202[\s\S]*pollAfterSeconds/u,
  "Capacity request must poll a pending asynchronous observation.",
);
assert.match(
  capacityRequestClient,
  /AbortSignal\.timeout\(20_000\)/u,
  "Every capacity polling exchange must have a short timeout.",
);
assert.match(
  attestorManifest,
  /Reference only[\s\S]*separately reviewed immutable repository/u,
  "Attestor manifest must prohibit candidate-controlled deployment.",
);
assert.match(attestorManifest, /min_machines_running\s*=\s*2/u);
const capacityAutoscalerManifest = await readFile(
  new URL(
    "../deploy/capacity/transform-fleet-autoscaler.toml",
    import.meta.url,
  ),
  "utf8",
);
assert.match(
  capacityAutoscalerManifest,
  /^\s*image\s*=\s*"flyio\/fly-autoscaler@sha256:8befadf6269dd637e3f3759f61039bd8e1543e9ec3d06523e974e76a80c207df"$/mu,
  "Capacity evidence must use an immutable autoscaler image.",
);
assert.match(attestorDockerfile, /^USER node$/mu);
assert.match(attestorDockerfile, /npm ci --omit=dev --ignore-scripts/u);
assert.match(attestorStoreSql, /UNIQUE\(token_jti\)/u);
assert.match(attestorControlSql, /default_transaction_read_only=on/u);
assert.doesNotMatch(attestorControlSql, /GRANT (?:INSERT|UPDATE|DELETE)/u);
assert.match(attestorAnalyticalSql, /receives no table or schema grant/u);

process.stdout.write(
  `validated ${actualFiles.length + 2} runtime deployment boundaries and release preflight\n`,
);
