import type { RawStoragePage } from "../../../packages/storage/src/s3.js";
import type { RawStorageS3Config } from "../../../packages/storage/src/s3.js";
import { S3RawDeletionObjectStore } from "../../../packages/storage/src/s3-deletion.js";
import type {
  MachineSessionIdentity,
  SupabaseMachineSessionPool,
} from "../../../packages/storage/src/session-credentials.js";
import type { DeletionClaim } from "./store.js";

export interface RawDeletionObjectStore {
  listPrefix(prefix: string, continuationToken?: string): Promise<RawStoragePage>;
  deleteKeys(keys: readonly string[]): Promise<void>;
}

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function scopePrefix(tenantId: string, connectionId: string | null): string {
  if (!ulidPattern.test(tenantId) || (connectionId !== null && !ulidPattern.test(connectionId))) {
    throw new Error("raw_deletion_scope_invalid");
  }
  return connectionId
    ? `tenant/${tenantId}/connection/${connectionId}/`
    : `tenant/${tenantId}/`;
}

export class RawStoragePurger {
  constructor(private readonly objects: RawDeletionObjectStore) {}

  async purge(tenantId: string, connectionId: string | null): Promise<Readonly<{
    verified: true;
    prefix: string;
    objectsRemoved: number;
  }>> {
    const prefix = scopePrefix(tenantId, connectionId);
    let objectsRemoved = 0;
    // Always request the first page again after a delete. This is bounded in
    // memory and cannot skip keys because a continuation cursor became stale
    // when the preceding page was removed.
    for (;;) {
      const page = await this.objects.listPrefix(prefix);
      if (page.keys.length === 0) break;
      await this.objects.deleteKeys(page.keys);
      objectsRemoved += page.keys.length;
    }
    const verification = await this.verify(tenantId, connectionId);
    if (!verification.verified) {
      throw new Error(`raw_storage_verification_failed:${verification.remainingObjects}`);
    }
    return Object.freeze({ verified: true, prefix, objectsRemoved });
  }

  async verify(tenantId: string, connectionId: string | null): Promise<Readonly<{
    verified: boolean;
    remainingObjects: number;
  }>> {
    const page = await this.objects.listPrefix(scopePrefix(tenantId, connectionId));
    return Object.freeze({ verified: page.keys.length === 0, remainingObjects: page.keys.length });
  }
}

export type RawStorageDeletionGrant = Readonly<{
  grantId: string;
  tenantId: string;
  scope: "tenant" | "connection";
  connectionId: string | null;
  operation: "purge" | "verify";
  expiresAt: string;
}>;

export interface RawStorageDeletionSessionControl {
  issueRawStorageSession(
    claim: DeletionClaim,
    operation: "purge" | "verify",
    identity: MachineSessionIdentity,
  ): Promise<RawStorageDeletionGrant>;
  revokeRawStorageSession(claim: DeletionClaim, grantId: string): Promise<void>;
}

export type DeletionScopedObjectStore = RawDeletionObjectStore & Readonly<{ destroy(): void }>;
export type DeletionScopedObjectStoreFactory = (
  scope: Readonly<{
    tenantId: string;
    connectionId: string | null;
    operation: "purge" | "verify";
  }>,
  authorizeSession: (
    identity: MachineSessionIdentity,
  ) => Promise<Readonly<{ expiresAt: Date }>>,
) => DeletionScopedObjectStore;

/**
 * Opens one S3 client for one claimed deletion stage. The Auth token is never
 * returned to this service: the credential provider exposes only validated
 * subject/session/expiry coordinates, which the control plane binds to the
 * live queue attempt before the first S3 request. Every issued grant is
 * explicitly revoked and every client destroyed even when S3 fails.
 */
export class LeaseBoundRawStoragePurger {
  constructor(
    private readonly config: RawStorageS3Config,
    private readonly control: RawStorageDeletionSessionControl,
    private readonly sessionPool: SupabaseMachineSessionPool | undefined,
    private readonly objectStoreFactory?: DeletionScopedObjectStoreFactory,
  ) {}

  purge(claim: DeletionClaim) {
    return this.withSession(claim, "purge", (purger) =>
      purger.purge(claim.tenantId, claim.connectionId));
  }

  verify(claim: DeletionClaim) {
    return this.withSession(claim, "verify", (purger) =>
      purger.verify(claim.tenantId, claim.connectionId));
  }

  private async withSession<T>(
    claim: DeletionClaim,
    operation: "purge" | "verify",
    work: (purger: RawStoragePurger) => Promise<T>,
  ): Promise<T> {
    const grants: string[] = [];
    const scope = {
      tenantId: claim.tenantId,
      connectionId: claim.connectionId,
      operation,
    } as const;
    const authorizeSession = async (identity: MachineSessionIdentity) => {
        const grant = await this.control.issueRawStorageSession(claim, operation, identity);
        if (ulidPattern.test(grant.grantId)) grants.push(grant.grantId);
        if (
          grant.tenantId !== claim.tenantId ||
          grant.scope !== claim.scope ||
          grant.connectionId !== claim.connectionId ||
          grant.operation !== operation ||
          !ulidPattern.test(grant.grantId)
        ) {
          throw new Error("raw_deletion_session_scope_mismatch");
        }
        const expiresAt = new Date(grant.expiresAt);
        if (
          !Number.isFinite(expiresAt.valueOf()) ||
          expiresAt.valueOf() > identity.tokenExpiresAt.valueOf()
        ) {
          throw new Error("raw_deletion_session_expiry_invalid");
        }
        return Object.freeze({ expiresAt });
      };
    const objects = this.objectStoreFactory
      ? this.objectStoreFactory(scope, authorizeSession)
      : new S3RawDeletionObjectStore(this.config, undefined, {
          ...(this.sessionPool ? { sessionPool: this.sessionPool } : {}),
          scope,
          authorizeSession,
        });
    try {
      return await work(new RawStoragePurger(objects));
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
            this.control.revokeRawStorageSession(claim, grantId),
          ),
        ),
      );
      for (const result of revocations) {
        if (result.status === "rejected") cleanupFailures.push(result.reason);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          cleanupFailures,
          "raw_deletion_session_cleanup_failed",
        );
      }
    }
  }
}
