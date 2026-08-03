import assert from "node:assert/strict";
import { createHash, type KeyObject } from "node:crypto";
import {
  canonicalJson,
  createCapacityNonce,
  createTransformFleetCapacityAttestation,
} from "../../../scripts/transform-fleet-capacity-attestation.mjs";
import {
  CAPACITY_ATTESTATION_MAX_OBSERVATION_MS,
  CAPACITY_ATTESTATION_SAMPLE_INTERVAL_MS,
} from "../../../scripts/capacity-attestation-timing.mjs";
import type { CapacityAttestationRequest } from "./contracts.js";
import type {
  ControlCapacitySample,
  ControlRunDetail,
  DatabasePressureSample,
  PostgresCapacityAnalyticalObserver,
  PostgresCapacityControlObserver,
} from "./database-observers.js";
import type {
  FlyCapacityObserver,
  FlyFleetSnapshot,
  FlyPrometheusObserver,
  GitHubRunObserver,
} from "./external-observers.js";

const DESIGN_TENANTS = 20_000;
const MINIMUM_SAMPLES = 20;
const MINIMUM_STABLE_MS = 300_000;

export type CapacityCollectorCheckpoint = Readonly<{
  schemaVersion: 1;
  observationStartedAt: string;
  firstSample: ControlCapacitySample;
  controlSamples: readonly ControlCapacitySample[];
  analyticalSamples: readonly DatabasePressureSample[];
  fleetSamples: readonly FlyFleetSnapshot[];
  floorReachedAt: string | null;
  verifiedDeployment: FlyFleetSnapshot | null;
}>;

export type CapacityCollectorPersistence = Readonly<{
  checkpoint?: unknown;
  save(checkpoint: CapacityCollectorCheckpoint): Promise<void>;
}>;

export type CapacityCollectorDependencies = Readonly<{
  github: Pick<GitHubRunObserver, "assertAuthorityRun">;
  fly: Pick<FlyCapacityObserver, "snapshot">;
  prometheus: Pick<FlyPrometheusObserver, "observe">;
  control: Pick<PostgresCapacityControlObserver, "sample" | "detail">;
  analytical: Pick<PostgresCapacityAnalyticalObserver, "sample">;
  signingKey: KeyObject | string | Buffer;
  producerToolRef: string;
  producerBuildDigest: string;
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  sampleIntervalMs?: number;
  minimumSamples?: number;
  minimumStableMs?: number;
  maximumObservationMs?: number;
}>;

export class TransformFleetCapacityCollector {
  private readonly clock: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly dependencies: CapacityCollectorDependencies) {
    this.clock = dependencies.clock ?? Date.now;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    assert.match(dependencies.producerToolRef,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u,
      "Capacity producer tool ref must be immutable.");
    assert.match(dependencies.producerBuildDigest, /^sha256:[a-f0-9]{64}$/u,
      "Capacity producer build digest is invalid.");
  }

  async collect(
    request: CapacityAttestationRequest,
    persistence?: CapacityCollectorPersistence,
  ): Promise<Readonly<Record<string, unknown>>> {
    await this.dependencies.github.assertAuthorityRun(request);
    const restored = persistence?.checkpoint === undefined || persistence.checkpoint === null
      ? undefined
      : restoreCheckpoint(persistence.checkpoint);
    if (restored) {
      assert.ok(restored.fleetSamples.every((sample) =>
        sample.transformRunning >= request.requestedFloor && sample.transformRunning <= 40),
      "Capacity collector checkpoint contains a below-floor fleet observation.");
      assert.ok(restored.fleetSamples.every((sample) =>
        sample.transformImageDigest === request.candidateTransformImageDigest),
      "Capacity collector checkpoint contains another candidate image.");
    }
    const observationStartedAt = restored?.observationStartedAt ?? new Date(this.clock()).toISOString();
    const firstSample = restored?.firstSample ?? await this.dependencies.control.sample(request);
    assert.equal(firstSample.maintenanceDue, DESIGN_TENANTS,
      "Capacity cell did not begin with exactly 20,000 due tenants.");
    assert.equal(firstSample.transformQueueDepth, 0,
      "Capacity cell canonical transform queue was not empty at observation start.");

    const controlSamples: ControlCapacitySample[] = restored
      ? [...restored.controlSamples]
      : [firstSample];
    const analyticalSamples: DatabasePressureSample[] = restored
      ? [...restored.analyticalSamples]
      : [await this.dependencies.analytical.sample()];
    const fleetSamples: FlyFleetSnapshot[] = restored ? [...restored.fleetSamples] : [];
    const observationStartedMs = Date.parse(observationStartedAt);
    const deadline = observationStartedMs +
      (this.dependencies.maximumObservationMs ?? CAPACITY_ATTESTATION_MAX_OBSERVATION_MS);
    let floorReachedAt: string | null = restored?.floorReachedAt ?? null;
    let verifiedDeployment: FlyFleetSnapshot | null = restored?.verifiedDeployment ?? null;
    const saveCheckpoint = async (): Promise<void> => {
      if (!persistence) return;
      await persistence.save(checkpointDocument({
        observationStartedAt,
        firstSample,
        controlSamples,
        analyticalSamples,
        fleetSamples,
        floorReachedAt,
        verifiedDeployment,
      }));
    };
    if (!restored) await saveCheckpoint();

    while (this.clock() <= deadline) {
      const fleet = await this.dependencies.fly.snapshot(request);
      if (fleet.transformRunning > 0) {
        assert.equal(fleet.transformImageDigest, request.candidateTransformImageDigest,
          "Capacity fleet observation contains another candidate image.");
      }
      if (floorReachedAt === null && fleet.transformRunning >= request.requestedFloor) {
        floorReachedAt = fleet.observedAt;
      }
      if (floorReachedAt !== null) {
        fleetSamples.push(fleet);
        if (fleet.transformRunning < request.requestedFloor) {
          // Persist the adverse direct observation before failing so a process
          // death cannot turn a measured dip into an apparently clean resume.
          await saveCheckpoint();
          assert.fail("Capacity transform fleet dropped below the requested floor after stability began.");
        }
        if (verifiedDeployment === null && fleet.transformRunning === request.requestedFloor) {
          verifiedDeployment = fleet;
        }
      }
      const [control, analytical] = await Promise.all([
        this.dependencies.control.sample(request),
        this.dependencies.analytical.sample(),
      ]);
      controlSamples.push(control);
      analyticalSamples.push(analytical);
      await saveCheckpoint();
      const stableMs = floorReachedAt ? this.clock() - Date.parse(floorReachedAt) : 0;
      if (
        control.completedClaims === DESIGN_TENANTS &&
        control.maintenanceDue === 0 &&
        control.participantCount === request.requestedFloor &&
        controlSamples.length >= (this.dependencies.minimumSamples ?? MINIMUM_SAMPLES) &&
        stableMs >= (this.dependencies.minimumStableMs ?? MINIMUM_STABLE_MS)
      ) break;
      await this.sleep(this.dependencies.sampleIntervalMs ?? CAPACITY_ATTESTATION_SAMPLE_INTERVAL_MS);
    }
    assert.ok(floorReachedAt && verifiedDeployment, "Capacity fleet never established the exact requested floor.");
    const finalSample = controlSamples.at(-1)!;
    assert.equal(finalSample.completedClaims, DESIGN_TENANTS, "Capacity fleet did not complete all 20,000 claims.");
    assert.equal(finalSample.maintenanceDue, 0, "Capacity fleet did not drain all due maintenance work.");
    assert.equal(finalSample.transformQueueDepth, 0, "Capacity fleet left canonical transform work queued.");
    assert.equal(finalSample.oldestVisibleJobAgeSeconds, 0, "Capacity fleet left aged transform work visible.");
    assert.ok(controlSamples.length >= (this.dependencies.minimumSamples ?? MINIMUM_SAMPLES),
      "Capacity fleet observation has too few direct database samples.");
    assert.equal(analyticalSamples.length, controlSamples.length,
      "Capacity database observation streams are incomplete.");
    assert.ok(fleetSamples.length > 0 && fleetSamples.every((sample) =>
      sample.transformRunning >= request.requestedFloor && sample.transformRunning <= 40),
    "Capacity transform fleet dropped below the requested floor.");
    assert.ok(fleetSamples.every((sample) => sample.autoscalerRunning === 1),
      "Capacity autoscaler was not continuously singular and running.");
    assert.equal(new Set(fleetSamples.map((sample) => sample.transformImageDigest)).size, 1,
      "Capacity transform image changed during observation.");
    assert.equal(verifiedDeployment.transformImageDigest, request.candidateTransformImageDigest,
      "Capacity verified deployment is not the approved candidate image.");

    const detail = await this.dependencies.control.detail(request);
    validateDetail(request, detail, fleetSamples);
    const prometheus = await this.dependencies.prometheus.observe(
      request,
      floorReachedAt,
      detail.completedAt,
    );
    const runningCounts = prometheus.runningSamples.map(({ value }) => value);
    const desiredCounts = prometheus.desiredSamples.map(({ value }) => value);
    assert.deepEqual(
      prometheus.runningSamples.map(({ observedAt }) => observedAt),
      prometheus.desiredSamples.map(({ observedAt }) => observedAt),
      "Independent Prometheus histories are not timestamp-aligned.",
    );
    assert.ok(runningCounts.every((value) => value >= request.requestedFloor && value <= 40),
      "Independent Prometheus history shows the fleet below its requested floor.");
    assert.ok(desiredCounts.every((value) => value === request.requestedFloor),
      "Independent Prometheus history shows an unexpected autoscaler target.");

    const generatedAtMs = this.clock();
    assert.ok(generatedAtMs >= Date.parse(detail.completedAt), "Capacity attestation clock precedes run completion.");
    const controlPressure = summarizePressure(controlSamples.map((sample) => sample.pressure),
      Math.max(...detail.participants.map((participant) => participant.controlPoolAcquireP95Ms)));
    const analyticalPressure = summarizePressure(analyticalSamples,
      Math.max(...detail.participants.map((participant) => participant.analyticalPoolAcquireP95Ms)));
    const participantDocument = detail.participants.map((participant) => ({
      participantId: participant.participantId,
      workerId: participant.workerId,
      releaseSha: participant.releaseSha,
      completedClaims: participant.completedClaims,
      errorCount: participant.errorCount,
    }));
    const observedCounts = fleetSamples.map((sample) => sample.transformRunning);
    const stableSeconds = Math.floor((Date.parse(detail.completedAt) - Date.parse(floorReachedAt)) / 1_000);
    const payload = {
      schemaVersion: 2,
      kind: "albert_transform_fleet_capacity",
      stagingEnvironment: "staging",
      stagingCellId: request.stagingCellId,
      authority: {
        repository: request.repository,
        sha: request.authoritySha,
        ref: request.authorityRef,
        runId: request.workflowRunId,
        runAttempt: request.workflowRunAttempt,
        job: "attest-transform-fleet-capacity",
        workflowRef: request.workflowRef,
      },
      candidate: {
        sha: request.candidateSha,
        transformImageDigest: request.candidateTransformImageDigest,
        releasePlanDigest: request.releasePlanDigest,
      },
      nonce: createCapacityNonce(),
      startedAt: detail.startedAt,
      completedAt: detail.completedAt,
      generatedAt: new Date(generatedAtMs).toISOString(),
      expiresAt: new Date(generatedAtMs + 90 * 60_000).toISOString(),
      passed: true,
      producer: {
        toolRef: this.dependencies.producerToolRef,
        buildDigest: this.dependencies.producerBuildDigest,
      },
      workload: {
        designTenants: DESIGN_TENANTS,
        completedTenants: detail.workload.completedTenants,
        distinctTenants: detail.distinctTenants,
        corpusContractDigest: request.corpusContractDigest,
        corpusFingerprint: detail.workload.corpusFingerprint,
        sourceRows: detail.workload.sourceRows,
        canonicalRows: detail.workload.canonicalRows,
        strata: detail.workload.strata,
      },
      fleet: {
        requestedMachineFloor: request.requestedFloor,
        observedWorkerProcesses: detail.participants.length,
        minRunningMachines: Math.min(...observedCounts),
        maxRunningMachines: Math.max(...observedCounts),
        completedClaims: detail.completedClaims,
        errorCount: detail.participants.reduce((total, participant) => total + participant.errorCount, 0),
        p95TenantMs: detail.p95TenantMs,
        p99TenantMs: detail.p99TenantMs,
        sweepDurationMs: Date.parse(detail.completedAt) - Date.parse(detail.startedAt),
        participantDigest: createHash("sha256").update(canonicalJson(participantDocument)).digest("hex"),
      },
      queue: {
        maintenanceDueAtStart: firstSample.maintenanceDue,
        maintenanceDueAtEnd: finalSample.maintenanceDue,
        maxActiveMaintenanceLeases: Math.max(...controlSamples.map((sample) => sample.activeMaintenanceLeases)),
        transformJobQueueDepthAtStart: firstSample.transformQueueDepth,
        transformJobQueueDepthAtEnd: finalSample.transformQueueDepth,
        oldestVisibleJobAgeSecondsAtEnd: finalSample.oldestVisibleJobAgeSeconds,
        sampleCount: controlSamples.length,
      },
      databases: { control: controlPressure, analytical: analyticalPressure },
      autoscaler: {
        appName: request.autoscalerApp,
        minDesiredMachines: Math.min(...desiredCounts),
        maxDesiredMachines: Math.max(...desiredCounts),
        minObservedMachines: Math.min(...observedCounts),
        maxObservedMachines: Math.max(...observedCounts),
        reachedRequestedFloorAt: floorReachedAt,
        stableAtOrAboveFloorSeconds: stableSeconds,
        sampleCount: runningCounts.length,
        errorCount: 0,
      },
      stagingDeployment: {
        appName: request.transformApp,
        imageDigest: verifiedDeployment.transformImageDigest,
        releaseSha: request.candidateSha,
        appliedFloor: request.requestedFloor,
        verifiedRunningMachines: verifiedDeployment.transformRunning,
        verifiedAt: verifiedDeployment.observedAt,
      },
      recommendedProductionFloor: request.requestedFloor,
    };
    return createTransformFleetCapacityAttestation(payload, this.dependencies.signingKey) as Readonly<Record<string, unknown>>;
  }
}

function checkpointDocument(input: Omit<CapacityCollectorCheckpoint, "schemaVersion">): CapacityCollectorCheckpoint {
  return Object.freeze({
    schemaVersion: 1 as const,
    observationStartedAt: input.observationStartedAt,
    firstSample: input.firstSample,
    controlSamples: Object.freeze([...input.controlSamples]),
    analyticalSamples: Object.freeze([...input.analyticalSamples]),
    fleetSamples: Object.freeze([...input.fleetSamples]),
    floorReachedAt: input.floorReachedAt,
    verifiedDeployment: input.verifiedDeployment,
  });
}

function restoreCheckpoint(input: unknown): CapacityCollectorCheckpoint {
  assert.ok(input && typeof input === "object" && !Array.isArray(input),
    "Capacity collector checkpoint is invalid.");
  const value = input as Readonly<Record<string, unknown>>;
  assert.equal(value.schemaVersion, 1, "Capacity collector checkpoint schema is unsupported.");
  assert.ok(typeof value.observationStartedAt === "string" &&
    Number.isFinite(Date.parse(value.observationStartedAt)),
  "Capacity collector checkpoint start time is invalid.");
  assert.ok(value.firstSample && typeof value.firstSample === "object" && !Array.isArray(value.firstSample),
    "Capacity collector checkpoint initial sample is invalid.");
  for (const [name, samples] of [
    ["control", value.controlSamples],
    ["analytical", value.analyticalSamples],
    ["fleet", value.fleetSamples],
  ] as const) {
    assert.ok(Array.isArray(samples) && samples.length <= 20_000,
      `Capacity collector checkpoint ${name} samples are invalid.`);
    assert.ok(samples.every((sample) => sample && typeof sample === "object" && !Array.isArray(sample)),
      `Capacity collector checkpoint ${name} sample is invalid.`);
  }
  assert.ok((value.controlSamples as readonly unknown[]).length >= 1,
    "Capacity collector checkpoint has no control sample.");
  assert.equal(
    (value.controlSamples as readonly unknown[]).length,
    (value.analyticalSamples as readonly unknown[]).length,
    "Capacity collector checkpoint database streams are incomplete.",
  );
  assert.deepEqual((value.controlSamples as readonly unknown[])[0], value.firstSample,
    "Capacity collector checkpoint initial sample differs.");
  assert.ok(value.floorReachedAt === null ||
    (typeof value.floorReachedAt === "string" && Number.isFinite(Date.parse(value.floorReachedAt))),
  "Capacity collector checkpoint floor time is invalid.");
  assert.ok(value.verifiedDeployment === null ||
    (value.verifiedDeployment && typeof value.verifiedDeployment === "object" && !Array.isArray(value.verifiedDeployment)),
  "Capacity collector checkpoint deployment sample is invalid.");
  if (value.floorReachedAt === null) {
    assert.equal((value.fleetSamples as readonly unknown[]).length, 0,
      "Capacity collector checkpoint retained fleet samples before stability.");
    assert.equal(value.verifiedDeployment, null,
      "Capacity collector checkpoint verified a deployment before stability.");
  } else {
    assert.ok((value.fleetSamples as readonly unknown[]).length >= 1,
      "Capacity collector checkpoint has no stable fleet sample.");
  }
  return checkpointDocument({
    observationStartedAt: value.observationStartedAt as string,
    firstSample: value.firstSample as ControlCapacitySample,
    controlSamples: value.controlSamples as readonly ControlCapacitySample[],
    analyticalSamples: value.analyticalSamples as readonly DatabasePressureSample[],
    fleetSamples: value.fleetSamples as readonly FlyFleetSnapshot[],
    floorReachedAt: value.floorReachedAt as string | null,
    verifiedDeployment: value.verifiedDeployment as FlyFleetSnapshot | null,
  });
}

function validateDetail(
  request: CapacityAttestationRequest,
  detail: ControlRunDetail,
  fleetSamples: readonly FlyFleetSnapshot[],
): void {
  assert.equal(detail.completedClaims, DESIGN_TENANTS, "Capacity direct lease count is incomplete.");
  assert.equal(detail.distinctTenants, DESIGN_TENANTS, "Capacity run did not process 20,000 distinct tenants.");
  assert.equal(detail.workload.completedTenants, DESIGN_TENANTS, "Capacity workload profile is incomplete.");
  assert.equal(detail.workload.corpusFingerprint, request.corpusFingerprint,
    "Capacity completed workload differs from the independently approved corpus.");
  assert.equal(detail.participants.length, request.requestedFloor,
    "Capacity participant count differs from the requested Machine floor.");
  assert.equal(detail.participants.reduce((sum, participant) => sum + participant.completedClaims, 0), DESIGN_TENANTS,
    "Capacity participant claim totals are incomplete.");
  assert.ok(detail.participants.every((participant) =>
    participant.releaseSha === request.candidateSha && participant.errorCount === 0),
  "Capacity participant release identity or outcome differs.");
  const participantIds = detail.participants.map((participant) => participant.participantId).sort();
  const observedIds = fleetSamples.at(-1)!.transformMachineIds;
  assert.deepEqual(participantIds, observedIds, "Capacity DB participants differ from the observed Fly Machines.");
}

function summarizePressure(samples: readonly DatabasePressureSample[], poolAcquireP95Ms: number) {
  assert.ok(samples.length >= 1, "Capacity database samples are missing.");
  const maxConnections = samples[0]!.maxConnections;
  assert.ok(samples.every((sample) => sample.maxConnections === maxConnections),
    "Capacity database max_connections changed during the run.");
  const peakConnections = Math.max(...samples.map((sample) => sample.connections));
  const deadlocksDelta = samples.at(-1)!.deadlocks - samples[0]!.deadlocks;
  assert.ok(deadlocksDelta >= 0, "Capacity database statistics reset during the run.");
  return Object.freeze({
    maxConnections,
    peakConnections,
    peakUtilization: peakConnections / maxConnections,
    poolAcquireP95Ms,
    maxLockWaiters: Math.max(...samples.map((sample) => sample.lockWaiters)),
    deadlocksDelta,
    sampleCount: samples.length,
  });
}
