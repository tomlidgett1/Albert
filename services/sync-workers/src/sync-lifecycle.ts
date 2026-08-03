import type {
  ConnectorStream,
  SyncPage,
} from "../../../packages/connector-sdk/src/index.js";
import type {
  InitialBackfillJob,
} from "../../../packages/queue/src/index.js";

export type PersistedStreamCursor = Readonly<{
  cursor: Readonly<{ value: string; sourceUpdatedAt?: string }> | null;
  sourceWatermark: string | null;
  backfillComplete: boolean;
  connectionGeneration: number;
  coverage: SyncPage["coverage"] | null;
}>;

export type BackfillPhasePlan = Readonly<{
  stream: string;
  domains: readonly string[];
  dependencies: readonly string[];
  required: boolean;
  strategy: ConnectorStream["backfillStrategy"];
  phase: InitialBackfillJob["phase"];
  planMode: InitialBackfillJob["planMode"];
  range: InitialBackfillJob["range"];
  replayVersion: number;
  inheritedCoverage: SyncPage["coverage"] | null;
}>;

const HISTORY_FLOOR = "1970-01-01T00:00:00.000Z";
const COMPLETION_BOUNDARIES = new Set<NonNullable<SyncPage["coverage"]>["boundaryKind"]>([
  "verified_oldest",
  "verified_empty",
  "account_start",
  "vendor_retention",
  "snapshot_at",
]);

function subtractUtcMonths(value: string, months: number): string {
  const source = new Date(value);
  if (!Number.isFinite(source.valueOf())) throw new Error("backfill_plan_timestamp_invalid");
  const day = source.getUTCDate();
  source.setUTCDate(1);
  source.setUTCMonth(source.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(
    source.getUTCFullYear(),
    source.getUTCMonth() + 1,
    0,
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  )).getUTCDate();
  source.setUTCDate(Math.min(day, lastDay));
  return source.toISOString();
}

export function isCompletionCoverage(
  coverage: SyncPage["coverage"] | null | undefined,
): coverage is NonNullable<SyncPage["coverage"]> {
  return Boolean(coverage && COMPLETION_BOUNDARIES.has(coverage.boundaryKind));
}

function trustedPreviousCoverage(
  job: InitialBackfillJob,
  previous: PersistedStreamCursor | null,
): previous is PersistedStreamCursor & Readonly<{
  cursor: NonNullable<PersistedStreamCursor["cursor"]>;
  sourceWatermark: string;
  coverage: NonNullable<SyncPage["coverage"]>;
}> {
  if (!previous || previous.connectionGeneration !== job.connectionGeneration - 1) return false;
  if (
    !previous.cursor ||
    !previous.backfillComplete ||
    !previous.sourceWatermark ||
    !isCompletionCoverage(previous.coverage)
  ) {
    return false;
  }
  const watermark = Date.parse(previous.sourceWatermark);
  return Number.isFinite(watermark) && watermark <= Date.parse(job.range.to);
}

export function buildBackfillPlan(
  job: InitialBackfillJob,
  stream: ConnectorStream,
  previous: PersistedStreamCursor | null,
): readonly BackfillPhasePlan[] {
  const base = {
    stream: stream.id,
    domains: [...stream.productDomains],
    dependencies: [...stream.dependencies],
    required: stream.availability === "required",
    strategy: stream.backfillStrategy,
    replayVersion: 1,
  } as const;

  if (stream.backfillStrategy !== "time_windowed") {
    return [{
      ...base,
      phase: "recent",
      planMode: "single_pass",
      range: job.range,
      inheritedCoverage: null,
    }];
  }

  if (trustedPreviousCoverage(job, previous)) {
    return [{
      ...base,
      phase: "recent",
      planMode: "resume_verified",
      // Source filters are inclusive. Starting at the previously committed
      // modified watermark provides deterministic at-least-once catch-up.
      range: { from: previous.sourceWatermark, to: job.range.to },
      inheritedCoverage: previous.coverage,
    }];
  }

  const thirteenMonthBoundary = subtractUtcMonths(job.range.to, 13);
  const candidates: readonly BackfillPhasePlan[] = [
    {
      ...base,
      phase: "recent",
      planMode: "progressive",
      range: job.range,
      inheritedCoverage: null,
    },
    {
      ...base,
      phase: "thirteen_months",
      planMode: "progressive",
      range: { from: thirteenMonthBoundary, to: job.range.from },
      inheritedCoverage: null,
    },
    {
      ...base,
      phase: "full_history",
      planMode: "progressive",
      range: { from: HISTORY_FLOOR, to: thirteenMonthBoundary },
      inheritedCoverage: null,
    },
  ];
  return candidates.filter((candidate) =>
    Date.parse(candidate.range.from) < Date.parse(candidate.range.to)
  );
}

export function phaseCompletesBackfill(
  job: InitialBackfillJob,
  pageCoverage: SyncPage["coverage"] | null | undefined,
  inheritedCoverage: SyncPage["coverage"] | null | undefined,
): Readonly<{ complete: boolean; coverage: NonNullable<SyncPage["coverage"]> | null }> {
  if (job.planMode === "progressive" && job.phase !== "full_history") {
    return { complete: false, coverage: null };
  }
  if (job.planMode === "resume_verified" && isCompletionCoverage(inheritedCoverage)) {
    return { complete: true, coverage: inheritedCoverage };
  }
  return isCompletionCoverage(pageCoverage)
    ? { complete: true, coverage: pageCoverage }
    : { complete: false, coverage: null };
}

export function nextBackfillPlan(
  plans: readonly BackfillPhasePlan[],
  phase: InitialBackfillJob["phase"],
): BackfillPhasePlan | null {
  const index = plans.findIndex((candidate) => candidate.phase === phase);
  return index >= 0 ? plans[index + 1] ?? null : null;
}
