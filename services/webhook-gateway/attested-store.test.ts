import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PostgresQueryClient } from "../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "../sync-workers/src/database.js";
import { createWebhookAttestor } from "./src/attestation.js";
import { DeputyWebhookResolver } from "./src/deputy.js";
import { WebhookStore } from "./src/store.js";
import { XeroWebhookInboxStore } from "./src/xero-inbox.js";

const tenantId = "01J00000000000000000000001";
const connectionId = "01J00000000000000000000002";
const inboxId = "01J00000000000000000000003";
const receiptId = "01J00000000000000000000004";
const materialId = "01J00000000000000000000005";
const workerId = "gateway-worker-1";
const leaseToken = "A".repeat(22);
const leaseVersion = 7;
const receivedAt = "2026-08-03T10:00:00.000Z";

type RecordedCall = Readonly<{ sql: string; values: readonly unknown[] }>;

class AttestedDatabase implements TransactionalPostgres {
  readonly calls: RecordedCall[] = [];

  async transaction<T>(work: (client: PostgresQueryClient) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<Readonly<{ rows: readonly Row[] }>> {
    this.calls.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
    const row = (value: Record<string, unknown>): Readonly<{ rows: readonly Row[] }> => ({
      rows: [value as Row],
    });
    if (sql.includes("accept_attested_xero_webhook_inbox")) {
      return row({ inbox_id: inboxId, status: "pending", created: true, delivery_count: 1 });
    }
    if (sql.includes("claim_attested_xero_webhook_inbox")) {
      return row({
        inbox_id: inboxId,
        body_sha256: "b".repeat(64),
        encryption_key_id: "xero-inbox-v1",
        nonce: Buffer.alloc(12, 1),
        ciphertext: Buffer.alloc(8, 2),
        auth_tag: Buffer.alloc(16, 3),
        body_bytes: 8,
        first_event_sequence: 10,
        last_event_sequence: 11,
        event_count: 2,
        first_received_at: receivedAt,
        attempt_count: 1,
        lease_token: leaseToken,
        lease_version: leaseVersion,
      });
    }
    if (sql.includes("renew_attested_xero_webhook_inbox_lease")) return row({ renewed: true });
    if (sql.includes("record_attested_xero_webhook_sequence")) {
      return row({ disposition: "contiguous", gap_id: null, gap_first_sequence: null, gap_last_sequence: null });
    }
    if (sql.includes("enqueue_attested_xero_webhook_gap_sweeps")) return row({ count: 3 });
    if (sql.includes("fail_attested_xero_webhook_inbox")) return row({ status: "retry_wait" });
    if (sql.includes("attested_xero_webhook_inbox_health")) {
      return row({
        pending_count: 1,
        processing_count: 1,
        retry_count: 0,
        failed_count: 0,
        expired_count: 0,
        oldest_unprocessed_at: receivedAt,
        active_key_ids: ["xero-inbox-v1"],
      });
    }
    if (sql.includes("resolve_attested_xero_webhook_connections")) {
      return row({
        tenant_id: tenantId,
        connection_id: connectionId,
        connector_key: "xero",
        external_account_reference: "xero-tenant-1",
      });
    }
    if (sql.includes("reserve_attested_webhook_receipt")) {
      return row({
        webhook_receipt_id: receiptId,
        status: "received",
        raw_object_key: null,
        duplicate: false,
        received_at: receivedAt,
      });
    }
    if (sql.includes("attach_attested_webhook_raw")) return row({ attached: true });
    if (sql.includes("enqueue_attested_xero_webhook_incremental")) return row({ enqueued: true });
    if (sql.includes("resolve_attested_deputy_webhook_material")) {
      return row({
        tenant_id: tenantId,
        connection_id: connectionId,
        connector_key: "deputy",
        external_account_reference: "tenant.au.deputy.com",
        material_id: materialId,
        material_version: 1,
        verification_mode: "custom_header",
        envelope_version: 1,
        algorithm: "A256GCM",
        key_id: "deputy-key-v1",
        iv: "iv",
        ciphertext: "ciphertext",
        callback_url: `https://hooks.example/v1/webhooks/deputy/${connectionId}/${materialId}`,
      });
    }
    return { rows: [] };
  }
}

function attestor() {
  let nonce = 0;
  return createWebhookAttestor({
    keyId: "webhook-v1",
    encodedSecret: Buffer.alloc(32, 11).toString("base64url"),
    now: () => Date.parse(receivedAt),
    nonce: () => Buffer.alloc(16, ++nonce).toString("base64url"),
  });
}

function documents(db: AttestedDatabase): readonly Record<string, unknown>[] {
  return db.calls.map((call) => {
    assert.equal(typeof call.values[0], "string");
    assert.equal(typeof call.values[1], "number");
    assert.match(String(call.values[2]), /^[A-Za-z0-9_-]{22}$/u);
    assert.equal(call.values[3], "webhook-v1");
    assert.match(String(call.values[4]), /^[0-9a-f]{64}$/u);
    return JSON.parse(String(call.values[0])) as Record<string, unknown>;
  });
}

test("every Xero inbox action is independently attested and stale-writer fenced", async () => {
  const db = new AttestedDatabase();
  const store = new XeroWebhookInboxStore(db, attestor());
  const bodyNonce = new Uint8Array(12).fill(1);
  const ciphertext = new Uint8Array(8).fill(2);
  const authTag = new Uint8Array(16).fill(3);

  await store.accept({
    inboxId,
    bodySha256: "b".repeat(64),
    encryptionKeyId: "xero-inbox-v1",
    nonce: bodyNonce,
    ciphertext,
    authTag,
    bodyBytes: ciphertext.byteLength,
    firstEventSequence: 10,
    lastEventSequence: 11,
    eventCount: 2,
    receivedAt,
    expiresAt: "2026-08-06T10:00:00.000Z",
    retainUntil: "2026-08-17T10:00:00.000Z",
  });
  const claim = await store.claim(workerId, 90);
  assert.equal(claim?.leaseToken, leaseToken);
  assert.equal(claim?.leaseVersion, leaseVersion);
  await store.renew(inboxId, workerId, leaseToken, leaseVersion, 90);
  await store.recordSequence(inboxId, workerId, leaseToken, leaseVersion);
  await store.recordConnection({
    tenantId,
    connectionId,
    inboxId,
    workerId,
    leaseToken,
    leaseVersion,
    streams: ["invoices"],
  });
  await store.enqueueGapSweeps(
    "01J00000000000000000000006",
    inboxId,
    workerId,
    leaseToken,
    leaseVersion,
    receivedAt,
  );
  await store.complete(inboxId, workerId, leaseToken, leaseVersion, {
    partitionCount: 1,
    matchedConnectionCount: 1,
    routedStreamCount: 1,
    unmatchedPartitionCount: 0,
    ignoredEventCount: 0,
    sequenceDisposition: "contiguous",
    gapRecoveryCount: 0,
  });
  await store.fail({
    inboxId,
    workerId,
    leaseToken,
    leaseVersion,
    errorCode: "temporary_failure",
    retryDelaySeconds: 30,
    maxAttempts: 5,
    permanent: false,
  });
  await store.health();

  const proofDocuments = documents(db);
  assert.deepEqual(
    proofDocuments.map((document) => document.operation),
    [
      "xero.accept",
      "xero.claim",
      "xero.renew",
      "xero.sequence",
      "xero.connection",
      "xero.gap",
      "xero.complete",
      "xero.fail",
      "xero.health",
    ],
  );
  const accepted = proofDocuments[0]!;
  assert.equal(accepted.ciphertextSha256, createHash("sha256").update(ciphertext).digest("hex"));
  assert.equal(JSON.stringify(accepted).includes(Buffer.from(ciphertext).toString("hex")), false);
  for (const document of proofDocuments.slice(2, 8)) {
    assert.equal(document.workerId, workerId);
    assert.equal(document.leaseToken, leaseToken);
    assert.equal(document.leaseVersion, leaseVersion);
  }
});

test("connection resolution and every Xero receipt mutation use proof-gated RPCs", async () => {
  const db = new AttestedDatabase();
  const signer = attestor();
  const store = new WebhookStore(db, signer);
  const connection = {
    tenantId,
    connectionId,
    connectorKey: "xero" as const,
    externalAccountReference: "xero-tenant-1",
  };
  await store.resolveXero(["xero-tenant-1"]);
  const reserved = await store.reserve({
    connection,
    dedupeKey: `xero:${inboxId}:invoices`,
    vendorEventId: inboxId,
    bodySha256: "c".repeat(64),
    verificationReference: inboxId,
    leaseOwner: workerId,
    leaseToken,
    leaseVersion,
    safeHeaders: { source_body_sha256: "b".repeat(64), inbox_key_id: "xero-inbox-v1" },
    receivedAt,
  });
  assert.equal(reserved.receiptId, receiptId);
  await store.attachRaw(
    connection,
    receiptId,
    `tenant/${tenantId}/connection/${connectionId}/stream/webhook_xero/date/2026-08-03/batch-${receiptId}.json.gz`,
    inboxId,
    workerId,
    leaseToken,
    leaseVersion,
  );
  await store.finalizeXero({
    connection,
    inboxId,
    receiptId,
    stream: "invoices",
    receivedAt,
    workerId,
    leaseToken,
    leaseVersion,
  });
  await store.markFailed(connection, receiptId, inboxId, workerId, leaseToken, leaseVersion);

  assert.ok(db.calls.every((call) => /_attested_|attested_/u.test(call.sql)));
  for (const document of documents(db).slice(1)) {
    assert.equal(document.leaseToken, leaseToken);
    assert.equal(document.leaseVersion, leaseVersion);
  }
});

test("Deputy verifier material resolution requires an independent edge proof", async () => {
  const db = new AttestedDatabase();
  const resolved = await new DeputyWebhookResolver(db, attestor()).resolve(connectionId, materialId);
  assert.equal(resolved?.materialId, materialId);
  assert.match(db.calls[0]!.sql, /resolve_attested_deputy_webhook_material/u);
  assert.deepEqual(documents(db)[0], {
    version: 1,
    operation: "deputy.resolve",
    connectionId,
    materialId,
  });
});
