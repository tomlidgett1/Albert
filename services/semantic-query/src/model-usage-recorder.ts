import { z } from "zod";
import {
  modelUsageCheckpointInputSchema,
  modelUsageCheckpointResultSchema,
  type ModelUsageCheckpointInput,
  type ModelUsageCheckpointResult,
} from "../../../packages/shared/src/index.js";
import type { PgPoolLike } from "./database.js";

const checkpointRowSchema = z.object({
  metering_digest: z.string().regex(/^[a-f0-9]{64}$/),
  provider_usage_digest: z.string().regex(/^[a-f0-9]{64}$/),
  stage: z.enum(["provider", "terminal"]),
  outcome: modelUsageCheckpointInputSchema.shape.outcome,
  idempotent_replay: z.boolean(),
}).strict();

export interface ModelUsageRecorder {
  record(input: ModelUsageCheckpointInput): Promise<ModelUsageCheckpointResult>;
}

/** Persists provider cost independently from immutable answer finalization. */
export class PostgresModelUsageRecorder implements ModelUsageRecorder {
  constructor(private readonly controlPlanePool: PgPoolLike) {}

  async record(rawInput: ModelUsageCheckpointInput): Promise<ModelUsageCheckpointResult> {
    const input = modelUsageCheckpointInputSchema.parse(rawInput);
    const client = await this.controlPlanePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE albert_semantic_control");
      await client.query("SELECT set_config('albert.tenant_id',$1,true)", [input.tenantId]);
      const result = await client.query(
        `SELECT metering_digest,provider_usage_digest,stage,outcome,idempotent_replay
           FROM control_plane.record_model_usage_checkpoint(
             $1,$2::uuid,$3,$4,$5,$6::jsonb,$7::jsonb,$8
           )`,
        [
          input.tenantId,
          input.actorUserId,
          input.conversationId,
          input.turnId,
          input.providerResponseId,
          JSON.stringify(input.providerUsage),
          JSON.stringify(input.metering),
          input.outcome,
        ],
      );
      const row = checkpointRowSchema.parse(result.rows[0]);
      await client.query("COMMIT");
      return modelUsageCheckpointResultSchema.parse({
        meteringDigest: row.metering_digest,
        providerUsageDigest: row.provider_usage_digest,
        stage: row.stage,
        outcome: row.outcome,
        idempotentReplay: row.idempotent_replay,
      });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }
}
