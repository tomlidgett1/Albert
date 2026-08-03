import {
  claimAssertionSchema,
  claimCellReferenceSchema,
  evidenceClaimInputSchema,
  type EvidenceClaimInput,
  type GovernedResult,
} from "../../../packages/agent/src/semantic-tools.js";
import type { TraceCell } from "../../../packages/shared/src/index.js";
import {
  findUngroundedNumbersForCells,
  normalizedQuantitativeClaims,
} from "./grounding.js";

export { claimAssertionSchema, claimCellReferenceSchema };
export const evidenceClaimSchema = evidenceClaimInputSchema;

export type EvidenceClaim = EvidenceClaimInput;
export type ClaimCellReference = EvidenceClaim["refs"][number];

export type ClaimValidation = Readonly<{
  valid: boolean;
  claims: readonly EvidenceClaim[];
  errors: readonly string[];
}>;

type ResolvedReference = Readonly<{
  ref: ClaimCellReference;
  result: GovernedResult;
  column: GovernedResult["columns"][number];
  value: TraceCell;
}>;

const comparativeLexicon = /\b(?:highest|lowest|largest|smallest|maximum|minimum|top|bottom|best|worst|more|less|greater|higher|lower|above|below|exceed(?:ed|s)?|under|over|outperform(?:ed|s)?|beat|ahead|behind|difference|delta|gap|versus|vs\.?|compared|double|twice|half|equal|same|matched|identical|led|leading|trailing|rank(?:ed|s)?|increase(?:d|s)?|decrease(?:d|s)?|declined|dropped|surged|rose|grew|fell|up|down)\b/iu;
const assertionLexicon = Object.freeze({
  highest: /\b(?:highest|largest|maximum|top|most|led|leading)\b/iu,
  lowest: /\b(?:lowest|smallest|minimum|bottom|least|trailing)\b/iu,
  greater_than: /\b(?:greater|higher|more|above|exceed(?:ed|s)?|outperform(?:ed|s)?|beat|ahead)\b/iu,
  less_than: /\b(?:less|lower|below|under|fell|trailing|behind)\b/iu,
  equal: /\b(?:equal|same|matched|identical)\b/iu,
} satisfies Readonly<Record<Exclude<EvidenceClaim["assertion"], "value">, RegExp>>);

export function validateEvidenceClaims(
  rawClaims: readonly EvidenceClaim[],
  results: ReadonlyMap<string, GovernedResult>,
): ClaimValidation {
  const errors: string[] = [];
  const claims: EvidenceClaim[] = [];
  for (const [claimIndex, rawClaim] of rawClaims.entries()) {
    const parsed = evidenceClaimSchema.safeParse(rawClaim);
    if (!parsed.success) {
      errors.push(`claim_${claimIndex}:schema`);
      continue;
    }
    const claim = parsed.data;
    const resolved = resolveReferences(claim, results, claimIndex, errors);
    if (!resolved) continue;
    const claimErrors = validateClaim(claim, resolved, results);
    if (claimErrors.length) {
      errors.push(...claimErrors.map((error) => `claim_${claimIndex}:${error}`));
      continue;
    }
    claims.push({
      // Rendering model-authored comparative prose would re-introduce an
      // ordering ambiguity: a truthful pair of refs can accompany a sentence
      // that swaps the subject and comparator. Emit a server-owned sentence
      // whose row/metric/value ordering comes exclusively from validated refs.
      statement: canonicalClaimStatement(claim.assertion, resolved),
      assertion: claim.assertion,
      refs: claim.refs.map((ref) => ({ ...ref })),
    });
  }
  return Object.freeze({
    valid: errors.length === 0 && claims.length === rawClaims.length,
    claims: Object.freeze(claims),
    errors: Object.freeze(errors),
  });
}

export function renderValidatedClaims(claims: readonly EvidenceClaim[], maxLength = 4_000): string {
  return claims.map((claim) => claim.statement).join(" ").slice(0, maxLength).trim();
}

export function containsComparativeClaim(value: string): boolean {
  comparativeLexicon.lastIndex = 0;
  return comparativeLexicon.test(value);
}

function resolveReferences(
  claim: EvidenceClaim,
  results: ReadonlyMap<string, GovernedResult>,
  claimIndex: number,
  errors: string[],
): readonly ResolvedReference[] | null {
  const resolved: ResolvedReference[] = [];
  const unique = new Set<string>();
  for (const ref of claim.refs) {
    const key = referenceKey(ref);
    if (unique.has(key)) {
      errors.push(`claim_${claimIndex}:duplicate_ref`);
      return null;
    }
    unique.add(key);
    const result = results.get(ref.resultId);
    const row = result?.rows[ref.rowIndex];
    const column = result?.columns.find((candidate) => candidate.key === ref.columnKey);
    if (!result || !row || !column || !Object.hasOwn(row, ref.columnKey)) {
      errors.push(`claim_${claimIndex}:unknown_ref`);
      return null;
    }
    resolved.push({ ref, result, column, value: row[ref.columnKey] ?? null });
  }
  if (new Set(resolved.map((item) => item.ref.resultId)).size !== 1) {
    errors.push(`claim_${claimIndex}:cross_result_comparison`);
    return null;
  }
  return Object.freeze(resolved);
}

function validateClaim(
  claim: EvidenceClaim,
  refs: readonly ResolvedReference[],
  results: ReadonlyMap<string, GovernedResult>,
): readonly string[] {
  const errors: string[] = [];
  const numericRefs = refs.filter(isNumericReference);
  const labelRefs = refs.filter((ref) => !isNumericReference(ref));
  if (!numericRefs.length) errors.push("numeric_ref_required");

  for (const ref of refs) {
    if (!containsExactPhrase(claim.statement, ref.column.label)) errors.push("column_label_missing");
  }
  for (const ref of labelRefs) {
    if (ref.value === null || !containsExactPhrase(claim.statement, String(ref.value))) {
      errors.push("source_label_missing");
    }
  }

  const labelRows = new Set(labelRefs.map((ref) => `${ref.ref.resultId}:${ref.ref.rowIndex}`));
  const numericRows = new Set(numericRefs.map((ref) => `${ref.ref.resultId}:${ref.ref.rowIndex}`));
  if (labelRefs.some((ref) => !numericRows.has(`${ref.ref.resultId}:${ref.ref.rowIndex}`))) {
    errors.push("off_row_label_ref");
  }
  for (const numericRef of numericRefs) {
    const row = numericRef.result.rows[numericRef.ref.rowIndex] as Readonly<Record<string, TraceCell>>;
    const rowHasLabel = numericRef.result.columns.some((column) =>
      !isNumericColumn(column.type) && row[column.key] !== null && String(row[column.key]).trim().length > 0);
    if (rowHasLabel && !labelRows.has(`${numericRef.ref.resultId}:${numericRef.ref.rowIndex}`)) {
      errors.push("same_row_label_ref_required");
    }
  }

  const referencedLabels = new Set(labelRefs.map((ref) => referenceKey(ref.ref)));
  const referencedResult = refs[0]?.result;
  if (referencedResult) {
    referencedResult.rows.forEach((row, rowIndex) => {
      referencedResult.columns.forEach((column) => {
        if (isNumericColumn(column.type)) return;
        const value = row[column.key];
        if (value === null || !String(value).trim()) return;
        const key = referenceKey({ resultId: referencedResult.resultId, rowIndex, columnKey: column.key });
        if (!referencedLabels.has(key) && containsExactPhrase(claim.statement, String(value))) {
          errors.push("unreferenced_source_label");
        }
      });
    });
  }

  const maskedStatement = maskPhrases(claim.statement, [
    ...labelRefs.flatMap((ref) => ref.value === null ? [] : [String(ref.value)]),
    ...refs.map((ref) => ref.column.label),
  ]);
  const numericValues = numericRefs.map((ref) => ref.value);
  if (findUngroundedNumbersForCells(maskedStatement, numericValues).length) {
    errors.push("unreferenced_number");
  }
  const mentionedValues = new Set(normalizedQuantitativeClaims(maskedStatement));
  for (const ref of numericRefs) {
    const normalized = normalizedDecimalToken(ref.value);
    if (!normalized || !mentionedValues.has(normalized)) errors.push("cell_value_missing");
  }

  if (claim.assertion === "value") {
    comparativeLexicon.lastIndex = 0;
    if (comparativeLexicon.test(claim.statement)) errors.push("comparison_requires_typed_assertion");
  } else {
    const requiredLexicon = assertionLexicon[claim.assertion];
    requiredLexicon.lastIndex = 0;
    if (!requiredLexicon.test(claim.statement)) errors.push("assertion_wording_mismatch");
  }

  if (claim.assertion === "highest" || claim.assertion === "lowest") {
    if (numericRefs.length !== 1) errors.push("rank_requires_one_numeric_ref");
    else if (!validRank(numericRefs[0]!, claim.assertion)) errors.push("rank_not_supported");
  } else if (claim.assertion === "greater_than" || claim.assertion === "less_than" || claim.assertion === "equal") {
    if (numericRefs.length !== 2) errors.push("comparison_requires_two_numeric_refs");
    else if (!sameComparableMetric(numericRefs[0]!, numericRefs[1]!)) errors.push("comparison_metric_mismatch");
    else if (!validComparison(numericRefs[0]!, numericRefs[1]!, claim.assertion)) errors.push("comparison_not_supported");
  } else if (numericRefs.length !== 1) {
    errors.push("value_requires_one_numeric_ref");
  }

  // The map is accepted as an argument intentionally: callers must validate
  // against the exact full result registry, never a model-supplied row subset.
  if (!refs.every((ref) => results.get(ref.ref.resultId) === ref.result)) errors.push("result_registry_changed");
  return Object.freeze([...new Set(errors)]);
}

function sameComparableMetric(left: ResolvedReference, right: ResolvedReference): boolean {
  return left.ref.columnKey === right.ref.columnKey
    && left.column.type === right.column.type
    && (left.column.currency ?? null) === (right.column.currency ?? null);
}

function canonicalClaimStatement(
  assertion: EvidenceClaim["assertion"],
  refs: readonly ResolvedReference[],
): string {
  const numericRefs = refs.filter(isNumericReference);
  const labelRefs = refs.filter((ref) => !isNumericReference(ref));
  const describeRow = (numericRef: ResolvedReference): string => {
    const labels = labelRefs
      .filter((labelRef) => labelRef.ref.resultId === numericRef.ref.resultId
        && labelRef.ref.rowIndex === numericRef.ref.rowIndex)
      .map((labelRef) => `${labelRef.column.label} ${String(labelRef.value)}`);
    return labels.join(", ") || `Row ${numericRef.ref.rowIndex + 1}`;
  };
  const describeValue = (numericRef: ResolvedReference): string => {
    const value = normalizedDecimalToken(numericRef.value) ?? String(numericRef.value);
    if (numericRef.column.type === "currency") {
      return numericRef.column.currency ? `${numericRef.column.currency} ${value}` : value;
    }
    return numericRef.column.type === "percent" ? `${value}%` : value;
  };

  const left = numericRefs[0];
  if (!left) return "Validated evidence was unavailable.";
  const leftSubject = describeRow(left);
  const metric = left.column.label;
  const leftValue = describeValue(left);
  if (assertion === "value") return `${leftSubject} had ${metric} of ${leftValue}.`;
  if (assertion === "highest") return `${leftSubject} had the highest ${metric} at ${leftValue}.`;
  if (assertion === "lowest") return `${leftSubject} had the lowest ${metric} at ${leftValue}.`;

  const right = numericRefs[1];
  if (!right) return "Validated comparison evidence was unavailable.";
  const rightSubject = describeRow(right);
  const rightValue = describeValue(right);
  if (assertion === "greater_than") {
    return `${leftSubject} ${metric} of ${leftValue} was higher than ${rightSubject} ${metric} of ${rightValue}.`;
  }
  if (assertion === "less_than") {
    return `${leftSubject} ${metric} of ${leftValue} was lower than ${rightSubject} ${metric} of ${rightValue}.`;
  }
  return `${leftSubject} ${metric} of ${leftValue} equalled ${rightSubject} ${metric} of ${rightValue}.`;
}

function validRank(ref: ResolvedReference, assertion: "highest" | "lowest"): boolean {
  const resultWindow = ref.result.resultWindow;
  const primaryOrdering = resultWindow?.orderBy[0];
  const requiredDirection = assertion === "highest" ? "desc" : "asc";
  if (
    !resultWindow
    || resultWindow.orderedBeforeLimit !== true
    || resultWindow.requestedLimit < ref.result.rows.length
    || primaryOrdering?.columnKey !== ref.ref.columnKey
    || primaryOrdering.direction !== requiredDirection
  ) {
    return false;
  }
  const values = ref.result.rows.flatMap((row) => {
    const value = row[ref.ref.columnKey];
    const parsed = decimal(value);
    return value === null || parsed === null ? [] : [parsed];
  });
  const selected = decimal(ref.value);
  if (!selected || !values.length) return false;
  return values.every((value) => assertion === "highest"
    ? compareDecimal(selected, value) >= 0
    : compareDecimal(selected, value) <= 0);
}

function validComparison(
  left: ResolvedReference,
  right: ResolvedReference,
  assertion: "greater_than" | "less_than" | "equal",
): boolean {
  const leftValue = decimal(left.value);
  const rightValue = decimal(right.value);
  if (!leftValue || !rightValue) return false;
  const comparison = compareDecimal(leftValue, rightValue);
  if (assertion === "greater_than") return comparison > 0;
  if (assertion === "less_than") return comparison < 0;
  return comparison === 0;
}

function isNumericReference(ref: ResolvedReference): boolean {
  return isNumericColumn(ref.column.type) && decimal(ref.value) !== null;
}

function isNumericColumn(type: GovernedResult["columns"][number]["type"]): boolean {
  return type === "number" || type === "currency" || type === "percent";
}

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;
function decimal(value: TraceCell): Decimal | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const normalized = String(value).trim().replace(/[$,%+]/gu, "");
  const match = normalized.match(/^(-?)(\d+)(?:\.(\d+))?$/u);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const coefficient = BigInt(`${match[1] ?? ""}${match[2]}${fraction}`);
  return Object.freeze({ coefficient, scale: fraction.length });
}

function compareDecimal(left: Decimal, right: Decimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * (10n ** BigInt(scale - left.scale));
  const rightValue = right.coefficient * (10n ** BigInt(scale - right.scale));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function normalizedDecimalToken(value: TraceCell): string | null {
  const parsed = decimal(value);
  if (!parsed) return null;
  if (parsed.coefficient === 0n) return "0";
  let coefficient = parsed.coefficient;
  let scale = parsed.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  const rendered = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return `${negative ? "-" : ""}${rendered}`;
}

function referenceKey(ref: ClaimCellReference): string {
  return `${ref.resultId}:${ref.rowIndex}:${ref.columnKey}`;
}

function containsExactPhrase(value: string, phrase: string): boolean {
  const normalized = phrase.trim();
  if (!normalized) return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(normalized).replace(/\s+/gu, "\\s+")}(?![\\p{L}\\p{N}])`, "iu");
  return pattern.test(value);
}

function maskPhrases(value: string, phrases: readonly string[]): string {
  return [...new Set(phrases.filter((phrase) => phrase.trim()).sort((left, right) => right.length - left.length))]
    .reduce((masked, phrase) => masked.replace(new RegExp(escapeRegExp(phrase), "giu"), " label "), value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
