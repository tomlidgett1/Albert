import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createV3CommentaryState,
  prepareV3CommentaryUpdate,
} from "../../packages/albert-v3/src/engine/commentary.js";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("v3 commentary is sparse, evidence-gated, and bounded", () => {
  const state = createV3CommentaryState(true, 3);

  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "plan",
    message: "I’ll compare the recent movement with its main drivers, then cross-check the strongest signal.",
    queryCount: 0,
  }), {
    accepted: true,
    text: "I’ll compare the recent movement with its main drivers, then cross-check the strongest signal.",
  });

  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "plan",
    message: "I’ll make a second plan.",
    queryCount: 0,
  }), { accepted: false, reason: "plan_exists" });

  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "finding",
    message: "A material movement is emerging, and I’m checking what explains it.",
    queryCount: 0,
  }), { accepted: false, reason: "no_new_evidence" });

  assert.equal(prepareV3CommentaryUpdate({
    state,
    kind: "finding",
    message: "A material movement is emerging, and I’m checking what explains it.",
    queryCount: 1,
  }).accepted, true);

  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "finding",
    message: "A material movement is emerging, and I’m checking what explains it.",
    queryCount: 2,
  }), { accepted: false, reason: "duplicate" });

  assert.equal(prepareV3CommentaryUpdate({
    state,
    kind: "finding",
    message: "The driver is concentrated in one segment, so I’m validating whether it persists over time.",
    queryCount: 2,
  }).accepted, true);

  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "finding",
    message: "This fourth update should not be shown.",
    queryCount: 3,
  }), { accepted: false, reason: "limit" });
});

test("step summaries sit outside the general ceiling but stay deduplicated and capped", () => {
  const state = createV3CommentaryState(true, 1, 2);

  assert.equal(prepareV3CommentaryUpdate({
    state,
    kind: "plan",
    message: "I’ll compare margins by department, then look at workshop utilisation.",
    queryCount: 0,
  }).accepted, true);
  // General ceiling (1) is spent; a finding is refused …
  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "finding",
    message: "Parts margin is the weak spot, so I’m checking supplier pricing next.",
    queryCount: 1,
  }), { accepted: false, reason: "limit" });
  // … but a completed-step summary still shows.
  assert.equal(prepareV3CommentaryUpdate({
    state,
    kind: "step",
    message: "Parts and accessories run a 31% gross margin against 44% for workshop; parts is where the money leaks.",
    queryCount: 1,
  }).accepted, true);
  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "step",
    message: "Parts and accessories run a 31% gross margin against 44% for workshop; parts is where the money leaks.",
    queryCount: 2,
  }), { accepted: false, reason: "duplicate" });
  assert.equal(prepareV3CommentaryUpdate({
    state,
    kind: "step",
    message: "Workshop labour is 61% utilised; about $4,200 a month of billable time goes unsold.",
    queryCount: 2,
  }).accepted, true);
  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "step",
    message: "A third step summary is over the per-turn cap of two.",
    queryCount: 3,
  }), { accepted: false, reason: "limit" });
});

test("update_plan carries a per-step findings summary and query tools nudge for it", () => {
  const tools = read("packages/albert-v3/src/engine/tools.ts");
  const initialPlan = read("packages/albert-v3/src/engine/initial-plan.ts");
  const lanes = read("packages/albert-v3/src/engine/lanes.ts");
  const deepLane = read("packages/albert-v3/src/engine/deep-lane.ts");

  assert.match(tools, /name: "update_plan"[\s\S]*summary: z\.string\(\)[\s\S]*\.nullable\(\)/u);
  assert.match(tools, /kind: "step",\s*message: summary/u);
  assert.match(tools, /completed without a summary/u);
  // Every governed query result path carries the nudge while a step awaits its summary.
  assert.ok((tools.match(/\.\.\.planStepSummaryNudge\(context\)/gu) ?? []).length >= 4);
  assert.match(initialPlan, /planStepsAwaitingSummary = \[\.\.\.\(context\.planStepsAwaitingSummary \?\? \[\]\), \.\.\.completed\]/u);
  assert.match(lanes, /never tick a step silently/u);
  assert.match(deepLane, /emitDeepCommentary\(input\.context, "step", branchStepSummary\(/u);
});

test("quick turns cannot emit owner commentary", () => {
  const state = createV3CommentaryState(false);
  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "plan",
    message: "I’ll inspect this simple lookup.",
    queryCount: 0,
  }), { accepted: false, reason: "disabled" });
});

test("v3 runtime and compact UI preserve the substantial-commentary contract", () => {
  const engine = read("packages/albert-v3/src/engine/engine.ts");
  const lanes = read("packages/albert-v3/src/engine/lanes.ts");
  const tools = read("packages/albert-v3/src/engine/tools.ts");
  const deepLane = read("packages/albert-v3/src/engine/deep-lane.ts");
  const trace = read("app/dash/components/InsightsStyleTrace.tsx");
  const styles = read("app/dash/components/insights-trace.module.css");

  assert.match(engine, /createV3CommentaryState\(lane === "analytical" \|\| lane === "deep"\)/u);
  assert.match(lanes, /one or two\s+natural sentences/u);
  assert.match(lanes, /Skip routine[\s\S]*query-by-query narration/u);
  assert.match(tools, /type: "narrative", text: update\.text/u);
  assert.match(tools, /kind: z\.enum\(\["plan", "finding"\]\)/u);
  assert.match(deepLane, /Branches report evidence to the lead analyst/u);

  assert.match(trace, /aria-live="polite"/u);
  assert.match(trace, /streaming && runtime === "v3"/u);
  assert.match(trace, /Routine query\/tool events never enter here/u);
  assert.match(trace, /nextProgressShimmerDelayMs/u);
  assert.match(trace, /pickNextProgressShimmerLine/u);
  assert.match(trace, /liveProgressShimmerLine/u);
  assert.match(trace, /formatCheckingTools/u);
  assert.match(styles, /\.liveCommentaryItem\[data-latest="true"\]/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(styles, /--insights-shimmer-duration/u);
});
