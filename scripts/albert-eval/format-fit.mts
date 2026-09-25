/**
 * Deterministic answer-SHAPE fit over an Omni eval run (companion to
 * style-metrics.mts, which measures length and caveats). style-metrics rewards
 * brevity and never notices a missing table; this asks whether each answer took
 * the shape its question needs (questions carry `format`), and flags the
 * failure modes the owner reported on 2026-09-23:
 *
 * - dense prose: a paragraph or bullet carrying four or more figures, which a
 *   table would have shown at a glance;
 * - a comparison written as sentences: two periods compared across several
 *   figures with no table;
 * - malformed pivots: a composed pivot whose row labels are numbers or whose
 *   "periods" are not periods (a category or ID pivoted across the top);
 * - ID and code columns shown to the owner;
 * - table overshoot on a question that wanted a sentence;
 * - a comparison table that drops a period or the change: a question that
 *   compares periods (its `expect` names both) is only a fit when one table
 *   shows both periods and a change column;
 * - em dashes, which the owners' house style bans.
 *
 * Usage:
 *   npx tsx scripts/albert-eval/format-fit.mts --run <run>
 *   npx tsx scripts/albert-eval/format-fit.mts --compare <before> <after>
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { RUNS_ROOT, readJsonl, type EvalTurnRecord } from "./lib.js";

type Table = { headers: string[]; rows: string[][] };
type Fit = {
  id: string; format: string; state: string; ms: number; queries: number;
  tables: number; tableShapes: string; pivots: number; malformedPivots: number; charts: number;
  proseWords: number; figuresInProse: number; densePassages: number; idColumns: number;
  comparison: boolean; comparisonShape: string; emDashes: number;
  fit: boolean; verdict: string;
};

const FIGURE = /(?:[-−]?\$\s?\d[\d,]*(?:\.\d+)?\s?[kKmMbB]?)|(?:[-−]?\d[\d,]*(?:\.\d+)?\s?%)|(?:\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)|(?:\b\d+(?:\.\d+)?\b)/gu;
const DATEISH = /\b(?:\d{1,2}\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s\d{1,2}|(?:19|20)\d{2}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s*[–-]\s*\d{1,2})\b/gu;
const PERIOD_HEADER = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)\w*\s+)?(?:\d{1,2}\s)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*(?:\s(?:19|20)?\d{2,4})?$|^(?:q[1-4]\s)?(?:19|20)\d{2}$|^week|^(?:this|last|previous|prior)\s|^(?:mtd|ytd)$|^\d{4}-\d{2}(?:-\d{2})?$|^\d{1,2}\s(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|^\d{1,2}\s*[–-]\s*\d{1,2}\s(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/iu;
/** A question that compares periods: its expectation names the other period or the change. */
const COMPARES = /\b(?:the week before|the month before|last month|both periods|a change column|and the change)\b/iu;
const CHANGE_HEADER = /\b(?:change|diff(?:erence)?|drop|growth|movement|vs)\b|Δ|[+-]\s?%/iu;
const NUMERIC_CELL = /^[+\-−]?\$?[\d,]+(?:\.\d+)?\s?(?:%|pts|[kKmM])?$/u;

function parse(text: string): { prose: string; tables: Table[] } {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const tables: Table[] = [];
  const prose: string[] = [];
  const split = (value: string) => value.trim().replace(/^\||\|$/gu, "").split(/(?<!\\)\|/u).map((cell) => cell.replace(/\\(.)/gu, "$1").trim());
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*\|.*\|\s*$/u.test(line) && /^\s*\|[\s:|-]+\|\s*$/u.test(lines[i + 1] ?? "")) {
      const table: Table = { headers: split(line), rows: [] };
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/u.test(lines[i]!)) { table.rows.push(split(lines[i]!)); i += 1; }
      i -= 1;
      tables.push(table);
      continue;
    }
    // The closing footnote is small print, not body prose.
    if (/^\s*(?:\*\*)?Note:/iu.test(line)) continue;
    prose.push(line);
  }
  return { prose: prose.join("\n"), tables };
}

const words = (value: string) => value.replace(/[#*_`>|]/gu, " ").split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
const figures = (value: string) => (value.replace(DATEISH, " ").match(FIGURE) ?? []).filter((match) => !/^\d$/u.test(match.trim())).length;

function isIdColumn(header: string, cells: readonly string[]): boolean {
  if (/\b(?:id|code|sku|ean|upc|#)\b/iu.test(header)) return true;
  const filled = cells.filter(Boolean);
  // Integer-looking cells with thousands separators in a column that is not a count or amount.
  return filled.length >= 3 && filled.every((cell) => /^\d{1,3}(?:,\d{3})+$/u.test(cell)) && !/\b(?:units?|qty|quantity|count|transactions?|sales|orders?|items?|jobs?|hours?)\b/iu.test(header);
}

/**
 * How a comparison table is laid out: "both+change" when one table shows two
 * periods and the change, else what it is missing.
 */
function comparisonShape(tables: readonly Table[]): string {
  let best = "no table";
  for (const table of tables) {
    const change = table.headers.findIndex((header) => CHANGE_HEADER.test(header));
    const numeric = table.headers.map((_, index) => table.rows.length > 0 && table.rows.every((row) => !row[index] || NUMERIC_CELL.test(row[index]!.replace(/\*\*/gu, ""))));
    // Periods across the top (a pivot), or two numeric value columns beside a change (a per-entity comparison).
    const periods = table.headers.filter((header, index) => index !== change && (PERIOD_HEADER.test(header.trim()) || numeric[index])).length;
    const shape = periods >= 2 && change >= 0 ? "both+change" : periods >= 2 ? "no change column" : change >= 0 ? "change without both periods" : "one period";
    if (shape === "both+change") return shape;
    if (best === "no table" || shape === "no change column") best = shape;
  }
  return best;
}

function analyse(record: EvalTurnRecord): Fit {
  const text = record.answerText ?? "";
  const { prose, tables } = parse(text);
  const format = record.format ?? "any";
  const paragraphs = prose.split(/\n{2,}|\n(?=\s*(?:[-*]|\d+[.)])\s)/u).map((part) => part.trim()).filter(Boolean);
  const dense = paragraphs.filter((part) => figures(part) >= 4).length;
  const figuresInProse = figures(prose);
  // A composed pivot is the table whose rows are metrics (ComposePivotTable's shape); derived tables carry no view.
  const composedPivots = record.tables.filter((table) => table.columns[0]?.key === "metric");
  const malformed = composedPivots.filter((table) => {
    const [first, ...rest] = table.columns;
    if (!first || rest.length === 0) return false;
    // Metrics run down a pivot's first column; numbers there mean the shape was transposed.
    const rowLabelsNumeric = table.rows.slice(0, 8).filter((row) => typeof row[first.key] === "number").length >= Math.min(3, table.rows.length);
    // Pivot period columns carry period names; product names or IDs across the top are not periods.
    const periodish = rest.filter((column) => PERIOD_HEADER.test(column.label.trim())).length;
    return rowLabelsNumeric || (rest.length >= 3 && periodish === 0 && table.columns.some((column) => /\b(?:id|path|category|product|name)\b/iu.test(column.label)));
  }).length;
  const idColumns = tables.reduce((sum, table) => sum + table.headers.filter((header, index) => isIdColumn(header, table.rows.map((row) => row[index] ?? ""))).length, 0);
  const tableShapes = tables.map((table) => `${table.rows.length}x${table.headers.length}`).join(" ") || "-";
  const maxRows = Math.max(0, ...tables.map((table) => table.rows.length));
  const answered = Boolean(text.trim()) && !record.failed;
  const comparison = COMPARES.test(record.expect ?? "");
  const shape = comparison ? comparisonShape(tables) : "-";
  const emDashes = (text.match(/—/gu) ?? []).length;
  let fit = false;
  let verdict = "";
  if (!answered) verdict = record.failed ? `failed: ${record.failed}` : "no answer";
  else if (format === "table") {
    fit = tables.length > 0 && malformed === 0 && idColumns === 0 && (!comparison || shape === "both+change");
    verdict = tables.length === 0 ? (dense ? "prose where a table was needed (dense)" : "prose where a table was needed")
      : malformed ? "malformed pivot" : idColumns ? "ID/code column shown" : comparison && shape !== "both+change" ? `comparison: ${shape}` : comparison ? "comparison table" : "table";
  } else if (format === "chart_or_table") {
    fit = (tables.length > 0 || record.charts.length > 0) && malformed === 0;
    verdict = fit ? (record.charts.length ? "chart" : "table") : malformed ? "malformed pivot" : "prose where a chart or table was needed";
  } else if (format === "prose") {
    fit = maxRows <= 5 && dense === 0;
    verdict = maxRows > 5 ? `table overshoot (${maxRows} rows)` : dense ? "dense prose" : "sentence";
  } else {
    fit = true;
    verdict = "any";
  }
  if (fit && dense > 0 && tables.length > 0) verdict += " + dense prose";
  if (emDashes) verdict += ` + ${emDashes} em dash${emDashes === 1 ? "" : "es"}`;
  return {
    id: record.id, format, state: record.answerState ?? "-", ms: record.durationMs, queries: record.queriesExecuted ?? record.queries.length,
    tables: tables.length, tableShapes, pivots: composedPivots.length, malformedPivots: malformed, charts: record.charts.length,
    proseWords: words(prose), figuresInProse, densePassages: dense, idColumns, comparison, comparisonShape: shape, emDashes, fit, verdict,
  };
}

function load(run: string): Fit[] {
  const records = readJsonl<EvalTurnRecord>(path.join(RUNS_ROOT, run, "results.jsonl"));
  const latest = new Map<string, EvalTurnRecord>();
  for (const record of records) latest.set(record.id, record);
  return [...latest.values()].sort((left, right) => left.id.localeCompare(right.id)).map(analyse);
}

function summary(rows: readonly Fit[]) {
  const fit = rows.filter((row) => row.fit).length;
  return {
    turns: rows.length,
    fitRate: rows.length ? Math.round((fit / rows.length) * 1000) / 10 : 0,
    fit,
    missingTables: rows.filter((row) => row.verdict.startsWith("prose where")).length,
    densePassages: rows.reduce((sum, row) => sum + row.densePassages, 0),
    malformedPivots: rows.reduce((sum, row) => sum + row.malformedPivots, 0),
    idColumns: rows.reduce((sum, row) => sum + row.idColumns, 0),
    comparisons: rows.filter((row) => row.comparison).length,
    comparisonsWithBothAndChange: rows.filter((row) => row.comparisonShape === "both+change").length,
    emDashes: rows.reduce((sum, row) => sum + row.emDashes, 0),
    medianProseWords: [...rows].map((row) => row.proseWords).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0,
    medianSeconds: Math.round(([...rows].map((row) => row.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0) / 1000),
  };
}

function print(run: string, rows: readonly Fit[]) {
  console.log(`\n# ${run}`);
  console.log("id     format          fit  verdict                                   tables       pivots charts prose figs dense  s");
  for (const row of rows) {
    console.log(`${row.id.padEnd(6)} ${row.format.padEnd(15)} ${row.fit ? "yes" : "NO "}  ${row.verdict.slice(0, 41).padEnd(41)} ${row.tableShapes.slice(0, 12).padEnd(12)} ${String(row.pivots).padStart(3)}${row.malformedPivots ? "!" : " "}  ${String(row.charts).padStart(5)} ${String(row.proseWords).padStart(5)} ${String(row.figuresInProse).padStart(4)} ${String(row.densePassages).padStart(5)} ${String(Math.round(row.ms / 1000)).padStart(3)}`);
  }
  console.log(JSON.stringify(summary(rows)));
}

const argv = process.argv.slice(2);
if (argv[0] === "--compare" && argv[1] && argv[2]) {
  const before = load(argv[1]);
  const after = load(argv[2]);
  print(argv[1], before);
  print(argv[2], after);
} else if (argv[0] === "--run" && argv[1]) {
  const rows = load(argv[1]);
  print(argv[1], rows);
  writeFileSync(path.join(RUNS_ROOT, argv[1], "format-fit.json"), JSON.stringify({ summary: summary(rows), rows }, null, 2));
} else {
  throw new Error("Usage: format-fit.mts --run <run> | --compare <before> <after>");
}
