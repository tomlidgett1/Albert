import { PutObjectCommand, S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { gzipSync } from "node:zlib";

import { loadRawStorageS3Config } from "../packages/storage/src/s3.ts";
import { S3RawIngestionObjectStore } from "../packages/storage/src/s3-ingestion.ts";
import { SupabaseMachineSessionCredentialProvider } from "../packages/storage/src/session-credentials.ts";

function dumpError(label: string, error: unknown): void {
  const e = error as Record<string, unknown> & {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
    Code?: string;
    code?: string;
  };
  console.error(label, {
    name: e?.name,
    message: e?.message,
    code: e?.Code || e?.code,
    status: e?.$metadata?.httpStatusCode,
    json: JSON.stringify(error, Object.getOwnPropertyNames(error as object)).slice(0, 2500),
  });
}

const config = loadRawStorageS3Config(process.env, {
  machinePurpose: "sync",
  passwordEnvironmentName: "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
});
console.log({
  endpoint: config.endpoint,
  region: config.region,
  bucket: config.bucket,
  email: config.machineEmail,
});

const provider = new SupabaseMachineSessionCredentialProvider(config);
const creds = await provider.getCredentials();
console.log({
  accessKeyId: creds.accessKeyId,
  hasSession: Boolean(creds.sessionToken),
  expiration: creds.expiration?.toISOString?.(),
});

const client = new S3Client({
  endpoint: config.endpoint,
  region: config.region,
  forcePathStyle: true,
  credentials: {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  },
});

try {
  const listed = await client.send(new ListObjectsV2Command({
    Bucket: config.bucket,
    MaxKeys: 3,
  }));
  console.log("list ok", { keyCount: listed.KeyCount });
} catch (error) {
  dumpError("list failed", error);
}

const readinessKey =
  "tenant/00000000000000000000000000/connection/00000000000000000000000000/stream/albert_readiness/date/2000-01-01/batch-00000000000000000000000000.jsonl.gz";
const body = gzipSync(Buffer.from("albert-raw-storage-sync-readiness-v1\n"), { level: 9 });
try {
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: readinessKey,
    Body: body,
    ContentType: "application/gzip",
    CacheControl: "private, max-age=31536000, immutable",
    IfNoneMatch: "*",
  }));
  console.log("readiness put created");
} catch (error) {
  dumpError("readiness put failed", error);
}

const store = new S3RawIngestionObjectStore(config);
try {
  await store.ready();
  console.log("store.ready ok");
} catch (error) {
  dumpError("store.ready failed", error);
}
store.destroy();
