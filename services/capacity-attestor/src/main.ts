import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { pathToFileURL } from "node:url";
import { TransformFleetCapacityCollector } from "./collector.js";
import type { CapacityAttestorPolicy } from "./contracts.js";
import {
  PostgresCapacityAnalyticalObserver,
  PostgresCapacityControlObserver,
  type CapacityPgPool,
} from "./database-observers.js";
import { FlyCapacityObserver, FlyPrometheusObserver, GitHubRunObserver } from "./external-observers.js";
import { createCapacityAttestorHttpHandler } from "./http.js";
import { startCapacityAttestorNodeServer } from "./node-server.js";
import { GitHubOidcVerifier } from "./oidc.js";
import { PostgresCapacityAttestationStore } from "./store.js";

type PgModule = Readonly<{ Pool: new (options: Readonly<Record<string, unknown>>) => CapacityPgPool }>;

export async function startCapacityAttestorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<{ url: string; close(): Promise<void> }>> {
  const policy = loadPolicy(environment);
  const privateKeyPem = Buffer.from(required(environment, "ALBERT_CAPACITY_ED25519_PRIVATE_KEY_BASE64"), "base64").toString("utf8");
  assert.match(privateKeyPem, /-----BEGIN PRIVATE KEY-----/u, "Capacity signing key must be base64-encoded PKCS8 PEM.");
  const signingKey = createPrivateKey(privateKeyPem);
  assert.equal(signingKey.asymmetricKeyType, "ed25519", "Capacity signing key must be Ed25519.");
  const pg = await loadPg();
  const storePool = pool(pg, requiredDatabase(environment, "ALBERT_CAPACITY_ATTESTOR_STORE_DATABASE_URL", "albert_capacity_attestor_store"), "albert-capacity-attestor-store");
  const controlPool = pool(pg, requiredDatabase(environment, "ALBERT_CAPACITY_CONTROL_OBSERVER_DATABASE_URL", "albert_capacity_control_observer"), "albert-capacity-control-observer");
  const analyticalPool = pool(pg, requiredDatabase(environment, "ALBERT_CAPACITY_ANALYTICAL_OBSERVER_DATABASE_URL", "albert_capacity_analytical_observer"), "albert-capacity-analytical-observer");
  const store = new PostgresCapacityAttestationStore(storePool);
  const control = new PostgresCapacityControlObserver(controlPool);
  const analytical = new PostgresCapacityAnalyticalObserver(analyticalPool);
  const collector = new TransformFleetCapacityCollector({
    github: new GitHubRunObserver(required(environment, "ALBERT_CAPACITY_GITHUB_READ_TOKEN")),
    fly: new FlyCapacityObserver(required(environment, "ALBERT_CAPACITY_FLY_READ_TOKEN")),
    prometheus: new FlyPrometheusObserver(
      required(environment, "ALBERT_CAPACITY_PROMETHEUS_ORIGIN"),
      required(environment, "ALBERT_CAPACITY_PROMETHEUS_READ_TOKEN"),
      required(environment, "ALBERT_CAPACITY_PROMETHEUS_RUNNING_QUERY"),
      required(environment, "ALBERT_CAPACITY_PROMETHEUS_DESIRED_QUERY"),
    ),
    control,
    analytical,
    signingKey,
    producerToolRef: required(environment, "ALBERT_CAPACITY_ATTESTOR_TOOL_REF"),
    producerBuildDigest: required(environment, "ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST"),
  });
  const oidc = new GitHubOidcVerifier();
  const handler = createCapacityAttestorHttpHandler({ policy, oidc, collector, store });
  try {
    return await startCapacityAttestorNodeServer({
      handler,
      ready: async () => (await Promise.all([store.ready(), control.ready(), analytical.ready()])).every(Boolean),
      closeDependencies: async () => { await Promise.all([storePool.end?.(), controlPool.end?.(), analyticalPool.end?.()]); },
      host: environment.ALBERT_CAPACITY_ATTESTOR_HOST?.trim() || "0.0.0.0",
      port: boundedInteger(environment.ALBERT_CAPACITY_ATTESTOR_PORT, 8791, 1, 65_535),
    });
  } catch (error) {
    await Promise.all([storePool.end?.(), controlPool.end?.(), analyticalPool.end?.()]);
    throw error;
  }
}

function loadPolicy(environment: NodeJS.ProcessEnv): CapacityAttestorPolicy {
  const repository = required(environment, "ALBERT_CAPACITY_ALLOWED_REPOSITORY");
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, "Capacity allowed repository is invalid.");
  const workflowRef = required(environment, "ALBERT_CAPACITY_ALLOWED_WORKFLOW_REF");
  assert.match(workflowRef, new RegExp(`^${escapeRegex(repository)}/\\.github/workflows/release\\.yml@refs/(?:heads|tags)/[A-Za-z0-9._/-]+$`, "u"),
    "Capacity allowed workflow ref is invalid.");
  const releaseRef = required(environment, "ALBERT_CAPACITY_ALLOWED_RELEASE_REF");
  assert.match(releaseRef, /^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u, "Capacity allowed release ref is invalid.");
  const stagingCellId = required(environment, "ALBERT_CAPACITY_STAGING_CELL_ID");
  const transformApp = required(environment, "ALBERT_CAPACITY_TRANSFORM_APP");
  const autoscalerApp = required(environment, "ALBERT_CAPACITY_AUTOSCALER_APP");
  for (const [name, value] of [["staging cell", stagingCellId], ["transform app", transformApp], ["autoscaler app", autoscalerApp]]) {
    assert.match(value, /^[a-z0-9][a-z0-9-]{1,62}$/u, `Capacity ${name} is invalid.`);
  }
  assert.notEqual(transformApp, autoscalerApp, "Capacity apps must be distinct.");
  const corpusFingerprint = required(environment, "ALBERT_CAPACITY_CORPUS_FINGERPRINT");
  assert.match(corpusFingerprint, /^[a-f0-9]{64}$/u, "Capacity corpus fingerprint is invalid.");
  return Object.freeze({
    repository,
    workflowRef,
    releaseRef,
    stagingEnvironment: "staging-capacity",
    stagingCellId,
    transformApp,
    autoscalerApp,
    requestedFloor: boundedInteger(environment.ALBERT_CAPACITY_REQUESTED_FLOOR, 2, 2, 40),
    corpusFingerprint,
  });
}

function pool(pg: PgModule, connectionString: string, applicationName: string): CapacityPgPool {
  return new pg.Pool({
    connectionString,
    application_name: applicationName,
    max: 2,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 1_800,
  });
}

function requiredDatabase(environment: NodeJS.ProcessEnv, name: string, expectedLogin: string): string {
  const value = required(environment, name);
  const url = new URL(value);
  assert.ok(url.protocol === "postgres:" || url.protocol === "postgresql:", `${name} must be PostgreSQL.`);
  assert.ok(["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? ""), `${name} must require TLS.`);
  assert.equal(decodeURIComponent(url.username).split(".")[0], expectedLogin, `${name} must use ${expectedLogin}.`);
  assert.equal(["localhost", "127.0.0.1", "::1"].includes(url.hostname), false, `${name} cannot be local.`);
  return value;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  assert.ok(value, `${name} is required by the independent capacity attestor.`);
  return value;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  assert.ok(Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum,
    `Expected an integer between ${minimum} and ${maximum}.`);
  return parsed;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function loadPg(): Promise<PgModule> {
  const imported = await import("pg");
  const pgModule = (imported.default ?? imported) as unknown as PgModule;
  if (!pgModule.Pool) throw new Error("Capacity attestor image must provide pg.");
  return pgModule;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const running = await startCapacityAttestorFromEnvironment();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void running.close().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
