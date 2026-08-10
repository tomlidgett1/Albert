import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import pg, { type Client as PgClient } from "pg";
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
const controlPlaneUrl = process.env.CONTROL_PLANE_ADMIN_DATABASE_URL?.trim();
const tenantId =
  process.env.ALBERT_V2_EVALUATION_TENANT_ID?.trim() ??
  "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
if (!publicationHash || !/^[a-f0-9]{64}$/u.test(publicationHash))
  throw new Error("The exact Semantic V2 publication hash is required.");
if (!semanticUrl || !signingSecret || !controlPlaneUrl)
  throw new Error(
    "SEMANTIC_QUERY_SERVICE_URL, ALBERT_SEMANTIC_SIGNING_SECRET, and CONTROL_PLANE_ADMIN_DATABASE_URL are required.",
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
const { Client } = pg;
const controlPlane: PgClient = new Client({
  connectionString: controlPlaneUrl,
  application_name: "albert-v2-evaluation-gold",
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});
await controlPlane.connect();
await controlPlane.query("SET ROLE albert_control_migration_owner");
const owner = await controlPlane.query<{ user_id: string }>(
  `SELECT membership.user_id
     FROM control_plane.memberships membership
    WHERE membership.tenant_id=$1
      AND membership.role='owner'
      AND membership.status='active'
    ORDER BY membership.created_at
    LIMIT 1`,
  [tenantId],
);
const ownerId = owner.rows[0]?.user_id;
if (!ownerId)
  throw new Error("The evaluation tenant has no active owner for turn lineage.");

type EvaluationTurn = Readonly<{
  conversationId: string;
  turnId: string;
  context: Readonly<{
    tenantId: string;
    role: "owner";
    conversationId: string;
    turnId: string;
  }>;
}>;

async function openEvaluationTurn(caseId: string, question: string): Promise<EvaluationTurn> {
  const conversationId = ulid();
  const turnId = ulid();
  await controlPlane.query("BEGIN");
  try {
    await controlPlane.query(
      `INSERT INTO control_plane.conversations(
         tenant_id,conversation_id,title,status,created_by,created_at,updated_at
       ) VALUES($1,$2,$3,'active',$4,clock_timestamp(),clock_timestamp())`,
      [tenantId, conversationId, `Albert V2 gold ${caseId}`.slice(0, 120), ownerId],
    );
    await controlPlane.query(
      `INSERT INTO control_plane.conversation_turns(
         tenant_id,turn_id,conversation_id,turn_number,user_message,runtime_profile,
         status,created_by,created_at,lease_expires_at
       ) VALUES($1,$2,$3,1,$4,$5::jsonb,'running',$6,clock_timestamp(),
                clock_timestamp()+interval '15 minutes')`,
      [
        tenantId,
        turnId,
        conversationId,
        question,
        JSON.stringify({
          runtime: "v2-evaluation-deterministic-gold",
          publicationHash,
          caseId,
        }),
        ownerId,
      ],
    );
    await controlPlane.query("COMMIT");
  } catch (error) {
    await controlPlane.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    conversationId,
    turnId,
    context: Object.freeze({
      tenantId,
      role: "owner" as const,
      conversationId,
      turnId,
    }),
  });
}

async function closeEvaluationTurn(
  turn: EvaluationTurn,
  caseId: string,
  succeeded: boolean,
): Promise<void> {
  const resultDigest = createHash("sha256")
    .update(`${publicationHash}:${caseId}:${succeeded ? "passed" : "failed"}`)
    .digest("hex");
  await controlPlane.query("BEGIN");
  try {
    const closed = await controlPlane.query(
      `UPDATE control_plane.conversation_turns
          SET status='failed',completed_at=clock_timestamp(),result_digest=$4
        WHERE tenant_id=$1 AND conversation_id=$2 AND turn_id=$3
          AND status='running' AND lease_expires_at>clock_timestamp()
        RETURNING turn_id`,
      [tenantId, turn.conversationId, turn.turnId, resultDigest],
    );
    if (closed.rowCount !== 1)
      throw new Error(`Evaluation turn ${caseId} was no longer active at finalization.`);
    await controlPlane.query(
      `UPDATE control_plane.conversations
          SET status='archived',archived_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND conversation_id=$2`,
      [tenantId, turn.conversationId],
    );
    await controlPlane.query("COMMIT");
  } catch (error) {
    await controlPlane.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

try {
  const contextTurn = await openEvaluationTurn(
    "dataset_watermark",
    "Deterministic evaluation watermark",
  );
  let semanticContext: Awaited<ReturnType<typeof client.executeV2>>;
  let contextSucceeded = false;
  try {
    semanticContext = await client.executeV2(
      "get_semantic_context_v2",
      { question: "Deterministic evaluation watermark", limit: 1 },
      contextTurn.context,
    );
    contextSucceeded = true;
  } finally {
    await closeEvaluationTurn(contextTurn, "dataset_watermark", contextSucceeded);
  }
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
  const oracleFailures: string[] = [];
  for (const [index, evaluationCase] of oracleCases.entries()) {
  const block = evaluationCase.grading.oracleBlock;
  if (!block)
    throw new Error(
      `Evaluation case ${evaluationCase.id} requires deterministic gold but has no oracle block.`,
    );
    const turn = await openEvaluationTurn(evaluationCase.id, evaluationCase.ask);
    let succeeded = false;
    let executed: Record<string, unknown>;
    try {
      const evidenceNodeId = `${evaluationCase.id}_evidence`;
      const requiresCompetingHypotheses = ["diagnosis", "recommendation"].includes(
        evaluationCase.questionClass,
      );
      await client.executeV2(
        "create_investigation_v2",
        {
          objective: `Pre-model deterministic oracle for ${evaluationCase.id}`,
          questionClass: evaluationCase.questionClass,
          definitionsToResolve: [],
          hypotheses: requiresCompetingHypotheses
            ? [
                {
                  id: `${evaluationCase.id}_has_data`,
                  proposition: "The governed oracle returns data.",
                  evidenceNodeIds: [evidenceNodeId],
                  status: "untested",
                },
                {
                  id: `${evaluationCase.id}_has_no_data`,
                  proposition: "The governed oracle returns no data.",
                  evidenceNodeIds: [evidenceNodeId],
                  status: "untested",
                },
              ]
            : [],
          evidenceNodes: [
            {
              id: evidenceNodeId,
              question: evaluationCase.ask,
              status: "ready",
              resultRefs: [],
            },
          ],
          dependencies: [],
          stopConditions: ["objective_satisfied"],
        },
        turn.context,
      );
      const created = record(
        await client.executeV2(
          "create_workspace_v2",
          { blocks: [block] },
          turn.context,
        ),
        `${evaluationCase.id} workspace response`,
      );
      const workspace = record(created.workspace, `${evaluationCase.id} workspace`);
      executed = record(
        await client.executeV2(
          "execute_workspace_v2",
          {
            workspaceId: workspace.id,
            expectedRevision: workspace.revision,
          },
          turn.context,
        ),
        `${evaluationCase.id} execution response`,
      );
      succeeded = true;
    } finally {
      await closeEvaluationTurn(turn, evaluationCase.id, succeeded);
    }
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
    ) {
      oracleFailures.push(
        `No-data oracle ${evaluationCase.id} returned non-empty evidence.`,
      );
    } else {
      cases[evaluationCase.id] = { kind: "empty_result", rowCount: 0 };
    }
  } else {
    const visibleQueries = queries.filter(
      (query) => Array.isArray(query.rows) && query.rows.length > 0,
    );
    const query = visibleQueries[0];
    if (!query) {
      oracleFailures.push(
        `Numeric oracle ${evaluationCase.id} returned no rows.`,
      );
      process.stderr.write(
        `${JSON.stringify({ event: "v2_gold_oracle_invalid", caseId: evaluationCase.id, reason: "no_rows" })}\n`,
      );
      continue;
    }
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
    if (!measureKey) {
      oracleFailures.push(
        `Numeric oracle ${evaluationCase.id} has no exact numeric measure cell.`,
      );
      process.stderr.write(
        `${JSON.stringify({ event: "v2_gold_oracle_invalid", caseId: evaluationCase.id, reason: "no_numeric_measure_cell", measureIds: block.measureIds, row })}\n`,
      );
    } else {
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
  }
  process.stderr.write(
    `${JSON.stringify({ event: "v2_gold_oracle_complete", completed: index + 1, total: oracleCases.length, caseId: evaluationCase.id })}\n`,
  );
  }

  if (oracleFailures.length)
    throw new Error(
      `Deterministic oracle generation found ${oracleFailures.length} invalid cases:\n${oracleFailures.join("\n")}`,
    );

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
} finally {
  await controlPlane.end().catch(() => undefined);
}
