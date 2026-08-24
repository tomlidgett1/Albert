import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createV3CommentaryState,
  looksLikeFinding,
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

  // A finding must state a fact: no figure and no ranking claim is dropped.
  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "finding",
    message: "A material movement is emerging, and I’m checking what explains it.",
    queryCount: 1,
  }), { accepted: false, reason: "no_fact" });

  assert.equal(prepareV3CommentaryUpdate({
    state,
    kind: "finding",
    message: "Refunds are up 38% on last month and concentrated in one category.",
    queryCount: 1,
  }).accepted, true);

  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "finding",
    message: "Refunds are up 38% on last month and concentrated in one category.",
    queryCount: 2,
  }), { accepted: false, reason: "duplicate" });

  assert.equal(prepareV3CommentaryUpdate({
    state,
    kind: "finding",
    message: "The driver is concentrated in one segment worth $12,400 a month.",
    queryCount: 2,
  }).accepted, true);

  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "finding",
    message: "This fourth update of $1 should not be shown.",
    queryCount: 3,
  }), { accepted: false, reason: "limit" });
});

test("step summaries carry a fact, never method, hedges or intentions", () => {
  assert.equal(looksLikeFinding("Parts run a 31% margin against 44% for workshop."), true);
  assert.equal(looksLikeFinding("Sunday is the weakest trading day for gross takings."), true);
  assert.equal(looksLikeFinding("Retail demand: Analysis covers the 12 complete weeks from 25 May to 16 August 2026."), false);
  assert.equal(looksLikeFinding("Staffing: Month-level labour is quantified, but a reliable ranking is not available from the governed views."), false);
  assert.equal(looksLikeFinding("I’ll examine margins, then cross-check the strongest findings."), false);
  const state = createV3CommentaryState(true);
  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "step",
    message: "The data cannot support a weekday ranking.",
    queryCount: 1,
  }), { accepted: false, reason: "no_fact" });
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

test("a completed step may comment plainly that it found no material result", () => {
  const state = createV3CommentaryState(true);
  assert.equal(prepareV3CommentaryUpdate({
    state,
    kind: "step",
    message: "No matching rows were returned for this step.",
    queryCount: 1,
  }).accepted, true);
});

test("update_plan carries a per-step findings summary and query tools nudge for it", () => {
  const tools = read("packages/albert-v3/src/engine/tools.ts");
  const initialPlan = read("packages/albert-v3/src/engine/initial-plan.ts");
  const lanes = read("packages/albert-v3/src/engine/lanes.ts");
  const deepLane = read("packages/albert-v3/src/engine/deep-lane.ts");

  assert.match(tools, /name: "update_plan"[\s\S]*summary: z\.string\(\)[\s\S]*\.nullable\(\)/u);
  assert.match(tools, /kind: "step",\s*message: summary/u);
  assert.match(tools, /cannot be completed without a short commentary/u);
  // Every governed query result path carries the nudge while a step awaits its summary.
  assert.ok((tools.match(/\.\.\.planStepSummaryNudge\(context\)/gu) ?? []).length >= 4);
  assert.match(initialPlan, /plannedStepCompletionCommentary\(context, step\)/u);
  assert.match(initialPlan, /type: "narrative",[\s\S]*plannedStepCompletionCommentary/u);
  assert.doesNotMatch(tools, /statusDetail: sanitizeTraceText\(update\.text/u);
  assert.match(lanes, /Also provide a summary/u);
  assert.match(deepLane, /emitDeepCommentary\(input\.context, "step", stepSummary\)/u);
});

test("orientation beats bypass the fact gate but stay capped, deduplicated and quiet on quick turns", () => {
  const state = createV3CommentaryState(true, 1, 2, 2);
  assert.equal(prepareV3CommentaryUpdate({
    state,
    kind: "plan",
    message: "I’ll compare the two periods, then break the gap down.",
    queryCount: 0,
  }).accepted, true);
  // The general ceiling (1) is spent, and the message is pure forward intent —
  // both would kill a finding. An orientation still shows: it sits outside the
  // general ceiling and the fact gate does not apply to it.
  assert.equal(prepareV3CommentaryUpdate({
    state,
    kind: "orientation",
    message: "I've found the right data for this — Sales analytics. I'll compare the two periods, then break the gap down by category.",
    queryCount: 0,
  }).accepted, true);
  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "orientation",
    message: "I've found the right data for this — Sales analytics. I'll compare the two periods, then break the gap down by category.",
    queryCount: 0,
  }), { accepted: false, reason: "duplicate" });
  assert.equal(prepareV3CommentaryUpdate({
    state,
    kind: "orientation",
    message: "I've split this into three angles and will cross-check the findings before recommending anything.",
    queryCount: 0,
  }).accepted, true);
  assert.deepEqual(prepareV3CommentaryUpdate({
    state,
    kind: "orientation",
    message: "A third orientation is over the per-turn cap of two.",
    queryCount: 0,
  }), { accepted: false, reason: "limit" });

  const disabled = createV3CommentaryState(false);
  assert.deepEqual(prepareV3CommentaryUpdate({
    state: disabled,
    kind: "orientation",
    message: "Quick turns stay quiet even for orientations.",
    queryCount: 0,
  }), { accepted: false, reason: "disabled" });
});

test("phase-boundary orientations are emitted by trusted lane code only, through the gate", () => {
  const plannedLane = read("packages/albert-v3/src/engine/planned-lane.ts");
  const deepLane = read("packages/albert-v3/src/engine/deep-lane.ts");
  const tools = read("packages/albert-v3/src/engine/tools.ts");

  // Planned lane: the research-complete beat names the matched data areas and
  // carries the planner's forward-intent sentence, gated (not a bare emit).
  assert.match(plannedLane, /kind: "orientation"/u);
  assert.match(plannedLane, /I've found the right data for this/u);
  assert.match(plannedLane, /prepareV3CommentaryUpdate/u);
  // Deep lane: the attack-order beat after branch decomposition.
  assert.match(deepLane, /emitDeepCommentary\(\s*input\.context,\s*"orientation"/u);
  assert.match(deepLane, /I've split this into \$\{plan\.branches\.length\} angles/u);
  // The model-facing progress tool cannot emit orientations.
  assert.match(tools, /kind: z\.enum\(\["plan", "finding"\]\)/u);
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
  assert.match(lanes, /do not narrate the plan in prose/u);
  assert.match(lanes, /a fact the owner would repeat to a colleague/u);
  assert.match(lanes, /Skip plans, routine status and query-by-query narration/u);
  assert.match(tools, /type: "narrative", text: update\.text/u);
  assert.match(tools, /kind: z\.enum\(\["plan", "finding"\]\)/u);
  assert.match(deepLane, /Branches report evidence to the lead analyst/u);
  assert.doesNotMatch(deepLane, /kind: "plan"|"plan",\s*`I’ll examine/u);
  assert.match(deepLane, /if \(!looksLikeFinding\(body\)\) return "";/u);

  assert.match(trace, /aria-live="polite"/u);
  assert.match(trace, /streaming\s*&&\s*\(runtime === "v3" \|\| runtime === "codex"\)/u);
  assert.match(trace, /Routine query\/tool events never enter here/u);
  assert.doesNotMatch(trace, /liveCommentaryStatus/u);
  assert.match(trace, /activityLabelLive/u);
  assert.match(styles, /\.activityLabelLive/u);
  assert.match(trace, /nextProgressShimmerDelayMs/u);
  assert.match(trace, /pickNextProgressShimmerLine/u);
  assert.match(trace, /liveProgressShimmerLine/u);
  assert.match(trace, /formatCheckingTools/u);
  assert.match(styles, /\.liveCommentaryItem\[data-latest="true"\]/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(styles, /--insights-shimmer-duration/u);
  assert.match(trace, /step\.status === "blocked"[\s\S]*CrossIcon/u);
  assert.match(trace, /step\.status === "incomplete"[\s\S]*planStepDash/u);
  assert.match(trace, /\(step\.status === "blocked" \|\| step\.status === "incomplete"\) && step\.statusDetail/u);
  assert.match(trace, /const displayPlan = plan && !streaming && \(stopped \|\| error\)/u);
  assert.match(trace, /type TrailStepStatus = "running" \| "done" \| "error" \| "incomplete"/u);
  assert.match(trace, /steps\[index\] = \{ \.\.\.target, status: "incomplete" \}/u);
  assert.match(trace, /stopped \? "incomplete" : "done"/u);
  assert.match(trace, /counts\.incomplete === 1 \? "1 step stopped"/u);
  assert.match(trace, /stage === "research"/u);
  assert.match(trace, /Completed research/u);
  assert.match(styles, /\.planStep\[data-status="blocked"\]/u);
  assert.match(styles, /\.planStep\[data-status="incomplete"\]/u);
});

test("malformed compare ranges are refused before they reach Cube", async () => {
  const { timeDimensionProblems } = await import("../../packages/albert-v3/src/engine/tools.js");
  const tz = "Australia/Melbourne";
  assert.equal(timeDimensionProblems([{ dimension: "sales_analytics.completed_at", compareDateRange: ["2026-01-01,2026-08-19", "2025-01-01,2025-08-19"] }], tz), null);
  assert.match(timeDimensionProblems([{ dimension: "sales_analytics.completed_at", compareDateRange: ["2025-01-01,2025-08-19 أو no", "2025-01-01,2025-08-19"] }], tz) ?? "", /explicit "YYYY-MM-DD,YYYY-MM-DD" pair/u);
  assert.match(timeDimensionProblems([{ dimension: "sales_analytics.completed_at", dateRange: "2026-01-01,2026-08-19", compareDateRange: ["2026-01-01,2026-08-19", "2025-01-01,2025-08-19"] }], tz) ?? "", /not both/u);
  assert.equal(timeDimensionProblems([{ dimension: "sales_analytics.completed_at", dateRange: "last month" }], tz), null);
  const cube = readFileSync(new URL("../../deploy/fly/cube.toml", import.meta.url), "utf8");
  assert.match(cube, /CUBEJS_DB_QUERY_TIMEOUT = "2m"/u);
});
