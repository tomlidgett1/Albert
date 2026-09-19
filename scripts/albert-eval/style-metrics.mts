/**
 * Deterministic answer-STYLE metrics over an Omni eval run's results.jsonl.
 * format-metrics.mts measures structure and latency; this measures how the
 * answer reads: length against a per-tier budget, caveat load, sentences that
 * say the same thing twice, prose that re-reads table cells, over-precise
 * figures, bold density and table shape. No model in the loop, so two runs of
 * the same corpus compare exactly.
 *
 * The closing "Note: ..." footnote (ADR 0143) is measured apart from the body.
 * It is the one place a caveat belongs and is set in small print, so counting
 * it as prose made a 25-word answer with a 12-word note look a third caveat.
 * Its length is reported and penalised on its own, so it cannot quietly become
 * the new dumping ground.
 *
 * Usage:
 *   npx tsx scripts/albert-eval/style-metrics.mts --run <run>
 *   npx tsx scripts/albert-eval/style-metrics.mts --compare <before> <after>
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { RUNS_ROOT, readJsonl, type EvalTurnRecord } from "./lib.js";

/** Prose-word budget by tier: what a sharp analyst would send, not a report. */
const PROSE_BUDGET: Record<string, number> = { easy: 60, medium: 130, hard: 260, xhard: 320 };

const CAVEAT = /\b(?:tax[- ]inclusive|inc(?:l(?:uding|usive)?)?\.? (?:gst|tax)|ex[- ](?:gst|tax)|in aud\b|aud\b|accrual|cash basis|basis\b|non-voided|refunds? (?:subtract|netted)|excludes?|not included|does not (?:establish|include)|is not (?:a|the)|isn[’']t (?:a|the)|not a (?:complete|confirmed|full|forecast|claim)|partial|month to date|quarter to date|best[- ]effort|inference|is limited to|capped|top slice|ranked slice|rows returned|full population|not (?:been )?refreshed|business date|timezone|australia\/melbourne|snapshot|operational|on-costs|superannuation and other)\b/iu;
const FILLER = /\b(?:is below|are below|below\.|shown below|in other words|this gives you|worth noting|it[’']s worth|in summary|overall,|here (?:is|are) (?:the|a)|the full (?:ranking|breakdown|list)|as shown|the key signal|that came from|i used the)\b/giu;
const STOP = new Set("a an the of to in on at for and or but is are was were be been it this that these those with from by as than then so not no you your i we our its their they he she versus vs per".split(" "));

type Table = { headers: string[]; rows: string[][] };
type Row = {
  id: string; tier: string; state: string; words: number; proseWords: number; budget: number; overBudget: number;
  tables: number; maxCols: number; maxRows: number; headings: number; bullets: number; bold: number; boldPer100: number;
  caveatSentences: number; caveatWords: number; caveatShare: number; noteWords: number; duplicatePairs: number; filler: number;
  rereadFigures: number; centsFigures: number; longHeaders: number; datedBuckets: number; leadsWithAnswer: boolean; score: number;
};

function parse(text: string): { prose: string; tables: Table[] } {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const tables: Table[] = [];
  const prose: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*\|.*\|\s*$/u.test(line) && /^\s*\|[\s:|-]+\|\s*$/u.test(lines[i + 1] ?? "")) {
      const split = (value: string) => value.trim().replace(/^\||\|$/gu, "").split(/(?<!\\)\|/u).map((cell) => cell.replace(/\\(.)/gu, "$1").trim());
      const table: Table = { headers: split(line), rows: [] };
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/u.test(lines[i]!)) { table.rows.push(split(lines[i]!)); i += 1; }
      i -= 1;
      tables.push(table);
      continue;
    }
    prose.push(line);
  }
  return { prose: prose.join("\n"), tables };
}

const wordCount = (value: string) => value.replace(/[#*_`>|]/gu, " ").split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
const sentences = (value: string) => value.replace(/^#{1,6}\s.*$/gmu, "").replace(/\*\*/gu, "").split(/(?<=[.!?])\s+|\n+/u).map((s) => s.replace(/^\s*(?:[-*]|\d+[.)])\s+/u, "").trim()).filter((s) => wordCount(s) >= 4);
const contentWords = (value: string) => new Set(value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/u).filter((word) => word.length > 2 && !STOP.has(word)));
const figures = (value: string) => [...value.matchAll(/-?\$?\d[\d,]*(?:\.\d+)?%?/gu)].map((m) => m[0].replace(/[$,]/gu, "")).filter((f) => f.replace(/\D/gu, "").length >= 3);

function measure(record: EvalTurnRecord): Row {
  const text = record.answerText ?? "";
  const parsed = parse(text);
  const tables = parsed.tables;
  const noteAt = parsed.prose.search(/(?:^|\n)Notes?: /u);
  const note = noteAt >= 0 ? parsed.prose.slice(noteAt) : "";
  const prose = noteAt >= 0 ? parsed.prose.slice(0, noteAt) : parsed.prose;
  // Repetition is judged across body and footnote together: a note that
  // restates the body is exactly the defect.
  const all = sentences(`${prose}\n${note.replace(/^\s*Notes?: /u, "")}`);
  const body = sentences(prose);
  const caveats = body.filter((sentence) => CAVEAT.test(sentence));
  let duplicatePairs = 0;
  const sets = all.map(contentWords);
  for (let a = 0; a < sets.length; a += 1) for (let b = a + 1; b < sets.length; b += 1) {
    const left = sets[a]!; const right = sets[b]!;
    if (left.size < 4 || right.size < 4) continue;
    const shared = [...left].filter((word) => right.has(word)).length;
    if (shared / Math.min(left.size, right.size) >= 0.6) duplicatePairs += 1;
  }
  const tableFigures = new Set(tables.flatMap((table) => table.rows.flat().flatMap(figures)));
  const rereadFigures = figures(prose).filter((figure) => tableFigures.has(figure)).length;
  const centsFigures = [...text.matchAll(/\$\d{1,3}(?:,\d{3})+\.\d{2}\b/gu)].length;
  const longHeaders = tables.flatMap((table) => table.headers).filter((header) => header.length > 20 || /[()]/u.test(header)).length;
  // A month or week bucket printed as a full calendar date ("1 Aug 2026").
  const datedBuckets = tables.flatMap((table) => [...table.headers, ...table.rows.map((row) => row[0] ?? "")]).filter((cell) => /^\d{1,2} [A-Z][a-z]{2,8} \d{4}$/u.test(cell)).length;
  const proseWords = wordCount(prose);
  const budget = PROSE_BUDGET[record.tier] ?? 130;
  const bold = (text.match(/\*\*[^*\n]+\*\*/gu) ?? []).length;
  const caveatWords = caveats.reduce((sum, sentence) => sum + wordCount(sentence), 0);
  const first = body[0] ?? "";
  const noteWords = wordCount(note.replace(/^\s*Notes?: /u, ""));
  const row: Omit<Row, "score"> = {
    id: record.id, tier: record.tier, state: record.answerState ?? (record.failed ? "FAILED" : "none"),
    words: wordCount(text), proseWords, budget, overBudget: Math.max(0, proseWords - budget),
    tables: tables.length, maxCols: Math.max(0, ...tables.map((table) => table.headers.length)), maxRows: Math.max(0, ...tables.map((table) => table.rows.length)),
    headings: (text.match(/^#{1,6}\s/gmu) ?? []).length, bullets: (text.match(/^\s*(?:[-*]|\d+[.)])\s/gmu) ?? []).length,
    bold, boldPer100: proseWords ? Math.round((bold / proseWords) * 1000) / 10 : 0,
    caveatSentences: caveats.length, caveatWords, caveatShare: proseWords ? Math.round((caveatWords / proseWords) * 100) : 0, noteWords,
    duplicatePairs, filler: (prose.match(FILLER) ?? []).length, rereadFigures, centsFigures, longHeaders, datedBuckets,
    leadsWithAnswer: /\d|\*\*/u.test(first),
  };
  // 100 = clean. Each defect class is capped so one runaway metric cannot hide the rest.
  const penalty = Math.min(30, (row.overBudget / row.budget) * 30) + Math.min(20, Math.max(0, row.caveatShare - 15) * 0.6)
    + Math.min(10, Math.max(0, row.noteWords - 35) * 0.4) + Math.min(15, row.duplicatePairs * 5) + Math.min(10, row.rereadFigures * 1.5) + Math.min(8, row.centsFigures * 0.5)
    + Math.min(6, row.longHeaders * 1.5) + Math.min(4, row.datedBuckets) + Math.min(6, Math.max(0, row.boldPer100 - 3) * 1.5)
    + Math.min(4, row.filler * 2) + (row.leadsWithAnswer ? 0 : 5) + (row.maxCols > 5 ? 4 : 0) + (row.tier === "easy" && row.headings ? 4 : 0);
  return { ...row, score: Math.max(0, Math.round(100 - penalty)) };
}

function load(run: string): Row[] {
  const records = readJsonl<EvalTurnRecord>(path.join(RUNS_ROOT, run, "results.jsonl"));
  if (!records.length) throw new Error(`no results in ${run}`);
  const latest = new Map<string, EvalTurnRecord>();
  for (const record of records) latest.set(record.id, record);
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id)).map(measure);
}

const mean = (rows: Row[], pick: (row: Row) => number) => Math.round((rows.reduce((sum, row) => sum + pick(row), 0) / Math.max(1, rows.length)) * 10) / 10;
const COLUMNS: Array<[string, (row: Row) => number]> = [
  ["score", (r) => r.score], ["prose words", (r) => r.proseWords], ["over budget", (r) => r.overBudget], ["caveat %", (r) => r.caveatShare], ["note words", (r) => r.noteWords],
  ["dup pairs", (r) => r.duplicatePairs], ["re-read figs", (r) => r.rereadFigures], ["cents figs", (r) => r.centsFigures], ["long headers", (r) => r.longHeaders],
  ["dated buckets", (r) => r.datedBuckets], ["bold/100w", (r) => r.boldPer100], ["filler", (r) => r.filler], ["headings", (r) => r.headings], ["max cols", (r) => r.maxCols], ["max rows", (r) => r.maxRows],
];

function report(run: string, rows: Row[]): string {
  const lines = [`# Answer style — run ${run}`, "", `Turns: ${rows.length} · mean score ${mean(rows, (r) => r.score)} / 100`, "",
    `| id | tier | state | ${COLUMNS.map(([name]) => name).join(" | ")} | leads |`, `|---|---|---|${COLUMNS.map(() => "---:").join("|")}|---|`];
  for (const row of rows) lines.push(`| ${row.id} | ${row.tier} | ${row.state} | ${COLUMNS.map(([, pick]) => pick(row)).join(" | ")} | ${row.leadsWithAnswer ? "yes" : "NO"} |`);
  lines.push(`| **mean** | | | ${COLUMNS.map(([, pick]) => mean(rows, pick)).join(" | ")} | ${rows.filter((r) => r.leadsWithAnswer).length}/${rows.length} |`, "");
  return lines.join("\n");
}

const argv = process.argv.slice(2);
if (argv[0] === "--compare") {
  const [before, after] = [argv[1], argv[2]];
  if (!before || !after) throw new Error("--compare <before> <after>");
  const left = load(before); const right = load(after);
  const lines = [`# Answer style — ${before} → ${after}`, "", "| metric | before | after | change |", "|---|---:|---:|---:|"];
  for (const [name, pick] of COLUMNS) {
    const a = mean(left, pick); const b = mean(right, pick);
    lines.push(`| ${name} | ${a} | ${b} | ${a === 0 ? "—" : `${Math.round(((b - a) / a) * 100)}%`} |`);
  }
  lines.push("", "| id | score | prose words | caveat % | dup pairs | cents figs |", "|---|---|---|---|---|---|");
  for (const row of left) {
    const match = right.find((candidate) => candidate.id === row.id);
    if (match) lines.push(`| ${row.id} | ${row.score} → ${match.score} | ${row.proseWords} → ${match.proseWords} | ${row.caveatShare} → ${match.caveatShare} | ${row.duplicatePairs} → ${match.duplicatePairs} | ${row.centsFigures} → ${match.centsFigures} |`);
  }
  console.log(lines.join("\n"));
} else {
  const run = argv[argv.indexOf("--run") + 1];
  if (!run || argv.indexOf("--run") < 0) throw new Error("--run <run> or --compare <before> <after>");
  const rows = load(run);
  const text = report(run, rows);
  writeFileSync(path.join(RUNS_ROOT, run, "style-metrics.md"), text);
  writeFileSync(path.join(RUNS_ROOT, run, "style-metrics.json"), JSON.stringify(rows, null, 2));
  console.log(text);
}
