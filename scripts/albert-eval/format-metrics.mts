/**
 * Deterministic format + latency metrics over a codex eval run's
 * results.jsonl. Complements grade.mts (LLM judge) with measured facts:
 * markdown structure of answers, chart behaviour vs expectation, latency
 * phase decomposition, and query effort. Prints a markdown report and writes
 * format-metrics.json next to the results.
 *
 * Usage: npx tsx scripts/albert-eval/format-metrics.mts --run <run>
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { RUNS_ROOT, percentile, readJsonl, type EvalTurnRecord } from "./lib.js";

const run = process.argv[process.argv.indexOf("--run") + 1];
if (!run) throw new Error("--run required");
const dir = path.join(RUNS_ROOT, run);
const records = readJsonl<EvalTurnRecord>(path.join(dir, "results.jsonl"));
if (records.length === 0) throw new Error(`no results in ${dir}`);

type Row = {
  id: string;
  tier: string;
  state: string;
  durationS: number;
  firstQueryS: number | null;
  composeS: number | null; // answer − last query: synthesis + validation + review time
  queries: number;
  answerChars: number;
  headings: number;
  boldRuns: number;
  bullets: number;
  numberedItems: number;
  paragraphs: number;
  pipeTable: boolean;
  charts: number;
  chartExpected: boolean;
  chartDelivered: boolean;
  answerTables: number;
  followUps: number;
  leadsWithBottomLine: boolean;
};

const rows: Row[] = records.map((r) => {
  const text = r.answerText ?? "";
  const chartExpected = r.format === "line" || r.format === "bar";
  return {
    id: r.id,
    tier: r.tier,
    state: r.answerState ?? (r.failed ? "FAILED" : "none"),
    durationS: Math.round(r.durationMs / 1000),
    firstQueryS: r.phases.firstQueryMs != null ? Math.round(r.phases.firstQueryMs / 1000) : null,
    composeS: r.phases.answerMs != null && r.phases.lastQueryMs != null
      ? Math.round((r.phases.answerMs - r.phases.lastQueryMs) / 1000)
      : null,
    queries: r.queriesExecuted ?? r.queries.length,
    answerChars: text.length,
    headings: (text.match(/^#{1,4}\s/gmu) ?? []).length,
    boldRuns: (text.match(/\*\*[^*\n]+\*\*/gu) ?? []).length,
    bullets: (text.match(/^\s*[-*]\s/gmu) ?? []).length,
    numberedItems: (text.match(/^\s*\d+[.)]\s/gmu) ?? []).length,
    paragraphs: text.split(/\n{2,}/u).filter((p) => p.trim().length > 0).length,
    pipeTable: /^\s*\|.*\|\s*$/mu.test(text) && /\|\s*:?-{3,}/u.test(text),
    charts: r.charts.length,
    chartExpected,
    chartDelivered: r.charts.length > 0,
    answerTables: r.tables.filter((t) => t.presentation === "answer").length,
    followUps: r.followUps?.length ?? 0,
    leadsWithBottomLine: /^\s*\*\*/u.test(text),
  };
});

function stats(values: Array<number | null>): { p50: number | null; p90: number | null; max: number | null; mean: number | null } {
  const nums = values.filter((v): v is number => v != null);
  if (!nums.length) return { p50: null, p90: null, max: null, mean: null };
  return {
    p50: percentile(nums, 50),
    p90: percentile(nums, 90),
    max: Math.max(...nums),
    mean: Math.round(nums.reduce((a, b) => a + b, 0) / nums.length),
  };
}

const byTier = new Map<string, Row[]>();
for (const row of rows) {
  if (!byTier.has(row.tier)) byTier.set(row.tier, []);
  byTier.get(row.tier)!.push(row);
}

const lines: string[] = [];
lines.push(`# Format & latency metrics — run ${run}`, "", `Turns: ${rows.length}`, "");

lines.push("## Latency by tier (seconds)", "", "| tier | n | p50 | p90 | max | mean | p50 first-query | p50 compose |", "|---|---|---|---|---|---|---|---|");
for (const [tier, tierRows] of byTier) {
  const d = stats(tierRows.map((r) => r.durationS));
  const fq = stats(tierRows.map((r) => r.firstQueryS));
  const c = stats(tierRows.map((r) => r.composeS));
  lines.push(`| ${tier} | ${tierRows.length} | ${d.p50} | ${d.p90} | ${d.max} | ${d.mean} | ${fq.p50} | ${c.p50} |`);
}
const all = stats(rows.map((r) => r.durationS));
const allFq = stats(rows.map((r) => r.firstQueryS));
const allC = stats(rows.map((r) => r.composeS));
lines.push(`| **all** | ${rows.length} | ${all.p50} | ${all.p90} | ${all.max} | ${all.mean} | ${allFq.p50} | ${allC.p50} |`, "");

lines.push("## Answer states", "");
const states = new Map<string, number>();
for (const row of rows) states.set(row.state, (states.get(row.state) ?? 0) + 1);
for (const [state, count] of [...states].sort((a, b) => b[1] - a[1])) lines.push(`- ${state}: ${count}`);
lines.push("");

const chartExpectedRows = rows.filter((r) => r.chartExpected);
const chartMissing = chartExpectedRows.filter((r) => !r.chartDelivered);
const chartUnexpected = rows.filter((r) => !r.chartExpected && r.charts > 0);
lines.push("## Charts", "",
  `- chart expected (format=line/bar): ${chartExpectedRows.length}; delivered: ${chartExpectedRows.length - chartMissing.length}; MISSING: ${chartMissing.map((r) => r.id).join(", ") || "none"}`,
  `- charts on other turns: ${chartUnexpected.length} (${chartUnexpected.map((r) => `${r.id}:${r.charts}`).join(", ") || "none"})`,
  "");

lines.push("## Answer structure", "",
  `- length chars: p50 ${stats(rows.map((r) => r.answerChars)).p50}, p90 ${stats(rows.map((r) => r.answerChars)).p90}, max ${stats(rows.map((r) => r.answerChars)).max}`,
  `- with headings: ${rows.filter((r) => r.headings > 0).length}/${rows.length}`,
  `- with bold: ${rows.filter((r) => r.boldRuns > 0).length}/${rows.length} (median bold runs ${stats(rows.map((r) => r.boldRuns)).p50})`,
  `- with bullets: ${rows.filter((r) => r.bullets > 0).length}/${rows.length}`,
  `- leads with bold bottom-line: ${rows.filter((r) => r.leadsWithBottomLine).length}/${rows.length}`,
  `- markdown pipe tables (CONTRACT VIOLATION): ${rows.filter((r) => r.pipeTable).map((r) => r.id).join(", ") || "none"}`,
  `- answer-presentation tables: turns with ≥1: ${rows.filter((r) => r.answerTables > 0).length}/${rows.length}`,
  `- follow-up chips: turns with ≥1: ${rows.filter((r) => r.followUps > 0).length}/${rows.length}`,
  "");

lines.push("## Query effort", "",
  `- queries per turn: p50 ${stats(rows.map((r) => r.queries)).p50}, p90 ${stats(rows.map((r) => r.queries)).p90}, max ${stats(rows.map((r) => r.queries)).max}`,
  `- zero-query turns: ${rows.filter((r) => r.queries === 0).map((r) => r.id).join(", ") || "none"}`,
  "");

lines.push("## Slowest 10 turns", "", "| id | tier | state | total s | first-query s | compose s | queries | chars |", "|---|---|---|---|---|---|---|---|");
for (const row of [...rows].sort((a, b) => b.durationS - a.durationS).slice(0, 10)) {
  lines.push(`| ${row.id} | ${row.tier} | ${row.state} | ${row.durationS} | ${row.firstQueryS ?? "—"} | ${row.composeS ?? "—"} | ${row.queries} | ${row.answerChars} |`);
}
lines.push("");

const report = lines.join("\n");
writeFileSync(path.join(dir, "format-metrics.md"), report);
writeFileSync(path.join(dir, "format-metrics.json"), JSON.stringify(rows, null, 2));
console.log(report);
