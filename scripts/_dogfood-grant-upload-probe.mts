import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { gzipSync } from "node:zlib";
import pg from "pg";

import { loadRawStorageS3Config } from "../packages/storage/src/s3.ts";
import { SupabaseMachineSessionPool } from "../packages/storage/src/session-credentials.ts";

const config = loadRawStorageS3Config(process.env as Record<string, string | undefined>, {
  machinePurpose: "sync",
  passwordEnvironmentName: "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
});
const pool = new SupabaseMachineSessionPool(config);
const session = await pool.getSession();
console.log("auth", { userId: session.userId, sessionId: session.sessionId });

const tenantId = "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
const connectionId = "01KZ54B1PCKM1MHSNHY4XT6DEX";
const permitId = "01KZ56E518DHSPZQASHHHMNENJ";
const workerId = "sync-worker-local:local-sync-01";
const stream = "order_lines";
const batchId = "01KZ55PAP50260DHM8PHFJ2FYV";
const requestedAt = "2026-08-04T01:20:00.197Z";
const date = new Date(requestedAt).toISOString().slice(0, 10);
const objectKey = `tenant/${tenantId}/connection/${connectionId}/stream/${stream}/date/${date}/batch-${batchId}.jsonl.gz`;
console.log("objectKey", objectKey);

const db = new pg.Client({ connectionString: process.env.CONTROL_PLANE_DATABASE_URL });
await db.connect();
await db.query("begin");
await db.query('set local role "albert_sync_control"');

try {
  const grant = await db.query(
    `select * from control_plane.issue_raw_storage_sync_session(
       $1::text,$2::text,$3::text,$4::uuid,$5::uuid,$6::timestamptz
     )`,
    [
      permitId,
      workerId,
      objectKey,
      session.userId,
      session.sessionId,
      new Date(session.tokenExpiresAt).toISOString(),
    ],
  );
  console.log("grant", grant.rows[0]);
} catch (error) {
  console.error("grant failed", error instanceof Error ? error.message : error);
  await db.query("rollback");
  await db.end();
  process.exit(3);
}

// Keep the grant transaction open until after upload? Issuers commit the grant
// inside the SECURITY DEFINER function, so it should be visible immediately.
await db.query("commit");

const client = new S3Client({
  endpoint: config.endpoint,
  region: config.region,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.legacyAnonKey,
    sessionToken: session.accessToken,
  },
});
const body = gzipSync(Buffer.from(`${JSON.stringify({ probe: true })}\n`), { level: 9 });
try {
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    Body: body,
    ContentType: "application/gzip",
    CacheControl: "private, max-age=31536000, immutable",
    IfNoneMatch: "*",
  }));
  console.log("upload OK");
} catch (error) {
  const e = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number }; Code?: string };
  console.error("upload failed", {
    name: e.name,
    message: e.message,
    status: e.$metadata?.httpStatusCode,
    code: e.Code,
  });
}

await db.end();
