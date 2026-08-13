/**
 * 75-question Luna Max evaluation battery for the Albert v3 engine.
 *
 * Drives `runAlbertV3Turn` directly against production Cubecore and OpenAI
 * with { model: gpt-5.6-luna, reasoningEffort: max, fastMode: false }, and
 * records one JSONL row per question with the full answer, every governed
 * query (topic/yaml/rowCount), diagnostics, narratives, states and timing.
 *
 * Usage:
 *   npx tsx scripts/albert-v3-eval75.mts            # full battery
 *   npx tsx scripts/albert-v3-eval75.mts 3          # single question by index
 *   npx tsx scripts/albert-v3-eval75.mts 0 10       # range [from, to)
 *
 * Results append to .albert-eval75-results.jsonl (repo root, untracked).
 */

import { appendFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAlbertV3Turn } from "../packages/albert-v3/src/index.js";
import type { TraceEvent } from "../packages/shared/src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return out;
}

const envLocal = readEnvFile(path.join(root, ".env.local"));
const cubeApiUrl = process.env.CUBE_API_URL || envLocal.CUBE_API_URL || "http://localhost:4000";
const cubeApiSecret = process.env.CUBEJS_API_SECRET || envLocal.CUBEJS_API_SECRET;
const openaiApiKey = process.env.OPENAI_API_KEY || envLocal.OPENAI_API_KEY;
if (!cubeApiSecret || !openaiApiKey) {
  console.error("Missing CUBEJS_API_SECRET or OPENAI_API_KEY");
  process.exit(1);
}

const TENANT_ID = process.env.TENANT_ID || "01KZN20VTX2EWW1TQ2AA3MCPW6";
const CONVERSATION_ID = process.env.CONVERSATION_ID || "01SM0KETESTC0NVAAAAAAAAAAA";
const TURN_ID = process.env.TURN_ID || "01SM0KETESTT0RNAAAAAAAAAAA";
const RESULTS = path.join(root, ".albert-eval75-results.jsonl");
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 3);
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS || 600_000);

type Category = "easy" | "moderate" | "hard" | "multi" | "edge" | "data";
type EvalCase = Readonly<{ label: string; category: Category; question: string; expect?: string }>;

const BATTERY: readonly EvalCase[] = [
  // ---------- Easy, single tool ----------
  { label: "easy-sales-yesterday", category: "easy", question: "What were my sales yesterday?", expect: "LS data ends 2026-08-07; must disclose staleness, not claim zero." },
  { label: "easy-sales-last-week", category: "easy", question: "How much did we sell last week?", expect: "Partial coverage: LS through Aug 7." },
  { label: "easy-top-products-month", category: "easy", question: "What were our top 10 selling products in July?" },
  { label: "easy-customer-count", category: "easy", question: "How many customers do we have?" },
  { label: "easy-revenue-this-year", category: "easy", question: "What's our total revenue this year so far?" },
  { label: "easy-hours-last-week", category: "easy", question: "How many hours did staff work last week?" },
  { label: "easy-wages-july", category: "easy", question: "What did wages cost us in July?" },
  { label: "easy-top-categories", category: "easy", question: "Which categories sell the most?" },
  { label: "easy-refunds-july", category: "easy", question: "How much did we refund in July?" },
  { label: "easy-specific-day", category: "easy", question: "What were sales on 15 July 2026?" },
  { label: "easy-avg-sale", category: "easy", question: "What's our average sale value this year?" },
  { label: "easy-outstanding-invoices", category: "easy", question: "How much money is owed to us right now?" },

  // ---------- Moderate ----------
  { label: "mod-mom-compare", category: "moderate", question: "How did July sales compare to June?" },
  { label: "mod-yoy-compare", category: "moderate", question: "How did this July compare to July last year?" },
  { label: "mod-service-vs-product", category: "moderate", question: "How much of our revenue is servicing versus selling products?" },
  { label: "mod-gst-quarter", category: "moderate", question: "How much GST did we collect this quarter?" },
  { label: "mod-busiest-day", category: "moderate", question: "What's our busiest day of the week?" },
  { label: "mod-seasonality", category: "moderate", question: "Which months are our strongest and weakest for sales?" },
  { label: "mod-roster-next-week", category: "moderate", question: "Who's rostered on next week?" },
  { label: "mod-top-customer", category: "moderate", question: "Who is our biggest customer of all time and how much have they spent?" },
  { label: "mod-declining-categories", category: "moderate", question: "Are any product categories declining this year compared to last year?" },
  { label: "mod-payment-mix", category: "moderate", question: "How do customers pay us - what's the split between cash and card?" },
  { label: "mod-staff-leave", category: "moderate", question: "Who has taken the most leave this year?" },
  { label: "mod-biggest-sale-ever", category: "moderate", question: "What's the biggest single sale we've ever made?" },

  // ---------- Hard / nuanced ----------
  { label: "hard-margin-by-category", category: "hard", question: "Which product categories make us the best margin, and which are barely worth stocking?" },
  { label: "hard-sales-dip", category: "hard", question: "Why were sales weaker in June than May this year?" },
  { label: "hard-labour-pct", category: "hard", question: "What percentage of our revenue goes on labour, and how has that trended this year?" },
  { label: "hard-revenue-per-hour", category: "hard", question: "What's our revenue per staffed hour, and which days are we overstaffed?" },
  { label: "hard-attach-rate", category: "hard", question: "When people come in for a service, how often do they also buy parts in the same sale?" },
  { label: "hard-retention", category: "hard", question: "What share of this year's customers are returning versus new, and is retention improving?" },
  { label: "hard-ar-ageing", category: "hard", question: "Give me an ageing breakdown of everything we owe suppliers." },
  { label: "hard-bills-due-august", category: "hard", question: "What bills are due in August?", expect: "Must lead with the ~$25k already overdue, not just the empty window." },
  { label: "hard-discounts", category: "hard", question: "How much are discounts costing us this year and who's giving them?" },
  { label: "hard-refund-pattern", category: "hard", question: "Are refunds concentrated in any product category or staff member?" },
  { label: "hard-slow-movers", category: "hard", question: "What stock has been sitting unsold the longest?" },
  { label: "hard-workshop-revenue", category: "hard", question: "How much does the workshop bring in per month on average this year?" },
  { label: "hard-price-rises", category: "hard", question: "Have our average service prices gone up over the last three years?" },
  { label: "hard-cash-position", category: "hard", question: "If everyone who owes us paid up and we paid every bill we owe, where would we land?" },
  { label: "hard-weekend-vs-weekday", category: "hard", question: "Do we make more per hour of trading on weekends or weekdays?" },

  // ---------- Multi-tool ----------
  { label: "multi-wage-vs-sales", category: "multi", question: "Compare our wage costs to our sales month by month this year - are wages growing faster than revenue?", expect: "Deputy/Xero payroll + Lightspeed." },
  { label: "multi-square-vs-lightspeed", category: "multi", question: "How much did we take through Square versus Lightspeed in July?" },
  { label: "multi-bills-vs-pos", category: "multi", question: "How much did we buy from suppliers in July according to Xero, and does that line up with what arrived in Lightspeed purchase orders?" },
  { label: "multi-roster-vs-busy", category: "multi", question: "Are we rostering people at our busiest selling times?" },
  { label: "multi-staff-sales-day", category: "multi", question: "Who was working on our biggest sales day this year?" },
  { label: "multi-payroll-vs-timesheets", category: "multi", question: "Do our Xero payroll costs line up with the hours recorded in Deputy for July?" },
  { label: "multi-supplier-spend", category: "multi", question: "Which supplier did we spend the most with this year and what did we buy?" },
  { label: "multi-square-workforce", category: "multi", question: "We track shifts in both Deputy and Square - do they agree on hours worked in July?" },
  { label: "multi-total-takings", category: "multi", question: "What was our total business income in July across everything?" },
  { label: "multi-owner-summary", category: "multi", question: "Give me a one-page health check: sales, wages, what we owe, what's owed to us." },

  // ---------- Edge cases ----------
  { label: "edge-oldest-bill", category: "edge", question: "What's the oldest unpaid bill we have?", expect: "1954/1996 junk due dates exist; should flag implausibility." },
  { label: "edge-shopify", category: "edge", question: "How's our Shopify store performing?", expect: "Not connected; must say so plainly." },
  { label: "edge-momence", category: "edge", question: "How many active Momence members do we have?", expect: "No momence data; must not invent." },
  { label: "edge-typo-staff", category: "edge", question: "How many hours did Maitena work last month?", expect: "Maïténa Etchebarne - diacritics." },
  { label: "edge-typo-item", category: "edge", question: "How much servcies revenue did we make in July?" },
  { label: "edge-typo-supplier", category: "edge", question: "How much do we owe chane reaction cycles?" },
  { label: "edge-future-sales", category: "edge", question: "What will our sales be next week?", expect: "Forecasting beyond data; should decline or frame as estimate from history." },
  { label: "edge-before-data", category: "edge", question: "What were our sales in 2017?", expect: "Data starts Apr 2018." },
  { label: "edge-today-stale", category: "edge", question: "How are sales going today?", expect: "LS through Aug 7 - staleness disclosure, not zero." },
  { label: "edge-ambiguous", category: "edge", question: "Any red flags I should know about?" },
  { label: "edge-nps", category: "edge", question: "What's our NPS score this quarter?", expect: "No such data anywhere; honest refusal." },
  { label: "edge-nonexistent-store", category: "edge", question: "How did the Fitzroy store do last month?", expect: "No such location; should check and say so." },
  { label: "edge-tiny-denominator", category: "edge", question: "What's our average revenue per workorder?", expect: "Only 3 workorders exist." },
  { label: "edge-empty-window", category: "edge", question: "How many bikes did we sell between 2am and 4am last Tuesday?" },

  // ---------- Hard questions about the specific data ----------
  { label: "data-owe-most", category: "data", question: "Which supplier do we owe the most money to right now, and how overdue is it?" },
  { label: "data-pon-bike", category: "data", question: "How much have we bought from Pon Bike this year?" },
  { label: "data-leigh-hours", category: "data", question: "How many hours has Leigh Phillips worked this year and what has it cost us?" },
  { label: "data-compare-staff", category: "data", question: "Compare the hours worked by Charles and Thomas over the last three months." },
  { label: "data-revenue-split", category: "data", question: "Split this year's revenue into bikes, parts and servicing." },
  { label: "data-top5-lastvisit", category: "data", question: "Who are our top 5 customers this year and when did each last shop with us?" },
  { label: "data-weekend-products", category: "data", question: "What do we sell most on Saturdays?" },
  { label: "data-items-per-sale", category: "data", question: "How many items does the average sale include, and has that changed since 2024?" },
  { label: "data-square-refund-rate", category: "data", question: "What's our refund rate on Square payments?" },
  { label: "data-gift-cards", category: "data", question: "How much value is sitting on unredeemed gift cards?" },
  { label: "data-biggest-refund", category: "data", question: "What's the biggest refund we've ever given and what was it for?" },
  { label: "data-tyre-revenue", category: "data", question: "How much do we make from tyre changes a month? Include both the service fee and the tyres themselves." },
];

type CaseRecord = {
  index: number;
  label: string;
  category: Category;
  question: string;
  expect?: string;
  answerState?: string;
  answerText?: string;
  followUps?: readonly string[];
  narratives: string[];
  plan?: unknown;
  queries: Array<{ topic: string; view?: string; rowCount?: number; queryYaml?: string; timeRange?: string }>;
  progress: string[];
  clarification?: string;
  errors: string[];
  durationMs: number;
  queriesExecuted?: number;
  failed?: string;
};

async function runCase(index: number, testCase: EvalCase): Promise<CaseRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("eval timeout")), TIMEOUT_MS);
  const started = Date.now();
  let sequence = 0;
  const record: CaseRecord = {
    index,
    label: testCase.label,
    category: testCase.category,
    question: testCase.question,
    ...(testCase.expect ? { expect: testCase.expect } : {}),
    narratives: [],
    queries: [],
    progress: [],
    errors: [],
    durationMs: 0,
  };
  console.log(`[${index}] START ${testCase.label}: "${testCase.question}"`);
  try {
    const result = await runAlbertV3Turn({
      message: testCase.question,
      conversation: [],
      preferences: { model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: false },
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      cubeApiUrl,
      cubeApiSecret: cubeApiSecret!,
      openaiApiKey: openaiApiKey!,
      signal: controller.signal,
      emit: async (event) => {
        sequence += 1;
        switch (event.type) {
          case "progress":
            record.progress.push(`${event.label}${event.detail ? ` · ${event.detail}` : ""}`);
            break;
          case "narrative":
            record.narratives.push(event.text);
            break;
          case "plan":
            record.plan = event.steps;
            break;
          case "query":
            record.queries.push({
              topic: event.topic,
              view: event.view,
              rowCount: event.rowCount,
              queryYaml: event.queryYaml,
              timeRange: event.timeRange.label,
            });
            break;
          case "answer":
            record.answerState = event.state;
            record.answerText = event.text;
            record.followUps = event.followUps;
            break;
          case "clarification":
            record.clarification = event.question;
            break;
          case "error":
            record.errors.push(event.message);
            break;
          default:
            break;
        }
        return {
          ...event,
          id: `ev_${index}_${sequence}`,
          sequence,
          occurredAt: new Date().toISOString(),
        } as TraceEvent;
      },
    });
    record.queriesExecuted = result.queriesExecuted;
    record.answerState = result.answerState;
    record.answerText = result.answerText;
  } catch (error) {
    record.failed = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  record.durationMs = Date.now() - started;
  appendFileSync(RESULTS, `${JSON.stringify(record)}\n`);
  console.log(`[${index}] DONE ${testCase.label}: state=${record.answerState ?? "FAILED"} queries=${record.queries.length} ${(record.durationMs / 1000).toFixed(0)}s${record.failed ? ` FAILED: ${record.failed}` : ""}`);
  return record;
}

const fromArg = process.argv[2] !== undefined ? Number(process.argv[2]) : 0;
const toArg = process.argv[3] !== undefined
  ? Number(process.argv[3])
  : (process.argv[2] !== undefined ? fromArg + 1 : BATTERY.length);
const indexes = Array.from(
  { length: Math.min(toArg, BATTERY.length) - fromArg },
  (_, offset) => fromArg + offset,
);

let cursor = 0;
async function worker(): Promise<void> {
  while (cursor < indexes.length) {
    const myIndex = indexes[cursor];
    cursor += 1;
    await runCase(myIndex, BATTERY[myIndex]);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, indexes.length) }, worker));
console.log(`\nBattery finished: ${indexes.length} cases appended to ${RESULTS}`);
