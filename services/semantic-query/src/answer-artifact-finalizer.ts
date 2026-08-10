import { z } from "zod";
import { ulid } from "ulid";
import {
  findUngroundedClaimNumbersV2,
  resolveOperatorOutputPathV2,
  semanticClaimEvidenceDigestV2,
  semanticInsightKeyV2,
  validateRecommendationOperatorEvidenceV2,
} from "../../../packages/analytics-v2/src/evidence.js";
import { queryWorkspaceV2Schema } from "../../../packages/analytics-v2/src/workspace.js";
import {
  answerArtifactFinalizationInputSchema,
  answerArtifactFinalizationResultSchema,
  semanticV2AnswerArtifactFinalizationInputSchema,
  type AnswerArtifactFinalizationInput,
  type AnswerArtifactFinalizationResult,
  type SemanticV2AnswerArtifactFinalizationInput,
} from "../../../packages/shared/src/index.js";
import { contentDigest } from "./bundle.js";
import type {
  PgPoolLike,
  SemanticAnalyticalCapabilityIssuer,
} from "./database.js";

const queryAuditRowSchema = z
  .object({
    query_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    route: z.enum(["semantic", "source_exploration", "sql_first"]),
    topic: z.string().nullable(),
    bundle_hash: z.string().regex(/^[a-f0-9]{64}$/),
    registry_version: z.string().min(1),
    ir: z.record(z.string(), z.unknown()),
    compiled_sql: z.string().min(1),
    result_digest: z.string().regex(/^[a-f0-9]{64}$/),
    answer_state: z.enum([
      "verified",
      "qualified",
      "exploratory",
      "clarification",
      "unavailable",
    ]),
    validation: z.record(z.string(), z.unknown()),
  })
  .strict();

const finalizationRowSchema = z
  .object({
    answer_artifact_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    artifact_digest: z.string().regex(/^[a-f0-9]{64}$/),
    idempotent_replay: z.boolean(),
  })
  .strict();

export interface AnswerArtifactFinalizer {
  finalize(
    input: AnswerArtifactFinalizationInput,
  ): Promise<AnswerArtifactFinalizationResult>;
  finalizeSemanticV2(
    input: SemanticV2AnswerArtifactFinalizationInput,
  ): Promise<AnswerArtifactFinalizationResult>;
}

/**
 * Per-step cost of one finalization, including any retried attempts.
 * Finalization runs after the answer text exists but before it is released, so
 * its cost is felt directly as time the user waits on a finished answer. The
 * connect timings separate pool contention from actual query work.
 */
export type AnswerArtifactFinalizationTiming = Readonly<{
  totalMs: number;
  attempts: number;
  /** Waiting for a semantic-metadata pool connection. */
  metadataConnectMs: number;
  /** Deletion advisory lock plus the query-audit read, once connected. */
  metadataQueryMs: number;
  /** Waiting for a control-plane pool connection. */
  controlPlaneConnectMs: number;
  /** The `finalize_answer_artifact` call itself. */
  finalizeCallMs: number;
  commitMs: number;
}>;

type TimingAccumulator = {
  attempts: number;
  metadataConnectMs: number;
  metadataQueryMs: number;
  controlPlaneConnectMs: number;
  finalizeCallMs: number;
  commitMs: number;
};

function newTimingAccumulator(): TimingAccumulator {
  return {
    attempts: 0,
    metadataConnectMs: 0,
    metadataQueryMs: 0,
    controlPlaneConnectMs: 0,
    finalizeCallMs: 0,
    commitMs: 0,
  };
}

/**
 * Resolves immutable analytical audit rows before asking the control plane to
 * atomically finalize the turn. Only audit identifiers cross the signed HTTP
 * boundary; SQL is hashed here and remains confined to the server trust zone.
 */
export class PostgresAnswerArtifactFinalizer implements AnswerArtifactFinalizer {
  constructor(
    private readonly controlPlanePool: PgPoolLike,
    private readonly semanticMetadataPool: PgPoolLike,
    private readonly capabilityIssuer?: SemanticAnalyticalCapabilityIssuer,
    /** Receives the per-step cost of every finalization, successful or not. */
    private readonly onTiming?: (
      timing: AnswerArtifactFinalizationTiming,
    ) => void,
  ) {}

  async finalize(
    rawInput: AnswerArtifactFinalizationInput,
  ): Promise<AnswerArtifactFinalizationResult> {
    const input = answerArtifactFinalizationInputSchema.parse(rawInput);
    const startedAt = Date.now();
    const timing = newTimingAccumulator();
    try {
      // The pooler recycles connections underneath us. Finalization is the last
      // step of an otherwise complete turn, and every attempt either commits or
      // rolls back whole, so a dropped connection is retried rather than losing
      // the answer. A committed attempt replays idempotently inside the control
      // plane, which keeps a retry safe even if the drop hid a successful commit.
      for (let attempt = 0; ; attempt += 1) {
        timing.attempts = attempt + 1;
        try {
          return await this.attemptFinalize(input, timing);
        } catch (error) {
          if (attempt >= 2 || !isRecoverableConnectionFailure(error))
            throw error;
        }
      }
    } finally {
      // Reported on the failure path too: a finalization that exhausted its
      // retries is exactly the one whose cost needs explaining.
      this.onTiming?.(
        Object.freeze({ totalMs: Date.now() - startedAt, ...timing }),
      );
    }
  }

  async finalizeSemanticV2(
    rawInput: SemanticV2AnswerArtifactFinalizationInput,
  ): Promise<AnswerArtifactFinalizationResult> {
    const input =
      semanticV2AnswerArtifactFinalizationInputSchema.parse(rawInput);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.attemptFinalizeSemanticV2(input);
      } catch (error) {
        if (attempt >= 2 || !isRecoverableConnectionFailure(error)) throw error;
      }
    }
  }

  private async attemptFinalizeSemanticV2(
    input: SemanticV2AnswerArtifactFinalizationInput,
  ): Promise<AnswerArtifactFinalizationResult> {
    const client = await this.controlPlanePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE albert_semantic_control");
      await client.query("SELECT set_config('albert.tenant_id',$1,true)", [
        input.tenantId,
      ]);
      const snapshots =
        input.executionIds.length === 0
          ? []
          : (
              await client.query(
                `SELECT s.execution_id,s.workspace_id,s.workspace_revision,s.publication_hash,
                s.normalized_plan_hash,s.compiler_output_hash,s.result_digest,
                s.source_watermarks,s.validation,s.terminal_state,p.registry_version,
                r.document AS workspace_document
           FROM control_plane.query_execution_snapshots_v2 s
           JOIN control_plane.query_workspaces_v2 w
             ON w.tenant_id=s.tenant_id AND w.workspace_id=s.workspace_id
           JOIN control_plane.query_workspace_revisions_v2 r
             ON r.tenant_id=s.tenant_id AND r.workspace_id=s.workspace_id
            AND r.revision=s.workspace_revision
           JOIN control_plane.semantic_v2_publications p
             ON p.publication_hash=s.publication_hash
          WHERE s.tenant_id=$1 AND w.question_id=$2
            AND s.execution_id=ANY($3::text[])
          ORDER BY array_position($3::text[],s.execution_id)`,
                [input.tenantId, input.turnId, input.executionIds],
              )
            ).rows;
      if (
        snapshots.length !== input.executionIds.length ||
        snapshots.some(
          (row, index) => row.execution_id !== input.executionIds[index],
        )
      ) {
        throw new Error(
          "One or more Semantic V2 executions do not belong to this tenant turn.",
        );
      }
      if (
        snapshots.some((row) => row.publication_hash !== input.publicationHash)
      )
        throw new Error("Semantic V2 answer evidence crosses publications.");

      const investigation = input.investigationId
        ? ((
            await client.query(
              `SELECT revision,status,plan FROM control_plane.investigation_plans_v2
          WHERE tenant_id=$1 AND investigation_id=$2 AND conversation_id=$3 AND turn_id=$4`,
              [
                input.tenantId,
                input.investigationId,
                input.conversationId,
                input.turnId,
              ],
            )
          ).rows[0] as
            | {
                revision: number;
                status: string;
                plan: Record<string, unknown>;
              }
            | undefined)
        : undefined;
      if (input.investigationId && !investigation)
        throw new Error(
          "The Semantic V2 investigation does not belong to this tenant turn.",
        );
      if (
        ["verified", "derived", "exploratory", "no_data"].includes(
          input.answerState,
        ) &&
        investigation?.status !== "sufficient"
      ) {
        throw new Error(
          "A completed Semantic V2 analytical answer requires a sufficient investigation.",
        );
      }

      const cellReferences = input.claims.flatMap((claim) =>
        claim.evidenceRefs.filter(
          (reference) => reference.rowIndex !== undefined,
        ),
      );
      const resultPairs = [
        ...new Set(
          cellReferences.map(
            (reference) => `${reference.executionId}:${reference.resultId}`,
          ),
        ),
      ];
      const resultRows =
        resultPairs.length === 0
          ? []
          : (
              await client.query(
                `SELECT execution_id,artifact->>'queryId' AS result_id,artifact
           FROM control_plane.evidence_artifacts_v2
          WHERE tenant_id=$1 AND evidence_type='result'
            AND (execution_id||':'||(artifact->>'queryId'))=ANY($2::text[])`,
                [input.tenantId, resultPairs],
              )
            ).rows;
      const results = new Map(
        resultRows.map((row) => [
          `${row.execution_id}:${row.result_id}`,
          row.artifact as Record<string, unknown>,
        ]),
      );
      if (results.size !== resultPairs.length)
        throw new Error("One or more claim cell references do not exist.");

      const operatorIds = [
        ...new Set(
          input.claims.flatMap((claim) =>
            claim.evidenceRefs.flatMap((reference) =>
              reference.operatorArtifactId
                ? [reference.operatorArtifactId]
                : [],
            ),
          ),
        ),
      ];
      const operatorRows =
        operatorIds.length === 0
          ? []
          : (
              await client.query(
                `SELECT evidence_id,execution_id,artifact
           FROM control_plane.evidence_artifacts_v2
          WHERE tenant_id=$1 AND evidence_type='operator' AND evidence_id=ANY($2::text[])`,
                [input.tenantId, operatorIds],
              )
            ).rows;
      const operators = new Map(
        operatorRows.map((row) => [
          String(row.evidence_id),
          {
            executionId: String(row.execution_id),
            artifact: row.artifact as Record<string, unknown>,
          },
        ]),
      );
      if (operators.size !== operatorIds.length)
        throw new Error("One or more claim operator references do not exist.");

      const hypothesisStates = new Map<string, string>();
      if (investigation && Array.isArray(investigation.plan.hypotheses)) {
        for (const item of investigation.plan.hypotheses)
          if (
            item &&
            typeof item === "object" &&
            typeof (item as Record<string, unknown>).id === "string"
          )
            hypothesisStates.set(
              String((item as Record<string, unknown>).id),
              String((item as Record<string, unknown>).status),
            );
      }
      for (const claim of input.claims) {
        const citedEvidence: unknown[] = [];
        const operatorValues: Array<
          Readonly<{
            operatorId: string;
            path: readonly (string | number)[];
            value: unknown;
          }>
        > = [];
        if (
          claim.semanticState === "verified" &&
          claim.evidenceRefs.some((reference) => reference.operatorArtifactId)
        )
          throw new Error(
            `Claim ${claim.id} is operator-derived and cannot be Verified.`,
          );
        for (const reference of claim.evidenceRefs) {
          if (!input.executionIds.includes(reference.executionId))
            throw new Error(
              `Claim ${claim.id} references an execution outside the answer artifact.`,
            );
          if (reference.publicationHash !== input.publicationHash)
            throw new Error(`Claim ${claim.id} crosses semantic publications.`);
          if (
            reference.rowIndex !== undefined &&
            reference.columnKey !== undefined
          ) {
            const artifact = results.get(
              `${reference.executionId}:${reference.resultId}`,
            );
            const rows =
              artifact && Array.isArray(artifact.rows) ? artifact.rows : [];
            const row = rows[reference.rowIndex];
            if (
              !row ||
              typeof row !== "object" ||
              !Object.prototype.hasOwnProperty.call(row, reference.columnKey)
            )
              throw new Error(
                `Claim ${claim.id} references a missing governed cell.`,
              );
            citedEvidence.push(
              (row as Record<string, unknown>)[reference.columnKey],
            );
          }
          if (reference.operatorArtifactId) {
            const operator = operators.get(reference.operatorArtifactId);
            if (
              !operator ||
              operator.artifact.publicationHash !== input.publicationHash
            )
              throw new Error(
                `Claim ${claim.id} references an invalid operator artifact.`,
              );
            const sourceReferences = Array.isArray(
              operator.artifact.sourceReferences,
            )
              ? operator.artifact.sourceReferences.filter(
                  (value): value is string => typeof value === "string",
                )
              : Array.isArray(operator.artifact.sourceResultIds)
                ? operator.artifact.sourceResultIds.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [];
            if (
              !sourceReferences.includes(
                `${reference.executionId}:${reference.resultId}`,
              )
            )
              throw new Error(
                `Claim ${claim.id} cites an operator that was not derived from the referenced result.`,
              );
            const resolved = resolveOperatorOutputPathV2(
              operator.artifact.output,
              reference.operatorOutputPath ?? [],
            );
            if (!resolved.found)
              throw new Error(
                `Claim ${claim.id} references a missing operator output path.`,
              );
            citedEvidence.push(resolved.value);
            operatorValues.push({
              operatorId: String(operator.artifact.operatorId),
              path: reference.operatorOutputPath ?? [],
              value: resolved.value,
            });
          }
        }
        const ungroundedNumbers = findUngroundedClaimNumbersV2(
          claim.text,
          citedEvidence,
        );
        if (ungroundedNumbers.length)
          throw new Error(
            `Claim ${claim.id} contains figures absent from its exact cited evidence: ${ungroundedNumbers.join(", ")}.`,
          );
        if (claim.type === "causal") {
          const states = claim.competingHypothesisRefs.map((id) =>
            hypothesisStates.get(id),
          );
          if (
            states.length < 2 ||
            states.some((state) => !state) ||
            !states.includes("supported") ||
            !states.some(
              (state) => state === "refuted" || state === "inconclusive",
            )
          ) {
            throw new Error(
              `Causal claim ${claim.id} lacks resolved competing-hypothesis evidence.`,
            );
          }
        }
        if (
          (claim.type === "causal" || claim.type === "recommendation") &&
          claim.evidenceRefs.every((reference) => !reference.operatorArtifactId)
        )
          throw new Error(
            `${claim.type === "causal" ? "Causal claim" : "Recommendation"} ${claim.id} lacks deterministic operator evidence.`,
          );
        const recommendationIssues = validateRecommendationOperatorEvidenceV2(
          claim,
          operatorValues,
        );
        if (recommendationIssues.length)
          throw new Error(
            `Recommendation ${claim.id} failed deterministic evidence validation: ${recommendationIssues.join(" ")}`,
          );
      }
      assertSemanticV2EvidenceMatchesAnswerState(input, snapshots);

      const queryExecutions = snapshots.map((row) => {
        const workspace = queryWorkspaceV2Schema.parse(row.workspace_document);
        const topicIds = [
          ...new Set(workspace.blocks.flatMap(({ topicIds }) => topicIds)),
        ].sort();
        const dimensionIds = [
          ...new Set(
            workspace.blocks.flatMap(({ dimensionIds }) => dimensionIds),
          ),
        ].sort();
        const measureIds = [
          ...new Set(workspace.blocks.flatMap(({ measureIds }) => measureIds)),
        ].sort();
        return Object.freeze({
          queryAuditId: row.execution_id,
          route: "semantic_v2",
          topic: topicIds.join(" + "),
          bundleHash: row.publication_hash,
          registryVersion: row.registry_version,
          normalizedIr: {
            workspaceId: row.workspace_id,
            workspaceRevision: row.workspace_revision,
            normalizedPlanHash: row.normalized_plan_hash,
            sourceWatermarks: row.source_watermarks,
            topicIds,
            dimensionIds,
            measureIds,
          },
          compilerOutputHash: row.compiler_output_hash,
          resultDigest: row.result_digest,
          answerState: row.terminal_state,
          validation: row.validation,
        });
      });
      const result = await client.query(
        `SELECT answer_artifact_id,artifact_digest,idempotent_replay
           FROM control_plane.finalize_semantic_v2_answer_artifact(
             $1,$2::uuid,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12
           )`,
        [
          input.tenantId,
          input.actorUserId,
          input.conversationId,
          input.turnId,
          input.providerResponseId,
          JSON.stringify(input.providerUsage),
          input.answerState,
          input.turnResultDigest,
          JSON.stringify(input.metering),
          JSON.stringify(queryExecutions),
          JSON.stringify(input.claims),
          input.investigationId,
        ],
      );
      const row = finalizationRowSchema.parse(result.rows[0]);
      if (
        !row.idempotent_replay &&
        (input.answerState === "clarification" ||
          input.answerState === "unavailable")
      ) {
        const turn = await client.query(
          `SELECT user_message FROM control_plane.conversation_turns
            WHERE tenant_id=$1 AND conversation_id=$2 AND turn_id=$3`,
          [input.tenantId, input.conversationId, input.turnId],
        );
        const questionDigest = contentDigest(
          String(turn.rows[0]?.user_message ?? input.turnId)
            .trim()
            .toLowerCase(),
        );
        await client.query(
          `INSERT INTO control_plane.semantic_runtime_events_v2(
             tenant_id,event_id,turn_id,publication_hash,event_kind,reason_code,
             question_digest,topic_ids,object_ids,detail
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb,'[]'::jsonb,$8::jsonb)`,
          [
            input.tenantId,
            ulid(),
            input.turnId,
            input.publicationHash,
            input.answerState,
            input.answerState === "clarification"
              ? "MATERIAL_AMBIGUITY"
              : "SEMANTIC_UNAVAILABLE",
            questionDigest,
            JSON.stringify({ investigationId: input.investigationId }),
          ],
        );
      }
      if (!row.idempotent_replay) {
        for (const claim of input.claims) {
          const governedEvidence = claim.evidenceRefs.map((reference) => {
            if (
              reference.rowIndex !== undefined &&
              reference.columnKey !== undefined
            ) {
              const artifact = results.get(
                `${reference.executionId}:${reference.resultId}`,
              );
              const rows =
                artifact && Array.isArray(artifact.rows) ? artifact.rows : [];
              const sourceRow = rows[reference.rowIndex] as
                Record<string, unknown> | undefined;
              return {
                kind: "cell",
                resultId: reference.resultId,
                columnKey: reference.columnKey,
                value: sourceRow?.[reference.columnKey] ?? null,
              };
            }
            const operator = reference.operatorArtifactId
              ? operators.get(reference.operatorArtifactId)
              : undefined;
            const resolvedOperatorOutput = operator
              ? resolveOperatorOutputPathV2(
                  operator.artifact.output,
                  reference.operatorOutputPath ?? [],
                )
              : { found: false as const };
            return {
              kind: "operator",
              resultId: reference.resultId,
              artifactHash: operator?.artifact.artifactHash ?? null,
              operatorOutputPath: reference.operatorOutputPath ?? null,
              value: resolvedOperatorOutput.found
                ? resolvedOperatorOutput.value
                : null,
            };
          });
          const magnitudeCandidate =
            claim.opportunityValue ??
            governedEvidence.find(
              (item) =>
                item.kind === "cell" &&
                (typeof item.value === "number" ||
                  typeof item.value === "string"),
            )?.value;
          const magnitude =
            magnitudeCandidate !== undefined &&
            magnitudeCandidate !== null &&
            Number.isFinite(Number(magnitudeCandidate))
              ? String(magnitudeCandidate)
              : null;
          const insightKey = semanticInsightKeyV2(claim);
          const evidenceDigest =
            semanticClaimEvidenceDigestV2(governedEvidence);
          await client.query(
            `INSERT INTO control_plane.insight_ledger_v2(
               tenant_id,insight_id,insight_key,objective,state,magnitude,unit,novelty,
               evidence_refs,evidence_digest,occurrences,last_answer_artifact_id,
               first_observed_at,last_observed_at
             ) VALUES ($1,$2,$3,$4,'active',$5,NULL,1,$6::jsonb,$7,1,$8,now(),now())
             ON CONFLICT (tenant_id,insight_key) DO UPDATE SET
               objective=excluded.objective,
               state=CASE
                 WHEN control_plane.insight_ledger_v2.state IN ('resolved','rejected','superseded')
                  AND control_plane.insight_ledger_v2.evidence_digest<>excluded.evidence_digest THEN 'active'
                 ELSE control_plane.insight_ledger_v2.state
               END,
               magnitude=excluded.magnitude,
               novelty=CASE WHEN control_plane.insight_ledger_v2.evidence_digest=excluded.evidence_digest THEN 0 ELSE 1 END,
               evidence_refs=excluded.evidence_refs,
               evidence_digest=excluded.evidence_digest,
               occurrences=control_plane.insight_ledger_v2.occurrences+1,
               last_answer_artifact_id=excluded.last_answer_artifact_id,
               last_observed_at=excluded.last_observed_at`,
            [
              input.tenantId,
              ulid(),
              insightKey,
              claim.text.slice(0, 1000),
              magnitude,
              JSON.stringify(claim.evidenceRefs),
              evidenceDigest,
              row.answer_artifact_id,
            ],
          );
        }
      }
      await client.query("COMMIT");
      return answerArtifactFinalizationResultSchema.parse({
        answerArtifactId: row.answer_artifact_id,
        artifactDigest: row.artifact_digest,
        idempotentReplay: row.idempotent_replay,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve original failure */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async attemptFinalize(
    input: AnswerArtifactFinalizationInput,
    timing: TimingAccumulator,
  ): Promise<AnswerArtifactFinalizationResult> {
    const queryExecutions = await this.loadQueryExecutions(input, timing);
    assertEvidenceMatchesAnswerState(input, queryExecutions);

    const connectStartedAt = Date.now();
    const client = await this.controlPlanePool.connect();
    timing.controlPlaneConnectMs += Date.now() - connectStartedAt;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE albert_semantic_control");
      await client.query("SELECT set_config('albert.tenant_id',$1,true)", [
        input.tenantId,
      ]);
      const finalizeStartedAt = Date.now();
      const result = await client.query(
        `SELECT answer_artifact_id,artifact_digest,idempotent_replay
           FROM control_plane.finalize_answer_artifact(
             $1,$2::uuid,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb
           )`,
        [
          input.tenantId,
          input.actorUserId,
          input.conversationId,
          input.turnId,
          input.providerResponseId,
          JSON.stringify(input.providerUsage),
          input.answerState,
          input.turnResultDigest,
          JSON.stringify(input.metering),
          JSON.stringify(queryExecutions),
        ],
      );
      timing.finalizeCallMs += Date.now() - finalizeStartedAt;
      const row = finalizationRowSchema.parse(result.rows[0]);
      const commitStartedAt = Date.now();
      await client.query("COMMIT");
      timing.commitMs += Date.now() - commitStartedAt;
      return answerArtifactFinalizationResultSchema.parse({
        answerArtifactId: row.answer_artifact_id,
        artifactDigest: row.artifact_digest,
        idempotentReplay: row.idempotent_replay,
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve the original failure */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadQueryExecutions(
    input: AnswerArtifactFinalizationInput,
    timing: TimingAccumulator,
  ): Promise<readonly Record<string, unknown>[]> {
    if (input.queryAuditIds.length === 0) return Object.freeze([]);
    const capability = this.capabilityIssuer
      ? await this.capabilityIssuer.issue({
          tenantId: input.tenantId,
          scope: "semantic_metadata",
          evidence: {
            conversationId: input.conversationId,
            turnId: input.turnId,
          },
        })
      : undefined;
    const connectStartedAt = Date.now();
    const client = await this.semanticMetadataPool.connect();
    timing.metadataConnectMs += Date.now() - connectStartedAt;
    const queryStartedAt = Date.now();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query("SET LOCAL ROLE semantic_meta_rw");
      if (capability) {
        await client.query(
          "SELECT set_config('albert.tenant_capability',$1,true)",
          [capability],
        );
      } else {
        await client.query("SELECT set_config('albert.tenant_id',$1,true)", [
          input.tenantId,
        ]);
      }
      // Keep analytical erasure from crossing the point at which immutable
      // query evidence is copied into the control-plane finalization request.
      // The deletion procedures take the matching exclusive transaction lock.
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('deletion:'||$1,0))",
        [input.tenantId],
      );
      const result = await client.query(
        `SELECT query_id,route,topic,bundle_hash,registry_version,ir,compiled_sql,
                result_digest,answer_state,validation
           FROM semantic_internal.query_audit
          WHERE tenant_id=$1
            AND conversation_id=$2
            AND turn_id=$3
            AND query_id=ANY($4::text[])
          ORDER BY array_position($4::text[],query_id)`,
        [
          input.tenantId,
          input.conversationId,
          input.turnId,
          input.queryAuditIds,
        ],
      );
      const rows = result.rows.map((row) => queryAuditRowSchema.parse(row));
      if (
        rows.length !== input.queryAuditIds.length ||
        rows.some((row, index) => row.query_id !== input.queryAuditIds[index])
      ) {
        throw new Error(
          "One or more query audit references do not belong to this tenant conversation turn.",
        );
      }
      await client.query("COMMIT");
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            queryAuditId: row.query_id,
            route: row.route,
            topic: row.topic,
            bundleHash: row.bundle_hash,
            registryVersion: row.registry_version,
            normalizedIr: row.ir,
            compilerOutputHash: contentDigest({ sql: row.compiled_sql }),
            resultDigest: row.result_digest,
            answerState: row.answer_state,
            validation: row.validation,
          }),
        ),
      );
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve the original failure */
      }
      throw error;
    } finally {
      timing.metadataQueryMs += Date.now() - queryStartedAt;
      client.release();
    }
  }
}

/**
 * Connection-level failures only. A SQLSTATE raised by the finalization
 * function itself is a real rejection and must surface unchanged.
 */
const RECOVERABLE_CONNECTION_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "57P01",
  "57P02",
  "57P03",
]);

function isRecoverableConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return RECOVERABLE_CONNECTION_CODES.has(code);
  return /Connection terminated|connection terminated|ECONNRESET|EPIPE|socket hang up/u.test(
    error.message,
  );
}

function assertEvidenceMatchesAnswerState(
  input: AnswerArtifactFinalizationInput,
  executions: readonly Readonly<Record<string, unknown>>[],
): void {
  const state = input.answerState;
  const routes = executions.map((execution) => execution.route);
  if (state === "clarification" && executions.length !== 0) {
    throw new Error(
      "Clarification turns cannot bind analytical query evidence.",
    );
  }
  const directoryAnswer =
    input.directoryEvidence !== undefined &&
    state === "qualified" &&
    input.directoryEvidence.valueCount > 0 &&
    executions.length === 0;
  if (
    ["verified", "qualified", "exploratory"].includes(state) &&
    executions.length === 0 &&
    !directoryAnswer
  ) {
    throw new Error(
      "Analytical answers require at least one immutable query audit reference.",
    );
  }
  if (
    state === "exploratory" &&
    !routes.includes("source_exploration") &&
    !routes.includes("sql_first")
  ) {
    throw new Error(
      "Exploratory answers require source-exploration or sql-first evidence.",
    );
  }
  // sql_first evidence is deliberately admissible under Verified: its structure
  // was linted before execution and its claims attested against governed
  // contracts afterwards. source_exploration carries no such attestation.
  if (state === "verified" && routes.includes("source_exploration")) {
    throw new Error(
      "Verified answers cannot be supported by source-exploration evidence.",
    );
  }
}

function assertSemanticV2EvidenceMatchesAnswerState(
  input: SemanticV2AnswerArtifactFinalizationInput,
  executions: readonly Readonly<Record<string, unknown>>[],
): void {
  const terminalStates = executions.map((execution) =>
    String(execution.terminal_state),
  );
  const claimStates = input.claims.map(({ semanticState }) => semanticState);
  const positiveState = [
    "verified",
    "derived",
    "exploratory",
    "no_data",
  ].includes(input.answerState);
  if (positiveState && executions.length === 0)
    throw new Error(
      `${input.answerState} requires immutable Semantic V2 execution evidence.`,
    );
  if (
    positiveState &&
    executions.some((execution) => {
      const validation = execution.validation as
        Readonly<Record<string, unknown>> | undefined;
      return (
        !validation ||
        validation.passed !== true ||
        validation.explainCostPassed !== true ||
        validation.tenantIsolationPassed !== true ||
        validation.fanoutSafetyPassed !== true ||
        validation.evidenceComplete !== true
      );
    })
  )
    throw new Error(
      `${input.answerState} requires complete passing Semantic V2 validation receipts.`,
    );
  if (input.answerState === "clarification" && executions.length !== 0)
    throw new Error("Clarification cannot bind Semantic V2 executions.");
  if (
    input.answerState === "no_data" &&
    (executions.length === 0 ||
      terminalStates.some((state) => state !== "no_data"))
  )
    throw new Error(
      "No-data requires only valid empty Semantic V2 executions.",
    );
  if (input.answerState === "no_data" && input.claims.length !== 0)
    throw new Error("No-data cannot contain analytical claims.");
  if (
    input.answerState === "verified" &&
    (input.claims.length === 0 ||
      claimStates.some((state) => state !== "verified") ||
      terminalStates.some((state) => state !== "verified"))
  )
    throw new Error(
      "Verified exceeds the confidence of its Semantic V2 evidence or contains no grounded claims.",
    );
  if (
    input.answerState === "derived" &&
    (!claimStates.includes("derived") ||
      claimStates.includes("exploratory") ||
      terminalStates.includes("exploratory"))
  )
    throw new Error(
      "Derived requires deterministic derived evidence without exploratory claims.",
    );
  if (
    input.answerState === "exploratory" &&
    !claimStates.includes("exploratory") &&
    !terminalStates.includes("exploratory")
  )
    throw new Error("Exploratory requires exploratory Semantic V2 evidence.");
}
