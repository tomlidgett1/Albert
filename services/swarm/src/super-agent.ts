/**
 * Test-only Super agent plan (ADR 0125).
 *
 * This is one owner question investigated through five ordered, governed
 * Codex passes. The browser controller runs the passes with concurrency one
 * and gives the final challenge the earlier distilled findings.
 */
import {
  SWARM_DEFAULT_COMPARISON_PERIOD,
  applyExcludes,
  prepareSwarmAgents,
  type SwarmPlan,
  type SwarmPlannedAgent,
} from "./planner";
import { SWARM_DEFAULT_TIMEZONE, defaultSwarmPeriod } from "./period";

export const SUPER_AGENT_KIND = "super-agent" as const;
export const SUPER_AGENT_MODEL = "gpt-5.6-luna" as const;
export const SUPER_AGENT_REASONING_EFFORT = "max" as const;
export const SUPER_AGENT_FAST_MODE = false;
export const SUPER_AGENT_PRO_MODE = true;
export const SUPER_AGENT_SOL_PLANNER = true;
export const SUPER_AGENT_CONCURRENCY = 1;
export const SUPER_AGENT_DURATION_MS = 45 * 60_000;
export const SUPER_AGENT_CHECKPOINT_INTERVAL_MS = 2 * 60_000;
export const SUPER_AGENT_OWNER_QUESTION = "How can we improve profitability?" as const;

export const SUPER_AGENT_PREFERENCES = Object.freeze({
  model: SUPER_AGENT_MODEL,
  reasoningEffort: SUPER_AGENT_REASONING_EFFORT,
  fastMode: SUPER_AGENT_FAST_MODE,
});

const SUPER_AGENT_FORMAT = [
  "This is one ordered pass inside a 45-minute Super agent investigation.",
  "Do not ask a clarifying question. Make the safest material interpretation, state it, and continue.",
  "Work in deep loops: form a hypothesis, run governed queries, look for contrary evidence, drill into the strongest divergence, and repeat until another query is unlikely to change the decision.",
  "Do not stop at the first plausible finding or merely restate a P&L. Use every connected source that can answer this pass, but never improvise joins or figures.",
  "Quantify the size, confidence, controllability, time horizon, and important limitation of every recommended lever. Use albert.derive_result for every calculation.",
  "Begin with one '## ' evidence-led headline. Then give key numbers, tests performed, contrary evidence, opportunity sizing, and what the next pass must challenge. Stay under 1,000 words.",
].join(" ");

function pass(input: Readonly<{
  key: string;
  title: string;
  tagline: string;
  role: SwarmPlannedAgent["role"];
  assignment: string;
}>): SwarmPlannedAgent {
  return {
    key: input.key,
    title: input.title,
    tagline: input.tagline,
    role: input.role,
    assignment: input.assignment,
    exclude: "Do not skip into a later pass. Record evidence the later passes can challenge.",
  };
}

export function superAgentPlan(input: Readonly<{
  now?: Date;
  timezone?: string;
}> = {}): SwarmPlan {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? SWARM_DEFAULT_TIMEZONE;
  return {
    periodLabel: SWARM_DEFAULT_COMPARISON_PERIOD,
    period: defaultSwarmPeriod(now, timezone),
    rationale: "Five sequential profitability loops: establish, decompose, challenge, size, and prioritise.",
    agents: applyExcludes([
      pass({
        key: "profit-baseline",
        title: "Pass 1 · Profit baseline",
        tagline: "Establish the governed profit bridge",
        role: "measure",
        assignment: "Establish the current and comparable profitability baseline from governed accounting and operational evidence: revenue lens, gross profit, operating expenses, net profit, cash conversion, period coverage, and reconciliation limitations. Build a profit bridge and test whether the apparent movement is broad, seasonal, or concentrated. Do not recommend actions yet.",
      }),
      pass({
        key: "margin-levers",
        title: "Pass 2 · Margin levers",
        tagline: "Find sales and gross-margin opportunity",
        role: "explain",
        assignment: "Decompose gross-margin opportunity across price realisation, product and category mix, unit cost, discounting, refunds, basket, channel, location, customer concentration, and volume. Rank only governed, controllable levers and test whether each survives a prior-period and concentration check. Do not analyse the operating-expense ledger.",
      }),
      pass({
        key: "cost-structure",
        title: "Pass 3 · Cost structure",
        tagline: "Interrogate recurring and avoidable cost",
        role: "explain",
        assignment: "Interrogate operating expenses and cash outflows by account, supplier, recurrence, trend, and materiality. Separate structural costs from anomalies, accounting classifications, pass-throughs, and one-offs. Size plausible savings without assuming every large expense is avoidable. Do not repeat product rankings.",
      }),
      pass({
        key: "capital-productivity",
        title: "Pass 4 · Productivity",
        tagline: "Test inventory, labour, and cash efficiency",
        role: "measure",
        assignment: "Test inventory productivity, working capital, labour productivity where connected, receivables, payables, cash settlement, and under-used assets or locations. Aggregate each fact independently before alignment. Identify profit trapped by stock, staffing shape, timing, or cash conversion and quantify only what governed evidence supports.",
      }),
      pass({
        key: "profit-challenge",
        title: "Pass 5 · Challenge and rank",
        tagline: "Try to disprove the proposed profit plan",
        role: "challenge",
        assignment: "Read the earlier pass findings, then try to disprove them. Search for missing periods, definition mismatches, one-off events, concentration, counter-trends, double counting, non-controllable costs, cash-versus-accrual tension, and recommendations whose dollar impact is not evidenced. Produce a ranked 30/60/90-day profitability plan with conservative opportunity ranges, dependencies, owner decisions, and explicit stop-doing advice.",
      }),
    ]),
  };
}

export function prepareSuperAgentPasses(plan: SwarmPlan, question: string) {
  return prepareSwarmAgents(plan, question, { format: SUPER_AGENT_FORMAT });
}
