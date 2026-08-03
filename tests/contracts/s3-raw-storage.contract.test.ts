import assert from "node:assert/strict";
import test from "node:test";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { WebhookRawWriter } from "../../packages/storage/src/webhook-raw.js";
import { S3RawDeletionObjectStore } from "../../packages/storage/src/s3-deletion.js";
import { S3RawIngestionObjectStore } from "../../packages/storage/src/s3-ingestion.js";
import {
  loadRawStorageS3Config,
  rawStorageReadinessKey,
  type RawStorageS3Config,
} from "../../packages/storage/src/s3.js";
import {
  SupabaseMachineSessionCredentialProvider,
  SupabaseMachineSessionPool,
} from "../../packages/storage/src/session-credentials.js";

const tenantId = "01J00000000000000000000001";
const connectionId = "01J00000000000000000000002";
const receiptId = "01J00000000000000000000003";
const key = `tenant/${tenantId}/connection/${connectionId}/stream/sales/date/2026-08-03/batch-${receiptId}.jsonl.gz`;
const projectRef = "abcdefghijklmnopqrst";

function jwt(payload: Readonly<Record<string, unknown>>): string {
  return `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

const legacyAnonKey = jwt({ role: "anon", ref: projectRef, exp: 4_102_444_800 });
const ingestionConfig: RawStorageS3Config = {
  endpoint: `https://${projectRef}.storage.supabase.co/storage/v1/s3`,
  authUrl: `https://${projectRef}.supabase.co`,
  region: "ap-southeast-2",
  accessKeyId: projectRef,
  legacyAnonKey,
  machinePurpose: "sync",
  machineEmail: "raw-storage-sync@machine.albert.invalid",
  machinePassword: "sync-machine-password-material-00000001",
  bucket: "raw-payloads",
};
const deletionConfig: RawStorageS3Config = {
  ...ingestionConfig,
  machinePurpose: "deletion",
  machineEmail: "raw-storage-deletion@machine.albert.invalid",
  machinePassword: "deletion-machine-password-material-00001",
};
const injectedScopeAuthorization = async () => ({
  expiresAt: new Date(Date.now() + 120_000),
});

test("ingestion S3 adapter exposes only immutable conditional write and verification commands", async () => {
  const calls: unknown[] = [];
  let readinessBody: Uint8Array | undefined;
  const client = {
    async send(command: unknown) {
      calls.push(command);
      if (
        command instanceof PutObjectCommand &&
        command.input.Key === rawStorageReadinessKey("sync")
      ) {
        readinessBody = command.input.Body as Uint8Array;
        return {};
      }
      if (command instanceof GetObjectCommand) {
        if (command.input.Key === rawStorageReadinessKey("sync")) {
          if (!readinessBody) {
            throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
          }
          return {
            Body: {
              async transformToByteArray() {
                return readinessBody ?? new Uint8Array();
              },
            },
          };
        }
        return { Body: { async transformToByteArray() { return new Uint8Array([1, 2, 3]); } } };
      }
      return {};
    },
    destroy() {},
  } as unknown as S3Client;
  const store = new S3RawIngestionObjectStore(ingestionConfig, client, {
    scope: { tenantId, connectionId, objectKey: key },
    authorizeSession: injectedScopeAuthorization,
  });
  await store.ready();
  assert.equal(await store.putIfAbsent({
    key,
    body: new Uint8Array([1, 2, 3]),
    contentType: "application/gzip",
    metadata: { sha256: "a".repeat(64) },
  }), "created");
  assert.deepEqual(await store.read(key), new Uint8Array([1, 2, 3]));
  assert.ok(calls[0] instanceof GetObjectCommand);
  assert.ok(calls[1] instanceof PutObjectCommand);
  assert.ok(calls[2] instanceof GetObjectCommand);
  assert.ok(calls[3] instanceof PutObjectCommand);
  assert.equal((calls[3] as PutObjectCommand).input.IfNoneMatch, "*");
  assert.equal((calls[3] as PutObjectCommand).input.Bucket, "raw-payloads");
  assert.equal("deleteKeys" in store, false);
  assert.equal("listPrefix" in store, false);
  await assert.rejects(() => store.read(`other/${key}`), /outside the governed tenant prefix/);
});

test("deletion S3 adapter exposes only bounded list and delete commands", async () => {
  const calls: unknown[] = [];
  let listCalls = 0;
  const client = {
    async send(command: unknown) {
      calls.push(command);
      if (command instanceof ListObjectsV2Command) {
        listCalls += 1;
        return listCalls === 1
          ? { Contents: [
            { Key: rawStorageReadinessKey("sync") },
            { Key: rawStorageReadinessKey("webhook") },
          ] }
          : { Contents: [{ Key: key }] };
      }
      if (command instanceof DeleteObjectsCommand) return {};
      return {};
    },
    destroy() {},
  } as unknown as S3Client;
  const store = new S3RawDeletionObjectStore(deletionConfig, client, {
    scope: { tenantId, connectionId, operation: "purge" },
    authorizeSession: injectedScopeAuthorization,
  });
  await store.ready();
  const page = await store.listPrefix(`tenant/${tenantId}/connection/${connectionId}/`);
  assert.deepEqual(page.keys, [key]);
  await store.deleteKeys(page.keys);
  assert.ok(calls[0] instanceof ListObjectsV2Command);
  assert.ok(calls[1] instanceof ListObjectsV2Command);
  assert.ok(calls[2] instanceof DeleteObjectsCommand);
  assert.equal("putIfAbsent" in store, false);
  assert.equal("read" in store, false);
  await assert.rejects(
    () => store.listPrefix("tenant/not-a-tenant/"),
    /outside the governed tenant scope/,
  );
});

test("readiness fails closed when Storage RLS hides the fixed sentinel", async () => {
  const client = {
    async send(command: unknown) {
      if (command instanceof GetObjectCommand) {
        throw Object.assign(new Error("hidden"), { $metadata: { httpStatusCode: 404 } });
      }
      if (command instanceof PutObjectCommand) {
        throw Object.assign(new Error("precondition"), { $metadata: { httpStatusCode: 412 } });
      }
      return {};
    },
    destroy() {},
  } as unknown as S3Client;
  const store = new S3RawIngestionObjectStore(ingestionConfig, client, {
    scope: { tenantId, connectionId, objectKey: key },
    authorizeSession: injectedScopeAuthorization,
  });
  await assert.rejects(() => store.ready(), /readiness object is not visible/);
});

test("ingestion treats 412 as an existing immutable object", async () => {
  const client = {
    async send(command: unknown) {
      if (command instanceof PutObjectCommand) {
        throw Object.assign(new Error("precondition"), { $metadata: { httpStatusCode: 412 } });
      }
      return {};
    },
    destroy() {},
  } as unknown as S3Client;
  const store = new S3RawIngestionObjectStore(ingestionConfig, client, {
    scope: { tenantId, connectionId, objectKey: key },
    authorizeSession: injectedScopeAuthorization,
  });
  assert.equal(await store.putIfAbsent({
    key,
    body: new Uint8Array([1]),
    contentType: "application/gzip",
    metadata: {},
  }), "exists");
});

test("unscoped machine adapters can probe readiness but cannot touch customer objects", async () => {
  const client = { async send() { return {}; }, destroy() {} } as unknown as S3Client;
  const ingestion = new S3RawIngestionObjectStore(ingestionConfig, client);
  const deletion = new S3RawDeletionObjectStore(deletionConfig, client);
  await assert.rejects(
    ingestion.putIfAbsent({
      key,
      body: new Uint8Array([1]),
      contentType: "application/gzip",
      metadata: {},
    }),
    /exact active session scope/,
  );
  await assert.rejects(
    deletion.listPrefix(`tenant/${tenantId}/connection/${connectionId}/`),
    /exact active session scope/,
  );
});

test("machine credential provider signs in once and refreshes short-lived JWT credentials", async () => {
  let now = Date.parse("2026-08-03T10:00:00.000Z");
  const calls: Array<{ grant: string; body: unknown }> = [];
  const userId = "10000000-0000-4000-8000-000000000001";
  const responseFor = (suffix: string) => new Response(JSON.stringify({
    access_token: jwt({
      sub: userId,
      session_id: "20000000-0000-4000-8000-000000000001",
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor((now + 120_000) / 1_000),
      app_metadata: {
        albert_machine_principal: true,
        albert_raw_storage_purpose: "sync",
      },
    }),
    refresh_token: `refresh-${suffix}`,
    expires_in: 120,
    user: { id: userId },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const provider = new SupabaseMachineSessionCredentialProvider(ingestionConfig, {
    now: () => now,
    fetch: async (input, init) => {
      const url = String(input);
      const grant = new URL(url).searchParams.get("grant_type") ?? "";
      calls.push({ grant, body: JSON.parse(String(init?.body)) as unknown });
      return responseFor(grant);
    },
  });
  const first = await provider.getCredentials();
  const cached = await provider.getCredentials();
  assert.equal(first.sessionToken, cached.sessionToken);
  assert.equal(first.accessKeyId, projectRef);
  assert.equal(first.secretAccessKey, legacyAnonKey);
  assert.deepEqual(calls.map((call) => call.grant), ["password"]);
  assert.deepEqual(calls[0]?.body, {
    email: ingestionConfig.machineEmail,
    password: ingestionConfig.machinePassword,
  });

  now += 70_000;
  await provider.getCredentials();
  assert.deepEqual(calls.map((call) => call.grant), ["password", "refresh_token"]);
  assert.deepEqual(calls[1]?.body, { refresh_token: "refresh-password" });
});

test("credential provider rejects a valid user JWT for the wrong machine purpose", async () => {
  const now = Date.parse("2026-08-03T10:00:00.000Z");
  const userId = "10000000-0000-4000-8000-000000000001";
  const provider = new SupabaseMachineSessionCredentialProvider(ingestionConfig, {
    now: () => now,
    fetch: async () => new Response(JSON.stringify({
      access_token: jwt({
        sub: userId,
        session_id: "20000000-0000-4000-8000-000000000001",
        role: "authenticated",
        aud: "authenticated",
        exp: Math.floor((now + 120_000) / 1_000),
        app_metadata: {
          albert_machine_principal: true,
          albert_raw_storage_purpose: "deletion",
        },
      }),
      refresh_token: "refresh-token",
      expires_in: 120,
      user: { id: userId },
    }), { status: 200 }),
  });
  await assert.rejects(
    () => provider.getCredentials(),
    /not bound to the expected machine purpose/,
  );
});

test("parallel exact scopes share one Auth login but authorize independently", async () => {
  const now = Date.parse("2026-08-03T10:00:00.000Z");
  const userId = "10000000-0000-4000-8000-000000000001";
  const sessionId = "20000000-0000-4000-8000-000000000001";
  let loginCount = 0;
  const pool = new SupabaseMachineSessionPool(ingestionConfig, {
    now: () => now,
    fetch: async () => {
      loginCount += 1;
      return new Response(JSON.stringify({
        access_token: jwt({
          sub: userId,
          session_id: sessionId,
          role: "authenticated",
          aud: "authenticated",
          exp: Math.floor((now + 300_000) / 1_000),
          app_metadata: {
            albert_machine_principal: true,
            albert_raw_storage_purpose: "sync",
          },
        }),
        refresh_token: "shared-refresh-token",
        expires_in: 300,
        user: { id: userId },
      }), { status: 200 });
    },
  });
  const authorizedScopes: string[] = [];
  const provider = (scope: string) => new SupabaseMachineSessionCredentialProvider(
    ingestionConfig,
    {
      now: () => now,
      sessionPool: pool,
      authorizeSession: async (identity) => {
        assert.equal(identity.sessionId, sessionId);
        authorizedScopes.push(scope);
        return { expiresAt: new Date(now + 120_000) };
      },
    },
  );

  const [left, right] = await Promise.all([
    provider("tenant-a/object-a").getCredentials(),
    provider("tenant-b/object-b").getCredentials(),
  ]);

  assert.equal(loginCount, 1);
  assert.equal(left.sessionToken, right.sessionToken);
  assert.deepEqual(authorizedScopes.sort(), ["tenant-a/object-a", "tenant-b/object-b"]);
});

test("webhook retries verify exact immutable bytes instead of accepting a key collision", async () => {
  let body: Uint8Array | undefined;
  const store = {
    async putIfAbsent(input: { body: Uint8Array }) { body = input.body; return "exists" as const; },
    async read() { return body ?? null; },
  };
  const writer = new WebhookRawWriter(store);
  const receipt = await writer.put({
    tenantId,
    connectionId,
    receiptId,
    connectorKey: "xero",
    receivedAt: "2026-08-03T10:00:00.000Z",
    body: new TextEncoder().encode("signed vendor bytes"),
  });
  assert.match(receipt.objectKey, /webhook_xero/);
  const conflicting = new WebhookRawWriter({
    async putIfAbsent() { return "exists" as const; },
    async read() { return new Uint8Array([0]); },
  });
  await assert.rejects(() => conflicting.put({
    tenantId,
    connectionId,
    receiptId,
    connectorKey: "xero",
    receivedAt: "2026-08-03T10:00:00.000Z",
    body: new TextEncoder().encode("different"),
  }), /webhook_raw_conflict/);
});

test("S3 configuration requires project/anon/password session coordinates", () => {
  const environment = {
    SUPABASE_STORAGE_S3_ENDPOINT: ingestionConfig.endpoint,
    SUPABASE_STORAGE_S3_REGION: ingestionConfig.region,
    SUPABASE_STORAGE_S3_ACCESS_KEY_ID: ingestionConfig.accessKeyId,
    SUPABASE_STORAGE_S3_LEGACY_ANON_KEY: ingestionConfig.legacyAnonKey,
    ALBERT_RAW_STORAGE_SYNC_PASSWORD: ingestionConfig.machinePassword,
  };
  assert.deepEqual(loadRawStorageS3Config(environment, {
    machinePurpose: "sync",
    passwordEnvironmentName: "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
  }), ingestionConfig);
  assert.throws(() => loadRawStorageS3Config({
    ...environment,
    SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "wrong-project-reference",
  }, {
    machinePurpose: "sync",
    passwordEnvironmentName: "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
  }), /project ref/);
  assert.throws(() => loadRawStorageS3Config({
    ...environment,
    SUPABASE_STORAGE_S3_LEGACY_ANON_KEY: "sb_publishable_not-supported",
  }, {
    machinePurpose: "sync",
    passwordEnvironmentName: "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
  }), /publishable keys/);
  assert.throws(() => loadRawStorageS3Config({
    ...environment,
    SUPABASE_STORAGE_S3_ENDPOINT: `https://${projectRef}.supabase.co`,
  }, {
    machinePurpose: "sync",
    passwordEnvironmentName: "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
  }), /S3 endpoint/);
});

test("local Supabase session credentials require the documented stub access key", () => {
  const local = loadRawStorageS3Config({
    SUPABASE_STORAGE_S3_ENDPOINT: "http://127.0.0.1:54321/storage/v1/s3",
    SUPABASE_STORAGE_S3_REGION: "local",
    SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "stub",
    SUPABASE_STORAGE_S3_LEGACY_ANON_KEY: jwt({ role: "anon", exp: 4_102_444_800 }),
    ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD: "webhook-machine-password-material-000001",
  }, {
    machinePurpose: "webhook",
    passwordEnvironmentName: "ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD",
  });
  assert.equal(local.authUrl, "http://127.0.0.1:54321");
  assert.equal(local.accessKeyId, "stub");
});
