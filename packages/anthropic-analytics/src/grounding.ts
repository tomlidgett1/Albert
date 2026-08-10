import {
  finalAnswerSchema,
  type AnswerOutcome,
  type FinalAnswer,
  type SemanticResponse,
} from "./contracts.js";

export type ExecutedResult = Readonly<{
  resultId: string;
  state: AnswerOutcome;
  rows: readonly Readonly<Record<string, unknown>>[];
  columns: readonly string[];
  declaredClaims?: readonly Readonly<{ metricId: string; column: string }>[];
  queryAuditId?: string;
  route?: "semantic" | "source_exploration" | "sql_first";
  response: SemanticResponse;
}>;

const analyticalOutcomes = new Set<AnswerOutcome>(["verified", "qualified", "exploratory"]);

const evidenceRank: Readonly<Record<AnswerOutcome, number>> = Object.freeze({
  unavailable: 0,
  clarification: 0,
  exploratory: 1,
  qualified: 2,
  verified: 3,
});

const MONTH_NAME = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const ISO_DATE_TIME = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/giu;
const SLASH_DATE = /\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/giu;
const NATURAL_LANGUAGE_DATE = new RegExp(
  `\\b(?:\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_NAME}(?:,?\\s+\\d{4})?|${MONTH_NAME}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|${MONTH_NAME}\\s+\\d{4})\\b`,
  "giu",
);
const CLOCK_TIME = /\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[ap]m)?(?:\s?(?:UTC|GMT)[+-]\d{1,2}(?::?\d{2})?)?\b/giu;
const TEMPORAL_DURATION = /\b(?:(?:over|for|during|within|across|in|last|past|previous|prior|next|following)\s+(?:the\s+)?)?\d+(?:\.\d+)?[- ](?:calendar\s+|business\s+|trading\s+)?(?:days?|weeks?|months?|quarters?|years?|hours?|minutes?)(?:\s+period)?\b/giu;
const STANDALONE_YEAR = /\b(?:19|20)\d{2}\b/gu;

/** Dates and reporting-window parameters describe evidence scope; they are not
 * numerical business claims. Remove those spans before requiring exact cell
 * support, while retaining currency, percentages, counts, quantities and
 * every other analytical number. */
function withoutTemporalNumbers(value: string): string {
  return value
    .replace(ISO_DATE_TIME, " ")
    .replace(SLASH_DATE, " ")
    .replace(NATURAL_LANGUAGE_DATE, " ")
    .replace(CLOCK_TIME, " ")
    .replace(TEMPORAL_DURATION, " ")
    .replace(STANDALONE_YEAR, " ");
}

function outcomeForRank(rank: number): AnswerOutcome {
  if (rank >= 3) return "verified";
  if (rank === 2) return "qualified";
  if (rank === 1) return "exploratory";
  return "unavailable";
}

function numericTokens(value: string): readonly string[] {
  return withoutTemporalNumbers(value).match(/(?<![A-Za-z_])-?\d+(?:,\d{3})*(?:\.\d+)?%?/g) ?? [];
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replaceAll(",", "").replace(/%$/u, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function tokenValue(token: string): number {
  return Number(token.replaceAll(",", "").replace(/%$/u, ""));
}

function equivalentNumber(token: string, cell: unknown): boolean {
  const expected = tokenValue(token);
  const actual = numericValue(cell);
  if (actual === undefined) return false;
  const tolerance = Math.max(0.000_001, Math.abs(expected) * 1e-9);
  if (Math.abs(actual - expected) <= tolerance) return true;
  return token.endsWith("%") && Math.abs(actual * 100 - expected) <= tolerance;
}

/**
 * The provider proposes prose; this function grants it evidence. It validates
 * every cited cell and applies a deterministic evidence ceiling, so a model
 * cannot promote staging or qualified SQL to Verified.
 */
export function groundFinalAnswer(
  raw: unknown,
  executedResults: readonly ExecutedResult[],
): FinalAnswer {
  const candidate = finalAnswerSchema.parse(raw);
  const byId = new Map(executedResults.map((result) => [result.resultId, result]));

  for (const resultId of candidate.resultIds) {
    if (!byId.has(resultId)) throw new Error(`Final answer cited unknown result ${resultId}.`);
  }

  for (const claim of candidate.claims) {
    for (const reference of claim.refs) {
      const result = byId.get(reference.resultId);
      if (!result) throw new Error(`Claim cited unknown result ${reference.resultId}.`);
      const row = result.rows[reference.rowIndex];
      if (!row || !(reference.columnKey in row)) {
        throw new Error(`Claim reference ${reference.resultId}[${reference.rowIndex}].${reference.columnKey} does not exist.`);
      }
    }
    for (const token of numericTokens(claim.statement)) {
      const supported = claim.refs.some((reference) => {
        const result = byId.get(reference.resultId);
        return equivalentNumber(token, result?.rows[reference.rowIndex]?.[reference.columnKey]);
      });
      if (!supported) throw new Error(`Numerical claim ${token} does not match its cited cells.`);
    }
  }

  const proseNumbers = numericTokens(candidate.text);
  for (const token of proseNumbers) {
    if (!candidate.claims.some((claim) => numericTokens(claim.statement).includes(token))) {
      throw new Error(`Answer number ${token} is not represented in a grounded claim.`);
    }
  }

  if (["verified", "qualified", "exploratory"].includes(candidate.outcome)) {
    const cited = candidate.resultIds.map((id) => byId.get(id)!);
    const ceiling = cited.reduce((minimum, result) => Math.min(minimum, evidenceRank[result.state]), 3);
    if (ceiling === 0) {
      return Object.freeze({
        ...candidate,
        outcome: "unavailable",
        text: "The executed evidence did not support a publishable analytical result.",
        resultIds: [],
        claims: [],
        unavailableReason: "The governed SQL service marked the cited evidence unavailable.",
      });
    }
    if (evidenceRank[candidate.outcome] > ceiling) {
      return Object.freeze({ ...candidate, outcome: outcomeForRank(ceiling) });
    }
  }

  return Object.freeze(candidate);
}

function humanizeColumn(value: string): string {
  return value.replaceAll("_", " ");
}

function resultOrdering(result: ExecutedResult): Readonly<{ columnKey: string; direction: "asc" | "desc" }> | undefined {
  const window = result.response.data?.resultWindow;
  if (!window || typeof window !== "object" || Array.isArray(window)) return undefined;
  const orderBy = Reflect.get(window, "orderBy");
  if (!Array.isArray(orderBy) || !orderBy[0] || typeof orderBy[0] !== "object") return undefined;
  const columnKey = Reflect.get(orderBy[0], "columnKey");
  const direction = Reflect.get(orderBy[0], "direction");
  if (typeof columnKey !== "string" || (direction !== "asc" && direction !== "desc")) return undefined;
  return { columnKey, direction };
}

/**
 * Preserve a successful governed result when the provider reaches its turn
 * deadline before emitting structured prose. The host states only exact cells
 * already in the evidence ledger and runs the normal grounding validator over
 * its own fallback, so this path improves completion without inventing facts.
 */
const monthNumbers = new Map([
  ["jan", "01"], ["january", "01"], ["feb", "02"], ["february", "02"],
  ["mar", "03"], ["march", "03"], ["apr", "04"], ["april", "04"],
  ["may", "05"], ["jun", "06"], ["june", "06"], ["jul", "07"], ["july", "07"],
  ["aug", "08"], ["august", "08"], ["sep", "09"], ["sept", "09"], ["september", "09"],
  ["oct", "10"], ["october", "10"], ["nov", "11"], ["november", "11"],
  ["dec", "12"], ["december", "12"],
]);

function localDate(value: unknown, timezone: string): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return undefined;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : undefined;
}

function requestedDates(question: string | undefined, now: Date, timezone: string): readonly string[] {
  if (!question) return [];
  const dates = new Set(question.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []);
  for (const match of question.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})\b/giu)) {
    const month = monthNumbers.get(match[2]!.toLowerCase());
    if (month) dates.add(`${match[3]}-${month}-${match[1]!.padStart(2, "0")}`);
  }
  for (const match of question.matchAll(/\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{4})\b/giu)) {
    const month = monthNumbers.get(match[1]!.toLowerCase());
    if (month) dates.add(`${match[3]}-${month}-${match[2]!.padStart(2, "0")}`);
  }
  if (/\b(?:today|yesterday)\b/iu.test(question)) {
    const localToday = localDate(now, timezone);
    if (localToday) {
      const offset = /\byesterday\b/iu.test(question) ? -1 : 0;
      const relative = new Date(`${localToday}T00:00:00.000Z`);
      relative.setUTCDate(relative.getUTCDate() + offset);
      dates.add(relative.toISOString().slice(0, 10));
    }
  }
  return [...dates];
}

export function groundEvidenceFallback(
  executedResults: readonly ExecutedResult[],
  context?: Readonly<{ question?: string; now?: Date }>,
): FinalAnswer | undefined {
  const result = [...executedResults].reverse().find((item) =>
    analyticalOutcomes.has(item.state) && (item.declaredClaims?.length ?? 0) > 0);
  if (!result) return undefined;
  if (!result.rows[0]) {
    return groundFinalAnswer({
      outcome: result.state,
      text: "The governed query completed and returned no matching rows.",
      resultIds: [result.resultId],
      claims: [],
      followUps: ["Try a wider reporting period or remove a filter."],
    }, executedResults);
  }

  const ordering = resultOrdering(result);
  const temporalColumn = ordering && /(?:^|_)(?:date|day|at)$/u.test(ordering.columnKey)
    ? ordering.columnKey
    : result.columns.find((column) => /(?:^|_)(?:date|day|at)$/u.test(column));
  const timezone = typeof result.response.provenance.timeRange?.timezone === "string"
    ? result.response.provenance.timeRange.timezone
    : "Australia/Melbourne";
  const targets = requestedDates(context?.question, context?.now ?? new Date(), timezone);
  const datedRows = temporalColumn
    ? result.rows.map((row, rowIndex) => ({ row, rowIndex, date: localDate(row[temporalColumn], timezone) }))
    : [];
  let selected = datedRows[0] ?? { row: result.rows[0]!, rowIndex: 0, date: undefined };
  if (targets.length > 0 && temporalColumn) {
    const matched = datedRows.find((item) => item.date === targets[0]);
    if (!matched) {
      return groundFinalAnswer({
        outcome: result.state,
        text: "The governed query completed but contained no row for the requested business date.",
        resultIds: [result.resultId],
        claims: [],
        followUps: ["Ask for the most recent complete trading day available."],
      }, executedResults);
    }
    selected = matched;
  } else if (temporalColumn && /\b(?:latest|most recent)\b/iu.test(context?.question ?? "")) {
    selected = datedRows.reduce((latest, item) => item.date && (!latest.date || item.date > latest.date) ? item : latest, selected);
  }
  const temporalValue = selected.date;
  const answerContext = temporalColumn && temporalValue
    ? targets.length === 0 && (ordering?.columnKey === temporalColumn && ordering.direction === "desc" || /\b(?:latest|most recent)\b/iu.test(context?.question ?? ""))
      ? `For the latest returned ${humanizeColumn(temporalColumn)}, ${temporalValue}`
      : `For ${humanizeColumn(temporalColumn)} ${temporalValue}`
    : "In the first governed result row";

  const claims = (result.declaredClaims ?? []).flatMap((claim) => {
    const cell = selected.row[claim.column];
    if (numericValue(cell) === undefined) return [];
    return [{
      statement: `${answerContext}, ${humanizeColumn(claim.column)} was ${String(cell)}.`,
      assertion: "value" as const,
      refs: [{ resultId: result.resultId, rowIndex: selected.rowIndex, columnKey: claim.column }],
    }];
  });
  const text = claims.length > 0
    ? claims.map((claim) => claim.statement).join(" ")
    : "The governed query completed and its result is shown above; no numerical narrative was added because no declared claim mapped to a numeric result cell.";
  return groundFinalAnswer({
    outcome: result.state,
    text,
    resultIds: [result.resultId],
    claims,
    followUps: ["Ask me to explain or re-slice this governed result."],
  }, executedResults);
}
