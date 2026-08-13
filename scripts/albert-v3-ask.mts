/**
 * Ask the Albert v3 engine a single ad-hoc question from the command line.
 *
 *   npx tsx scripts/albert-v3-ask.mts "how many gen servcies last month?"
 *
 * Same wiring as albert-v3-qa-battery.mts: drives runAlbertV3Turn directly
 * against local Cube and the live OpenAI API, using the smoke-test lease ids.
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

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('Usage: npx tsx scripts/albert-v3-ask.mts "your question"');
  process.exit(1);
}

const TENANT_ID = process.env.TENANT_ID || "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
const CONVERSATION_ID = process.env.CONVERSATION_ID || "01SM0KETESTC0NVAAAAAAAAAAA";
const TURN_ID = process.env.TURN_ID || "01SM0KETESTT0RNAAAAAAAAAAA";

function snippet(text: string, max = 500): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("timeout")), 300_000);
const started = Date.now();
let sequence = 0;

const result = await runAlbertV3Turn({
  message: question,
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
        console.log(`[${at}] progress · ${event.label}${event.detail ? ` · ${snippet(event.detail, 160)}` : ""}`);
        break;
      case "query":
        console.log(`[${at}] query · ${event.topic} · rows=${event.rowCount ?? "?"} ms=${event.executionMs ?? "?"}`);
        break;
      case "table":
        console.log(`[${at}] table · ${event.caption} (${event.rows.length} rows)`);
        for (const row of event.rows.slice(0, 6)) console.log(`   ${JSON.stringify(row)}`);
        break;
      case "clarification":
        console.log(`[${at}] clarification · ${event.question}`);
        break;
      case "answer":
        console.log(`[${at}] answer · state=${event.state}`);
        console.log(`ANSWER: ${snippet(event.text, 1200)}`);
        break;
      case "error":
        console.log(`[${at}] ERROR · ${event.message}`);
        break;
      default:
        console.log(`[${at}] ${(event as { type: string }).type}`);
    }
    return {
      ...event,
      id: `ask_${sequence}`,
      sequence,
      occurredAt: new Date().toISOString(),
    } as TraceEvent;
  },
});
clearTimeout(timer);
console.log(`RESULT: state=${result.answerState} queries=${result.queriesExecuted} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
