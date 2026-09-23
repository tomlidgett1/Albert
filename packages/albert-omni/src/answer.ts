import { z } from "zod";
import { formatReportingRange, reportingRanges, stripScopedCalendarDates } from "../../shared/src/reporting-dates.js";
import { PIVOT_CHANGE_COLUMN_KEY, type ResultSemantics, type TraceAnswerEvent, type TraceTableColumn, type TraceRowFormat } from "../../shared/src/index.js";
import { publicColumnKey } from "../../albert-v3/src/cube/presentation.js";
import { sanitizeAnswerText, sanitizeTraceText } from "../../shared/src/index.js";
import { findUngroundedNumbersWithEvidence, ownerStatedGroundingValues } from "../../../services/conversation/src/grounding.js";
import type { PivotSourceResult } from "./pivot.js";
import { answerPeriodIssues } from "./answer-scope.js";
import { extractOmniFollowUps } from "./follow-ups.js";
import { BLANK_CALCULATION_NOTE } from "./derive.js";

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
    // Rows ordered by one column before the limit ("biggest falls first"); null keeps the result's order.
    sort: z.object({ columnKey: z.string().min(1).max(160), direction: z.enum(["asc", "desc"]) }).strict().nullable(),
  }).strict()).max(12),
  citedResultIds: z.array(resultId).max(30),
  limitations: z.array(z.string().min(1).max(500)).max(12),
  followUps: z.array(z.string().min(4).max(160)).max(3),
}).strict();
type ParsedAnswerInput = z.infer<typeof composeAnswerSchema>;
type AnswerTableInput = ParsedAnswerInput["tables"][number];
/** Callers built before headers and sorting existed may omit them; the model-facing schema stays strict. */
export type ComposeAnswerInput = Omit<ParsedAnswerInput, "tables"> & Readonly<{
  tables: readonly (Omit<AnswerTableInput, "headers" | "sort"> & Readonly<{ headers?: AnswerTableInput["headers"]; sort?: AnswerTableInput["sort"] }>)[];
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
  // A pivot heading stands alone, so a week says it is one: "Week of 7 Sep", never a bare "7 Sep".
  return grain
    ? new Map(parsed.map((entry) => [entry.key, `${grain === "week" ? "Week of " : ""}${periodLabel(entry.date, grain, currentYear)}`]))
    : new Map();
}

/** An empty numeric cell is left blank, and an empty label says so: a dash reads as a figure. */
const EMPTY_CELL = "";
/** A calendar phrase in a header ("1–19 Sep", "Sep to 19") names a window, not a figure. */
const HEADER_MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?";
const HEADER_DATE = new RegExp(`\\b\\d{1,2}(?:\\s*[–-]\\s*\\d{1,2})?\\s+${HEADER_MONTH}|\\b${HEADER_MONTH}\\s+(?:to\\s+)?\\d{1,2}(?:\\s*[–-]\\s*\\d{1,2})?\\b`, "giu");
const EMPTY_LABEL = "Not set";

function displayCell(value: unknown, column: TraceTableColumn, style: CellStyle = {}): string {
  const { format = "auto", decimals = null } = style;
  if (value === null || value === undefined) return column.type === "string" ? EMPTY_LABEL : EMPTY_CELL;
  if (typeof value === "string" && /(?:^|[._])(?:compare_date_range|compareDateRange)$/u.test(column.key)) return escapeCell(formatReportingRange(value));
  if (["date", "datetime"].includes(column.type)) {
    const date = midnightDate(value);
    if (date && style.grain) return escapeCell(periodLabel(date, style.grain, style.currentYear));
    if (date) return `${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    // An instant on the store's own clock (no zone) reads as its calendar day: to the owner a last-sold time is a date.
    const local = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/u.exec(value) : null;
    const month = local ? MONTHS_SHORT[Number(local[2]) - 1] : undefined;
    if (local && month) return `${Number(local[3])} ${month} ${local[1]}`;
  }
  if (!["number", "currency", "percent"].includes(column.type)) {
    // A source system's enum ("COST_OF_SALES") is a code, not a label. Only the
    // underscored form is rewritten: an all-caps word may be a brand ("SRAM").
    // Emphasis written into a label ("**Gross profit**") would print its marks literally once escaped.
    const label = String(value).replace(/\*\*|__|`/gu, "").trim();
    if (!label) return EMPTY_LABEL;
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
  // A rate or count that is not zero never reads as zero: beside large cells
  // "0.004" keeps its first significant digit rather than the column's "0.0".
  // Money keeps its column's precision, because cents are noise beside thousands.
  const tiny = column.type !== "currency" && shown !== 0 && Math.abs(shown) < 0.5 * 10 ** -places;
  const formatter = new Intl.NumberFormat("en-AU", {
    maximumFractionDigits: tiny ? Math.min(4, Math.ceil(-Math.log10(Math.abs(shown)))) : places,
    // Money keeps both cents whenever it is written out; only an abbreviated figure ("$3.7k") drops zeros.
    minimumFractionDigits: tiny ? 0 : style.fixed || (column.type === "currency" && !(format === "compact" && Math.abs(shown) >= 1_000)) ? places : 0,
    // A figure that rounds to zero carries no sign: "-0.0%" and "-$0" read as a fall.
    signDisplay: "negative",
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

type PivotChange = Readonly<{ rate: boolean; scale: TraceTableColumn["percentScale"] }>;

/**
 * A composed pivot's change cell (metric rows, a closing change column) keeps
 * its own unit whatever its row's format says: null when the cell is not one,
 * else whether the row is a rate, whose change is a difference in points.
 */
function pivotChange(source: AnswerEvidence, column: TraceTableColumn, rowIndex: number): PivotChange | null {
  if (source.columns[0]?.key !== "metric" || column.key !== PIVOT_CHANGE_COLUMN_KEY || column.type !== "percent") return null;
  const rowFormat = source.rowFormats?.[rowIndex];
  const period = source.columns.find((candidate) => ["number", "currency", "percent"].includes(candidate.type) && candidate.key !== PIVOT_CHANGE_COLUMN_KEY);
  return { rate: (rowFormat?.type ?? period?.type) === "percent", scale: rowFormat?.percentScale ?? period?.percentScale };
}

/**
 * A pivot's change: one decimal, a percent change on an amount or a count and
 * percentage points on a rate. A table signs it ("+12.4%", "-3.1 pts") so a
 * reader never works out which way it moved; a sentence says the direction in
 * words, so there only a fall keeps its sign.
 */
function changeCell(value: unknown, change: PivotChange, signed: boolean): string {
  if (value === null || value === undefined || value === "") return EMPTY_CELL;
  const numeric = Number(typeof value === "string" ? value.replaceAll(",", "") : value);
  if (!Number.isFinite(numeric)) throw new Error("Non-numeric change cell.");
  const shown = change.rate && change.scale === "ratio" ? numeric * 100 : numeric;
  const places = Math.abs(shown) >= 100 ? 0 : 1;
  const rounded = Number(shown.toFixed(places));
  const text = new Intl.NumberFormat("en-AU", { minimumFractionDigits: places, maximumFractionDigits: places }).format(Math.abs(rounded));
  return `${rounded < 0 ? "-" : rounded > 0 && signed ? "+" : ""}${text}${change.rate ? " pts" : "%"}`;
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
 * No em dashes in an answer: the owners' house style reads a clause set off by
 * dashes between commas instead. Table rows are left alone.
 */
function withoutEmDashes(markdown: string): string {
  return markdown.split("\n").map((line) => (/^\s*\|/u.test(line) || !line.includes("—") ? line : line
    .replace(/\s*—\s*/gu, ", ")
    .replace(/,\s*([,.;:!?])/gu, "$1")
    .replace(/^(\s*(?:[-*]|\d+[.)])?\s*),\s*/u, "$1")
    .replace(/,\s*$/u, ""))).join("\n");
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
/** Prose that says a figure rose, directly before it: "up ", "a rise of ", "grew by ". */
const RISING_WORDS = /\b(?:up|rose|risen|rising|rise|grew|grown|growing|gained|gain|increased?|higher|climbed|jumped|lifted)(?:\s+(?:by|of))?\s+(?:about\s+|around\s+|roughly\s+|just\s+|nearly\s+)?$/iu;
/** A placeholder with the marks typed around it: a minus or "$" before it, a "%" or a points unit after it. */
const PLACED_FIGURE = /(-?)(\$?)\{\{([a-z][a-z_]{0,39})\}\}(%?)(\s*(?:percentage points?|points?|pts|pp)\b)?/gu;
const CURRENCY_MARK = /[$€£¥]|\b[A-Z]{3}\b/u;

/** The words just before a placed figure, emphasis aside ("**down {{c}}**"). */
function leadBefore(markdown: string, offset: number): string {
  return markdown.slice(Math.max(0, offset - 72), offset).replace(/\*\*/gu, "");
}

/**
 * Whether a cell's sign is its direction: a pivot's change, a difference or
 * percent change worked out by DeriveResult or CalculateValues, or a field
 * named as a change. Only such a figure is contradicted by the direction word
 * before it; "lost {{customers}}" states a count, not a fall, and a column
 * named for one way ("Drop") carries a size whose label says which way.
 */
function directional(source: AnswerEvidence, column: TraceTableColumn, rowIndex: number): boolean {
  if (pivotChange(source, column, rowIndex)) return true;
  if (/\b(?:drops?|declines?|falls?|loss(?:es)?|decreases?|reductions?|shortfalls?|rises?|increases?|gains?|uplifts?)\b/iu.test(column.label)) return false;
  const recipe = source.provenance.calculations?.find((calculation) => calculation.column === column.key);
  if (recipe) return recipe.operator === "subtract" || recipe.operator === "percent_change" || /^(?:difference|percent_change)\(/u.test(recipe.formula);
  return /\b(?:change|delta|difference|growth|variance|movement)\b/iu.test(`${column.key.replace(/[._]/gu, " ")} ${column.label}`);
}

/** A financial year written "2025-26": its second half is the year after, not a figure. */
const FINANCIAL_YEAR = /(?<![\p{L}\d])(?:FY\s?)?((?:19|20)\d{2})\s*[-–/]\s*(\d{2})(?![\p{L}\d])/giu;
const yearAfter = (year: string, next: string): boolean => Number(next) === (Number(year) + 1) % 100;
const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const RANK_SIZE = `(\\d{1,3}|${COUNT_WORDS.slice(2).join("|")})`;
/** The size of a ranking's head: "the top three", "your 5 biggest". */
const RANKED_HEAD = new RegExp(`\\b(?:top|bottom)\\s+${RANK_SIZE}(?![\\p{L}\\d-]|\\s*%)|(?<![\\p{L}\\d$£€¥.,-])${RANK_SIZE}\\s+(?:biggest|largest|highest|lowest|smallest|best|worst|busiest|quietest|slowest|fastest|most|least)\\b`, "giu");
const rankSize = (size: string): number => /^\d+$/u.test(size) ? Number(size) : COUNT_WORDS.indexOf(size.toLowerCase());
/** A window or a year a follow-up asks about ("over the last 12 months", "August 2025"). */
const WINDOW_LENGTH = /(?<![\p{L}\d$£€¥.,])\d{1,4}(?:\s*-\s*|\s+)(?:day|week|month|quarter|year)s?\b/giu;
const ANY_YEAR = /(?<![\p{L}\d$£€¥.,-])(?:19|20)\d{2}(?![\p{L}\d])/gu;

/** Resolves every analytical figure from governed cells; the model supplies prose and references. */
/** The words around a rejected figure, so the model repairs every one in one pass instead of hunting for where "two" was. */
function figureInContext(text: string, token: string): string {
  const sentence = text.split(/(?<=[.!?])\s+|\n+/u).find((part) => part.includes(token))?.trim();
  if (!sentence) return token;
  const at = sentence.indexOf(token);
  const start = Math.max(0, at - 50);
  const end = Math.min(sentence.length, at + token.length + 40);
  const excerpt = `${start > 0 ? "…" : ""}${sentence.slice(start, end)}${end < sentence.length ? "…" : ""}`.replace(/\s+/gu, " ");
  return `${token} (in "${excerpt}")`;
}

export function composeAnswer(
  input: ComposeAnswerInput,
  evidence: ReadonlyMap<string, AnswerEvidence>,
  options: Readonly<{
    question: string;
    today: string;
    hadQueryFailures?: boolean;
    imessage?: boolean;
    /** Each source's data cutoff for this turn (the "Data freshness" anchors the model was given). */
    freshness?: readonly Readonly<{ dataThrough?: string | null }>[];
  }>,
): Readonly<{ ok: true; answer: ComposedAnswer }> | Readonly<{ ok: false; issues: readonly string[] }> {
  const parsed = composeAnswerSchema.safeParse({
    ...input,
    tables: Array.isArray(input.tables) ? input.tables.map((table) => ({ headers: null, sort: null, ...table })) : input.tables,
  });
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  const request = parsed.data;
  const issues: string[] = [];
  // A value the prose never places carries nothing to the owner, so it is
  // dropped rather than refused: refusing it cost a full model round trip on
  // about half of all composition failures (production, September 2026). A
  // table defined but never placed is still refused below, because the answer
  // would silently lose a table the model meant to show.
  const placed = new Set([...request.markdown.matchAll(/\{\{([a-z][a-z_]{0,39})\}\}/gu)].map((match) => match[1]!));
  const tableIds = new Set(request.tables.map((table) => table.id));
  const values = request.values.filter((value) => placed.has(value.id) || tableIds.has(value.id));
  const selected = new Set(request.citedResultIds);
  const slots = new Map<string, string>();
  const claims: NonNullable<TraceAnswerEvent["claims"]>[number][] = [];
  const currentYear = Number(/\b((?:19|20)\d{2})\b/u.exec(options.today)?.[1]) || null;
  let truncatedTable = false;
  /** Whether any table shows a blank calculated cell, the only time the note on blank calculations is worth its place. */
  let blankCalculation = false;
  /** Each table cut short: rows shown, and the full count when the result is complete. */
  const truncations: { shown: number; total: number | null }[] = [];
  /** Row counts a presented table proves, which prose may repeat ("the eight bikes above"). */
  const shownRowCounts: number[] = [];
  /** Each placed figure as it renders, and whether its sign is its direction. */
  const placedFigures = new Map<string, Readonly<{ text: string; directional: boolean }>>();
  // A ranking's head is what was asked for ("top 10", "best day", "biggest
  // expenses"): a partial list is expected, and its size is the owner's choice.
  const askedForTopN = /\b(?:top|best|worst|biggest|largest|smallest|highest|lowest|most|least|busiest|quietest|slowest|fastest)\b/iu.test(options.question);
  const put = (id: string, value: string) => {
    if (slots.has(id)) issues.push(`Duplicate placeholder ${id}.`);
    slots.set(id, value);
  };
  for (const value of values) {
    const source = evidence.get(value.resultId);
    const column = source?.columns.find((column) => column.key === value.columnKey);
    const row = source?.rows[value.rowIndex];
    if (!source || !column || !row || !(value.columnKey in row)) {
      issues.push(`Value ${value.id} references an unknown result, row or column.`);
      continue;
    }
    if (row[column.key] === null || row[column.key] === undefined) {
      issues.push(`Value ${value.id} points at an empty cell. Say in words that there is no figure (for example "no sales recorded") instead of citing it.`);
      continue;
    }
    selected.add(source.resultId);
    try {
      // A pivot's change is a percent or points whatever its row's format: never "$32.58".
      const change = pivotChange(source, column, value.rowIndex);
      const shownAs = source.rowFormats?.[value.rowIndex] ? { ...column, ...source.rowFormats[value.rowIndex] } : column;
      const text = change ? changeCell(row[column.key], change, false) : displayCell(row[column.key], shownAs, {
        format: value.format, decimals: value.decimals, grain: grainFor(source, column), currentYear,
      });
      put(value.id, text);
      if (change || ["number", "currency", "percent"].includes(shownAs.type)) placedFigures.set(value.id, { text, directional: directional(source, column, value.rowIndex) });
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
    // Rows may be ordered by one column before the limit; each cell still cites its own source row.
    const order = source.rows.map((_, index) => index);
    const sortColumn = table.sort ? source.columns.find((column) => column.key === table.sort!.columnKey) : undefined;
    if (table.sort && !sortColumn) { issues.push(`Table ${table.id} sorts by ${table.sort.columnKey}, which is not a column of ${source.resultId}.`); continue; }
    if (table.sort && sortColumn) {
      const direction = table.sort.direction === "asc" ? 1 : -1;
      const amount = ["number", "currency", "percent"].includes(sortColumn.type);
      const cell = (index: number) => source.rows[index]![sortColumn.key];
      const missing = (value: unknown) => value === null || value === undefined || value === "";
      order.sort((a, b) => {
        const left = cell(a);
        const right = cell(b);
        // Blank cells sort last whichever way the table runs.
        if (missing(left) || missing(right)) return missing(left) === missing(right) ? a - b : missing(left) ? 1 : -1;
        const compared = amount
          ? Number(String(left).replaceAll(",", "")) - Number(String(right).replaceAll(",", ""))
          : String(left).localeCompare(String(right), "en-AU");
        return compared === 0 || Number.isNaN(compared) ? a - b : compared * direction;
      });
    }
    const picked = order.slice(0, table.limit);
    const rows = picked.map((index) => source.rows[index]!);
    if (rows.length < source.rows.length || source.semantics?.completeness === "limited") {
      truncatedTable = true;
      truncations.push({ shown: rows.length, total: source.semantics?.completeness === "complete" ? source.rows.length : null });
    }
    // The rows on show count something only when they are the whole of a
    // complete result, or the head of a ranking the owner asked for: twelve
    // rows of thirty overdue jobs do not make "12 work orders are overdue".
    if (askedForTopN || (rows.length === source.rows.length && source.semantics?.completeness === "complete")) shownRowCounts.push(rows.length);
    // A period heading is resolved from the governed cell that names it, so a
    // model-written header can shorten a field label but never rename a period.
    const periods = periodHeaders(typed, source.semantics, currentYear);
    const headerScope = new Set([
      ...ownerStatedGroundingValues(options.question),
      ...[source.provenance.timeRange.label, (source as Readonly<{ queryYaml?: unknown }>).queryYaml].flatMap((scope) => typeof scope === "string" ? (scope.match(/\d+/gu) ?? []).map(Number) : []),
    ]);
    const headers = typed.map((column, index) => {
      const written = periods.has(column.key) ? undefined : table.headers?.[index]?.trim();
      const figures = written?.replace(HEADER_DATE, " ").replace(/\b(?:12|24)[ -]?h(?:ou)?r?\b/giu, " ")
        .replace(FINANCIAL_YEAR, (match, year: string, next: string) => yearAfter(year, next) ? " " : match).match(/\d[\d,.]*/gu) ?? [];
      // A header may repeat the owner's own words ("Price 12 months ago") or
      // the window the result covers ("Units (12 weeks)"); any other number in
      // a header is a figure the cells should carry.
      if (figures.some((figure) => !column.label.includes(figure) && !/^(?:19|20)\d{2}$/u.test(figure) && !headerScope.has(Number(figure.replaceAll(",", ""))))) {
        issues.push(`Header "${written}" states a figure its field does not carry. Headers name the column; figures belong in cells.`);
      }
      return written || periods.get(column.key) || column.label;
    });
    const numeric = (column: TraceTableColumn) => ["number", "currency", "percent"].includes(column.type);
    // A DeriveResult percent_change column reads signed in a table, as a pivot's change does.
    const calculations = source.provenance.calculations ?? [];
    const signedColumns = new Set(calculations.filter((calculation) => calculation.operator === "percent_change").map((calculation) => calculation.column));
    const calculatedColumns = new Set(calculations.map((calculation) => calculation.column));
    // Row formats set precision only when rows carry different units; a single-unit pivot (one with a change column
    // carries row formats anyway) shares each column's precision, so a column never mixes $7,137 with $685.00.
    const shownFormats = source.rowFormats ? picked.map((index) => source.rowFormats![index] ?? null) : [];
    const mixedRows = new Set(shownFormats.map((format) => format ? `${format.type}:${format.currency ?? ""}:${format.percentScale ?? ""}` : "")).size > 1;
    // A unit every row shares is each value column's own (a pivot's period columns may be typed "number").
    const sharedFormat = mixedRows ? null : shownFormats.find((format) => format) ?? null;
    const closesSection = (row: Readonly<Record<string, unknown>>) => typed[0]!.type === "string" && STATEMENT_TOTAL.test(String(row[typed[0]!.key] ?? "").trim());
    const statement = rows.filter(closesSection).length >= 2;
    const magnitudes = typed.map((column) => columnMagnitude(rows, column.key));
    const precisions = typed.map((column) => columnDecimals(rows, sharedFormat && numeric(column) && column.key !== PIVOT_CHANGE_COLUMN_KEY ? { ...column, ...sharedFormat } : column));
    const grains = typed.map((column) => grainFor(source, column, table.limit));
    try {
      // One row of several measures reads sideways ("Sales revenue | Cost of
      // sales | Gross profit | ..."). Stood on its end it is a statement: one
      // line per measure, under the period it covers. Same cells, same claims.
      if (rows.length === 1 && typed.length >= 3) {
        const row = rows[0]!;
        const only = picked[0]!;
        const cells = typed.map((column, index) => {
          const text = displayCell(row[column.key], source.rowFormats?.[only] && column.type !== "string" ? { ...column, ...source.rowFormats[only] } : column, { grain: grains[index]!, currentYear });
          claims.push({ statement: `${column.label}: ${text}`, assertion: "value", refs: [{ resultId: source.resultId, rowIndex: only, columnKey: column.key }] });
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
            return `| ${total ? `**${escapeCell(line.label)}**` : escapeCell(line.label)} | ${total && line.cell !== EMPTY_CELL ? `**${line.cell}**` : line.cell} |`;
          }),
        ].join("\n"));
        continue;
      }
      put(table.id, [
        `| ${headers.map(escapeCell).join(" | ")} |`,
        `| ${typed.map((column) => numeric(column) ? "---:" : "---").join(" | ")} |`,
        ...rows.map((row, position) => {
          const rowIndex = picked[position]!;
          // A metric-per-row pivot is read across, so its precision is set by the row.
          const rowFormat = source.rowFormats?.[rowIndex];
          const across = rowFormat && mixedRows ? Math.max(0, ...typed.filter((column) => numeric(column) && !pivotChange(source, column, rowIndex)).map((column) => Math.abs(Number(row[column.key])) || 0)) : null;
          // A statement's subtotal and total lines carry the accountant's emphasis;
          // the renderer rules them off from the detail above.
          const total = statement && closesSection(row);
          return `| ${typed.map((column, index) => {
            const change = pivotChange(source, column, rowIndex);
            const shown = change ? changeCell(row[column.key], change, true) : displayCell(row[column.key], rowFormat && column.type !== "string" ? { ...column, ...rowFormat } : column, {
              magnitude: across ?? magnitudes[index]!, grain: grains[index]!, currentYear,
              // Mixed-unit pivot rows keep each cell's own precision; a plain column shares one.
              ...((rowFormat && mixedRows) || precisions[index] === null ? {} : { decimals: precisions[index]!, fixed: true }),
            });
            const text = !change && signedColumns.has(column.key) && /^\d/u.test(shown) && /[1-9]/u.test(shown) ? `+${shown}` : shown;
            if (text === EMPTY_CELL && calculatedColumns.has(column.key)) blankCalculation = true;
            claims.push({ statement: `${column.label}: ${text}`, assertion: "value", refs: [{ resultId: source.resultId, rowIndex, columnKey: column.key }] });
            return total && text !== EMPTY_CELL ? `**${text}**` : text;
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
  for (const id of slots.keys()) if (!placeholders.includes(id)) issues.push(`Table {{${id}}} was defined but not placed: put {{${id}}} alone on its own line where the table belongs, or remove it from tables.`);
  // What is typed around a figure must agree with it. A mark the figure
  // renders itself is absorbed when the answer is resolved; one it does not
  // carry, or a direction word its sign contradicts, would misstate it to the
  // owner ("Sales fell 8.2%" on a rise, "$120" for 120 units).
  for (const match of request.markdown.matchAll(PLACED_FIGURE)) {
    const [, minus, dollar, id, percent] = match;
    const figure = placedFigures.get(id!);
    if (!figure) continue;
    const placeholder = `{{${id}}}`;
    const lead = leadBefore(request.markdown, match.index);
    const negative = figure.text.startsWith("-");
    if (figure.directional && !negative && /[1-9]/u.test(figure.text) && FALLING_WORDS.test(lead)) {
      issues.push(`${placeholder} is a rise (it renders "${figure.text}"), but the word before it says it fell. Say it rose ("up ${placeholder}"), or bind the figure that fell.`);
    }
    if (figure.directional && negative && RISING_WORDS.test(lead)) {
      issues.push(`${placeholder} is a fall (it renders "${figure.text}"), but the word before it says it rose. Say it fell ("down ${placeholder}" drops the minus), or bind the figure that rose.`);
    }
    // A hyphen that joins words or a range ("year-{{c}}", "{{low}}-{{high}}") is not a minus sign.
    if (minus && !negative && !/[\p{L}\p{N}\}%)]$/u.test(request.markdown.slice(0, match.index))) {
      issues.push(`The minus typed before ${placeholder} would show "-${figure.text}", but the figure is not negative. Remove it: a placeholder renders its own sign.`);
    }
    if (dollar && !CURRENCY_MARK.test(figure.text)) issues.push(`The "$" typed before ${placeholder} would show "$${figure.text}", but the figure is not money. Remove it, or bind a currency field.`);
    if (percent && !figure.text.endsWith("%")) issues.push(`The "%" typed after ${placeholder} would show "${figure.text}%", but the figure is not a percentage. Remove it, or bind a percentage field.`);
  }

  // Values from result cells must travel through a reference, never borrow
  // support from an unrelated equal number somewhere in the evidence pool.
  const plain = [request.markdown.replace(/\{\{[^}]+\}\}(?::[0-5]\d\b)?/gu, ""), ...request.limitations].join("\n");
  const dateLabels = [options.today, ...sources.flatMap((source) => [source.provenance.timeRange.label, source.provenance.timeRange.start, source.provenance.timeRange.end])];
  // A derived table (a ranking joined to last year's prices) carries the
  // windows it was built from; their years are in evidence as much as its own.
  const inputWindows = sources.flatMap((source) => source.semantics?.inputWindows ?? []);
  const allowed = [...ownerStatedGroundingValues(options.question), ...[...dateLabels, ...inputWindows].flatMap((label) => [...label.matchAll(/\b(?:19|20)\d{2}\b/gu)].map((match) => Number(match[0])))];
  const labels = [...dateLabels, ...sources.flatMap((source) => source.rows.flatMap((row) => source.columns.filter((column) => ["string", "date", "datetime"].includes(column.type)).map((column) => String(row[column.key] ?? ""))))];
  // The spans this answer's evidence covers: explicit query windows, the run of
  // dates each cited result actually returned, and today.
  const todayIso = /\b(\d{4}-\d{2}-\d{2})\b/u.exec(options.today)?.[1];
  const spans: (readonly [string, string])[] = [
    ...(todayIso ? [[todayIso, todayIso] as const] : []),
    // The prompt tells the model to name where a source's data ends and what
    // that leaves uncovered ("sales run through 19 September, so Sunday 20
    // September is missing"): the cutoff and the days from it to today are
    // stated facts of this turn, not figures to bind.
    ...(options.freshness ?? []).flatMap((entry) => {
      const through = entry.dataThrough?.slice(0, 10);
      if (!through || !/^\d{4}-\d{2}-\d{2}$/u.test(through)) return [];
      return [[through, todayIso && todayIso > through ? todayIso : through] as const];
    }),
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
  const labelText = labels.join("\n").toLowerCase();
  const shownMost = Math.max(0, ...shownRowCounts);
  /**
   * The figures a stretch of text states that nothing in scope supports, and
   * any day it misnames. A follow-up is the owner's next question: the year,
   * window or ranking size it asks about is a request, not a finding.
   */
  const unbound = (text: string, followUp = false): Readonly<{ figures: readonly string[]; issues: readonly string[] }> => {
    const scoped = stripScopedCalendarDates(text, spans);
    const prose = scoped.text
      .replace(/(?<![\p{L}\d$£€¥.,-])(\d{1,4})(?:\s*-\s*|\s+)(?:day|week|month|year)s?\b/giu, (match, length: string) => fieldNumbers.has(length) ? " the window " : match)
      // "one soft spot", "one-off": never "twenty-one" or "one hundred".
      .replace(/(?<![\p{L}-])one(?![\p{L}]|-(?:hundred|thousand|million|billion|and)\b|\s+(?:hundred|thousand|million|billion)\b)/giu, " ")
      // "FY 2025-26" names one financial year; its "26" is the year after, not a figure.
      .replace(FINANCIAL_YEAR, (match, year: string, next: string) => yearAfter(year, next) && (followUp || allowed.includes(Number(year))) ? " the year " : match)
      // "The top three jobs" of a ranking the owner asked for points into the
      // table beside it, and counts nothing the table does not show.
      .replace(RANKED_HEAD, (match, top: string | undefined, most: string | undefined) => followUp || (askedForTopN && rankSize(top ?? most!) <= shownMost) ? " the top " : match)
      // A model or part code ("XG-1270", "M7100", "10-33t") is part of a name when
      // a cited label carries it, even where the answer shortens the rest of the
      // name: "the SRAM Force XG-1270 cassette" is not the figure 1,270. A bare
      // number is never excused this way.
      .replace(/(?<![\p{L}\d])(?=[\p{L}\d./-]*\p{L})(?=[\p{L}\d./-]*\d)[\p{L}\d]+(?:[./-][\p{L}\d]+)*(?![\p{L}\d])/gu, (code) => labelText.includes(code.toLowerCase()) ? " code " : code);
    const asked = followUp ? prose.replace(WINDOW_LENGTH, " the window ").replace(ANY_YEAR, " the year ") : prose;
    return { figures: findUngroundedNumbersWithEvidence(asked, [...allowed, ...shownRowCounts], labels), issues: scoped.issues };
  };
  const checked = unbound(plain);
  issues.push(...checked.issues);
  if (checked.figures.length) {
    const written = [request.markdown, ...request.limitations].join("\n");
    issues.push(`Unbound figures: ${checked.figures.slice(0, 12).map((token) => figureInContext(written, token)).join("; ")}. Bind each with a {{value_name}} or {{table_name}} reference (work out a new figure first: CalculateValues between two cells, DeriveResult across rows or results), or rewrite that sentence without it. Never swap in another count, number word or approximation ("almost half", "zero", "three"): each is checked the same way.`);
  }
  if (/\{\{|\}\}/u.test(plain)) issues.push("Malformed answer placeholder.");
  if (request.outcome === "answer" && (!sources.length || claims.length === 0)) issues.push("An analytical answer requires cited evidence and at least one value or table reference.");
  if (request.outcome === "no_data" && (!sources.length || sources.some((source) => source.rows.length > 0))) issues.push("No data requires an executed empty query for the requested scope.");
  if (request.outcome === "explanation" && (values.length || request.tables.length)) issues.push("Use outcome answer when presenting data values.");
  if (issues.length) return { ok: false, issues };

  // A placeholder renders with its own sign, currency symbol and percent sign;
  // a model that also types one around it would show "$$9,126" and "26.8%%",
  // and one that writes the direction in words would show "down -19.9%".
  // A points figure followed by the model's own unit ("{{m}} percentage points") keeps the model's words.
  const resolved = request.markdown.replace(PLACED_FIGURE, (_match, minus: string, dollar: string, id: string, percent: string, unit: string | undefined, offset: number, whole: string) => {
    const slot = slots.get(id)!;
    const lead = leadBefore(whole, offset);
    const saidInWords = slot.startsWith("-") && (FALLING_WORDS.test(lead) || FALLING_BY.test(lead));
    const signed = saidInWords ? slot.slice(1) : slot;
    const value = unit && signed.endsWith(" pts") ? signed.slice(0, -" pts".length) : signed;
    // A minus typed before a negative figure is its own sign said twice, even where the words say it too ("down -{{c}}").
    return `${minus && slot.startsWith("-") ? "" : minus}${dollar && CURRENCY_MARK.test(value) ? "" : dollar}${value}${percent && value.endsWith("%") ? "" : percent}${unit ?? ""}`;
  });
  const extracted = extractOmniFollowUps(resolved);
  // A closing paragraph set wholly in italics is a caveat written as an aside;
  // it belongs with the other notes, in the footnote's type, not in the body.
  const aside = /\n\n[*_]([^*_\n][^\n]*[^*_\n])[*_]\s*$/u.exec(extracted.text);
  const body = withoutEmDashes(calmBold(aside ? extracted.text.slice(0, aside.index) : extracted.text));
  // The note on blank calculated cells is kept only when one is on show and the answer has not already explained its blanks.
  const blanksExplained = request.limitations.some((note) => /\bblank\b/iu.test(note));
  const qualifications = sources.flatMap((source) => source.semantics?.qualifications ?? [])
    .filter((note) => note !== BLANK_CALCULATION_NOTE || (blankCalculation && !blanksExplained));
  const limited = sources.some((source) => source.semantics?.completeness !== "complete");
  const reused = sources.some((source) => source.priorTurn);
  const failures = Boolean(options.hadQueryFailures) && request.outcome === "answer";
  const qualified = request.limitations.length > 0 || qualifications.length > 0 || limited || reused || failures;
  // A list cut short is worth saying once, unless a ranking's head is what was asked for.
  // One cut table says exactly how much of it is shown.
  const [only] = truncations.length === 1 ? truncations : [];
  const truncationNote = !only ? "Tables show the first rows, not every row."
    : only.total !== null ? `The table shows ${only.shown} of ${only.total} rows.`
      : `The table shows the first ${only.shown} rows, not every row.`;
  const notes = [
    ...(aside ? [aside[1]!] : []),
    ...request.limitations,
    ...qualifications,
    ...(truncatedTable && !askedForTopN && !request.limitations.some((note) => /\b(?:top|first|largest|highest|biggest)\b|\bnot (?:a |the )?(?:complete|full)\b|\bcapped\b|\bslice\b|\blimited to\b/iu.test(note))
      ? [truncationNote] : []),
    ...(reused ? ["Uses earlier results from this conversation; the figures have not been refreshed."] : []),
    ...(failures ? ["Some queries failed along the way; the figures shown come from the ones that succeeded."] : []),
  ];
  const note = footnote(body, notes);
  const text = note ? `${body}\n\n${withoutEmDashes(note)}` : body;
  if (text.length > 120_000 || Buffer.byteLength(JSON.stringify({ text, claims })) > 1_200_000) return { ok: false, issues: ["The composed answer exceeds the artifact size limit. Select fewer rows or columns; the answer will not be silently truncated."] };
  const state: ComposedAnswer["state"] = request.outcome === "clarification" ? "Clarification"
    : request.outcome === "unavailable" ? "Unavailable"
      : request.outcome === "explanation" ? "Exploratory"
        : qualified ? "Qualified"
          : request.outcome === "no_data" ? "No data" : "Verified";
  // A suggested question is held to the body's figures too ("Why did Bikes
  // drop 23%?" asserts a fall), but it is not worth a model round trip: one
  // that states a figure nothing supports, or leaves a placeholder raw, is
  // dropped. Links in the body were already checked as prose.
  const suggested = request.followUps.filter((question) => {
    if (/\{\{|\}\}/u.test(question)) return false;
    const asked = unbound(question, true);
    return !asked.figures.length && !asked.issues.length;
  });
  return { ok: true, answer: {
    text: sanitizeAnswerText(text, 120_000), state, claims,
    presentedResultIds: [...selected],
    followUps: options.imessage ? [] : [...new Set([...suggested, ...extracted.followUps])].slice(0, 3).map((text) => sanitizeTraceText(text, 160)),
  } };
}

export const COMPOSE_ANSWER_INSTRUCTIONS = `# Composing the final answer

Use ComposeAnswer to deliver the answer. Its accepted content is exactly what the owner receives.
Write the answer in markdown, replacing EVERY analytical figure with a named placeholder like {{sales}}. Define it in values using the resultId, zero-based rowIndex and exact columnKey returned by a tool. Do not type the value yourself.
A placeholder renders complete: its own minus sign, currency symbol, thousands separators and percent sign. Write "{{sales}}" and "up {{change}}", never "\${{sales}}" or "{{change}}%". A mark or a direction word the figure contradicts is refused: "\${{units}}" on a count, "{{ratio}}%" on a plain number, "-{{change}}" or "fell {{change}}" on a rise, "up {{change}}" on a fall. format auto shows whole dollars from $1,000 up, cents below that, and one decimal on a percentage; format compact rounds for reading ($19.4k, $1.2M) and is the right choice for most amounts inside a sentence, because the table beside it carries the exact figure. Leave decimals null unless a specific precision matters. A date cell renders as the period it names (a month bucket as "Aug 2026", a week as "6 Jul", a day as "Sat 12 Sep").
Calendar dates are not figures: type a date or a day range directly, digits and all ("Sunday 13 September", "1–19 September"), whenever it falls inside the window your cited results cover or is today. That is how you name a day that has no row of its own, such as a day the store was closed. Never spell a date out in words ("the nineteenth") to avoid digits. Give the weekday only when you are sure of it; a mismatch is rejected. The article "one", a window length that comes from a field you queried ("no sale in 90 days"), and the row count of a table that shows its whole result or the head of a ranking the owner asked for ("these eight bikes", "the top three") are likewise fine to type; every other count or amount is a placeholder.
For tables, put {{weekly_table}} in its own paragraph, alone on a line with a blank line before and after, and define it in tables with resultId, columnKeys, headers and limit. headers is one short, plain header per column key, in the same order ("Product", "Revenue", "Units", "Week"): the governed field labels are long and technical, so always supply them. A header names the column and never carries a figure; period columns of a pivot keep their own period names whatever you pass. Choose only the columnKeys that earn a place and set limit to the rows worth reading; sort orders the rows by one column first ({columnKey: "change", direction: "asc"} puts the biggest falls first), and null keeps the result's order. Do not wrap the placeholder in a Markdown table or add your own header or separator row: the server supplies the complete table. Never hand-copy or transpose a numerical table. ComposePivotTable and DeriveResult prepare new shapes before composition: a table that compares periods is presented with its change, from ComposePivotTable with change true (metrics down) or a DeriveResult percent_change column beside the two periods (named entities). The server signs a pivot's change and a percent_change column in a table, and writes a rate's change in points; cited in a sentence, a change reads with the direction in your words ("up {{takings_change}}" renders "up 12.4%", "down {{margin_change}}" renders "down 3.1 pts"). Arithmetic is never typed: CalculateValues does exact arithmetic between two result cells, including period-on-period change across two rows of a comparison query, and DeriveResult does anything across rows or results.
Never type an em dash; use a comma, a colon or a full stop.
Use citedResultIds for every result that supports the conclusion.
limitations is the answer's single footnote, shown once in small type beneath it. Give it zero to two short items, each under twenty words, and only what would change how the owner reads a figure: a proxy, a partial period, a missing source, a known data gap. Never repeat there what the body already says, and never list routine basis (currency, timezone, "completed non-voided sales") that would not mislead anyone. The harness adds its own note when a table is cut short. limitations cannot bind a figure, so never type a count or amount there. The harness decides the answer state; you cannot promote an answer to Verified.
outcome answer presents query evidence; explanation answers a definition question without figures; clarification asks the one blocking question; no_data cites the executed empty result; unavailable names the missing capability. Do not use explanation to avoid retrieving business figures.
followUps are questions, not findings: the period, window or ranking size one asks about is fine, but one that states any other figure ("Why did Bikes drop 23%?") is dropped.
If composition reports issues, repair the references or run the necessary query or derivation, then compose again. After acceptance, finish with a brief hand-over; do not rewrite the accepted answer.`;
