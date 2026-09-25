/**
 * End-to-end question battery for the Albert v3 engine (plan Phase 6).
 *
 * Drives `runAlbertV3Turn` directly (no HTTP/auth layer) against the local
 * Cube Core container and the live OpenAI API, logging every trace event
 * compactly so semantic-layer gaps and engine faults are visible per question.
 *
 * Usage:
 *   npx tsx scripts/albert-v3-qa-battery.mts            # full battery
 *   npx tsx scripts/albert-v3-qa-battery.mts 3          # single question by index
 *   npx tsx scripts/albert-v3-qa-battery.mts 0 4        # range [from, to)
 *
 * Reuses the smoke-test conversation/turn ids, which hold an active semantic
 * turn lease in the control plane (required by the capability driver).
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAlbertV3Turn } from "../packages/albert-v3/src/index.js";
import { DEFAULT_AGENT_PREFERENCES, type TraceEvent } from "../packages/shared/src/index.js";

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

type BatteryCase = Readonly<{ label: string; question: string; timeoutMs: number }>;

const BATTERY: readonly BatteryCase[] = [
  { label: "quick-yesterday", question: "What were my sales yesterday?", timeoutMs: 240_000 },
  { label: "category-month", question: "Which categories sold the most this month?", timeoutMs: 300_000 },
  { label: "refunds-by-store", question: "Show me refunds by store last month.", timeoutMs: 300_000 },
  { label: "payment-mix", question: "What's my payment mix this quarter?", timeoutMs: 300_000 },
  { label: "new-vs-returning", question: "How many new versus returning customers did we have this year?", timeoutMs: 300_000 },
  { label: "top-customers", question: "Who are my top 10 customers by lifetime spend?", timeoutMs: 300_000 },
  { label: "yoy-month", question: "How did sales go this month compared to the same month last year?", timeoutMs: 300_000 },
  { label: "profitability-breakdown", question: "Break down profitability by customer and category and give recommendations.", timeoutMs: 480_000 },
  { label: "ambiguous", question: "How are we doing?", timeoutMs: 300_000 },
  { label: "deep-profitability", question: "How can I improve the profitability of my business?", timeoutMs: 720_000 },
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
      preferences: DEFAULT_AGENT_PREFERENCES,
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
            console.log(`  ANSWER: ${snippet(event.text, 900)}`);
            break;
          case "error":
            console.log(`  [${at}] ERROR · ${event.message}`);
            break;
          default:
            console.log(`  [${at}] ${(event as { type: string }).type}`);
        }
        return {
          ...event,
          id: `qa_${sequence}`,
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
