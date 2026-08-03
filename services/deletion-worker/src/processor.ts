import { createHash, createHmac } from "node:crypto";
import { ulid } from "ulid";
import { LightspeedRConnector } from "../../../connectors/lightspeed-r/index.js";
import { XeroConnector } from "../../../connectors/xero/index.js";
import {
  ConnectorError,
  type WorkerCredentialVault,
} from "../../../packages/connector-sdk/src/index.js";
import type { DeletionWorkerConfig } from "./config.js";
import type { DeletionClaim, RevocationTarget } from "./store.js";

export interface DeletionControlPort {
  extend(claim: DeletionClaim): Promise<void>;
  revocationContext(claim: DeletionClaim): Promise<Readonly<{
    priorStatus: string;
    priorProgress: Readonly<Record<string, unknown>>;
    targets: readonly RevocationTarget[];
  }>>;
  destroyCredentials(claim: DeletionClaim, evidence: Readonly<Record<string, unknown>>): Promise<void>;
  credentialVerification(claim: DeletionClaim): Promise<Readonly<Record<string, unknown> & { verified: boolean }>>;
  assertQuiescent(claim: DeletionClaim): Promise<Readonly<Record<string, unknown>>>;
  progress(claim: DeletionClaim, stage: string, value: Readonly<Record<string, unknown>>): Promise<void>;
  purge(claim: DeletionClaim): Promise<Readonly<Record<string, unknown>>>;
  verify(claim: DeletionClaim): Promise<Readonly<Record<string, unknown>>>;
  markVerifying(claim: DeletionClaim): Promise<void>;
  complete(claim: DeletionClaim, proof: Readonly<{
    proofId: string;
    tenantReferenceHash: string;
    connectionReferenceHash: string | null;
    remoteRevocation: Readonly<Record<string, unknown>>;
    storeVerification: Readonly<Record<string, unknown>>;
    proofDigest: string;
    serviceVersion: string;
  }>): Promise<void>;
  retry(claim: DeletionClaim, error: Readonly<Record<string, unknown>>, delaySeconds: number): Promise<void>;
}

export interface DeletionAnalyticalPort {
  purge(claim: DeletionClaim): Promise<Readonly<Record<string, unknown>>>;
  verify(claim: DeletionClaim): Promise<Readonly<Record<string, unknown>>>;
}

export interface DeletionRawStoragePort {
  purge(tenantId: string, connectionId: string | null): Promise<Readonly<Record<string, unknown>>>;
  verify(tenantId: string, connectionId: string | null): Promise<Readonly<Record<string, unknown> & { verified: boolean }>>;
}

export interface CredentialRevoker {
  revoke(claim: DeletionClaim): Promise<Readonly<Record<string, unknown>>>;
}

function stable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("proof_contains_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  throw new Error("proof_contains_unsupported_value");
}

function verified(value: Readonly<Record<string, unknown>>, store: string): void {
  if (value.verified !== true) throw new Error(`${store}_deletion_not_verified`);
}

const connectorFailureCodes = new Set([
  "AUTHENTICATION_REQUIRED",
  "CAPABILITY_UNAVAILABLE",
  "CONFIGURATION_INVALID",
  "CREDENTIAL_CONFLICT",
  "CURSOR_INVALID",
  "OAUTH_EXCHANGE_FAILED",
  "RATE_LIMITED",
  "REMOTE_RESPONSE_INVALID",
  "REMOTE_UNAVAILABLE",
  "WEBHOOK_SIGNATURE_INVALID",
]);

const databaseFailureCodes: Readonly<Record<string, string>> = Object.freeze({
  "40001": "database_serialization_conflict",
  "40P01": "database_deadlock",
  "42501": "database_permission_denied",
  "55000": "deletion_fence_conflict",
  "57P01": "database_unavailable",
  "08000": "database_unavailable",
  "08003": "database_unavailable",
  "08006": "database_unavailable",
  "23503": "database_integrity_violation",
  "23505": "database_integrity_violation",
});

export type DeletionFailureEvidence = Readonly<{
  code: string;
  errorClass: "connector" | "database" | "timeout" | "internal";
  correlationId: string;
  retryable: true;
  failedAt: string;
}>;

/** Never persist an exception message: vendor and database text may contain secrets. */
export function deletionFailureEvidence(error: unknown): DeletionFailureEvidence {
  let code = "unexpected_deletion_failure";
  let errorClass: DeletionFailureEvidence["errorClass"] = "internal";
  if (error instanceof ConnectorError && connectorFailureCodes.has(error.code)) {
    code = `connector_${error.code.toLowerCase()}`;
    errorClass = "connector";
  } else if (error && typeof error === "object") {
    const candidate = error as Readonly<{ code?: unknown; name?: unknown }>;
    if (typeof candidate.code === "string" && databaseFailureCodes[candidate.code]) {
      code = databaseFailureCodes[candidate.code]!;
      errorClass = "database";
    } else if (candidate.name === "AbortError") {
      code = "operation_aborted";
      errorClass = "timeout";
    } else if (candidate.name === "TimeoutError") {
      code = "operation_timeout";
      errorClass = "timeout";
    } else if (candidate.name === "TypeError") {
      code = "internal_type_error";
    } else if (candidate.name === "SyntaxError") {
      code = "internal_syntax_error";
    }
  }
  return Object.freeze({
    code,
    errorClass,
    correlationId: ulid(),
    retryable: true,
    failedAt: new Date().toISOString(),
  });
}

function logFailure(event: string, evidence: DeletionFailureEvidence): void {
  process.stderr.write(`${JSON.stringify({
    event,
    code: evidence.code,
    errorClass: evidence.errorClass,
    correlationId: evidence.correlationId,
  })}\n`);
}

export class ProductionCredentialRevoker implements CredentialRevoker {
  constructor(
    private readonly control: Pick<DeletionControlPort, "revocationContext">,
    private readonly vaultForClaim: (claim: DeletionClaim) => WorkerCredentialVault,
    private readonly config: Pick<
      DeletionWorkerConfig,
      "lightspeedClientId" | "lightspeedClientSecret" | "xeroClientId"
    >,
  ) {}

  private async revokeTarget(target: RevocationTarget, vault: WorkerCredentialVault): Promise<void> {
    const context = {
      tenantId: target.tenantId,
      connectionId: target.connectionId,
      credentialRef: target.credentialRef,
      abortSignal: AbortSignal.timeout(30_000),
    } as const;
    if (target.connectorId === "deputy") {
      // Deputy publishes no remote OAuth revocation endpoint. Cryptographic
      // destruction is the documented local enforcement mechanism.
      await vault.destroy(target.credentialRef);
      return;
    }
    if (target.connectorId === "lightspeed-r") {
      await new LightspeedRConnector({
        clientId: this.config.lightspeedClientId,
        clientSecret: this.config.lightspeedClientSecret,
        vault,
      }).revoke_credentials(context);
      return;
    }
    await new XeroConnector({
      clientId: this.config.xeroClientId,
      oauthMode: "pkce",
      vault,
    }).revoke_credentials(context);
  }

  async revoke(claim: DeletionClaim): Promise<Readonly<Record<string, unknown>>> {
    const context = await this.control.revocationContext(claim);
    const vault = this.vaultForClaim(claim);
    const targets: Array<Readonly<Record<string, unknown>>> = [];
    for (const target of context.targets) {
      let status: "succeeded" | "unsupported" | "failed" =
        target.connectorId === "deputy" ? "unsupported" : "succeeded";
      let errorCode: string | undefined;
      let errorClass: string | undefined;
      let correlationId: string | undefined;
      try {
        await this.revokeTarget(target, vault);
      } catch (error) {
        status = "failed";
        const failure = deletionFailureEvidence(error);
        errorCode = failure.code;
        errorClass = failure.errorClass;
        correlationId = failure.correlationId;
        logFailure("deletion_remote_revocation_failed", failure);
      }
      targets.push(Object.freeze({
        provider: target.connectorId,
        status,
        ...(errorCode ? { errorCode } : {}),
        ...(errorClass ? { errorClass } : {}),
        ...(correlationId ? { correlationId } : {}),
      }));
    }
    return Object.freeze({
      attemptedAt: new Date().toISOString(),
      priorStatus: context.priorStatus,
      targetCount: targets.length,
      targets,
      bestEffort: true,
    });
  }
}

export class DeletionProcessor {
  constructor(
    private readonly control: DeletionControlPort,
    private readonly analytical: DeletionAnalyticalPort,
    private readonly raw: DeletionRawStoragePort,
    private readonly revoker: CredentialRevoker,
    private readonly proofHmacKey: string,
    private readonly serviceVersion: string,
  ) {}

  private referenceHash(kind: "tenant" | "connection", value: string): string {
    return createHmac("sha256", this.proofHmacKey).update(`albert-deletion-v1:${kind}:${value}`).digest("hex");
  }

  async process(claim: DeletionClaim): Promise<void> {
    try {
      await this.control.extend(claim);
      const remoteRevocation = await this.revoker.revoke(claim);
      await this.control.destroyCredentials(claim, remoteRevocation);
      const credentialVault = await this.control.credentialVerification(claim);
      verified(credentialVault, "credential_vault");
      await this.control.progress(claim, "remote_revocation", remoteRevocation);
      await this.control.progress(claim, "credential_vault", credentialVault);

      await this.control.extend(claim);
      const quiescence = await this.control.assertQuiescent(claim);
      verified(quiescence, "sync_write_quiescence");
      const rawPurge = await this.raw.purge(claim.tenantId, claim.connectionId);
      await this.control.progress(claim, "raw_storage", rawPurge);

      await this.control.extend(claim);
      const analyticalPurge = await this.analytical.purge(claim);
      await this.control.progress(claim, "analytical", analyticalPurge);

      await this.control.extend(claim);
      const controlPurge = await this.control.purge(claim);
      await this.control.progress(claim, "control_plane", controlPurge);

      await this.control.extend(claim);
      await this.control.markVerifying(claim);
      const [rawStorage, analytical, controlPlane, finalCredentialVault] = await Promise.all([
        this.raw.verify(claim.tenantId, claim.connectionId),
        this.analytical.verify(claim),
        this.control.verify(claim),
        this.control.credentialVerification(claim),
      ]);
      verified(rawStorage, "raw_storage");
      verified(analytical, "analytical");
      verified(controlPlane, "control_plane");
      verified(finalCredentialVault, "credential_vault");
      const storeVerification = Object.freeze({
        credential_vault: finalCredentialVault,
        raw_storage: rawStorage,
        analytical,
        control_plane: controlPlane,
      });
      await this.control.progress(claim, "verification", Object.freeze({
        verified: true,
        stores: Object.keys(storeVerification),
        verifiedAt: new Date().toISOString(),
      }));

      const proofId = ulid();
      const tenantReferenceHash = this.referenceHash("tenant", claim.tenantId);
      const connectionReferenceHash = claim.connectionId
        ? this.referenceHash("connection", claim.connectionId)
        : null;
      const proofDigest = createHash("sha256").update(stable({
        version: "albert-deletion-proof-v1",
        proofId,
        deletionRequestId: claim.requestId,
        scope: claim.scope,
        tenantReferenceHash,
        connectionReferenceHash,
        remoteRevocation,
        storeVerification,
        serviceVersion: this.serviceVersion,
      })).digest("hex");
      await this.control.complete(claim, {
        proofId,
        tenantReferenceHash,
        connectionReferenceHash,
        remoteRevocation,
        storeVerification,
        proofDigest,
        serviceVersion: this.serviceVersion,
      });
    } catch (error) {
      const errorEvidence = deletionFailureEvidence(error);
      logFailure("deletion_job_attempt_failed", errorEvidence);
      const delaySeconds = Math.min(900, Math.max(10, 2 ** Math.min(claim.readCount, 9) * 5));
      await this.control.retry(claim, errorEvidence, delaySeconds).catch(() => undefined);
    }
  }
}
