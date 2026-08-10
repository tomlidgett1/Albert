import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  createCapacityAttestorHttpHandler,
} from "./src/http.js";
import {
  TransformFleetCapacityCollector,
  type CapacityCollectorCheckpoint,
} from "./src/collector.js";
import {
  capacityAttestationRequestSchema,
  enforceCapacityAttestorPolicy,
  type CapacityAttestationRequest,
  type CapacityAttestorPolicy,
} from "./src/contracts.js";
import { FlyCapacityObserver, FlyPrometheusObserver, GitHubRunObserver } from "./src/external-observers.js";
import { GitHubOidcVerifier } from "./src/oidc.js";
import { PostgresCapacityAttestationStore } from "./src/store.js";
import { verifyTransformFleetCapacityAttestation } from "../../scripts/transform-fleet-capacity-attestation.mjs";
import {
  CAPACITY_ATTESTATION_LEASE_SECONDS,
  CAPACITY_ATTESTATION_MAX_OBSERVATION_MS,
  CAPACITY_ATTESTATION_POLL_WINDOW_MS,
  CAPACITY_ATTESTATION_RECOVERY_ALLOWANCE_MS,
} from "../../scripts/capacity-attestation-timing.mjs";

const repository = "tomlidgett1/Albert";
const candidateSha = "a".repeat(40);
const authoritySha = "b".repeat(40);
const authorityRef = "refs/tags/albert-release-authority-v1";
const workflowRef = `${repository}/.github/workflows/release-authority.yml@${authorityRef}`;
const candidateTransformImageDigest = `sha256:${"9".repeat(64)}`;
const releasePlanDigest = "7".repeat(64);
const corpusFingerprint = "f".repeat(64);

function prometheusSamples(value: number, count = 20, start = "2026-08-03T00:00:00.000Z") {
  const startMilliseconds = Date.parse(start);
  return Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
    observedAt: new Date(startMilliseconds + index * 15_000).toISOString(),
    value,
  })));
}

function request(): CapacityAttestationRequest {
  return capacityAttestationRequestSchema.parse({
    schemaVersion: 2,
    authoritySha,
    authorityRef,
    candidateSha,
    candidateTransformImageDigest,
    releasePlanDigest,
    repository,
    workflowRunId: "123456789",
    workflowRunAttempt: 2,
    workflowRef,
    capacityRunId: "123456789-2",
    stagingCellId: "sydney-capacity-01",
    transformApp: "albert-transform-capacity",
    autoscalerApp: "albert-transform-capacity-autoscaler",
    requestedFloor: 4,
    corpusContractDigest: "82895eb48467068eabdb9b4c511e85242cedbc2584d0127ee700e791e4bdcf4a",
    corpusFingerprint,
  });
}

function policy(): CapacityAttestorPolicy {
  return Object.freeze({
    repository,
    workflowRef,
    authorityRef,
    authoritySha,
    stagingEnvironment: "staging-capacity",
    stagingCellId: "sydney-capacity-01",
    transformApp: "albert-transform-capacity",
    autoscalerApp: "albert-transform-capacity-autoscaler",
    requestedFloor: 4,
    corpusFingerprint,
  });
}

function jwt(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  kid: string,
  now: number,
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://token.actions.githubusercontent.com",
    aud: "albert-transform-capacity-attestor",
    sub: `repo:${repository}:environment:staging-capacity`,
    repository,
    sha: authoritySha,
    run_id: "123456789",
    run_attempt: "2",
    workflow_ref: workflowRef,
    workflow_sha: authoritySha,
    ref: authorityRef,
    environment: "staging-capacity",
    event_name: "workflow_dispatch",
    runner_environment: "github-hosted",
    jti: "oidc-token-id-123456789",
    iat: Math.floor(now / 1_000) - 5,
    nbf: Math.floor(now / 1_000) - 5,
    exp: Math.floor(now / 1_000) + 300,
    ...overrides,
  })).toString("base64url");
  return `${header}.${payload}.${Buffer.from(sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey)).toString("base64url")}`;
}

test("GitHub OIDC/JWKS verification binds protected environment, workflow SHA, run, and corpus policy", async () => {
  const now = Date.parse("2026-08-03T00:00:00.000Z");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "github-test-key";
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
  const verifier = new GitHubOidcVerifier(async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }), () => now);
  const identity = await verifier.verify(jwt(privateKey, kid, now), request(), policy());
  assert.equal(identity.authoritySha, authoritySha);
  assert.equal(identity.authorityRef, authorityRef);
  assert.equal(identity.environment, "staging-capacity");

  const wrongPolicy = { ...policy(), corpusFingerprint: "1".repeat(64) };
  assert.throws(() => enforceCapacityAttestorPolicy(request(), wrongPolicy), /corpus fingerprint/u);
  const wrongRequest = { ...request(), workflowRunAttempt: 3, capacityRunId: "123456789-3" };
  await assert.rejects(() => verifier.verify(jwt(privateKey, kid, now), wrongRequest, policy()), /attempt/u);
  await assert.rejects(
    () => verifier.verify(jwt(privateKey, kid, now, {
      sha: candidateSha,
      workflow_sha: candidateSha,
    }), request(), policy()),
    /authority SHA/u,
  );
});

test("GitHub observer binds the active check-run and proves it is the only staging-capacity job", async () => {
  let workflowSourceUrl = "";
  const observer = new GitHubRunObserver("g".repeat(40), async (input) => {
    const url = String(input);
    if (url.includes("/contents/")) {
      workflowSourceUrl = url;
      return new Response(`jobs:\n  attest-transform-fleet-capacity:\n    environment: staging-capacity\n    steps:\n      - name: Ask the independently pinned attestor to observe and sign the run\n        run: node scripts/request-independent-capacity-attestation.mjs output.json\n  verify:\n    runs-on: ubuntu-latest\n`, { status: 200 });
    }
    if (url.includes("/jobs?")) {
      return Response.json({ total_count: 1, jobs: [{
        name: "attest-transform-fleet-capacity",
        status: "in_progress",
        check_run_id: 9988,
        check_run_url: `https://api.github.com/repos/${repository}/check-runs/9988`,
        labels: ["ubuntu-24.04"],
        steps: [{ name: "Ask the independently pinned attestor to observe and sign the run", status: "in_progress" }],
      }] });
    }
    return Response.json({
      head_sha: authoritySha,
      run_attempt: 2,
      event: "workflow_dispatch",
      path: ".github/workflows/release-authority.yml@albert-release-authority-v1",
      status: "in_progress",
    });
  });
  await observer.assertAuthorityRun(request());
  assert.match(workflowSourceUrl,
    new RegExp(`/contents/\\.github/workflows/release-authority\\.yml\\?ref=${authoritySha}$`, "u"));

  const candidateHead = new GitHubRunObserver("g".repeat(40), async () => Response.json({
    head_sha: candidateSha,
    run_attempt: 2,
    event: "workflow_dispatch",
    path: ".github/workflows/release-authority.yml@albert-release-authority-v1",
    status: "in_progress",
  }));
  await assert.rejects(() => candidateHead.assertAuthorityRun(request()), /release authority/u);

  const duplicate = new GitHubRunObserver("g".repeat(40), async (input) => {
    const url = String(input);
    if (url.includes("/contents/")) return new Response(`jobs:\n  attest-transform-fleet-capacity:\n    environment: staging-capacity\n    steps:\n      - run: node scripts/request-independent-capacity-attestation.mjs out\n  rogue:\n    environment: staging-capacity\n`, { status: 200 });
    if (url.includes("/jobs?")) return Response.json({ total_count: 1, jobs: [{
      name: "attest-transform-fleet-capacity", status: "in_progress", check_run_id: 1,
      check_run_url: `https://api.github.com/repos/${repository}/check-runs/1`, labels: ["ubuntu-24.04"],
      steps: [{ name: "Ask the independently pinned attestor to observe and sign the run", status: "in_progress" }],
    }] });
    return Response.json({
      head_sha: authoritySha,
      run_attempt: 2,
      event: "workflow_dispatch",
      path: ".github/workflows/release-authority.yml@albert-release-authority-v1",
      status: "in_progress",
    });
  });
  await assert.rejects(() => duplicate.assertAuthorityRun(request()), /Only the exact capacity attestation job/u);
});

test("Fly observation rejects a Machine digest that is not the approved candidate image", async () => {
  const observer = new FlyCapacityObserver("f".repeat(40), async (input) => {
    const url = String(input);
    if (url.includes("/apps/albert-transform-capacity/machines")) {
      return Response.json([{
        id: "00000000000001",
        state: "started",
        region: "syd",
        image_ref: { digest: `sha256:${"8".repeat(64)}` },
        config: { env: {
          ALBERT_SERVICE_VERSION: candidateSha,
          ALBERT_DEPLOYMENT_ID: "capacity-123456789-2",
          ALBERT_CAPACITY_RUN_ID: "123456789-2",
          ALBERT_CAPACITY_RUN_APPROVED: `load-staging:${candidateSha}`,
          ALBERT_WORKER_CONCURRENCY: "8",
          ALBERT_SNAPSHOT_CLAIM_BATCH_SIZE: "8",
        } },
      }]);
    }
    return Response.json([]);
  });
  await assert.rejects(() => observer.snapshot(request()), /approved candidate image/u);
});

test("collector signs only independently observed 20k fleet, queue, DB, autoscaler, and corpus evidence", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let controlCalls = 0;
  const machineIds = ["00000000000001", "00000000000002", "00000000000003", "00000000000004"];
  const basePressure = { maxConnections: 100, connections: 40, lockWaiters: 0, deadlocks: 2 };
  const collector = new TransformFleetCapacityCollector({
    github: { assertAuthorityRun: async () => undefined },
    fly: { snapshot: async () => ({
      transformRunning: 4, autoscalerRunning: 1,
      transformImageDigest: candidateTransformImageDigest,
      transformMachineIds: machineIds,
      observedAt: "2026-08-03T00:00:00.000Z",
    }) },
    prometheus: { observe: async () => ({
      runningSamples: prometheusSamples(4),
      desiredSamples: prometheusSamples(4),
    }) },
    analytical: { sample: async () => basePressure },
    control: {
      sample: async () => {
        controlCalls += 1;
        const finished = controlCalls >= 21;
        return {
          observedAt: "2026-08-03T00:20:00.000Z",
          maintenanceDue: controlCalls === 1 ? 20_000 : finished ? 0 : 10_000,
          activeMaintenanceLeases: 32,
          transformQueueDepth: 0,
          oldestVisibleJobAgeSeconds: 0,
          completedClaims: finished ? 20_000 : 10_000,
          participantCount: finished ? 4 : 0,
          pressure: basePressure,
        };
      },
      detail: async () => ({
        completedClaims: 20_000,
        distinctTenants: 20_000,
        p95TenantMs: 120,
        p99TenantMs: 180,
        startedAt: "2026-08-03T00:10:00.000Z",
        completedAt: "2026-08-03T00:30:00.000Z",
        participants: machineIds.map((participantId, index) => ({
          participantId,
          workerId: `capacity:123456789-2:${participantId}`,
          releaseSha: candidateSha,
          completedClaims: 5_000,
          controlPoolAcquireP95Ms: 20 + index,
          analyticalPoolAcquireP95Ms: 30 + index,
          errorCount: 0,
        })),
        workload: {
          completedTenants: 20_000,
          sourceRows: { p50: 4_000, p95: 20_000, max: 80_000 },
          canonicalRows: { p50: 2_000, p95: 10_000, max: 40_000 },
          strata: [
            { id: "micro", minRows: 1, maxRows: 999, count: 2_000 },
            { id: "small", minRows: 1_000, maxRows: 9_999, count: 14_000 },
            { id: "medium", minRows: 10_000, maxRows: null, count: 4_000 },
          ],
          corpusFingerprint,
        },
      }),
    },
    signingKey: privateKey,
    producerToolRef: `tomlidgett1/albert-release-trust@${"d".repeat(40)}`,
    producerBuildDigest: `sha256:${"e".repeat(64)}`,
    clock: () => Date.parse("2026-08-03T00:31:00.000Z"),
    sleep: async () => undefined,
  });
  const envelope = await collector.collect(request());
  const verified = verifyTransformFleetCapacityAttestation(envelope, {
    publicKey,
    authoritySha,
    authorityRef,
    candidateSha,
    candidateTransformImageDigest,
    releasePlanDigest,
    repository,
    workflowRunId: "123456789",
    workflowRunAttempt: 2,
    workflowRef,
    stagingCellId: "sydney-capacity-01",
    corpusFingerprint,
    producerToolRef: `tomlidgett1/albert-release-trust@${"d".repeat(40)}`,
    producerBuildDigest: `sha256:${"e".repeat(64)}`,
    now: new Date("2026-08-03T00:40:00.000Z"),
  });
  assert.equal(verified.recommendedProductionFloor, 4);
  assert.equal((envelope.payload as { stagingDeployment: { imageDigest: string } }).stagingDeployment.imageDigest,
    `sha256:${"9".repeat(64)}`);
});

test("collector durably retains and rejects a direct below-floor sample after stability begins", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pressure = { maxConnections: 100, connections: 40, lockWaiters: 0, deadlocks: 2 };
  const machineIds = ["00000000000001", "00000000000002", "00000000000003", "00000000000004"];
  let controlCalls = 0;
  let flyCalls = 0;
  let durableCheckpoint: CapacityCollectorCheckpoint | undefined;
  const collector = new TransformFleetCapacityCollector({
    github: { assertAuthorityRun: async () => undefined },
    fly: { snapshot: async () => {
      flyCalls += 1;
      const transformRunning = flyCalls === 1 ? 4 : 3;
      return {
        transformRunning,
        autoscalerRunning: 1,
        transformImageDigest: candidateTransformImageDigest,
        transformMachineIds: machineIds.slice(0, transformRunning),
        observedAt: new Date(Date.parse("2026-08-03T00:00:00.000Z") + flyCalls * 15_000).toISOString(),
      };
    } },
    prometheus: { observe: async () => assert.fail("Prometheus must not run after a direct fleet dip.") },
    analytical: { sample: async () => pressure },
    control: {
      sample: async () => {
        controlCalls += 1;
        return {
          observedAt: "2026-08-03T00:00:00.000Z",
          maintenanceDue: controlCalls === 1 ? 20_000 : 10_000,
          activeMaintenanceLeases: 32,
          transformQueueDepth: 0,
          oldestVisibleJobAgeSeconds: 0,
          completedClaims: 10_000,
          participantCount: 0,
          pressure,
        };
      },
      detail: async () => assert.fail("Run detail must not be read after a direct fleet dip."),
    },
    signingKey: privateKey,
    producerToolRef: `tomlidgett1/albert-release-trust@${"d".repeat(40)}`,
    producerBuildDigest: `sha256:${"e".repeat(64)}`,
    clock: () => Date.parse("2026-08-03T00:01:00.000Z"),
    sleep: async () => undefined,
  });
  await assert.rejects(() => collector.collect(request(), {
    save: async (checkpoint) => { durableCheckpoint = checkpoint; },
  }), /dropped below the requested floor after stability began/u);
  assert.ok(durableCheckpoint);
  assert.equal(durableCheckpoint.fleetSamples.at(-1)?.transformRunning, 3);
  await assert.rejects(() => collector.collect(request(), {
    checkpoint: durableCheckpoint,
    save: async () => undefined,
  }), /checkpoint contains a below-floor fleet observation/u);
});

test("Prometheus range observation rejects missing timestamps, duplicates, and fleet dips", async () => {
  const start = "2026-08-03T00:00:00.000Z";
  const end = "2026-08-03T00:05:00.000Z";
  const startSeconds = Date.parse(start) / 1_000;
  const response = (
    query: string,
    mutate?: (values: Array<[number, string]>) => void,
  ) => {
    const desired = query.startsWith("desired_");
    const values = Array.from({ length: 21 }, (_, index): [number, string] => [
      startSeconds + index * 15,
      String(desired ? 4 : 4),
    ]);
    mutate?.(values);
    return Response.json({
      status: "success",
      data: { resultType: "matrix", result: [{ metric: {}, values }] },
    });
  };
  const observer = (mutateRunning?: (values: Array<[number, string]>) => void) =>
    new FlyPrometheusObserver(
      "https://api.fly.io/prometheus/albert-capacity",
      "p".repeat(40),
      "running_{{app}}",
      "desired_{{app}}",
      async (input) => {
        const query = new URL(String(input)).searchParams.get("query") ?? "";
        return response(query, query.startsWith("running_") ? mutateRunning : undefined);
      },
    );

  const complete = await observer().observe(request(), start, end);
  assert.equal(complete.runningSamples.length, 21);
  assert.equal(complete.runningSamples.at(-1)?.observedAt, end);

  await assert.rejects(() => observer((values) => { values.splice(10, 1); }).observe(request(), start, end),
    /complete requested range/u);
  await assert.rejects(() => observer((values) => { values[10]![0] = values[9]![0]; }).observe(request(), start, end),
    /timestamp gap or duplicate/u);
  await assert.rejects(() => observer((values) => { values[10]![1] = "3"; }).observe(request(), start, end),
    /fleet dip/u);
});

test("durable checkpoints let a replacement collector finish the same capacity attempt", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const machineIds = ["00000000000001", "00000000000002", "00000000000003", "00000000000004"];
  const pressure = { maxConnections: 100, connections: 40, lockWaiters: 0, deadlocks: 2 };
  let controlCalls = 0;
  let now = Date.parse("2026-08-03T00:00:00.000Z");
  const collector = new TransformFleetCapacityCollector({
    github: { assertAuthorityRun: async () => undefined },
    fly: { snapshot: async () => ({
      transformRunning: 4,
      autoscalerRunning: 1,
      transformImageDigest: candidateTransformImageDigest,
      transformMachineIds: machineIds,
      observedAt: new Date(now).toISOString(),
    }) },
    prometheus: { observe: async () => ({
      runningSamples: prometheusSamples(4),
      desiredSamples: prometheusSamples(4),
    }) },
    analytical: { sample: async () => pressure },
    control: {
      sample: async () => {
        controlCalls += 1;
        const finished = controlCalls >= 20;
        return {
          observedAt: new Date(now).toISOString(),
          maintenanceDue: controlCalls === 1 ? 20_000 : finished ? 0 : 10_000,
          activeMaintenanceLeases: 32,
          transformQueueDepth: 0,
          oldestVisibleJobAgeSeconds: 0,
          completedClaims: finished ? 20_000 : 10_000,
          participantCount: finished ? 4 : 0,
          pressure,
        };
      },
      detail: async () => ({
        completedClaims: 20_000,
        distinctTenants: 20_000,
        p95TenantMs: 120,
        p99TenantMs: 180,
        startedAt: "2026-08-03T00:10:00.000Z",
        completedAt: "2026-08-03T00:30:00.000Z",
        participants: machineIds.map((participantId, index) => ({
          participantId,
          workerId: `capacity:123456789-2:${participantId}`,
          releaseSha: candidateSha,
          completedClaims: 5_000,
          controlPoolAcquireP95Ms: 20 + index,
          analyticalPoolAcquireP95Ms: 30 + index,
          errorCount: 0,
        })),
        workload: {
          completedTenants: 20_000,
          sourceRows: { p50: 4_000, p95: 20_000, max: 80_000 },
          canonicalRows: { p50: 2_000, p95: 10_000, max: 40_000 },
          strata: [
            { id: "micro", minRows: 1, maxRows: 999, count: 2_000 },
            { id: "small", minRows: 1_000, maxRows: 9_999, count: 14_000 },
            { id: "medium", minRows: 10_000, maxRows: null, count: 4_000 },
          ],
          corpusFingerprint,
        },
      }),
    },
    signingKey: privateKey,
    producerToolRef: `tomlidgett1/albert-release-trust@${"d".repeat(40)}`,
    producerBuildDigest: `sha256:${"e".repeat(64)}`,
    clock: () => now,
    sleep: async () => undefined,
  });

  let durableCheckpoint: CapacityCollectorCheckpoint | undefined;
  let saves = 0;
  await assert.rejects(() => collector.collect(request(), {
    save: async (checkpoint) => {
      durableCheckpoint = checkpoint;
      saves += 1;
      if (saves === 10) throw new Error("simulated collector process death");
    },
  }), /simulated collector process death/u);
  assert.ok(durableCheckpoint);
  assert.equal(durableCheckpoint.controlSamples.length, 10);

  now = Date.parse("2026-08-03T00:31:00.000Z");
  const envelope = await collector.collect(request(), {
    checkpoint: durableCheckpoint,
    save: async (checkpoint) => { durableCheckpoint = checkpoint; },
  });
  assert.equal((envelope.payload as { fleet: { completedClaims: number } }).fleet.completedClaims, 20_000);
  assert.equal(durableCheckpoint.controlSamples.length, 20);
});

test("renewable checkpoint lease expires inside the same protected polling attempt", async () => {
  const key = {
    repository,
    workflowRunId: "123456789",
    workflowRunAttempt: 2,
    authoritySha,
    authorityRef,
    candidateSha,
    candidateTransformImageDigest,
    releasePlanDigest,
  };
  const requestDigest = "1".repeat(64);
  const pressure = { maxConnections: 100, connections: 20, lockWaiters: 0, deadlocks: 0 };
  const firstSample = {
    observedAt: "2026-08-03T00:00:00.000Z",
    maintenanceDue: 20_000,
    activeMaintenanceLeases: 0,
    transformQueueDepth: 0,
    oldestVisibleJobAgeSeconds: 0,
    completedClaims: 0,
    participantCount: 0,
    pressure,
  };
  const checkpoint: CapacityCollectorCheckpoint = {
    schemaVersion: 1,
    observationStartedAt: firstSample.observedAt,
    firstSample,
    controlSamples: [firstSample],
    analyticalSamples: [pressure],
    fleetSamples: [],
    floorReachedAt: null,
    verifiedDeployment: null,
  };
  let row: Record<string, unknown> | undefined;
  let leaseExpired = false;
  const observedLeaseSeconds: number[] = [];
  const client = {
    async query(sql: string, parameters: readonly unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (["begin", "commit", "rollback"].includes(normalized) || normalized.includes("set_config")) {
        return { rows: [] };
      }
      if (normalized.startsWith("insert into capacity_trust.transform_attestations")) {
        observedLeaseSeconds.push(Number(parameters[11]));
        row ??= {
          protocol_version: 2,
          authority_sha: parameters[3],
          authority_ref: parameters[4],
          candidate_sha: parameters[5],
          candidate_image_digest: parameters[6],
          release_plan_digest: parameters[7],
          request_digest: parameters[8],
          status: "running",
          lease_token: parameters[10],
          checkpoint: null,
          envelope: null,
        };
        return { rows: [] };
      }
      if (normalized.startsWith("select protocol_version")) return { rows: row ? [row] : [] };
      if (normalized.startsWith("select lease_token=")) {
        return { rows: [{ owns_lease: row?.lease_token === parameters[3] }] };
      }
      if (normalized.startsWith("update capacity_trust.transform_attestations set checkpoint=")) {
        observedLeaseSeconds.push(Number(parameters[9]));
        if (!row || row.lease_token !== parameters[10]) return { rows: [] };
        row.checkpoint = JSON.parse(String(parameters[8]));
        return { rows: [{ checkpointed: 1 }] };
      }
      if (normalized.startsWith("update capacity_trust.transform_attestations set status='running'")) {
        observedLeaseSeconds.push(Number(parameters[5]));
        if (!leaseExpired || !row) return { rows: [] };
        row.token_jti = parameters[3];
        row.lease_token = parameters[4];
        leaseExpired = false;
        return { rows: [{ acquired: 1 }] };
      }
      throw new Error(`Unexpected store SQL in test: ${normalized}`);
    },
    release() {},
  };
  const store = new PostgresCapacityAttestationStore({
    connect: async () => client,
  });
  const first = await store.reserve(key, "first-oidc-token-id", requestDigest);
  assert.equal(first.status, "acquired");
  assert.equal(first.status === "acquired" ? first.checkpoint : undefined, undefined);
  assert.ok(first.status === "acquired");
  await assert.rejects(
    () => store.reserve({ ...key, authoritySha: "c".repeat(40) }, "changed-authority-token-id", requestDigest),
    /reserved with different inputs/u,
  );
  await assert.rejects(
    () => store.reserve({
      ...key,
      authorityRef: "refs/tags/albert-release-authority-v2",
    }, "changed-authority-ref-token-id", requestDigest),
    /reserved with different inputs/u,
  );
  await assert.rejects(
    () => store.reserve({ ...key, candidateSha: "c".repeat(40) }, "changed-candidate-token-id", requestDigest),
    /reserved with different inputs/u,
  );
  await assert.rejects(
    () => store.reserve({
      ...key,
      candidateTransformImageDigest: `sha256:${"8".repeat(64)}`,
    }, "changed-image-token-id", requestDigest),
    /reserved with different inputs/u,
  );
  await assert.rejects(
    () => store.reserve({ ...key, releasePlanDigest: "6".repeat(64) }, "changed-plan-token-id", requestDigest),
    /reserved with different inputs/u,
  );
  await assert.rejects(
    () => store.reserve(key, "changed-request-token-id", "2".repeat(64)),
    /reserved with different inputs/u,
  );
  await store.checkpoint(key, first.leaseToken, checkpoint);

  leaseExpired = true;
  const replacement = await store.reserve(key, "replacement-oidc-token-id", requestDigest);
  assert.equal(replacement.status, "acquired");
  assert.ok(replacement.status === "acquired");
  assert.deepEqual(replacement.checkpoint, checkpoint);
  assert.notEqual(replacement.leaseToken, first.leaseToken);
  assert.ok(observedLeaseSeconds.every((seconds) => seconds === CAPACITY_ATTESTATION_LEASE_SECONDS));
  assert.ok(
    CAPACITY_ATTESTATION_POLL_WINDOW_MS >=
      CAPACITY_ATTESTATION_MAX_OBSERVATION_MS +
      CAPACITY_ATTESTATION_LEASE_SECONDS * 1_000 +
      CAPACITY_ATTESTATION_RECOVERY_ALLOWANCE_MS,
    "Protected polling window must include observation, lease takeover, and recovery allowance.",
  );
});

test("HTTP surface enforces policy and never accepts a caller-authored pass payload", async () => {
  let completed = false;
  const handler = createCapacityAttestorHttpHandler({
    policy: policy(),
    oidc: { verify: async () => ({ jti: "oidc-token-id-123456789" } as never) },
    collector: { collect: async () => ({ payload: {}, signature: {} }) },
    store: {
      reserve: async () => ({ status: "acquired", leaseToken: "lease" }),
      checkpoint: async () => undefined,
      complete: async () => { completed = true; },
      fail: async () => undefined,
    },
  });
  const response = await handler(new Request("https://attestor.example/v1/transform-capacity-attestations", {
    method: "POST",
    headers: { authorization: `Bearer ${"x".repeat(40)}`, "content-type": "application/json" },
    body: JSON.stringify(request()),
  }));
  assert.equal(response.status, 202);
  const pending = await response.json() as Readonly<Record<string, unknown>>;
  assert.equal(pending.schemaVersion, 2);
  assert.equal(pending.status, "pending");
  assert.match(String(pending.attestationId), /^[a-f0-9]{64}$/u);
  assert.equal(pending.pollAfterSeconds, 15);
  // The exact id is derived from canonical run coordinates; only its shape is public.
  // Allow the detached collector completion microtask to settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, true);
  const injected = await handler(new Request("https://attestor.example/v1/transform-capacity-attestations", {
    method: "POST",
    headers: { authorization: `Bearer ${"x".repeat(40)}`, "content-type": "application/json" },
    body: JSON.stringify({ ...request(), passed: true }),
  }));
  assert.equal(injected.status, 400);
});
