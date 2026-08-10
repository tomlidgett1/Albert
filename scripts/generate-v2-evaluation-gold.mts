import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { ulid } from "ulid";

import { SemanticServiceClient } from "../services/conversation/src/semantic-client.js";
import {
  assertV2PublicEvaluationBlueprint,
  bindV2SealedHoldout,
  type V2EvaluationDeterministicGold,
} from "./v2-evaluation-policy.js";

if (
  !process.argv.includes("--execute") ||
  !process.argv.includes("--confirm-deterministic-oracles")
)
  throw new Error(
    "Refusing to execute evaluation oracles without --execute --confirm-deterministic-oracles.",
  );

function argument(name: string): string | undefined {
  return process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .trim();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

try {
  process.loadEnvFile?.(".env.local");
} catch {
  /* Explicit process environment remains authoritative. */
}

const holdoutPathValue = argument("holdout");
const outputPathValue = argument("output");
if (!holdoutPathValue || !outputPathValue)
  throw new Error(
    "--holdout=<sealed holdout> and --output=<external gold manifest> are required.",
  );
const holdoutPath = resolve(holdoutPathValue);
const outputPath = resolve(outputPathValue);
for (const [label, path] of [
  ["holdout", holdoutPath],
  ["gold output", outputPath],
] as const) {
  const repositoryRelative = relative(resolve("."), path);
  if (!repositoryRelative.startsWith("..") || repositoryRelative === "")
    throw new Error(`The ${label} must remain outside the repository.`);
}

const blueprint: unknown = JSON.parse(
  readFileSync("evals/v2-evaluation-corpus.json", "utf8"),
);
assertV2PublicEvaluationBlueprint(blueprint);
const corpus = bindV2SealedHoldout(
  blueprint,
  JSON.parse(readFileSync(holdoutPath, "utf8")),
);
const publicationHash =
  process.env.ALBERT_SEMANTIC_V2_PUBLICATION_HASH?.trim();
const semanticUrl = process.env.SEMANTIC_QUERY_SERVICE_URL?.trim();
const signingSecret = process.env.ALBERT_SEMANTIC_SIGNING_SECRET?.trim();
const tenantId =
  process.env.ALBERT_V2_EVALUATION_TENANT_ID?.trim() ??
  "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
if (!publicationHash || !/^[a-f0-9]{64}$/u.test(publicationHash))
  throw new Error("The exact Semantic V2 publication hash is required.");
if (!semanticUrl || !signingSecret)
  throw new Error(
    "SEMANTIC_QUERY_SERVICE_URL and ALBERT_SEMANTIC_SIGNING_SECRET are required.",
  );

const readinessResponse = await fetch(new URL("/readyz", semanticUrl), {
  signal: AbortSignal.timeout(10_000),
});
const readiness = record(await readinessResponse.json(), "readiness");
if (
  !readinessResponse.ok ||
  readiness.status !== "ready" ||
  readiness.analyticalRuntime !== "v2" ||
  readiness.v2PublicationHash !== publicationHash
)
  throw new Error(
    "The deterministic oracle service is not ready on the exact V2 publication.",
  );

const client = new SemanticServiceClient(semanticUrl, signingSecret);
const contextFor = (turnId: string) => ({
  tenantId,
  role: "owner" as const,
  conversationId: ulid(),
  turnId,
});
const contextTurn = ulid();
const semanticContext = await client.executeV2(
  "get_semantic_context_v2",
  { question: "Deterministic evaluation watermark", limit: 1 },
  contextFor(contextTurn),
);
if (semanticContext.publicationHash !== publicationHash)
  throw new Error("The semantic context did not bind the qualified publication.");
const datasetWatermarkHash = createHash("sha256")
  .update(
    JSON.stringify(
      canonical({
        publicationHash,
        tenantContext: semanticContext.tenantContext,
      }),
    ),
  )
  .digest("hex");

const cases: Record<string, V2EvaluationDeterministicGold> = {};
const oracleCases = corpus.filter(
  ({ expectedTerminalState, grading }) =>
    grading.oracleBlock !== null || expectedTerminalState === "no_data",
);
for (const [index, evaluationCase] of oracleCases.entries()) {
  const block = evaluationCase.grading.oracleBlock;
  if (!block)
    throw new Error(
      `Evaluation case ${evaluationCase.id} requires deterministic gold but has no oracle block.`,
    );
  const turnId = ulid();
  const context = contextFor(turnId);
  await client.executeV2(
    "create_investigation_v2",
    {
      objective: `Pre-model deterministic oracle for ${evaluationCase.id}`,
      questionClass: evaluationCase.questionClass,
      definitionsToResolve: [],
      hypotheses: [],
      evidenceNodes: [
        {
          id: `${evaluationCase.id}_evidence`,
          question: evaluationCase.ask,
          status: "ready",
          resultRefs: [],
        },
      ],
      dependencies: [],
      stopConditions: ["objective_satisfied"],
    },
    context,
  );
  const created = record(
    await client.executeV2("create_workspace_v2", { blocks: [block] }, context),
    `${evaluationCase.id} workspace response`,
  );
  const workspace = record(created.workspace, `${evaluationCase.id} workspace`);
  const executed = record(
    await client.executeV2(
      "execute_workspace_v2",
      {
        workspaceId: workspace.id,
        expectedRevision: workspace.revision,
      },
      context,
    ),
    `${evaluationCase.id} execution response`,
  );
  const execution = record(executed.execution, `${evaluationCase.id} execution`);
  const queries = Array.isArray(execution.queries)
    ? execution.queries.map((query, queryIndex) =>
        record(query, `${evaluationCase.id} query ${queryIndex}`),
      )
    : [];
  if (evaluationCase.expectedTerminalState === "no_data") {
    if (
      execution.terminalState !== "no_data" ||
      queries.some(
        (query) => Array.isArray(query.rows) && query.rows.length !== 0,
      )
    )
      throw new Error(
        `No-data oracle ${evaluationCase.id} returned non-empty evidence.`,
      );
    cases[evaluationCase.id] = { kind: "empty_result", rowCount: 0 };
  } else {
    const visibleQueries = queries.filter(
      (query) => Array.isArray(query.rows) && query.rows.length > 0,
    );
    const query = visibleQueries[0];
    if (!query)
      throw new Error(`Numeric oracle ${evaluationCase.id} returned no rows.`);
    const row = record(
      (query.rows as unknown[])[0],
      `${evaluationCase.id} first result row`,
    );
    const measureKey = block.measureIds.find((id) => {
      const value = row[id];
      return (
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && /^[-+]?\d+(?:\.\d+)?$/u.test(value))
      );
    });
    if (!measureKey)
      throw new Error(
        `Numeric oracle ${evaluationCase.id} has no exact numeric measure cell.`,
      );
    const rowMatch = Object.fromEntries(
      block.dimensionIds.flatMap((dimensionId) =>
        Object.prototype.hasOwnProperty.call(row, dimensionId)
          ? [[dimensionId, row[dimensionId] as string | number | null]]
          : [],
      ),
    );
    cases[evaluationCase.id] = {
      kind: "numeric_cells",
      cells: [
        {
          tableIndex: 0,
          columnKey: measureKey,
          ...(Object.keys(rowMatch).length ? { rowMatch } : {}),
          expected: row[measureKey] as string | number,
        },
      ],
    };
  }
  process.stderr.write(
    `${JSON.stringify({ event: "v2_gold_oracle_complete", completed: index + 1, total: oracleCases.length, caseId: evaluationCase.id })}\n`,
  );
}

const manifest = {
  schemaVersion: 1 as const,
  publicationHash,
  datasetWatermarkHash,
  cases,
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({ outputPath, publicationHash, datasetWatermarkHash, oracleCases: oracleCases.length, numericCases: Object.values(cases).filter(({ kind }) => kind === "numeric_cells").length, emptyCases: Object.values(cases).filter(({ kind }) => kind === "empty_result").length }, null, 2)}\n`,
);
