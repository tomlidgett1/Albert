import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SWARM_CLIENT_CONCURRENCY,
  SWARM_MAX_AGENTS,
  SWARM_MIN_AGENTS,
  fallbackSwarmPlan,
  prepareSwarmAgents,
} from "../../services/swarm/src/planner.ts";
import { conservativeSwarmAnswerState } from "../../services/swarm/src/synthesis.ts";
import { swarmPlanSteps } from "../../services/swarm/src/parent-events.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const page = read("app/dash/page.tsx");
const panel = read("app/dash/components/SwarmPanel.tsx");
const controller = read("app/dash/lib/swarm-run-controller.ts");
const route = read("app/api/swarm/route.ts");
const agentRoute = read("app/api/swarm/agent/route.ts");
const synthesisRoute = read("app/api/swarm/synthesis/route.ts");
const stopRoute = read("app/api/swarm/stop/route.ts");
const heartbeatRoute = read("app/api/swarm/heartbeat/route.ts");
const repository = read("services/control-plane/src/swarm-repository.ts");
const webRepository = read("services/control-plane/src/web-repository.ts");
const migration = read("infra/migrations/control-plane/0168_m8_codex_swarm.sql");
const adr = read("docs/adr/0120-codex-swarm-subagents.md");

test("dash wires a Swarm button, progress slide-out, and hidden child threads", () => {
  assert.match(page, /import SwarmPanel from "\.\/components\/SwarmPanel"/u);
  assert.match(page, /aria-label="Swarm"/u);
  assert.match(page, /Swarm\s*\n\s*<\/button>/u);
  assert.match(page, /<SwarmPanel onClose=/u);
  assert.match(page, /startSwarmFleet\(/u);
  assert.match(page, /hydrateSwarmFromRun\(/u);
  assert.match(page, /stopSwarmFleet\(\)/u);
  assert.match(page, /swarmConversationIds\.has\(conversation\.conversationId\)/u);
  assert.match(page, /fetch\("\/api\/swarm"/u);
  assert.match(panel, /Active ·/u);
  assert.match(panel, /Done ·/u);
  assert.match(panel, /InsightsStyleTrace/u);
  assert.match(panel, /Stop swarm/u);
});

test("the planner allocates 2-5 disjoint agents and never clones the question", () => {
  assert.equal(SWARM_MIN_AGENTS, 2);
  assert.equal(SWARM_MAX_AGENTS, 5);
  assert.equal(SWARM_CLIENT_CONCURRENCY, 3);

  const full = fallbackSwarmPlan({
    question: "Why did profit fall last quarter?",
    connectors: ["lightspeed-r", "deputy", "xero"],
  });
  assert.ok(full.agents.length >= 2 && full.agents.length <= 5);
  const keys = new Set(full.agents.map((agent) => agent.key));
  assert.equal(keys.size, full.agents.length);
  assert.ok(full.agents.some((agent) => agent.role === "challenge"));
  const assignments = full.agents.map((agent) => agent.assignment);
  assert.equal(new Set(assignments).size, assignments.length);

  const prepared = prepareSwarmAgents(full, "Why did profit fall last quarter?");
  for (const agent of prepared) {
    assert.match(agent.key, /^[a-z][a-z0-9-]{2,60}$/u);
    assert.ok(agent.prompt.length >= 80 && agent.prompt.length <= 4000, agent.key);
    assert.match(agent.prompt, /You MUST cover/u);
    assert.match(agent.prompt, /You MUST NOT cover/u);
    assert.doesNotMatch(agent.prompt, /Why did profit fall last quarter\?\s*$/u);
  }

  const accounting = fallbackSwarmPlan({
    question: "What is cash on hand this week?",
    connectors: ["xero"],
  });
  assert.ok(accounting.agents.length >= 2);
});

test("synthesis stays conservative and does not invent a verified number", () => {
  assert.equal(conservativeSwarmAnswerState([
    {
      agentKey: "sales-measure",
      title: "Sales",
      role: "measure",
      answerState: "Verified",
      headline: "Sales were $12,000",
      keyNumbers: [{ label: "Sales", value: "$12,000" }],
      summaryExcerpt: "Sales were $12,000",
      failed: false,
      failureNote: null,
    },
  ]), "Derived");
  assert.equal(conservativeSwarmAnswerState([
    {
      agentKey: "challenge",
      title: "Challenge",
      role: "challenge",
      answerState: null,
      headline: null,
      keyNumbers: [],
      summaryExcerpt: "",
      failed: true,
      failureNote: "Timed out",
    },
  ]), "Unavailable");
  const steps = swarmPlanSteps({
    agents: [
      { key: "sales-measure", title: "Sales", status: "researching" },
      { key: "labour-cost", title: "Labour", status: "researching" },
    ],
  });
  assert.equal(steps.filter((step) => step.status === "active").length, 1);
  assert.ok(steps.some((step) => step.id === "swarm-synthesis"));
});

test("routes are same-origin, rate-limited, and keyed by run id", () => {
  assert.match(route, /assertSameOriginMutation\(request\)/u);
  assert.match(route, /consumeAlbertRateLimit\("swarm\.run"\)/u);
  assert.match(webRepository, /"swarm\.run": Object\.freeze\(\{ limit: 10, windowSeconds: 3_600 \}\)/u);
  assert.match(agentRoute, /assertSameOriginMutation\(request\)/u);
  assert.match(agentRoute, /distillProactiveAnswer\(parsed\.answer\)/u);
  assert.match(synthesisRoute, /assertSameOriginMutation\(request\)/u);
  assert.match(synthesisRoute, /loadSwarmRun\(parsed\.runId\)/u);
  assert.match(synthesisRoute, /Specialists are still working/u);
  assert.match(synthesisRoute, /failureCode: answerState === "Unavailable" \? "albert_swarm_unavailable" : "albert_swarm_answered"/u);
  assert.match(stopRoute, /assertSameOriginMutation\(request\)/u);
  assert.match(heartbeatRoute, /loadSwarmRun\(parsed\.runId\)/u);
  assert.match(repository, /albert_swarm_get_run/u);
  assert.match(route, /Cache-Control": "no-store/u);
});

test("the fleet is client-orchestrated through the real Codex pipeline", () => {
  assert.match(controller, /fetch\("\/api\/codex-conversation"/u);
  assert.match(controller, /X-Albert-Conversation-Id/u);
  assert.match(controller, /X-Albert-Turn-Id/u);
  assert.match(controller, /action: "started"/u);
  assert.match(controller, /action: "completed"/u);
  assert.match(controller, /action: "failed"/u);
  assert.match(controller, /\/api\/swarm\/synthesis/u);
  assert.match(page, /activeChatRuntime !== "codex"/u);
  assert.match(adr, /orchestrator allocates/iu);
  assert.match(adr, /Every worker is a real Codex conversation/u);
});

test("the migration carries tables, RLS, RPCs, deletion, and NOTIFY", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS control_plane\.swarm_runs/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS control_plane\.swarm_agents/u);
  assert.match(migration, /lane_exclude/u);
  assert.match(migration, /ALTER TABLE control_plane\.swarm_runs ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE control_plane\.swarm_agents ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /\('swarm\.run', 10, 3600, false\)/u);
  assert.match(migration, /DELETE FROM control_plane\.swarm_agents WHERE tenant_id = request_row\.tenant_id/u);
  assert.match(migration, /DELETE FROM control_plane\.swarm_runs WHERE tenant_id = request_row\.tenant_id/u);
  assert.match(migration, /NOTIFY pgrst, 'reload schema'/u);
  for (const fn of [
    "albert_swarm_panel()",
    "albert_swarm_get_run(text)",
    "albert_swarm_for_conversation(text)",
    "albert_swarm_begin_run(text, text, text, text, text, text, jsonb, jsonb)",
    "albert_swarm_agent_started(text, text, text, text)",
    "albert_swarm_agent_completed(text, text, text, text, text, jsonb, jsonb)",
    "albert_swarm_agent_failed(text, text, text)",
    "albert_swarm_record_synthesis(text, jsonb)",
    "albert_swarm_stop(text)",
  ]) {
    assert.ok(
      migration.includes(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated`),
      fn,
    );
  }
});
