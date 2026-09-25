import type { CubeFilter, CubeQuery, CubeTimeDimension } from "../../albert-v3/src/cube/types.js";

export type OmniMemberKind = Readonly<{
  kind: "measure" | "dimension" | "segment";
  type?: "string" | "number" | "boolean" | "time";
}>;

const STRING_ONLY_OPERATORS = new Set([
  "contains", "notContains", "startsWith", "notStartsWith", "endsWith", "notEndsWith",
]);

function timeFilterMisuse(
  filters: readonly CubeFilter[] | undefined,
  memberKinds: ReadonlyMap<string, OmniMemberKind>,
  errors: string[],
): void {
  for (const filter of filters ?? []) {
    if ("and" in filter) { timeFilterMisuse(filter.and, memberKinds, errors); continue; }
    if ("or" in filter) { timeFilterMisuse(filter.or, memberKinds, errors); continue; }
    if (memberKinds.get(filter.member)?.type === "time" && STRING_ONLY_OPERATORS.has(filter.operator)) {
      errors.push(`${filter.member} is a time field; "${filter.operator}" is a text operator. Use inDateRange, beforeDate or afterDate — or better, constrain time with timeDimensions.dateRange.`);
    }
  }
}

/**
 * Deterministic repairs for the query shapes models most often get slightly
 * wrong. Every repair is meaning-preserving and disclosed back to the model
 * as an adjustment note; anything ambiguous is left for the validator's
 * specific error message. Production batteries showed each of these classes
 * costing a full model round-trip per occurrence:
 *
 * - a one-entry compareDateRange (a plain period, not a comparison);
 * - more than four compare periods (the governed ceiling is four);
 * - "last N complete weeks" phrasing Cube's date parser cannot read
 *   (Cube's own "last N weeks" already means complete weeks);
 * - the same member as a bucketed time dimension and a plain dimension,
 *   which the validator rejects outright.
 */
export function normalizeOmniCubeQuery(
  query: CubeQuery,
  memberKinds?: ReadonlyMap<string, OmniMemberKind>,
): Readonly<{
  query: CubeQuery;
  adjustments: readonly string[];
  /** Misuses no repair can save; the executor should fail fast with these. */
  errors: readonly string[];
}> {
  const adjustments: string[] = [];
  const errors: string[] = [];

  // Members filed under the wrong selection array move to the right one — the
  // selection is identical, only the placement changes, and Cube demands it.
  let measures = query.measures;
  let plainDimensions = query.dimensions;
  let segments = query.segments;
  if (memberKinds) {
    const moved = { measures: [] as string[], dimensions: [] as string[], segments: [] as string[] };
    const classify = (members: readonly string[] | undefined, expected: OmniMemberKind["kind"]): string[] | undefined => {
      if (members === undefined) return undefined;
      const kept: string[] = [];
      for (const member of members) {
        const actual = memberKinds.get(member)?.kind;
        if (actual === undefined || actual === expected) {
          kept.push(member);
          continue;
        }
        moved[`${actual}s`].push(member);
        adjustments.push(`${member} is a ${actual}, not a ${expected}; it was moved to ${actual}s.`);
      }
      return kept;
    };
    measures = classify(measures, "measure");
    plainDimensions = classify(plainDimensions, "dimension");
    segments = classify(segments, "segment");
    if (moved.measures.length > 0) measures = [...(measures ?? []), ...moved.measures];
    if (moved.dimensions.length > 0) plainDimensions = [...(plainDimensions ?? []), ...moved.dimensions];
    if (moved.segments.length > 0) segments = [...(segments ?? []), ...moved.segments];
    timeFilterMisuse(query.filters, memberKinds, errors);
  }
  query = {
    ...query,
    ...(measures === undefined ? {} : { measures }),
    ...(plainDimensions === undefined ? {} : { dimensions: plainDimensions }),
    ...(segments === undefined ? {} : { segments }),
  };

  const normalizeRelative = (range: string | readonly [string, string]): string | readonly [string, string] => {
    if (typeof range !== "string") return range;
    const cleaned = range
      .trim()
      .replace(/^the\s+/iu, "")
      .replace(/\b(last|past|previous)\s+(\d+)\s+(?:complete|completed|full|whole)\s+(day|week|month|quarter|year)s?\b/iu, "last $2 $3s")
      .replace(/\b(?:complete|completed|full|whole)\s+(day|week|month|quarter|year)s\b/iu, "$1s");
    if (cleaned !== range.trim()) {
      adjustments.push(`Date range "${range}" was normalised to "${cleaned}" (Cube's relative ranges already cover complete periods only).`);
    }
    return cleaned;
  };

  const timeDimensions = (query.timeDimensions ?? []).map((dimension): CubeTimeDimension => {
    let dateRange = dimension.dateRange === undefined ? undefined : normalizeRelative(dimension.dateRange);
    let compareDateRange = dimension.compareDateRange;

    if (compareDateRange !== undefined && compareDateRange.length === 1) {
      // One period is not a comparison; treat it as the plain date range.
      if (dateRange === undefined) {
        dateRange = normalizeRelative(compareDateRange[0]!);
        adjustments.push("compareDateRange had a single period, so it ran as the plain dateRange; pass two to four periods to compare.");
      } else {
        errors.push("Both dateRange and a single compareDateRange were supplied. Choose the intended window explicitly; neither is discarded.");
      }
      compareDateRange = undefined;
    } else if (compareDateRange !== undefined && compareDateRange.length > 4) {
      errors.push(`compareDateRange supports at most four periods; split the ${compareDateRange.length} requested periods into separate queries. No periods were discarded.`);
    }

    return {
      dimension: dimension.dimension,
      ...(dimension.granularity === undefined ? {} : { granularity: dimension.granularity }),
      ...(dateRange === undefined ? {} : { dateRange }),
      ...(compareDateRange === undefined ? {} : { compareDateRange }),
    };
  });

  // A member bucketed as a time dimension must not also appear as a plain
  // dimension: Cube would group by the raw timestamp and the validator
  // rejects the query. The bucketed form is always the intended one.
  const bucketedMembers = new Set(
    timeDimensions.filter((dimension) => dimension.granularity).map((dimension) => dimension.dimension),
  );
  const dimensions = (query.dimensions ?? []).filter((member) => {
    if (!bucketedMembers.has(member)) return true;
    adjustments.push(`${member} is already a bucketed time dimension, so its duplicate plain-dimension entry was removed.`);
    return false;
  });

  const normalized: CubeQuery = {
    ...query,
    ...(query.timeDimensions === undefined ? {} : { timeDimensions }),
    ...(query.dimensions === undefined ? {} : { dimensions }),
  };
  if (normalized.dimensions !== undefined && normalized.dimensions.length === 0) {
    const rest = { ...normalized };
    delete rest.dimensions;
    return Object.freeze({ query: rest as CubeQuery, adjustments: Object.freeze(adjustments), errors: Object.freeze(errors) });
  }
  return Object.freeze({ query: normalized, adjustments: Object.freeze(adjustments), errors: Object.freeze(errors) });
}
