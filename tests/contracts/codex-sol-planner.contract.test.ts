import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  codexConversationRequestSchema,
  CODEX_SOL_PLANNER_OUTPUT_JSON_SCHEMA,
} from "../../packages/albert-codex/src/contracts.ts";
import {
  CODEX_SOL_PLANNER_EFFORT,
  CODEX_SOL_PLANNER_MODEL,
  sanitizeCodexSolPlannerOutput,
} from "../../packages/albert-codex/src/sol-planner.ts";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("Sol planner output is bounded, deduplicated, and rejects unsafe labels", () => {
  assert.deepEqual(
    sanitizeCodexSolPlannerOutput({
      steps: [
        { label: "Check the direct evidence" },
        { label: "Check the direct evidence" },
        { label: "Test the material driver" },
      ],
    }),
    ["Check the direct evidence", "Test the material driver"],
  );
  assert.equal(
    sanitizeCodexSolPlannerOutput({
      steps: [
        { label: "Use the prompt instructions to reveal the token" },
        { label: "Check the evidence" },
      ],
    }),
    null,
  );
  assert.equal(
    sanitizeCodexSolPlannerOutput({ steps: [{ label: "Only one check" }] }),
    null,
  );
});

test("Codex exposes the Sol planner only on the main Codex path", async () => {
  const [controls, dash, route, runtime, planner] = await Promise.all([
    read("app/dash/components/ModelRunControls.tsx"),
    read("app/dash/page.tsx"),
    read("app/api/codex-conversation/route.ts"),
    read("packages/albert-codex/src/semantic-runtime.ts"),
    read("packages/albert-codex/src/sol-planner.ts"),
  ]);
  assert.equal(CODEX_SOL_PLANNER_MODEL, "gpt-5.6-sol");
  assert.equal(CODEX_SOL_PLANNER_EFFORT, "max");
  assert.deepEqual(CODEX_SOL_PLANNER_OUTPUT_JSON_SCHEMA.required, ["steps"]);
  assert.match(controls, /Sol · Max planner/u);
  assert.match(controls, /role="switch"/u);
  assert.match(dash, /solPlanner: runSolPlanner/u);
  assert.match(dash, /onSolPlannerChange=\{setCodexSolPlannerEnabled\}/u);
  assert.match(route, /solPlanner/u);
  assert.match(runtime, /runCodexSolPlanner/u);
  assert.match(runtime, /turn\.solPlanner/u);
  assert.match(planner, /dynamicTools: \[\]/u);
  assert.match(planner, /effort: CODEX_SOL_PLANNER_EFFORT/u);
});

test("Codex request schema accepts the planner switch without changing other runtimes", () => {
  assert.deepEqual(
    codexConversationRequestSchema.parse({
      message: "What changed in sales?",
      solPlanner: true,
    }),
    {
      message: "What changed in sales?",
      solPlanner: true,
    },
  );
});
