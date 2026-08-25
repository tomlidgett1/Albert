import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SWARM_ASSIGNMENT_OVERLAP_LIMIT,
  SWARM_CLIENT_CONCURRENCY,
  SWARM_DEFAULT_COMPARISON_PERIOD,
  SWARM_MAX_AGENTS,
  SWARM_MIN_AGENTS,
  SWARM_UNBOUNDED_PERIOD,
  assignmentOverlapRatio,
  fallbackSwarmPlan,
  inferSwarmPeriodLabel,
  prepareSwarmAgents,
  swarmPlanIssue,
  type SwarmPlan,
} from "../../services/swarm/src/planner.ts";
import { validSwarmPeriod } from "../../services/swarm/src/period.ts";
import {
  appendSwarmBrief,
  buildSwarmWaveBrief,
  splitSwarmWaves,
} from "../../services/swarm/src/worker-brief.ts";
import {
  buildSwarmSynthesis,
  conservativeSwarmAnswerState,
  extractSwarmFigures,
  governedSwarmAnswerState,
  unsupportedSwarmFigures,
  type SwarmSynthesisFinding,
} from "../../services/swarm/src/synthesis.ts";
import { swarmPlanSteps } from "../../services/swarm/src/parent-events.ts";
import {
  SALES_DEEP_BRIEFING_PATH,
  SALES_DEEP_FAST_MODE,
  SALES_DEEP_KIND,
  SALES_DEEP_MODEL,
  SALES_DEEP_OWNER_QUESTION,
  SALES_DEEP_PREFERENCES,
  SALES_DEEP_REASONING_EFFORT,
  buildSalesBriefingMarkdown,
  prepareSalesDeepAgents,
  salesDeepPlan,
} from "../../services/swarm/src/sales-deep.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const page = read("app/dash/page.tsx");
const panel = read("app/dash/components/SwarmPanel.tsx");
const controller = read("app/dash/lib/swarm-run-controller.ts");
const route = read("app/api/swarm/route.ts");
const agentRoute = read("app/api/swarm/agent/route.ts");
const synthesisRoute = read("app/api/swarm/synthesis/route.ts");
const codexRoute = read("app/api/codex-conversation/route.ts");
const stopRoute = read("app/api/swarm/stop/route.ts");
const heartbeatRoute = read("app/api/swarm/heartbeat/route.ts");
const repository = read("services/control-plane/src/swarm-repository.ts");
const webRepository = read("services/control-plane/src/web-repository.ts");
const migration = read("infra/migrations/control-plane/0168_m8_codex_swarm.sql");
const briefingMigration = read("infra/migrations/control-plane/0169_m8_sales_deep_briefing.sql");
const adr = read("docs/adr/0120-codex-swarm-subagents.md");
const agentsWorkspace = read("app/dash/components/AgentsWorkspace.tsx");
const salesDeepStore = read("services/swarm/src/sales-deep-store.ts");

test("dash wires a Swarm button, progress slide-out, and hidden child threads", () => {
  assert.match(page, /import SwarmPanel(?:, \{ SWARM_PANEL_DEFAULT_WIDTH \})? from "\.\/components\/SwarmPanel"/u);
  assert.match(page, /aria-label="Swarm"/u);
  assert.match(page, /swarmToggleLabel\}>Swarm<\/span>/u);
  assert.match(page, /<SwarmPanel[\s\S]*?onClose=/u);
  assert.match(page, /startSwarmFleet\(/u);
  assert.match(page, /hydrateSwarmFromRun\(/u);
  assert.match(page, /stopSwarmFleet\(\)/u);
  assert.match(page, /swarmConversationIds\.has\(conversation\.conversationId\)/u);
  assert.match(page, /fetch\("\/api\/swarm"/u);
  assert.match(page, /const setSwarmMode = useCallback/u);
  assert.match(page, /swarmEnabledRef\.current = resolved[\s\S]{0,100}setSwarmEnabled\(resolved\)/u);
  assert.match(panel, /superAgent \? "Current pass" : "Active"/u);
  assert.match(panel, /Done ·/u);
  assert.match(panel, /InsightsStyleTrace/u);
  assert.match(panel, /Stop \{superAgent \? "Super agent" : "swarm"\}/u);
  assert.match(panel, /Resize \$\{superAgent \? "Super agent" : "swarm"\} panel/u);
  assert.match(page, /onWidenPastDefault=\{\(\) => setCollapsed\(true\)\}/u);
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

test("the planner does not invent a 13-week window for snapshot briefs", () => {
  assert.equal(
    inferSwarmPeriodLabel("I want to understand everything about the employees of Ashburton Cycles"),
    SWARM_UNBOUNDED_PERIOD,
  );
  assert.equal(
    inferSwarmPeriodLabel("Why did profit fall last quarter?"),
    "Last quarter",
  );
  assert.equal(
    inferSwarmPeriodLabel("Why did profit fall?"),
    SWARM_DEFAULT_COMPARISON_PERIOD,
  );
  assert.equal(
    fallbackSwarmPlan({
      question: "I want to understand everything about the employees of Ashburton Cycles",
      connectors: ["deputy", "lightspeed-r"],
    }).periodLabel,
    SWARM_UNBOUNDED_PERIOD,
  );
  assert.match(adr, /As asked/u);
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

test("Pro synthesis uses the selected Luna model at Max without putting Pro on workers", async () => {
  let request: Record<string, unknown> | undefined;
  const answer = "Sales were $12,000 in the governed window. Protect that baseline, investigate the largest controllable gap, and use the next review to decide whether to expand the intervention.";
  const result = await buildSwarmSynthesis({
    question: "How can we improve profitability?",
    periodLabel: "Last 13 weeks versus prior 13 weeks",
    businessName: "Albert Bike Store",
    findings: [{
      agentKey: "sales",
      title: "Sales",
      role: "measure",
      answerState: "Verified",
      headline: "Sales were $12,000",
      keyNumbers: [{ label: "Sales", value: "$12,000" }],
      summaryExcerpt: "Sales were $12,000 in the governed window.",
      failed: false,
      failureNote: null,
    }],
    apiKey: "sk-fixture",
    baseUrl: "https://au.api.openai.com/v1",
    safetyIdentifier: "fixture",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    proMode: true,
    client: {
      responses: {
        create: async (body: Record<string, unknown>) => {
          request = body;
          return {
            output_text: JSON.stringify({
              headline: "Sales were $12,000",
              answer,
              followUps: ["Which category should I fix first?", "What is the largest cost lever?"],
              disagreements: [],
            }),
          };
        },
      },
    } as never,
  });
  assert.equal(result.source, "model");
  assert.equal(request?.model, "gpt-5.6-luna");
  assert.deepEqual(request?.reasoning, { effort: "max", mode: "pro" });
  assert.equal(request?.max_output_tokens, 48_000);
  assert.equal((request?.text as { verbosity?: string })?.verbosity, "high");
  assert.equal(Object.hasOwn(request ?? {}, "service_tier"), false);
});

test("an incomplete Pro synthesis recovers on Luna Max without Fast before deterministic fallback", async () => {
  const requests: Record<string, unknown>[] = [];
  const answer = "Sales were $12,000 in the governed window. Protect that baseline, investigate the controllable gap, and set a measured decision point before expanding the intervention.";
  const result = await buildSwarmSynthesis({
    question: "How can we improve profitability?",
    periodLabel: "Last 13 weeks versus prior 13 weeks",
    businessName: "Albert Bike Store",
    findings: [{
      agentKey: "sales",
      title: "Sales",
      role: "measure",
      answerState: "Verified",
      headline: "Sales were $12,000",
      keyNumbers: [{ label: "Sales", value: "$12,000" }],
      summaryExcerpt: "Sales were $12,000 in the governed window.",
      failed: false,
      failureNote: null,
    }],
    apiKey: "sk-fixture",
    baseUrl: "https://au.api.openai.com/v1",
    safetyIdentifier: "fixture",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    proMode: true,
    client: {
      responses: {
        create: async (body: Record<string, unknown>) => {
          requests.push(body);
          if (requests.length === 1) return { status: "incomplete", output_text: "" };
          return {
            status: "completed",
            output_text: JSON.stringify({
              headline: "Recover margin before chasing volume: tighten discounts and returns, improve sales per existing labour hour, and clear aged stock for cash without treating itas",
              answer,
              followUps: ["Which category should I fix first?", "What is the largest cost lever?"],
              disagreements: [],
            }),
          };
        },
      },
    } as never,
  });
  assert.equal(result.source, "model-repaired");
  assert.equal(result.synthesis.headline, "Recover margin before chasing volume");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.reasoning, { effort: "max", mode: "pro" });
  assert.deepEqual(requests[1]?.reasoning, { effort: "max" });
  assert.equal(requests[0]?.max_output_tokens, 48_000);
  assert.equal(requests[1]?.max_output_tokens, 16_000);
  assert.equal(Object.hasOwn(requests[1] ?? {}, "service_tier"), false);
});

test("a Pro provider timeout reaches the standard Luna Max recovery", async () => {
  const requests: Record<string, unknown>[] = [];
  const result = await buildSwarmSynthesis({
    question: "How can we improve profitability?",
    periodLabel: "Latest complete month versus prior complete month",
    businessName: "Albert Bike Store",
    findings: [{
      agentKey: "accounts",
      title: "Accounts",
      role: "measure",
      answerState: "Verified",
      headline: "Gross profit was $95,000",
      keyNumbers: [{ label: "Gross profit", value: "$95,000" }],
      summaryExcerpt: "Gross profit was $95,000 in the governed period.",
      failed: false,
      failureNote: null,
    }],
    apiKey: "sk-fixture",
    baseUrl: "https://au.api.openai.com/v1",
    safetyIdentifier: "fixture",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    proMode: true,
    client: {
      responses: {
        create: async (body: Record<string, unknown>) => {
          requests.push(body);
          if (requests.length === 1) throw new Error("Request timed out.");
          return {
            status: "completed",
            output_text: JSON.stringify({
              headline: "Protect the $95,000 gross-profit baseline",
              answer: "Gross profit was $95,000 in the governed period. Protect that baseline, assign an owner to the material controllable levers, and retain only actions that improve the governed result without breaching the agreed guardrail.",
              followUps: ["Which cost lever should I test first?", "Which sales lever is most controllable?"],
              disagreements: [],
            }),
          };
        },
      },
    } as never,
  });
  assert.equal(result.source, "model-repaired");
  assert.equal(result.failure, null);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.reasoning, { effort: "max", mode: "pro" });
  assert.deepEqual(requests[1]?.reasoning, { effort: "max" });
  assert.equal(Object.hasOwn(requests[1] ?? {}, "service_tier"), false);
});

test("the emergency synthesis fallback preserves detailed evidence and a decision cadence", async () => {
  const result = await buildSwarmSynthesis({
    question: "How can we improve profitability?",
    periodLabel: "Last 13 weeks versus prior 13 weeks",
    businessName: "Albert Bike Store",
    findings: [{
      agentKey: "sales",
      title: "Sales",
      role: "measure",
      answerState: "Verified",
      headline: "Discounts are the clearest leakage",
      keyNumbers: [
        { label: "Revenue", value: "$250,000" },
        { label: "Discounts", value: "$10,000" },
        { label: "Returns", value: "$4,000" },
        { label: "Gross margin", value: "38%" },
      ],
      summaryExcerpt: "Discounts and returns are material, while premium bikes held margin better than accessories. Indiscriminate discounting is not supported.",
      failed: false,
      failureNote: null,
    }, {
      agentKey: "accounts",
      title: "Accounts",
      role: "reconcile",
      answerState: null,
      headline: null,
      keyNumbers: [],
      summaryExcerpt: "",
      failed: true,
      failureNote: "The P&L reconciliation did not complete.",
    }],
    apiKey: "sk-fixture",
    baseUrl: "https://au.api.openai.com/v1",
    safetyIdentifier: "fixture",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    proMode: true,
    client: {
      responses: {
        create: async () => ({ status: "incomplete", output_text: "" }),
      },
    } as never,
  });
  assert.equal(result.source, "fallback");
  assert.match(result.synthesis.answer, /Indiscriminate discounting is not supported/u);
  assert.match(result.synthesis.answer, /Revenue: \$250,000/u);
  assert.match(result.synthesis.answer, /The P&L reconciliation did not complete/u);
  assert.match(result.synthesis.answer, /Next 30 days/u);
  assert.match(result.synthesis.answer, /By 90 days/u);
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
  assert.match(synthesisRoute, /AbortSignal\.timeout\(SYNTHESIS_ROUTE_DEADLINE_MS\)/u);
  assert.match(synthesisRoute, /signal: synthesisSignal/u);
  assert.match(synthesisRoute, /failureCode: answerState === "Unavailable" \? "albert_swarm_unavailable" : "albert_swarm_answered"/u);
  assert.match(stopRoute, /assertSameOriginMutation\(request\)/u);
  assert.match(heartbeatRoute, /loadSwarmRun\(parsed\.runId\)/u);
  assert.match(repository, /albert_swarm_get_run/u);
  assert.match(route, /Cache-Control": "no-store/u);
});

test("the fleet is client-orchestrated through the real Codex pipeline", () => {
  assert.match(controller, /fetch\("\/api\/codex-conversation"/u);
  assert.match(controller, /preferences\.solPlanner \? \{ solPlanner: true \} : \{\}/u);
  assert.match(controller, /preferences\.proMode \? \{ proMode: true \} : \{\}/u);
  assert.match(page, /solPlanner: runSolPlanner/u);
  assert.match(page, /proMode: runProMode/u);
  assert.match(route, /solPlanner: z\.boolean\(\)\.optional\(\)/u);
  assert.match(route, /proMode: z\.boolean\(\)\.optional\(\)/u);
  assert.match(route, /proMode: false/u);
  assert.match(route, /synthesisProMode:/u);
  assert.match(synthesisRoute, /run\.plan\.reasoningMode === "pro"/u);
  assert.match(synthesisRoute, /proMode: true/u);
  assert.match(synthesisRoute, /export const maxDuration = 800/u);
  assert.match(codexRoute, /\.\.\.\(solPlanner \? \{ solPlanner: true \} : \{\}\)/u);
  assert.match(codexRoute, /\.\.\.\(reasoningMode === "pro" \? \{ reasoningMode: "pro" as const \} : \{\}\)/u);
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

test("a shared window resolves once into ISO dates every worker must query", () => {
  const now = new Date("2026-08-24T03:00:00Z");
  const plan = fallbackSwarmPlan({
    question: "Why did profit fall?",
    connectors: ["lightspeed-r", "deputy", "xero"],
    timezone: "Australia/Sydney",
    now,
  });
  assert.equal(plan.periodLabel, SWARM_DEFAULT_COMPARISON_PERIOD);
  assert.ok(plan.period);
  assert.match(plan.period.start, /^\d{4}-\d{2}-\d{2}$/u);
  assert.ok(validSwarmPeriod(plan.period, now, "Australia/Sydney"));
  assert.ok(plan.period.compareEnd < plan.period.start);
  for (const agent of prepareSwarmAgents(plan, "Why did profit fall?")) {
    assert.ok(agent.prompt.includes(`Query window: ${plan.period.start} to ${plan.period.end}`), agent.key);
    assert.match(agent.prompt, /Do not re-derive the period/u);
  }

  const snapshot = fallbackSwarmPlan({
    question: "I want to understand everything about the employees",
    connectors: ["deputy"],
    now,
  });
  assert.equal(snapshot.periodLabel, SWARM_UNBOUNDED_PERIOD);
  assert.equal(snapshot.period, null);
  assert.ok(!validSwarmPeriod({
    start: "2026-08-01", end: "2026-08-23",
    compareStart: "2026-08-10", compareEnd: "2026-08-20",
  }, now, "Australia/Sydney"), "overlapping comparison windows must be rejected");
});

test("the worker format contract survives a long question and a full fleet", () => {
  const base = fallbackSwarmPlan({
    question: "Why did profit fall?",
    connectors: ["lightspeed-r", "deputy", "xero"],
    now: new Date("2026-08-24T03:00:00Z"),
  });
  const crowded: SwarmPlan = {
    ...base,
    agents: [
      ...base.agents,
      {
        key: "customers",
        title: "Customers",
        tagline: "Repeat and new customer behaviour",
        role: "explain",
        assignment: "Quantify repeat versus new customer counts and their spend for the shared period.",
        exclude: "Everything the other agents own.",
      },
    ].slice(0, SWARM_MAX_AGENTS),
  };
  const longQuestion = `Why did profit fall? ${"x".repeat(2_000)}`;
  for (const agent of prepareSwarmAgents(crowded, longQuestion)) {
    assert.ok(agent.prompt.length <= 4_000, agent.key);
    assert.match(agent.prompt, /Key numbers/u, agent.key);
    assert.match(agent.prompt, /under 400 words/u, agent.key);
  }
});

test("challenge and reconcile run as a second wave briefed with real findings", () => {
  const { firstWave, secondWave } = splitSwarmWaves([
    { role: "measure", key: "a" },
    { role: "explain", key: "b" },
    { role: "reconcile", key: "c" },
    { role: "challenge", key: "d" },
  ] as const);
  assert.deepEqual(firstWave.map((agent) => agent.key), ["a", "b"]);
  assert.deepEqual(secondWave.map((agent) => agent.key), ["c", "d"]);

  const soloChallenge = splitSwarmWaves([{ role: "challenge", key: "x" }] as const);
  assert.equal(soloChallenge.firstWave.length, 1);
  assert.equal(soloChallenge.secondWave.length, 0);

  const brief = buildSwarmWaveBrief([
    {
      title: "Sales",
      headline: "Sales fell $8,200",
      answerState: "Derived",
      keyNumbers: [{ label: "Net sales", value: "$96,400" }],
      failed: false,
    },
    { title: "Labour", headline: null, answerState: null, keyNumbers: [], failed: true },
  ]);
  assert.match(brief, /Sales \[Derived\]: Sales fell \$8,200/u);
  assert.match(brief, /Net sales \$96,400/u);
  assert.match(brief, /Did not finish: Labour/u);
  assert.match(brief, /untrusted evidence/u);
  assert.ok(appendSwarmBrief("p".repeat(7_000), brief).length <= 7_600);

  assert.match(controller, /splitSwarmWaves\(/u);
  assert.match(controller, /buildSwarmWaveBrief\(/u);
  assert.match(controller, /appendSwarmBrief\(/u);
  assert.match(controller, /Waiting on the first wave/u);
});

test("model plans that overlap or name disconnected sources are rejected", () => {
  const paraphrasedA = "Quantify total sales, product mix and basket size for the shared period.";
  const paraphrasedB = "Measure the sales, product mix and basket size over the shared period.";
  assert.ok(assignmentOverlapRatio(paraphrasedA, paraphrasedB) > SWARM_ASSIGNMENT_OVERLAP_LIMIT);

  const overlapping: SwarmPlan = {
    periodLabel: "As asked",
    period: null,
    rationale: "Two paraphrased clones of one job.",
    agents: [
      {
        key: "one", title: "One", tagline: "first cut", role: "measure",
        assignment: paraphrasedA, exclude: "Everything else.",
      },
      {
        key: "two", title: "Two", tagline: "second cut", role: "explain",
        assignment: paraphrasedB, exclude: "Everything else.",
      },
    ],
  };
  assert.match(swarmPlanIssue(overlapping, ["square"]) ?? "", /^overlapping-assignments/u);

  const disconnected: SwarmPlan = {
    periodLabel: "As asked",
    period: null,
    rationale: "Labour work with no roster source connected.",
    agents: [
      {
        key: "sales", title: "Sales", tagline: "what sold", role: "measure",
        assignment: "Quantify sales and basket for the shared period from the register.",
        exclude: "Everything else.",
      },
      {
        key: "labour", title: "Labour", tagline: "wage cost", role: "explain",
        assignment: "Pull rostered hours from Deputy and cost the wage bill.",
        exclude: "Everything else.",
      },
    ],
  };
  assert.match(swarmPlanIssue(disconnected, ["square"]) ?? "", /^roster-not-connected/u);

  const reconcileWithoutBooks: SwarmPlan = {
    ...disconnected,
    agents: [
      disconnected.agents[0]!,
      {
        key: "books", title: "Books", tagline: "the ledgers", role: "reconcile",
        assignment: "Reconcile takings against banked receipts and the ledger for the period.",
        exclude: "Everything else.",
      },
    ],
  };
  assert.match(swarmPlanIssue(reconcileWithoutBooks, ["square"]) ?? "", /^reconcile-without-accounting/u);

  const healthy = fallbackSwarmPlan({
    question: "Why did profit fall?",
    connectors: ["lightspeed-r", "deputy", "xero"],
  });
  assert.equal(swarmPlanIssue(healthy, ["lightspeed-r", "deputy", "xero"]), null);

  const negatedRoster = fallbackSwarmPlan({
    question: "Why did profit fall?",
    connectors: ["square", "xero"],
  });
  assert.equal(
    swarmPlanIssue(negatedRoster, ["square", "xero"]),
    null,
    "a 'Do not roster staff' exclusion must not read as needing a roster source",
  );
});

test("allocation and synthesis outcomes are persisted and logged, not swallowed", () => {
  assert.match(route, /swarm\.plan_allocated/u);
  assert.match(route, /source: allocation\.source/u);
  assert.match(route, /periodSource: allocation\.periodSource/u);
  assert.match(route, /issue: allocation\.issue/u);
  assert.match(route, /period: plan\.period/u);
  assert.match(synthesisRoute, /source: result\.source/u);
  assert.match(synthesisRoute, /unsupportedFigures/u);
  assert.match(synthesisRoute, /governedSwarmAnswerState/u);
  assert.match(repository, /periodSource/u);
  assert.match(repository, /unsupportedFigures/u);
});

test("synthesis figures must trace to a finding or the answer is demoted", () => {
  const findings: SwarmSynthesisFinding[] = [{
    agentKey: "sales-measure",
    title: "Sales",
    role: "measure",
    answerState: "Verified",
    headline: "Sales were $12,000",
    keyNumbers: [
      { label: "Sales", value: "$12,000" },
      { label: "Growth", value: "8.2%" },
    ],
    summaryExcerpt: "Net sales $12,000 for the window, up 8.2% on the prior window.",
    failed: false,
    failureNote: null,
  }];

  assert.deepEqual([...unsupportedSwarmFigures({
    headline: "Sales were $12k",
    answer: "Sales rose 8.2% to $12,000 across the window.",
    findings,
  })], []);
  assert.deepEqual([...unsupportedSwarmFigures({
    headline: "Sales were $13,500",
    answer: "Margin fell 3% on the quarter.",
    findings,
  })], ["$13,500", "3%"]);

  const figures = extractSwarmFigures("Sales hit $1.2m, up 4.5%");
  assert.deepEqual(figures.map((figure) => [figure.kind, figure.value]), [
    ["currency", 1_200_000],
    ["percent", 4.5],
  ]);

  assert.equal(governedSwarmAnswerState(findings, []), "Derived");
  assert.equal(governedSwarmAnswerState(findings, ["$13,500"]), "Exploratory");
});

test("the sales-deep test fleet stays inside sales and writes a briefing", () => {
  assert.equal(SALES_DEEP_KIND, "sales-deep");
  assert.equal(SALES_DEEP_MODEL, "gpt-5.6-luna");
  assert.equal(SALES_DEEP_REASONING_EFFORT, "max");
  assert.equal(SALES_DEEP_FAST_MODE, false);
  assert.equal(SALES_DEEP_PREFERENCES.fastMode, false);
  assert.equal(SALES_DEEP_BRIEFING_PATH, "evals/albert/context/sales-agent.md");
  assert.match(SALES_DEEP_OWNER_QUESTION, /complete sales brief/u);

  const plan = salesDeepPlan({
    now: new Date("2026-08-24T03:00:00Z"),
    timezone: "Australia/Sydney",
  });
  assert.equal(plan.agents.length, 5);
  assert.equal(new Set(plan.agents.map((agent) => agent.key)).size, 5);
  assert.ok(plan.agents.every((agent) => agent.key.startsWith("sales-")));
  assert.ok(plan.agents.some((agent) => agent.role === "challenge"));
  assert.equal(swarmPlanIssue(plan, ["lightspeed-r", "xero"]), null);
  for (let index = 0; index < plan.agents.length; index += 1) {
    for (let other = index + 1; other < plan.agents.length; other += 1) {
      const left = plan.agents[index];
      const right = plan.agents[other];
      if (!left || !right) continue;
      assert.ok(
        assignmentOverlapRatio(left.assignment, right.assignment) <= SWARM_ASSIGNMENT_OVERLAP_LIMIT,
        `${left.key}+${right.key}`,
      );
    }
  }

  const prepared = prepareSalesDeepAgents(plan, SALES_DEEP_OWNER_QUESTION);
  for (const agent of prepared) {
    assert.ok(agent.prompt.length >= 80 && agent.prompt.length <= 4000, agent.key);
    assert.match(agent.prompt, /Investigate thoroughly/u);
  }

  const markdown = buildSalesBriefingMarkdown({
    generatedAt: "2026-08-24T03:00:00.000Z",
    businessName: "Ashburton Cycles",
    question: SALES_DEEP_OWNER_QUESTION,
    periodLabel: plan.periodLabel,
    period: plan.period,
    headline: "Takings held at $12,000",
    answer: "Sales were $12,000 across the window.",
    answerState: "Derived",
    followUps: ["Which products are pulling the mix down?"],
    disagreements: [],
    findings: [{
      agentKey: "sales-trajectory",
      title: "Trajectory",
      role: "measure",
      answerState: "Derived",
      headline: "Takings held at $12,000",
      keyNumbers: [{ label: "Takings", value: "$12,000" }],
      summaryExcerpt: "Company-wide takings were $12,000.",
      failed: false,
      failureNote: null,
    }],
  });
  assert.match(markdown, /^# Sales agent briefing/u);
  assert.match(markdown, /Ashburton Cycles/u);
  assert.match(markdown, /\$12,000/u);

  assert.match(agentsWorkspace, /agent\.id === "sales"/u);
  assert.match(agentsWorkspace, /onStartSalesSwarm/u);
  assert.match(page, /swarmKind: "sales-deep"/u);
  assert.match(page, /const swarmKind = options\?\.swarmKind/u);
  assert.match(page, /\.\.\.\(swarmKind \? \{ kind: swarmKind \} : \{\}\)/u);
  assert.match(route, /kind: z\.enum\(\["question", "sales-deep", "super-agent"\]\)/u);
  assert.match(route, /SALES_DEEP_PREFERENCES/u);
  assert.match(synthesisRoute, /buildSalesBriefingMarkdown/u);
  assert.match(synthesisRoute, /writeSalesBriefingFile/u);
  assert.match(codexRoute, /readSalesBriefingFile/u);
  assert.match(salesDeepStore, /node:fs\/promises/u);
  assert.match(briefingMigration, /briefing_markdown/u);
  assert.match(briefingMigration, /albert_swarm_save_briefing/u);
  assert.match(briefingMigration, /albert_swarm_latest_briefing/u);
  assert.match(briefingMigration, /GRANT EXECUTE ON FUNCTION public\.albert_swarm_save_briefing\(text, text\) TO authenticated/u);
  assert.match(adr, /sales-deep test briefing/u);
});
