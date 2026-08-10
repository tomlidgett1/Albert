import { createHash } from "node:crypto";

import { z } from "zod";

export const semanticTerminalStateV2Schema = z.enum([
  "verified",
  "derived",
  "exploratory",
  "clarification",
  "no_data",
  "unavailable",
]);
export type SemanticTerminalStateV2 = z.infer<
  typeof semanticTerminalStateV2Schema
>;

export const evidenceReferenceV2Schema = z
  .object({
    executionId: z.string().min(1),
    resultId: z.string().min(1),
    rowIndex: z.number().int().nonnegative().optional(),
    columnKey: z.string().min(1).optional(),
    operatorArtifactId: z.string().min(1).optional(),
    operatorOutputPath: z
      .array(
        z.union([z.string().min(1).max(160), z.number().int().nonnegative()]),
      )
      .min(1)
      .max(12)
      .optional(),
    publicationHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((reference, context) => {
    const cell =
      reference.rowIndex !== undefined || reference.columnKey !== undefined;
    if (
      cell &&
      (reference.rowIndex === undefined || reference.columnKey === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Cell references require both rowIndex and columnKey.",
      });
    if (!cell && !reference.operatorArtifactId)
      context.addIssue({
        code: "custom",
        message: "Evidence must reference a result cell or operator artifact.",
      });
    if (reference.operatorArtifactId && cell)
      context.addIssue({
        code: "custom",
        message:
          "An evidence reference must select either one result cell or one operator output, not both.",
      });
    if (reference.operatorArtifactId && !reference.operatorOutputPath)
      context.addIssue({
        code: "custom",
        message: "Operator evidence requires an exact operatorOutputPath.",
        path: ["operatorOutputPath"],
      });
    if (!reference.operatorArtifactId && reference.operatorOutputPath)
      context.addIssue({
        code: "custom",
        message: "operatorOutputPath is valid only with an operator artifact.",
        path: ["operatorOutputPath"],
      });
  });
export type EvidenceReferenceV2 = z.infer<typeof evidenceReferenceV2Schema>;

export const groundedClaimV2Schema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1).max(2000),
    type: z.enum([
      "numeric",
      "comparative",
      "descriptive",
      "causal",
      "recommendation",
    ]),
    evidenceRefs: z.array(evidenceReferenceV2Schema).min(1).max(40),
    semanticState: z.enum(["verified", "derived", "exploratory"]),
    limitations: z.array(z.string().min(1)).default([]),
    controllability: z.enum(["high", "medium", "low"]).optional(),
    competingHypothesisRefs: z.array(z.string().min(1)).default([]),
    opportunityValue: z
      .string()
      .regex(/^-?\d+(?:\.\d{1,4})?$/)
      .optional(),
  })
  .strict()
  .superRefine((claim, context) => {
    if (claim.type === "causal" && claim.competingHypothesisRefs.length === 0)
      context.addIssue({
        code: "custom",
        message: "Causal claims require competing-hypothesis evidence.",
        path: ["competingHypothesisRefs"],
      });
    if (claim.type === "recommendation") {
      if (!claim.controllability)
        context.addIssue({
          code: "custom",
          message: "Recommendations require controllability.",
          path: ["controllability"],
        });
      if (!claim.opportunityValue)
        context.addIssue({
          code: "custom",
          message: "Recommendations require deterministic opportunity sizing.",
          path: ["opportunityValue"],
        });
      else if (
        !Number.isFinite(Number(claim.opportunityValue)) ||
        Number(claim.opportunityValue) <= 0
      )
        context.addIssue({
          code: "custom",
          message: "Recommendation opportunity sizing must be positive.",
          path: ["opportunityValue"],
        });
      if (claim.limitations.length === 0)
        context.addIssue({
          code: "custom",
          message: "Recommendations require at least one explicit limitation.",
          path: ["limitations"],
        });
    }
  });
export type GroundedClaimV2 = z.infer<typeof groundedClaimV2Schema>;

export type OperatorOutputResolutionV2 = Readonly<{
  found: boolean;
  value?: unknown;
}>;

/** Resolves a claim's exact typed path inside an immutable operator output. */
export function resolveOperatorOutputPathV2(
  output: unknown,
  path: readonly (string | number)[],
): OperatorOutputResolutionV2 {
  let current = output;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length)
        return Object.freeze({ found: false });
      current = current[segment];
      continue;
    }
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    )
      return Object.freeze({ found: false });
    current = (current as Record<string, unknown>)[segment];
  }
  return Object.freeze({ found: true, value: current });
}

export type ClaimOperatorValueV2 = Readonly<{
  operatorId: string;
  path: readonly (string | number)[];
  value: unknown;
}>;

/** Governs the two deterministic outputs required by every recommendation. */
export function validateRecommendationOperatorEvidenceV2(
  claim: GroundedClaimV2,
  operatorValues: readonly ClaimOperatorValueV2[],
): readonly string[] {
  if (claim.type !== "recommendation") return Object.freeze([]);
  const issues: string[] = [];
  const opportunityValues = operatorValues
    .filter(
      ({ operatorId, path }) =>
        operatorId === "opportunity_sizing" &&
        ["netOpportunity", "totalNetOpportunity"].includes(
          String(path.at(-1)),
        ),
    )
    .map(({ value }) => value);
  if (opportunityValues.length === 0)
    issues.push("Recommendation lacks governed opportunity-sizing evidence.");
  else if (
    findUngroundedClaimNumbersV2(
      claim.opportunityValue ?? "",
      opportunityValues,
    ).length > 0
  )
    issues.push(
      "Recommendation opportunity value is absent from its exact opportunity-sizing output.",
    );
  const controllabilityValues = operatorValues
    .filter(
      ({ operatorId, path }) =>
        operatorId === "constraint_controllability" &&
        path.at(-1) === "controllability",
    )
    .map(({ value }) => value);
  if (!controllabilityValues.some((value) => value === claim.controllability))
    issues.push(
      "Recommendation controllability is absent from its exact constraint output.",
    );
  return Object.freeze(issues);
}

function stableStringifyV2(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableStringifyV2).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringifyV2(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function semanticInsightPropositionV2(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-+]?\d[\d,.]*(?:%|\b)/gu, "#")
    .replace(/[^a-z0-9#]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function semanticInsightKeyV2(
  claim: Pick<GroundedClaimV2, "type" | "text">,
): string {
  return createHash("sha256")
    .update(
      stableStringifyV2({
        type: claim.type,
        proposition: semanticInsightPropositionV2(claim.text),
      }),
    )
    .digest("hex");
}

export function semanticClaimEvidenceDigestV2(
  governedEvidence: readonly unknown[],
): string {
  return createHash("sha256")
    .update(stableStringifyV2(governedEvidence))
    .digest("hex");
}

export type InsightEvidenceCandidateV2 = Readonly<{
  claim: GroundedClaimV2;
  governedEvidence: readonly unknown[];
}>;

export function unchangedInsightClaimIdsV2(
  questionClass: string | null,
  current: readonly InsightEvidenceCandidateV2[],
  prior: readonly Readonly<{
    insightKey: string;
    evidenceDigest: string;
  }>[],
): ReadonlySet<string> {
  if (
    questionClass !== "recommendation" &&
    questionClass !== "open_exploration"
  )
    return new Set();
  const priorByKey = new Map(
    prior.map(({ insightKey, evidenceDigest }) => [insightKey, evidenceDigest]),
  );
  return new Set(
    current.flatMap(({ claim, governedEvidence }) =>
      priorByKey.get(semanticInsightKeyV2(claim)) ===
      semanticClaimEvidenceDigestV2(governedEvidence)
        ? [claim.id]
        : [],
    ),
  );
}

export const resultEvidenceV2Schema = z
  .object({
    executionId: z.string().min(1),
    resultId: z.string().min(1),
    state: z.enum([
      "verified",
      "derived",
      "exploratory",
      "no_data",
      "unavailable",
    ]),
    rowCount: z.number().int().nonnegative(),
    validationPassed: z.boolean(),
    publicationHash: z.string().regex(/^[a-f0-9]{64}$/),
    limitations: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.state === "no_data" && result.rowCount !== 0)
      context.addIssue({
        code: "custom",
        message: "No-data results must contain zero rows.",
      });
    if (
      ["verified", "derived"].includes(result.state) &&
      !result.validationPassed
    )
      context.addIssue({
        code: "custom",
        message: `${result.state} results require passing validation.`,
      });
  });
export type ResultEvidenceV2 = z.infer<typeof resultEvidenceV2Schema>;

const claimNumericTokenPatternV2 =
  /(?<![\p{L}\d])[-+]?\$?\d[\d,]*(?:\.\d+)?\s?(?:%|k|m|bn|b)?(?![\p{L}\d])/giu;
const claimListMarkerPatternV2 = /^[ \t]*(?:[-*]\s*)?\d+[.)](?=\s)/gmu;
const claimMagnitudeScalesV2: Readonly<Record<string, number>> = Object.freeze({
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  bn: 1_000_000_000,
});

type ClaimNumericTokenV2 = Readonly<{
  token: string;
  value: number;
  decimals: number;
  scale: number;
  percent: boolean;
  signed: boolean;
}>;

function parseClaimNumericTokenV2(token: string): ClaimNumericTokenV2 | null {
  const trimmed = token.trim();
  const match = /^([-+]?)\$?([\d,]*\d)(?:\.(\d+))?\s?(%|k|m|bn|b)?$/iu.exec(
    trimmed,
  );
  if (!match) return null;
  const [, sign, integerPart, fractionPart, suffix] = match;
  const value = Number(
    `${sign === "-" ? "-" : ""}${integerPart!.replaceAll(",", "")}${fractionPart ? `.${fractionPart}` : ""}`,
  );
  if (!Number.isFinite(value)) return null;
  const normalizedSuffix = suffix?.toLowerCase();
  return Object.freeze({
    token: trimmed,
    value,
    decimals: fractionPart?.length ?? 0,
    scale:
      normalizedSuffix && normalizedSuffix !== "%"
        ? (claimMagnitudeScalesV2[normalizedSuffix] ?? 1)
        : 1,
    percent: normalizedSuffix === "%",
    signed: sign === "-" || sign === "+",
  });
}

function claimNumericTokensV2(
  narrative: string,
): readonly ClaimNumericTokenV2[] {
  claimNumericTokenPatternV2.lastIndex = 0;
  return (
    narrative
      .replace(claimListMarkerPatternV2, "")
      .match(claimNumericTokenPatternV2) ?? []
  )
    .map(parseClaimNumericTokenV2)
    .filter((token): token is ClaimNumericTokenV2 => token !== null);
}

function roundClaimNumberV2(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return (
    Math.round(
      (value + Number.EPSILON * Math.sign(value) * Math.abs(value)) * factor,
    ) / factor
  );
}

function claimTokenMatchesValueV2(
  token: ClaimNumericTokenV2,
  evidence: number,
): boolean {
  const signedCandidates = token.signed
    ? [evidence]
    : [evidence, Math.abs(evidence)];
  const candidates = token.percent
    ? [
        ...signedCandidates,
        ...signedCandidates.map((candidate) => candidate * 100),
      ]
    : signedCandidates;
  return candidates.some((candidate) => {
    const scaled = candidate / token.scale;
    if (scaled === token.value) return true;
    if (token.decimals > 6 || (token.decimals === 0 && Math.abs(scaled) < 10))
      return false;
    return roundClaimNumberV2(scaled, token.decimals) === token.value;
  });
}

function collectClaimEvidenceNumbersV2(value: unknown, output: number[]): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) output.push(value);
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[-+]?\$?\d[\d,]*(?:\.\d+)?%?$/u.test(trimmed)) {
      const parsed = Number(trimmed.replace(/[$,%+]/gu, ""));
      if (Number.isFinite(parsed)) output.push(parsed);
    }
    const date = /^(\d{4})-(\d{2})-(\d{2})/u.exec(trimmed);
    if (date) output.push(Number(date[1]), Number(date[2]), Number(date[3]));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectClaimEvidenceNumbersV2(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>))
      collectClaimEvidenceNumbersV2(item, output);
  }
}

/**
 * Enforces claim-local numerical grounding. A figure may be rendered with
 * natural rounding, currency, percentage, or magnitude notation, but it must
 * match a value from this claim's exact cited cells or operator artifact.
 * Global result rows deliberately are not admissible here: citing an unrelated
 * cell that happens to contain the same figure is not evidence for a claim.
 */
export function findUngroundedClaimNumbersV2(
  narrative: string,
  citedEvidence: readonly unknown[],
): readonly string[] {
  const values: number[] = [];
  for (const evidence of citedEvidence)
    collectClaimEvidenceNumbersV2(evidence, values);
  return Object.freeze(
    claimNumericTokensV2(narrative)
      .filter(
        (token) =>
          !values.some((value) => claimTokenMatchesValueV2(token, value)),
      )
      .map(({ token }) => token),
  );
}

const confidenceRank: Readonly<
  Record<"verified" | "derived" | "exploratory", number>
> = { exploratory: 0, derived: 1, verified: 2 };

export function deriveAnswerStateV2(
  input: Readonly<{
    results: readonly ResultEvidenceV2[];
    claims: readonly GroundedClaimV2[];
    clarificationRequired?: boolean;
  }>,
): SemanticTerminalStateV2 {
  if (input.clarificationRequired) return "clarification";
  if (input.results.some(({ state }) => state === "unavailable"))
    return "unavailable";
  if (
    input.results.length > 0 &&
    input.results.every(({ state }) => state === "no_data")
  )
    return "no_data";
  if (input.claims.length === 0)
    return input.results.some(({ state }) => state === "no_data")
      ? "no_data"
      : "unavailable";
  const weakestClaim = input.claims.reduce(
    (weakest, claim) =>
      confidenceRank[claim.semanticState] < confidenceRank[weakest]
        ? claim.semanticState
        : weakest,
    "verified" as "verified" | "derived" | "exploratory",
  );
  return weakestClaim;
}

export function validateClaimEvidenceV2(
  claim: GroundedClaimV2,
  results: readonly ResultEvidenceV2[],
): readonly string[] {
  const byId = new Map(
    results.map((result) => [
      `${result.executionId}:${result.resultId}`,
      result,
    ]),
  );
  const issues: string[] = [];
  for (const reference of claim.evidenceRefs) {
    if (reference.operatorArtifactId && claim.semanticState === "verified")
      issues.push(
        `Claim ${claim.id} is operator-derived and cannot be Verified.`,
      );
    const result = byId.get(`${reference.executionId}:${reference.resultId}`);
    if (!result)
      issues.push(
        `Claim ${claim.id} references unknown result ${reference.executionId}:${reference.resultId}.`,
      );
    else if (result.publicationHash !== reference.publicationHash)
      issues.push(`Claim ${claim.id} crosses semantic publications.`);
    else if (result.state === "unavailable" || result.state === "no_data")
      issues.push(`Claim ${claim.id} relies on ${result.state} evidence.`);
    else if (confidenceRank[claim.semanticState] > confidenceRank[result.state])
      issues.push(
        `Claim ${claim.id} exceeds result ${result.resultId}'s confidence.`,
      );
  }
  return Object.freeze(issues);
}
