/**
 * Headless morning-brief synthesis for the latest completed Proactive run
 * (mirrors app/api/proactive/synthesis/route.ts). Env: PROACTIVE_DB_URL.
 * Usage: node --env-file=.env.local --import tsx scripts/_proactive-synthesize.mts
 */
import pg from "pg";
import { buildProactiveSynthesis } from "../services/proactive/src/synthesis.js";

const dbUrl = process.env.PROACTIVE_DB_URL;
const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!dbUrl || !apiKey) throw new Error("set PROACTIVE_DB_URL and OPENAI_API_KEY");

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query("set role albert_control_migration_owner");
await client.query(
  "select set_config('request.jwt.claims', json_build_object('sub', 'e6a1b354-ffbc-41c0-8131-d2f018dba818', 'role', 'authenticated')::text, false)",
);
const panel = await client.query("select public.albert_proactive_panel() as panel");
const run = panel.rows[0]?.panel?.run;
if (!run || run.status !== "completed") throw new Error(`no completed run (status=${run?.status})`);
console.log(`synthesizing run ${run.runId} (${run.findings.length} findings)`);

const synthesis = await buildProactiveSynthesis({
  businessName: "Ashburton Cycles",
  findings: run.findings
    .filter((finding: { status: string }) => finding.status === "completed")
    .map((finding: Record<string, unknown>) => ({
      agentKey: String(finding.agentKey),
      agentTitle: String(finding.agentTitle),
      answerState: finding.answerState as string | null,
      headline: finding.headline as string | null,
      keyNumbers: (finding.keyNumbers ?? []) as readonly { label: string; value: string }[],
      summaryExcerpt: String(finding.summary ?? ""),
    })),
  apiKey,
  baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  safetyIdentifier: "proactive-headless-verification",
});
if (!synthesis) throw new Error("synthesis returned null");
await client.query("select public.albert_proactive_record_synthesis($1, $2::jsonb)", [
  run.runId,
  JSON.stringify(synthesis),
]);
console.log("\n===== VERDICT =====\n" + synthesis.verdict);
console.log("\n===== HIGHLIGHTS =====");
for (const h of synthesis.highlights) {
  console.log(`[${h.tone}] ${h.headline}\n  why: ${h.why}\n  ask: ${h.question}`);
}
console.log("\n===== QUIET LINE =====\n" + synthesis.quietLine);
await client.end();
