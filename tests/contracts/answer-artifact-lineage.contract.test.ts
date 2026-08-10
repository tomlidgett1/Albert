import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";
import { PostgresAnswerArtifactFinalizer } from "../../services/semantic-query/src/answer-artifact-finalizer.js";
import type {
  PgClientLike,
  PgPoolLike,
} from "../../services/semantic-query/src/database.js";

const migration = readFileSync(
  resolve(
    "infra/migrations/control-plane/0015_m8_immutable_answer_artifact_lineage.sql",
  ),
  "utf8",
);
const finalizationFences = readFileSync(
  resolve(
    "infra/migrations/control-plane/0018_m8_conversation_finalization_fences.sql",
  ),
  "utf8",
);
const semanticService = readFileSync(
  resolve("services/semantic-query/src/service.ts"),
  "utf8",
);
const semanticHttp = readFileSync(
  resolve("services/semantic-query/src/http.ts"),
  "utf8",
);
const semanticV2Finalizer = readFileSync(
  resolve("services/semantic-query/src/answer-artifact-finalizer.ts"),
  "utf8",
);
const liveRuntime = readFileSync(
  resolve("services/conversation/src/live.ts"),
  "utf8",
);
const conversationRoute = readFileSync(
  resolve("app/api/conversation/route.ts"),
  "utf8",
);
const lineageRoute = readFileSync(
  resolve(
    "app/api/conversations/[conversationId]/artifacts/[artifactId]/lineage/route.ts",
  ),
  "utf8",
);
const turnLineageRoute = readFileSync(
  resolve(
    "app/api/conversations/[conversationId]/turns/[turnId]/lineage/route.ts",
  ),
  "utf8",
);
const adr = readFileSync(
  resolve(
    "docs/adr/0012-cross-store-immutable-answer-artifact-finalization.md",
  ),
  "utf8",
);

function v2WorkspaceDocument() {
  return {
    id: "01K2ZZZZZZ0000000000000005",
    tenantId: "01K2ZZZZZZ0000000000000001",
    publicationHash: "a".repeat(64),
    overlayVersion: "context-v1",
    revision: 1,
    questionId: "01K2ZZZZZZ0000000000000003",
    blocks: [
      {
        id: "sales",
        topicIds: ["business.sales_performance"],
        rootViewId: "commerce_sales_event",
        dimensionIds: ["commerce_sales_event.business_date"],
        measureIds: ["commerce.net_sales_ex_gst"],
        filters: [],
        time: { range: { type: "current_snapshot" } },
        sort: [],
        limit: 100,
        parameters: {},
      },
    ],
    status: "executed",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:01.000Z",
  };
}

test("successful turn completion is a privileged immutable artefact finalization", () => {
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION control_plane\.finalize_answer_artifact/,
  );
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO albert_semantic_control/);
  assert.match(
    migration,
    /REVOKE EXECUTE ON FUNCTION public\.complete_albert_turn[\s\S]*FROM authenticated/,
  );
  assert.match(migration, /answer_artifacts_one_per_turn/);
  assert.match(migration, /answer_artifacts_content_address/);
  assert.match(migration, /answer_artifacts_reject_mutation/);
  assert.match(migration, /answer_execution_events_reject_mutation/);
  assert.match(
    migration,
    /REVOKE SELECT ON TABLE control_plane\.answer_artifacts/,
  );
  assert.match(migration, /deletion_mutation_authorized/);
  assert.match(migration, /answer finalization fenced by tenant deletion/);
  assert.match(
    migration,
    /request\.status IN \('queued','running','retry_wait','verifying','failed'\)/,
  );
  assert.match(
    migration,
    /a visible result table is missing immutable query evidence/,
  );
  assert.match(conversationRoute, /finalizeAnswerArtifact/);
  assert.match(conversationRoute, /deferredTerminalEvent/u);
  assert.match(
    conversationRoute,
    /const finalization = result\.semanticV2[\s\S]*finalizeSemanticV2AnswerArtifact[\s\S]*finalizeAnswerArtifact/u,
  );
  assert.match(
    conversationRoute,
    /const finalization = result\.semanticV2[\s\S]*deliver\(deferredTerminalEvent\)/u,
  );
  assert.doesNotMatch(
    conversationRoute,
    /completeConversationTurn|recordConversationModelUsage/,
  );
  assert.match(
    semanticV2Finalizer,
    /is operator-derived and cannot be Verified/iu,
  );
  assert.match(
    semanticV2Finalizer,
    /claim\.type === "causal" \|\| claim\.type === "recommendation"/u,
  );
  assert.match(semanticV2Finalizer, /resolveOperatorOutputPathV2/u);
  assert.match(
    semanticV2Finalizer,
    /validateRecommendationOperatorEvidenceV2/u,
  );
  assert.match(
    semanticV2Finalizer,
    /failed deterministic evidence validation/u,
  );
});

test("unfinalized terminals never reappear in history, model context or turn lineage", () => {
  assert.match(
    finalizationFences,
    /conversation_turns_one_running_per_conversation/u,
  );
  assert.match(
    finalizationFences,
    /turn\.status='completed'[\s\S]*JOIN control_plane\.answer_artifacts/u,
  );
  assert.match(
    finalizationFences,
    /event\.event->>'type' NOT IN \('answer','clarification'\)[\s\S]*turn\.status='completed'[\s\S]*answer_artifacts/u,
  );
  assert.match(
    migration,
    /albert_turn_answer_lineage[\s\S]*FROM control_plane\.answer_artifacts/u,
  );
  assert.match(
    conversationRoute,
    /appendCurrentUserMessage\([\s\S]*loadConversationModelContext[\s\S]*parsed\.data\.message/u,
  );
});

test("turn idempotency is owner-bound and accepts only an exact immutable retry", () => {
  assert.match(finalizationFences, /owned_conversation\.created_by=actor/u);
  assert.match(finalizationFences, /turn\.created_by=actor/u);
  assert.match(
    finalizationFences,
    /existing_user_message<>btrim\(p_user_message\)/u,
  );
  assert.match(
    finalizationFences,
    /existing_runtime_profile<>p_runtime_profile/u,
  );
  assert.match(finalizationFences, /turn id collision/u);
});

test("query audits bind IR, bundle, SQL hash, result digest and validation without exposing SQL", () => {
  assert.match(semanticService, /queryAuditId/);
  assert.match(semanticService, /compilerOutputHash/);
  assert.match(liveRuntime, /queryAuditIds\.push/);
  assert.match(migration, /'normalizedIr'/);
  assert.match(migration, /'compilerOutputHash'/);
  assert.match(migration, /'resultDigest'/);
  assert.match(migration, /query_item->'validation'/);
  assert.match(migration, /trace_document/);
  assert.match(semanticHttp, /\/v1\/answer-artifacts\/finalize/);
  assert.doesNotMatch(lineageRoute, /compiled_sql|normalizedIr|semantic_ir/i);
  assert.match(turnLineageRoute, /loadTurnAnswerLineage/);
  assert.match(adr, /never returns compiled SQL, prompts, raw tool/);
});

test("Postgres finalizer resolves only exact tenant turn query audits before control commit", async () => {
  const statements: string[] = [];
  const metadataPool = poolFor(async (sql, parameters) => {
    statements.push(sql);
    if (sql.includes("FROM semantic_internal.query_audit")) {
      assert.deepEqual(parameters, [
        "01K1ZZZZZZ0000000000000001",
        "01K1ZZZZZZ0000000000000002",
        "01K1ZZZZZZ0000000000000003",
        ["01K1ZZZZZZ0000000000000004"],
      ]);
      return {
        rows: [
          {
            query_id: "01K1ZZZZZZ0000000000000004",
            route: "semantic",
            topic: "sales_performance",
            bundle_hash: "a".repeat(64),
            registry_version: "2026.08.03",
            ir: { kind: "single", topic: "sales_performance" },
            compiled_sql:
              "SELECT governed_value FROM mart.sales_day_location WHERE tenant_id=$1",
            result_digest: "b".repeat(64),
            answer_state: "verified",
            validation: {
              status: "passed",
              checks: [{ checkId: "no_fanout", status: "passed" }],
            },
          },
        ],
      };
    }
    return { rows: [] };
  });
  const controlPool = poolFor(async (sql, parameters) => {
    statements.push(sql);
    if (sql.includes("control_plane.finalize_answer_artifact")) {
      const executions = JSON.parse(String(parameters?.[9])) as readonly Record<
        string,
        unknown
      >[];
      assert.equal(executions[0]?.queryAuditId, "01K1ZZZZZZ0000000000000004");
      assert.equal(
        executions[0]?.compilerOutputHash,
        "b0f2aa68a9d54c352067cd3162d0fcec3c7be7e8f54448ba7dd697d54e47ac82",
      );
      assert.deepEqual(executions[0]?.validation, {
        status: "passed",
        checks: [{ checkId: "no_fanout", status: "passed" }],
      });
      assert.equal(
        JSON.stringify(executions).includes("SELECT governed_value"),
        false,
      );
      return {
        rows: [
          {
            answer_artifact_id: "01K1ZZZZZZ0000000000000005",
            artifact_digest: "c".repeat(64),
            idempotent_replay: false,
          },
        ],
      };
    }
    return { rows: [] };
  });
  const finalizer = new PostgresAnswerArtifactFinalizer(
    controlPool,
    metadataPool,
  );
  const result = await finalizer.finalize({
    tenantId: "01K1ZZZZZZ0000000000000001",
    actorUserId: "10000000-0000-4000-8000-000000000001",
    conversationId: "01K1ZZZZZZ0000000000000002",
    turnId: "01K1ZZZZZZ0000000000000003",
    providerResponseId: "resp_123",
    providerUsage: { inputTokens: 20, outputTokens: 10 },
    answerState: "verified",
    turnResultDigest: `sha256:${"d".repeat(64)}`,
    metering: {
      rateCardId: "openai-2026-08-03",
      model: "gpt-5.6-sol",
      fastMode: false,
      requests: 1,
      inputTokens: 20,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      estimatedCostUsdMicros: 100,
      pricingCompleteness: "request_level",
    },
    queryAuditIds: ["01K1ZZZZZZ0000000000000004"],
  });
  assert.equal(result.answerArtifactId, "01K1ZZZZZZ0000000000000005");
  assert.ok(
    statements.some((sql) => sql === "SET LOCAL ROLE semantic_meta_rw"),
  );
  assert.ok(
    statements.some((sql) => sql.includes("pg_advisory_xact_lock_shared")),
  );
  assert.ok(
    statements.some((sql) => sql === "SET LOCAL ROLE albert_semantic_control"),
  );
});

test("Semantic V2 finalization verifies claim cells and atomically records insight memory", async () => {
  const statements: string[] = [];
  const controlPool = poolFor(async (sql, parameters) => {
    statements.push(sql);
    if (sql.includes("FROM control_plane.query_execution_snapshots_v2 s"))
      return {
        rows: [
          {
            execution_id: "01K2ZZZZZZ0000000000000004",
            workspace_id: "01K2ZZZZZZ0000000000000005",
            workspace_revision: 1,
            publication_hash: "a".repeat(64),
            normalized_plan_hash: "b".repeat(64),
            compiler_output_hash: "c".repeat(64),
            result_digest: "d".repeat(64),
            source_watermarks: { lightspeed: "2026-08-09" },
            validation: {
              passed: true,
              explainCostPassed: true,
              tenantIsolationPassed: true,
              fanoutSafetyPassed: true,
              evidenceComplete: true,
            },
            terminal_state: "verified",
            registry_version: "2.0.0",
            workspace_document: v2WorkspaceDocument(),
          },
        ],
      };
    if (sql.includes("FROM control_plane.investigation_plans_v2"))
      return {
        rows: [{ revision: 3, status: "sufficient", plan: { hypotheses: [] } }],
      };
    if (
      sql.includes("FROM control_plane.evidence_artifacts_v2") &&
      sql.includes("evidence_type='result'")
    )
      return {
        rows: [
          {
            execution_id: "01K2ZZZZZZ0000000000000004",
            result_id: "sales.current",
            artifact: {
              queryId: "sales.current",
              rows: [{ "commerce.net_sales_ex_gst": 123.45 }],
            },
          },
        ],
      };
    if (sql.includes("control_plane.finalize_semantic_v2_answer_artifact")) {
      const executions = JSON.parse(String(parameters?.[9])) as readonly Record<
        string,
        unknown
      >[];
      assert.equal(executions[0]?.topic, "business.sales_performance");
      assert.deepEqual(executions[0]?.normalizedIr, {
        workspaceId: "01K2ZZZZZZ0000000000000005",
        workspaceRevision: 1,
        normalizedPlanHash: "b".repeat(64),
        sourceWatermarks: { lightspeed: "2026-08-09" },
        topicIds: ["business.sales_performance"],
        dimensionIds: ["commerce_sales_event.business_date"],
        measureIds: ["commerce.net_sales_ex_gst"],
      });
      return {
        rows: [
          {
            answer_artifact_id: "01K2ZZZZZZ0000000000000006",
            artifact_digest: "e".repeat(64),
            idempotent_replay: false,
          },
        ],
      };
    }
    return { rows: [] };
  });
  const finalizer = new PostgresAnswerArtifactFinalizer(
    controlPool,
    poolFor(async () => ({ rows: [] })),
  );
  const result = await finalizer.finalizeSemanticV2({
    tenantId: "01K2ZZZZZZ0000000000000001",
    actorUserId: "20000000-0000-4000-8000-000000000001",
    conversationId: "01K2ZZZZZZ0000000000000002",
    turnId: "01K2ZZZZZZ0000000000000003",
    providerResponseId: "resp_v2",
    providerUsage: {
      requests: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    answerState: "verified",
    turnResultDigest: `sha256:${"f".repeat(64)}`,
    metering: {
      rateCardId: "openai-gpt-5.6-au-2026-08-03",
      model: "gpt-5.6-luna",
      fastMode: false,
      requests: 1,
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 5,
      estimatedCostUsdMicros: 10,
      pricingCompleteness: "request_level",
    },
    executionIds: ["01K2ZZZZZZ0000000000000004"],
    publicationHash: "a".repeat(64),
    investigationId: "01K2ZZZZZZ0000000000000007",
    claims: [
      {
        id: "net-sales",
        text: "Net sales were $123.45.",
        type: "numeric",
        evidenceRefs: [
          {
            executionId: "01K2ZZZZZZ0000000000000004",
            resultId: "sales.current",
            rowIndex: 0,
            columnKey: "commerce.net_sales_ex_gst",
            publicationHash: "a".repeat(64),
          },
        ],
        semanticState: "verified",
        limitations: [],
        competingHypothesisRefs: [],
      },
    ],
  });
  assert.equal(result.answerArtifactId, "01K2ZZZZZZ0000000000000006");
  assert.ok(
    statements.some((sql) =>
      sql.includes("finalize_semantic_v2_answer_artifact"),
    ),
  );
  assert.ok(
    statements.some((sql) =>
      sql.includes("INSERT INTO control_plane.insight_ledger_v2"),
    ),
  );
  assert.ok(
    statements.some((sql) =>
      sql.includes("evidence_digest=excluded.evidence_digest"),
    ),
  );
});

test("Semantic V2 finalization rejects incomplete persisted validation receipts", async () => {
  const statements: string[] = [];
  const controlPool = poolFor(async (sql) => {
    statements.push(sql);
    if (sql.includes("FROM control_plane.query_execution_snapshots_v2 s"))
      return {
        rows: [
          {
            execution_id: "01K2VVVVVV0000000000000004",
            workspace_id: "01K2VVVVVV0000000000000005",
            workspace_revision: 1,
            publication_hash: "a".repeat(64),
            normalized_plan_hash: "b".repeat(64),
            compiler_output_hash: "c".repeat(64),
            result_digest: "d".repeat(64),
            source_watermarks: {},
            validation: {
              passed: true,
              explainCostPassed: true,
              tenantIsolationPassed: true,
              evidenceComplete: true,
            },
            terminal_state: "no_data",
            registry_version: "2.0.0",
            workspace_document: v2WorkspaceDocument(),
          },
        ],
      };
    if (sql.includes("FROM control_plane.investigation_plans_v2"))
      return {
        rows: [{ revision: 1, status: "sufficient", plan: { hypotheses: [] } }],
      };
    if (sql.includes("finalize_semantic_v2_answer_artifact"))
      throw new Error("finalization must not be reached");
    return { rows: [] };
  });
  const finalizer = new PostgresAnswerArtifactFinalizer(
    controlPool,
    poolFor(async () => ({ rows: [] })),
  );
  await assert.rejects(
    () =>
      finalizer.finalizeSemanticV2({
        tenantId: "01K2VVVVVV0000000000000001",
        actorUserId: "20000000-0000-4000-8000-000000000001",
        conversationId: "01K2VVVVVV0000000000000002",
        turnId: "01K2VVVVVV0000000000000003",
        providerResponseId: "resp_incomplete_validation",
        providerUsage: {
          requests: 1,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
        answerState: "no_data",
        turnResultDigest: `sha256:${"f".repeat(64)}`,
        metering: {
          rateCardId: "openai-gpt-5.6-au-2026-08-03",
          model: "gpt-5.6-luna",
          fastMode: false,
          requests: 1,
          inputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          estimatedCostUsdMicros: 10,
          pricingCompleteness: "request_level",
        },
        executionIds: ["01K2VVVVVV0000000000000004"],
        publicationHash: "a".repeat(64),
        investigationId: "01K2VVVVVV0000000000000007",
        claims: [],
      }),
    /complete passing Semantic V2 validation receipts/iu,
  );
  assert.ok(
    !statements.some((sql) =>
      sql.includes("finalize_semantic_v2_answer_artifact"),
    ),
  );
});

test("Semantic V2 finalization rejects a figure absent from the claim's exact cited cell", async () => {
  const statements: string[] = [];
  const controlPool = poolFor(async (sql) => {
    statements.push(sql);
    if (sql.includes("FROM control_plane.query_execution_snapshots_v2 s"))
      return {
        rows: [
          {
            execution_id: "01K2YYYYYY0000000000000004",
            workspace_id: "01K2YYYYYY0000000000000005",
            workspace_revision: 1,
            publication_hash: "a".repeat(64),
            normalized_plan_hash: "b".repeat(64),
            compiler_output_hash: "c".repeat(64),
            result_digest: "d".repeat(64),
            source_watermarks: {},
            validation: {
              passed: true,
              explainCostPassed: true,
              tenantIsolationPassed: true,
              fanoutSafetyPassed: true,
              evidenceComplete: true,
            },
            terminal_state: "verified",
            registry_version: "2.0.0",
            workspace_document: v2WorkspaceDocument(),
          },
        ],
      };
    if (sql.includes("FROM control_plane.investigation_plans_v2"))
      return {
        rows: [{ revision: 2, status: "sufficient", plan: { hypotheses: [] } }],
      };
    if (sql.includes("evidence_type='result'"))
      return {
        rows: [
          {
            execution_id: "01K2YYYYYY0000000000000004",
            result_id: "sales.current",
            artifact: {
              queryId: "sales.current",
              rows: [{ "commerce.net_sales_ex_gst": 123.45 }],
            },
          },
        ],
      };
    if (sql.includes("finalize_semantic_v2_answer_artifact"))
      throw new Error("finalization must not be reached");
    return { rows: [] };
  });
  const finalizer = new PostgresAnswerArtifactFinalizer(
    controlPool,
    poolFor(async () => ({ rows: [] })),
  );
  await assert.rejects(
    () =>
      finalizer.finalizeSemanticV2({
        tenantId: "01K2YYYYYY0000000000000001",
        actorUserId: "20000000-0000-4000-8000-000000000001",
        conversationId: "01K2YYYYYY0000000000000002",
        turnId: "01K2YYYYYY0000000000000003",
        providerResponseId: "resp_wrong_number",
        providerUsage: {
          requests: 1,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
        answerState: "verified",
        turnResultDigest: `sha256:${"f".repeat(64)}`,
        metering: {
          rateCardId: "openai-gpt-5.6-au-2026-08-03",
          model: "gpt-5.6-luna",
          fastMode: false,
          requests: 1,
          inputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          estimatedCostUsdMicros: 10,
          pricingCompleteness: "request_level",
        },
        executionIds: ["01K2YYYYYY0000000000000004"],
        publicationHash: "a".repeat(64),
        investigationId: "01K2YYYYYY0000000000000007",
        claims: [
          {
            id: "wrong-net-sales",
            text: "Net sales were $999.",
            type: "numeric",
            semanticState: "verified",
            limitations: [],
            competingHypothesisRefs: [],
            evidenceRefs: [
              {
                executionId: "01K2YYYYYY0000000000000004",
                resultId: "sales.current",
                rowIndex: 0,
                columnKey: "commerce.net_sales_ex_gst",
                publicationHash: "a".repeat(64),
              },
            ],
          },
        ],
      }),
    /figures absent from its exact cited evidence/iu,
  );
  assert.ok(
    !statements.some((sql) =>
      sql.includes("finalize_semantic_v2_answer_artifact"),
    ),
  );
});

test("Semantic V2 finalization rejects an operator citation unrelated to the referenced result", async () => {
  const controlPool = poolFor(async (sql) => {
    if (sql.includes("FROM control_plane.query_execution_snapshots_v2 s"))
      return {
        rows: [
          {
            execution_id: "01K2XXXXXX0000000000000004",
            workspace_id: "01K2XXXXXX0000000000000005",
            workspace_revision: 1,
            publication_hash: "a".repeat(64),
            normalized_plan_hash: "b".repeat(64),
            compiler_output_hash: "c".repeat(64),
            result_digest: "d".repeat(64),
            source_watermarks: {},
            validation: {
              passed: true,
              explainCostPassed: true,
              tenantIsolationPassed: true,
              fanoutSafetyPassed: true,
              evidenceComplete: true,
            },
            terminal_state: "verified",
            registry_version: "2.0.0",
            workspace_document: v2WorkspaceDocument(),
          },
        ],
      };
    if (sql.includes("FROM control_plane.investigation_plans_v2"))
      return {
        rows: [{ revision: 2, status: "sufficient", plan: { hypotheses: [] } }],
      };
    if (sql.includes("evidence_type='operator'"))
      return {
        rows: [
          {
            evidence_id: "01K2XXXXXX0000000000000008",
            execution_id: "01K2XXXXXX0000000000000004",
            artifact: {
              publicationHash: "a".repeat(64),
              sourceReferences: ["another-execution:another-result"],
              output: { totalChange: "10" },
            },
          },
        ],
      };
    return { rows: [] };
  });
  const finalizer = new PostgresAnswerArtifactFinalizer(
    controlPool,
    poolFor(async () => ({ rows: [] })),
  );
  await assert.rejects(
    () =>
      finalizer.finalizeSemanticV2({
        tenantId: "01K2XXXXXX0000000000000001",
        actorUserId: "20000000-0000-4000-8000-000000000001",
        conversationId: "01K2XXXXXX0000000000000002",
        turnId: "01K2XXXXXX0000000000000003",
        providerResponseId: "resp_wrong_operator",
        providerUsage: {
          requests: 1,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
        answerState: "derived",
        turnResultDigest: `sha256:${"f".repeat(64)}`,
        metering: {
          rateCardId: "openai-gpt-5.6-au-2026-08-03",
          model: "gpt-5.6-luna",
          fastMode: false,
          requests: 1,
          inputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 5,
          estimatedCostUsdMicros: 10,
          pricingCompleteness: "request_level",
        },
        executionIds: ["01K2XXXXXX0000000000000004"],
        publicationHash: "a".repeat(64),
        investigationId: "01K2XXXXXX0000000000000007",
        claims: [
          {
            id: "wrong-operator",
            text: "The derived change was $10.",
            type: "numeric",
            semanticState: "derived",
            limitations: [],
            competingHypothesisRefs: [],
            evidenceRefs: [
              {
                executionId: "01K2XXXXXX0000000000000004",
                resultId: "sales.current",
                operatorArtifactId: "01K2XXXXXX0000000000000008",
                operatorOutputPath: ["totalChange"],
                publicationHash: "a".repeat(64),
              },
            ],
          },
        ],
      }),
    /operator that was not derived from the referenced result/iu,
  );
});

function poolFor(
  query: (
    sql: string,
    parameters?: readonly unknown[],
  ) => Promise<
    Readonly<{ rows: readonly Readonly<Record<string, unknown>>[] }>
  >,
): PgPoolLike {
  return {
    async connect(): Promise<PgClientLike> {
      return { query, release() {} };
    },
  };
}
