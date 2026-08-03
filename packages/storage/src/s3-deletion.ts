import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  rawStorageReadinessKey,
  type RawStoragePage,
  type RawStorageS3Config,
} from "./s3.js";
import { SupabaseMachineSessionCredentialProvider } from "./session-credentials.js";
import type {
  MachineSessionAuthorization,
  MachineSessionIdentity,
  SupabaseMachineSessionPool,
} from "./session-credentials.js";

const RAW_BUCKET = "raw-payloads";
const SAFE_RAW_KEY = /^tenant\/[0-9A-HJKMNP-TV-Z]{26}(?:\/[A-Za-z0-9._-]+)+$/u;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export type RawDeletionSessionScope = Readonly<{
  tenantId: string;
  connectionId: string | null;
  operation: "purge" | "verify";
}>;

export type S3RawDeletionObjectStoreOptions = Readonly<{
  sessionPool?: SupabaseMachineSessionPool;
  scope?: RawDeletionSessionScope;
  authorizeSession?: (
    identity: MachineSessionIdentity,
  ) => Promise<MachineSessionAuthorization>;
}>;

export interface RawDeletionObjectStore {
  ready(): Promise<void>;
  listPrefix(prefix: string): Promise<RawStoragePage>;
  deleteKeys(keys: readonly string[]): Promise<void>;
  destroy(): void;
}

/** List/delete-only adapter available exclusively to the deletion service. */
export class S3RawDeletionObjectStore implements RawDeletionObjectStore {
  private readonly client: S3Client;
  private readonly scope: RawDeletionSessionScope | undefined;
  private readonly authorizedPrefix: string | undefined;

  constructor(
    private readonly config: RawStorageS3Config,
    client?: S3Client,
    options?: S3RawDeletionObjectStoreOptions,
  ) {
    if (config.bucket !== RAW_BUCKET || config.machinePurpose !== "deletion") {
      throw new Error("Raw deletion requires the deletion machine principal.");
    }
    this.scope = options?.scope;
    if (
      this.scope &&
      (!ULID.test(this.scope.tenantId) ||
        (this.scope.connectionId !== null && !ULID.test(this.scope.connectionId)))
    ) {
      throw new Error("Raw deletion session scope is invalid.");
    }
    this.authorizedPrefix = this.scope
      ? this.scope.connectionId
        ? `tenant/${this.scope.tenantId}/connection/${this.scope.connectionId}/`
        : `tenant/${this.scope.tenantId}/`
      : undefined;
    if (Boolean(this.scope) !== Boolean(options?.authorizeSession)) {
      throw new Error("Raw deletion scope and session authorizer must be provided together.");
    }
    const credentialProvider = new SupabaseMachineSessionCredentialProvider(config, {
      ...(options?.sessionPool ? { sessionPool: options.sessionPool } : {}),
      ...(options?.authorizeSession ? { authorizeSession: options.authorizeSession } : {}),
    });
    this.client = client ?? new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      maxAttempts: 3,
      credentials: () => credentialProvider.getCredentials(),
    });
  }

  async ready(): Promise<void> {
    const result = await this.client.send(new ListObjectsV2Command({
      Bucket: this.config.bucket,
      Prefix: "tenant/00000000000000000000000000/",
      MaxKeys: 10,
    }));
    const visible = new Set((result.Contents ?? []).flatMap((item) =>
      typeof item.Key === "string" ? [item.Key] : []
    ));
    if (
      !visible.has(rawStorageReadinessKey("sync")) ||
      !visible.has(rawStorageReadinessKey("webhook"))
    ) {
      throw new Error("Raw deletion session cannot enumerate the governed readiness objects.");
    }
  }

  async listPrefix(prefix: string): Promise<RawStoragePage> {
    assertRawPrefix(prefix);
    if (!this.authorizedPrefix || prefix !== this.authorizedPrefix) {
      throw new Error("Raw deletion listing requires an exact active session scope.");
    }
    const result = await this.client.send(new ListObjectsV2Command({
      Bucket: this.config.bucket,
      Prefix: prefix,
      MaxKeys: 1_000,
    }));
    const keys = (result.Contents ?? []).flatMap((item) =>
      typeof item.Key === "string" ? [item.Key] : []
    );
    for (const key of keys) {
      assertRawKey(key);
      this.assertAuthorizedKey(key);
    }
    return Object.freeze({ keys: Object.freeze(keys) });
  }

  async deleteKeys(keys: readonly string[]): Promise<void> {
    if (keys.length < 1 || keys.length > 1_000) {
      throw new Error("Raw object deletion batch must contain 1 to 1000 keys.");
    }
    if (this.scope?.operation !== "purge") {
      throw new Error("Raw deletion requires a purge-scoped active session.");
    }
    for (const key of keys) {
      assertRawKey(key);
      this.assertAuthorizedKey(key);
    }
    const result = await this.client.send(new DeleteObjectsCommand({
      Bucket: this.config.bucket,
      Delete: { Quiet: true, Objects: keys.map((Key) => ({ Key })) },
    }));
    if (result.Errors?.length) {
      const code = result.Errors[0]?.Code?.replaceAll(/[^A-Za-z0-9_.-]/gu, "_") ||
        "delete_error";
      throw new Error(`Raw object deletion failed (${code}).`);
    }
  }

  destroy(): void {
    this.client.destroy();
  }

  private assertAuthorizedKey(key: string): void {
    if (!this.authorizedPrefix || !key.startsWith(this.authorizedPrefix)) {
      throw new Error("Raw storage object key is outside the authorized deletion scope.");
    }
  }
}

function assertRawKey(value: string): void {
  if (value.length > 1_024 || !SAFE_RAW_KEY.test(value) || value.includes("..")) {
    throw new Error("Raw storage object key is outside the governed tenant prefix.");
  }
}

function assertRawPrefix(value: string): void {
  if (!/^tenant\/[0-9A-HJKMNP-TV-Z]{26}(?:\/connection\/[0-9A-HJKMNP-TV-Z]{26})?\/$/u.test(value)) {
    throw new Error("Raw storage prefix is outside the governed tenant scope.");
  }
}
