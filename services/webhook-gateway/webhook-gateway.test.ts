import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { XeroWebhookValidationError } from "../../connectors/xero/webhooks.js";
import type { SupabaseWebhookRawWriter } from "../../packages/storage/src/index.js";
import { sealSecret } from "../../packages/security/src/index.js";
import { loadWebhookGatewayConfig, type WebhookGatewayConfig } from "./src/config.js";
import {
  DeputyWebhookVerifier,
  type ResolvedDeputyWebhook,
} from "./src/deputy.js";
import { WebhookGatewayHandler } from "./src/handler.js";
import type { WebhookStore } from "./src/store.js";

const ids = {
  tenantId: "01J00000000000000000000001",
  connectionId: "01J00000000000000000000002",
  receiptId: "01J00000000000000000000003",
  materialId: "01J00000000000000000000004",
};

const config: WebhookGatewayConfig = {
  controlPlaneDatabaseUrl: "postgresql://worker:secret@db.example/postgres",
  rawStorage: {
    endpoint:"https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3",
    authUrl:"https://abcdefghijklmnopqrst.supabase.co",
    region:"ap-southeast-2",
    accessKeyId:"abcdefghijklmnopqrst",
    legacyAnonKey:"eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature",
    machinePurpose:"webhook",
    machineEmail:"raw-storage-webhook@machine.albert.invalid",
    machinePassword:"webhook-machine-password-material-000001",
    bucket:"raw-payloads",
  },
  xeroWebhookSigningKey: "xero-webhook-key",
  xeroWebhookInboxKeyring: {
    currentKeyId: "xero-inbox-v1",
    currentKey: new Uint8Array(Buffer.alloc(32, 7)),
    keys: new Map([["xero-inbox-v1", new Uint8Array(Buffer.alloc(32, 7))]]),
  },
  xeroWebhookEncryptedRetentionDays: 3,
  xeroWebhookMetadataRetentionDays: 14,
  xeroWebhookPersistenceTimeoutMs: 3_500,
  webhookAttestationKeyId: "webhook-attestation-v1",
  webhookAttestationSecret: Buffer.alloc(32, 11).toString("base64url"),
  xeroWebhookProcessor: {
    workerId: "test-webhook-worker",
    leaseSeconds: 90,
    pollIntervalMs: 500,
    maxAttempts: 12,
    retryBaseSeconds: 5,
    retryMaxSeconds: 3_600,
  },
  deputyWebhookEncryptionKey: Buffer.alloc(32, 9).toString("base64url"),
  deputyWebhookEncryptionKeyId: "deputy-webhook-v1",
  deputyWebhookEncryptionKeys: new Map([
    ["deputy-webhook-v1", Buffer.alloc(32, 9).toString("base64url")],
  ]),
  deputyWebhookMaxSkewMs: 300_000,
  serviceVersion: "test",
  port: 8081,
};

function xeroBody() {
  return JSON.stringify({
    events: [{
      resourceUrl: "https://api.xero.com/api.xro/2.0/Invoices/717f2bfc-c6d4-41fd-b238-3f2f0c0cf777",
      resourceId: "717f2bfc-c6d4-41fd-b238-3f2f0c0cf777",
      eventDateUtc: "2026-08-03T10:00:00.000Z",
      eventType: "UPDATE",
      eventCategory: "INVOICE",
      tenantId: "c2cc9b6e-9458-4c7d-93cc-f02b81b0594f",
      tenantType: "ORGANISATION",
    }],
    firstEventSequence: 10,
    lastEventSequence: 10,
    entropy: "fixture",
  });
}

function dependencies(options: Readonly<{
  expectedStreams?: readonly string[];
  overrides?: Partial<Pick<WebhookStore,
    "reserve" | "attachRaw" | "finalize" | "markFailed"
  >>;
  xero?: Readonly<{
    accept(): Promise<Readonly<{
      inboxId: string;
      status: "pending";
      created: boolean;
      deliveryCount: number;
      intentToReceive: boolean;
    }>>;
  }>;
  deputy?: Readonly<{
    resolve(connectionId: string, materialId: string): Promise<ResolvedDeputyWebhook | null>;
    verify: DeputyWebhookVerifier["verify"];
  }>;
}> = {}) {
  const expectedStreams = options.expectedStreams ?? ["invoices"];
  const calls: string[] = [];
  const store = {
    async reserve() {
      calls.push("reserve");
      return {
        receiptId: ids.receiptId,
        status: "received" as const,
        rawObjectKey: null,
        duplicate: false,
        receivedAt: "2026-08-03T10:00:00.000Z",
      };
    },
    async attachRaw() { calls.push("attach"); },
    async finalize(input: { streams: readonly string[] }) {
      calls.push("finalize");
      assert.deepEqual(input.streams, expectedStreams);
      return input.streams.length;
    },
    async markFailed() { calls.push("failed"); },
    ...options.overrides,
  };
  const raw = {
    async put(input: { body: Uint8Array }) {
      calls.push("raw");
      return {
        objectKey: "tenant/raw.json.gz",
        bodySha256: createHash("sha256").update(input.body).digest("hex"),
        compressedBytes: 100,
      };
    },
  };
  return {
    calls,
    handler: new WebhookGatewayHandler({
      store,
      xero: options.xero ?? {
        async accept() {
          calls.push("xero_inbox");
          return {
            inboxId: ids.receiptId,
            status: "pending" as const,
            created: true,
            deliveryCount: 1,
            intentToReceive: false,
          };
        },
      },
      deputy: options.deputy ? {
        resolver: { resolve: options.deputy.resolve },
        verifier: { verify: options.deputy.verify },
      } : {
        resolver: { async resolve() { return null; } },
        verifier: { async verify() { throw new Error("deputy_verifier_not_configured"); } },
      },
      raw: raw as Pick<SupabaseWebhookRawWriter, "put">,
    }),
  };
}

test("gateway verifies Xero HMAC and durably acknowledges only after inbox persistence", async () => {
  const fixture = dependencies();
  const body = xeroBody();
  const signature = createHmac("sha256", config.xeroWebhookSigningKey)
    .update(body)
    .digest("base64");
  const response = await fixture.handler.handle(new Request("https://hooks.example/v1/webhooks/xero", {
    method: "POST",
    headers: { "content-type": "application/json", "x-xero-signature": signature },
    body,
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    accepted: true,
    queued: true,
    duplicate: false,
    intentToReceive: false,
  });
  assert.deepEqual(fixture.calls, ["xero_inbox"]);
});

test("gateway rejects an invalid Xero signature before tenant resolution", async () => {
  const fixture = dependencies({
    xero: {
      async accept() {
        throw new XeroWebhookValidationError("signature_invalid");
      },
    },
  });
  const response = await fixture.handler.handle(new Request("https://hooks.example/v1/webhooks/xero", {
    method: "POST",
    headers: { "content-type": "application/json", "x-xero-signature": "invalid" },
    body: xeroBody(),
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(fixture.calls, []);
});

async function deputyIngressFixture(options: Readonly<{
  connectionId?: string;
  customHeaderSecret?: string;
  enterpriseHmacKey?: string;
  reserve?: (input: { dedupeKey: string }) => Promise<{
    receiptId: string;
    status: "received" | "queued";
    rawObjectKey: null;
    duplicate: boolean;
    receivedAt: string;
  }>;
}> = {}) {
  const connectionId = options.connectionId ?? ids.connectionId;
  const customHeaderSecret = options.customHeaderSecret ?? "d".repeat(48);
  const callbackUrl = `https://hooks.example/v1/webhooks/deputy/${connectionId}/${ids.materialId}`;
  const material = {
    version: 1 as const,
    customHeaderSecret,
    ...(options.enterpriseHmacKey ? { enterpriseHmacKey: options.enterpriseHmacKey } : {}),
  };
  const envelope = await sealSecret({
    plaintext: JSON.stringify(material),
    encodedKey: config.deputyWebhookEncryptionKey,
    keyId: config.deputyWebhookEncryptionKeyId,
    associatedData: `albert:deputy-webhook:v1:${ids.tenantId}:${connectionId}:${ids.materialId}`,
  });
  const resolved: ResolvedDeputyWebhook = {
    tenantId: ids.tenantId,
    connectionId,
    connectorKey: "deputy",
    externalAccountReference: "demo.au.deputy.com",
    materialId: ids.materialId,
    materialVersion: 1,
    verificationMode: options.enterpriseHmacKey
      ? "custom_header_and_enterprise_hmac"
      : "custom_header",
    envelope,
    callbackUrl,
  };
  const now = Date.now();
  const verifier = new DeputyWebhookVerifier({
    encryptionKey: config.deputyWebhookEncryptionKey,
    keyId: config.deputyWebhookEncryptionKeyId,
    maxClockSkewMs: config.deputyWebhookMaxSkewMs,
    now: () => now,
  });
  return {
    ...dependencies({
      expectedStreams: ["timesheets"],
      ...(options.reserve ? { overrides: { reserve: options.reserve } } : {}),
      deputy: {
        async resolve(requestedConnectionId, requestedMaterialId) {
          return requestedConnectionId === connectionId && requestedMaterialId === ids.materialId
            ? resolved
            : null;
        },
        verify: verifier.verify.bind(verifier),
      },
    }),
    callbackUrl,
    customHeaderSecret,
    generationTime: String(Math.floor(now / 1_000)),
  };
}

test("gateway authenticates a connection-bound Deputy hook and routes its connection", async () => {
  const fixture = await deputyIngressFixture();
  const body = JSON.stringify({ topic: "Timesheet.Update", data: { Id: 501 } });
  const response = await fixture.handler.handle(new Request(
    fixture.callbackUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-albert-webhook-secret": fixture.customHeaderSecret,
        "x-deputy-generation-time": fixture.generationTime,
        "x-deputy-webhook-callback": fixture.callbackUrl,
      },
      body,
    },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true, routed: 1 });
  assert.deepEqual(fixture.calls, ["reserve", "raw", "attach", "finalize"]);
});

test("Deputy ingress rejects stale, forged, and cross-connection deliveries before persistence", async () => {
  const fixture = await deputyIngressFixture({ customHeaderSecret: "b".repeat(48) });
  const body = JSON.stringify({ topic: "Timesheet.Update", data: { Id: 501 } });
  const request = (url: string, secret: string, generationTime = fixture.generationTime) =>
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-albert-webhook-secret": secret,
        "x-deputy-generation-time": generationTime,
        "x-deputy-webhook-callback": fixture.callbackUrl,
      },
      body,
    });

  const forged = await fixture.handler.handle(request(fixture.callbackUrl, "a".repeat(48)));
  assert.equal(forged.status, 401);
  const stale = await fixture.handler.handle(request(
    fixture.callbackUrl,
    fixture.customHeaderSecret,
    String(Number(fixture.generationTime) - 601),
  ));
  assert.equal(stale.status, 401);
  const crossConnection = await fixture.handler.handle(request(
    `https://hooks.example/v1/webhooks/deputy/01J00000000000000000000009/${ids.materialId}`,
    fixture.customHeaderSecret,
  ));
  assert.equal(crossConnection.status, 404);
  assert.deepEqual(fixture.calls, []);
});

test("Deputy Enterprise mode requires the official raw-body HMAC as well as the connection secret", async () => {
  const enterpriseHmacKey = "enterprise-install-private-key";
  const fixture = await deputyIngressFixture({ enterpriseHmacKey });
  const body = JSON.stringify({ topic: "Timesheet.Update", data: { Id: 501 } });
  const baseHeaders = {
    "content-type": "application/json",
    "x-albert-webhook-secret": fixture.customHeaderSecret,
    "x-deputy-generation-time": fixture.generationTime,
    "x-deputy-webhook-callback": fixture.callbackUrl,
  };
  const rejected = await fixture.handler.handle(new Request(fixture.callbackUrl, {
    method: "POST",
    headers: { ...baseHeaders, "x-deputy-secret": "0".repeat(64) },
    body,
  }));
  assert.equal(rejected.status, 401);
  const accepted = await fixture.handler.handle(new Request(fixture.callbackUrl, {
    method: "POST",
    headers: {
      ...baseHeaders,
      "x-deputy-secret": createHmac("sha256", enterpriseHmacKey).update(body).digest("hex"),
    },
    body,
  }));
  assert.equal(accepted.status, 200);
});

test("Deputy replay identity is body-derived and a processed retry is not routed twice", async () => {
  const dedupeKeys: string[] = [];
  let reservation = 0;
  const fixture = await deputyIngressFixture({
    reserve: async (input) => {
      dedupeKeys.push(input.dedupeKey);
      reservation += 1;
      return {
        receiptId: ids.receiptId,
        status: reservation === 1 ? "received" : "queued",
        rawObjectKey: null,
        duplicate: reservation > 1,
        receivedAt: "2026-08-03T10:00:00.000Z",
      };
    },
  });
  const body = JSON.stringify({ topic: "Timesheet.Update", data: { Id: 501 } });
  const deliver = (requestId: string) => fixture.handler.handle(new Request(fixture.callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      "x-albert-webhook-secret": fixture.customHeaderSecret,
      "x-deputy-generation-time": fixture.generationTime,
      "x-deputy-webhook-callback": fixture.callbackUrl,
    },
    body,
  }));
  assert.equal((await deliver("mutable-request-a")).status, 200);
  const replay = await deliver("mutable-request-b");
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { accepted: true, routed: 0 });
  assert.equal(dedupeKeys.length, 2);
  assert.equal(dedupeKeys[0], dedupeKeys[1]);
  assert.deepEqual(fixture.calls, ["raw", "attach", "finalize"]);
});

test("gateway configuration fails closed without the Deputy webhook-only encryption key", () => {
  const source: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    CONTROL_PLANE_DATABASE_URL:
      "postgresql://albert_webhook_control_runtime.abcdefghijklmnopqrst:secret@control.example/postgres?sslmode=require",
    ALBERT_CONTROL_PLANE_PROJECT_REF: "abcdefghijklmnopqrst",
    ALBERT_CONTROL_PLANE_REGION: "ap-southeast-2",
    SUPABASE_STORAGE_S3_ENDPOINT:
      "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3",
    SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
    SUPABASE_STORAGE_S3_ACCESS_KEY_ID: config.rawStorage.accessKeyId,
    SUPABASE_STORAGE_S3_LEGACY_ANON_KEY: config.rawStorage.legacyAnonKey,
    ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD: config.rawStorage.machinePassword,
    XERO_WEBHOOK_SIGNING_KEY: config.xeroWebhookSigningKey,
    WEBHOOK_INBOX_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    WEBHOOK_INBOX_ENCRYPTION_KEY_ID: "xero-inbox-v1",
    WEBHOOK_ATTESTATION_KEY_ID: config.webhookAttestationKeyId,
    WEBHOOK_ATTESTATION_SECRET: config.webhookAttestationSecret,
    ALBERT_WEBHOOK_WORKER_ID: "test-webhook-worker",
    FLY_MACHINE_ID: "90801abcdef123",
    ALBERT_SERVICE_VERSION: "a".repeat(40),
    ALBERT_DEPLOYMENT_ID: "test-deployment-1",
  };
  assert.throws(() => loadWebhookGatewayConfig(source), /DEPUTY_WEBHOOK_ENCRYPTION_KEY/);
});
