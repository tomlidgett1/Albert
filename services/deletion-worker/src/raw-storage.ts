import type { RawStoragePage } from "../../../packages/storage/src/index.js";

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
