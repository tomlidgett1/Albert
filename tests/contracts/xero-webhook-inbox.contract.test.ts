import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  partitionXeroWebhook,
  verifyAndParseXeroWebhook,
  XERO_WEBHOOK_MAX_BODY_BYTES,
  XeroWebhookValidationError,
  type XeroWebhookPayload,
} from "../../connectors/xero/webhooks.js";
import type { WebhookConnection } from "../../services/webhook-gateway/src/store.js";
import {
  decryptXeroWebhookBody,
  encryptXeroWebhookBody,
  loadXeroWebhookInboxKeyring,
} from "../../services/webhook-gateway/src/xero-crypto.js";
import {
  XeroWebhookInboxStore,
  XeroWebhookIngress,
} from "../../services/webhook-gateway/src/xero-inbox.js";
import { XeroWebhookProcessor } from "../../services/webhook-gateway/src/xero-processor.js";

const ids = Object.freeze({
  tenantA: "c2cc9b6e-9458-4c7d-93cc-f02b81b0594f",
  tenantB: "aef86862-2015-4b6b-88bc-d89032cecc50",
  application: "84a762be-69b3-4f16-91d0-b80eb073e22e",
  eventA: "717f2bfc-c6d4-41fd-b238-3f2f0c0cf777",
  eventB: "55d84274-a3da-4829-a7c0-0cab601b95cc",
  eventC: "8a27f316-69b7-47d3-97b1-76fe251a7ea6",
  subscription: "5426f152-4490-4b16-b6ed-ea47f0ef1bfd",
  albertTenant: "01J00000000000000000000001",
  connection: "01J00000000000000000000002",
  inbox: "01J00000000000000000000003",
  receiptA: "01J00000000000000000000004",
  receiptB: "01J00000000000000000000005",
});

const signingKey = "xero-official-webhook-key-fixture";
const encodedInboxKey = Buffer.alloc(32, 17).toString("base64url");
const keyring = loadXeroWebhookInboxKeyring({
  WEBHOOK_INBOX_ENCRYPTION_KEY_ID: "xero-inbox-v1",
  WEBHOOK_INBOX_ENCRYPTION_KEY: encodedInboxKey,
});

function payload(): XeroWebhookPayload {
  return {
    events: [
      {
        resourceUrl: `https://api.xero.com/api.xro/2.0/Invoices/${ids.eventA}`,
        resourceId: ids.eventA,
        eventDateUtc: "2026-08-03T10:00:00.000Z",
        eventType: "UPDATE",
        eventCategory: "INVOICE",
        tenantId: ids.tenantA,
        tenantType: "ORGANISATION",
      },
      {
        resourceUrl: `https://api.xero.com/api.xro/2.0/Contacts/${ids.eventB}`,
        resourceId: ids.eventB,
        eventDateUtc: "2026-08-03T10:00:01.000Z",
        eventType: "CREATE",
        eventCategory: "CONTACT",
        tenantId: ids.tenantA,
        tenantType: "ORGANISATION",
      },
      {
        resourceUrl: `https://api.xero.com/api.xro/2.0/CreditNotes/${ids.eventC}`,
        resourceId: ids.eventC,
        eventDateUtc: "2026-08-03T10:00:02.000Z",
        eventType: "UPDATE",
        eventCategory: "CREDITNOTE",
        tenantId: ids.tenantB,
        tenantType: "ORGANISATION",
        data: { Type: "ACCRECCREDIT", Status: "AUTHORISED" },
      },
      {
        resourceUrl: `https://api.xero.com/appstore/subscriptions/${ids.subscription}`,
        resourceId: ids.subscription,
        eventDateUtc: "2026-08-03T10:00:03.000Z",
        eventType: "UPDATE",
        eventCategory: "SUBSCRIPTION",
        tenantId: ids.application,
        tenantType: "APPLICATION",
      },
    ],
    firstEventSequence: 20,
    lastEventSequence: 23,
    entropy: "official-schema-fixture",
  };
}

function body(value: unknown = payload()): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function signature(value: Uint8Array): string {
  return createHmac("sha256", signingKey).update(value).digest("base64");
}

test("Xero verification uses exact bytes and partitions organisations and categories before routing", () => {
  const exact = body();
  const parsed = verifyAndParseXeroWebhook(exact, signature(exact), signingKey);
  const partitions = partitionXeroWebhook(parsed);
  assert.deepEqual(
    partitions.map((partition) => [partition.xeroTenantId, partition.category, partition.stream]),
    [
      [ids.tenantB, "CREDITNOTE", "credit_notes"],
      [ids.tenantA, "CONTACT", "contacts"],
      [ids.tenantA, "INVOICE", "invoices"],
    ].sort((left, right) => String(left).localeCompare(String(right))),
  );
  for (const partition of partitions) {
    assert.ok(partition.events.every((event) => event.tenantId === partition.xeroTenantId));
    assert.ok(partition.events.every((event) => event.eventCategory === partition.category));
  }
  const reformatted = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(exact)), null, 2));
  assert.throws(
    () => verifyAndParseXeroWebhook(reformatted, signature(exact), signingKey),
    (error) => error instanceof XeroWebhookValidationError && error.code === "signature_invalid",
  );
});

test("Xero rejects malformed signatures and invalid current webhook schemas", () => {
  const exact = body();
  const oversized = new Uint8Array(XERO_WEBHOOK_MAX_BODY_BYTES + 1);
  assert.throws(
    () => verifyAndParseXeroWebhook(oversized, signature(oversized), signingKey),
    (error) => error instanceof XeroWebhookValidationError && error.code === "payload_too_large",
  );
  assert.throws(
    () => verifyAndParseXeroWebhook(exact, "not-base64", signingKey),
    (error) => error instanceof XeroWebhookValidationError && error.code === "signature_invalid",
  );
  const invalid = body({ ...payload(), firstEventSequence: 0 });
  assert.throws(
    () => verifyAndParseXeroWebhook(invalid, signature(invalid), signingKey),
    (error) => error instanceof XeroWebhookValidationError && error.code === "payload_invalid",
  );
  const invalidDate = payload();
  const invalidDateBody = body({
    ...invalidDate,
    events: invalidDate.events.map((event, index) =>
      index === 0 ? { ...event, eventDateUtc: "not-an-rfc3339-date" } : event
    ),
  });
  assert.throws(
    () => verifyAndParseXeroWebhook(invalidDateBody, signature(invalidDateBody), signingKey),
    (error) => error instanceof XeroWebhookValidationError && error.code === "payload_invalid",
  );
  const invalidCredit = payload();
  const creditBody = body({
    ...invalidCredit,
    events: invalidCredit.events.map((event) =>
      event.eventCategory === "CREDITNOTE" ? { ...event, data: { Type: "UNKNOWN" } } : event
    ),
  });
  assert.throws(
    () => verifyAndParseXeroWebhook(creditBody, signature(creditBody), signingKey),
    (error) => error instanceof XeroWebhookValidationError && error.code === "payload_invalid",
  );
});

test("Xero inbox encryption is authenticated, key-versioned, and requires an exact 32-byte base64url key", () => {
  assert.throws(() => loadXeroWebhookInboxKeyring({
    WEBHOOK_INBOX_ENCRYPTION_KEY_ID: "xero-inbox-v1",
    WEBHOOK_INBOX_ENCRYPTION_KEY: `${encodedInboxKey}=`,
  }), /unpadded base64url-encoded 32-byte/);
  assert.throws(() => loadXeroWebhookInboxKeyring({
    WEBHOOK_INBOX_ENCRYPTION_KEY_ID: "xero-inbox-v2",
    WEBHOOK_INBOX_ENCRYPTION_KEY: encodedInboxKey,
    WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
      "xero-inbox-v1": encodedInboxKey,
    }),
  }), /must not reuse key material/);
  const exact = body();
  const digest = createHash("sha256").update(exact).digest("hex");
  const encrypted = encryptXeroWebhookBody({
    inboxId: ids.inbox,
    bodySha256: digest,
    body: exact,
    keyring,
  });
  assert.equal(Buffer.from(encrypted.ciphertext).includes(Buffer.from("tenantId")), false);
  assert.deepEqual(decryptXeroWebhookBody({
    inboxId: ids.inbox,
    keyId: encrypted.keyId,
    bodySha256: digest,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    authTag: encrypted.authTag,
    keyring,
  }), exact);
  const tampered = new Uint8Array(encrypted.ciphertext);
  tampered[0] = (tampered[0] ?? 0) ^ 1;
  assert.throws(() => decryptXeroWebhookBody({
    inboxId: ids.inbox,
    keyId: encrypted.keyId,
    bodySha256: digest,
    nonce: encrypted.nonce,
    ciphertext: tampered,
    authTag: encrypted.authTag,
    keyring,
  }), /ciphertext_invalid/);
});

test("Xero HTTP ingress commits only an encrypted tenant-neutral item before acknowledgement", async () => {
  const exact = body();
  const persisted: Array<Parameters<XeroWebhookInboxStore["accept"]>[0]> = [];
  const ingress = new XeroWebhookIngress({
    signingKey,
    keyring,
    encryptedRetentionDays: 3,
    metadataRetentionDays: 14,
    persistenceTimeoutMs: 3_500,
  }, {
    async accept(input) {
      persisted.push(input);
      return {
        inboxId: input.inboxId,
        status: "pending",
        created: true,
        deliveryCount: 1,
      };
    },
  }, () => Date.parse("2026-08-03T10:01:00.000Z"), () => ids.inbox);
  const accepted = await ingress.accept(exact, signature(exact));
  assert.equal(accepted.created, true);
  assert.equal(accepted.intentToReceive, false);
  const stored = persisted[0];
  assert.ok(stored);
  assert.equal("tenantId" in stored, false);
  assert.equal("connectionId" in stored, false);
  assert.equal(Buffer.from(stored.ciphertext).includes(Buffer.from(ids.tenantA)), false);
  assert.equal(stored.expiresAt, "2026-08-06T10:01:00.000Z");
  assert.equal(stored.retainUntil, "2026-08-17T10:01:00.000Z");
});

test("leased Xero processing routes only matching tenant/category partitions and enqueues gap recovery", async () => {
  const exact = body();
  const digest = createHash("sha256").update(exact).digest("hex");
  const encrypted = encryptXeroWebhookBody({
    inboxId: ids.inbox,
    bodySha256: digest,
    body: exact,
    keyring,
  });
  const controller = new AbortController();
  let claimed = false;
  let gapSweeps = 0;
  let summary: Readonly<Record<string, string | number>> | null = null;
  const connection: WebhookConnection = {
    tenantId: ids.albertTenant,
    connectionId: ids.connection,
    connectorKey: "xero",
    externalAccountReference: ids.tenantA,
  };
  const recordedConnections: readonly string[][] = [];
  const routedBodies: unknown[] = [];
  let receiptIndex = 0;
  const inbox = {
    async claim() {
      if (claimed) return null;
      claimed = true;
      return {
        inboxId: ids.inbox,
        bodySha256: digest,
        encryptionKeyId: encrypted.keyId,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        authTag: encrypted.authTag,
        bodyBytes: exact.byteLength,
        firstEventSequence: 20,
        lastEventSequence: 23,
        eventCount: 4,
        firstReceivedAt: "2026-08-03T10:01:00.000Z",
        attemptCount: 1,
        leaseToken: "A".repeat(22),
        leaseVersion: 1,
      };
    },
    async renew(
      inboxId: string,
      workerId: string,
      leaseToken: string,
      leaseVersion: number,
    ) {
      assert.equal(inboxId, ids.inbox);
      assert.equal(workerId, "xero-test-worker");
      assert.equal(leaseToken, "A".repeat(22));
      assert.equal(leaseVersion, 1);
      return true;
    },
    async recordSequence(
      inboxId: string,
      workerId: string,
      leaseToken: string,
      leaseVersion: number,
    ): Promise<XeroSequenceObservationFixture> {
      assert.equal(inboxId, ids.inbox);
      assert.equal(workerId, "xero-test-worker");
      assert.equal(leaseToken, "A".repeat(22));
      assert.equal(leaseVersion, 1);
      return {
        disposition: "gap",
        gapId: "01J00000000000000000000006",
        gapFirstSequence: 18,
        gapLastSequence: 19,
      };
    },
    async enqueueGapSweeps(
      _gapId: string,
      _inboxId: string,
      _workerId: string,
      leaseToken: string,
      leaseVersion: number,
    ) {
      assert.equal(leaseToken, "A".repeat(22));
      assert.equal(leaseVersion, 1);
      gapSweeps += 1;
      return 6;
    },
    async recordConnection(input: {
      streams: readonly string[];
      leaseToken: string;
      leaseVersion: number;
    }) {
      assert.equal(input.leaseToken, "A".repeat(22));
      assert.equal(input.leaseVersion, 1);
      (recordedConnections as string[][]).push([...input.streams]);
    },
    async complete(
      _inboxId: string,
      _workerId: string,
      _leaseToken: string,
      _leaseVersion: number,
      value: Readonly<Record<string, string | number>>,
    ) {
      assert.equal(_leaseToken, "A".repeat(22));
      assert.equal(_leaseVersion, 1);
      summary = value;
      controller.abort();
    },
    async fail() { throw new Error("unexpected_failure"); },
    async purge() { return 0; },
    async health() {
      return {
        pendingCount: 0, processingCount: 1, retryCount: 0,
        failedCount: 0, expiredCount: 0, oldestUnprocessedAt: null,
        activeKeyIds: [encrypted.keyId],
      };
    },
  };
  const routes = {
    async resolveXero(externalIds: readonly string[]) {
      assert.deepEqual([...externalIds].sort(), [ids.tenantA, ids.tenantB].sort());
      return [connection];
    },
    async reserve(input: { leaseToken?: string; leaseVersion?: number }) {
      assert.equal(input.leaseToken, "A".repeat(22));
      assert.equal(input.leaseVersion, 1);
      const receiptId = receiptIndex++ === 0 ? ids.receiptA : ids.receiptB;
      return {
        receiptId,
        status: "received" as const,
        rawObjectKey: null,
        duplicate: false,
        receivedAt: "2026-08-03T10:01:00.000Z",
      };
    },
    async attachRaw(
      _connection: WebhookConnection,
      _receiptId: string,
      _objectKey: string,
      _verificationReference: string,
      _workerId: string,
      leaseToken: string,
      leaseVersion: number,
    ) {
      assert.equal(leaseToken, "A".repeat(22));
      assert.equal(leaseVersion, 1);
    },
    async finalizeXero(input: { leaseToken: string; leaseVersion: number }) {
      assert.equal(input.leaseToken, "A".repeat(22));
      assert.equal(input.leaseVersion, 1);
      return true;
    },
    async markFailed() {},
  };
  const raw = {
    async put(input: { body: Uint8Array }) {
      const routed = JSON.parse(new TextDecoder().decode(input.body)) as {
        xeroTenantId: string;
        category: string;
        events: readonly { tenantId: string; eventCategory: string }[];
      };
      assert.equal(routed.xeroTenantId, ids.tenantA);
      assert.ok(routed.events.every((event) => event.tenantId === ids.tenantA));
      assert.ok(routed.events.every((event) => event.eventCategory === routed.category));
      routedBodies.push(routed);
      return {
        objectKey: `tenant/${ids.albertTenant}/connection/${ids.connection}/stream/webhook_xero/date/2026-08-03/batch-${receiptIndex}.json.gz`,
        bodySha256: createHash("sha256").update(input.body).digest("hex"),
        compressedBytes: 100,
      };
    },
  };
  const processor = new XeroWebhookProcessor({
    config: {
      workerId: "xero-test-worker",
      keyring,
      leaseSeconds: 30,
      pollIntervalMs: 100,
      maxAttempts: 3,
      retryBaseSeconds: 1,
      retryMaxSeconds: 5,
      serviceVersion: "test",
    },
    inbox,
    routes,
    raw,
  });
  await processor.run(controller.signal);
  assert.equal(gapSweeps, 1);
  assert.equal(routedBodies.length, 2);
  assert.deepEqual(recordedConnections, [["contacts", "invoices"]]);
  assert.deepEqual(summary, {
    partitionCount: 3,
    matchedConnectionCount: 1,
    routedStreamCount: 2,
    unmatchedPartitionCount: 1,
    ignoredEventCount: 1,
    sequenceDisposition: "gap",
    gapRecoveryCount: 6,
  });
});

type XeroSequenceObservationFixture = Readonly<{
  disposition: "gap";
  gapId: string;
  gapFirstSequence: number;
  gapLastSequence: number;
}>;

test("migration provides bounded leases, idempotent sequences, fixed routing and least privilege", async () => {
  const migration = await readFile(
    new URL("../../infra/migrations/control-plane/0010_xero_webhook_inbox.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /ciphertext\s+bytea[\s\S]*octet_length\(ciphertext\)\s*=\s*body_bytes/i);
  assert.match(migration, /body_bytes\s+integer[\s\S]*between\s+1\s+and\s+1048576/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /lease_expires_at/i);
  assert.match(migration, /delivery_count\s*=\s*item\.delivery_count\s*\+\s*1/i);
  assert.match(migration, /'gap'[\s\S]*missing_first_sequence[\s\S]*missing_last_sequence/i);
  assert.match(migration, /'ReconciliationSweep'[\s\S]*'xero-gap:'/i);
  assert.match(migration, /enqueue_xero_webhook_incremental/i);
  assert.match(migration, /status\s*=\s*'processed'[\s\S]*ciphertext\s*=\s*null/i);
  assert.match(migration, /status\s*=\s*'expired'[\s\S]*ciphertext\s*=\s*null[\s\S]*status\s+in\s*\('pending',\s*'processing',\s*'retry_wait',\s*'failed'\)/i);
  assert.match(migration, /revoke\s+select\s+on\s+table[\s\S]*oauth_token_refs[\s\S]*from\s+albert_webhook_control/i);
  assert.match(migration, /revoke\s+execute\s+on\s+function\s+control_plane\.enqueue_sync_job[\s\S]*from\s+public,\s*albert_webhook_control/i);
  assert.doesNotMatch(migration, /grant[^;]+oauth_(?:token_refs|secret_envelopes)[^;]+albert_webhook_control/i);
  assert.doesNotMatch(migration, /grant[^;]+service_role/i);
});

test("retention hardening erases terminal payloads and caps all Xero inbox data below 30 days", async () => {
  const [migration, bootstrap, legacyAdminUpgrade, managedPostgresUpgrade] = await Promise.all([
    readFile(new URL(
      "../../infra/migrations/control-plane/0035_m8_xero_webhook_retention_hardening.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL("../../infra/bootstrap/control_plane_role.sql", import.meta.url), "utf8"),
    readFile(new URL(
      "../../infra/bootstrap-upgrades/control-plane/0001_xero_inbox_retention_cron.sql",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../../infra/bootstrap-upgrades/control-plane/0003_managed_postgres_cron_identity.sql",
      import.meta.url,
    ), "utf8"),
  ]);
  assert.match(migration, /expires_at\s*>=\s*first_received_at\s*\+\s*interval\s*'1 day'/i);
  assert.match(migration, /expires_at\s*<=\s*first_received_at\s*\+\s*interval\s*'7 days'/i);
  assert.match(migration, /retain_until\s*<=\s*first_received_at\s*\+\s*interval\s*'30 days'/i);
  assert.match(
    migration,
    /next_status\s+in\s*\('expired',\s*'failed'\)[\s\S]*then\s+null/i,
  );
  assert.match(migration, /lease_expires_at\s*>\s*clock_timestamp\(\)/i);
  assert.match(
    migration,
    /active_key_ids[\s\S]*filter\s*\(where status in \('pending',\s*'processing',\s*'retry_wait'\)\)/i,
  );
  assert.match(migration, /albert_install_xero_inbox_retention_cron_job/u);
  assert.match(
    legacyAdminUpgrade,
    /albert-xero-inbox-retention[\s\S]*\* \* \* \* \*[\s\S]*purge_xero_webhook_inbox\(5000\)[\s\S]*'postgres'/u,
  );
  assert.match(
    managedPostgresUpgrade,
    /albert-xero-inbox-retention[\s\S]*\* \* \* \* \*[\s\S]*purge_xero_webhook_inbox\(5000\)[\s\S]*current_database\(\),\s*NULL/u,
  );
  assert.doesNotMatch(bootstrap, /albert_install_xero_inbox_retention_cron_job/u);
});
