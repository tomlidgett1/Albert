export type CanonicalDimensionStateClaim = Readonly<{
  canonicalId: string;
  sourceUpdatedAt: unknown;
  sourceVersion: string | null;
  payloadHash: string;
  mappingVersion: string;
}>;

export type CanonicalDimensionCandidate<Value> = CanonicalDimensionStateClaim & Readonly<{
  value: Value;
}>;

export type CanonicalDimensionReduction<Value> = Readonly<{
  winners: readonly Value[];
  forceClaimCanonicalIds: readonly string[];
}>;

type NormalizedClaim<Value> = Readonly<{
  canonicalId: string;
  sourceUpdatedAt: string;
  sourceVersion: string | null;
  payloadHash: string;
  mappingVersion: string;
  value: Value;
  inputIndex: number;
}>;

const CANONICAL_EPOCH = new Date(0).toISOString();

/**
 * Reproduce canonical_record_state's admission rule for identities which occur
 * more than once in one mapper batch.
 *
 * The database admits a candidate only when its effective source time is not
 * older and at least one of source version, payload hash, or mapping version
 * changed. Reducing by timestamp alone is subtly wrong: an identical replay at
 * a later timestamp does not claim state, while A -> B -> A at increasing
 * timestamps does. The latter finishes with the same signature it started
 * with, so `forceClaimCanonicalIds` tells the set-based upsert that the final A
 * is the result of a real in-batch transition rather than an identical no-op.
 *
 * Winners retain the relative order of their selected source observations.
 */
export function reduceCanonicalDimensionCandidates<Value>(
  candidates: readonly CanonicalDimensionCandidate<Value>[],
  currentStates: readonly CanonicalDimensionStateClaim[],
): CanonicalDimensionReduction<Value> {
  const initialById = new Map<string, NormalizedClaim<undefined>>();
  for (const state of currentStates) {
    if (initialById.has(state.canonicalId)) {
      throw new Error("canonical_dimension_reducer_state_duplicate");
    }
    initialById.set(state.canonicalId, normalizeClaim(state, undefined, -1));
  }

  const grouped = new Map<string, NormalizedClaim<Value>[]>();
  candidates.forEach((candidate, inputIndex) => {
    if (!candidate.canonicalId) {
      throw new Error("canonical_dimension_reducer_identity_missing");
    }
    const normalized = normalizeClaim(candidate, candidate.value, inputIndex);
    const group = grouped.get(candidate.canonicalId);
    if (group) group.push(normalized);
    else grouped.set(candidate.canonicalId, [normalized]);
  });

  const selected: NormalizedClaim<Value>[] = [];
  const forced = new Set<string>();
  for (const [canonicalId, observations] of grouped) {
    const initial = initialById.get(canonicalId);
    let simulated: NormalizedClaim<Value> | NormalizedClaim<undefined> | undefined = initial;
    let winner: NormalizedClaim<Value> | undefined;
    for (const observation of observations) {
      if (!simulated || candidateClaims(simulated, observation)) {
        simulated = observation;
        winner = observation;
      }
    }
    if (!winner) continue;

    // The row is locked by the caller before this plan is executed. A forced
    // claim is therefore narrowly scoped to a transition proven against this
    // exact initial signature, never a bypass of source-time admission.
    if (initial && !candidateClaims(initial, winner)) forced.add(canonicalId);
    selected.push(winner);
  }

  selected.sort((left, right) => left.inputIndex - right.inputIndex);
  return Object.freeze({
    winners: Object.freeze(selected.map(({ value }) => value)),
    forceClaimCanonicalIds: Object.freeze([...forced].sort()),
  });
}

function normalizeClaim<Value>(
  claim: CanonicalDimensionStateClaim,
  value: Value,
  inputIndex: number,
): NormalizedClaim<Value> {
  return Object.freeze({
    canonicalId: claim.canonicalId,
    sourceUpdatedAt: instantOrEpoch(claim.sourceUpdatedAt),
    sourceVersion: claim.sourceVersion,
    payloadHash: claim.payloadHash,
    mappingVersion: claim.mappingVersion,
    value,
    inputIndex,
  });
}

function candidateClaims(
  current: NormalizedClaim<unknown>,
  candidate: NormalizedClaim<unknown>,
): boolean {
  return candidate.sourceUpdatedAt >= current.sourceUpdatedAt && (
    candidate.payloadHash !== current.payloadHash ||
    candidate.sourceVersion !== current.sourceVersion ||
    candidate.mappingVersion !== current.mappingVersion
  );
}

function instantOrEpoch(value: unknown): string {
  if (value === null || value === undefined) return CANONICAL_EPOCH;
  const parsed = new Date(value as string | number | Date);
  return Number.isNaN(parsed.valueOf()) ? CANONICAL_EPOCH : parsed.toISOString();
}
