import { z } from "zod";
import {
  answerArtifactFinalizationInputSchema,
  answerArtifactFinalizationResultSchema,
  type AnswerArtifactFinalizationInput,
  type AnswerArtifactFinalizationResult,
} from "../../../packages/shared/src/index.js";
import { contentDigest } from "./bundle.js";
import type { PgPoolLike, SemanticAnalyticalCapabilityIssuer } from "./database.js";

const queryAuditRowSchema = z.object({
  query_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  route: z.enum(["semantic", "source_exploration", "sql_first"]),
  topic: z.string().nullable(),
  bundle_hash: z.string().regex(/^[a-f0-9]{64}$/),
  registry_version: z.string().min(1),
  ir: z.record(z.string(), z.unknown()),
  compiled_sql: z.string().min(1),
  result_digest: z.string().regex(/^[a-f0-9]{64}$/),
  answer_state: z.enum(["verified", "qualified", "exploratory", "clarification", "unavailable"]),
  validation: z.record(z.string(), z.unknown()),
}).strict();

const finalizationRowSchema = z.object({
  answer_artifact_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  artifact_digest: z.string().regex(/^[a-f0-9]{64}$/),
  idempotent_replay: z.boolean(),
}).strict();

export interface AnswerArtifactFinalizer {
  finalize(input: AnswerArtifactFinalizationInput): Promise<AnswerArtifactFinalizationResult>;
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
    private readonly onTiming?: (timing: AnswerArtifactFinalizationTiming) => void,
  ) {}

  async finalize(rawInput: AnswerArtifactFinalizationInput): Promise<AnswerArtifactFinalizationResult> {
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
          if (attempt >= 2 || !isRecoverableConnectionFailure(error)) throw error;
        }
      }
    } finally {
      // Reported on the failure path too: a finalization that exhausted its
      // retries is exactly the one whose cost needs explaining.
      this.onTiming?.(Object.freeze({ totalMs: Date.now() - startedAt, ...timing }));
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
      await client.query("SELECT set_config('albert.tenant_id',$1,true)", [input.tenantId]);
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
      try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
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
        evidence: { conversationId: input.conversationId, turnId: input.turnId },
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
        await client.query("SELECT set_config('albert.tenant_capability',$1,true)", [capability]);
      } else {
        await client.query("SELECT set_config('albert.tenant_id',$1,true)", [input.tenantId]);
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
        [input.tenantId, input.conversationId, input.turnId, input.queryAuditIds],
      );
      const rows = result.rows.map((row) => queryAuditRowSchema.parse(row));
      if (rows.length !== input.queryAuditIds.length
          || rows.some((row, index) => row.query_id !== input.queryAuditIds[index])) {
        throw new Error("One or more query audit references do not belong to this tenant conversation turn.");
      }
      await client.query("COMMIT");
      return Object.freeze(rows.map((row) => Object.freeze({
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
      })));
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
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
  "08000", "08001", "08003", "08004", "08006", "08007", "57P01", "57P02", "57P03",
]);

function isRecoverableConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return RECOVERABLE_CONNECTION_CODES.has(code);
  return /Connection terminated|connection terminated|ECONNRESET|EPIPE|socket hang up/u.test(error.message);
}

function assertEvidenceMatchesAnswerState(
  input: AnswerArtifactFinalizationInput,
  executions: readonly Readonly<Record<string, unknown>>[],
): void {
  const state = input.answerState;
  const routes = executions.map((execution) => execution.route);
  if (state === "clarification" && executions.length !== 0) {
    throw new Error("Clarification turns cannot bind analytical query evidence.");
  }
  const directoryAnswer = input.directoryEvidence !== undefined
    && state === "qualified"
    && input.directoryEvidence.valueCount > 0
    && executions.length === 0;
  if (["verified", "qualified", "exploratory"].includes(state) && executions.length === 0 && !directoryAnswer) {
    throw new Error("Analytical answers require at least one immutable query audit reference.");
  }
  if (state === "exploratory"
    && !routes.includes("source_exploration")
    && !routes.includes("sql_first")) {
    throw new Error("Exploratory answers require source-exploration or sql-first evidence.");
  }
  // sql_first evidence is deliberately admissible under Verified: its structure
  // was linted before execution and its claims attested against governed
  // contracts afterwards. source_exploration carries no such attestation.
  if (state === "verified" && routes.includes("source_exploration")) {
    throw new Error("Verified answers cannot be supported by source-exploration evidence.");
  }
}
