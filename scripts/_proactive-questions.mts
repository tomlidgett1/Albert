/**
 * Headless question-bank generation for Ashburton Cycles (mirrors
 * app/api/proactive/questions/route.ts). Env: PROACTIVE_DB_URL, OPENAI_API_KEY.
 * Usage: node --env-file=.env.local --import tsx scripts/_proactive-questions.mts
 */
import pg from "pg";
import { buildQuestionBank, QUESTION_BANK_MODEL } from "../services/proactive/src/question-bank.js";

const dbUrl = process.env.PROACTIVE_DB_URL;
const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!dbUrl || !apiKey) throw new Error("set PROACTIVE_DB_URL and OPENAI_API_KEY");

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("set role albert_control_migration_owner");
await client.query(
  "select set_config('request.jwt.claims', json_build_object('sub', 'e6a1b354-ffbc-41c0-8131-d2f018dba818', 'role', 'authenticated')::text, false)",
);
const contextRow = await client.query("select public.albert_business_context() as ctx");
const rendered = String(contextRow.rows[0]?.ctx?.rendered ?? "");
const panel = await client.query("select public.albert_proactive_panel() as panel");
const findings = panel.rows[0]?.panel?.run?.findings ?? [];
const headlines = findings
  .filter((f: { status: string; headline: string | null }) => f.status === "completed" && f.headline)
  .map((f: { agentTitle: string; headline: string }) => `${f.agentTitle}: ${f.headline}`);
console.log(`context ${rendered.length} chars, ${headlines.length} headlines`);

const bank = await buildQuestionBank({
  businessContext: rendered || "Ashburton Cycles, a bicycle retail and workshop business in Melbourne.",
  findingHeadlines: headlines,
  activeConnectors: ["lightspeed-r", "xero", "deputy"],
  apiKey,
  baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  safetyIdentifier: "proactive-headless-verification",
});
if (!bank) throw new Error("question bank returned null");
await client.query("select public.albert_proactive_record_question_bank($1::jsonb, $2)", [
  JSON.stringify(bank.questions),
  QUESTION_BANK_MODEL,
]);
console.log(`recorded ${bank.questions.length} questions:`);
for (const q of bank.questions) console.log(`  [${q.category}] ${q.text}`);
await client.end();
