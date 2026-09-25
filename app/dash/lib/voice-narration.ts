import type {
  TraceAnswerEvent,
  TraceClarificationEvent,
  TraceEvent,
  TraceTableColumn,
  TraceTableEvent,
} from "@/packages/shared/src";

/**
 * Voice narration derives short spoken lines from the governed trace stream.
 *
 * Everything here is pure and React-free so the contract suite can pin the
 * spoken-copy behaviour: what gets narrated, what stays silent, and what the
 * realtime model is handed as the tool result. Lines are owner copy — no SQL,
 * no snake_case members, no runtime jargon — mirroring the trail's rules in
 * InsightsStyleTrace but tuned for the ear instead of the eye.
 */

/** Member lists and governed identifiers are audit detail, not speech. */
function soundsTechnical(value: string): boolean {
  return /SQL|governed|allowlisted|intent to available|tenant|staging|lint|schema|CTE|GROUP BY/iu.test(value)
    || /\b[a-z][a-z0-9]*_[a-z0-9_]*\.[a-z][a-z0-9_]*\b/u.test(value)
    || /^[a-z0-9_]+(?:,\s*[a-z0-9_]+)+$/u.test(value);
}

/**
 * Internal-machinery talk ("Albert checked the draft, codex is repairing
 * it") must never be spoken to a business owner. Draft/validate/repair
 * activity becomes one plain line; other machinery references go silent.
 */
const REPAIR_ACTIVITY = /\b(?:repair(?:ing|ed)?|draft(?:ed|ing)?|validat(?:ion|ing|ed|or)|checked the)\b/iu;
const SPEECH_JARGON = /\b(?:codex|governed|runtime|semantic|catalogue|pipeline|schema|provider|prompt|token|agent)\b/iu;

function sanitizeSpokenLine(line: string): string | null {
  if (soundsTechnical(line)) return null;
  if (REPAIR_ACTIVITY.test(line)) return "double-checking the numbers";
  if (SPEECH_JARGON.test(line)) return null;
  return line;
}

function softenLabel(label: string): string {
  return label
    .replace(/^Understanding the question$/iu, "working out what you're asking")
    .replace(/^Codex is planning the analysis$/iu, "planning the analysis")
    .replace(/^Running SQL(?: with governed claims)?$/iu, "looking up your numbers")
    .replace(/^Running an exploratory query$/iu, "looking up your numbers")
    .replace(/^SQL query failed$/iu, "retrying a lookup that didn't work")
    .replace(/^Searched the semantic catalogue$/iu, "checking which of your data can answer this")
    .replace(/^Loaded governed view definitions$/iu, "reading how your metrics are defined")
    .replace(/^Analysing\b/iu, "looking at")
    .replace(/^Querying\b/iu, "looking up")
    .replace(/^Exploring\b/iu, "looking through");
}

function humanizeTopic(topic: string): string {
  return topic.replaceAll("_", " ").replace(/\s+/gu, " ").trim();
}

/**
 * One speakable line for a trace event, or null when the event should stay
 * silent (tables, charts, validations and plans are visual, not spoken).
 */
export function describeTraceEventForVoice(event: TraceEvent): string | null {
  switch (event.type) {
    case "narrative": {
      const text = event.text.trim();
      if (!text) return null;
      // Acknowledgements are already conversational; commentary is too —
      // unless it talks about the machinery.
      return sanitizeSpokenLine(text);
    }
    case "progress": {
      const label = event.label.trim();
      if (!label) return null;
      const detail = (event.detail ?? "").trim().replace(/\.+$/u, "");
      if (detail && !soundsTechnical(detail) && detail.length > label.length) {
        return sanitizeSpokenLine(softenLabel(detail));
      }
      return sanitizeSpokenLine(softenLabel(label));
    }
    case "query": {
      const topic = humanizeTopic(event.topic);
      return topic ? sanitizeSpokenLine(`looking up ${topic}`) : null;
    }
    case "error":
      return event.recoverable
        ? "hit a snag, trying another way"
        : null;
    default:
      return null;
  }
}

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
] as const;
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"] as const;

function twoDigitsToWords(value: number): string {
  if (value < 20) return ONES[value] ?? "";
  const tens = TENS[Math.floor(value / 10)] ?? "";
  const ones = value % 10;
  return ones === 0 ? tens : `${tens}-${ONES[ones]}`;
}

function threeDigitsToWords(value: number): string {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds === 0) return twoDigitsToWords(rest);
  if (rest === 0) return `${ONES[hundreds]} hundred`;
  return `${ONES[hundreds]} hundred and ${twoDigitsToWords(rest)}`;
}

/**
 * Realtime speech models read bare digits unreliably ("one two four three"
 * for 1,243), so every figure we hand the voice is spelled out in words —
 * words cannot be misread. Australian English style ("one hundred and
 * thirty"); decimals read digit-wise after "point", which IS how they are
 * spoken aloud.
 */
export function numberToSpokenWords(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value < 0) return `minus ${numberToSpokenWords(-value)}`;
  const integer = Math.floor(value);
  const fractionText = (() => {
    const text = String(value);
    const point = text.indexOf(".");
    if (point < 0) return "";
    const digits = text.slice(point + 1, point + 4);
    return ` point ${[...digits].map((digit) => ONES[Number(digit)]).join(" ")}`;
  })();
  if (integer >= 1_000_000_000_000) return value.toLocaleString("en-AU");
  const groups: string[] = [];
  const units = ["", " thousand", " million", " billion"];
  let remaining = integer;
  let unitIndex = 0;
  while (remaining > 0 || unitIndex === 0) {
    const group = remaining % 1_000;
    if (group > 0 || (remaining === 0 && unitIndex === 0 && groups.length === 0)) {
      groups.unshift(`${threeDigitsToWords(group)}${units[unitIndex]}`);
    }
    remaining = Math.floor(remaining / 1_000);
    unitIndex += 1;
    if (remaining === 0) break;
  }
  if (groups.length === 0) groups.push("zero");
  const last = groups[groups.length - 1] ?? "";
  const joined = groups.length > 1 && integer % 1_000 > 0 && integer % 1_000 < 100
    ? `${groups.slice(0, -1).join(", ")} and ${last}`
    : groups.join(", ");
  return `${joined}${fractionText}`;
}

function currencyUnit(code: string | undefined, amount: number): string {
  const plural = Math.abs(amount) !== 1;
  switch (code) {
    case undefined:
    case "":
    case "AUD":
    case "USD":
    case "NZD":
      return plural ? "dollars" : "dollar";
    case "GBP":
      return plural ? "pounds" : "pound";
    case "EUR":
      return plural ? "euros" : "euro";
    default:
      return code;
  }
}

export function currencyToSpokenWords(value: number, code?: string): string {
  const negative = value < 0;
  const absolute = Math.abs(value);
  const dollars = absolute >= 100 ? Math.round(absolute) : Math.floor(absolute);
  const cents = absolute >= 100 ? 0 : Math.round((absolute - dollars) * 100);
  const main = `${numberToSpokenWords(dollars)} ${currencyUnit(code, dollars)}`;
  const withCents = cents > 0 ? `${main} and ${numberToSpokenWords(cents)} cents` : main;
  return negative ? `minus ${withCents}` : withCents;
}

function numericCellToSpokenWords(value: number, column: TraceTableColumn): string {
  if (column.type === "currency") return currencyToSpokenWords(value, column.currency);
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  if (column.type === "percent") return `${numberToSpokenWords(rounded)} percent`;
  return numberToSpokenWords(rounded);
}

function formatCellForSpeech(value: string | number | null, column: TraceTableColumn): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (soundsTechnical(trimmed) || trimmed.length > 48) return null;
    // Cells often arrive pre-formatted ("0.00", "$1,234.56", "12.4%") —
    // still numbers, still must be spoken as words.
    const numericText = trimmed.replace(/^[$\s]+/u, "").replace(/%$/u, "").replaceAll(",", "");
    if (/^-?\d+(?:\.\d+)?$/u.test(numericText)) {
      const numeric = Number(numericText);
      if (trimmed.startsWith("$")) return currencyToSpokenWords(numeric, column.currency);
      if (trimmed.endsWith("%")) {
        return `${numberToSpokenWords(Math.abs(numeric) >= 100 ? Math.round(numeric) : Math.round(numeric * 100) / 100)} percent`;
      }
      return numericCellToSpokenWords(numeric, column);
    }
    return spellOutNumbersForSpeech(trimmed);
  }
  return numericCellToSpokenWords(value, column);
}

/**
 * Rewrites the figures inside prose so the voice reads them as words.
 * Conservative on purpose: money, "$1.2 million"-style amounts, percentages
 * and thousands-separated numbers are converted; years, times, small counts
 * and identifiers are left alone (models read those fine, and mangling a
 * date is worse than the original problem).
 */
export function spellOutNumbersForSpeech(text: string): string {
  return text
    .replace(
      /\$\s?(\d+(?:\.\d+)?)\s*(million|billion|thousand)\b/giu,
      (_match, amount: string, scale: string) =>
        `${numberToSpokenWords(Number(amount))} ${scale.toLowerCase()} dollars`,
    )
    .replace(
      /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/gu,
      (_match, amount: string) => currencyToSpokenWords(Number(amount.replaceAll(",", ""))),
    )
    .replace(
      /\b(\d+(?:\.\d+)?)\s?%/gu,
      (_match, amount: string) => `${numberToSpokenWords(Number(amount))} percent`,
    )
    .replace(
      /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/gu,
      (match) => numberToSpokenWords(Number(match.replaceAll(",", ""))),
    )
    // Bare decimals ("0.00", "981.4") read digit-by-digit if left alone.
    .replace(/\b\d+\.\d+\b/gu, (match) => numberToSpokenWords(Number(match)))
    // Standalone integers of three or more digits, sparing year-shaped ones
    // so dates stay intact.
    .replace(/\b\d{3,9}\b/gu, (match) => {
      const numeric = Number(match);
      if (numeric >= 1900 && numeric <= 2099) return match;
      return numberToSpokenWords(numeric);
    });
}

/**
 * A spoken "first numbers are in" headline from a completed governed table.
 *
 * The harness streams real intermediate results long before the final answer;
 * reading the top line aloud gives the owner substance mid-turn at zero extra
 * compute. Kept short: the caption, the leading label cell, and up to two
 * measure cells from the first row.
 */
export function describeTableEventForVoice(event: TraceTableEvent): string | null {
  if (event.status && event.status !== "complete") return null;
  const caption = event.caption.trim().replace(/\.+$/u, "");
  if (!caption || soundsTechnical(caption)) return null;
  const row = event.rows[0];
  if (!row) return null;

  const labelColumn = event.columns.find((column) => column.type === "string"
    && typeof row[column.key] === "string" && row[column.key] !== "");
  const measureParts: string[] = [];
  for (const column of event.columns) {
    if (column === labelColumn || column.type === "string") continue;
    if (soundsTechnical(column.label)) continue;
    const spoken = formatCellForSpeech(row[column.key] ?? null, column);
    if (!spoken) continue;
    measureParts.push(`${column.label.toLowerCase()} ${spoken}`);
    if (measureParts.length === 2) break;
  }
  if (measureParts.length === 0) return null;

  const topLine = labelColumn
    ? `${String(row[labelColumn.key])}: ${measureParts.join(", ")}`
    : measureParts.join(", ");
  const scale = event.rows.length > 1
    ? ` (top of ${numberToSpokenWords(event.rows.length)} rows)`
    : "";
  return `first numbers are in — ${caption.charAt(0).toLowerCase()}${caption.slice(1)}. ${topLine}${scale}`;
}

/**
 * Fixed softened stage labels carry no new information after the first one —
 * a human colleague wouldn't keep announcing "looking up your numbers".
 * Topic-specific lines, commentary, and table headlines are substance.
 */
export function isGenericNarrationLine(line: string): boolean {
  return /^(?:planning the analysis|looking up your numbers|working out what you're asking|checking which of your data can answer this|reading how your metrics are defined|double-checking the numbers|working on it)$/iu
    .test(line.trim());
}

export type NarrationTake = Readonly<{
  line: string;
  /** "heartbeat" means: say only a brief few-word check-in, nothing else. */
  kind: "update" | "heartbeat";
}>;

/**
 * Decides what the voice says while the analysis runs, tuned to sound like a
 * colleague thinking aloud rather than a status bot: substance speaks on a
 * normal cadence, generic stage labels speak rarely and never displace
 * substance, repeats stay silent, and a long quiet stretch produces one brief
 * check-in instead of a re-announcement.
 */
export function createNarrationTracker(options?: Readonly<{
  /** Minimum ms between substantive spoken updates. */
  minIntervalMs?: number;
  /** Generic stage labels wait much longer — most should never be spoken. */
  genericIntervalMs?: number;
  /** After this long with nothing new, emit one brief check-in. */
  heartbeatMs?: number;
}>) {
  const minIntervalMs = options?.minIntervalMs ?? 11_000;
  const genericIntervalMs = options?.genericIntervalMs ?? 26_000;
  const heartbeatMs = options?.heartbeatMs ?? 45_000;
  let lastSpokenLine: string | null = null;
  let lastSpokenAt = 0;
  let pending: Readonly<{ line: string; generic: boolean }> | null = null;
  let primed = false;

  return {
    /** Record a derived line; it becomes the next candidate if it's new. */
    note(line: string | null, noteOptions?: Readonly<{ generic?: boolean }>): void {
      if (!line) return;
      const trimmed = line.trim();
      if (!trimmed || trimmed === lastSpokenLine || trimmed === pending?.line) return;
      const generic = noteOptions?.generic ?? isGenericNarrationLine(trimmed);
      // Filler never displaces substance waiting to be spoken.
      if (pending && !pending.generic && generic) return;
      pending = { line: trimmed, generic };
    },
    /**
     * What to speak right now, or null. Consuming it starts the
     * inter-update interval.
     */
    take(now: number): NarrationTake | null {
      if (pending) {
        const interval = pending.generic ? genericIntervalMs : minIntervalMs;
        if (primed || now - lastSpokenAt >= interval) {
          const line = pending.line;
          pending = null;
          primed = false;
          lastSpokenLine = line;
          lastSpokenAt = now;
          return { line, kind: "update" };
        }
        return null;
      }
      if (lastSpokenLine && now - lastSpokenAt >= heartbeatMs) {
        lastSpokenAt = now;
        return { line: "", kind: "heartbeat" };
      }
      return null;
    },
    /** First update (the acknowledgement) should not wait out the interval. */
    primeImmediate(): void {
      primed = true;
    },
    reset(): void {
      lastSpokenLine = null;
      lastSpokenAt = 0;
      pending = null;
      primed = false;
    },
  };
}

export type NarrationTracker = ReturnType<typeof createNarrationTracker>;

/**
 * Markdown renders; speech doesn't. Strip structure the voice can't read:
 * tables become a short elision, links keep their text, emphasis drops.
 */
export function stripMarkdownForSpeech(markdown: string): string {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let inTable = false;
  let inCodeFence = false;
  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const isTableRow = /^\s*\|.*\|\s*$/u.test(line);
    if (isTableRow) {
      if (!inTable) {
        inTable = true;
        kept.push("(The full table is on screen.)");
      }
      continue;
    }
    inTable = false;
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/^\s*[-*]\s+/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

const MAX_SPOKEN_ANSWER_CHARS = 2_400;

/**
 * The JSON string handed back to the realtime model as the ask_albert
 * function result. Bounded and structured so the voice can lead with claims
 * and state, not re-derive numbers.
 */
export function buildAnswerToolOutput(answer: TraceAnswerEvent): string {
  const spoken = spellOutNumbersForSpeech(stripMarkdownForSpeech(answer.text));
  return JSON.stringify({
    state: answer.state,
    answer: spoken.length > MAX_SPOKEN_ANSWER_CHARS
      ? `${spoken.slice(0, MAX_SPOKEN_ANSWER_CHARS)}…`
      : spoken,
    key_findings: (answer.claims ?? [])
      .slice(0, 6)
      .map((claim) => spellOutNumbersForSpeech(claim.statement)),
    follow_ups: answer.followUps.slice(0, 3),
    // Plain owner language only — a verified answer needs no ceremony, and
    // "governed evidence" is machinery talk that must never be spoken.
    note: answer.state === "No data"
      ? "Nothing in the records matched that question."
      : answer.state === "Unavailable"
        ? "That data isn't connected yet."
        : answer.state === "Qualified"
          ? "Solid answer, with one limitation worth mentioning."
          : undefined,
  });
}

/** Tool result when the analysis needs one choice before it can continue. */
export function buildClarificationToolOutput(clarification: TraceClarificationEvent): string {
  return JSON.stringify({
    state: "Clarification",
    question: clarification.question,
    options: clarification.options.map((option) => option.label),
    instruction: "Ask the user this question aloud, then call ask_albert again with their clarified question.",
  });
}

/** Tool result when the turn failed outright. */
export function buildErrorToolOutput(message: string): string {
  return JSON.stringify({
    state: "Failed",
    error: message,
    instruction: "Apologise briefly and offer to try again or rephrase.",
  });
}
