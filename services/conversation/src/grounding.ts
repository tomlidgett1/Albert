import type { TraceCell } from "../../../packages/shared/src/index.js";

const numericTokenPattern =
  /(?<![\p{L}\d])[-+]?\$?\d[\d,]*(?:\.\d+)?\s?(?:%|k|m|bn|b)?(?![\p{L}\d])/giu;

const numberWordValues = Object.freeze({
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
} as const);

const numberWordAlternation = Object.keys(numberWordValues)
  .sort((left, right) => right.length - left.length)
  .join("|");
const numberWordPattern = new RegExp(
  `\\b(?:${numberWordAlternation}|hundred|thousand|million|billion)(?:[\\s-]+(?:and[\\s-]+)?(?:${numberWordAlternation}|hundred|thousand|million|billion))*\\b`,
  "giu",
);

type QuantitativeWordClaim = Readonly<{
  token: string;
  normalized: string;
  allowRowCount: boolean;
}>;

/**
 * One numeric figure as the author actually wrote it. `decimals` and `scale`
 * record the precision the author committed to, which is what makes a tolerant
 * comparison safe: "62%" claims one significant rounding of a cell, "62.05%"
 * claims another, and neither may drift onto a different cell.
 */
type NumericToken = Readonly<{
  token: string;
  value: number;
  decimals: number;
  scale: number;
  /** An explicit percent sign may faithfully render either a ratio cell
   * (0.0265 -> 2.65%) or an already-percent-scaled cell (2.65 -> 2.65%). */
  percent: boolean;
  /** Whether the author wrote an explicit sign, rather than carrying direction
   * in words ("down $2,219.31"). Unsigned figures may match a cell magnitude. */
  signed: boolean;
}>;

/**
 * Below this magnitude an integer-precision match is refused. Rounding 2.4 to
 * "2" would let an arbitrary small integer borrow grounding from an unrelated
 * cell, so short values must be quoted at the precision they carry.
 */
const MINIMUM_INTEGER_ROUNDING_MAGNITUDE = 10;
/** Deepest decimal precision an author can meaningfully write for a figure. */
const MAXIMUM_COMPARABLE_DECIMALS = 6;

const magnitudeScales: Readonly<Record<string, number>> = Object.freeze({
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  bn: 1_000_000_000,
});

/** Splits a written figure into its value, its precision, and its magnitude. */
function parseNumericToken(token: string): NumericToken | null {
  const trimmed = token.trim();
  const match = /^([-+]?)\$?([\d,]*\d)(?:\.(\d+))?\s?(%|k|m|bn|b)?$/iu.exec(trimmed);
  if (!match) return null;
  const [, sign, integerPart, fractionPart, suffix] = match;
  const digits = `${sign === "-" ? "-" : ""}${integerPart.replaceAll(",", "")}${fractionPart ? `.${fractionPart}` : ""}`;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  const normalizedSuffix = suffix?.toLowerCase();
  const scale = normalizedSuffix && normalizedSuffix !== "%"
    ? magnitudeScales[normalizedSuffix] ?? 1
    : 1;
  return Object.freeze({
    token: trimmed,
    value,
    decimals: fractionPart?.length ?? 0,
    scale,
    percent: normalizedSuffix === "%",
    signed: sign === "-" || sign === "+",
  });
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  // Scale-then-round keeps 1.005 -> 1.01 rather than inheriting the binary
  // representation error that Number.prototype.toFixed exposes at this size.
  return Math.round((value + Number.EPSILON * Math.sign(value) * Math.abs(value)) * factor) / factor;
}

/**
 * A figure is grounded when some governed cell rounds to exactly what the
 * author wrote, at the precision and magnitude they wrote it. This admits the
 * natural "$37,558.70", "62%" and "$37.6k" renderings of a cell while still
 * refusing any value no cell supports.
 */
function tokenMatchesCellValue(token: NumericToken, cell: number): boolean {
  // An unsigned figure may state the magnitude of a negative cell, because
  // business prose carries direction in words: "sales are down $2,219.31"
  // reports the cell -2219.31 faithfully. Typed comparison claims, not the
  // narrative, are what prove direction.
  const signedCandidates = token.signed ? [cell] : [cell, Math.abs(cell)];
  const candidates = token.percent
    ? [...signedCandidates, ...signedCandidates.map((candidate) => candidate * 100)]
    : signedCandidates;
  return candidates.some((candidate) => {
    const scaled = candidate / token.scale;
    if (scaled === token.value) return true;
    if (token.decimals > MAXIMUM_COMPARABLE_DECIMALS) return false;
    if (token.decimals === 0 && Math.abs(scaled) < MINIMUM_INTEGER_ROUNDING_MAGNITUDE) return false;
    return roundTo(scaled, token.decimals) === token.value;
  });
}

function numericCellValue(value: TraceCell): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[-+]?\$?\d[\d,]*(?:\.\d+)?%?$/u.test(trimmed)) return null;
  const numeric = Number(trimmed.replace(/[$,%+]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function parseNumberWords(value: string): number | null {
  const words = value.toLowerCase().split(/[\s-]+/u).filter(Boolean);
  let total = 0;
  let current = 0;
  let lastLargeScale = Number.POSITIVE_INFINITY;
  let sawNumber = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === "and") {
      if (index === 0 || index === words.length - 1 || total + current < 100) return null;
      continue;
    }
    const small = numberWordValues[word as keyof typeof numberWordValues];
    if (small !== undefined) {
      current += small;
      sawNumber = true;
      continue;
    }
    if (word === "hundred") {
      if (current === 0) current = 1;
      if (current >= 100) return null;
      current *= 100;
      sawNumber = true;
      continue;
    }
    const scale = word === "thousand" ? 1_000 : word === "million" ? 1_000_000 : 1_000_000_000;
    if (scale >= lastLargeScale) return null;
    if (current === 0) current = 1;
    total += current * scale;
    current = 0;
    lastLargeScale = scale;
    sawNumber = true;
  }
  const parsed = total + current;
  return sawNumber && Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Typography-tolerant form for label comparison: writers (and models) render a
 * stored "31-60 days" as "31–60 days" — same label, different dash. Grounding
 * must compare content, not glyph choice.
 */
function comparableLabelText(value: string): string {
  return value
    .toLocaleLowerCase("en-AU")
    .replace(/[‐-―−]/gu, "-")
    .replace(/\s+/gu, " ");
}

function copiedSourceLabel(
  narrative: string,
  token: string,
  labels: readonly string[],
): boolean {
  const normalizedNarrative = comparableLabelText(narrative);
  const normalizedToken = comparableLabelText(token);
  return labels.some((label) => {
    const normalizedLabel = comparableLabelText(label);
    return normalizedLabel.includes(normalizedToken) && normalizedNarrative.includes(normalizedLabel);
  });
}

function quantitativeWordClaims(
  narrative: string,
  copiedLabels: readonly string[],
): readonly QuantitativeWordClaim[] {
  const claims: QuantitativeWordClaim[] = [];
  numberWordPattern.lastIndex = 0;
  for (const match of narrative.matchAll(numberWordPattern)) {
    const token = match[0];
    const offset = match.index ?? 0;
    const before = narrative.slice(Math.max(0, offset - 64), offset).toLowerCase();
    const after = narrative.slice(offset + token.length, offset + token.length + 16).toLowerCase();
    if (
      token.toLowerCase() === "one" &&
      (/(?:\bno\s+|\bsome\s*)$/u.test(before)
        || /^\s+(?:of|another|off)\b/u.test(after)
        // "Cannot identify one owner" expresses unresolved uniqueness; it
        // does not assert that the evidence contains one record. Treating the
        // determiner as a quantitative finding can erase an honest ambiguity
        // warning and replace it with a misleading ranked result.
        || /\b(?:cannot|can't|could not|couldn't|unable to)\s+(?:safely\s+)?(?:identify|choose|select|name)\s*$/u.test(before))
    ) continue;
    if (copiedSourceLabel(narrative, token, copiedLabels)) continue;
    const parsed = parseNumberWords(token);
    if (parsed !== null) claims.push({ token, normalized: String(parsed), allowRowCount: true });
  }

  const multiplierPatterns: readonly Readonly<{ pattern: RegExp; value: number }>[] = [
    { pattern: /\b(?:twice|doubled)\b/giu, value: 2 },
    { pattern: /\b(?:thrice|tripled)\b/giu, value: 3 },
    {
      pattern: /\b(?:is|was|were|are|at|nearly|almost|about|roughly|approximately)\s+(?:double|triple)\b|\b(?:double|triple)\s+(?:as|the|what|its|last|previous|amount|value|rate|sales|revenue|cost|profit|margin|total|number)\b/giu,
      value: 0,
    },
    { pattern: /\bhalved\b|\bhalf\s+(?:as|of|the)\b|\b(?:by|to|about|around|nearly|almost|roughly|approximately)\s+half\b|\b(?:cut|split)\s+in\s+half\b/giu, value: 0.5 },
  ];
  for (const { pattern, value } of multiplierPatterns) {
    pattern.lastIndex = 0;
    for (const match of narrative.matchAll(pattern)) {
      const token = match[0];
      const offset = match.index ?? 0;
      const preceding = narrative.slice(Math.max(0, offset - 16), offset).toLowerCase();
      if (/\b(?:first|second|opening|closing|financial|calendar)\s*$/u.test(preceding) && /half/iu.test(token)) {
        continue;
      }
      if (copiedSourceLabel(narrative, token, copiedLabels)) continue;
      const normalized = value === 0
        ? (/triple/iu.test(token) ? "3" : "2")
        : String(value);
      claims.push({ token, normalized, allowRowCount: false });
    }
  }
  return Object.freeze(claims);
}

/** Numeric cell values and copyable text labels drawn from governed rows. */
export type GroundingEvidence = Readonly<{
  values: readonly number[];
  labels: readonly string[];
}>;

/**
 * The year, month and day of a governed date cell. A date is data: an answer
 * that groups by week has to name the weeks it is reporting, and it will write
 * "29 June" where the cell holds "2026-06-29". Without this every dated answer
 * — the entire trend and by-period class — reads as unsupported arithmetic.
 */
function dateCellComponents(value: TraceCell): readonly number[] {
  if (typeof value !== "string") return [];
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value.trim());
  if (!match) return [];
  const [, year, month, day] = match;
  return [Number(year), Number(month), Number(day)];
}

export function groundingEvidenceFromRows(
  rows: readonly Readonly<Record<string, TraceCell>>[],
): GroundingEvidence {
  const values: number[] = [];
  const labels: string[] = [];
  for (const row of rows) {
    for (const value of Object.values(row)) {
      const numeric = numericCellValue(value);
      if (numeric !== null) {
        values.push(numeric);
        continue;
      }
      const dateParts = dateCellComponents(value);
      if (dateParts.length) values.push(...dateParts);
      if (typeof value === "string" && value.trim()) {
        labels.push(value.trim());
        // Numbers embedded in string cells are data the row supplied — an age
        // band "31-60 days" states 31 and 60 as surely as a numeric cell would.
        // Without this, restating a label with different typography (an en dash
        // for the stored hyphen) reads as an invented figure and the redactor
        // silently deletes a correct row from the answer.
        for (const embedded of value.matchAll(/\d[\d,]*(?:\.\d+)?/gu)) {
          const parsed = Number(embedded[0].replaceAll(",", ""));
          if (Number.isFinite(parsed)) values.push(parsed);
        }
      }
    }
  }
  return Object.freeze({ values: Object.freeze(values), labels: Object.freeze(labels) });
}

/**
 * Numbers the owner themselves wrote — a target ("save $1k a month"), a
 * hypothetical ("raise prices 5%"), a constraint ("under $10k a month").
 * Restating the owner's own figure is reporting, not invention, so these
 * values may join the grounded pool for the final answer. Digit tokens with
 * $/%/k/m forms, "N grand", and plain number-word phrases ("five hundred",
 * "a thousand") all count; the scaled value is returned so a question's
 * "$1k" grounds an answer's "$1,000".
 */
export function ownerStatedGroundingValues(text: string): readonly number[] {
  const values = new Set<number>();
  numericTokenPattern.lastIndex = 0;
  for (const raw of text.match(numericTokenPattern) ?? []) {
    const token = parseNumericToken(raw.trim());
    if (!token) continue;
    values.add(token.value * token.scale);
    if (token.scale !== 1) values.add(token.value);
  }
  const grandCount = new RegExp(
    String.raw`\b(\d[\d,]*(?:\.\d+)?|a|an|(?:${numberWordAlternation})(?:[\s-]+(?:${numberWordAlternation}))?)\s*grand\b`,
    "giu",
  );
  for (const grand of text.matchAll(grandCount)) {
    const raw = grand[1]!;
    const parsed = /^\d/u.test(raw)
      ? Number(raw.replaceAll(",", ""))
      : /^an?$/iu.test(raw) ? 1 : parseNumberWords(raw);
    if (parsed !== null && Number.isFinite(parsed) && parsed > 0) values.add(parsed * 1_000);
  }
  numberWordPattern.lastIndex = 0;
  for (const phrase of text.match(numberWordPattern) ?? []) {
    const parsed = parseNumberWords(phrase);
    if (parsed !== null && parsed !== 0) values.add(parsed);
  }
  return Object.freeze([...values]);
}

/**
 * Prevents model-authored figures from entering a governed narrative. Every
 * numeric token must be a faithful rendering of a governed cell, a
 * server-derived row count, or a figure the caller supplied as additional
 * governed evidence (a resolved period boundary, for example).
 */
export function findUngroundedNumbers(
  narrative: string,
  rows: readonly Readonly<Record<string, TraceCell>>[],
  additionalValues: readonly number[] = [],
  additionalLabels: readonly string[] = [],
): readonly string[] {
  const evidence = groundingEvidenceFromRows(rows);
  return findUngroundedNumbersWithEvidence(
    narrative,
    [...evidence.values, ...additionalValues],
    [...evidence.labels, ...additionalLabels],
    rows.length,
  );
}

/** Structured claims deliberately do not inherit the global row-count escape
 * hatch. Only their explicitly referenced numeric cells may ground figures. */
export function findUngroundedNumbersForCells(
  narrative: string,
  cells: readonly TraceCell[],
  copiedLabels: readonly string[] = [],
): readonly string[] {
  const values = cells.map(numericCellValue).filter((value): value is number => value !== null);
  return findUngroundedNumbersWithEvidence(narrative, values, copiedLabels);
}

/** True when the narrative states this cell at some faithful precision. */
export function mentionsCellValue(narrative: string, cell: TraceCell): boolean {
  const value = numericCellValue(cell);
  if (value === null) return false;
  return numericTokens(narrative).some((token) => tokenMatchesCellValue(token, value));
}

export function normalizedQuantitativeClaims(
  narrative: string,
  copiedLabels: readonly string[] = [],
): readonly string[] {
  const values = numericTokens(narrative).map((token) => String(token.value * token.scale));
  for (const claim of quantitativeWordClaims(narrative, copiedLabels)) values.push(claim.normalized);
  return Object.freeze(values);
}

/**
 * Ordered-list markers ("1.", "2)") number the presentation, not the business.
 * Reading them as unsupported figures blocked every ranked answer, which is the
 * shape most of these questions want.
 */
const listMarkerPattern = /^[ \t]*(?:[-*]\s*)?\d+[.)](?=\s)/gmu;

/** Rank/# cells are presentation ordinals, like ordered-list markers. */
function withoutMarkdownRankCells(narrative: string): string {
  const lines = narrative.split("\n");
  let rankColumn = -1;
  let inTable = false;
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      rankColumn = -1;
      inTable = false;
      return line;
    }
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    if (!inTable) {
      rankColumn = cells.findIndex((cell) => /^(?:rank|#|position)$/iu.test(cell));
      inTable = true;
      return line;
    }
    if (rankColumn < 0 || !cells[rankColumn] || !/^\d+$/u.test(cells[rankColumn]!)) return line;
    cells[rankColumn] = "";
    return `| ${cells.join(" | ")} |`;
  }).join("\n");
}

function numericTokens(narrative: string): readonly NumericToken[] {
  const withoutListMarkers = withoutMarkdownRankCells(narrative.replace(listMarkerPattern, ""));
  numericTokenPattern.lastIndex = 0;
  return (withoutListMarkers.match(numericTokenPattern) ?? [])
    .map(parseNumericToken)
    .filter((token): token is NumericToken => token !== null);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** True when this fragment is where the narrative actually states the figure. */
function fragmentStatesToken(fragment: string, rawToken: string): boolean {
  const target = parseNumericToken(rawToken);
  if (!target) {
    // Word-form claims ("doubled", "thirty") are matched as whole words.
    return new RegExp(`\\b${escapeRegExp(rawToken)}\\b`, "iu").test(fragment);
  }
  return numericTokens(fragment).some((token) =>
    token.token === target.token
    || (token.value === target.value
      && token.scale === target.scale
      && token.decimals === target.decimals));
}

/** A markdown table's `| --- |` rule, which carries no figure of its own. */
const tableSeparatorPattern = /^\|?[\s:|-]*-[\s:|-]*\|?$/u;

/**
 * Sentence boundaries as a business narrative actually writes them. Splitting
 * on a full stop followed by whitespace keeps "$37,558.70" and "97.9%" whole,
 * because their stops are followed by a digit rather than a space.
 */
function splitSentences(line: string): readonly string[] {
  return line.split(/(?<=[.!?])\s+/u).filter((part) => part.trim().length > 0);
}

/**
 * A markdown table whose data rows were all removed states nothing, so its
 * header and rule are dropped with them rather than left as a bare frame.
 */
function dropEmptyTables(lines: readonly string[]): readonly string[] {
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const isSeparator = tableSeparatorPattern.test(line.trim()) && line.includes("|");
    if (!isSeparator) { kept.push(line); continue; }
    const next = lines[index + 1]?.trim() ?? "";
    if (next.startsWith("|")) { kept.push(line); continue; }
    // Header immediately above a rule with no surviving rows below it.
    if (kept.at(-1)?.trim().startsWith("|")) kept.pop();
  }
  return kept;
}

/**
 * Removes only the parts of a narrative that state an unsupported figure, and
 * keeps everything else the author wrote. One bad number invalidates its own
 * sentence or its own table row — not the whole answer — so an answer that
 * loses a clause is worth far more to the reader than a stub that says nothing.
 * Returns "" only when no part of the narrative survived.
 */
export function redactUngroundedProse(
  narrative: string,
  ungrounded: readonly string[],
): string {
  if (ungrounded.length === 0) return narrative;
  const carries = (fragment: string): boolean =>
    ungrounded.some((token) => fragmentStatesToken(fragment, token));
  const kept: string[] = [];
  for (const line of narrative.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|")) {
      // Table rows are whole records: drop the offending row, keep the table.
      if (tableSeparatorPattern.test(trimmed) || !carries(line)) kept.push(line);
      continue;
    }
    if (!carries(line)) { kept.push(line); continue; }
    const survivors = splitSentences(line).filter((sentence) => !carries(sentence));
    if (survivors.length > 0) kept.push(survivors.join(" ").trim());
  }
  return dropEmptyTables(kept).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function findUngroundedNumbersWithEvidence(
  narrative: string,
  cellValues: readonly number[],
  copiedLabels: readonly string[],
  rowCount?: number,
): readonly string[] {
  const grounded = rowCount === undefined ? cellValues : [...cellValues, rowCount];
  const ungrounded = numericTokens(narrative)
    .filter((token) => !grounded.some((value) => tokenMatchesCellValue(token, value)))
    // A digit inside a governed label the answer quoted verbatim — "CO2",
    // "Shimano 105", "700x25c" — is part of a name, not a figure.
    .filter((token) => !copiedSourceLabel(narrative, token.token, copiedLabels))
    .map((token) => token.token);
  for (const claim of quantitativeWordClaims(narrative, copiedLabels)) {
    const evidence = claim.allowRowCount ? grounded : cellValues;
    const claimed = Number(claim.normalized);
    if (!evidence.some((value) => value === claimed)) ungrounded.push(claim.token);
  }
  return Object.freeze([...new Set(ungrounded)]);
}
