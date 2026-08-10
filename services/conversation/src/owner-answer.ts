/**
 * Owner-facing answer craft for Albert.
 *
 * Small-business owners read the final prose, not the SQL trail. These helpers
 * turn provenance, result tables, and validation noise into clear Australian
 * English that names the number, the thing, and the period, without leaking
 * governance jargon.
 */

import { sanitizeTraceText, type TraceProvenance } from "../../../packages/shared/src/index.js";
import type { GovernedResult } from "../../../packages/agent/src/semantic-tools.js";
import { governedTerm, governedTermList } from "./live-terms.js";

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Calendar day in Australian English: "7 August 2026". */
export function formatOwnerDay(value: string): string {
  const trimmed = value.trim();
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})/u.exec(trimmed);
  if (dayOnly) {
    const year = Number(dayOnly[1]);
    const month = Number(dayOnly[2]);
    const day = Number(dayOnly[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${day} ${MONTHS_LONG[month - 1]} ${year}`;
    }
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function parseIsoDateParts(value: string): Readonly<{ year: number; month: number; day: number }> | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function addDays(parts: Readonly<{ year: number; month: number; day: number }>, delta: number): Readonly<{ year: number; month: number; day: number }> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + delta));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function formatDayMonthYear(parts: Readonly<{ year: number; month: number; day: number }>): string {
  return `${parts.day} ${MONTHS_LONG[parts.month - 1]} ${parts.year}`;
}

/**
 * Turn compiler / SQL period labels into something a shop owner would say.
 * Half-open ISO ranges (`2026-08-01 to 2026-09-01`) become "August 2026".
 */
export function humanisePeriodLabel(
  timeRange: TraceProvenance["timeRange"],
): string {
  const raw = timeRange.label.trim();
  if (!raw || raw === "No governed query executed") return "";
  // SQL-first statements do not carry a compiler period label. Prefer the
  // answer/table's own months over a vague "all available history" disclosure.
  if (raw === "Defined by the statement") return "";

  const isoRange = /^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/u.exec(raw);
  if (isoRange) {
    const start = parseIsoDateParts(isoRange[1]!);
    const endExclusive = parseIsoDateParts(isoRange[2]!);
    if (start && endExclusive) {
      // Calendar month: 1st → 1st of next month.
      if (
        start.day === 1
        && endExclusive.day === 1
        && (endExclusive.year > start.year
          || (endExclusive.year === start.year && endExclusive.month === start.month + 1)
          || (endExclusive.year === start.year + 1 && start.month === 12 && endExclusive.month === 1))
      ) {
        return `${MONTHS_LONG[start.month - 1]} ${start.year}`;
      }
      const endInclusive = addDays(endExclusive, -1);
      if (
        endInclusive.year > start.year
        || endInclusive.month > start.month
        || endInclusive.day >= start.day
      ) {
        if (start.year === endInclusive.year && start.month === endInclusive.month) {
          if (start.day === endInclusive.day) return formatDayMonthYear(start);
          return `${start.day}–${endInclusive.day} ${MONTHS_LONG[start.month - 1]} ${start.year}`;
        }
        if (start.year === endInclusive.year) {
          return `${start.day} ${MONTHS_LONG[start.month - 1]} – ${endInclusive.day} ${MONTHS_LONG[endInclusive.month - 1]} ${start.year}`;
        }
        return `${formatDayMonthYear(start)} – ${formatDayMonthYear(endInclusive)}`;
      }
    }
  }

  // Already human labels from the semantic compiler ("Last week", "month to date").
  if (!/\d{4}-\d{2}-\d{2}/u.test(raw)) return raw;

  const start = parseIsoDateParts(timeRange.start);
  const end = parseIsoDateParts(timeRange.end);
  if (start && end) {
    return humanisePeriodLabel({
      ...timeRange,
      label: `${timeRange.start.slice(0, 10)} to ${timeRange.end.slice(0, 10)}`,
    });
  }
  return raw;
}

/**
 * Server-owned sentence naming the period and source. Appended when the model
 * forgets to say when the figures apply.
 */
export function periodDisclosure(provenance: TraceProvenance): string {
  const label = humanisePeriodLabel(provenance.timeRange);
  const sources = [...new Set(provenance.sources.map((source) => source.label.trim()).filter(Boolean))];
  const through = provenance.sources
    .map((source) => source.dataThrough)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1);
  const throughHuman = through ? formatOwnerDay(through) : "";
  const sourceClause = sources.length ? ` from ${sources.join(" and ")}` : "";
  const throughClause = throughHuman ? ` (updated through ${throughHuman})` : "";
  if (!label) {
    // SQL-first periods are stated in the answer/table; still name freshness.
    if (!sources.length && !throughHuman) return "";
    return `Figures${sourceClause}${throughClause}.`.replace("Figures (", "Figures updated (");
  }
  return `These figures cover ${label}${sourceClause}${throughClause}.`;
}

/** True when the answer already states the period we would disclose. */
export function answerAlreadyStatesPeriod(
  answerText: string,
  provenance: TraceProvenance,
): boolean {
  const disclosure = periodDisclosure(provenance);
  if (!disclosure) return true;
  if (answerText.includes(disclosure)) return true;
  const rawLabel = provenance.timeRange.label.trim();
  if (rawLabel && answerText.includes(rawLabel)) return true;
  const human = humanisePeriodLabel(provenance.timeRange);
  if (human && answerText.toLowerCase().includes(human.toLowerCase())) return true;
  return false;
}

function formatResultCell(
  value: unknown,
  columnType: GovernedResult["columns"][number]["type"] | undefined,
): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (columnType === "currency") {
      return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(value);
    }
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  }
  const raw = String(value).trim();
  if (!raw) return "n/a";
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/u.exec(raw);
  if (isoDate) {
    const year = Number(isoDate[1]);
    const month = Number(isoDate[2]);
    const day = Number(isoDate[3]);
    if (month >= 1 && month <= 12 && day === 1) {
      return `${MONTHS_LONG[month - 1]} ${year}`;
    }
    const human = formatOwnerDay(raw);
    if (human) return human;
  }
  if (columnType === "currency" || /^-?\d+(?:\.\d+)?$/u.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && (columnType === "currency" || Math.abs(numeric) >= 1 || columnType === "number")) {
      if (columnType === "currency") {
        return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(numeric);
      }
      return Number.isInteger(numeric) ? String(numeric) : String(Number(numeric.toFixed(2)));
    }
  }
  return raw;
}

/** True when the prose already carries a markdown pipe table. */
export function answerContainsMarkdownTable(text: string): boolean {
  const lines = text.split(/\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index]!;
    const rule = lines[index + 1]!;
    if (!header.includes("|")) continue;
    if ((header.match(/\|/gu) ?? []).length < 2) continue;
    if (/^\|?\s*:?-{3,}/u.test(rule)) return true;
  }
  return false;
}

/** Multi-row series / rankings, or a wide single row, must ship as a table. */
export function evidenceWantsMarkdownTable(result: GovernedResult): boolean {
  if (result.rows.length >= 2) return true;
  return result.rows.length === 1 && result.columns.length >= 3;
}

function chooseOwnerTableColumns(
  result: GovernedResult,
): GovernedResult["columns"] {
  if (result.columns.length <= 5) return result.columns;
  const constantStringKeys = new Set(
    result.columns
      .filter((column) => column.type === "string")
      .filter((column) => {
        const values = new Set(result.rows.map((row) => String(row[column.key] ?? "").trim()));
        return values.size <= 1;
      })
      .map((column) => column.key),
  );
  const preferred = result.columns.filter((column) => {
    if (constantStringKeys.has(column.key) && /employee|customer|name/iu.test(column.key)) {
      return false;
    }
    return true;
  });
  const timeLike = preferred.filter((column) => /month|week|day|date|period|bucket/iu.test(`${column.key} ${column.label}`));
  const moneyLike = preferred.filter((column) => looksLikeMoneyColumn(column) || looksLikeCountColumn(column));
  const picked = [...timeLike, ...moneyLike, ...preferred.filter((column) => !timeLike.includes(column) && !moneyLike.includes(column))];
  const unique: GovernedResult["columns"][number][] = [];
  for (const column of picked) {
    if (unique.some((entry) => entry.key === column.key)) continue;
    unique.push(column);
    if (unique.length >= 5) break;
  }
  return unique.length > 0 ? unique : result.columns.slice(0, 5);
}

function looksLikeCountColumn(column: GovernedResult["columns"][number]): boolean {
  return /count|units|qty|quantity|sold|bookings|transactions|rows?/iu.test(`${column.key} ${column.label}`);
}

function looksLikeMoneyColumn(column: GovernedResult["columns"][number]): boolean {
  return column.type === "currency"
    || /sales|revenue|profit|margin|amount|total|spend|cost|price|takings|gst/iu.test(`${column.key} ${column.label}`);
}

function friendlyColumnPhrase(column: GovernedResult["columns"][number]): string {
  const label = column.label.trim() || governedTerm(column.key);
  return label.replace(/\bGst\b/gu, "GST");
}

function isBareRowCountResult(result: GovernedResult): boolean {
  return result.columns.length === 1
    && /^(row_)?count$/iu.test(result.columns[0]?.key ?? "");
}

/** Source-exploration probes (resultId source:…) are not owner answers. */
function isExplorationProbe(result: GovernedResult): boolean {
  return result.resultId.startsWith("source:");
}

function hasLabelColumn(result: GovernedResult): boolean {
  return result.columns.some((column) =>
    column.type === "string"
    || /name|description|item|product|employee|customer|shop|category|label/iu.test(`${column.key} ${column.label}`));
}

/**
 * Prefer a result that can actually answer the owner (named rows / multi-column)
 * over a trailing bare row_count from a dead-end exploration.
 */
export function pickAnswerResult(
  results: readonly GovernedResult[],
): GovernedResult | undefined {
  const usable = results.filter((result) => result.rows.length > 0);
  if (usable.length === 0) return undefined;
  const labelled = usable.filter(hasLabelColumn);
  if (labelled.length > 0) return labelled.at(-1);
  const substantive = usable.filter((result) =>
    !isBareRowCountResult(result) && !isExplorationProbe(result));
  if (substantive.length > 0) return substantive.at(-1);
  // Never promote a bare source-exploration row_count into the owner answer
  // (regression: uncategorised products → "The total is 17138").
  const nonExploration = usable.filter((result) => !isExplorationProbe(result));
  if (nonExploration.length > 0) return nonExploration.at(-1);
  return undefined;
}

/**
 * Last-resort answer from query results when the model draft was gutted or
 * never stated the figures. Written for a shop owner, not as a dump of labels.
 */
export function synthesizeAnswerFromResults(results: readonly GovernedResult[]): string {
  const result = pickAnswerResult(results);
  if (!result) {
    return "Sorry, I couldn't turn the lookups I ran into a product or sales answer. Ask again and I'll list the matching rows.";
  }
  const columns = result.columns;
  if (columns.length === 0) {
    return `I found ${result.rows.length} row${result.rows.length === 1 ? "" : "s"} in the table above.`;
  }

  if (result.rows.length === 1 && columns.length === 1) {
    const column = columns[0]!;
    const rendered = formatResultCell(result.rows[0]![column.key], column.type);
    // A lone row_count is only safe when it came from intentional SQL, not
    // exploration probes (those are filtered by pickAnswerResult).
    if (looksLikeCountColumn(column) && rendered !== "n/a") {
      return `The total is ${rendered}.`;
    }
    if (looksLikeMoneyColumn(column)) {
      return `${friendlyColumnPhrase(column)} came to ${rendered}.`;
    }
    return `${friendlyColumnPhrase(column)}: ${rendered}.`;
  }

  if (result.rows.length === 1 && columns.length <= 6) {
    const row = result.rows[0]!;
    const labelColumn = columns.find((column) => column.type === "string")
      ?? columns.find((column) => /name|label|item|product|employee|customer|shop|category/iu.test(column.key));
    const metricColumns = columns.filter((column) => column.key !== labelColumn?.key);
    // Two or more metrics: table-first so the owner can scan the figures.
    if (metricColumns.length >= 2) {
      return formatResultsAsMarkdownTable(result);
    }
    if (labelColumn && metricColumns.length === 1) {
      const subject = formatResultCell(row[labelColumn.key], labelColumn.type);
      const column = metricColumns[0]!;
      const rendered = formatResultCell(row[column.key], column.type);
      if (looksLikeCountColumn(column)) {
        return `${subject}: ${rendered} ${friendlyColumnPhrase(column).toLowerCase()}.`;
      }
      if (looksLikeMoneyColumn(column)) {
        return `${subject}: ${friendlyColumnPhrase(column).toLowerCase()} ${rendered}.`;
      }
      return `${subject}: ${friendlyColumnPhrase(column).toLowerCase()} ${rendered}.`;
    }
    const parts = columns.map((column) => {
      const rendered = formatResultCell(row[column.key], column.type);
      return `${friendlyColumnPhrase(column)} ${rendered}`;
    });
    return parts.join(". ") + ".";
  }

  return formatResultsAsMarkdownTable(result);
}

export type FormatResultsAsMarkdownTableOptions = Readonly<{
  /** Include a short prose lead-in before the pipe table. Default true. */
  includeIntro?: boolean;
  /** Max data rows in the answer table. Default 36 (covers 24–36 month series). */
  maxRows?: number;
}>;

/** Owner-facing markdown table for multi-row / multi-metric result sets. */
export function formatResultsAsMarkdownTable(
  result: GovernedResult,
  options: FormatResultsAsMarkdownTableOptions = {},
): string {
  const includeIntro = options.includeIntro ?? true;
  const maxRows = options.maxRows ?? 36;
  const columns = chooseOwnerTableColumns(result);
  if (columns.length === 0 || result.rows.length === 0) {
    return "Sorry, I couldn't turn the lookups I ran into a product or sales answer.";
  }
  const labelColumn = columns.find((column) => column.type === "string")
    ?? columns.find((column) => /name|label|item|product|employee|customer|shop|category|month|week|date/iu.test(column.key))
    ?? columns[0]!;
  const leader = formatResultCell(result.rows[0]![labelColumn.key], labelColumn.type);
  const series = /month|week|day|date|period/iu.test(`${labelColumn.key} ${labelColumn.label}`);
  const intro = result.rows.length === 1
    ? "Here is what came back:"
    : series
      ? "Here are the figures:"
      : `Here are the top results, led by ${leader}:`;
  const header = `| ${columns.map((column) => friendlyColumnPhrase(column)).join(" | ")} |`;
  const rule = `| ${columns.map(() => "---").join(" | ")} |`;
  const shown = result.rows.slice(0, maxRows);
  const body = shown.map((row) => {
    const cells = columns.map((column) => formatResultCell(row[column.key], column.type));
    return `| ${cells.join(" | ")} |`;
  });
  const more = result.rows.length > shown.length
    ? `\n\n…and ${result.rows.length - shown.length} more rows in the query table above.`
    : "";
  const table = `${header}\n${rule}\n${body.join("\n")}${more}`;
  return includeIntro ? `${intro}\n\n${table}` : table;
}

/**
 * Server-owned presentation rule: when the evidence is tabular, the owner
 * answer must include a markdown table. Models often cite a min/max and skip
 * the rows; this appends the table from the governed result.
 */
export function ensureAnswerIncludesTable(
  answerText: string,
  results: readonly GovernedResult[],
): string {
  const usable = results.filter((result) => result.rows.length > 0);
  // In a multi-section review there is no universally correct "last table".
  // Appending one arbitrary section after a complete cross-result narrative
  // misrepresents its importance. The model may still author a useful summary
  // table; the server only forces tabular detail for a single-result answer.
  if (usable.length > 1) return answerText;
  const focus = pickAnswerResult(usable);
  if (!focus || !evidenceWantsMarkdownTable(focus)) return answerText;
  if (answerContainsMarkdownTable(answerText)) return answerText;
  const table = formatResultsAsMarkdownTable(focus, { includeIntro: false, maxRows: 36 });
  const lead = answerText.trim();
  if (!lead) return formatResultsAsMarkdownTable(focus, { maxRows: 36 });
  return `${lead}\n\n${table}`;
}

/**
 * Split prose into sentences without breaking `$800.00` or `commerce.units_sold`.
 */
function splitProseSentences(block: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < block.length; index += 1) {
    const char = block[index]!;
    current += char;
    if (char !== "." && char !== "!" && char !== "?") continue;
    const prev = block[index - 1] ?? "";
    const next = block[index + 1] ?? "";
    if (char === "." && /\d/u.test(prev) && /\d/u.test(next)) continue;
    if (char === "." && /[a-z0-9_]/iu.test(prev) && /[a-z_]/iu.test(next)) continue;
    if (next && !/\s/u.test(next) && next !== "") continue;
    parts.push(current.trim());
    current = "";
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length > 0 ? parts : [block];
}

/**
 * Drop sentences that only talk about the platform (certification, attestation,
 * exploratory status). Keep sentences that still carry business facts.
 */
export function stripOwnerFacingJargon(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  const jargonOnly =
    /\b(governed(?:\s+\w+){0,4}|attest(?:ation|ed| against)?|certif(?:y|ied|ication)|exploratory(?:\s+status)?|semantic bundle|query-?ready data|commerce\.[a-z0-9_.]+|finance\.[a-z0-9_.]+|inventory\.[a-z0-9_.]+)\b/iu;

  // Preserve fenced / table blocks; only scrub prose paragraphs.
  const blocks = trimmed.split(/\n{2,}/u);
  const cleaned = blocks.map((block) => {
    if (/^\s*\|/u.test(block) || /^\s*```/u.test(block) || /^\s*\d+\.\s/u.test(block)) {
      return block;
    }
    const kept = splitProseSentences(block)
      .map((sentence) => sentence.trim())
      .filter((sentence) => {
        if (!sentence) return false;
        if (!jargonOnly.test(sentence)) return true;
        // Drop pure platform sentences even when they mention a dotted metric id.
        if (/\b(attest|certif|exploratory|semantic bundle|query-?ready)\b/iu.test(sentence)) {
          return false;
        }
        // Keep if the sentence still carries a concrete money/count fact.
        return /\$\d|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\s+(?:units?|sales?|bookings?|items?)\b/iu.test(sentence);
      })
      .map((sentence) => sentence
        .replace(/\bthe governed\b/giu, "the")
        .replace(/\bgoverned\s+/giu, "")
        .replace(/\s{2,}/gu, " ")
        .trim());
    return kept.join(" ").trim();
  }).filter(Boolean);

  return cleaned.join("\n\n").trim();
}

export type EntityAssumptionDisclosure = Readonly<{
  phrase: string;
  itemName: string;
}>;

/**
 * Ensure a fuzzy-name assumption is stated once in plain English when the
 * server resolved it but the model forgot to say so.
 */
export function ensureAssumptionDisclosed(
  answerText: string,
  assumptions: readonly EntityAssumptionDisclosure[],
): string {
  if (assumptions.length === 0) return answerText;
  let text = answerText;
  for (const assumption of assumptions) {
    const phrase = assumption.phrase.trim();
    const itemName = assumption.itemName.trim();
    if (!phrase || !itemName) continue;
    const lower = text.toLowerCase();
    const already =
      lower.includes(`treating`) && lower.includes(itemName.toLowerCase())
      || lower.includes(`taking “${phrase.toLowerCase()}”`)
      || lower.includes(`taking "${phrase.toLowerCase()}"`)
      || lower.includes(`as ${itemName.toLowerCase()}`) && /treat|assum|match|taking/iu.test(lower);
    if (already) continue;
    const line = `Treating “${phrase}” as ${itemName}.`;
    text = text.trim() ? `${text.trim()}\n\n${line}` : line;
  }
  return text;
}

/**
 * Rewrite internal validation warnings into one owner-actionable sentence.
 * Returns empty when the warning is pure platform noise (attestation ids, etc.).
 */
export function ownerFacingLimitation(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  const text = raw.trim();

  // Attestation / column-shape noise helps engineers, not owners. When other
  // queries already returned usable rows, omit rather than scare.
  if (/attest|no numeric column named|certif|semantic bundle|checkId/iu.test(text)) {
    return "";
  }

  const before = text.match(/unavailable before\s+([0-9T:.\-Z]+)/iu);
  const capability = text.match(/^([\w.]+)\s+is unavailable/iu);
  if (before) {
    const date = formatOwnerDay(before[1]!);
    const topic = capability
      ? sentenceCase(capability[1]!.split(".").map((part) => governedTerm(part)).join(" "))
      : "That data";
    const backfill = /backfill/iu.test(text) ? "; older history is still loading" : "";
    return date
      ? `${topic} only goes back to ${date}${backfill}.`
      : `${topic} is not available for the full period you asked about${backfill}.`;
  }

  let cleaned = text
    .replace(/\b[a-z]+(?:\.[a-z0-9_]+)+\b/giu, (match) => governedTerm(match))
    .replace(/\bT\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  cleaned = sanitizeTraceText(cleaned, 280);
  if (!cleaned) return "";
  if (/\b(attest|governed check|bundle hash|IR)\b/iu.test(cleaned)) return "";
  return cleaned.endsWith(".") ? cleaned : `${cleaned}.`;
}

function sentenceCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** Plain-English Unavailable when evidence itself explains the block. */
export function unavailableEvidenceExplanation(
  evidence: readonly Readonly<{
    capabilities?: { missing?: readonly string[] };
    validation: {
      warnings: readonly string[];
      checks: readonly Readonly<Record<string, unknown>>[];
    };
  }>[],
  readableCheckName: (checkId: string) => string,
): string {
  const missing = [...new Set(evidence.flatMap((item) => item.capabilities?.missing ?? []))];
  if (missing.length > 0) {
    return `I can't answer this from the sources connected today. It needs ${governedTermList(missing, 4)}, which no connected source currently provides. Connecting a source that supplies it would unlock this answer.`;
  }
  const warning = evidence.flatMap((item) => item.validation.warnings).find(Boolean);
  const ownerWarning = ownerFacingLimitation(warning);
  const blocking = evidence.flatMap((item) => item.validation.checks
    .filter((check) => check.status === "failed" || check.status === "blocked")
    .map((check) => typeof check.checkId === "string" ? readableCheckName(check.checkId) : "")
    .filter(Boolean));
  if (blocking.length > 0) {
    if (ownerWarning) {
      return `I can't give you a reliable answer for this yet. ${ownerWarning} This clears once that data is fully loaded.`;
    }
    return `I can't give you a reliable answer for this yet. A data quality check on ${governedTermList([...new Set(blocking)], 3)} did not pass, so the figures are not trustworthy enough to report. This clears once that check passes.`;
  }
  if (ownerWarning) return ownerWarning;
  if (warning) {
    const fallback = ownerFacingLimitation(warning) || sanitizeTraceText(warning, 600);
    if (fallback && !/attest|governed/iu.test(fallback)) return fallback;
  }
  return "I couldn't produce a safely supported answer from the data available for this question.";
}

/**
 * States the part of the analysis that could not run, in owner English.
 * Omits the note entirely when we have nothing useful to say.
 */
export function supersededBlockDisclosure<Evidence extends Readonly<{
    state?: string;
    capabilities?: { missing?: readonly string[] };
    validation: {
      status?: string;
      warnings: readonly string[];
      checks: readonly Readonly<Record<string, unknown>>[];
    };
  }>>(
  evidence: readonly Evidence[],
  isBlocked: (item: Evidence) => boolean,
): string {
  const blocked = evidence.filter(isBlocked);
  if (blocked.length === 0) return "";
  const missing = [...new Set(blocked.flatMap((item) => item.capabilities?.missing ?? []))];
  if (missing.length > 0) {
    return `One part of this could not be completed: it needs ${governedTermList(missing, 3)}, which no connected source provides yet. Everything above still comes from the results that did come back.`;
  }
  const reason = blocked.flatMap((item) => item.validation.warnings).find(Boolean);
  const ownerReason = ownerFacingLimitation(reason);
  if (!ownerReason) return "";
  return `One part of this could not be completed: ${ownerReason} Everything above still comes from the results that did come back.`;
}

export function partialAnswerFromEvidence(results: readonly GovernedResult[]): {
  state: "Qualified";
  text: string;
  claims: [];
  followUps: [];
  scope: null;
} {
  return {
    state: "Qualified",
    text: results.length === 1
      ? "I ran out of room to finish writing this up, but the numbers are in the table above. Ask me about any part of it and I'll take it further."
      : `I ran out of room to finish writing this up, but the ${results.length} result tables above have the numbers. Ask me about any part of it and I'll take it further.`,
    claims: [],
    followUps: [],
    scope: null,
  };
}
