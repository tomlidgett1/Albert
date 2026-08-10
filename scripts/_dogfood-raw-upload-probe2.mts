
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { gzipSync } from "node:zlib";
import { loadRawStorageS3Config } from "../packages/storage/src/s3.js";
import { SupabaseMachineSessionCredentialProvider } from "../packages/storage/src/session-credentials.js";
import { S3RawIngestionObjectStore } from "../packages/storage/src/s3-ingestion.js";

const config = loadRawStorageS3Config(process.env as any, {
  machinePurpose: "sync",
  passwordEnvironmentName: "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
});
const provider = new SupabaseMachineSessionCredentialProvider(config);
const creds = await provider.getCredentials();
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

const tenantId = "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
const connectionId = "01KZ54B1PCKM1MHSNHY4XT6DEX";
const batchId = "01KZTESTPROBE00000000000001";
const key = `tenant/${tenantId}/connection/${connectionId}/stream/shops/date/2026-08-04/batch-${batchId}.jsonl.gz`;
const body = gzipSync(Buffer.from('{"probe":true}\n'), { level: 9 });

async function tryPut(label: string, cmd: any) {
  try {
    await client.send(new PutObjectCommand(cmd));
    console.log(label, "OK");
  } catch (e: any) {
    console.error(label, {
      name: e?.name,
      message: e?.message,
      status: e?.$metadata?.httpStatusCode,
      code: e?.Code,
    });
  }
}

await tryPut("customer no grant camel meta", {
  Bucket: config.bucket,
  Key: key,
  Body: body,
  ContentType: "application/gzip",
  CacheControl: "private, max-age=31536000, immutable",
  IfNoneMatch: "*",
  Metadata: {
    batchId,
    contentSha256: "a".repeat(64),
    compressedSha256: "b".repeat(64),
    schemaSha256: "c".repeat(64),
  },
});

await tryPut("customer no grant no meta", {
  Bucket: config.bucket,
  Key: key + ".nometadata",
  Body: body,
  ContentType: "application/gzip",
  CacheControl: "private, max-age=31536000, immutable",
  IfNoneMatch: "*",
});

// Use putIfAbsent path and inspect thrown message
const store = new S3RawIngestionObjectStore(config, undefined, {
  scope: { tenantId, connectionId, objectKey: key },
  authorizeSession: async () => ({ expiresAt: new Date(Date.now() + 60_000) }),
});
try {
  const result = await store.putIfAbsent({
    key,
    body,
    contentType: "application/gzip",
    metadata: {
      batchId,
      contentSha256: "a".repeat(64),
      compressedSha256: "b".repeat(64),
      schemaSha256: "c".repeat(64),
    },
  });
  console.log("scoped putIfAbsent", result);
} catch (e: any) {
  console.error("scoped putIfAbsent failed", e?.message);
}
store.destroy();
