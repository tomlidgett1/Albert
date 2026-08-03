import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { gzipSync } from "node:zlib";
import type { RawObjectStore } from "./raw-batch.js";
import {
  rawStorageReadinessKey,
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

export type RawIngestionSessionScope = Readonly<{
  tenantId: string;
  connectionId: string;
  objectKey: string;
}>;

export type S3RawIngestionObjectStoreOptions = Readonly<{
  sessionPool?: SupabaseMachineSessionPool;
  scope?: RawIngestionSessionScope;
  authorizeSession?: (
    identity: MachineSessionIdentity,
  ) => Promise<MachineSessionAuthorization>;
}>;

/** Upload/read-only adapter used by sync and webhook ingestion processes. */
export class S3RawIngestionObjectStore implements RawObjectStore {
  private readonly client: S3Client;
  private readonly scope: RawIngestionSessionScope | undefined;

  constructor(
    private readonly config: RawStorageS3Config,
    client?: S3Client,
    options?: S3RawIngestionObjectStoreOptions,
  ) {
    if (config.bucket !== RAW_BUCKET || config.machinePurpose === "deletion") {
      throw new Error("Raw ingestion requires a sync or webhook machine principal.");
    }
    this.scope = options?.scope;
    if (this.scope) {
      assertRawKey(this.scope.objectKey);
      const expectedPrefix = `tenant/${this.scope.tenantId}/connection/${this.scope.connectionId}/`;
      if (
        !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(this.scope.tenantId) ||
        !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(this.scope.connectionId) ||
        !this.scope.objectKey.startsWith(expectedPrefix) ||
        (config.machinePurpose === "sync") === this.scope.objectKey.includes("/stream/webhook_")
      ) {
        throw new Error("Raw ingestion session scope is invalid for its machine purpose.");
      }
    }
    if (Boolean(this.scope) !== Boolean(options?.authorizeSession)) {
      throw new Error("Raw ingestion scope and session authorizer must be provided together.");
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
    const purpose = this.config.machinePurpose;
    if (purpose === "deletion") {
      throw new Error("Raw ingestion readiness requires an ingestion principal.");
    }
    const probeKey = rawStorageReadinessKey(purpose);
    const probeBody = gzipSync(`albert-raw-storage-${purpose}-readiness-v1\n`, { level: 9 });
    const sentinelVisible = async (): Promise<boolean> => {
      try {
        const result = await this.client.send(new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: probeKey,
        }));
        if (!result.Body) throw new Error("empty_body");
        const received = new Uint8Array(await result.Body.transformToByteArray());
        if (
          received.byteLength !== probeBody.byteLength ||
          received.some((value, index) => value !== probeBody[index])
        ) {
          throw new Error("sentinel_mismatch");
        }
        return true;
      } catch (error) {
        if (httpStatus(error) === 404 || errorName(error) === "NoSuchKey") return false;
        throw new Error(`Raw Storage readiness read failed (${safeStorageCode(error)}).`);
      }
    };

    if (await sentinelVisible()) return;
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: probeKey,
        Body: probeBody,
        CacheControl: "private, max-age=31536000, immutable",
        ContentType: "application/gzip",
        IfNoneMatch: "*",
      }));
    } catch (error) {
      // A concurrent replica can create the sentinel after our first read.
      // Supabase can report that immutable collision as 403, 409, or 412
      // because ingestion intentionally has no UPDATE policy. Passing still
      // requires the exact object to become readable below.
      if (![403, 409, 412].includes(httpStatus(error) ?? 0)) {
        throw new Error(`Raw Storage readiness upload failed (${safeStorageCode(error)}).`);
      }
    }
    if (!(await sentinelVisible())) {
      throw new Error("Raw Storage readiness object is not visible to the machine session.");
    }
  }

  async putIfAbsent(
    input: Parameters<RawObjectStore["putIfAbsent"]>[0],
  ): Promise<"created" | "exists"> {
    assertRawKey(input.key);
    this.assertAuthorizedObject(input.key);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.client.send(new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: input.key,
          Body: input.body,
          CacheControl: "private, max-age=31536000, immutable",
          ContentType: input.contentType,
          Metadata: { ...input.metadata },
          IfNoneMatch: "*",
        }));
        return "created";
      } catch (error) {
        const status = httpStatus(error);
        if (status === 412) return "exists";
        if (status === 409 && attempt < 3) continue;
        throw new Error(`Immutable raw upload failed (${safeStorageCode(error)}).`);
      }
    }
    throw new Error("Immutable raw upload failed (conditional_conflict).");
  }

  async read(key: string): Promise<Uint8Array | null> {
    assertRawKey(key);
    this.assertAuthorizedObject(key);
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }));
      if (!result.Body) throw new Error("empty_body");
      return new Uint8Array(await result.Body.transformToByteArray());
    } catch (error) {
      if (httpStatus(error) === 404 || errorName(error) === "NoSuchKey") return null;
      throw new Error(`Immutable raw download failed (${safeStorageCode(error)}).`);
    }
  }

  destroy(): void {
    this.client.destroy();
  }

  private assertAuthorizedObject(key: string): void {
    if (!this.scope || key !== this.scope.objectKey) {
      throw new Error("Raw ingestion customer access requires an exact active session scope.");
    }
  }
}

function assertRawKey(value: string): void {
  if (value.length > 1_024 || !SAFE_RAW_KEY.test(value) || value.includes("..")) {
    throw new Error("Raw storage object key is outside the governed tenant prefix.");
  }
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const metadata = (error as { $metadata?: unknown }).$metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const status = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function safeStorageCode(error: unknown): string {
  const status = httpStatus(error);
  if (status) return `http_${status}`;
  const name = errorName(error);
  return name?.replaceAll(/[^A-Za-z0-9_.-]/gu, "_") || "storage_error";
}
