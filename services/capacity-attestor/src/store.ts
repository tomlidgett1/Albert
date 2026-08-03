import { randomBytes } from "node:crypto";
import { CAPACITY_ATTESTATION_LEASE_SECONDS } from "../../../scripts/capacity-attestation-timing.mjs";
import type { CapacityCollectorCheckpoint } from "./collector.js";
import type { CapacityPgPool, CapacityPgClient } from "./database-observers.js";

const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;

type AttestationKey = Readonly<{
  repository: string;
  workflowRunId: string;
  workflowRunAttempt: number;
  candidateSha: string;
}>;

export type CapacityReservation =
  | Readonly<{ status: "acquired"; leaseToken: string; checkpoint?: unknown }>
  | Readonly<{ status: "completed"; envelope: Readonly<Record<string, unknown>> }>
  | Readonly<{ status: "busy" }>
  | Readonly<{ status: "failed" }>;

export class PostgresCapacityAttestationStore {
  constructor(
    private readonly pool: CapacityPgPool,
    private readonly expectedLogin = "albert_capacity_attestor_store",
  ) {}

  async ready(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        select current_user=$1
                 and not role.rolsuper and not role.rolcreatedb and not role.rolcreaterole
                 and not role.rolreplication and not role.rolbypassrls and not role.rolinherit
                 and not exists(select 1 from pg_catalog.pg_auth_members membership
                                 where membership.member=role.oid)
                 and has_table_privilege(current_user,'capacity_trust.transform_attestations','select')
                 and has_table_privilege(current_user,'capacity_trust.transform_attestations','insert')
                 and has_table_privilege(current_user,'capacity_trust.transform_attestations','update')
                 and not has_table_privilege(current_user,'capacity_trust.transform_attestations','delete')
                 and not has_table_privilege(current_user,'capacity_trust.transform_attestations','truncate')
                 and not has_table_privilege(current_user,'capacity_trust.transform_attestations','references')
                 and not has_table_privilege(current_user,'capacity_trust.transform_attestations','trigger')
                 as login_ready,
               to_regclass('capacity_trust.transform_attestations') is not null as schema_ready
          from pg_catalog.pg_roles role where role.rolname=current_user`,
      [this.expectedLogin]);
      return result.rows[0]?.login_ready === true && result.rows[0]?.schema_ready === true;
    } catch {
      return false;
    } finally {
      client.release();
    }
  }

  async reserve(
    key: AttestationKey,
    tokenJti: string,
    requestDigest: string,
  ): Promise<CapacityReservation> {
    const leaseToken = randomBytes(32).toString("hex");
    return this.transaction(async (client) => {
      await client.query(`
        insert into capacity_trust.transform_attestations(
          repository,workflow_run_id,workflow_run_attempt,candidate_sha,
          request_digest,token_jti,status,lease_token,lease_expires_at
        ) values($1,$2,$3,$4,$5,$6,'running',$7,
                 clock_timestamp()+make_interval(secs=>$8::double precision))
        on conflict(repository,workflow_run_id,workflow_run_attempt) do nothing`, [
        key.repository, key.workflowRunId, key.workflowRunAttempt, key.candidateSha,
        requestDigest, tokenJti, leaseToken, CAPACITY_ATTESTATION_LEASE_SECONDS,
      ]);
      const locked = await client.query(`
        select candidate_sha,request_digest,status,lease_expires_at,envelope,checkpoint
          from capacity_trust.transform_attestations
         where repository=$1 and workflow_run_id=$2 and workflow_run_attempt=$3
         for update`, [key.repository, key.workflowRunId, key.workflowRunAttempt]);
      const row = locked.rows[0];
      if (!row || row.candidate_sha !== key.candidateSha || row.request_digest !== requestDigest) {
        throw new Error("Capacity attestation run identity was already reserved with different inputs.");
      }
      if (row.status === "completed") {
        if (!row.envelope || typeof row.envelope !== "object" || Array.isArray(row.envelope)) {
          throw new Error("Stored capacity attestation envelope is invalid.");
        }
        return Object.freeze({ status: "completed" as const, envelope: row.envelope as Readonly<Record<string, unknown>> });
      }
      if (row.status === "failed") return Object.freeze({ status: "failed" as const });
      const inserted = await client.query(`
        select lease_token=$4 as owns_lease
          from capacity_trust.transform_attestations
         where repository=$1 and workflow_run_id=$2 and workflow_run_attempt=$3`,
      [key.repository, key.workflowRunId, key.workflowRunAttempt, leaseToken]);
      if (inserted.rows[0]?.owns_lease === true) {
        return Object.freeze({ status: "acquired" as const, leaseToken, checkpoint: row.checkpoint ?? undefined });
      }
      if (row.status === "running") {
        const takeover = await client.query(`
          update capacity_trust.transform_attestations
             set status='running',token_jti=$4,lease_token=$5,
                 lease_expires_at=clock_timestamp()+make_interval(secs=>$6::double precision),
                 error_code=null,updated_at=clock_timestamp()
           where repository=$1 and workflow_run_id=$2 and workflow_run_attempt=$3
             and status='running' and lease_expires_at<=clock_timestamp()
         returning 1 as acquired`, [
        key.repository, key.workflowRunId, key.workflowRunAttempt, tokenJti, leaseToken,
        CAPACITY_ATTESTATION_LEASE_SECONDS,
      ]);
        if (takeover.rows[0]?.acquired === 1) {
          return Object.freeze({ status: "acquired" as const, leaseToken, checkpoint: row.checkpoint ?? undefined });
        }
      }
      return Object.freeze({ status: "busy" as const });
    });
  }

  async checkpoint(
    key: AttestationKey,
    leaseToken: string,
    checkpoint: CapacityCollectorCheckpoint,
  ): Promise<void> {
    const encoded = JSON.stringify(checkpoint);
    if (Buffer.byteLength(encoded, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new Error("Capacity attestation checkpoint exceeds its durable size limit.");
    }
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        update capacity_trust.transform_attestations
           set checkpoint=$5::jsonb,
               lease_expires_at=clock_timestamp()+make_interval(secs=>$6::double precision),
               updated_at=clock_timestamp()
         where repository=$1 and workflow_run_id=$2 and workflow_run_attempt=$3
           and candidate_sha=$4 and status='running' and lease_token=$7
       returning 1 as checkpointed`, [
      key.repository, key.workflowRunId, key.workflowRunAttempt, key.candidateSha,
      encoded, CAPACITY_ATTESTATION_LEASE_SECONDS, leaseToken,
    ]);
      if (result.rows[0]?.checkpointed !== 1) {
        throw new Error("Capacity attestation lease was lost before checkpointing.");
      }
    } finally {
      client.release();
    }
  }

  async complete(
    key: AttestationKey,
    leaseToken: string,
    envelope: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        update capacity_trust.transform_attestations
           set status='completed',envelope=$5::jsonb,lease_token=null,
               lease_expires_at=null,checkpoint=null,
               completed_at=clock_timestamp(),updated_at=clock_timestamp()
         where repository=$1 and workflow_run_id=$2 and workflow_run_attempt=$3
           and candidate_sha=$4 and status='running' and lease_token=$6
       returning 1 as completed`, [
      key.repository, key.workflowRunId, key.workflowRunAttempt, key.candidateSha,
      JSON.stringify(envelope), leaseToken,
    ]);
      if (result.rows[0]?.completed !== 1) throw new Error("Capacity attestation lease was lost before completion.");
    } finally {
      client.release();
    }
  }

  async fail(key: AttestationKey, leaseToken: string, errorCode: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        update capacity_trust.transform_attestations
           set status='failed',error_code=$5,lease_token=null,lease_expires_at=null,
               checkpoint=null,updated_at=clock_timestamp()
         where repository=$1 and workflow_run_id=$2 and workflow_run_attempt=$3
           and candidate_sha=$4 and status='running' and lease_token=$6`, [
      key.repository, key.workflowRunId, key.workflowRunAttempt, key.candidateSha,
      errorCode.slice(0, 80), leaseToken,
    ]);
    } finally {
      client.release();
    }
  }

  private async transaction<T>(work: (client: CapacityPgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('statement_timeout','3000ms',true)");
      const value = await work(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
