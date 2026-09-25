import { createHash, createHmac } from "node:crypto";
import { ulid } from "ulid";
import { LightspeedRConnector } from "../../../connectors/lightspeed-r/index.js";
import { SquareConnector } from "../../../connectors/square/index.js";
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
  issueAnalyticalCapability(claim: DeletionClaim, operation: "purge" | "verify"): Promise<string>;
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
  purge(claim: DeletionClaim, capability: string): Promise<Readonly<Record<string, unknown>>>;
  verify(claim: DeletionClaim, capability: string): Promise<Readonly<Record<string, unknown>>>;
}

export interface DeletionRawStoragePort {
  purge(claim: DeletionClaim): Promise<Readonly<Record<string, unknown>>>;
  verify(claim: DeletionClaim): Promise<Readonly<Record<string, unknown> & { verified: boolean }>>;
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

const analyticalResidualKeys = Object.freeze([
  "stagingRows",
  "canonicalRows",
  "bridgeRows",
  "linkRows",
  "embeddingRows",
  "cacheRows",
  "otherAnalyticalRows",
] as const);
const analyticalAttestationKeys = Object.freeze([
  "verified",
  "scope",
  "measurement",
  "remainingRows",
  "residuals",
] as const);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function deletionEvidenceCount(value: unknown, store: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${store}_deletion_attestation_invalid`);
  }
  return value as number;
}

/**
 * A boolean from the analytical database is insufficient deletion evidence.
 * Require the catalog-measured residual contract and prove that its total is
 * internally consistent before it can enter the immutable deletion proof.
 */
function normalizeAnalyticalAttestation(
  value: Readonly<Record<string, unknown>>,
  claim: DeletionClaim,
): Readonly<Record<string, unknown>> {
  const residuals = value.residuals;
  if (
    !hasExactKeys(value, analyticalAttestationKeys)
    || value.measurement !== "post_purge_row_counts_v1"
    || value.scope !== claim.scope
    || !isRecord(residuals)
  ) {
    throw new Error("analytical_deletion_attestation_invalid");
  }
  if (!hasExactKeys(residuals, analyticalResidualKeys)) {
    throw new Error("analytical_deletion_attestation_invalid");
  }
  const residualTotal = analyticalResidualKeys.reduce(
    (sum, key) => sum + deletionEvidenceCount(residuals[key], "analytical"),
    0,
  );
  const remainingRows = deletionEvidenceCount(value.remainingRows, "analytical");
  if (remainingRows !== residualTotal) {
    throw new Error("analytical_deletion_attestation_invalid");
  }
  if (value.verified !== true || remainingRows !== 0) {
    throw new Error("analytical_deletion_not_verified");
  }
  return Object.freeze({
    verified: true,
    scope: claim.scope,
    measurement: "post_purge_row_counts_v1",
    remainingRows,
    residuals: Object.freeze({
      stagingRows: deletionEvidenceCount(residuals.stagingRows, "analytical"),
      canonicalRows: deletionEvidenceCount(residuals.canonicalRows, "analytical"),
      bridgeRows: deletionEvidenceCount(residuals.bridgeRows, "analytical"),
      linkRows: deletionEvidenceCount(residuals.linkRows, "analytical"),
      embeddingRows: deletionEvidenceCount(residuals.embeddingRows, "analytical"),
      cacheRows: deletionEvidenceCount(residuals.cacheRows, "analytical"),
      otherAnalyticalRows: deletionEvidenceCount(residuals.otherAnalyticalRows, "analytical"),
    }),
  });
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

const remoteRevocationKeys = Object.freeze([
  "attemptedAt",
  "priorStatus",
  "targetCount",
  "targets",
  "bestEffort",
] as const);
const forcedRemoteRevocationKeys = Object.freeze([
  ...remoteRevocationKeys,
  "forcedLocalDestruction",
  "reason",
] as const);
const remoteTargetKeys = Object.freeze([
  "provider",
  "connectionGeneration",
  "status",
] as const);
const remoteFailedTargetKeys = Object.freeze([
  ...remoteTargetKeys,
  "errorCode",
  "errorClass",
  "correlationId",
] as const);
const remotePriorStatuses = new Set([
  "pending",
  "succeeded",
  "unsupported",
  "failed",
  "not_applicable",
]);
const remoteProviders = new Set([
  "lightspeed-r",
  "lightspeed-x",
  "xero",
  "deputy",
  "square",
  "momence",
  "shopify",
]);
const remoteTargetStatuses = new Set(["succeeded", "unsupported", "failed"]);
const remoteFailureClasses = new Map<string, string>([
  ...[...connectorFailureCodes].map((code) => [
    `connector_${code.toLowerCase()}`,
    "connector",
  ] as const),
  ...Object.values(databaseFailureCodes).map((code) => [code, "database"] as const),
  ["operation_aborted", "timeout"],
  ["operation_timeout", "timeout"],
  ["internal_type_error", "internal"],
  ["internal_syntax_error", "internal"],
  ["unexpected_deletion_failure", "internal"],
]);

function normalizeRemoteRevocation(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const forcedLocalDestruction = hasExactKeys(value, forcedRemoteRevocationKeys);
  if (!forcedLocalDestruction && !hasExactKeys(value, remoteRevocationKeys)) {
    throw new Error("remote_revocation_attestation_invalid");
  }
  const attemptedAt = value.attemptedAt;
  const priorStatus = value.priorStatus;
  const targetCount = deletionEvidenceCount(value.targetCount, "remote_revocation");
  const targets = value.targets;
  if (
    typeof attemptedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(attemptedAt)
    || !Number.isFinite(Date.parse(attemptedAt))
    || new Date(attemptedAt).toISOString() !== attemptedAt
    || typeof priorStatus !== "string"
    || !remotePriorStatuses.has(priorStatus)
    || !Array.isArray(targets)
    || targetCount !== targets.length
    || value.bestEffort !== true
    || (forcedLocalDestruction && (
      value.forcedLocalDestruction !== true
      || value.reason !== "remote_revocation_grace_expired"
      || priorStatus !== "failed"
      || targetCount !== 0
    ))
  ) {
    throw new Error("remote_revocation_attestation_invalid");
  }
  const normalizedTargets = targets.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("remote_revocation_attestation_invalid");
    const status = candidate.status;
    const provider = candidate.provider;
    const connectionGeneration = deletionEvidenceCount(
      candidate.connectionGeneration,
      "remote_revocation",
    );
    if (
      typeof status !== "string"
      || !remoteTargetStatuses.has(status)
      || typeof provider !== "string"
      || !remoteProviders.has(provider)
      || connectionGeneration < 1
    ) {
      throw new Error("remote_revocation_attestation_invalid");
    }
    if (status !== "failed") {
      if (!hasExactKeys(candidate, remoteTargetKeys)) {
        throw new Error("remote_revocation_attestation_invalid");
      }
      return Object.freeze({ provider, connectionGeneration, status });
    }
    if (!hasExactKeys(candidate, remoteFailedTargetKeys)) {
      throw new Error("remote_revocation_attestation_invalid");
    }
    const errorCode = candidate.errorCode;
    const errorClass = candidate.errorClass;
    const correlationId = candidate.correlationId;
    if (
      typeof errorCode !== "string"
      || typeof errorClass !== "string"
      || remoteFailureClasses.get(errorCode) !== errorClass
      || typeof correlationId !== "string"
      || !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(correlationId)
    ) {
      throw new Error("remote_revocation_attestation_invalid");
    }
    return Object.freeze({
      provider,
      connectionGeneration,
      status,
      errorCode,
      errorClass,
      correlationId,
    });
  });
  return Object.freeze({
    attemptedAt,
    priorStatus,
    targetCount,
    targets: Object.freeze(normalizedTargets),
    bestEffort: true,
    ...(forcedLocalDestruction
      ? { forcedLocalDestruction: true, reason: "remote_revocation_grace_expired" }
      : {}),
  });
}

function normalizeCredentialVerification(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const keys = ["verified", "tokenReferences", "credentialEnvelopes", "sessionEnvelopes"];
  if (!hasExactKeys(value, keys)) throw new Error("credential_vault_deletion_attestation_invalid");
  const tokenReferences = deletionEvidenceCount(value.tokenReferences, "credential_vault");
  const credentialEnvelopes = deletionEvidenceCount(value.credentialEnvelopes, "credential_vault");
  const sessionEnvelopes = deletionEvidenceCount(value.sessionEnvelopes, "credential_vault");
  if (value.verified !== true || tokenReferences + credentialEnvelopes + sessionEnvelopes !== 0) {
    throw new Error("credential_vault_deletion_not_verified");
  }
  return Object.freeze({ verified: true, tokenReferences, credentialEnvelopes, sessionEnvelopes });
}

function normalizeRawVerification(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!hasExactKeys(value, ["verified", "remainingObjects"])) {
    throw new Error("raw_storage_deletion_attestation_invalid");
  }
  const remainingObjects = deletionEvidenceCount(value.remainingObjects, "raw_storage");
  if (value.verified !== true || remainingObjects !== 0) {
    throw new Error("raw_storage_deletion_not_verified");
  }
  return Object.freeze({ verified: true, remainingObjects });
}

function normalizeControlVerification(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const keys = [
    "verified",
    "remainingTenantOrConnectionRows",
    "remainingDerivedArtifacts",
    "remainingQueueMessages",
  ];
  if (!hasExactKeys(value, keys)) throw new Error("control_plane_deletion_attestation_invalid");
  const remainingTenantOrConnectionRows = deletionEvidenceCount(
    value.remainingTenantOrConnectionRows,
    "control_plane",
  );
  const remainingDerivedArtifacts = deletionEvidenceCount(
    value.remainingDerivedArtifacts,
    "control_plane",
  );
  const remainingQueueMessages = deletionEvidenceCount(
    value.remainingQueueMessages,
    "control_plane",
  );
  if (
    value.verified !== true
    || remainingTenantOrConnectionRows + remainingDerivedArtifacts + remainingQueueMessages !== 0
  ) {
    throw new Error("control_plane_deletion_not_verified");
  }
  return Object.freeze({
    verified: true,
    remainingTenantOrConnectionRows,
    remainingDerivedArtifacts,
    remainingQueueMessages,
  });
}

function normalizeRawPurge(
  value: Readonly<Record<string, unknown>>,
  claim: DeletionClaim,
): Readonly<Record<string, unknown>> {
  if (!hasExactKeys(value, ["verified", "prefix", "objectsRemoved"])) {
    throw new Error("raw_storage_deletion_progress_invalid");
  }
  const expectedPrefix = claim.connectionId
    ? `tenant/${claim.tenantId}/connection/${claim.connectionId}/`
    : `tenant/${claim.tenantId}/`;
  const objectsRemoved = deletionEvidenceCount(value.objectsRemoved, "raw_storage");
  if (value.verified !== true || value.prefix !== expectedPrefix) {
    throw new Error("raw_storage_deletion_progress_invalid");
  }
  return Object.freeze({ verified: true, objectsRemoved });
}

function normalizeAnalyticalPurge(
  value: Readonly<Record<string, unknown>>,
  claim: DeletionClaim,
): Readonly<Record<string, unknown>> {
  if (claim.scope === "tenant") {
    if (!hasExactKeys(value, ["verified", "scope", "rowsRemoved", "remainingRows"])) {
      throw new Error("analytical_deletion_progress_invalid");
    }
    const rowsRemoved = deletionEvidenceCount(value.rowsRemoved, "analytical");
    const remainingRows = deletionEvidenceCount(value.remainingRows, "analytical");
    if (value.verified !== true || value.scope !== "tenant" || remainingRows !== 0) {
      throw new Error("analytical_deletion_progress_invalid");
    }
    return Object.freeze({ verified: true, scope: "tenant", rowsRemoved });
  }
  if (!hasExactKeys(value, [
    "verified",
    "scope",
    "rowsRemoved",
    "canonicalDependencyRowsAdded",
    "canonicalResidual",
    "reconciliationRowsRemoved",
    "marts",
  ])) {
    throw new Error("analytical_deletion_progress_invalid");
  }
  const rowsRemoved = deletionEvidenceCount(value.rowsRemoved, "analytical");
  deletionEvidenceCount(value.canonicalDependencyRowsAdded, "analytical");
  const canonicalResidual = deletionEvidenceCount(value.canonicalResidual, "analytical");
  deletionEvidenceCount(value.reconciliationRowsRemoved, "analytical");
  const marts = value.marts;
  if (!isRecord(marts) || !hasExactKeys(marts, ["refreshed", "chunks", "from", "to"])) {
    throw new Error("analytical_deletion_progress_invalid");
  }
  const chunks = deletionEvidenceCount(marts.chunks, "analytical");
  const from = marts.from;
  const to = marts.to;
  const validBounds = chunks === 0
    ? from === null && to === null
    : typeof from === "string"
      && typeof to === "string"
      && /^\d{4}-\d{2}-\d{2}$/u.test(from)
      && /^\d{4}-\d{2}-\d{2}$/u.test(to);
  if (
    value.verified !== true
    || value.scope !== "connection"
    || canonicalResidual !== 0
    || marts.refreshed !== true
    || !validBounds
  ) {
    throw new Error("analytical_deletion_progress_invalid");
  }
  return Object.freeze({ verified: true, scope: "connection", rowsRemoved });
}

function normalizeControlPurge(
  value: Readonly<Record<string, unknown>>,
  claim: DeletionClaim,
): Readonly<Record<string, unknown>> {
  const completionKey = claim.scope === "tenant"
    ? "tenantAnchorPendingProof"
    : "connectionTombstoned";
  if (!hasExactKeys(value, ["scope", "rowsRemoved", completionKey])) {
    throw new Error("control_plane_deletion_progress_invalid");
  }
  const rowsRemoved = deletionEvidenceCount(value.rowsRemoved, "control_plane");
  if (value.scope !== claim.scope || value[completionKey] !== true) {
    throw new Error("control_plane_deletion_progress_invalid");
  }
  return Object.freeze({ verified: true, scope: claim.scope, rowsRemoved });
}

export type DeletionFailureEvidence = Readonly<{
  code: string;
  errorClass: "connector" | "database" | "timeout" | "internal";
  correlationId: string;
  retryable: true;
  failedAt: string;
}>;

export type DeletionProcessOutcome =
  | Readonly<{ status: "completed" }>
  | Readonly<{
      status: "retry_scheduled";
      failure: DeletionFailureEvidence;
      retryDelaySeconds: number;
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
      | "lightspeedClientId"
      | "lightspeedClientSecret"
      | "squareClientId"
      | "squareClientSecret"
      | "squareRedirectUri"
      | "xeroClientId"
    >,
  ) {}

  private async revokeTarget(target: RevocationTarget, vault: WorkerCredentialVault): Promise<void> {
    const context = {
      tenantId: target.tenantId,
      connectionId: target.connectionId,
      credentialRef: target.credentialRef,
      abortSignal: AbortSignal.timeout(30_000),
    } as const;
    // Shopify exposes appUninstall, but that irreversible whole-install
    // mutation is not a per-grant revoke and ordinary Albert disconnect does
    // not invoke it. These targets therefore use cryptographic local
    // destruction and truthfully record vendor revocation as unsupported.
    if (
      target.connectorId === "deputy"
      || target.connectorId === "lightspeed-x"
      || target.connectorId === "momence"
      || target.connectorId === "shopify"
    ) {
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
    if (target.connectorId === "square") {
      await new SquareConnector({
        clientId: this.config.squareClientId,
        clientSecret: this.config.squareClientSecret,
        redirectUri: this.config.squareRedirectUri,
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
    const priorRemote = context.priorProgress.remote_revocation;
    if (context.targets.length === 0 && priorRemote !== undefined) {
      const forcedLocalDestruction = isRecord(priorRemote)
        && hasExactKeys(priorRemote, ["forcedLocalDestruction", "reason"])
        && priorRemote.forcedLocalDestruction === true
        && priorRemote.reason === "remote_revocation_grace_expired";
      if (forcedLocalDestruction) {
        const credentialProgress = context.priorProgress.credential_vault;
        const completedAt = isRecord(credentialProgress)
          ? credentialProgress.completedAt
          : undefined;
        if (typeof completedAt !== "string" || !Number.isFinite(Date.parse(completedAt))) {
          throw new Error("forced_remote_revocation_attestation_invalid");
        }
        return normalizeRemoteRevocation(Object.freeze({
          attemptedAt: new Date(completedAt).toISOString(),
          priorStatus: "failed",
          targetCount: 0,
          targets: Object.freeze([]),
          bestEffort: true,
          forcedLocalDestruction: true,
          reason: "remote_revocation_grace_expired",
        }));
      }
      if (!isRecord(priorRemote)) throw new Error("remote_revocation_attestation_invalid");
      return normalizeRemoteRevocation(priorRemote);
    }
    const vault = this.vaultForClaim(claim);
    const targets: Array<Readonly<Record<string, unknown>>> = [];
    for (const target of context.targets) {
      let status: "succeeded" | "unsupported" | "failed" =
        target.connectorId === "deputy"
          || target.connectorId === "lightspeed-x"
          || target.connectorId === "momence"
          || target.connectorId === "shopify"
          ? "unsupported"
          : "succeeded";
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
        connectionGeneration: target.connectionGeneration,
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

  async process(claim: DeletionClaim): Promise<DeletionProcessOutcome> {
    try {
      await this.control.extend(claim);
      const remoteRevocation = normalizeRemoteRevocation(await this.revoker.revoke(claim));
      await this.control.destroyCredentials(claim, remoteRevocation);
      const credentialVault = normalizeCredentialVerification(
        await this.control.credentialVerification(claim),
      );
      await this.control.progress(claim, "remote_revocation", remoteRevocation);
      await this.control.progress(claim, "credential_vault", credentialVault);

      await this.control.extend(claim);
      const quiescence = await this.control.assertQuiescent(claim);
      if (quiescence.verified !== true) throw new Error("sync_write_quiescence_deletion_not_verified");
      const rawPurge = await this.raw.purge(claim);
      await this.control.progress(claim, "raw_storage", normalizeRawPurge(rawPurge, claim));

      await this.control.extend(claim);
      const purgeCapability = await this.control.issueAnalyticalCapability(claim, "purge");
      const analyticalPurge = await this.analytical.purge(claim, purgeCapability);
      await this.control.progress(
        claim,
        "analytical",
        normalizeAnalyticalPurge(analyticalPurge, claim),
      );

      await this.control.extend(claim);
      const controlPurge = await this.control.purge(claim);
      await this.control.progress(
        claim,
        "control_plane",
        normalizeControlPurge(controlPurge, claim),
      );

      await this.control.extend(claim);
      await this.control.markVerifying(claim);
      const verifyCapability = await this.control.issueAnalyticalCapability(claim, "verify");
      const [rawStorage, analytical, controlPlane, finalCredentialVault] = await Promise.all([
        this.raw.verify(claim),
        this.analytical.verify(claim, verifyCapability),
        this.control.verify(claim),
        this.control.credentialVerification(claim),
      ]);
      const normalizedRawStorage = normalizeRawVerification(rawStorage);
      const normalizedAnalytical = normalizeAnalyticalAttestation(analytical, claim);
      const normalizedControlPlane = normalizeControlVerification(controlPlane);
      const normalizedCredentialVault = normalizeCredentialVerification(finalCredentialVault);
      const storeVerification = Object.freeze({
        credential_vault: normalizedCredentialVault,
        raw_storage: normalizedRawStorage,
        analytical: normalizedAnalytical,
        control_plane: normalizedControlPlane,
      });
      await this.control.progress(claim, "verification", Object.freeze({
        verified: true,
        storesVerified: Object.keys(storeVerification).length,
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
      return Object.freeze({ status: "completed" });
    } catch (error) {
      const errorEvidence = deletionFailureEvidence(error);
      logFailure("deletion_job_attempt_failed", errorEvidence);
      const delaySeconds = Math.min(900, Math.max(10, 2 ** Math.min(claim.readCount, 9) * 5));
      // A retry outcome is only returned after the durable retry transition has
      // succeeded. If scheduling itself fails, propagate that failure so the
      // worker loop and its operational heartbeat cannot report a completion.
      await this.control.retry(claim, errorEvidence, delaySeconds);
      return Object.freeze({
        status: "retry_scheduled",
        failure: errorEvidence,
        retryDelaySeconds: delaySeconds,
      });
    }
  }
}
