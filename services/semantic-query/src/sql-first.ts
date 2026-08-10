import type {
  CompiledSemanticValidationEvidence,
} from "../../../packages/compiler/src/index.js";
import type {
  FactScopeBinding,
  SqlFirstLintResult,
} from "../../../packages/semantic-registry/src/index.js";
import { compileExploratorySql } from "./exploratory-sql.js";
import type { DatabaseRow } from "./types.js";

/**
 * The runtime companions of the SQL-first linter: the canary that proves at
 * execution time what static reading could not, the differential attestation
 * that re-states each declared claim through its governed contract, and the
 * state derivation that turns all of it into one honest answer state.
 */

export type SqlFirstCanarySpec = Readonly<{
  factId: string;
  /** Bounded single-statement canary, ready for queryAsSemanticRole. */
  sql: string;
  /** Why a scope was not canaried, when it was not. */
  skipped?: "no_from_clause" | "references_derived_relation";
}>;

/**
 * One count-preservation probe per fact-bearing scope: if the scope's exact
 * join tree returns more rows than distinct fact grains, the join multiplied
 * the fact and every SUM over it is inflated. Built from the verbatim
 * FROM/WHERE text the linter extracted, so the canary measures precisely the
 * tree the statement executed, not a reconstruction of it.
 */
export function buildSqlFirstCanaries(
  factScopes: readonly FactScopeBinding[],
): readonly SqlFirstCanarySpec[] {
  const seen = new Set<string>();
  const specs: SqlFirstCanarySpec[] = [];
  for (const scope of factScopes) {
    const key = `${scope.factId}:${scope.alias}:${scope.fromText ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (scope.staticallyClean) continue;
    if (!scope.fromText) {
      specs.push({ factId: scope.factId, sql: "", skipped: "no_from_clause" });
      continue;
    }
    if (scope.referencesDerived) {
      specs.push({ factId: scope.factId, sql: "", skipped: "references_derived_relation" });
      continue;
    }
    const statement = `SELECT count(*) AS row_count, count(DISTINCT ${scope.alias}.${scope.grainKey}) AS distinct_rows FROM ${scope.fromText}${scope.whereText ? ` WHERE ${scope.whereText}` : ""}`;
    // The canary re-enters the same textual guard as the statement it probes:
    // defence in depth, and the tenant placeholder wrapper for free.
    const compiled = compileExploratorySql(statement, 1);
    specs.push({ factId: scope.factId, sql: compiled.sql });
  }
  return Object.freeze(specs);
}

export type SqlFirstCanaryOutcome = Readonly<{
  factId: string;
  status: "passed" | "blocked" | "skipped";
  rowCount?: number;
  distinctRows?: number;
  reason?: string;
}>;

export function canaryOutcome(
  spec: SqlFirstCanarySpec,
  rows: readonly DatabaseRow[],
  factWasSummed: boolean,
): SqlFirstCanaryOutcome {
  const row = rows[0];
  const rowCount = numberFrom(row?.row_count);
  const distinctRows = numberFrom(row?.distinct_rows);
  if (rowCount === undefined || distinctRows === undefined) {
    return { factId: spec.factId, status: "skipped", reason: "canary_result_unreadable" };
  }
  if (rowCount > distinctRows && factWasSummed) {
    return { factId: spec.factId, status: "blocked", rowCount, distinctRows };
  }
  return { factId: spec.factId, status: "passed", rowCount, distinctRows };
}

/**
 * The fan-out fingerprint: when a join multiplies a fact, the inflation ratio
 * lands near the average child count per row — basket size, tenders per
 * order. Naming the ratio turns "the number is wrong" into "the number is
 * wrong in the way a header-times-lines join is wrong".
 */
export function canaryDiagnosis(outcome: SqlFirstCanaryOutcome): string {
  const ratio = outcome.rowCount !== undefined && outcome.distinctRows
    ? (outcome.rowCount / outcome.distinctRows).toFixed(2)
    : "unknown";
  return `The join tree multiplied ${outcome.factId}: ${String(outcome.rowCount)} rows over ${String(outcome.distinctRows)} distinct grains (×${ratio}, the shape of a header-times-lines join). Aggregate each fact in its own subquery before joining, or use the aligned mart.`;
}

/**
 * Runtime proof adjusts static ignorance, never static knowledge: a join the
 * registry could not classify is upgraded when the canary preserved the
 * grain over real rows, while a declared one_to_many stays declared no
 * matter how the data landed today. A proven multiplication downgrades
 * everything the canary measured for that fact.
 */
export function adjustEvidenceWithCanary(
  evidence: CompiledSemanticValidationEvidence,
  outcomes: readonly SqlFirstCanaryOutcome[],
): CompiledSemanticValidationEvidence {
  const provenClean = new Set(
    outcomes
      .filter((outcome) => outcome.status === "passed" && (outcome.rowCount ?? 0) > 0)
      .map((outcome) => outcome.factId),
  );
  const provenMultiplied = new Set(
    outcomes.filter((outcome) => outcome.status === "blocked").map((outcome) => outcome.factId),
  );
  return Object.freeze({
    ...evidence,
    joins: Object.freeze(evidence.joins.map((join) => {
      if (provenMultiplied.has(join.factId)) {
        return Object.freeze({ ...join, cardinality: "one_to_many" as const });
      }
      if (join.cardinality === "unverified" && provenClean.has(join.factId)) {
        return Object.freeze({ ...join, cardinality: "many_to_one" as const });
      }
      return join;
    })),
  });
}

export type SqlFirstAttestationOutcome = Readonly<{
  metricId: string;
  column: string;
  status: "passed" | "warning" | "blocked";
  reasonCode?:
    | "value_diverged"
    | "claim_column_missing"
    | "contract_unavailable"
    | "composite_contract_unattested";
  agentValue?: number;
  contractValue?: number;
  delta?: number;
  detail?: string;
}>;

/** Sum a claimed output column across the returned rows, null-safely. */
export function claimedScalar(rows: readonly DatabaseRow[], column: string): number | undefined {
  let total = 0;
  let observed = false;
  for (const row of rows) {
    if (!(column in row)) continue;
    const value = numberFrom(row[column]);
    if (value === undefined) continue;
    total += value;
    observed = true;
  }
  return observed ? total : undefined;
}

export function compareAttestation(
  metricId: string,
  column: string,
  agentValue: number | undefined,
  contractValue: number | undefined,
): SqlFirstAttestationOutcome {
  if (agentValue === undefined) {
    return {
      metricId, column, status: "blocked", reasonCode: "claim_column_missing",
      detail: `The statement returned no numeric column named ${column} to attest against ${metricId}.`,
    };
  }
  if (contractValue === undefined) {
    return {
      metricId, column, status: "warning", reasonCode: "contract_unavailable", agentValue,
      detail: `${metricId} could not be recomputed through its governed contract, so the claim stays unattested.`,
    };
  }
  const delta = Math.abs(agentValue - contractValue);
  const tolerance = Math.max(0.005, Math.abs(contractValue) * 1e-9);
  if (delta <= tolerance) {
    return { metricId, column, status: "passed", agentValue, contractValue, delta: 0 };
  }
  const ratio = contractValue !== 0 ? agentValue / contractValue : undefined;
  const fingerprint = ratio !== undefined && ratio > 1.2
    ? ` The ×${ratio.toFixed(2)} inflation is the fingerprint of a multiplying join.`
    : "";
  return {
    metricId, column, status: "warning", reasonCode: "value_diverged",
    agentValue, contractValue, delta,
    detail: `${metricId}: the statement produced ${agentValue} where the governed contract computes ${contractValue} over the declared window (Δ ${delta.toFixed(4)}).${fingerprint}`,
  };
}

export type SqlFirstStateInput = Readonly<{
  claims: number;
  attestations: readonly SqlFirstAttestationOutcome[];
  canaryBlocked: boolean;
  invariantsBlocked: boolean;
  minimumFactTier: number;
  warningCount: number;
}>;

/**
 * Answer state, earned rather than asserted. Never hand-assigned: proven
 * fan-out or a blocked invariant withholds the figures entirely; matching
 * attestations over contracted substrate verify; anything less honest lands
 * on qualified or exploratory. The minimum evidence tier caps the ceiling —
 * tier 0-1 substrate cannot certify no matter how well the claim attested.
 */
export function deriveSqlFirstState(input: SqlFirstStateInput): "verified" | "qualified" | "exploratory" | "unavailable" {
  if (input.canaryBlocked || input.invariantsBlocked) return "unavailable";
  if (input.claims === 0) return "exploratory";
  if (input.attestations.some((outcome) => outcome.status === "blocked")) return "qualified";
  if (input.minimumFactTier <= 0) return "exploratory";
  if (input.minimumFactTier === 1) return "qualified";
  const allAttested = input.attestations.length === input.claims
    && input.attestations.every((outcome) => outcome.status === "passed");
  return allAttested && input.warningCount === 0 ? "verified" : "qualified";
}

/**
 * Ordering proof for a model-authored statement. Trustworthy in exactly two
 * shapes: the statement's own top-level ORDER BY paired with its own LIMIT,
 * or its ORDER BY with the service bound not reached — in both, no row the
 * ordering would have ranked higher was cut. A truncation at the service
 * bound without an inner limit yields no proof at all.
 */
export function sqlFirstResultWindow(
  ordering: SqlFirstLintResult["resultOrdering"],
  serviceBound: number,
  returnedRows: number,
): {
  requestedLimit: number;
  orderedBeforeLimit: true;
  orderBy: { columnKey: string; direction: "asc" | "desc" }[];
} | undefined {
  if (ordering.orderBy.length === 0) return undefined;
  const orderBy = ordering.orderBy
    // The governed wire contract accepts at most five ordering keys. Keep the
    // proof within that boundary so a successful SQL result cannot be turned
    // into a response-schema failure during service serialization.
    .slice(0, 5)
    .map((item) => ({ columnKey: item.column, direction: item.direction }));
  if (ordering.limit !== undefined && ordering.limit <= serviceBound) {
    return { requestedLimit: ordering.limit, orderedBeforeLimit: true, orderBy };
  }
  if (ordering.limit === undefined && returnedRows < serviceBound) {
    return { requestedLimit: serviceBound, orderedBeforeLimit: true, orderBy };
  }
  return undefined;
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "bigint") return Number(value);
  return undefined;
}
