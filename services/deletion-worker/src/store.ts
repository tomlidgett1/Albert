import type { TransactionalPostgres } from "../../sync-workers/src/database.js";
import { asDeletionControl } from "./database-role.js";

export type DeletionScope = "connection" | "tenant";

export type DeletionClaim = Readonly<{
  messageId: number;
  readCount: number;
  visibilityDeadline: string;
  requestId: string;
  tenantId: string;
  connectionId: string | null;
  scope: DeletionScope;
}>;

export type RevocationTarget = Readonly<{
  tenantId: string;
  connectionId: string;
  connectorId: "lightspeed-r" | "xero" | "deputy";
  credentialRef: string;
}>;

type ClaimRow = Readonly<{
  message_id: string | number;
  read_count: string | number;
  visibility_deadline: string | Date;
  payload: {
    deletionRequestId?: unknown;
    tenantId?: unknown;
    connectionId?: unknown;
    scope?: unknown;
  };
}>;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`deletion_claim_${label}_invalid`);
  return value;
}

function evidence(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}_evidence_invalid`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function revocationTargets(value: unknown): readonly RevocationTarget[] {
  if (!Array.isArray(value)) throw new Error("deletion_revocation_targets_invalid");
  return value.map((candidate) => {
    const target = evidence(candidate, "deletion_revocation_target");
    const connectorId = requiredString(target.connectorId, "connector");
    if (connectorId !== "lightspeed-r" && connectorId !== "xero" && connectorId !== "deputy") {
      throw new Error("deletion_revocation_connector_invalid");
    }
    return Object.freeze({
      tenantId: requiredString(target.tenantId, "tenant"),
      connectionId: requiredString(target.connectionId, "connection"),
      connectorId,
      credentialRef: requiredString(target.credentialRef, "credential"),
    });
  });
}

export class DeletionControlStore {
  constructor(
    private readonly db: TransactionalPostgres,
    private readonly workerId: string,
  ) {
    if (!workerId.trim()) throw new Error("deletion_worker_id_invalid");
  }

  private query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) {
    return asDeletionControl(this.db, (client) => client.query<T>(text, values));
  }

  async claim(): Promise<DeletionClaim | null> {
    const result = await this.query<ClaimRow>(
      "select * from control_plane.claim_deletion_jobs($1::text,900,1)",
      [this.workerId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const requestId = requiredString(row.payload.deletionRequestId, "request");
    const tenantId = requiredString(row.payload.tenantId, "tenant");
    const scope = row.payload.scope;
    if (scope !== "connection" && scope !== "tenant") throw new Error("deletion_claim_scope_invalid");
    const connectionId = row.payload.connectionId === null || row.payload.connectionId === undefined
      ? null
      : requiredString(row.payload.connectionId, "connection");
    if ((scope === "connection") !== Boolean(connectionId)) throw new Error("deletion_claim_scope_mismatch");
    return Object.freeze({
      messageId: Number(row.message_id),
      readCount: Number(row.read_count),
      visibilityDeadline: new Date(row.visibility_deadline).toISOString(),
      requestId,
      tenantId,
      connectionId,
      scope,
    });
  }

  async extend(claim: DeletionClaim): Promise<void> {
    await this.query(
      "select control_plane.extend_deletion_visibility($1,$2,$3,$4,900)",
      [claim.messageId, claim.requestId, this.workerId, claim.readCount],
    );
  }

  async revocationContext(claim: DeletionClaim): Promise<Readonly<{
    priorStatus: string;
    priorProgress: Readonly<Record<string, unknown>>;
    targets: readonly RevocationTarget[];
  }>> {
    const result = await this.query<{ result: unknown }>(
      "select control_plane.deletion_revocation_context($1,$2,$3,$4) result",
      [claim.messageId, claim.requestId, this.workerId, claim.readCount],
    );
    const context = evidence(result.rows[0]?.result, "deletion_revocation_context");
    return Object.freeze({
      priorStatus: requiredString(context.priorStatus, "revocation_status"),
      priorProgress: evidence(context.priorProgress, "deletion_progress"),
      targets: revocationTargets(context.targets),
    });
  }

  async destroyCredentials(
    claim: DeletionClaim,
    remoteRevocation: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.query(
      "select control_plane.destroy_claimed_deletion_credentials($1,$2,$3,$4,$5::jsonb)",
      [
        claim.messageId,
        claim.requestId,
        this.workerId,
        claim.readCount,
        JSON.stringify(remoteRevocation),
      ],
    );
  }

  async credentialVerification(claim: DeletionClaim): Promise<Readonly<{
    verified: boolean;
    tokenReferences: number;
    credentialEnvelopes: number;
    sessionEnvelopes: number;
  }>> {
    const result = await this.query<{ result: unknown }>(
      "select control_plane.verify_deletion_credentials($1,$2,$3,$4) result",
      [claim.messageId, claim.requestId, this.workerId, claim.readCount],
    );
    const row = evidence(result.rows[0]?.result, "credential_verification");
    const tokenReferences = Number(row.tokenReferences);
    const credentialEnvelopes = Number(row.credentialEnvelopes);
    const sessionEnvelopes = Number(row.sessionEnvelopes);
    if (![tokenReferences, credentialEnvelopes, sessionEnvelopes].every(Number.isSafeInteger)) {
      throw new Error("credential_verification_counts_invalid");
    }
    return Object.freeze({
      verified: row.verified === true,
      tokenReferences,
      credentialEnvelopes,
      sessionEnvelopes,
    });
  }

  async assertQuiescent(claim: DeletionClaim): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.query<{ result: unknown }>(
      "select control_plane.assert_claimed_deletion_quiescent($1,$2,$3,$4) result",
      [claim.messageId, claim.requestId, this.workerId, claim.readCount],
    );
    return evidence(result.rows[0]?.result, "deletion_quiescence");
  }

  async progress(
    claim: DeletionClaim,
    stage: string,
    value: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.query(
      "select control_plane.record_deletion_progress($1,$2,$3,$4,$5,$6::jsonb)",
      [claim.messageId, claim.requestId, this.workerId, claim.readCount, stage, JSON.stringify(value)],
    );
  }

  async purge(claim: DeletionClaim): Promise<Readonly<Record<string, unknown>>> {
    const functionName = claim.scope === "tenant"
      ? "control_plane.purge_tenant_control"
      : "control_plane.purge_connection_control";
    const result = await this.query<{ result: unknown }>(
      `select ${functionName}($1,$2,$3,$4) result`,
      [claim.messageId, claim.requestId, this.workerId, claim.readCount],
    );
    return evidence(result.rows[0]?.result, "control_purge");
  }

  async verify(claim: DeletionClaim): Promise<Readonly<Record<string, unknown>>> {
    const result = await this.query<{ result: unknown }>(
      "select control_plane.verify_claimed_control_deletion($1,$2,$3,$4) result",
      [claim.messageId, claim.requestId, this.workerId, claim.readCount],
    );
    return evidence(result.rows[0]?.result, "control_verification");
  }

  async markVerifying(claim: DeletionClaim): Promise<void> {
    await this.query(
      "select control_plane.mark_deletion_verifying($1,$2,$3,$4)",
      [claim.messageId, claim.requestId, this.workerId, claim.readCount],
    );
  }

  async complete(claim: DeletionClaim, proof: Readonly<{
    proofId: string;
    tenantReferenceHash: string;
    connectionReferenceHash: string | null;
    remoteRevocation: Readonly<Record<string, unknown>>;
    storeVerification: Readonly<Record<string, unknown>>;
    proofDigest: string;
    serviceVersion: string;
  }>): Promise<void> {
    await this.query(
      `select control_plane.complete_deletion_job(
        $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11
      )`,
      [
        claim.messageId, claim.requestId, this.workerId, claim.readCount,
        proof.proofId, proof.tenantReferenceHash, proof.connectionReferenceHash,
        JSON.stringify(proof.remoteRevocation), JSON.stringify(proof.storeVerification),
        proof.proofDigest, proof.serviceVersion,
      ],
    );
  }

  async retry(claim: DeletionClaim, error: Readonly<Record<string, unknown>>, delaySeconds: number): Promise<void> {
    await this.query(
      "select control_plane.retry_deletion_job($1,$2,$3,$4,$5::jsonb,$6,20)",
      [claim.messageId, claim.requestId, this.workerId, claim.readCount, JSON.stringify(error), delaySeconds],
    );
  }

  async preflight(): Promise<void> {
    await this.query("select control_plane.assert_deletion_queue_ready()");
  }

  async heartbeat(input: Readonly<{
    serviceVersion: string;
    deploymentId: string | null;
    startedAt: string;
    activeJobs: number;
    metadata: Readonly<Record<string, unknown>>;
  }>): Promise<void> {
    await this.query(
      "select control_plane.heartbeat_worker($1,$2,$3,$4::timestamptz,$5,$6::jsonb)",
      [
        this.workerId,
        input.serviceVersion,
        input.deploymentId,
        input.startedAt,
        input.activeJobs,
        JSON.stringify(input.metadata),
      ],
    );
  }
}

export class DeletionAnalyticalStore {
  constructor(private readonly db: TransactionalPostgres) {}

  private async execute(
    claim: DeletionClaim,
    operation: "purge" | "verify",
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.db.transaction(async (client) => {
      await client.query("set local role deletion_rw");
      const functionName = claim.scope === "tenant"
        ? `deletion_internal.${operation}_tenant`
        : `deletion_internal.${operation}_connection`;
      const parameters = claim.scope === "tenant" ? [claim.tenantId] : [claim.tenantId, claim.connectionId];
      const placeholders = parameters.map((_, index) => `$${index + 1}`).join(",");
      const result = await client.query<{ result: unknown }>(
        `select ${functionName}(${placeholders}) result`,
        parameters,
      );
      return evidence(result.rows[0]?.result, `analytical_${operation}`);
    });
  }

  purge(claim: DeletionClaim) {
    return this.execute(claim, "purge");
  }

  verify(claim: DeletionClaim) {
    return this.execute(claim, "verify");
  }

  async preflight(): Promise<void> {
    const result = await this.db.transaction(async (client) => {
      await client.query("set local role deletion_rw");
      return client.query<{ ready: boolean }>(
        `select to_regprocedure('deletion_internal.purge_connection(text,text)') is not null ready`,
      );
    });
    if (result.rows[0]?.ready !== true) throw new Error("analytical_deletion_procedures_missing");
  }
}
