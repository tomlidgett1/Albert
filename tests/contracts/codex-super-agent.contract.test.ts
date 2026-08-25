import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { formatSuperAgentCheckpoint } from "../../app/dash/lib/swarm-run-controller.ts";
import { codexAnalyticalBriefSchema } from "../../packages/albert-codex/src/contracts.ts";
import {
  SUPER_AGENT_CHECKPOINT_INTERVAL_MS,
  SUPER_AGENT_CONCURRENCY,
  SUPER_AGENT_DURATION_MS,
  SUPER_AGENT_FAST_MODE,
  SUPER_AGENT_KIND,
  SUPER_AGENT_MODEL,
  SUPER_AGENT_OWNER_QUESTION,
  SUPER_AGENT_PREFERENCES,
  SUPER_AGENT_PRO_MODE,
  SUPER_AGENT_REASONING_EFFORT,
  SUPER_AGENT_SOL_PLANNER,
  prepareSuperAgentPasses,
  superAgentPlan,
} from "../../services/swarm/src/super-agent.ts";
import { splitSwarmWaves } from "../../services/swarm/src/worker-brief.ts";
import { buildSharedAnalyticalBrief } from "../../services/conversation/src/analytical-brief.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const route = read("app/api/swarm/route.ts");
const page = read("app/dash/page.tsx");
const panel = read("app/dash/components/SwarmPanel.tsx");
const controller = read("app/dash/lib/swarm-run-controller.ts");
const repository = read("services/control-plane/src/swarm-repository.ts");
const adr = read("docs/adr/0125-codex-super-agent-test-mode.md");
const evalRunner = read("scripts/albert-eval/run-codex.mts");

test("Super agent has a Sol planner with a Luna Max Pro standard-speed explorer", () => {
  assert.equal(SUPER_AGENT_KIND, "super-agent");
  assert.equal(SUPER_AGENT_OWNER_QUESTION, "How can we improve profitability?");
  assert.equal(SUPER_AGENT_MODEL, "gpt-5.6-luna");
  assert.equal(SUPER_AGENT_REASONING_EFFORT, "max");
  assert.equal(SUPER_AGENT_FAST_MODE, false);
  assert.equal(SUPER_AGENT_PRO_MODE, true);
  assert.equal(SUPER_AGENT_SOL_PLANNER, true);
  assert.equal(SUPER_AGENT_CONCURRENCY, 1);
  assert.equal(SUPER_AGENT_DURATION_MS, 45 * 60_000);
  assert.equal(SUPER_AGENT_CHECKPOINT_INTERVAL_MS, 2 * 60_000);
  assert.deepEqual(SUPER_AGENT_PREFERENCES, {
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    fastMode: false,
  });
});

test("profitability work is five ordered deep-loop passes with a final challenge", () => {
  const plan = superAgentPlan({
    now: new Date("2026-08-25T03:00:00Z"),
    timezone: "Australia/Melbourne",
  });
  assert.deepEqual(plan.agents.map((agent) => agent.key), [
    "profit-baseline",
    "margin-levers",
    "cost-structure",
    "capital-productivity",
    "profit-challenge",
  ]);
  assert.equal(plan.agents.at(-1)?.role, "challenge");
  const waves = splitSwarmWaves(plan.agents);
  assert.equal(waves.firstWave.length, 4);
  assert.equal(waves.secondWave.length, 1);

  const prepared = prepareSuperAgentPasses(plan, SUPER_AGENT_OWNER_QUESTION);
  assert.equal(prepared.length, 5);
  for (const pass of prepared) {
    assert.ok(pass.prompt.length <= 4_000, pass.key);
    assert.match(pass.prompt, /hypothesis, run governed queries, look for contrary evidence/iu);
    assert.match(pass.prompt, /Do not stop at the first plausible finding/iu);
    assert.match(pass.prompt, /How can we improve profitability\?/u);
  }
});

test("open profitability questions receive an explicit evidence brief", () => {
  const brief = buildSharedAnalyticalBrief({
    message: "How can we improve profitability?",
    activeConnectors: ["lightspeed-r", "xero", "deputy"],
    includeGeneric: true,
  });
  assert.equal(brief?.id, "profitability_review_v1");
  assert.deepEqual(brief?.requiredViews.map((view) => view.view), [
    "xero_profit_and_loss_analytics",
    "xero_profit_and_loss_account_analytics",
    "sales_analytics",
    "product_sales_analytics",
    "workforce_analytics",
  ]);
  assert.match(brief?.ownerGoal ?? "", /without double counting/iu);
  assert.match(brief?.answerMustCover.join(" ") ?? "", /latest complete month versus the prior complete month/iu);
  assert.equal(codexAnalyticalBriefSchema.safeParse(brief).success, true);
});

test("the API, controller, and UI preserve the explicit mode and progress contract", () => {
  assert.match(route, /kind: z\.enum\(\["question", "sales-deep", "super-agent"\]\)/u);
  assert.match(route, /superAgent \? SUPER_AGENT_CONCURRENCY : SWARM_CLIENT_CONCURRENCY/u);
  assert.match(route, /durationMs: SUPER_AGENT_DURATION_MS/u);
  assert.match(route, /checkpointIntervalMs: SUPER_AGENT_CHECKPOINT_INTERVAL_MS/u);
  assert.match(route, /superAgent \? SUPER_AGENT_PRO_MODE/u);
  assert.match(route, /superAgent[\s\S]*?\? SUPER_AGENT_SOL_PLANNER/u);
  assert.match(repository, /kind: z\.enum\(\["question", "sales-deep", "super-agent"\]\)/u);

  assert.match(page, /aria-label="Super agent"/u);
  assert.match(page, /superAgentEnabledRef/u);
  assert.match(page, /setSuperAgentMode/u);
  assert.match(page, /SUPER_AGENT_PREFERENCES/u);
  assert.match(page, /setCodexProModeEnabled\(SUPER_AGENT_PRO_MODE\)/u);
  assert.match(page, /setCodexSolPlannerEnabled\(SUPER_AGENT_SOL_PLANNER\)/u);
  assert.match(page, /kind: payload\.kind/u);
  assert.match(panel, /45-minute deep-work budget/u);
  assert.match(panel, /updates every 2 minutes/u);
  assert.match(panel, /data-testid="super-agent-checkpoint"/u);

  assert.match(controller, /window\.setInterval\([\s\S]*?input\.checkpointIntervalMs/u);
  assert.match(controller, /window\.setTimeout\([\s\S]*?input\.durationMs/u);
  assert.match(controller, /recordUnfinishedSuperAgentPasses/u);
  assert.match(controller, /runSuperAgentPasses/u);
  assert.match(controller, /appendSwarmBrief\(agent\.prompt, buildSwarmWaveBrief\(priorFindings\)\)/u);
  assert.match(controller, /controller\.abort\("super-agent-deadline"\)/u);
  const semanticRuntime = read("packages/albert-codex/src/semantic-runtime.ts");
  assert.match(semanticRuntime, /bounded decomposition preflight/u);
  assert.match(semanticRuntime, /proMode: false/u);
  assert.match(semanticRuntime, /timeAdvisory/u);
  assert.match(adr, /never\s+waits merely to make the timer look deeper/iu);
});

test("two-minute checkpoints contain only public progress scalars", () => {
  assert.equal(formatSuperAgentCheckpoint({
    elapsedMs: 8 * 60_000,
    completedPasses: 1,
    totalPasses: 5,
    queriesSeen: 17,
    activePass: "Pass 2 · Margin levers",
  }), "8m elapsed · 1 of 5 passes complete · 17 governed queries. Current: Pass 2 · Margin levers.");
  assert.equal(formatSuperAgentCheckpoint({
    elapsedMs: 45 * 60_000,
    completedPasses: 5,
    totalPasses: 5,
    queriesSeen: 64,
  }), "45m elapsed · 5 of 5 passes complete · 64 governed queries. Preparing the final synthesis.");
});

test("the CLI eval runner can execute the five-pass plan on subscription credits", () => {
  assert.match(evalRunner, /--super-agent-question/u);
  assert.match(evalRunner, /--start-super-pass/u);
  assert.match(evalRunner, /--pro requires --auth api/u);
  assert.match(evalRunner, /prepareSuperAgentPasses/u);
  assert.match(evalRunner, /thread: "SUPER-AGENT"/u);
  assert.match(evalRunner, /record\.thread === "SUPER-AGENT"/u);
  assert.match(evalRunner, /if \(args\.superAgentQuestion\) args\.solPlanner = true/u);
  assert.match(evalRunner, /authentication: subscriptionAuthentication\(subscriptionCodexHome\)/u);
  assert.match(evalRunner, /In-process eval transport is restricted to ChatGPT subscription auth/u);
  assert.match(evalRunner, /type: "query_audit"/u);
  assert.match(evalRunner, /client!\.runTurn\([\s\S]*?async \(event\)/u);
  assert.match(evalRunner, /args\.proMode \? \{ reasoningMode: "pro" as const \} : \{\}/u);
});
