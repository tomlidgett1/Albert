/**
 * Xero 50-question battery for the Albert v3 engine.
 *
 * The 50 most likely questions a small business would ask of their Xero data,
 * spanning AR/AP, P&L, GST, cash, payroll, customers/suppliers, items, assets
 * and setup, including questions whose correct answer is an honest disclosure
 * (bank balances, leave balances, quotes/POs).
 *
 * Runs with GPT 5.6 Luna at max reasoning effort and fast mode OFF.
 *
 * Usage:
 *   npx tsx scripts/albert-v3-xero-battery.mts            # full battery
 *   npx tsx scripts/albert-v3-xero-battery.mts 3          # single question
 *   npx tsx scripts/albert-v3-xero-battery.mts 0 10       # range [from, to)
 *
 * Reuses the smoke-test conversation/turn ids, which hold an active semantic
 * turn lease in the control plane (required by the capability driver).
 */

import { readFileSync, existsSync } from "node:fs";
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
const cubeEnv = readEnvFile(path.join(root, "cube-playground", ".env"));

const cubeApiUrl = process.env.CUBE_API_URL || envLocal.CUBE_API_URL || "http://localhost:4000";
const cubeApiSecret = process.env.CUBEJS_API_SECRET || envLocal.CUBEJS_API_SECRET || cubeEnv.CUBEJS_API_SECRET;
const openaiApiKey = process.env.OPENAI_API_KEY || envLocal.OPENAI_API_KEY;
if (!cubeApiSecret || !openaiApiKey) {
  console.error("Missing CUBEJS_API_SECRET or OPENAI_API_KEY");
  process.exit(1);
}

const TENANT_ID = process.env.TENANT_ID || "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
const CONVERSATION_ID = process.env.CONVERSATION_ID || "01SM0KETESTC0NVAAAAAAAAAAA";
const TURN_ID = process.env.TURN_ID || "01SM0KETESTT0RNAAAAAAAAAAA";

const PREFERENCES = Object.freeze({
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  fastMode: false,
} as const);

type BatteryCase = Readonly<{ label: string; question: string; timeoutMs: number }>;

const BATTERY: readonly BatteryCase[] = [
  // Money owed to me (AR)
  { label: "ar-who-owes", question: "Who owes me money right now?", timeoutMs: 360_000 },
  { label: "ar-overdue-ageing", question: "How much of what I'm owed is overdue, and how old is it?", timeoutMs: 360_000 },
  { label: "ar-biggest-unpaid", question: "What's my biggest unpaid invoice?", timeoutMs: 360_000 },
  { label: "ar-days-to-pay", question: "How long do my customers take to pay me on average?", timeoutMs: 360_000 },
  { label: "ar-due-soon", question: "Which invoices are due to be paid to me in the next two weeks?", timeoutMs: 360_000 },
  // Money I owe (AP)
  { label: "ap-who-i-owe", question: "Who do I owe money to at the moment?", timeoutMs: 360_000 },
  { label: "ap-overdue-bills", question: "Do I have any overdue bills?", timeoutMs: 360_000 },
  { label: "ap-due-this-month", question: "How much do I need to pay suppliers before the end of the month?", timeoutMs: 360_000 },
  { label: "ap-biggest-supplier", question: "Which supplier have I spent the most with this financial year?", timeoutMs: 360_000 },
  { label: "ap-my-payment-speed", question: "On average, how quickly do I pay my bills?", timeoutMs: 360_000 },
  // Profit and loss
  { label: "pnl-last-month", question: "Give me my profit and loss for last month.", timeoutMs: 480_000 },
  { label: "pnl-net-profit-fy", question: "What's my net profit this financial year so far?", timeoutMs: 480_000 },
  { label: "pnl-biggest-expenses", question: "What are my biggest expenses this year?", timeoutMs: 360_000 },
  { label: "pnl-revenue-trend", question: "How is my revenue trending month by month this calendar year?", timeoutMs: 360_000 },
  { label: "pnl-qtr-vs-lastyear", question: "Compare this quarter's revenue to the same quarter last year.", timeoutMs: 360_000 },
  { label: "pnl-gross-margin", question: "What's my gross profit margin looking like this year?", timeoutMs: 480_000 },
  { label: "pnl-expense-growth", question: "Which expense categories have grown the most compared to last year?", timeoutMs: 480_000 },
  { label: "pnl-rent", question: "How much have I spent on rent this year?", timeoutMs: 360_000 },
  { label: "pnl-merchant-fees", question: "How much am I paying in merchant and bank fees?", timeoutMs: 360_000 },
  { label: "pnl-other-income", question: "Did I earn any income outside of normal sales this year?", timeoutMs: 360_000 },
  // GST and tax
  { label: "gst-paid-quarter", question: "How much GST have I paid this quarter?", timeoutMs: 360_000 },
  { label: "gst-net-position", question: "What's my net GST position for this quarter?", timeoutMs: 360_000 },
  { label: "gst-basis-fy", question: "What GST basis am I registered on, and when does my financial year end?", timeoutMs: 360_000 },
  { label: "gst-bas", question: "Can you work out my BAS for last quarter?", timeoutMs: 480_000 },
  // Cash and banking
  { label: "cash-in-vs-out", question: "How much cash came in versus went out of my bank accounts last month?", timeoutMs: 360_000 },
  { label: "cash-spend-category", question: "What did I spend money on directly from my bank accounts last month, by category?", timeoutMs: 360_000 },
  { label: "cash-large-txns", question: "What were my ten largest bank transactions in the last month?", timeoutMs: 360_000 },
  { label: "cash-transfers", question: "How much have I moved between my own bank accounts this year?", timeoutMs: 360_000 },
  { label: "cash-unreconciled", question: "Do I have unreconciled bank transactions I should look at?", timeoutMs: 360_000 },
  { label: "cash-bank-balance", question: "What's my current bank balance?", timeoutMs: 360_000 },
  // Payroll
  { label: "pay-total-cost", question: "What has payroll cost me in total this financial year?", timeoutMs: 360_000 },
  { label: "pay-by-employee", question: "How much did each of my employees earn last month?", timeoutMs: 360_000 },
  { label: "pay-super-quarter", question: "How much super do I owe for last quarter?", timeoutMs: 360_000 },
  { label: "pay-payg-withheld", question: "How much PAYG tax have I withheld from wages this financial year?", timeoutMs: 360_000 },
  { label: "pay-headcount", question: "How many staff do I have on payroll, and who started most recently?", timeoutMs: 360_000 },
  { label: "pay-rates", question: "What pay rates do I have set up for my staff?", timeoutMs: 360_000 },
  { label: "pay-frequency", question: "How often do I pay my staff, and when is the next pay day?", timeoutMs: 360_000 },
  { label: "pay-hours-worked", question: "How many hours did my team put through payroll timesheets last month?", timeoutMs: 360_000 },
  { label: "pay-avg-net", question: "What's the average net pay per employee per pay run this year?", timeoutMs: 360_000 },
  { label: "pay-leave-balances", question: "How much annual leave has my team accrued?", timeoutMs: 360_000 },
  // Customers and suppliers
  { label: "cust-top", question: "Who are my top customers by invoiced sales this year?", timeoutMs: 360_000 },
  { label: "cust-credit-sitting", question: "Does anyone have credit sitting with me from overpayments?", timeoutMs: 360_000 },
  { label: "cust-credit-notes", question: "How much have I credited back to customers this year and why?", timeoutMs: 360_000 },
  // Items, assets, setup
  { label: "items-catalogue", question: "What products and services do I have set up in Xero, and at what prices?", timeoutMs: 360_000 },
  { label: "assets-owned", question: "What fixed assets do I own and what are they worth now?", timeoutMs: 360_000 },
  { label: "assets-depreciation", question: "How much depreciation have my assets accumulated?", timeoutMs: 360_000 },
  { label: "setup-users", question: "Who has access to my Xero account and what can they do?", timeoutMs: 360_000 },
  { label: "setup-subscriptions", question: "What recurring bills or subscriptions am I paying for?", timeoutMs: 360_000 },
  { label: "setup-quotes-pos", question: "Do I have any open quotes or purchase orders in Xero?", timeoutMs: 360_000 },
  { label: "hard-cashflow-summary", question: "Give me a full picture of my business finances right now: profit, cash movement, what I'm owed, what I owe, and payroll.", timeoutMs: 720_000 },
];

function snippet(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function runCase(index: number, testCase: BatteryCase): Promise<boolean> {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`[${index}] ${testCase.label}: "${testCase.question}"`);
  console.log("=".repeat(72));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("battery timeout")), testCase.timeoutMs);
  const started = Date.now();
  let sequence = 0;
  try {
    const result = await runAlbertV3Turn({
      message: testCase.question,
      conversation: [],
      preferences: PREFERENCES,
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      cubeApiUrl,
      cubeApiSecret,
      openaiApiKey,
      signal: controller.signal,
      emit: async (event) => {
        const at = `${((Date.now() - started) / 1000).toFixed(1)}s`;
        sequence += 1;
        switch (event.type) {
          case "progress":
            console.log(`  [${at}] progress · ${event.label}${event.detail ? ` · ${snippet(event.detail, 140)}` : ""}`);
            break;
          case "narrative":
            console.log(`  [${at}] narrative · ${snippet(event.text, 200)}`);
            break;
          case "query":
            console.log(`  [${at}] query · ${event.topic} · view=${event.view ?? "?"} rows=${event.rowCount ?? "?"} ms=${event.executionMs ?? "?"}`);
            break;
          case "table":
            console.log(`  [${at}] table · ${event.caption} (${event.rows.length} rows)`);
            break;
          case "chart":
            console.log(`  [${at}] chart · ${event.chartType} · ${event.caption}`);
            break;
          case "clarification":
            console.log(`  [${at}] clarification · ${event.question} · options: ${event.options.map((option) => option.label).join(" | ")}`);
            break;
          case "answer":
            console.log(`  [${at}] answer · state=${event.state}`);
            console.log(`  ANSWER: ${snippet(event.text, 1400)}`);
            break;
          case "error":
            console.log(`  [${at}] ERROR · ${event.message}`);
            break;
          default:
            console.log(`  [${at}] ${(event as { type: string }).type}`);
        }
        return {
          ...event,
          id: `xero_${sequence}`,
          sequence,
          occurredAt: new Date().toISOString(),
        } as TraceEvent;
      },
    });
    console.log(`  RESULT: state=${result.answerState} queries=${result.queriesExecuted} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
    return result.answerState !== "Unavailable";
  } catch (error) {
    console.log(`  FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const fromArg = process.argv[2] !== undefined ? Number(process.argv[2]) : 0;
const toArg = process.argv[3] !== undefined ? Number(process.argv[3]) : (process.argv[2] !== undefined ? fromArg + 1 : BATTERY.length);

let passed = 0;
let failed = 0;
for (let index = fromArg; index < Math.min(toArg, BATTERY.length); index += 1) {
  const ok = await runCase(index, BATTERY[index]);
  if (ok) passed += 1; else failed += 1;
}
console.log(`\n${"=".repeat(72)}`);
console.log(`Battery finished: ${passed} passed, ${failed} failed/unavailable`);
process.exit(failed > 0 ? 1 : 0);
