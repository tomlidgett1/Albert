import assert from "node:assert/strict";
import { load as parseYaml } from "js-yaml";
import { CAPACITY_ATTESTATION_SAMPLE_INTERVAL_MS } from "../../../scripts/capacity-attestation-timing.mjs";
import type { CapacityAttestationRequest } from "./contracts.js";

const STARTED_STATES = new Set(["started"]);

export type FlyFleetSnapshot = Readonly<{
  transformRunning: number;
  autoscalerRunning: number;
  transformImageDigest: string;
  transformMachineIds: readonly string[];
  observedAt: string;
}>;

export class GitHubRunObserver {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (token.length < 20) throw new Error("Capacity attestor GitHub token is invalid.");
  }

  async assertCandidateRun(request: CapacityAttestationRequest): Promise<void> {
    const url = new URL(
      `/repos/${encodeURIComponent(request.repository.split("/")[0]!)}/${encodeURIComponent(request.repository.split("/")[1]!)}` +
      `/actions/runs/${request.workflowRunId}/attempts/${request.workflowRunAttempt}`,
      "https://api.github.com",
    );
    const response = await this.fetcher(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "user-agent": "albert-capacity-attestor/1",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub workflow observation returned ${response.status}.`);
    const run = await response.json() as Readonly<Record<string, unknown>>;
    const expectedPath = request.workflowRef.slice(request.repository.length + 1, request.workflowRef.indexOf("@"));
    const expectedRef = request.workflowRef.slice(request.workflowRef.indexOf("@") + 1);
    const observedPath = String(run.path ?? "");
    const [observedFile, observedRef] = observedPath.split("@", 2);
    assert.equal(run.head_sha, request.candidateSha, "Observed GitHub run SHA differs from the candidate.");
    assert.equal(Number(run.run_attempt), request.workflowRunAttempt, "Observed GitHub run attempt differs.");
    assert.equal(run.event, "workflow_dispatch", "Observed GitHub run was not manually protected release dispatch.");
    assert.equal(observedFile, expectedPath, "Observed GitHub workflow path differs.");
    if (observedRef) {
      const shortRef = expectedRef.replace(/^refs\/(?:heads|tags)\//u, "");
      assert.ok(observedRef === expectedRef || observedRef === shortRef,
        "Observed GitHub workflow path ref differs.");
    }
    assert.ok(run.status === "in_progress" || run.status === "queued", "Observed GitHub release run is no longer active.");
    await Promise.all([this.assertExactJob(request), this.assertUniqueProtectedEnvironmentJob(request)]);
  }

  private async assertExactJob(request: CapacityAttestationRequest): Promise<void> {
    const response = await this.github(
      `/repos/${request.repository}/actions/runs/${request.workflowRunId}/attempts/${request.workflowRunAttempt}/jobs?filter=latest&per_page=100`,
      "application/vnd.github+json",
    );
    const body = await response.json() as Readonly<{ total_count?: unknown; jobs?: unknown }>;
    if (!Array.isArray(body.jobs) || Number(body.total_count) !== body.jobs.length || body.jobs.length > 100) {
      throw new Error("Observed GitHub job list is incomplete.");
    }
    const matches = body.jobs.filter((candidate) => {
      const job = candidate as Readonly<Record<string, unknown>>;
      return job.name === "attest-transform-fleet-capacity";
    }) as readonly Readonly<Record<string, unknown>>[];
    assert.equal(matches.length, 1, "Protected capacity workflow must contain exactly one attestation job.");
    const job = matches[0]!;
    assert.equal(job.status, "in_progress", "Protected capacity attestation job is not active.");
    assert.ok(Number.isSafeInteger(job.check_run_id) && Number(job.check_run_id) > 0,
      "Protected capacity job has no immutable check-run identity.");
    assert.match(String(job.check_run_url ?? ""), new RegExp(`/check-runs/${job.check_run_id}$`, "u"),
      "Protected capacity job check-run URL differs.");
    assert.ok(Array.isArray(job.labels) && job.labels.includes("ubuntu-latest"),
      "Protected capacity job is not running on the reviewed runner class.");
    const steps = Array.isArray(job.steps) ? job.steps as readonly Readonly<Record<string, unknown>>[] : [];
    const requestStep = steps.filter((step) => step.name === "Ask the independently pinned attestor to observe and sign the run");
    assert.equal(requestStep.length, 1, "Protected capacity request step is absent or duplicated.");
    assert.equal(requestStep[0]!.status, "in_progress", "OIDC request did not originate while the protected attestor step was active.");
  }

  private async assertUniqueProtectedEnvironmentJob(request: CapacityAttestationRequest): Promise<void> {
    const response = await this.github(
      `/repos/${request.repository}/contents/.github/workflows/release.yml?ref=${request.candidateSha}`,
      "application/vnd.github.raw+json",
    );
    const source = await response.text();
    if (source.length < 100 || source.length > 256 * 1024) throw new Error("Protected release workflow source size is invalid.");
    if (/(?:^|[\s,[{])[&*][A-Za-z0-9_-]+/mu.test(source) || /(?:^|\s)![A-Za-z0-9_-]+/mu.test(source)) {
      throw new Error("Protected release workflow cannot use YAML aliases or custom tags.");
    }
    const document = parseYaml(source) as Readonly<Record<string, unknown>> | null;
    const jobs = document?.jobs;
    if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) throw new Error("Protected release workflow jobs are invalid.");
    const entries = Object.entries(jobs as Readonly<Record<string, unknown>>);
    const protectedEntries = entries.filter(([, value]) => environmentName(value) === "staging-capacity");
    assert.deepEqual(protectedEntries.map(([name]) => name), ["attest-transform-fleet-capacity"],
      "Only the exact capacity attestation job may enter staging-capacity.");
    const attestationJob = (jobs as Readonly<Record<string, unknown>>)["attest-transform-fleet-capacity"];
    if (!attestationJob || typeof attestationJob !== "object" || Array.isArray(attestationJob)) {
      throw new Error("Protected capacity attestation job definition is invalid.");
    }
    const steps = (attestationJob as Readonly<Record<string, unknown>>).steps;
    if (!Array.isArray(steps)) throw new Error("Protected capacity attestation job steps are invalid.");
    const requests = steps.filter((step) => {
      const run = (step as Readonly<Record<string, unknown>> | null)?.run;
      return typeof run === "string" && run.includes("scripts/request-independent-capacity-attestation.mjs");
    });
    assert.equal(requests.length, 1, "Protected capacity workflow must make exactly one independent attestor request.");
  }

  private async github(path: string, accept: string): Promise<Response> {
    const response = await this.fetcher(new URL(path, "https://api.github.com"), {
      headers: {
        accept,
        authorization: `Bearer ${this.token}`,
        "user-agent": "albert-capacity-attestor/1",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub protected workflow observation returned ${response.status}.`);
    return response;
  }
}

function environmentName(job: unknown): string | undefined {
  if (!job || typeof job !== "object" || Array.isArray(job)) return undefined;
  const value = (job as Readonly<Record<string, unknown>>).environment;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const name = (value as Readonly<Record<string, unknown>>).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

type FlyMachine = Readonly<{
  id?: unknown;
  state?: unknown;
  region?: unknown;
  image_ref?: Readonly<{ digest?: unknown }>;
  config?: Readonly<{
    env?: Readonly<Record<string, unknown>>;
    image?: unknown;
  }>;
}>;

export class FlyCapacityObserver {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    if (token.length < 20) throw new Error("Capacity attestor Fly token is invalid.");
  }

  async snapshot(request: CapacityAttestationRequest): Promise<FlyFleetSnapshot> {
    const [transform, autoscaler] = await Promise.all([
      this.machines(request.transformApp),
      this.machines(request.autoscalerApp),
    ]);
    const transformRunning = transform.filter((machine) => STARTED_STATES.has(String(machine.state)));
    const autoscalerRunning = autoscaler.filter((machine) => STARTED_STATES.has(String(machine.state)));
    const expectedDeployment = `capacity-${request.workflowRunId}-${request.workflowRunAttempt}`;
    const digests = new Set<string>();
    const ids: string[] = [];
    for (const machine of transformRunning) {
      const env = machine.config?.env ?? {};
      assert.equal(machine.region, "syd", "Capacity transform Machine is outside Sydney.");
      assert.equal(env.ALBERT_SERVICE_VERSION, request.candidateSha, "Capacity Machine is not the candidate SHA.");
      assert.equal(env.ALBERT_DEPLOYMENT_ID, expectedDeployment, "Capacity Machine deployment identity differs.");
      assert.equal(env.ALBERT_CAPACITY_RUN_ID, request.capacityRunId, "Capacity Machine run identity differs.");
      assert.equal(env.ALBERT_CAPACITY_RUN_APPROVED, `load-staging:${request.candidateSha}`, "Capacity Machine approval differs.");
      assert.equal(env.ALBERT_WORKER_CONCURRENCY, "8", "Capacity Machine lane count differs.");
      assert.equal(env.ALBERT_SNAPSHOT_CLAIM_BATCH_SIZE, "8", "Capacity Machine claim batch differs.");
      const id = String(machine.id ?? "");
      assert.match(id, /^[a-f0-9]{14}$/u, "Capacity Machine id is invalid.");
      ids.push(id);
      const digest = String(machine.image_ref?.digest ?? "");
      assert.match(digest, /^sha256:[a-f0-9]{64}$/u, "Capacity Machine image digest is unavailable.");
      digests.add(digest);
    }
    for (const machine of autoscalerRunning) {
      const env = machine.config?.env ?? {};
      assert.equal(machine.region, "syd", "Capacity autoscaler Machine is outside Sydney.");
      assert.equal(env.FAS_APP_NAME, request.transformApp, "Capacity autoscaler targets another app.");
      assert.equal(env.FAS_CREATED_MACHINE_COUNT, String(request.requestedFloor), "Capacity autoscaler floor differs.");
      assert.equal(env.FAS_PROMETHEUS_QUERY, `vector(${request.requestedFloor})`, "Capacity autoscaler signal differs.");
    }
    assert.equal(digests.size, transformRunning.length === 0 ? 0 : 1, "Capacity transform fleet contains mixed images.");
    return Object.freeze({
      transformRunning: transformRunning.length,
      autoscalerRunning: autoscalerRunning.length,
      transformImageDigest: [...digests][0] ?? "",
      transformMachineIds: Object.freeze(ids.sort()),
      observedAt: new Date(this.clock()).toISOString(),
    });
  }

  private async machines(app: string): Promise<readonly FlyMachine[]> {
    const response = await this.fetcher(`https://api.machines.dev/v1/apps/${encodeURIComponent(app)}/machines`, {
      headers: { accept: "application/json", authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Fly Machine observation for ${app} returned ${response.status}.`);
    const body = await response.json();
    if (!Array.isArray(body) || body.length > 100) throw new Error(`Fly Machine observation for ${app} is invalid.`);
    return body as readonly FlyMachine[];
  }
}

export type PrometheusRangeSample = Readonly<{
  observedAt: string;
  value: number;
}>;

export type PrometheusFleetObservation = Readonly<{
  desiredSamples: readonly PrometheusRangeSample[];
  runningSamples: readonly PrometheusRangeSample[];
}>;

export class FlyPrometheusObserver {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly runningQueryTemplate: string,
    private readonly desiredQueryTemplate: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.fly.io" ||
        !/^\/prometheus\/[a-z0-9][a-z0-9-]{1,62}\/?$/u.test(parsed.pathname) ||
        parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Capacity Prometheus origin must be the Fly organization endpoint.");
    }
    if (token.length < 20) throw new Error("Capacity Prometheus token is invalid.");
    for (const template of [runningQueryTemplate, desiredQueryTemplate]) {
      if (template.length < 1 || template.length > 500 || !template.includes("{{app}}")) {
        throw new Error("Capacity Prometheus query template must contain {{app}}.");
      }
    }
  }

  async observe(request: CapacityAttestationRequest, start: string, end: string): Promise<PrometheusFleetObservation> {
    const [runningSamples, desiredSamples] = await Promise.all([
      this.queryRange(this.runningQueryTemplate.replaceAll("{{app}}", request.transformApp), start, end),
      this.queryRange(this.desiredQueryTemplate.replaceAll("{{app}}", request.autoscalerApp), start, end),
    ]);
    assert.deepEqual(
      runningSamples.map(({ observedAt }) => observedAt),
      desiredSamples.map(({ observedAt }) => observedAt),
      "Fly Prometheus histories are not timestamp-aligned.",
    );
    assert.ok(runningSamples.every(({ value }) =>
      value >= request.requestedFloor && value <= 40),
    "Fly Prometheus history contains a transform fleet dip.");
    assert.ok(desiredSamples.every(({ value }) => value === request.requestedFloor),
      "Fly Prometheus history contains an unexpected autoscaler target.");
    return Object.freeze({ runningSamples, desiredSamples });
  }

  private async queryRange(
    query: string,
    start: string,
    end: string,
  ): Promise<readonly PrometheusRangeSample[]> {
    const startMilliseconds = Date.parse(start);
    const endMilliseconds = Date.parse(end);
    assert.ok(Number.isFinite(startMilliseconds) && Number.isFinite(endMilliseconds) &&
      endMilliseconds >= startMilliseconds,
    "Fly Prometheus observation range is invalid.");
    const expectedSamples = Math.floor(
      (endMilliseconds - startMilliseconds) / CAPACITY_ATTESTATION_SAMPLE_INTERVAL_MS,
    ) + 1;
    if (expectedSamples < 20 || expectedSamples > 20_000) {
      throw new Error("Fly Prometheus observation has an invalid expected sample count.");
    }
    const url = new URL(`${this.origin.replace(/\/+$/u, "")}/api/v1/query_range`);
    url.searchParams.set("query", query);
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);
    url.searchParams.set("step", `${CAPACITY_ATTESTATION_SAMPLE_INTERVAL_MS / 1_000}s`);
    const response = await this.fetcher(url, {
      headers: { accept: "application/json", authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Fly Prometheus observation returned ${response.status}.`);
    const body = await response.json() as Readonly<Record<string, unknown>>;
    if (body.status !== "success") throw new Error("Fly Prometheus observation failed.");
    const data = body.data as Readonly<{ result?: unknown; resultType?: unknown }> | undefined;
    if (data?.resultType !== "matrix") throw new Error("Fly Prometheus query did not return a range matrix.");
    const result = data.result;
    if (!Array.isArray(result) || result.length !== 1) throw new Error("Fly Prometheus query did not return exactly one series.");
    const values = (result[0] as Readonly<{ values?: unknown }> | undefined)?.values;
    if (!Array.isArray(values) || values.length !== expectedSamples) {
      throw new Error("Fly Prometheus observation does not cover the complete requested range.");
    }
    return Object.freeze(values.map((sample, index) => {
      if (!Array.isArray(sample) || sample.length !== 2) throw new Error("Fly Prometheus sample is invalid.");
      const timestampSeconds = sample[0];
      if (typeof timestampSeconds !== "number" || !Number.isFinite(timestampSeconds)) {
        throw new Error("Fly Prometheus timestamp is invalid.");
      }
      const expectedTimestampMilliseconds = startMilliseconds +
        index * CAPACITY_ATTESTATION_SAMPLE_INTERVAL_MS;
      const timestampMilliseconds = timestampSeconds * 1_000;
      if (Math.abs(timestampMilliseconds - expectedTimestampMilliseconds) > 1) {
        throw new Error("Fly Prometheus observation contains a timestamp gap or duplicate.");
      }
      const value = Number(sample[1]);
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Fly Prometheus value is invalid.");
      return Object.freeze({
        observedAt: new Date(timestampMilliseconds).toISOString(),
        value,
      });
    }));
  }
}
