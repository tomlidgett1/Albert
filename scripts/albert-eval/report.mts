/**
 * Albert eval reporter.
 *
 *   npx tsx scripts/albert-eval/report.mts --run baseline
 *   npx tsx scripts/albert-eval/report.mts --compare baseline improved
 *
 * Writes evals/albert/runs/<run>/report.md, or evals/albert/compare-<a>-vs-<b>.md.
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { RUNS_ROOT, latencyClass, percentile, readJsonl, runDir, type EvalTurnRecord } from "./lib.js";

type Grade = {
  id: string; tier: string; scope: string; surface: string; pattern: string; thread?: string; turn?: number;
  correctness: number; directness: number; calibrated_detail: number; format_fitness: number; ambiguity_handling: number | null; overall: number; pass: boolean;
  failure_tags: string[]; golden_verdict: string; notes: string; golden_checks: Array<{ found: string }>; deterministic: Record<string, unknown>; error?: string; judge_model?: string;
};

type Row = { record: EvalTurnRecord; grade?: Grade };

function load(run: string): Row[] {
  const dir = runDir(run);
  const records = readJsonl<EvalTurnRecord>(path.join(dir, "results.jsonl"));
  const grades = new Map(readJsonl<Grade>(path.join(dir, "grades.jsonl")).map((g) => [g.id, g] as const));
  // Keep the latest record per id (resume may append duplicates).
  const latest = new Map<string, EvalTurnRecord>();
  for (const r of records) latest.set(r.id, r);
  return [...latest.values()].map((record) => ({ record, grade: grades.get(record.id) }));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (n: number | null | undefined, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? "–" : n.toFixed(d));
const secs = (ms: number | null) => (ms === null ? "–" : (ms / 1000).toFixed(0));
const pct = (n: number) => (Number.isNaN(n) ? "–" : `${(n * 100).toFixed(0)}%`);

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(r);
  }
  return out;
}

function latencyTable(rows: Row[], key: (r: Row) => string, title: string): string {
  const groups = [...groupBy(rows, key).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const lines = [`### ${title}`, "", "| class | n | p50 s | p95 s | mean s | max s | timeouts/fails |", "|---|---:|---:|---:|---:|---:|---:|"];
  for (const [name, group] of groups) {
    const ms = group.map((r) => r.record.durationMs);
    const fails = group.filter((r) => r.record.failed).length;
    lines.push(`| ${name} | ${group.length} | ${secs(percentile(ms, 50))} | ${secs(percentile(ms, 95))} | ${secs(mean(ms))} | ${secs(Math.max(...ms))} | ${fails} |`);
  }
  const all = rows.map((r) => r.record.durationMs);
  lines.push(`| **all** | ${rows.length} | ${secs(percentile(all, 50))} | ${secs(percentile(all, 95))} | ${secs(mean(all))} | ${secs(Math.max(...all))} | ${rows.filter((r) => r.record.failed).length} |`);
  return lines.join("\n");
}

function qualityTable(rows: Row[], key: (r: Row) => string, title: string): string {
  const groups = [...groupBy(rows, key).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const lines = [`### ${title}`, "", "| group | n | pass | overall | correct | direct | detail | format | ambiguity | golden hit |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  const rowLine = (name: string, group: Row[]) => {
    const g = group.map((r) => r.grade).filter((x): x is Grade => Boolean(x));
    const goldenChecks = g.flatMap((x) => x.golden_checks.filter((c) => c.found !== "unavailable"));
    const goldenHit = goldenChecks.length ? goldenChecks.filter((c) => c.found === "owner").length / goldenChecks.length : NaN;
    const amb = g.map((x) => x.ambiguity_handling).filter((x): x is number => typeof x === "number");
    return `| ${name} | ${group.length} | ${pct(g.length ? g.filter((x) => x.pass).length / g.length : NaN)} | ${fmt(mean(g.map((x) => x.overall)), 2)} | ${fmt(mean(g.map((x) => x.correctness)), 2)} | ${fmt(mean(g.map((x) => x.directness)), 2)} | ${fmt(mean(g.map((x) => x.calibrated_detail)), 2)} | ${fmt(mean(g.map((x) => x.format_fitness)), 2)} | ${amb.length ? fmt(mean(amb), 2) : "–"} | ${goldenChecks.length ? `${pct(goldenHit)} (${goldenChecks.length})` : "–"} |`;
  };
  for (const [name, group] of groups) lines.push(rowLine(name, group));
  lines.push(rowLine("**all**", rows));
  return lines.join("\n");
}

function tagTable(rows: Row[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of r.grade?.failure_tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const lines = ["### Failure tags (ranked)", "", "| tag | turns | share |", "|---|---:|---:|"];
  for (const [tag, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${tag} | ${n} | ${pct(n / rows.length)} |`);
  return lines.join("\n");
}

function worstTable(rows: Row[], n = 25): string {
  const graded = rows.filter((r) => r.grade).sort((a, b) => (a.grade!.overall - b.grade!.overall) || (a.grade!.correctness - b.grade!.correctness));
  const lines = [`### Lowest-scoring turns (${Math.min(n, graded.length)})`, "", "| id | pattern | overall | correct | s | tags | note |", "|---|---|---:|---:|---:|---|---|"];
  for (const r of graded.slice(0, n)) {
    lines.push(`| ${r.record.id} | ${r.record.pattern} | ${r.grade!.overall} | ${r.grade!.correctness} | ${secs(r.record.durationMs)} | ${r.grade!.failure_tags.join(", ")} | ${r.grade!.notes.replace(/\|/g, "/").slice(0, 160)} |`);
  }
  return lines.join("\n");
}

function stateTable(rows: Row[]): string {
  const counts = groupBy(rows, (r) => r.record.answerState ?? (r.record.failed ? "FAILED" : "none"));
  const lines = ["### Answer states", "", "| state | n |", "|---|---:|"];
  for (const [s, g] of [...counts.entries()].sort((a, b) => b[1].length - a[1].length)) lines.push(`| ${s} | ${g.length} |`);
  return lines.join("\n");
}

function cubeMs(record: EvalTurnRecord): number {
  return record.queries.reduce((n, q) => n + (q.executionMs ?? 0), 0);
}

function queriesTable(rows: Row[]): string {
  const groups = [...groupBy(rows, (r) => latencyClass(r.record)).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const lines = ["### Queries executed per turn and where the time goes (by class)", "", "| class | queries mean | p50 | p95 | max | Cube exec p50 s | Cube exec p95 s | non-Cube p50 s (model + engine) | model requests mean |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|"];
  for (const [name, group] of groups) {
    const q = group.map((r) => r.record.queriesExecuted ?? r.record.queries.length);
    const cube = group.map((r) => cubeMs(r.record));
    const nonCube = group.map((r) => Math.max(0, r.record.durationMs - cubeMs(r.record)));
    const reqs = group.map((r) => Number((r.record.usage as { requests?: number } | undefined)?.requests ?? 0));
    lines.push(`| ${name} | ${fmt(mean(q))} | ${fmt(percentile(q, 50), 0)} | ${fmt(percentile(q, 95), 0)} | ${Math.max(...q)} | ${secs(percentile(cube, 50))} | ${secs(percentile(cube, 95))} | ${secs(percentile(nonCube, 50))} | ${fmt(mean(reqs))} |`);
  }
  lines.push("", "Cube exec = sum of semantic-layer execution time for the turn's queries (serial sum; parallel queries overlap, so this is an upper bound on Cube wall-clock). non-Cube = turn duration minus that sum: the time attributable to model calls and engine orchestration.");
  return lines.join("\n");
}

function singleReport(run: string): string {
  const rows = load(run);
  const graded = rows.filter((r) => r.grade);
  const engine = rows[0]?.record.engineVersion ?? "?";
  const models = [...new Set(rows.map((row) => row.record.model).filter(Boolean))].join(", ") || "unknown";
  const efforts = [...new Set(rows.map((row) => row.record.reasoningEffort).filter(Boolean))].join(", ") || "unknown";
  const fastModes = new Set(rows.map((row) => row.record.fastMode));
  const fastLabel = fastModes.size === 1
    ? (fastModes.has(true) ? "on" : "off")
    : "mixed";
  const out = [
    `# Albert eval report — run \`${run}\``,
    "",
    `Engine: \`${engine}\` · turns: ${rows.length} (graded ${graded.length}) · model under test: ${models} @ ${efforts}, fast mode ${fastLabel} · judge: ${[...new Set(graded.map((g) => g.grade?.judge_model).filter(Boolean))].join(", ") || "n/a"}`,
    "",
    "## Headline",
    "",
    `- Pass rate: **${pct(graded.length ? graded.filter((r) => r.grade!.pass).length / graded.length : NaN)}**`,
    `- Mean overall ${fmt(mean(graded.map((r) => r.grade!.overall)), 2)} · correctness ${fmt(mean(graded.map((r) => r.grade!.correctness)), 2)} · directness ${fmt(mean(graded.map((r) => r.grade!.directness)), 2)} · calibrated detail ${fmt(mean(graded.map((r) => r.grade!.calibrated_detail)), 2)} · format ${fmt(mean(graded.map((r) => r.grade!.format_fitness)), 2)}`,
    `- Latency p50 ${secs(percentile(rows.map((r) => r.record.durationMs), 50))}s · p95 ${secs(percentile(rows.map((r) => r.record.durationMs), 95))}s · failed/timeouts ${rows.filter((r) => r.record.failed).length}`,
    "",
    "## Latency",
    "",
    latencyTable(rows, (r) => latencyClass(r.record), "By interaction class"),
    "",
    latencyTable(rows, (r) => r.record.tier, "By difficulty tier"),
    "",
    latencyTable(rows, (r) => r.record.scope, "By tool scope"),
    "",
    queriesTable(rows),
    "",
    "## Quality",
    "",
    qualityTable(rows, (r) => r.record.tier, "By difficulty tier"),
    "",
    qualityTable(rows, (r) => r.record.scope, "By tool scope"),
    "",
    qualityTable(rows, (r) => r.record.pattern, "By interaction pattern"),
    "",
    qualityTable(rows, (r) => r.record.surface, "By surface area"),
    "",
    stateTable(rows),
    "",
    tagTable(rows),
    "",
    worstTable(rows),
    "",
    "## Every turn",
    "",
    "| id | tier | scope | pattern | s | q | state | overall | pass | tags |",
    "|---|---|---|---|---:|---:|---|---:|---|---|",
    ...rows.sort((a, b) => a.record.id.localeCompare(b.record.id)).map((r) => `| ${r.record.id} | ${r.record.tier} | ${r.record.scope} | ${r.record.pattern} | ${secs(r.record.durationMs)} | ${r.record.queriesExecuted ?? r.record.queries.length} | ${r.record.answerState ?? (r.record.failed ? "FAILED" : "?")} | ${r.grade?.overall ?? "–"} | ${r.grade ? (r.grade.pass ? "✅" : "❌") : "–"} | ${r.grade?.failure_tags.join(", ") ?? ""} |`),
  ];
  return out.join("\n");
}

function compareReport(a: string, b: string): string {
  const ra = load(a);
  const rb = load(b);
  const byIdB = new Map(rb.map((r) => [r.record.id, r] as const));
  const paired = ra.filter((r) => byIdB.has(r.record.id)).map((r) => ({ a: r, b: byIdB.get(r.record.id)! }));
  const lines: string[] = [`# Albert eval — before/after: \`${a}\` → \`${b}\``, "", `Paired turns: ${paired.length}`, ""];
  const stat = (rows: Row[]) => {
    const g = rows.filter((r) => r.grade).map((r) => r.grade!);
    const ms = rows.map((r) => r.record.durationMs);
    return {
      n: rows.length,
      pass: g.length ? g.filter((x) => x.pass).length / g.length : NaN,
      overall: mean(g.map((x) => x.overall)), correctness: mean(g.map((x) => x.correctness)), directness: mean(g.map((x) => x.directness)),
      detail: mean(g.map((x) => x.calibrated_detail)), format: mean(g.map((x) => x.format_fitness)),
      p50: percentile(ms, 50) ?? NaN, p95: percentile(ms, 95) ?? NaN, meanMs: mean(ms), fails: rows.filter((r) => r.record.failed).length,
      queries: mean(rows.map((r) => r.record.queriesExecuted ?? r.record.queries.length)),
    };
  };
  const section = (title: string, key: (r: Row) => string) => {
    lines.push(`## ${title}`, "", "| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |", "|---|---:|---|---|---|---|---|---|---|---|");
    const groups = [...new Set(paired.map((p) => key(p.a)))].sort();
    for (const g of [...groups, "**all**"]) {
      const sel = g === "**all**" ? paired : paired.filter((p) => key(p.a) === g);
      const sa = stat(sel.map((p) => p.a));
      const sb = stat(sel.map((p) => p.b));
      lines.push(`| ${g} | ${sel.length} | ${pct(sa.pass)} → ${pct(sb.pass)} | ${fmt(sa.overall, 2)} → ${fmt(sb.overall, 2)} | ${fmt(sa.correctness, 2)} → ${fmt(sb.correctness, 2)} | ${fmt(sa.detail, 2)} → ${fmt(sb.detail, 2)} | ${fmt(sa.format, 2)} → ${fmt(sb.format, 2)} | ${secs(sa.p50)} → ${secs(sb.p50)} | ${secs(sa.p95)} → ${secs(sb.p95)} | ${fmt(sa.queries)} → ${fmt(sb.queries)} |`);
    }
    lines.push("");
  };
  section("By interaction class", (r) => latencyClass(r.record));
  section("By difficulty tier", (r) => r.record.tier);
  section("By tool scope", (r) => r.record.scope);
  section("By interaction pattern", (r) => r.record.pattern);
  // Tag deltas
  const tagCount = (rows: Row[]) => { const m = new Map<string, number>(); for (const r of rows) for (const t of r.grade?.failure_tags ?? []) m.set(t, (m.get(t) ?? 0) + 1); return m; };
  const ta = tagCount(paired.map((p) => p.a));
  const tb = tagCount(paired.map((p) => p.b));
  lines.push("## Failure tags before → after", "", "| tag | before | after |", "|---|---:|---:|");
  for (const tag of [...new Set([...ta.keys(), ...tb.keys()])].sort((x, y) => (tb.get(y) ?? 0) + (ta.get(y) ?? 0) - (tb.get(x) ?? 0) - (ta.get(x) ?? 0))) lines.push(`| ${tag} | ${ta.get(tag) ?? 0} | ${tb.get(tag) ?? 0} |`);
  lines.push("", "## Per-turn deltas (regressions first)", "", "| id | pattern | overall before → after | correct | s before → after | q | tags after |", "|---|---|---|---|---|---|---|");
  const withDelta = paired.filter((p) => p.a.grade && p.b.grade).map((p) => ({ p, d: p.b.grade!.overall - p.a.grade!.overall }));
  withDelta.sort((x, y) => x.d - y.d);
  for (const { p } of withDelta) {
    lines.push(`| ${p.a.record.id} | ${p.a.record.pattern} | ${p.a.grade!.overall} → ${p.b.grade!.overall} | ${p.a.grade!.correctness} → ${p.b.grade!.correctness} | ${secs(p.a.record.durationMs)} → ${secs(p.b.record.durationMs)} | ${p.a.record.queriesExecuted ?? "?"} → ${p.b.record.queriesExecuted ?? "?"} | ${p.b.grade!.failure_tags.join(", ")} |`);
  }
  return lines.join("\n");
}

const argv = process.argv.slice(2);
if (argv[0] === "--compare") {
  const [a, b] = [argv[1]!, argv[2]!];
  const md = compareReport(a, b);
  const file = path.join(RUNS_ROOT, "..", `compare-${a}-vs-${b}.md`);
  writeFileSync(file, md);
  console.log(md);
  console.log(`\n→ ${file}`);
} else {
  const run = argv[argv.indexOf("--run") + 1] ?? "adhoc";
  const md = singleReport(run);
  const file = path.join(runDir(run), "report.md");
  writeFileSync(file, md);
  console.log(md.split("\n").slice(0, 60).join("\n"));
  console.log(`\n→ ${file}`);
}
