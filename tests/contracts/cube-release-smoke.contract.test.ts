import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { load as loadYaml } from "js-yaml";
import {
  buildShopifyQuery,
  createFutureWindow,
  signJwt,
  validateLoadResponse,
  validateMetaResponse,
} from "../../cube-playground/scripts/release-smoke.mjs";
import {
  loadConfiguration,
  runProductionCubeReleaseSmoke,
  validateMachineProof,
} from "../../scripts/run-production-cube-release-smoke.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const tenantId = "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
const conversationId = "01KZ4ZMVF5QNQ4TX35VF3WDJBN";
const turnId = "01KZ4ZMVF5QNQ4TX35VF3WDJBP";
const measures = [
  "shopify_sales_analytics.current_total_sales",
  "shopify_sales_analytics.orders",
  "shopify_sales_analytics.distinct_protected_subjects",
] as const;

function machineProof() {
  return {
    schemaVersion: 1,
    ok: true,
    meta: {
      view: "shopify_sales_analytics",
      privacyPolicy: "aggregate_only",
      minimumTimeGranularity: "day",
      privacyMinimumGroupSize: 5,
      privacyPopulationMeasure: "distinct_protected_subjects",
      measures: [...measures],
      timeDimension: "shopify_sales_analytics.processed_at",
    },
    query: {
      measures: [...measures],
      timeDimension: "shopify_sales_analytics.processed_at",
      granularity: "day",
      emptyFutureWindow: true,
      rowCount: 0,
    },
  };
}

function source(runnerTemp: string) {
  return {
    ALBERT_RELEASE_CANDIDATE_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123456789",
    GITHUB_RUN_ATTEMPT: "1",
    ALBERT_RELEASE_DEPLOYMENT_ID: "123456789-1",
    ALBERT_RELEASE_CUBE_IMAGE: `ghcr.io/tomlidgett1/albert-cube@sha256:${"b".repeat(64)}`,
    ALBERT_RELEASE_AUTHORIZATION_DIGEST: "c".repeat(64),
    ALBERT_RELEASE_CUBE_SMOKE_TENANT_ID: tenantId,
    ALBERT_RELEASE_CUBE_APP: "albert-cube-production",
    ALBERT_RELEASE_CUBE_MACHINE_ID: "abcdef12345678",
    ALBERT_RELEASE_CONTROL_PLANE_PROJECT_REF: "abcdefghijklmnopqrst",
    ALBERT_RELEASE_CUBE_SMOKE_CONTROL_DATABASE_URL:
      "postgresql://albert_operator_diagnostic_control_runtime:secret@db.abcdefghijklmnopqrst.supabase.co/production?sslmode=verify-full",
    RUNNER_TEMP: runnerTemp,
  };
}

test("in-Machine probe signs a two-minute least-scope token and fixes a future Shopify day query", () => {
  const now = new Date("2026-08-12T18:30:00.000Z");
  const token = signJwt({
    tenant_id: tenantId,
    conversation_id: conversationId,
    turn_id: turnId,
  }, "release-test-secret-that-is-longer-than-thirty-two-bytes", now);
  const [header, body, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString("utf8")), {
    alg: "HS256",
    typ: "JWT",
  });
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
  assert.deepEqual(claims.scope, ["meta", "data"]);
  assert.equal(claims.albert_release_smoke, true);
  assert.equal(claims.exp - claims.iat, 120);
  assert.ok(signature);
  assert.doesNotMatch(token, /release-test-secret/u);

  assert.deepEqual(createFutureWindow(now), ["2026-08-14", "2026-08-15"]);
  assert.deepEqual(buildShopifyQuery(now), {
    measures,
    timeDimensions: [{
      dimension: "shopify_sales_analytics.processed_at",
      granularity: "day",
      dateRange: ["2026-08-14", "2026-08-15"],
    }],
    timezone: "Australia/Melbourne",
    limit: 1,
  });
});

test("meta and load validation require the Shopify privacy contract and zero returned rows", () => {
  const meta = validateMetaResponse({
    cubes: [{
      name: "shopify_sales_analytics",
      meta: {
        privacy_policy: "aggregate_only",
        minimum_time_granularity: "day",
        privacy_minimum_group_size: 5,
        privacy_population_measure: "distinct_protected_subjects",
      },
      measures: measures.map((name) => ({ name })),
      dimensions: [{ name: "shopify_sales_analytics.processed_at" }],
    }],
  });
  assert.equal(meta.privacyMinimumGroupSize, 5);
  assert.equal(validateLoadResponse({ data: [] }).rowCount, 0);
  assert.throws(() => validateLoadResponse({ data: [{ secret: "must-not-escape" }] }));
  assert.throws(() => validateMetaResponse({
    cubes: [{
      name: "shopify_sales_analytics",
      meta: {
        privacy_policy: "aggregate_only",
        minimum_time_granularity: "day",
        privacy_minimum_group_size: 4,
        privacy_population_measure: "distinct_protected_subjects",
      },
      measures: measures.map((name) => ({ name })),
      dimensions: [{ name: "shopify_sales_analytics.processed_at" }],
    }],
  }));
});

test("release coordinator binds structural proof to authorization and finalizes the real lease", async () => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "albert-cube-release-smoke-"));
  const outputPath = path.join(runnerTemp, "proof.json");
  const lease = {
    leaseId: "01KZ4ZMVF5QNQ4TX35VF3WDJBQ",
    conversationId,
    turnId,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  const finishes: unknown[][] = [];
  try {
    const result = await runProductionCubeReleaseSmoke({
      source: source(runnerTemp),
      outputPath,
      issue: async (config) => {
        assert.equal(config.tenantId, tenantId);
        return lease;
      },
      execute: async (config, issuedLease) => {
        assert.equal(config.machineId, "abcdef12345678");
        assert.equal(issuedLease, lease);
        return validateMachineProof(machineProof());
      },
      finish: async (...args) => {
        finishes.push(args);
        return true;
      },
    });
    assert.match(result.resultDigest, /^[a-f0-9]{64}$/u);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]![2], true);
    assert.equal(finishes[0]![3], result.resultDigest);
    const artifactText = await readFile(outputPath, "utf8");
    const artifact = JSON.parse(artifactText);
    assert.equal(artifact.authorizationDigest, "c".repeat(64));
    assert.equal(artifact.cubeImage, source(runnerTemp).ALBERT_RELEASE_CUBE_IMAGE);
    assert.equal(artifact.query.rowCount, 0);
    assert.doesNotMatch(artifactText, new RegExp(tenantId, "u"));
    assert.doesNotMatch(artifactText, new RegExp(conversationId, "u"));
    assert.doesNotMatch(artifactText, new RegExp(turnId, "u"));
    assert.ok(!Object.hasOwn(artifact, "data"));
    assert.ok(!Object.hasOwn(artifact, "rows"));
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("release coordinator closes a minted turn with a data-free failure digest", async () => {
  const runnerTemp = await mkdtemp(path.join(os.tmpdir(), "albert-cube-release-failure-"));
  const lease = {
    leaseId: "01KZ4ZMVF5QNQ4TX35VF3WDJBQ",
    conversationId,
    turnId,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  const finishes: unknown[][] = [];
  try {
    await assert.rejects(runProductionCubeReleaseSmoke({
      source: source(runnerTemp),
      issue: async () => lease,
      execute: async () => { throw new Error("response body must never be echoed"); },
      finish: async (...args) => {
        finishes.push(args);
        return true;
      },
    }), /unexpected_failure/u);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]![2], false);
    assert.match(String(finishes[0]![3]), /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(finishes), /response body must never be echoed/u);
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("release configuration fails closed on non-TLS production control URLs", () => {
  const valid = source("/tmp");
  assert.equal(loadConfiguration(valid).deploymentId, "123456789-1");
  assert.equal(loadConfiguration({
    ...valid,
    ALBERT_RELEASE_CUBE_SMOKE_CONTROL_DATABASE_URL:
      "postgresql://albert_operator_diagnostic_control_runtime.abcdefghijklmnopqrst:secret@aws-0-ap-southeast-2.pooler.supabase.com/production?sslmode=require",
  }).controlPlaneProjectRef, "abcdefghijklmnopqrst");
  assert.throws(() => loadConfiguration({
    ...valid,
    ALBERT_RELEASE_CUBE_SMOKE_CONTROL_DATABASE_URL:
      "postgresql://albert_operator_diagnostic_control_runtime:secret@db.abcdefghijklmnopqrst.supabase.co/production?sslmode=disable",
  }));
  assert.throws(() => loadConfiguration({
    ...valid,
    ALBERT_RELEASE_CUBE_SMOKE_CONTROL_DATABASE_URL:
      "postgresql://albert_operator_diagnostic_control_runtime:secret@db.zyxwvutsrqponmlkjihg.supabase.co/production?sslmode=verify-full",
  }));
  assert.throws(() => loadConfiguration({
    ...valid,
    ALBERT_RELEASE_DEPLOYMENT_ID: "123456789-2",
  }));
});

test("authority workflow proves signed authorization and never exports Cube's signing secret", async () => {
  const [workflowBody, runnerBody, machineBody, cubeConfig, dockerfile] = await Promise.all([
    readFile(path.join(root, ".github/workflows/release-authority.yml"), "utf8"),
    readFile(path.join(root, "scripts/run-production-cube-release-smoke.mjs"), "utf8"),
    readFile(path.join(root, "cube-playground/scripts/release-smoke.mjs"), "utf8"),
    readFile(path.join(root, "cube-playground/cube.js"), "utf8"),
    readFile(path.join(root, "cube-playground/Dockerfile"), "utf8"),
  ]);
  const workflow = loadYaml(workflowBody) as {
    jobs: Record<string, { steps?: unknown[]; needs?: string[]; permissions?: Record<string, string> }>;
  };
  const job = workflow.jobs["activate-and-smoke"]!;
  const serializedJob = JSON.stringify(job);
  assert.equal(job.permissions?.actions, "read");
  assert.ok(job.needs?.includes("build-candidate"));
  assert.ok(job.needs?.includes("build-cube-candidate"));
  assert.ok(job.needs?.includes("plan"));
  assert.match(serializedJob, /release-authorization-receipt\.mjs verify/u);
  assert.match(serializedJob, /ALBERT_RELEASE_CUBE_SMOKE_CONTROL_DATABASE_URL/u);
  assert.match(serializedJob, /ALBERT_RELEASE_CONTROL_PLANE_PROJECT_REF/u);
  assert.match(serializedJob, /ALBERT_RELEASE_CUBE_SMOKE_TENANT_ID/u);
  assert.match(serializedJob, /run-production-cube-release-smoke\.mjs/u);
  assert.doesNotMatch(serializedJob, /CUBEJS_API_SECRET/u);
  assert.match(runnerBody, /issue_protected_dogfood_semantic_turn/u);
  assert.match(runnerBody, /finish_protected_dogfood_semantic_turn/u);
  assert.match(runnerBody, /flyctl[\s\S]*machine[\s\S]*exec/u);
  assert.match(machineBody, /\/cubejs-api\/v1\/meta/u);
  assert.match(machineBody, /\/cubejs-api\/v1\/load/u);
  assert.match(machineBody, /future_window_not_empty/u);
  assert.doesNotMatch(machineBody, /console\.log\([^\n]*payload/u);
  assert.match(cubeConfig, /contextToApiScopes/u);
  assert.match(cubeConfig, /albert_release_smoke/u);
  assert.match(cubeConfig, /return \['meta', 'data'\]/u);
  assert.match(dockerfile, /COPY cube-playground\/scripts\/release-smoke\.mjs \/cube\/conf\/scripts\/release-smoke\.mjs/u);
});
