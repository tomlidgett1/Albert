import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { S3RawDeletionObjectStore } from "../packages/storage/src/s3-deletion.js";
import { S3RawIngestionObjectStore } from "../packages/storage/src/s3-ingestion.js";
import {
  loadRawStorageS3Config,
  rawStorageReadinessKey,
  type RawStorageMachinePurpose,
  type RawStorageS3Config,
} from "../packages/storage/src/s3.js";
import {
  SupabaseMachineSessionCredentialProvider,
  SupabaseMachineSessionPool,
  type MachineSessionIdentity,
} from "../packages/storage/src/session-credentials.js";
import { PgTransactionalDatabase } from "../services/sync-workers/src/postgres.js";

const tenantId = "01JA0000000000000000000001";
const connectionId = "01JA0000000000000000000002";
const deletionConnectionId = "01JA0000000000000000000003";
const syncJobRequestId = "01JA0000000000000000000005";
const syncBatchId = "01JA0000000000000000000006";
const webhookMaterialId = "01JA0000000000000000000007";
const webhookReceiptId = "01JA0000000000000000000008";
const deletionRequestId = "01JA0000000000000000000009";
const deletionBatchId = "01JA000000000000000000000A";
const syncWorkerId = "raw-storage-runtime-sync";
const deletionWorkerId = "raw-storage-runtime-deletion";
const syncKey = `tenant/${tenantId}/connection/${connectionId}/stream/sales/date/2026-08-03/batch-${syncBatchId}.jsonl.gz`;
const webhookKey = `tenant/${tenantId}/connection/${connectionId}/stream/webhook_deputy/date/2026-08-03/batch-${webhookReceiptId}.json.gz`;
const deletionPrefix = `tenant/${tenantId}/connection/${deletionConnectionId}/`;
const deletionKey = `${deletionPrefix}stream/sales/date/2026-08-03/batch-${deletionBatchId}.jsonl.gz`;
const crossScopePrefix = `tenant/${tenantId}/connection/${connectionId}/`;

type GrantRow = Readonly<{
  grant_id: string;
  tenant_id: string;
  connection_id: string;
  object_key: string;
  expires_at: Date;
}>;

type DeletionGrantRow = Readonly<{
  grant_id: string;
  tenant_id: string;
  scope: "tenant" | "connection";
  connection_id: string | null;
  operation: "purge" | "verify";
  expires_at: Date;
}>;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the raw Storage S3 proof.`);
  return value;
}

function passwordName(purpose: RawStorageMachinePurpose) {
  return `ALBERT_RAW_STORAGE_${purpose.toUpperCase()}_PASSWORD` as
    | "ALBERT_RAW_STORAGE_SYNC_PASSWORD"
    | "ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD"
    | "ALBERT_RAW_STORAGE_DELETION_PASSWORD";
}

function config(purpose: RawStorageMachinePurpose): RawStorageS3Config {
  return loadRawStorageS3Config(process.env, {
    machinePurpose: purpose,
    passwordEnvironmentName: passwordName(purpose),
  });
}

function runtimeDatabase(
  login: string,
  group: string,
  passwordEnvironmentName: string,
): PgTransactionalDatabase {
  const target = new URL(required("CONTROL_PLANE_DATABASE_URL"));
  target.username = login;
  target.password = required(passwordEnvironmentName);
  return new PgTransactionalDatabase(target.toString(), {
    applicationName: `raw-storage-s3-proof-${group}`,
    assumedRole: group,
    maxConnections: 1,
    statementTimeoutMs: 15_000,
  });
}

function sessionClient(
  selected: RawStorageS3Config,
  sessionPool: SupabaseMachineSessionPool,
): S3Client {
  const provider = new SupabaseMachineSessionCredentialProvider(selected, { sessionPool });
  return new S3Client({
    endpoint: selected.endpoint,
    region: selected.region,
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: () => provider.getCredentials(),
  });
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const metadata = (error as { $metadata?: unknown }).$metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const status = (metadata as { httpStatusCode?: unknown }).httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

async function read(client: S3Client, bucket: string, key: string): Promise<Uint8Array | null> {
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!result.Body) throw new Error("Raw Storage S3 proof received an empty object body.");
    return new Uint8Array(await result.Body.transformToByteArray());
  } catch (error) {
    if ([403, 404].includes(statusCode(error) ?? 0)) return null;
    throw error;
  }
}

async function visibleKeys(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const result = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 1_000,
  }));
  return (result.Contents ?? []).flatMap((item) =>
    typeof item.Key === "string" ? [item.Key] : []
  );
}

async function adminObject(
  method: "POST" | "DELETE",
  selected: RawStorageS3Config,
  key: string,
  body?: Uint8Array,
): Promise<void> {
  const serviceKey = required("SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY");
  const safeKey = key.split("/").map(encodeURIComponent).join("/");
  const uploadBody = body ? Uint8Array.from(body).buffer : undefined;
  const response = await fetch(
    `${selected.authUrl}/storage/v1/object/${selected.bucket}/${safeKey}`,
    {
      method,
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        ...(method === "POST"
          ? { "content-type": "application/gzip", "x-upsert": "true" }
          : {}),
      },
      ...(uploadBody ? { body: uploadBody } : {}),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok && !(method === "DELETE" && response.status === 404)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Raw Storage administrator fixture ${method} failed (http_${response.status}).`);
  }
  await response.body?.cancel().catch(() => undefined);
}

function assertGrantExpiry(expiresAt: Date, identity: MachineSessionIdentity): void {
  assert.ok(Number.isFinite(expiresAt.valueOf()));
  assert.ok(expiresAt.valueOf() > Date.now() + 5_000);
  assert.ok(expiresAt.valueOf() <= identity.tokenExpiresAt.valueOf());
}

export async function proveRawStorageS3Sessions(): Promise<void> {
  const syncConfig = config("sync");
  const webhookConfig = config("webhook");
  const deletionConfig = config("deletion");
  const syncDatabase = runtimeDatabase(
    "albert_sync_control_runtime",
    "albert_sync_control",
    "ALBERT_SYNC_CONTROL_DB_PASSWORD",
  );
  const webhookDatabase = runtimeDatabase(
    "albert_webhook_control_runtime",
    "albert_webhook_control",
    "ALBERT_WEBHOOK_CONTROL_DB_PASSWORD",
  );
  const deletionDatabase = runtimeDatabase(
    "albert_deletion_control_runtime",
    "albert_deletion_control",
    "ALBERT_DELETION_CONTROL_DB_PASSWORD",
  );
  const administrator = new PgTransactionalDatabase(required("CONTROL_PLANE_DATABASE_URL"), {
    applicationName: "raw-storage-s3-proof-administrator",
    maxConnections: 1,
    statementTimeoutMs: 15_000,
  });
  const syncPool = new SupabaseMachineSessionPool(syncConfig);
  const webhookPool = new SupabaseMachineSessionPool(webhookConfig);
  const deletionPool = new SupabaseMachineSessionPool(deletionConfig);
  const syncProbe = sessionClient(syncConfig, syncPool);
  const webhookProbe = sessionClient(webhookConfig, webhookPool);
  const deletionProbe = sessionClient(deletionConfig, deletionPool);
  const readiness = [
    new S3RawIngestionObjectStore(syncConfig),
    new S3RawIngestionObjectStore(webhookConfig),
    new S3RawDeletionObjectStore(deletionConfig),
  ] as const;
  const stores: Array<{ destroy(): void }> = [];
  const syncGrantIds: string[] = [];
  const webhookGrantIds: string[] = [];
  const deletionGrantIds: string[] = [];
  let syncExpiredSeeded = false;
  let webhookExpiredSeeded = false;
  let deletionExpiredSeeded = false;

  const syncCoordinates = await administrator.query<{
    permit_id: string;
  }>(`
    select permit_id
      from control_plane.sync_write_permits
     where tenant_id=$1 and job_request_id=$2 and worker_id=$3
       and expires_at>clock_timestamp()
  `, [tenantId, syncJobRequestId, syncWorkerId]);
  assert.equal(syncCoordinates.rows.length, 1, "the exact runtime sync permit must remain live");
  const syncPermitId = syncCoordinates.rows[0]!.permit_id;

  const deletionCoordinates = await administrator.query<{
    message_id: string;
    attempt_number: number;
  }>(`
    select request.queue_message_id::text as message_id,attempt.attempt_number
      from control_plane.deletion_requests as request
      join control_plane.deletion_job_attempts as attempt
        on attempt.tenant_id=request.tenant_id
       and attempt.deletion_request_id=request.deletion_request_id
     where request.tenant_id=$1 and request.deletion_request_id=$2
       and request.status='running' and attempt.worker_id=$3
       and attempt.outcome is null and attempt.visibility_deadline>clock_timestamp()
  `, [tenantId, deletionRequestId, deletionWorkerId]);
  assert.equal(deletionCoordinates.rows.length, 1, "the exact runtime deletion lease must remain live");
  const deletionMessageId = deletionCoordinates.rows[0]!.message_id;
  const deletionAttempt = deletionCoordinates.rows[0]!.attempt_number;

  const syncAuthorize = async (identity: MachineSessionIdentity) => {
    if (!syncExpiredSeeded) {
      syncExpiredSeeded = true;
      await administrator.query(`
        insert into control_plane.raw_storage_sync_session_grants(
          tenant_id,grant_id,permit_id,worker_id,auth_user_id,auth_session_id,
          object_key,issued_at,expires_at
        ) values($1,'01JA000000000000000000000B',$2,$3,$4,$5,$6,
                 statement_timestamp()-interval '10 minutes',
                 statement_timestamp()-interval '6 minutes')
      `, [tenantId, syncPermitId, syncWorkerId, identity.userId, identity.sessionId, syncKey]);
    }
    const issued = await syncDatabase.query<GrantRow>(`
      select * from control_plane.issue_raw_storage_sync_session($1,$2,$3,$4,$5,$6)
    `, [syncPermitId, syncWorkerId, syncKey, identity.userId, identity.sessionId,
      identity.tokenExpiresAt]);
    assert.equal(issued.rows.length, 1);
    const grant = issued.rows[0]!;
    assert.equal(grant.tenant_id, tenantId);
    assert.equal(grant.connection_id, connectionId);
    assert.equal(grant.object_key, syncKey);
    assertGrantExpiry(grant.expires_at, identity);
    syncGrantIds.push(grant.grant_id);
    return Object.freeze({ expiresAt: grant.expires_at });
  };

  const webhookAuthorize = async (identity: MachineSessionIdentity) => {
    if (!webhookExpiredSeeded) {
      webhookExpiredSeeded = true;
      await administrator.query(`
        insert into control_plane.raw_storage_webhook_session_grants(
          tenant_id,grant_id,connection_id,webhook_receipt_id,connector_key,
          verification_reference,auth_user_id,auth_session_id,object_key,
          issued_at,expires_at
        ) values($1,'01JA000000000000000000000C',$2,$3,'deputy',$4,$5,$6,$7,
                 statement_timestamp()-interval '10 minutes',
                 statement_timestamp()-interval '9 minutes')
      `, [tenantId, connectionId, webhookReceiptId, webhookMaterialId,
        identity.userId, identity.sessionId, webhookKey]);
    }
    const issued = await webhookDatabase.query<GrantRow>(`
      select * from control_plane.issue_raw_storage_webhook_session(
        $1,$2,$3,$4,null,null,null,$5,$6,$7
      )
    `, [tenantId, connectionId, webhookReceiptId, webhookMaterialId,
      identity.userId, identity.sessionId, identity.tokenExpiresAt]);
    assert.equal(issued.rows.length, 1);
    const grant = issued.rows[0]!;
    assert.equal(grant.tenant_id, tenantId);
    assert.equal(grant.connection_id, connectionId);
    assert.equal(grant.object_key, webhookKey);
    assertGrantExpiry(grant.expires_at, identity);
    webhookGrantIds.push(grant.grant_id);
    return Object.freeze({ expiresAt: grant.expires_at });
  };

  const deletionAuthorize = async (identity: MachineSessionIdentity) => {
    if (!deletionExpiredSeeded) {
      deletionExpiredSeeded = true;
      await administrator.query(`
        insert into control_plane.raw_storage_deletion_session_grants(
          tenant_id,grant_id,deletion_request_id,attempt_number,worker_id,message_id,
          auth_user_id,auth_session_id,operation,scope,connection_id,issued_at,expires_at
        ) values($1,'01JA000000000000000000000D',$2,$3,$4,$5,$6,$7,'purge',
                 'connection',$8,statement_timestamp()-interval '10 minutes',
                 statement_timestamp()-interval '6 minutes')
      `, [tenantId, deletionRequestId, deletionAttempt, deletionWorkerId,
        deletionMessageId, identity.userId, identity.sessionId, deletionConnectionId]);
    }
    const issued = await deletionDatabase.query<DeletionGrantRow>(`
      select * from control_plane.issue_raw_storage_deletion_session(
        $1,$2,$3,$4,'purge',$5,$6,$7
      )
    `, [deletionMessageId, deletionRequestId, deletionWorkerId, deletionAttempt,
      identity.userId, identity.sessionId, identity.tokenExpiresAt]);
    assert.equal(issued.rows.length, 1);
    const grant = issued.rows[0]!;
    assert.equal(grant.tenant_id, tenantId);
    assert.equal(grant.scope, "connection");
    assert.equal(grant.connection_id, deletionConnectionId);
    assert.equal(grant.operation, "purge");
    assertGrantExpiry(grant.expires_at, identity);
    deletionGrantIds.push(grant.grant_id);
    return Object.freeze({ expiresAt: grant.expires_at });
  };

  try {
    await Promise.all(readiness.map((store) => store.ready()));
    const sentinelPrefix = "tenant/00000000000000000000000000/";
    const [ambientSync, ambientWebhook, ambientDeletion] = await Promise.all([
      visibleKeys(syncProbe, syncConfig.bucket, "tenant/"),
      visibleKeys(webhookProbe, webhookConfig.bucket, "tenant/"),
      visibleKeys(deletionProbe, deletionConfig.bucket, "tenant/"),
    ]);
    assert.deepEqual(ambientSync, [rawStorageReadinessKey("sync")]);
    assert.deepEqual(ambientWebhook, [rawStorageReadinessKey("webhook")]);
    assert.deepEqual([...ambientDeletion].sort(), [
      rawStorageReadinessKey("sync"),
      rawStorageReadinessKey("webhook"),
    ].sort());
    assert.ok([...ambientSync, ...ambientWebhook, ...ambientDeletion]
      .every((key) => key.startsWith(sentinelPrefix)));

    await adminObject("POST", deletionConfig, deletionKey, new Uint8Array([31, 139, 8, 2]));
    const sync = new S3RawIngestionObjectStore(syncConfig, undefined, {
      sessionPool: syncPool,
      scope: { tenantId, connectionId, objectKey: syncKey },
      authorizeSession: syncAuthorize,
    });
    const webhook = new S3RawIngestionObjectStore(webhookConfig, undefined, {
      sessionPool: webhookPool,
      scope: { tenantId, connectionId, objectKey: webhookKey },
      authorizeSession: webhookAuthorize,
    });
    const deletion = new S3RawDeletionObjectStore(deletionConfig, undefined, {
      sessionPool: deletionPool,
      scope: { tenantId, connectionId: deletionConnectionId, operation: "purge" },
      authorizeSession: deletionAuthorize,
    });
    stores.push(sync, webhook, deletion);

    const syncBody = new Uint8Array([31, 139, 8, 0]);
    const webhookBody = new Uint8Array([31, 139, 8, 1]);
    assert.equal(await sync.putIfAbsent({
      key: syncKey,
      body: syncBody,
      contentType: "application/gzip",
      metadata: { batchid: syncBatchId },
    }), "created");
    assert.deepEqual(await sync.read(syncKey), syncBody);
    assert.equal(await webhook.putIfAbsent({
      key: webhookKey,
      body: webhookBody,
      contentType: "application/gzip",
      metadata: { receiptid: webhookReceiptId },
    }), "created");
    assert.deepEqual(await webhook.read(webhookKey), webhookBody);

    assert.deepEqual(await read(syncProbe, syncConfig.bucket, syncKey), syncBody);
    assert.equal(await read(syncProbe, syncConfig.bucket, webhookKey), null);
    assert.deepEqual(await read(webhookProbe, webhookConfig.bucket, webhookKey), webhookBody);
    assert.equal(await read(webhookProbe, webhookConfig.bucket, syncKey), null);

    await syncProbe.send(new DeleteObjectsCommand({
      Bucket: syncConfig.bucket,
      Delete: { Objects: [{ Key: syncKey }] },
    }));
    assert.deepEqual(await sync.read(syncKey), syncBody);
    await assert.rejects(deletionProbe.send(new PutObjectCommand({
      Bucket: deletionConfig.bucket,
      Key: deletionKey,
      Body: new Uint8Array([31, 139, 8, 3]),
      ContentType: "application/gzip",
    })));
    assert.deepEqual(
      await visibleKeys(deletionProbe, deletionConfig.bucket, deletionPrefix),
      [],
      "the ambient deletion principal must not enumerate customer objects",
    );
    assert.deepEqual(await visibleKeys(deletionProbe, deletionConfig.bucket, crossScopePrefix), []);
    const page = await deletion.listPrefix(deletionPrefix);
    assert.deepEqual(page.keys, [deletionKey]);
    await deletion.deleteKeys(page.keys);
    assert.deepEqual((await deletion.listPrefix(deletionPrefix)).keys, []);

    const expired = await administrator.query<{ remaining: string }>(`
      select count(*)::text as remaining
        from (
          select grant_id from control_plane.raw_storage_sync_session_grants
           where grant_id='01JA000000000000000000000B'
          union all
          select grant_id from control_plane.raw_storage_webhook_session_grants
           where grant_id='01JA000000000000000000000C'
          union all
          select grant_id from control_plane.raw_storage_deletion_session_grants
           where grant_id='01JA000000000000000000000D'
        ) as crashed
    `);
    assert.equal(expired.rows[0]?.remaining, "0", "every issuer must reap crashed expired grants");

    await administrator.query(`
      insert into control_plane.deletion_requests(
        tenant_id,deletion_request_id,connection_id,scope,status,
        remote_revocation_status,credential_destroyed_at,credential_destruction_due_at,
        purge_due_at,progress
      ) values($1,'01JA000000000000000000000E',$2,'connection','queued',
               'not_applicable',clock_timestamp(),clock_timestamp(),clock_timestamp(),'{}')
    `, [tenantId, connectionId]);
    assert.equal(await read(syncProbe, syncConfig.bucket, syncKey), null);
    assert.equal(await read(webhookProbe, webhookConfig.bucket, webhookKey), null);

    const revokeResults = await Promise.allSettled([
      ...syncGrantIds.map((grantId) => syncDatabase.query<{ revoked: boolean }>(`
        select control_plane.revoke_raw_storage_sync_session($1,$2,$3,$4) as revoked
      `, [tenantId, syncPermitId, syncWorkerId, grantId])),
      ...webhookGrantIds.map((grantId) => webhookDatabase.query<{ revoked: boolean }>(`
        select control_plane.revoke_raw_storage_webhook_session($1,$2,$3) as revoked
      `, [tenantId, webhookReceiptId, grantId])),
      ...deletionGrantIds.map((grantId) => deletionDatabase.query<{ revoked: boolean }>(`
        select control_plane.revoke_raw_storage_deletion_session($1,$2,$3,$4,$5) as revoked
      `, [deletionMessageId, deletionRequestId, deletionWorkerId, deletionAttempt, grantId])),
    ]);
    for (const result of revokeResults) {
      assert.equal(result.status, "fulfilled");
      if (result.status === "fulfilled") assert.equal(result.value.rows[0]?.revoked, true);
    }
    assert.equal(await read(syncProbe, syncConfig.bucket, syncKey), null);
    assert.equal(await read(webhookProbe, webhookConfig.bucket, webhookKey), null);
    await adminObject("POST", deletionConfig, deletionKey, new Uint8Array([31, 139, 8, 4]));
    assert.deepEqual(await visibleKeys(deletionProbe, deletionConfig.bucket, deletionPrefix), []);
  } finally {
    try {
      await Promise.allSettled([
        adminObject("DELETE", syncConfig, syncKey),
        adminObject("DELETE", webhookConfig, webhookKey),
        adminObject("DELETE", deletionConfig, deletionKey),
      ]);
      await administrator.transaction(async (client) => {
        // The seed must commit because three exact runtime logins and this S3
        // process share it. Remove it under the same protected deletion boundary
        // so later database suites always start from their own fixtures.
        await client.query("set local role albert_control_migration_owner");
        await client.query("select set_config('albert.deletion_authorized','on',true)");
        await client.query(
          "delete from control_plane.deletion_requests where tenant_id=$1",
          [tenantId],
        );
        await client.query("delete from control_plane.tenants where tenant_id=$1", [tenantId]);
      });
    } finally {
      for (const store of [...stores, ...readiness]) store.destroy();
      syncProbe.destroy();
      webhookProbe.destroy();
      deletionProbe.destroy();
      await Promise.allSettled([
        syncDatabase.close(),
        webhookDatabase.close(),
        deletionDatabase.close(),
        administrator.close(),
      ]);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await proveRawStorageS3Sessions();
  process.stdout.write("lease-bound raw Storage S3 runtime proof passed\n");
}
