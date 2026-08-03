import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorStream, SyncPage } from "../../packages/connector-sdk/src/index.js";
import type { InitialBackfillJob } from "../../packages/queue/src/index.js";
import {
  buildBackfillPlan,
  isCompletionCoverage,
  phaseCompletesBackfill,
} from "./src/sync-lifecycle.js";

const TO = "2026-08-03T00:00:00.000Z";
const RECENT_FROM = "2026-07-03T00:00:00.000Z";

function job(overrides: Partial<InitialBackfillJob> = {}): InitialBackfillJob {
  return {
    schemaVersion: 1,
    type: "InitialBackfill",
    tenantId: "01K00000000000000000000000",
    connectionId: "01K00000000000000000000001",
    connectionGeneration: 1,
    connectorId: "xero",
    externalAccountReference: "xero-tenant",
    syncRunId: "01K00000000000000000000002",
    batchId: "01K00000000000000000000003",
    requestedAt: TO,
    range: { from: RECENT_FROM, to: TO },
    phase: "recent",
    replayVersion: 1,
    planMode: "progressive",
    ...overrides,
  };
}

function stream(
  backfillStrategy: ConnectorStream["backfillStrategy"],
  overrides: Partial<ConnectorStream> = {},
): ConnectorStream {
  return {
    id: "invoices",
    label: "Invoices",
    domains: ["finance"],
    cursorKind: "high_water_mark",
    backfillStrategy,
    lateEditStrategy: "modified_field",
    deletionStrategy: "authoritative_identity_scan",
    sourceTotalStrategy: "count_distinct_complete_scan",
    availability: "required",
    dependencies: [],
    productDomains: ["accounting"],
    ...overrides,
  };
}

const exhaustiveCoverage = {
  boundaryKind: "verified_oldest",
  lowerBound: "2017-02-01T00:00:00.000Z",
  verification: "exhaustive_vendor_scan",
} as const satisfies NonNullable<SyncPage["coverage"]>;

test("time-windowed streams get one non-overlapping progressive phase plan", () => {
  const plans = buildBackfillPlan(job(), stream("time_windowed"), null);

  assert.deepEqual(plans.map((plan) => plan.phase), [
    "recent",
    "thirteen_months",
    "full_history",
  ]);
  assert.deepEqual(plans.map((plan) => plan.range), [
    { from: RECENT_FROM, to: TO },
    { from: "2025-07-03T00:00:00.000Z", to: RECENT_FROM },
    { from: "1970-01-01T00:00:00.000Z", to: "2025-07-03T00:00:00.000Z" },
  ]);
  assert.ok(plans.every((plan) => plan.planMode === "progressive"));
});

test("snapshot and offset streams are scanned once instead of triple-fetched", () => {
  const snapshot = buildBackfillPlan(
    job(),
    stream("snapshot", { id: "contacts", cursorKind: "page" }),
    null,
  );
  const journals = buildBackfillPlan(
    job(),
    stream("exhaustive_offset", {
      id: "journals",
      cursorKind: "offset",
      availability: "optional",
    }),
    null,
  );

  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0]?.planMode, "single_pass");
  assert.equal(journals.length, 1);
  assert.equal(journals[0]?.planMode, "single_pass");
  assert.equal(journals[0]?.required, false);
});

test("reauthorisation catches up inclusively from trusted prior-generation coverage", () => {
  const reconnectJob = job({ connectionGeneration: 2 });
  const plans = buildBackfillPlan(reconnectJob, stream("time_windowed"), {
    cursor: { value: "opaque", sourceUpdatedAt: "2026-07-28T10:15:00.000Z" },
    sourceWatermark: "2026-07-28T10:15:00.000Z",
    backfillComplete: true,
    connectionGeneration: 1,
    coverage: exhaustiveCoverage,
  });

  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.planMode, "resume_verified");
  assert.deepEqual(plans[0]?.range, {
    from: "2026-07-28T10:15:00.000Z",
    to: TO,
  });
  assert.deepEqual(plans[0]?.inheritedCoverage, exhaustiveCoverage);
  assert.deepEqual(
    phaseCompletesBackfill(
      { ...reconnectJob, planMode: "resume_verified" },
      {
        boundaryKind: "window_exhausted",
        lowerBound: "2026-07-28T10:15:00.000Z",
        verification: "exhaustive_vendor_scan",
      },
      exhaustiveCoverage,
    ),
    { complete: true, coverage: exhaustiveCoverage },
  );
});

test("uncertain or non-adjacent prior state forces a full rebuild", () => {
  const reconnectJob = job({ connectionGeneration: 3 });
  const plans = buildBackfillPlan(reconnectJob, stream("time_windowed"), {
    cursor: { value: "opaque" },
    sourceWatermark: "2026-07-28T10:15:00.000Z",
    backfillComplete: true,
    connectionGeneration: 1,
    coverage: exhaustiveCoverage,
  });

  assert.equal(plans.length, 3);
  assert.equal(plans.at(-1)?.range.from, "1970-01-01T00:00:00.000Z");
  assert.ok(plans.every((plan) => plan.planMode === "progressive"));

  const missingOpaqueCursor = buildBackfillPlan(
    job({ connectionGeneration: 2 }),
    stream("time_windowed"),
    {
      cursor: null,
      sourceWatermark: "2026-07-28T10:15:00.000Z",
      backfillComplete: true,
      connectionGeneration: 1,
      coverage: exhaustiveCoverage,
    },
  );
  assert.equal(missingOpaqueCursor.length, 3);
});

test("backfill completion requires explicit terminal coverage evidence", () => {
  const incomplete = {
    boundaryKind: "window_exhausted",
    lowerBound: RECENT_FROM,
    verification: "exhaustive_vendor_scan",
  } as const satisfies NonNullable<SyncPage["coverage"]>;

  assert.equal(isCompletionCoverage(incomplete), false);
  assert.deepEqual(
    phaseCompletesBackfill(job({ phase: "full_history" }), incomplete, null),
    { complete: false, coverage: null },
  );
  assert.deepEqual(
    phaseCompletesBackfill(job({ phase: "full_history" }), exhaustiveCoverage, null),
    { complete: true, coverage: exhaustiveCoverage },
  );
  assert.equal(isCompletionCoverage({
    boundaryKind: "vendor_retention",
    lowerBound: "2018-01-01T00:00:00.000Z",
    verification: "vendor_reported",
  }), true);
  assert.equal(isCompletionCoverage({
    boundaryKind: "account_start",
    lowerBound: "2021-05-04T00:00:00.000Z",
    verification: "account_metadata",
  }), true);
});
