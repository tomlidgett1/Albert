import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { laneModelSettings } from "../../packages/albert-v3/src/engine/lanes.ts";
import {
  buildTurnProvenance,
  emptyTurnProvenance,
  groundedAnswerState,
  laneRequiresQueryEvidence,
  looksLikeUngroundedPlan,
  ownerFacingAnswerText,
  ungroundedOwnerAnswer,
} from "../../packages/albert-v3/src/engine/grounding.ts";
import { normalizeAgentPreferences } from "../../packages/shared/src/index.ts";
import type { V3TurnContext } from "../../packages/albert-v3/src/engine/context.ts";

const read = (path: string) => readFileSync(resolve(path), "utf8");

test("Grok plan-only answers are detected and never shipped on data lanes", () => {
  const plan = "I'll break August month-to-date sales down by product category, using the same 1–13 August window and GST-inclusive figures.";
  assert.equal(looksLikeUngroundedPlan(plan), true);
  assert.equal(looksLikeUngroundedPlan("Let me pull the category split."), true);
  assert.equal(looksLikeUngroundedPlan("Sales were $12,400 across three categories."), false);
  assert.equal(laneRequiresQueryEvidence("quick"), true);
  assert.equal(laneRequiresQueryEvidence("explain"), false);
  assert.equal(ownerFacingAnswerText({
    lane: "explain",
    draft: "I can see the previous answer used GST-inclusive sales.",
    queriesExecuted: 0,
  }), "I can see the previous answer used GST-inclusive sales.");
  assert.equal(groundedAnswerState({
    lane: "quick",
    requested: "Verified",
    queriesExecuted: 0,
    rowsSeen: 0,
  }), "Unavailable");
  assert.equal(groundedAnswerState({
    lane: "explain",
    requested: "Exploratory",
    queriesExecuted: 0,
    rowsSeen: 0,
  }), "Exploratory");
});

test("empty v3 provenance does not fake a Cube source or hash of empty YAML", () => {
  const emptyHash = createHash("sha256").update("").digest("hex").slice(0, 16);
  const provenance = emptyTurnProvenance("Australia/Melbourne");
  assert.deepEqual(provenance.sources, []);
  assert.equal(provenance.semanticBundleHash, "albert-v3-cube-no-queries");
  assert.notEqual(provenance.semanticBundleHash, `albert-v3-cube-${emptyHash}`);

  const built = buildTurnProvenance({
    executedQueries: [],
    config: { timezone: "Australia/Melbourne" },
  } as V3TurnContext);
  assert.equal(built.semanticBundleHash, "albert-v3-cube-no-queries");
  assert.equal(built.sources.length, 0);
});

test("Grok data lanes investigate without structured output, then compose", () => {
  const lanes = read("packages/albert-v3/src/engine/lanes.ts");
  const engine = read("packages/albert-v3/src/engine/engine.ts");
  const deep = read("packages/albert-v3/src/engine/deep-lane.ts");
  assert.match(lanes, /runGrokInvestigation/u);
  assert.match(lanes, /toolChoice: "required"/u);
  assert.match(lanes, /Do not write the owner-facing answer/u);
  assert.match(lanes, /composeGroundedAnswer/u);
  assert.match(engine, /ownerFacingAnswerText/u);
  assert.match(engine, /buildTurnProvenance/u);
  assert.match(deep, /toolChoice: "required"/u);

  const required = laneModelSettings(
    normalizeAgentPreferences({
      model: "grok-4.6",
      reasoningEffort: "high",
      fastMode: true,
    }),
    "low",
    { toolChoice: "required" },
  );
  assert.equal(required.toolChoice, "required");
  assert.equal(required.store, false);
});
