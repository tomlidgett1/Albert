import type { RawStorageS3Config } from "../../../packages/storage/src/s3.js";
import type { RawObjectStore } from "../../../packages/storage/src/raw-batch.js";
import { S3RawIngestionObjectStore } from "../../../packages/storage/src/s3-ingestion.js";
import type {
  MachineSessionIdentity,
  SupabaseMachineSessionPool,
} from "../../../packages/storage/src/session-credentials.js";
import {
  buildWebhookRawObjectKey,
  WebhookRawWriter,
  type WebhookRawReceipt,
  type WebhookRawWriteInput,
} from "../../../packages/storage/src/webhook-raw.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export type RawStorageWebhookGrant = Readonly<{
  grantId: string;
  tenantId: string;
  connectionId: string;
  objectKey: string;
  expiresAt: string;
}>;

export interface RawStorageWebhookSessionControl {
  issueRawStorageWebhookSession(input: Readonly<{
    tenantId: string;
    connectionId: string;
    receiptId: string;
    connectorKey: "xero" | "deputy";
    verificationReference: string;
    xeroLeaseOwner?: string;
    xeroLeaseToken?: string;
    xeroLeaseVersion?: number;
    identity: MachineSessionIdentity;
  }>): Promise<RawStorageWebhookGrant>;
  revokeRawStorageWebhookSession(input: Readonly<{
    tenantId: string;
    receiptId: string;
    grantId: string;
  }>): Promise<void>;
}

export type WebhookScopedObjectStore = RawObjectStore & Readonly<{ destroy(): void }>;
export type WebhookScopedObjectStoreFactory = (
  scope: Readonly<{ tenantId: string; connectionId: string; objectKey: string }>,
  authorizeSession: (
    identity: MachineSessionIdentity,
  ) => Promise<Readonly<{ expiresAt: Date }>>,
) => WebhookScopedObjectStore;

/** One attested receipt, one exact object, and (for Xero) one inbox lease. */
export class LeaseBoundWebhookRawWriter {
  constructor(
    private readonly config: RawStorageS3Config,
    private readonly control: RawStorageWebhookSessionControl,
    private readonly sessionPool: SupabaseMachineSessionPool | undefined,
    private readonly objectStoreFactory?: WebhookScopedObjectStoreFactory,
  ) {}

  async put(input: WebhookRawWriteInput): Promise<WebhookRawReceipt> {
    const authority = input.authority;
    if (!authority || !ULID.test(authority.verificationReference)) {
      throw new Error("webhook_raw_storage_authority_missing");
    }
    if (
      input.connectorKey === "xero" &&
      (!authority.xeroLeaseOwner || !authority.xeroLeaseToken ||
        !Number.isSafeInteger(authority.xeroLeaseVersion) ||
        (authority.xeroLeaseVersion ?? 0) < 1)
    ) {
      throw new Error("xero_raw_storage_lease_missing");
    }
    if (
      input.connectorKey === "deputy" &&
      (authority.xeroLeaseOwner !== undefined || authority.xeroLeaseToken !== undefined ||
        authority.xeroLeaseVersion !== undefined)
    ) {
      throw new Error("deputy_raw_storage_lease_invalid");
    }
    const objectKey = buildWebhookRawObjectKey(input);
    const grants: string[] = [];
    const scope = {
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      objectKey,
    } as const;
    const authorizeSession = async (identity: MachineSessionIdentity) => {
        const grant = await this.control.issueRawStorageWebhookSession({
          tenantId: input.tenantId,
          connectionId: input.connectionId,
          receiptId: input.receiptId,
          connectorKey: input.connectorKey,
          verificationReference: authority.verificationReference,
          ...(authority.xeroLeaseOwner
            ? { xeroLeaseOwner: authority.xeroLeaseOwner }
            : {}),
          ...(authority.xeroLeaseToken
            ? { xeroLeaseToken: authority.xeroLeaseToken }
            : {}),
          ...(authority.xeroLeaseVersion === undefined
            ? {}
            : { xeroLeaseVersion: authority.xeroLeaseVersion }),
          identity,
        });
        if (ULID.test(grant.grantId)) grants.push(grant.grantId);
        if (
          !ULID.test(grant.grantId) ||
          grant.tenantId !== input.tenantId ||
          grant.connectionId !== input.connectionId ||
          grant.objectKey !== objectKey
        ) {
          throw new Error("webhook_raw_storage_grant_scope_mismatch");
        }
        const expiresAt = new Date(grant.expiresAt);
        if (
          !Number.isFinite(expiresAt.valueOf()) ||
          expiresAt.valueOf() > identity.tokenExpiresAt.valueOf()
        ) {
          throw new Error("webhook_raw_storage_grant_expiry_invalid");
        }
        return Object.freeze({ expiresAt });
      };
    const objects = this.objectStoreFactory
      ? this.objectStoreFactory(scope, authorizeSession)
      : new S3RawIngestionObjectStore(this.config, undefined, {
          ...(this.sessionPool ? { sessionPool: this.sessionPool } : {}),
          scope,
          authorizeSession,
        });
    try {
      return await new WebhookRawWriter(objects).put(input);
    } finally {
      const cleanupFailures: unknown[] = [];
      try {
        objects.destroy();
      } catch (error) {
        cleanupFailures.push(error);
      }
      const revocations = await Promise.allSettled(
        [...new Set(grants)].map((grantId) =>
          Promise.resolve().then(() =>
            this.control.revokeRawStorageWebhookSession({
              tenantId: input.tenantId,
              receiptId: input.receiptId,
              grantId,
            }),
          ),
        ),
      );
      for (const result of revocations) {
        if (result.status === "rejected") cleanupFailures.push(result.reason);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          cleanupFailures,
          "webhook_raw_storage_session_cleanup_failed",
        );
      }
    }
  }
}
