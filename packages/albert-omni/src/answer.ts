import { z } from "zod";
import { formatReportingRange, reportingRanges, stripScopedCalendarDates } from "../../shared/src/reporting-dates.js";
import type { ResultSemantics, TraceAnswerEvent, TraceTableColumn, TraceRowFormat } from "../../shared/src/index.js";
import { publicColumnKey } from "../../albert-v3/src/cube/presentation.js";
import { sanitizeAnswerText, sanitizeTraceText } from "../../shared/src/index.js";
import { findUngroundedNumbersWithEvidence, ownerStatedGroundingValues } from "../../../services/conversation/src/grounding.js";
import type { PivotSourceResult } from "./pivot.js";
import { answerPeriodIssues } from "./answer-scope.js";
import { extractOmniFollowUps } from "./follow-ups.js";

const slotId = z.string().regex(/^[a-z][a-z_]{0,39}$/u);
const resultId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
export const composeAnswerSchema = z.object({
  outcome: z.enum(["answer", "explanation", "clarification", "no_data", "unavailable"]),
  markdown: z.string().min(1).max(100_000),
  values: z.array(z.object({
    id: slotId,
    resultId,
    rowIndex: z.number().int().min(0).max(499),
    columnKey: z.string().min(1).max(160),
    format: z.enum(["auto", "compact"]),
    decimals: z.number().int().min(0).max(4).nullable(),
  }).strict()).max(80),
  tables: z.array(z.object({
    id: slotId,
    resultId,
    columnKeys: z.array(z.string().min(1).max(160)).min(1).max(14),
    // Short owner-facing headers, one per column key. Governed field labels
    // ("Stock value (at retail list price)") are written for the model, not
    // for a table in a chat column.
    headers: z.array(z.string().min(1).max(40)).min(1).max(14).nullable(),
    limit: z.number().int().min(1).max(50),
  }).strict()).max(12),
  citedResultIds: z.array(resultId).max(30),
  limitations: z.array(z.string().min(1).max(500)).max(12),
  followUps: z.array(z.string().min(4).max(160)).max(3),
}).strict();
type ParsedAnswerInput = z.infer<typeof composeAnswerSchema>;
type AnswerTableInput = ParsedAnswerInput["tables"][number];
/** Callers built before headers existed may omit them; the model-facing schema stays strict. */
export type ComposeAnswerInput = Omit<ParsedAnswerInput, "tables"> & Readonly<{
  tables: readonly (Omit<AnswerTableInput, "headers"> & Readonly<{ headers?: AnswerTableInput["headers"] }>)[];
}>;
export type AnswerEvidence = PivotSourceResult & Readonly<{ rowFormats?: readonly (TraceRowFormat | null)[]; priorTurn?: boolean }>;
export type ComposedAnswer = Readonly<{
  text: string;
  state: Exclude<TraceAnswerEvent["state"], "Derived">;
  claims: NonNullable<TraceAnswerEvent["claims"]>;
  presentedResultIds: readonly string[];
  followUps: readonly string[];
}>;

function escapeCell(value: string): string {
  return value.replace(/([\\`*_{}[\]()<>|])/gu, "\\$1").replace(/[\r\n]+/gu, " ");
}

type PeriodGrain = "year" | "quarter" | "month" | "week" | "day";
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MIDNIGHT_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]00:00(?::00)?(?:\.0+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;
/** Amounts from here up read as whole dollars; cents are noise beside thousands. */
const WHOLE_CURRENCY_FROM = 1_000;

/** How one cell is shown. Precision is a property of the column, so a table never mixes "$7,199" with "$824.99". */
type CellStyle = Readonly<{
  format?: "auto" | "compact";
  decimals?: number | null;
  /** The largest magnitude this cell is read beside: its column in a table, itself in prose. */
  magnitude?: number;
  grain?: PeriodGrain | null;
  /** Years are dropped from week and day labels that fall in the current year. */
  currentYear?: number | null;
  /** Pad to the chosen precision, so figures read down a column line up ("85.4", "75.5"). */
  fixed?: boolean;
}>;

function midnightDate(value: unknown): Date | null {
  if (typeof value !== "string" || !MIDNIGHT_DATE.test(value)) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A month bucket is "Aug 2026" and a week is "6 Jul": the first day of a period is not its name. */
function periodLabel(date: Date, grain: PeriodGrain, currentYear: number | null | undefined): string {
  const year = date.getUTCFullYear();
  const dayMonth = `${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]}`;
  const suffix = year === currentYear ? "" : ` ${year}`;
  if (grain === "year") return String(year);
  if (grain === "quarter") return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${year}`;
  if (grain === "month") return `${MONTHS_SHORT[date.getUTCMonth()]} ${year}`;
  if (grain === "week") return `${dayMonth}${suffix}`;
  return `${WEEKDAYS_SHORT[date.getUTCDay()]} ${dayMonth}${suffix}`;
}

/** Column key to time grain, read from the query's own grain ("view.completed_at.month"). */
function columnGrains(semantics: ResultSemantics | undefined): ReadonlyMap<string, PeriodGrain> {
  const grains = new Map<string, PeriodGrain>();
  for (const entry of [semantics?.grain ?? [], ...(semantics?.inputGrains ?? [])].flat()) {
    const match = /^(.+)\.(year|quarter|month|week|day)$/u.exec(entry);
    if (!match) continue;
    grains.set(publicColumnKey(match[1]!), match[2] as PeriodGrain);
    grains.set(publicColumnKey(entry), match[2] as PeriodGrain);
  }
  return grains;
}

/**
 * Derived and earlier results carry no grain, so period buckets are recognised
 * from their shape. Only unambiguous buckets are named; an ordinary date column
 * (last sold, invoice due) keeps its full calendar date.
 */
function inferGrain(dates: readonly Date[]): PeriodGrain | null {
  const distinct = [...new Set(dates.map((date) => date.getTime()))].sort((a, b) => a - b).map((time) => new Date(time));
  if (distinct.length < 2) return null;
  if (distinct.every((date) => date.getUTCDate() === 1)) {
    if (distinct.every((date) => date.getUTCMonth() === 0)) return "year";
    return distinct.every((date) => date.getUTCMonth() % 3 === 0) && distinct.length >= 3 ? "quarter" : "month";
  }
  const weekday = distinct[0]!.getUTCDay();
  const gaps = distinct.slice(1).map((date, index) => (date.getTime() - distinct[index]!.getTime()) / 86_400_000);
  return distinct.every((date) => date.getUTCDay() === weekday) && gaps.every((gap) => gap % 7 === 0) ? "week" : null;
}

function grainFor(source: AnswerEvidence, column: TraceTableColumn, rowLimit = source.rows.length): PeriodGrain | null {
  if (!["date", "datetime"].includes(column.type)) return null;
  const declared = columnGrains(source.semantics).get(column.key);
  if (declared) return declared;
  return inferGrain(source.rows.slice(0, rowLimit).flatMap((row) => midnightDate(row[column.key]) ?? []));
}

/** Pivot headings arrive pre-formatted as calendar dates ("1 Aug 2026"); name the period they start instead. */
function periodHeaders(columns: readonly TraceTableColumn[], semantics: ResultSemantics | undefined, currentYear: number | null): ReadonlyMap<string, string> {
  const parsed = columns.flatMap((column) => {
    const match = /^(\d{1,2}) ([A-Z][a-z]{2})[a-z]* (\d{4})$/u.exec(column.label.trim());
    const month = match ? MONTHS_SHORT.indexOf(match[2]!) : -1;
    return match && month >= 0 ? [{ key: column.key, date: new Date(Date.UTC(Number(match[3]), month, Number(match[1]))) }] : [];
  });
  if (parsed.length < 2) return new Map();
  const declared = [...new Set(columnGrains(semantics).values())];
  const grain = declared.length === 1 ? declared[0]! : inferGrain(parsed.map((entry) => entry.date));
  return grain ? new Map(parsed.map((entry) => [entry.key, periodLabel(entry.date, grain, currentYear)])) : new Map();
}

function displayCell(value: unknown, column: TraceTableColumn, style: CellStyle = {}): string {
  const { format = "auto", decimals = null } = style;
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" && /(?:^|[._])(?:compare_date_range|compareDateRange)$/u.test(column.key)) return escapeCell(formatReportingRange(value));
  if (["date", "datetime"].includes(column.type)) {
    const date = midnightDate(value);
    if (date && style.grain) return escapeCell(periodLabel(date, style.grain, style.currentYear));
    if (date) return `${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }
  if (!["number", "currency", "percent"].includes(column.type)) {
    // A source system's enum ("COST_OF_SALES") is a code, not a label. Only the
    // underscored form is rewritten: an all-caps word may be a brand ("SRAM").
    const label = String(value);
    return escapeCell(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(label) ? `${label[0]}${label.slice(1).toLowerCase().replaceAll("_", " ")}` : label);
  }
  const exact = typeof value === "number" ? value : String(value).replaceAll(",", "");
  const numeric = Number(exact);
  if (!Number.isFinite(numeric)) throw new Error(`Non-numeric cell in ${column.key}.`);
  const shown = column.type === "percent" && column.percentScale === "ratio" ? numeric * 100 : numeric;
  // Only money is read down a column; a percentage or a count keeps its own precision.
  const magnitude = column.type === "currency" ? Math.max(Math.abs(shown), style.magnitude ?? 0) : Math.abs(shown);
  // Precision follows what a reader can use: whole dollars beside thousands,
  // one decimal on a percentage, and no more than the cell itself carries.
  // Compact notation only abbreviates from a thousand up; below that "$480.6"
  // is neither rounded nor exact, so small amounts fall back to the plain rule.
  const places = decimals ?? (format === "compact" && Math.abs(shown) >= 1_000 ? 1
    : column.type === "currency" ? (magnitude >= WHOLE_CURRENCY_FROM || (format === "compact" && magnitude >= 100) ? 0 : 2)
      : column.type === "percent" ? (magnitude >= 100 ? 0 : magnitude < 1 && shown !== 0 ? 2 : 1)
        : Number.isInteger(numeric) ? 0 : magnitude >= 100 ? 1 : 2);
  const formatter = new Intl.NumberFormat("en-AU", {
    maximumFractionDigits: places,
    // Money keeps both cents whenever it is written out; only an abbreviated figure ("$3.7k") drops zeros.
    minimumFractionDigits: style.fixed || (column.type === "currency" && !(format === "compact" && Math.abs(shown) >= 1_000)) ? places : 0,
    ...(format === "compact" ? { notation: "compact" as const } : {}),
    ...(column.type === "currency" ? { style: "currency" as const, currency: column.currency ?? "AUD" } : {}),
  });
  // Node 22's Intl accepts exact decimal strings; TS's signature still lists
  // only number | bigint. Keep this compatibility cast at the formatting edge.
  const formatExact = formatter.format as unknown as (value: string | number) => string;
  const text = formatExact(column.type === "percent" && column.percentScale === "ratio" ? numeric * 100 : exact)
    // "$3.7k" is how the figure is written; ICU's "$3.7K" reads as a unit.
    .replace(/(?<=\d)K$/u, "k");
  return column.type === "percent" ? `${text}%` : text;
}

/** One precision for a count or rate column: none if every cell is whole, otherwise one decimal (two for small rates). */
function columnDecimals(rows: readonly Readonly<Record<string, unknown>>[], column: TraceTableColumn): number | null {
  if (column.type !== "number" && column.type !== "percent") return null;
  const scale = column.type === "percent" && column.percentScale === "ratio" ? 100 : 1;
  const cells = rows.flatMap((row) => {
    const numeric = Number(typeof row[column.key] === "string" ? (row[column.key] as string).replaceAll(",", "") : row[column.key]);
    return row[column.key] === null || row[column.key] === undefined || !Number.isFinite(numeric) ? [] : [numeric * scale];
  });
  if (!cells.length) return null;
  if (column.type === "number" && cells.every(Number.isInteger)) return 0;
  const largest = Math.max(...cells.map(Math.abs));
  // Rates under 1% keep each cell's own precision: padding "0.5%" to "0.50%" adds nothing.
  if (column.type === "percent") return largest < 1 ? null : 1;
  return largest < 10 ? 2 : 1;
}

function columnMagnitude(rows: readonly Readonly<Record<string, unknown>>[], key: string): number {
  return rows.reduce((max, row) => {
    const numeric = Number(typeof row[key] === "string" ? (row[key] as string).replaceAll(",", "") : row[key]);
    return Number.isFinite(numeric) ? Math.max(max, Math.abs(numeric)) : max;
  }, 0);
}

const STOP_WORDS = new Set("a an the of to in on at for and or but is are was were be been it this that these those with from by as than then so not no you your its their they has have had will can".split(" "));
function contentWords(value: string): ReadonlySet<string> {
  return new Set(value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/u).filter((word) => word.length > 2 && !STOP_WORDS.has(word)));
}
/** Share of the smaller statement's words that the other one also uses. */
function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size < 3 || right.size < 3) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.min(left.size, right.size);
}

/** Opens the closing footnote paragraph; the web renderer sets it small and muted. */
export const ANSWER_NOTE_PREFIX = "Note: ";

/**
 * One footnote, said once. The model's limitations, the results' own
 * qualifications and the harness's notes used to be appended as body
 * paragraphs after an answer that had usually stated them already, so a
 * three-paragraph reply could be two paragraphs of caveat. A note the body
 * already makes, or that another note makes, is dropped from display; the
 * answer state is decided from the facts, never from what survives here.
 */
function footnote(body: string, notes: readonly string[]): string {
  const sentences = body.split(/(?<=[.!?])\s+|\n+/u).map(contentWords);
  const kept: { text: string; words: ReadonlySet<string> }[] = [];
  for (const note of notes) {
    const text = note.trim().replace(/\s+/gu, " ");
    if (!text) continue;
    const words = contentWords(text);
    if (sentences.some((sentence) => overlap(words, sentence) >= 0.75)) continue;
    if (kept.some((other) => overlap(words, other.words) >= 0.75)) continue;
    kept.push({ text: /[.!?]$/u.test(text) ? text : `${text}.`, words });
  }
  return kept.length ? `${ANSWER_NOTE_PREFIX}${kept.map((note) => note.text).join(" ")}` : "";
}
/**
 * Bold is the headline. A reply that bolds every figure has no headline, so
 * figure-bearing bold survives once — the first — plus bullet lead-ins and the
 * total rows of a statement table. Bold words (a verdict) are left alone.
 */
function calmBold(markdown: string): string {
  let headline = false;
  return markdown.split("\n").map((line) => {
    if (/^\s*\|/u.test(line)) return line;
    return line.replace(/\*\*([^*\n]+)\*\*/gu, (match, inner: string, offset: number) => {
      if (!/\d/u.test(inner)) return match;
      if (/^\s*(?:[-*]|\d+[.)])\s+$/u.test(line.slice(0, offset))) return match;
      if (!headline) { headline = true; return match; }
      return inner;
    });
  }).join("\n");
}

/**
 * Row labels that close a section of a financial statement. A table is only
 * treated as a statement when at least two of its rows do: a P&L has Gross
 * profit and Net profit, whereas a scorecard that happens to list Net profit
 * beside takings and hours is not a statement and gets no ruled lines.
 */
const STATEMENT_TOTAL = /^(?:gross profit|net (?:profit|loss|income|assets|position|cash(?: movement| flow)?)|operating (?:profit|income)|ebit(?:da)?|total\b.*|.*\btotal)$/iu;

/**
 * Prose that already says a figure fell, directly before that figure: "down ",
 * "a drop of ", "fell by ". Words that introduce a level rather than a change
 * ("fell from", "below") are excluded, because a level may really be negative.
 */
const FALLING_WORDS = /\b(?:down|fell|fallen|falling|dropped|drop|declined?|decreased?|lower|shrank|lost|loss|shortfall|reduction)(?:\s+(?:by|of))?\s+(?:about\s+|around\s+|roughly\s+|just\s+|nearly\s+)?$/iu;
/** "below last year's pace by ": a figure introduced by "by" is a change, so a falling word earlier in the clause settles its direction. */
const FALLING_BY = /\b(?:down|fell|fallen|falling|dropped|declined|decreased|lower|below|behind|under|short|trailing|trails?|shrank|weaker|softer)\b[^.;:!?\n]{0,48}\bby\s+(?:about\s+|around\s+|roughly\s+|just\s+|nearly\s+)?$/iu;

/** Resolves every analytical figure from governed cells; the model supplies prose and references. */
export function composeAnswer(
  input: ComposeAnswerInput,
  evidence: ReadonlyMap<string, AnswerEvidence>,
  options: Readonly<{ question: string; today: string; hadQueryFailures?: boolean; imessage?: boolean }>,
): Readonly<{ ok: true; answer: ComposedAnswer }> | Readonly<{ ok: false; issues: readonly string[] }> {
  const parsed = composeAnswerSchema.safeParse({
    ...input,
    tables: Array.isArray(input.tables) ? input.tables.map((table) => ({ headers: null, ...table })) : input.tables,
  });
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  const request = parsed.data;
  const issues: string[] = [];
  const selected = new Set(request.citedResultIds);
  const slots = new Map<string, string>();
  const claims: NonNullable<TraceAnswerEvent["claims"]>[number][] = [];
  const currentYear = Number(/\b((?:19|20)\d{2})\b/u.exec(options.today)?.[1]) || null;
  let truncatedTable = false;
  /** How many rows each presented table shows: a count the server itself rendered ("the eight bikes above"). */
  const shownRowCounts: number[] = [];
  const put = (id: string, value: string) => {
    if (slots.has(id)) issues.push(`Duplicate placeholder ${id}.`);
    slots.set(id, value);
  };
  for (const value of request.values) {
    const source = evidence.get(value.resultId);
    const column = source?.columns.find((column) => column.key === value.columnKey);
    const row = source?.rows[value.rowIndex];
    if (!source || !column || !row || !(value.columnKey in row)) {
      issues.push(`Value ${value.id} references an unknown result, row or column.`);
      continue;
    }
    selected.add(source.resultId);
    try {
      const text = displayCell(row[column.key], source.rowFormats?.[value.rowIndex] ? { ...column, ...source.rowFormats[value.rowIndex] } : column, {
        format: value.format, decimals: value.decimals, grain: grainFor(source, column), currentYear,
      });
      put(value.id, text);
      claims.push({ statement: `${column.label}: ${text} (${source.provenance.timeRange.label})`, assertion: "value", refs: [{ resultId: source.resultId, rowIndex: value.rowIndex, columnKey: column.key }] });
    } catch (error) { issues.push(error instanceof Error ? error.message : "Invalid value."); }
  }
  for (const table of request.tables) {
    const placeholder = `{{${table.id}}}`;
    const lines = request.markdown.replace(/\r\n?/gu, "\n").split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.includes(placeholder)) continue;
      if (line.trim() !== placeholder || lines[index - 1]?.trim() || lines[index + 1]?.trim()) {
        issues.push(`Table ${table.id} must be a standalone paragraph: put ${placeholder} alone on a line with a blank line before and after it. Do not wrap it in a hand-written table header, row, or formatting.`);
      }
    }
    const source = evidence.get(table.resultId);
    if (!source) { issues.push(`Table ${table.id} references an unknown result.`); continue; }
    if (options.imessage) { issues.push("iMessage answers use value placeholders and short paragraphs, not tables."); continue; }
    const columns = table.columnKeys.map((key) => source.columns.find((column) => column.key === key));
    if (columns.some((column) => !column)) { issues.push(`Table ${table.id} names an unknown column.`); continue; }
    if (new Set(table.columnKeys).size !== table.columnKeys.length) { issues.push(`Table ${table.id} repeats a column.`); continue; }
    if (table.headers && table.headers.length !== table.columnKeys.length) { issues.push(`Table ${table.id} needs exactly one header per column key (${table.columnKeys.length}), or null.`); continue; }
    selected.add(source.resultId);
    const typed = columns as TraceTableColumn[];
    const rows = source.rows.slice(0, table.limit);
    if (rows.length < source.rows.length || source.semantics?.completeness === "limited") truncatedTable = true;
    shownRowCounts.push(rows.length);
    // A period heading is resolved from the governed cell that names it, so a
    // model-written header can shorten a field label but never rename a period.
    const periods = periodHeaders(typed, source.semantics, currentYear);
    const headers = typed.map((column, index) => {
      const written = periods.has(column.key) ? undefined : table.headers?.[index]?.trim();
      const figures = written?.match(/\d[\d,.]*/gu) ?? [];
      if (figures.some((figure) => !column.label.includes(figure) && !/^(?:19|20)\d{2}$/u.test(figure))) {
        issues.push(`Header "${written}" states a figure its field does not carry. Headers name the column; figures belong in cells.`);
      }
      return written || periods.get(column.key) || column.label;
    });
    const numeric = (column: TraceTableColumn) => ["number", "currency", "percent"].includes(column.type);
    const closesSection = (row: Readonly<Record<string, unknown>>) => typed[0]!.type === "string" && STATEMENT_TOTAL.test(String(row[typed[0]!.key] ?? "").trim());
    const statement = rows.filter(closesSection).length >= 2;
    const magnitudes = typed.map((column) => columnMagnitude(rows, column.key));
    const precisions = typed.map((column) => columnDecimals(rows, column));
    const grains = typed.map((column) => grainFor(source, column, table.limit));
    try {
      // One row of several measures reads sideways ("Sales revenue | Cost of
      // sales | Gross profit | ..."). Stood on its end it is a statement: one
      // line per measure, under the period it covers. Same cells, same claims.
      if (rows.length === 1 && typed.length >= 3) {
        const row = rows[0]!;
        const cells = typed.map((column, index) => {
          const text = displayCell(row[column.key], source.rowFormats?.[0] && column.type !== "string" ? { ...column, ...source.rowFormats[0] } : column, { grain: grains[index]!, currentYear });
          claims.push({ statement: `${column.label}: ${text}`, assertion: "value", refs: [{ resultId: source.resultId, rowIndex: 0, columnKey: column.key }] });
          return text;
        });
        const periodAt = typed.findIndex((column) => ["date", "datetime"].includes(column.type) || /(?:^|[._])(?:compare_date_range|compareDateRange)$/u.test(column.key));
        const lines = typed.flatMap((_, index) => index === periodAt ? [] : [{ label: headers[index]!, cell: cells[index]! }]);
        const statement = lines.filter((line) => STATEMENT_TOTAL.test(line.label.trim())).length >= 2;
        put(table.id, [
          `| ${periodAt >= 0 ? "Line" : "Metric"} | ${periodAt >= 0 ? cells[periodAt]! : "Value"} |`,
          "| --- | ---: |",
          ...lines.map((line) => {
            const total = statement && STATEMENT_TOTAL.test(line.label.trim());
            return `| ${total ? `**${escapeCell(line.label)}**` : escapeCell(line.label)} | ${total && line.cell !== "—" ? `**${line.cell}**` : line.cell} |`;
          }),
        ].join("\n"));
        continue;
      }
      put(table.id, [
        `| ${headers.map(escapeCell).join(" | ")} |`,
        `| ${typed.map((column) => numeric(column) ? "---:" : "---").join(" | ")} |`,
        ...rows.map((row, rowIndex) => {
          // A metric-per-row pivot is read across, so its precision is set by the row.
          const rowFormat = source.rowFormats?.[rowIndex];
          const across = rowFormat ? Math.max(0, ...typed.filter(numeric).map((column) => Math.abs(Number(row[column.key])) || 0)) : null;
          // A statement's subtotal and total lines carry the accountant's emphasis;
          // the renderer rules them off from the detail above.
          const total = statement && closesSection(row);
          return `| ${typed.map((column, index) => {
            const text = displayCell(row[column.key], rowFormat && column.type !== "string" ? { ...column, ...rowFormat } : column, {
              magnitude: across ?? magnitudes[index]!, grain: grains[index]!, currentYear,
              // Mixed-unit pivot rows keep each cell's own precision; a plain column shares one.
              ...(rowFormat || precisions[index] === null ? {} : { decimals: precisions[index]!, fixed: true }),
            });
            claims.push({ statement: `${column.label}: ${text}`, assertion: "value", refs: [{ resultId: source.resultId, rowIndex, columnKey: column.key }] });
            return total && text !== "—" ? `**${text}**` : text;
          }).join(" | ")} |`;
        }),
      ].join("\n"));
    } catch (error) { issues.push(error instanceof Error ? error.message : "Invalid table."); }
  }
  for (const id of selected) if (!evidence.has(id)) issues.push(`Unknown cited result ${id}.`);
  const sources = [...selected].flatMap((id) => evidence.get(id) ? [evidence.get(id)!] : []);
  if (request.outcome === "answer" || request.outcome === "no_data") issues.push(...answerPeriodIssues(options.question, sources));
  const placeholders = [...request.markdown.matchAll(/\{\{([a-z][a-z_]{0,39})\}\}/gu)].map((match) => match[1]!);
  for (const id of placeholders) if (!slots.has(id)) issues.push(`Unknown placeholder {{${id}}}.`);
  for (const id of slots.keys()) if (!placeholders.includes(id)) issues.push(`Placeholder {{${id}}} was defined but not used.`);

  // Values from result cells must travel through a reference, never borrow
  // support from an unrelated equal number somewhere in the evidence pool.
  const plain = [request.markdown.replace(/\{\{[^}]+\}\}/gu, ""), ...request.limitations].join("\n");
  const dateLabels = [options.today, ...sources.flatMap((source) => [source.provenance.timeRange.label, source.provenance.timeRange.start, source.provenance.timeRange.end])];
  const allowed = [...ownerStatedGroundingValues(options.question), ...dateLabels.flatMap((label) => [...label.matchAll(/\b(?:19|20)\d{2}\b/gu)].map((match) => Number(match[0])))];
  const labels = [...dateLabels, ...sources.flatMap((source) => source.rows.flatMap((row) => source.columns.filter((column) => ["string", "date", "datetime"].includes(column.type)).map((column) => String(row[column.key] ?? ""))))];
  // The spans this answer's evidence covers: explicit query windows, the run of
  // dates each cited result actually returned, and today.
  const todayIso = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(options.today)?.[1];
  const spans: (readonly [string, string])[] = [
    ...(todayIso ? [[todayIso, todayIso] as const] : []),
    ...sources.flatMap((source) => [
      ...reportingRanges(source),
      ...source.columns.filter((column) => ["date", "datetime"].includes(column.type)).flatMap((column) => {
        const days = source.rows.flatMap((row) => {
          const cell = row[column.key];
          return typeof cell === "string" && /^\d{4}-\d{2}-\d{2}/u.test(cell) ? [cell.slice(0, 10)] : [];
        }).sort();
        return days.length ? [[days[0]!, days.at(-1)!] as const] : [];
      }),
    ]),
  ];
  const scoped = stripScopedCalendarDates(plain, spans);
  issues.push(...scoped.issues);
  // Two more things that read as numbers but are not findings. A window length
  // taken from the governed fields a cited result used ("no sale in 90 days"
  // from unsold_90_days) is scope. And "one" is an article far more often than
  // a count ("one soft spot", "the one to watch"): rejecting it cost a repair
  // round-trip on a third of turns and taught the model to write around it.
  // The governed query is scope too: "no sale in 90 days" may come from a
  // filter value the query itself carries rather than from a field's name.
  const fieldNumbers = new Set(sources.flatMap((source) => [
    ...source.columns.flatMap((column) => [column.key, column.label]),
    ...source.provenance.definitions.flatMap((definition) => [definition.metric, definition.label]),
    (source as Readonly<{ queryYaml?: unknown }>).queryYaml,
  ]).flatMap((name) => typeof name === "string" ? name.match(/\d+/gu) ?? [] : []));
  const prose = scoped.text
    .replace(/(?<![\p{L}\d$£€¥.,-])(\d{1,4})(?:\s*-\s*|\s+)(?:day|week|month|year)s?\b/giu, (match, length: string) => fieldNumbers.has(length) ? " the window " : match)
    // "one soft spot", "one-off": never "twenty-one" or "one hundred".
    .replace(/(?<![\p{L}-])one(?![\p{L}]|-(?:hundred|thousand|million|billion|and)\b|\s+(?:hundred|thousand|million|billion)\b)/giu, " ");
  const unsupported = findUngroundedNumbersWithEvidence(prose, [...allowed, ...shownRowCounts], labels);
  if (unsupported.length) issues.push(`Unbound figures: ${unsupported.slice(0, 12).join(", ")}. Use {{value_name}} references or {{table_name}}; calculate new figures with DeriveResult first.`);
  if (/\{\{|\}\}/u.test(plain)) issues.push("Malformed answer placeholder.");
  if (request.outcome === "answer" && (!sources.length || claims.length === 0)) issues.push("An analytical answer requires cited evidence and at least one value or table reference.");
  if (request.outcome === "no_data" && (!sources.length || sources.some((source) => source.rows.length > 0))) issues.push("No data requires an executed empty query for the requested scope.");
  if (request.outcome === "explanation" && (request.values.length || request.tables.length)) issues.push("Use outcome answer when presenting data values.");
  if (issues.length) return { ok: false, issues };

  // A placeholder renders with its own sign, currency symbol and percent sign;
  // a model that also types one around it would show "$$9,126" and "26.8%%",
  // and one that writes the direction in words would show "down -19.9%".
  const resolved = request.markdown.replace(/(-?)(\$?)\{\{([a-z][a-z_]{0,39})\}\}(%?)/gu, (_match, minus: string, dollar: string, id: string, percent: string, offset: number, whole: string) => {
    const slot = slots.get(id)!;
    const lead = whole.slice(Math.max(0, offset - 72), offset).replace(/\*\*/gu, "");
    const saidInWords = slot.startsWith("-") && (FALLING_WORDS.test(lead) || FALLING_BY.test(lead));
    const value = saidInWords ? slot.slice(1) : slot;
    const symbol = /[$€£¥]|\b[A-Z]{3}\b/u.test(value);
    return `${minus && value.startsWith("-") ? "" : minus}${dollar && symbol ? "" : dollar}${value}${percent && value.endsWith("%") ? "" : percent}`;
  });
  const extracted = extractOmniFollowUps(resolved);
  // A closing paragraph set wholly in italics is a caveat written as an aside;
  // it belongs with the other notes, in the footnote's type, not in the body.
  const aside = /\n\n[*_]([^*_\n][^\n]*[^*_\n])[*_]\s*$/u.exec(extracted.text);
  const body = calmBold(aside ? extracted.text.slice(0, aside.index) : extracted.text);
  const qualifications = sources.flatMap((source) => source.semantics?.qualifications ?? []);
  const limited = sources.some((source) => source.semantics?.completeness !== "complete");
  const reused = sources.some((source) => source.priorTurn);
  const failures = Boolean(options.hadQueryFailures) && request.outcome === "answer";
  const qualified = request.limitations.length > 0 || qualifications.length > 0 || limited || reused || failures;
  // A list cut short is worth saying once, unless a ranking's head is what was
  // asked for: "top 10", "best day", "biggest expenses" expect a partial list.
  const askedForTopN = /\b(?:top|best|worst|biggest|largest|smallest|highest|lowest|most|least|busiest|quietest|slowest|fastest)\b/iu.test(options.question);
  const notes = [
    ...(aside ? [aside[1]!] : []),
    ...request.limitations,
    ...qualifications,
    ...(truncatedTable && !askedForTopN && !request.limitations.some((note) => /\b(?:top|first|largest|highest|biggest)\b|\bnot (?:a |the )?(?:complete|full)\b|\bcapped\b|\bslice\b|\blimited to\b/iu.test(note))
      ? ["Tables list the top rows, not every row."] : []),
    ...(reused ? ["Uses earlier results from this conversation; the figures have not been refreshed."] : []),
    ...(failures ? ["Some queries failed along the way; the figures shown come from the ones that succeeded."] : []),
  ];
  const note = footnote(body, notes);
  const text = note ? `${body}\n\n${note}` : body;
  if (text.length > 120_000 || Buffer.byteLength(JSON.stringify({ text, claims })) > 1_200_000) return { ok: false, issues: ["The composed answer exceeds the artifact size limit. Select fewer rows or columns; the answer will not be silently truncated."] };
  const state: ComposedAnswer["state"] = request.outcome === "clarification" ? "Clarification"
    : request.outcome === "unavailable" ? "Unavailable"
      : request.outcome === "explanation" ? "Exploratory"
        : qualified ? "Qualified"
          : request.outcome === "no_data" ? "No data" : "Verified";
  return { ok: true, answer: {
    text: sanitizeAnswerText(text, 120_000), state, claims,
    presentedResultIds: [...selected],
    followUps: options.imessage ? [] : [...new Set([...request.followUps, ...extracted.followUps])].slice(0, 3).map((text) => sanitizeTraceText(text, 160)),
  } };
}

export const COMPOSE_ANSWER_INSTRUCTIONS = `# Composing the final answer

Use ComposeAnswer to deliver the answer. Its accepted content is exactly what the owner receives.
Write the answer in markdown, replacing EVERY analytical figure with a named placeholder like {{sales}}. Define it in values using the resultId, zero-based rowIndex and exact columnKey returned by a tool. Do not type the value yourself.
A placeholder renders complete: its own minus sign, currency symbol, thousands separators and percent sign. Write "{{sales}}" and "up {{change}}", never "\${{sales}}" or "{{change}}%". format auto shows whole dollars from $1,000 up, cents below that, and one decimal on a percentage; format compact rounds for reading ($19.4k, $1.2M) and is the right choice for most amounts inside a sentence, because the table beside it carries the exact figure. Leave decimals null unless a specific precision matters. A date cell renders as the period it names (a month bucket as "Aug 2026", a week as "6 Jul", a day as "Sat 12 Sep").
Calendar dates are not figures: type a date or a day range directly, digits and all ("Sunday 13 September", "1–19 September"), whenever it falls inside the window your cited results cover or is today. That is how you name a day that has no row of its own, such as a day the store was closed. Never spell a date out in words ("the nineteenth") to avoid digits. Give the weekday only when you are sure of it; a mismatch is rejected. The article "one" and a window length that comes from a field you queried ("no sale in 90 days") are likewise fine to type; every other count or amount is a placeholder.
For tables, put {{weekly_table}} in its own paragraph, alone on a line with a blank line before and after, and define it in tables with resultId, columnKeys, headers and limit. headers is one short, plain header per column key, in the same order ("Product", "Revenue", "Units", "Week"): the governed field labels are long and technical, so always supply them. A header names the column and never carries a figure; period columns of a pivot keep their own period names whatever you pass. Choose only the columnKeys that earn a place and set limit to the rows worth reading. Do not wrap the placeholder in a Markdown table or add your own header or separator row: the server supplies the complete table. Never hand-copy or transpose a numerical table. ComposePivotTable and DeriveResult prepare new shapes and arithmetic before composition. CalculateValues computes exact arithmetic between any two result cells, including period-on-period change across two rows of a comparison query.
Use citedResultIds for every result that supports the conclusion.
limitations is the answer's single footnote, shown once in small type beneath it. Give it zero to two short items, each under twenty words, and only what would change how the owner reads a figure: a proxy, a partial period, a missing source, a known data gap. Never repeat there what the body already says, and never list routine basis (currency, timezone, "completed non-voided sales") that would not mislead anyone. The harness adds its own note when a table is cut short. The harness decides the answer state; you cannot promote an answer to Verified.
outcome answer presents query evidence; explanation answers a definition question without figures; clarification asks the one blocking question; no_data cites the executed empty result; unavailable names the missing capability. Do not use explanation to avoid retrieving business figures.
If composition reports issues, repair the references or run the necessary query or derivation, then compose again. After acceptance, finish with a brief hand-over; do not rewrite the accepted answer.`;
