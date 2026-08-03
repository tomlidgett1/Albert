import { assertCurrency, Decimal4 } from "./decimal.js";
import { factsById } from "./declarations.js";
import type {
  AuthorityRule,
  CanonicalCandidate,
  IdentitySourceObservation,
  IdentitySuggestion,
  SourceAuthorityConcept,
} from "./types.js";

export type CanonicalRecord = Readonly<{
  tenantId: string;
  id: string;
  fact: keyof typeof factsById;
  values: Readonly<Record<string, unknown>>;
  lineage: Readonly<{
    connectionId: string;
    sourceObjectType: string;
    sourceRecordId: string;
    syncRunId: string;
    sourceUpdatedAt?: string;
  }>;
}>;

export type RejectedCandidate = Readonly<{
  candidate: CanonicalCandidate<Readonly<Record<string, unknown>>>;
  reason: "invalid_candidate" | "non_authoritative_source";
  details: string;
}>;

export type CanonicalizationResult = Readonly<{
  accepted: readonly CanonicalRecord[];
  rejected: readonly RejectedCandidate[];
}>;

const moneyFieldPattern = /(?:^|_)(?:amount|cost|price|value)$/;
const currencyFieldPattern = /(?:^|_)currency$/;

/**
 * Applies the source-authority contract to connector-pack output. Connector-specific
 * mapping deliberately lives before this boundary; this function only accepts
 * source-neutral canonical candidates.
 */
export function canonicalizeCandidates(
  candidates: readonly CanonicalCandidate<Readonly<Record<string, unknown>>>[],
  authorityRules: readonly AuthorityRule[],
  asOf: string,
): CanonicalizationResult {
  const accepted: CanonicalRecord[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const candidate of candidates) {
    try {
      validateCandidate(candidate);
    } catch (error) {
      rejected.push({
        candidate,
        reason: "invalid_candidate",
        details: error instanceof Error ? error.message : "Candidate validation failed.",
      });
      continue;
    }

    const rule = resolveAuthorityRule(
      authorityRules,
      candidate.tenantId,
      candidate.authorityConcept,
      candidate.values,
      asOf,
    );

    if (!rule || rule.connectionId !== candidate.source.connectionId) {
      rejected.push({
        candidate,
        reason: "non_authoritative_source",
        details: rule
          ? `Authority for ${candidate.authorityConcept} is ${rule.connectionId}.`
          : `No effective authority rule for ${candidate.authorityConcept}.`,
      });
      continue;
    }

    accepted.push({
      tenantId: candidate.tenantId,
      id: candidate.id,
      fact: candidate.fact,
      values: normalizeExactValues(candidate.values),
      lineage: {
        ...candidate.source,
        syncRunId: candidate.syncRunId,
        ...(candidate.sourceUpdatedAt ? { sourceUpdatedAt: candidate.sourceUpdatedAt } : {}),
      },
    });
  }

  return { accepted, rejected };
}

export function resolveAuthorityRule(
  rules: readonly AuthorityRule[],
  tenantId: string,
  concept: SourceAuthorityConcept,
  values: Readonly<Record<string, unknown>>,
  asOf: string,
): AuthorityRule | undefined {
  const instant = parseInstant(asOf, "authority evaluation timestamp");
  const candidates = rules.filter((rule) => {
    if (rule.concept !== concept) return false;
    const effectiveFrom = parseInstant(rule.effectiveFrom, "authority effectiveFrom");
    const effectiveTo = rule.effectiveTo
      ? parseInstant(rule.effectiveTo, "authority effectiveTo")
      : Number.POSITIVE_INFINITY;
    if (instant < effectiveFrom || instant >= effectiveTo) return false;

    if (rule.scopeType === "tenant") return rule.scopeId === tenantId;
    const scopeKey = rule.scopeType === "location" ? "location_id" : "legal_entity_id";
    return values[scopeKey] === rule.scopeId;
  });

  const specificity = { tenant: 0, legal_entity: 1, location: 2 } as const;
  candidates.sort((left, right) => specificity[right.scopeType] - specificity[left.scopeType]);

  if (candidates.length > 1 && candidates[0]?.scopeType === candidates[1]?.scopeType) {
    throw new Error(
      `Overlapping ${candidates[0].scopeType} authority rules for ${concept} at ${asOf}.`,
    );
  }
  return candidates[0];
}

export function validateAuthorityRules(rules: readonly AuthorityRule[]): void {
  for (const rule of rules) {
    const start = parseInstant(rule.effectiveFrom, "authority effectiveFrom");
    const end = rule.effectiveTo
      ? parseInstant(rule.effectiveTo, "authority effectiveTo")
      : Number.POSITIVE_INFINITY;
    if (end <= start) throw new Error("Authority effectiveTo must be later than effectiveFrom.");
  }

  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    const left = rules[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < rules.length; rightIndex += 1) {
      const right = rules[rightIndex];
      if (!right) continue;
      if (
        left.concept !== right.concept ||
        left.scopeType !== right.scopeType ||
        left.scopeId !== right.scopeId
      ) continue;

      const leftStart = parseInstant(left.effectiveFrom, "authority effectiveFrom");
      const leftEnd = left.effectiveTo
        ? parseInstant(left.effectiveTo, "authority effectiveTo")
        : Number.POSITIVE_INFINITY;
      const rightStart = parseInstant(right.effectiveFrom, "authority effectiveFrom");
      const rightEnd = right.effectiveTo
        ? parseInstant(right.effectiveTo, "authority effectiveTo")
        : Number.POSITIVE_INFINITY;
      if (leftStart < rightEnd && rightStart < leftEnd) {
        throw new Error(
          `Overlapping authority rules for ${left.concept}/${left.scopeType}/${left.scopeId}.`,
        );
      }
    }
  }
}

export function buildIdentitySuggestions(
  observations: readonly IdentitySourceObservation[],
): readonly IdentitySuggestion[] {
  const effectiveObservations = enrichIdentityEvidence(observations);
  const suggestions: IdentitySuggestion[] = [];

  for (let leftIndex = 0; leftIndex < effectiveObservations.length; leftIndex += 1) {
    const left = effectiveObservations[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < effectiveObservations.length; rightIndex += 1) {
      const right = effectiveObservations[rightIndex];
      if (!right || left.connectionId === right.connectionId) continue;
      if (left.tenantId !== right.tenantId || left.entityType !== right.entityType) continue;

      if (left.externalId && right.externalId && left.externalId === right.externalId) {
        suggestions.push({
          left,
          right,
          matchMethod: "external_id",
          matchStatus: "accepted",
          confidenceBand: "high",
          evidence: { external_id: left.externalId },
        });
        continue;
      }

      const commonKeys = commonDeterministicKeys(left.deterministicKeys, right.deterministicKeys);
      if (Object.keys(commonKeys).length > 0) {
        suggestions.push({
          left,
          right,
          matchMethod: "deterministic_key",
          matchStatus: "accepted",
          confidenceBand: "high",
          evidence: commonKeys,
        });
        continue;
      }

      // Names are never accepted as joins. They can only raise a reviewable suggestion
      // when independently corroborated by the same organisational scope.
      if (
        left.normalizedName &&
        right.normalizedName &&
        left.normalizedName === right.normalizedName &&
        left.corroboratingScope &&
        left.corroboratingScope === right.corroboratingScope
      ) {
        suggestions.push({
          left,
          right,
          matchMethod: "composite_suggestion",
          matchStatus: "proposed",
          confidenceBand: "medium",
          evidence: {
            normalized_name: left.normalizedName,
            corroborating_scope: left.corroboratingScope,
          },
        });
      }
    }
  }

  return suggestions;
}

/**
 * Resolve connector-pack-declared lookup evidence without teaching the core
 * matcher about any vendor pair. Conflicting values for one evidence key are
 * omitted rather than selected arbitrarily.
 */
function enrichIdentityEvidence(
  observations: readonly IdentitySourceObservation[],
): readonly IdentitySourceObservation[] {
  const bySource = new Map(observations.map((observation) => [
    identityObservationKey(observation, observation.sourceObjectType, observation.sourceRecordId),
    observation,
  ]));
  return observations
    .filter((observation) => observation.linkable !== false)
    .map((observation) => {
      const keys: Record<string, string | undefined> = { ...observation.deterministicKeys };
      const conflicts = new Set<string>();
      const references = [...(observation.evidenceRefs ?? [])].sort((left, right) =>
        `${left.sourceObjectType}\u001f${left.sourceRecordId}`.localeCompare(
          `${right.sourceObjectType}\u001f${right.sourceRecordId}`,
        )
      );
      for (const reference of references) {
        const evidence = bySource.get(identityObservationKey(
          observation,
          reference.sourceObjectType,
          reference.sourceRecordId,
        ));
        if (!evidence) continue;
        for (const [key, value] of Object.entries(evidence.deterministicKeys)) {
          if (!value || conflicts.has(key)) continue;
          if (!keys[key]) keys[key] = value;
          else if (keys[key] !== value) {
            delete keys[key];
            conflicts.add(key);
          }
        }
      }
      return Object.freeze({ ...observation, deterministicKeys: Object.freeze(keys) });
    });
}

function identityObservationKey(
  observation: Pick<IdentitySourceObservation, "tenantId" | "entityType" | "connectionId">,
  sourceObjectType: string,
  sourceRecordId: string,
): string {
  return [
    observation.tenantId,
    observation.entityType,
    observation.connectionId,
    sourceObjectType,
    sourceRecordId,
  ].join("\u001f");
}

function validateCandidate(candidate: CanonicalCandidate<Readonly<Record<string, unknown>>>): void {
  if (!candidate.tenantId || !candidate.id || !candidate.syncRunId) {
    throw new Error("tenantId, id and syncRunId are required.");
  }
  if (!factsById[candidate.fact]) throw new Error(`Unknown canonical fact: ${candidate.fact}`);
  if (!candidate.source.connectionId || !candidate.source.sourceObjectType || !candidate.source.sourceRecordId) {
    throw new Error("Complete immutable source lineage is required.");
  }
  if (candidate.sourceUpdatedAt) parseInstant(candidate.sourceUpdatedAt, "sourceUpdatedAt");
}

function normalizeExactValues(values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        if (currencyFieldPattern.test(key) && typeof value === "string") {
          return [key, assertCurrency(value)];
        }
        if (moneyFieldPattern.test(key) && typeof value === "string") {
          return [key, Decimal4.from(value).toString()];
        }
        return [key, value];
      }),
    ),
  );
}

function commonDeterministicKeys(
  left: Readonly<Record<string, string | undefined>>,
  right: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const common: Record<string, string> = {};
  for (const [key, leftValue] of Object.entries(left)) {
    if (leftValue && right[key] && leftValue === right[key]) common[key] = leftValue;
  }
  return common;
}

function parseInstant(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${label}: ${value}`);
  return timestamp;
}
