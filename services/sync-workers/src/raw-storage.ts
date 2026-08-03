import {
  buildRawObjectKey,
  RawBatchWriter,
  type RawBatchContext,
  type RawBatchManifest,
  type RawBatchRecord,
  type RawManifestRepository,
  type RawObjectStore,
} from "../../../packages/storage/src/raw-batch.js";
import type { RawStorageS3Config } from "../../../packages/storage/src/s3.js";
import { S3RawIngestionObjectStore } from "../../../packages/storage/src/s3-ingestion.js";
import type {
  MachineSessionIdentity,
  SupabaseMachineSessionPool,
} from "../../../packages/storage/src/session-credentials.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export type RawStorageSyncGrant = Readonly<{
  grantId: string;
  tenantId: string;
  connectionId: string;
  objectKey: string;
  expiresAt: string;
}>;

export interface RawStorageSyncSessionControl {
  issueRawStorageSyncSession(input: Readonly<{
    permitId: string;
    workerId: string;
    objectKey: string;
    identity: MachineSessionIdentity;
  }>): Promise<RawStorageSyncGrant>;
  revokeRawStorageSyncSession(input: Readonly<{
    tenantId: string;
    permitId: string;
    workerId: string;
    grantId: string;
  }>): Promise<void>;
}

export interface SyncRawWriter {
  write(
    context: RawBatchContext,
    records: readonly RawBatchRecord[],
    authority: Readonly<{ permitId: string; workerId: string }>,
  ): Promise<RawBatchManifest>;
}

export type SyncScopedObjectStore = RawObjectStore & Readonly<{ destroy(): void }>;
export type SyncScopedObjectStoreFactory = (
  scope: Readonly<{ tenantId: string; connectionId: string; objectKey: string }>,
  authorizeSession: (
    identity: MachineSessionIdentity,
  ) => Promise<Readonly<{ expiresAt: Date }>>,
) => SyncScopedObjectStore;

/** One immutable batch, one Auth session grant, one exact object key. */
export class LeaseBoundSyncRawWriter implements SyncRawWriter {
  constructor(
    private readonly config: RawStorageS3Config,
    private readonly manifests: RawManifestRepository,
    private readonly control: RawStorageSyncSessionControl,
    private readonly sessionPool: SupabaseMachineSessionPool | undefined,
    private readonly objectStoreFactory?: SyncScopedObjectStoreFactory,
  ) {}

  async write(
    context: RawBatchContext,
    records: readonly RawBatchRecord[],
    authority: Readonly<{ permitId: string; workerId: string }>,
  ): Promise<RawBatchManifest> {
    const objectKey = buildRawObjectKey(context);
    const grants: string[] = [];
    const scope = {
      tenantId: context.tenantId,
      connectionId: context.connectionId,
      objectKey,
    } as const;
    const authorizeSession = async (identity: MachineSessionIdentity) => {
        const grant = await this.control.issueRawStorageSyncSession({
          ...authority,
          objectKey,
          identity,
        });
        if (ULID.test(grant.grantId)) grants.push(grant.grantId);
        if (
          !ULID.test(grant.grantId) ||
          grant.tenantId !== context.tenantId ||
          grant.connectionId !== context.connectionId ||
          grant.objectKey !== objectKey
        ) {
          throw new Error("sync_raw_storage_grant_scope_mismatch");
        }
        const expiresAt = new Date(grant.expiresAt);
        if (
          !Number.isFinite(expiresAt.valueOf()) ||
          expiresAt.valueOf() > identity.tokenExpiresAt.valueOf()
        ) {
          throw new Error("sync_raw_storage_grant_expiry_invalid");
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
      return await new RawBatchWriter(objects, this.manifests).write(context, records);
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
            this.control.revokeRawStorageSyncSession({
              tenantId: context.tenantId,
              permitId: authority.permitId,
              workerId: authority.workerId,
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
          "sync_raw_storage_session_cleanup_failed",
        );
      }
    }
  }
}
