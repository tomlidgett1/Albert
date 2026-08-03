import type { TraceCell } from "../../../packages/shared/src/index.js";

const numericTokenPattern = /(?<![\p{L}\d])[-+]?\$?\d[\d,]*(?:\.\d+)?%?(?![\p{L}\d])/gu;

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

function normalizeNumericToken(value: string): string {
  const stripped = value.replace(/[$,%+]/g, "");
  const numeric = Number(stripped);
  return Number.isFinite(numeric) ? String(numeric) : stripped;
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

function copiedSourceLabel(
  narrative: string,
  token: string,
  labels: readonly string[],
): boolean {
  const normalizedNarrative = narrative.toLocaleLowerCase("en-AU");
  const normalizedToken = token.toLocaleLowerCase("en-AU");
  return labels.some((label) => {
    const normalizedLabel = label.toLocaleLowerCase("en-AU");
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
    const before = narrative.slice(Math.max(0, offset - 16), offset).toLowerCase();
    const after = narrative.slice(offset + token.length, offset + token.length + 16).toLowerCase();
    if (
      token.toLowerCase() === "one" &&
      (/(?:\bno\s+|\bsome\s*)$/u.test(before) || /^\s+(?:of|another|off)\b/u.test(after))
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

/**
 * Prevents model-authored figures from entering a governed narrative. Every
 * numeric token must occur in a result cell or be a server-derived row count.
 */
export function findUngroundedNumbers(
  narrative: string,
  rows: readonly Readonly<Record<string, TraceCell>>[],
): readonly string[] {
  const groundedCells = new Set<string>();
  const copiedLabels: string[] = [];
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (typeof value === "number") groundedCells.add(normalizeNumericToken(String(value)));
      if (typeof value === "string" && /^[-+]?\d[\d,]*(?:\.\d+)?%?$/u.test(value.trim())) {
        groundedCells.add(normalizeNumericToken(value));
      } else if (typeof value === "string" && value.trim()) {
        copiedLabels.push(value.trim());
      }
    }
  }
  return findUngroundedNumbersWithEvidence(narrative,groundedCells,copiedLabels,String(rows.length));
}

/** Structured claims deliberately do not inherit the global row-count escape
 * hatch. Only their explicitly referenced numeric cells may ground figures. */
export function findUngroundedNumbersForCells(
  narrative:string,
  cells:readonly TraceCell[],
  copiedLabels:readonly string[]=[]
):readonly string[]{
  const groundedCells=new Set<string>();
  for(const value of cells){
    if(typeof value==="number")groundedCells.add(normalizeNumericToken(String(value)));
    if(typeof value==="string"&&/^[-+]?\$?\d[\d,]*(?:\.\d+)?%?$/u.test(value.trim())){
      groundedCells.add(normalizeNumericToken(value));
    }
  }
  return findUngroundedNumbersWithEvidence(narrative,groundedCells,copiedLabels);
}

export function normalizedQuantitativeClaims(
  narrative:string,
  copiedLabels:readonly string[]=[]
):readonly string[]{
  const values=(narrative.match(numericTokenPattern)??[]).map(normalizeNumericToken);
  for(const claim of quantitativeWordClaims(narrative,copiedLabels))values.push(claim.normalized);
  return Object.freeze(values);
}

function findUngroundedNumbersWithEvidence(
  narrative:string,
  groundedCells:ReadonlySet<string>,
  copiedLabels:readonly string[],
  rowCount?:string,
):readonly string[]{
  const grounded=new Set(groundedCells);if(rowCount!==undefined)grounded.add(rowCount);
  const tokens = narrative.match(numericTokenPattern) ?? [];
  const ungrounded = tokens.filter((token) => !grounded.has(normalizeNumericToken(token)));
  for (const claim of quantitativeWordClaims(narrative, copiedLabels)) {
    const evidence = claim.allowRowCount ? grounded : groundedCells;
    if (!evidence.has(claim.normalized)) ungrounded.push(claim.token);
  }
  return Object.freeze([...new Set(ungrounded)]);
}
