import assert from "node:assert/strict";
import { assertEmbeddedServiceBuildIdentity } from "../packages/config/src/build-identity.js";
import { pathToFileURL } from "node:url";
import { mapDeputyCanonical } from "../connectors/deputy/canonical.js";
import { mapLightspeedCanonical } from "../connectors/lightspeed-r/canonical.js";
import { mapXeroCanonical } from "../connectors/xero/canonical.js";
import { CanonicalTransformPipeline } from "../services/sync-workers/src/canonical-pipeline.js";
import { PgTransactionalDatabase } from "../services/sync-workers/src/postgres.js";
import { loadTransformWorkerConfig } from "../services/transform-worker/src/config.js";
import { assertProductionRuntimeBoundary } from "../packages/config/src/production-boundary.js";

const DESIGN_TENANTS = 20_000;
const REVIEWED_LANES_PER_MACHINE = 8;
const MAXIMUM_MACHINES = 40;
const MINIMUM_MACHINES = 2;
const SWEEP_SECONDS = 3_600;
const CAPACITY_UTILIZATION = 0.7;
const MINIMUM_RELEASE_SAMPLE_COUNT = 500;
const CAPACITY_BLOCKING_LIMITATIONS = Object.freeze([
  "single_process_shared_fleet_database_saturation_not_measured",
  "single_process_workload_profile_not_attested",
  "single_process_not_bound_to_protected_staging_orchestration",
  "single_process_cannot_satisfy_independent_fleet_attestation",
] as const);

export type TransformCapacityEnvironment = "local" | "staging";
export type TransformCapacityMode = "load";

export type TransformCapacityEvidence = Readonly<{
  schemaVersion: 2;
  workload: "transform_pipeline_snapshot_projection";
  measurementScope: "single_process_diagnostic";
  generatedAt: string;
  environment: TransformCapacityEnvironment;
  mode: TransformCapacityMode;
  releaseSha: string;
  runId: string;
  sampleCount: number;
  minimumSampleCount: number;
  completedByHarness: number;
  observedP95Ms: number;
  designTenants: 20_000;
  sweepSeconds: 3_600;
  workerProcesses: 1;
  lanesPerProcess: 8;
  claimBatchSize: 8;
  targetUtilization: 0.7;
  minimumMachines: 2;
  maximumMachines: 40;
  projectedRequiredMachines: number;
  projectedMachineFloor: number;
  projectedSweepSecondsAtProjectedFloor: number;
  maximumSupportedP95Ms: number;
  projectionWithinReviewedCeiling: boolean;
  diagnosticPassed: boolean;
  releaseEligible: false;
  blockingLimitations: typeof CAPACITY_BLOCKING_LIMITATIONS;
  source: "run_scoped_durable_transform_maintenance_completion";
}>;

type HarnessConfig = Readonly<{
  environment: TransformCapacityEnvironment;
  mode: TransformCapacityMode;
  releaseSha: string;
  runId: string;
  minimumSamples: number;
  maxClaims: number;
  participantId: string;
  workerId: string;
  notBefore: string | null;
  holdUntil: string | null;
  mappingVersion: string;
  controlPlaneDatabaseUrl: string;
  transformDatabaseUrl: string;
  workerConcurrency: number;
  snapshotClaimBatchSize: number;
}>;

type CapacitySummaryInput = Readonly<{
  environment: TransformCapacityEnvironment;
  mode: TransformCapacityMode;
  releaseSha: string;
  runId: string;
  sampleCount: number;
  minimumSampleCount: number;
  completedByHarness: number;
  observedP95Ms: number;
  generatedAt?: string;
}>;

/**
 * Convert durable per-tenant claim/completion latency into the reviewed fleet
 * requirement. This function deliberately accepts no synthetic tenant-count,
 * utilization, lane, or ceiling overrides.
 */
export function buildTransformCapacityEvidence(input: CapacitySummaryInput): TransformCapacityEvidence {
  assert.ok(Number.isInteger(input.sampleCount) && input.sampleCount >= 0, "Capacity sampleCount is invalid.");
  assert.ok(
    Number.isInteger(input.minimumSampleCount) && input.minimumSampleCount >= 1,
    "Capacity minimumSampleCount is invalid.",
  );
  assert.ok(
    Number.isInteger(input.completedByHarness) && input.completedByHarness >= 0,
    "Capacity completedByHarness is invalid.",
  );
  assert.ok(
    Number.isFinite(input.observedP95Ms) && input.observedP95Ms > 0,
    "Capacity observedP95Ms must be a positive measured duration.",
  );
  assert.match(input.releaseSha, /^(?:local|[a-f0-9]{40})$/u, "Capacity releaseSha is invalid.");
  assert.match(input.runId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u, "Capacity runId is invalid.");

  const projectedRequiredMachines = Math.ceil(
    DESIGN_TENANTS * input.observedP95Ms /
      (SWEEP_SECONDS * 1_000 * REVIEWED_LANES_PER_MACHINE * CAPACITY_UTILIZATION),
  );
  const projectedMachineFloor = Math.max(MINIMUM_MACHINES, projectedRequiredMachines);
  const projectedSweepSecondsAtProjectedFloor =
    DESIGN_TENANTS * input.observedP95Ms /
      (1_000 * REVIEWED_LANES_PER_MACHINE * projectedMachineFloor * CAPACITY_UTILIZATION);
  const maximumSupportedP95Ms =
    SWEEP_SECONDS * 1_000 * REVIEWED_LANES_PER_MACHINE * MAXIMUM_MACHINES * CAPACITY_UTILIZATION /
      DESIGN_TENANTS;
  const projectionWithinReviewedCeiling = projectedMachineFloor <= MAXIMUM_MACHINES;
  const diagnosticPassed = input.sampleCount >= input.minimumSampleCount
    && input.completedByHarness >= input.minimumSampleCount
    && input.sampleCount === input.completedByHarness
    && projectionWithinReviewedCeiling;

  return Object.freeze({
    schemaVersion: 2,
    workload: "transform_pipeline_snapshot_projection",
    measurementScope: "single_process_diagnostic",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    environment: input.environment,
    mode: input.mode,
    releaseSha: input.releaseSha,
    runId: input.runId,
    sampleCount: input.sampleCount,
    minimumSampleCount: input.minimumSampleCount,
    completedByHarness: input.completedByHarness,
    observedP95Ms: input.observedP95Ms,
    designTenants: DESIGN_TENANTS,
    sweepSeconds: SWEEP_SECONDS,
    workerProcesses: 1,
    lanesPerProcess: REVIEWED_LANES_PER_MACHINE,
    claimBatchSize: REVIEWED_LANES_PER_MACHINE,
    targetUtilization: CAPACITY_UTILIZATION,
    minimumMachines: MINIMUM_MACHINES,
    maximumMachines: MAXIMUM_MACHINES,
    projectedRequiredMachines,
    projectedMachineFloor,
    projectedSweepSecondsAtProjectedFloor,
    maximumSupportedP95Ms,
    projectionWithinReviewedCeiling,
    diagnosticPassed,
    releaseEligible: false,
    blockingLimitations: CAPACITY_BLOCKING_LIMITATIONS,
    source: "run_scoped_durable_transform_maintenance_completion",
  });
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required by the transform capacity harness.`);
  return value;
}

function boundedInteger(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(source[name] ?? fallback);
  assert.ok(
    Number.isInteger(value) && value >= minimum && value <= maximum,
    `${name} must be an integer between ${minimum} and ${maximum}.`,
  );
  return value;
}

function managedTimestamp(
  source: NodeJS.ProcessEnv,
  name: string,
  environment: TransformCapacityEnvironment,
): string | null {
  const value = source[name]?.trim();
  if (environment === "local" && !value) return null;
  assert.ok(value, `${name} is required for a protected staging fleet run.`);
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), `${name} must be an ISO timestamp.`);
  const now = Date.now();
  assert.ok(
    parsed >= now - 60_000 && parsed <= now + 2 * 60 * 60 * 1_000,
    `${name} must be within the protected run window.`,
  );
  return new Date(parsed).toISOString();
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? 0;
}

async function waitUntil(timestamp: string | null): Promise<void> {
  if (!timestamp) return;
  while (Date.now() < Date.parse(timestamp)) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, Date.parse(timestamp) - Date.now())));
  }
}

function harnessEnvironment(source: NodeJS.ProcessEnv): TransformCapacityEnvironment {
  const environment = required(source, "ALBERT_CAPACITY_ENVIRONMENT");
  assert.ok(
    environment === "local" || environment === "staging",
    "ALBERT_CAPACITY_ENVIRONMENT must be local or staging; production diagnostics use read-only service telemetry.",
  );
  return environment;
}

function harnessMode(source: NodeJS.ProcessEnv): TransformCapacityMode {
  const mode = source.ALBERT_CAPACITY_MODE?.trim() || "load";
  assert.equal(mode, "load", "ALBERT_CAPACITY_MODE must be load; the harness does not run in production.");
  return "load";
}

export function loadTransformCapacityHarnessConfig(source: NodeJS.ProcessEnv): HarnessConfig {
  const environment = harnessEnvironment(source);
  const mode = harnessMode(source);
  if (environment === "staging") {
    assertProductionRuntimeBoundary({ ...source, NODE_ENV: "production" }, {
      label: "transform capacity diagnostic",
      controlProject: true,
      analyticalRegion: true,
      storageRegion: false,
      modelDataResidency: false,
      lightspeedProduct: false,
      databaseLogins: {
        TRANSFORM_CONTROL_PLANE_DATABASE_URL: "albert_transform_control_runtime",
        TRANSFORM_DATABASE_URL: "albert_transform_analytical_runtime",
      },
      distinctDatabaseVariables: ["TRANSFORM_CONTROL_PLANE_DATABASE_URL", "TRANSFORM_DATABASE_URL"],
    });
  }
  const runtime = loadTransformWorkerConfig(source);
  const releaseSha = environment === "local"
    ? "local"
    : required(source, "ALBERT_SERVICE_VERSION");
  if (environment !== "local") {
    assert.match(releaseSha, /^[a-f0-9]{40}$/u, "ALBERT_SERVICE_VERSION must be a full release SHA for capacity evidence.");
    assert.equal(
      runtime.workerConcurrency,
      REVIEWED_LANES_PER_MACHINE,
      `Capacity evidence requires the reviewed ${REVIEWED_LANES_PER_MACHINE} transform lanes per Machine.`,
    );
    assert.equal(
      runtime.snapshotClaimBatchSize,
      REVIEWED_LANES_PER_MACHINE,
      `Capacity diagnostics require the reviewed ${REVIEWED_LANES_PER_MACHINE}-claim batch.`,
    );
  }
  if (environment === "staging") {
    assert.equal(
      required(source, "ALBERT_CAPACITY_RUN_APPROVED"),
      `load-staging:${releaseSha}`,
      "Staging capacity load requires an approval value bound to the exact release SHA.",
    );
  }

  const minimumSamples = boundedInteger(
    source,
    "ALBERT_CAPACITY_MIN_SAMPLES",
    environment === "local" ? 1 : MINIMUM_RELEASE_SAMPLE_COUNT,
    1,
    DESIGN_TENANTS,
  );
  if (environment !== "local") {
    assert.ok(
      minimumSamples >= MINIMUM_RELEASE_SAMPLE_COUNT,
      `Managed-cell capacity evidence requires at least ${MINIMUM_RELEASE_SAMPLE_COUNT} completed tenants.`,
    );
  }
  const maxClaims = boundedInteger(
    source,
    "ALBERT_CAPACITY_MAX_CLAIMS",
    DESIGN_TENANTS,
    1,
    DESIGN_TENANTS,
  );
  assert.ok(maxClaims >= minimumSamples, "ALBERT_CAPACITY_MAX_CLAIMS cannot be below the minimum sample count.");
  const runId = environment === "local"
    ? source.ALBERT_CAPACITY_RUN_ID?.trim() || `local-${process.pid}`
    : required(source, "ALBERT_CAPACITY_RUN_ID");
  assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u, "ALBERT_CAPACITY_RUN_ID is invalid.");
  const participantId = environment === "staging"
    ? required(source, "FLY_MACHINE_ID")
    : source.ALBERT_CAPACITY_PARTICIPANT_ID?.trim() || String(process.pid).padStart(14, "0");
  assert.match(participantId, /^[a-f0-9]{14}$/u, "Capacity participant id must be the immutable Fly Machine id.");
  const workerId = `capacity:${runId}:${participantId}`;
  assert.ok(workerId.length <= 160, "Capacity run id and participant id exceed the worker-id boundary.");
  const notBefore = managedTimestamp(source, "ALBERT_CAPACITY_NOT_BEFORE", environment);
  const holdUntil = managedTimestamp(source, "ALBERT_CAPACITY_HOLD_UNTIL", environment);
  if (notBefore && holdUntil) {
    assert.ok(Date.parse(holdUntil) > Date.parse(notBefore), "Capacity hold must end after the start barrier.");
  }
  return Object.freeze({
    environment,
    mode,
    releaseSha,
    runId,
    minimumSamples,
    maxClaims,
    participantId,
    workerId,
    notBefore,
    holdUntil,
    mappingVersion: runtime.mappingVersion,
    controlPlaneDatabaseUrl: runtime.controlPlaneDatabaseUrl,
    transformDatabaseUrl: runtime.transformDatabaseUrl,
    workerConcurrency: runtime.workerConcurrency,
    snapshotClaimBatchSize: runtime.snapshotClaimBatchSize,
  });
}

export async function runTransformCapacityHarness(
  source: NodeJS.ProcessEnv = process.env,
): Promise<TransformCapacityEvidence> {
  if (harnessEnvironment(source) === "staging") {
    assertEmbeddedServiceBuildIdentity({ ...source, NODE_ENV: "production" });
  }
  const config = loadTransformCapacityHarnessConfig(source);
  const controlPoolAcquireSamples: number[] = [];
  const analyticalPoolAcquireSamples: number[] = [];
  const control = new PgTransactionalDatabase(config.controlPlaneDatabaseUrl, {
    applicationName: `albert-transform-capacity-control/${config.releaseSha}`,
    maxConnections: config.workerConcurrency + 4,
    onPoolAcquire: (elapsedMs) => controlPoolAcquireSamples.push(elapsedMs),
  });
  const analytical = new PgTransactionalDatabase(config.transformDatabaseUrl, {
    applicationName: `albert-transform-capacity/${config.releaseSha}`,
    maxConnections: config.workerConcurrency + 4,
    onPoolAcquire: (elapsedMs) => analyticalPoolAcquireSamples.push(elapsedMs),
  });
  const pipeline = new CanonicalTransformPipeline(
    analytical,
    control,
    config.mappingVersion,
    {
      "lightspeed-r": mapLightspeedCanonical,
      xero: mapXeroCanonical,
      deputy: mapDeputyCanonical,
    },
  );
  try {
    await waitUntil(config.notBefore);
    const before = await pipeline.transformMaintenanceMetrics();
    assert.ok(
      before.dueTenants >= config.minimumSamples,
      `Only ${before.dueTenants} tenants are due; at least ${config.minimumSamples} are required.`,
    );
    const startedAt = new Date().toISOString();
    let completedByHarness = 0;
    let after: Awaited<ReturnType<typeof pipeline.transformCapacityRunMetrics>>;
    try {
      completedByHarness = await pipeline.snapshotAllTenants(config.workerId, {
        claimBatchSize: config.snapshotClaimBatchSize,
        maxClaims: config.maxClaims,
      });
      after = await pipeline.transformCapacityRunMetrics(config.workerId, startedAt);
    } catch (error) {
      after = await pipeline.transformCapacityRunMetrics(config.workerId, startedAt);
      if (config.environment === "staging") {
        await pipeline.recordTransformCapacityParticipant({
          runId: config.runId,
          participantId: config.participantId,
          workerId: config.workerId,
          releaseSha: config.releaseSha,
          startedAt,
          completedAt: new Date().toISOString(),
          completedClaims: after.completed,
          controlPoolAcquireP95Ms: percentile95(controlPoolAcquireSamples),
          analyticalPoolAcquireP95Ms: percentile95(analyticalPoolAcquireSamples),
          errorCount: 1,
        });
      }
      throw error;
    }
    assert.ok(
      after.completed >= config.minimumSamples,
      `Only ${after.completed} run-scoped durable completion samples exist; at least ${config.minimumSamples} are required.`,
    );
    assert.equal(
      after.completed,
      completedByHarness,
      "The durable run-scoped completion count differs from the snapshot path result; discard this diagnostic.",
    );
    if (config.environment === "staging") {
      await pipeline.recordTransformCapacityParticipant({
        runId: config.runId,
        participantId: config.participantId,
        workerId: config.workerId,
        releaseSha: config.releaseSha,
        startedAt,
        completedAt: new Date().toISOString(),
        completedClaims: after.completed,
        controlPoolAcquireP95Ms: percentile95(controlPoolAcquireSamples),
        analyticalPoolAcquireP95Ms: percentile95(analyticalPoolAcquireSamples),
        errorCount: 0,
      });
    }
    const evidence = buildTransformCapacityEvidence({
      environment: config.environment,
      mode: config.mode,
      releaseSha: config.releaseSha,
      runId: config.runId,
      sampleCount: after.completed,
      minimumSampleCount: config.minimumSamples,
      completedByHarness,
      observedP95Ms: after.completedP95Ms,
    });
    assert.equal(
      evidence.diagnosticPassed,
      true,
      `The diagnostic projection requires ${evidence.projectedRequiredMachines} Machines, beyond the reviewed ${MAXIMUM_MACHINES}-Machine ceiling or without enough samples.`,
    );
    return evidence;
  } finally {
    await Promise.allSettled([control.close(), analytical.close()]);
    await waitUntil(config.holdUntil);
  }
}

async function main(): Promise<void> {
  const evidence = await runTransformCapacityHarness(process.env);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`transform capacity harness failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
