export type TurnLineageReference = Readonly<{
  conversationId: string;
  turnId: string;
}>;

export type SafeAnswerLineage = Readonly<{
  answerArtifactId: string;
  conversationId: string;
  turnId: string;
  turnNumber: number;
  answerState: "verified" | "qualified" | "exploratory" | "clarification" | "unavailable";
  semanticBundleHash: string | null;
  traceDigest: string;
  artifactDigest: string;
  finalizedAt: string;
  queries: readonly Readonly<{
    queryAuditId: string;
    route: "semantic" | "source_exploration" | "sql_first";
    topic: string | null;
    bundleHash: string;
    registryVersion: string;
    compilerOutputHash: string;
    resultDigest: string;
    answerState: "verified" | "qualified" | "exploratory" | "clarification" | "unavailable";
  }>[];
}>;

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const answerStates = new Set<SafeAnswerLineage["answerState"]>([
  "verified",
  "qualified",
  "exploratory",
  "clarification",
  "unavailable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAnswerState(value: unknown): value is SafeAnswerLineage["answerState"] {
  return typeof value === "string" && answerStates.has(value as SafeAnswerLineage["answerState"]);
}

/**
 * Accept only the bounded, non-sensitive receipt fields rendered by the dash.
 * Raw plans, prompts, narrative bodies, SQL, and validation payloads returned
 * by the authenticated endpoint are deliberately discarded at this boundary.
 */
export function parseSafeAnswerLineage(
  value: unknown,
  expected: TurnLineageReference,
): SafeAnswerLineage | null {
  if (!isRecord(value) || !Array.isArray(value.queries) || value.queries.length > 20) return null;
  if (
    typeof value.answerArtifactId !== "string" || !ulidPattern.test(value.answerArtifactId)
    || value.conversationId !== expected.conversationId
    || value.turnId !== expected.turnId
    || !ulidPattern.test(expected.conversationId)
    || !ulidPattern.test(expected.turnId)
    || typeof value.turnNumber !== "number" || !Number.isSafeInteger(value.turnNumber) || value.turnNumber < 1
    || !isAnswerState(value.answerState)
    || (value.semanticBundleHash !== null && (typeof value.semanticBundleHash !== "string" || !digestPattern.test(value.semanticBundleHash)))
    || typeof value.traceDigest !== "string" || !digestPattern.test(value.traceDigest)
    || typeof value.artifactDigest !== "string" || !digestPattern.test(value.artifactDigest)
    || typeof value.finalizedAt !== "string" || value.finalizedAt.length > 80 || !Number.isFinite(Date.parse(value.finalizedAt))
  ) return null;

  const queries: SafeAnswerLineage["queries"][number][] = [];
  for (const rawQuery of value.queries) {
    if (!isRecord(rawQuery)) return null;
    if (
      typeof rawQuery.queryAuditId !== "string" || !ulidPattern.test(rawQuery.queryAuditId)
      || (rawQuery.route !== "semantic" && rawQuery.route !== "source_exploration" && rawQuery.route !== "sql_first")
      || (rawQuery.topic !== null && (typeof rawQuery.topic !== "string" || rawQuery.topic.length > 200))
      || typeof rawQuery.bundleHash !== "string" || !digestPattern.test(rawQuery.bundleHash)
      || typeof rawQuery.registryVersion !== "string" || rawQuery.registryVersion.length < 1 || rawQuery.registryVersion.length > 160
      || typeof rawQuery.compilerOutputHash !== "string" || !digestPattern.test(rawQuery.compilerOutputHash)
      || typeof rawQuery.resultDigest !== "string" || !digestPattern.test(rawQuery.resultDigest)
      || !isAnswerState(rawQuery.answerState)
    ) return null;
    queries.push({
      queryAuditId: rawQuery.queryAuditId,
      route: rawQuery.route,
      topic: rawQuery.topic,
      bundleHash: rawQuery.bundleHash,
      registryVersion: rawQuery.registryVersion,
      compilerOutputHash: rawQuery.compilerOutputHash,
      resultDigest: rawQuery.resultDigest,
      answerState: rawQuery.answerState,
    });
  }

  return Object.freeze({
    answerArtifactId: value.answerArtifactId,
    conversationId: expected.conversationId,
    turnId: expected.turnId,
    turnNumber: value.turnNumber,
    answerState: value.answerState,
    semanticBundleHash: value.semanticBundleHash,
    traceDigest: value.traceDigest,
    artifactDigest: value.artifactDigest,
    finalizedAt: value.finalizedAt,
    queries: Object.freeze(queries.map((query) => Object.freeze(query))),
  });
}

export function isTurnLineageReference(value: unknown): value is TurnLineageReference {
  if (!isRecord(value)) return false;
  return typeof value.conversationId === "string"
    && ulidPattern.test(value.conversationId)
    && typeof value.turnId === "string"
    && ulidPattern.test(value.turnId);
}
