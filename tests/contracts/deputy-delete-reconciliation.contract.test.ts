import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { mapDeputyCanonical } from "../../connectors/deputy/canonical.js";
import { deputyManifest } from "../../connectors/deputy/manifest.js";
import { parseDeputyWebhook } from "../../connectors/deputy/webhooks.js";
import type { PostgresQueryClient } from "../../packages/queue/src/index.js";
import { parseSyncJob } from "../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "../../services/sync-workers/src/database.js";
import { prepareTypedStaging, upsertTypedStagingRecord } from "../../services/sync-workers/src/typed-staging.js";
import { appendVerifiedWebhookTombstones } from "../../services/sync-workers/src/webhook-tombstones.js";
import { WebhookStore } from "../../services/webhook-gateway/src/store.js";
import { createWebhookAttestor } from "../../services/webhook-gateway/src/attestation.js";

const root = new URL("../../", import.meta.url);
const tenantId = "01J00000000000000000000001";
const connectionId = "01J00000000000000000000002";
const receiptId = "01J00000000000000000000003";
const syncRunId = "01J00000000000000000000004";
const batchId = "01J00000000000000000000005";
const jobRequestId = "01J00000000000000000000006";
const callbackUrl = `https://hooks.albert.example/v1/webhooks/deputy/${connectionId}/${receiptId}`;
const customHeaderSecret = "deputy-delete-connection-secret-".repeat(2);
const observedAt = "2026-08-03T10:00:00.000Z";

function deleteEvent(data: unknown) {
  return {
    id: "untrusted-delivery-id",
    receivedAt: observedAt,
    headers: {
      "x-albert-webhook-secret": customHeaderSecret,
      "x-deputy-generation-time": String(Date.parse(observedAt) / 1_000),
      "x-deputy-webhook-callback": callbackUrl,
    },
    body: new TextEncoder().encode(JSON.stringify({ topic: "Employee.Delete", data })),
  } as const;
}

test("Deputy DELETE verification preserves every source identity and rejects identity-free deletion events", () => {
  const disposition = parseDeputyWebhook({
    event: deleteEvent([{ Id: 41 }, { Id: "42" }, { Id: 41 }]),
    material: { version: 1, customHeaderSecret },
    expectedCallbackUrl: callbackUrl,
    nowMs: Date.parse(observedAt),
  });
  assert.deepEqual(disposition.streams, ["employees"]);
  assert.deepEqual(disposition.reconciliationSignals, [
    { kind: "tombstone", stream: "employees", sourceObjectType: "Employee", sourceRecordId: "41", observedAt },
    { kind: "tombstone", stream: "employees", sourceObjectType: "Employee", sourceRecordId: "42", observedAt },
  ]);
  assert.throws(() => parseDeputyWebhook({
    event: deleteEvent({ Company: 1 }),
    material: { version: 1, customHeaderSecret },
    expectedCallbackUrl: callbackUrl,
    nowMs: Date.parse(observedAt),
  }), /did not contain a valid source record identity/iu);
});

test("verified Deputy delete identities survive queue parsing and become immutable tombstone records", () => {
  const job = parseSyncJob({
    schemaVersion: 1,
    type: "IncrementalSync",
    tenantId,
    connectionId,
    connectionGeneration: 3,
    connectorId: "deputy",
    externalAccountReference: "albert.au.deputy.com",
    syncRunId,
    batchId,
    requestedAt: observedAt,
    jobRequestId,
    stream: "employees",
    reason: "webhook",
    webhookReceiptId: receiptId,
    webhookTombstones: [{
      kind: "tombstone",
      stream: "employees",
      sourceObjectType: "Employee",
      sourceRecordId: "42",
      observedAt,
    }],
  });
  assert.equal(job.type, "IncrementalSync");
  if (job.type !== "IncrementalSync") throw new Error("unexpected_job_type");
  const records = appendVerifiedWebhookTombstones({ job, manifest: deputyManifest, records: [] });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.sourceRecordId, "42");
  assert.equal(records[0]?.normalized?.tombstone, true);
  assert.equal(records[0]?.deletionSignal?.webhookReceiptId, receiptId);
  assert.deepEqual(records[0]?.normalized?.fields, { Id: "42" });
  assert.match(records[0]?.payloadHash ?? "", /^[0-9a-f]{64}$/u);
});

test("identity-only tombstones preserve prior typed source fields and close only an exact known episode", async () => {
  const projection = {
    schemaVersion: deputyManifest.packVersion,
    fields: { Id: "42" },
    tombstone: true,
  } as const;
  const prepared = prepareTypedStaging("deputy", "employees", projection);
  const statements: string[] = [];
  const client: PostgresQueryClient = {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string) {
      statements.push(sql.replace(/\s+/gu, " ").trim());
      return { rows: [] as Row[] };
    },
  };
  await upsertTypedStagingRecord(client, {
    contract: prepared.contract,
    tenantId,
    namespacedSourceKey: "deputy:albert.au.deputy.com:Employee:42",
    connectionId,
    externalAccountReference: "albert.au.deputy.com",
    sourceRecordId: "42",
    sourceVersion: observedAt,
    sourceUpdatedAt: observedAt,
    payloadHash: "a".repeat(64),
    payloadBatchId: batchId,
    syncRunId,
    tombstone: true,
    preserveExistingFields: true,
    mappingVersion: "m2-v1",
    values: prepared.values,
  });
  assert.match(statements[0] ?? "", /display_name" = coalesce\("source_deputy"\."employees"\."display_name", excluded\."display_name"\)/u);

  const identityOnlyCommands = mapDeputyCanonical("employees", {
    tenant_id: tenantId,
    namespaced_source_key: "deputy:albert.au.deputy.com:Employee:42",
    connection_id: connectionId,
    external_account_reference: "albert.au.deputy.com",
    source_object_type: "Employee",
    source_record_id: "42",
    source_version: observedAt,
    source_updated_at: observedAt,
    payload_hash: "a".repeat(64),
    payload_batch_id: batchId,
    sync_run_id: syncRunId,
    tombstone: true,
    mapping_version: "m2-v1",
    id: "42",
  }, { timezone: "Australia/Melbourne", baseCurrency: "AUD", tradingDayCutoff: "04:00" });
  assert.deepEqual(identityOnlyCommands, [{
    kind: "dimension",
    table: "worker",
    sourceObjectType: "Employee",
    sourceRecordId: "42",
    values: { active: false },
    tombstone: true,
    updateOnly: true,
    entityType: "worker",
  }]);

  // A reconciliation tombstone for a previously observed Employee is loaded
  // with its retained typed fields. That gives the mapper the exact episode
  // grain to terminate; a first-seen identity-only deletion deliberately does
  // not guess an employment start date.
  const retainedCommands = mapDeputyCanonical("employees", {
    tenant_id: tenantId,
    namespaced_source_key: "deputy:albert.au.deputy.com:Employee:42",
    connection_id: connectionId,
    external_account_reference: "albert.au.deputy.com",
    source_object_type: "Employee",
    source_record_id: "42",
    source_version: observedAt,
    source_updated_at: observedAt,
    payload_hash: "b".repeat(64),
    payload_batch_id: batchId,
    sync_run_id: syncRunId,
    tombstone: true,
    mapping_version: "m2-v1",
    id: "42",
    company: "7",
    display_name: "Alex Example",
    active: false,
    start_date: "2024-02-01",
    termination_date: "2026-08-03",
  }, { timezone: "Australia/Melbourne", baseCurrency: "AUD", tradingDayCutoff: "04:00" });
  const episode = retainedCommands.find((command) =>
    command.kind === "dimension" && command.table === "employment_episode"
  );
  assert.ok(episode && episode.kind === "dimension");
  assert.equal(episode.sourceObjectType, "EmployeeEpisode");
  assert.equal(episode.sourceRecordId, "42#episode:2024-02-01");
  assert.deepEqual(episode.values, {
    worker_id: {
      sourceRef: {
        table: "worker",
        sourceObjectType: "Employee",
        sourceRecordId: "42",
        connectionId,
        entityType: "worker",
      },
    },
    legal_entity_id: null,
    effective_from: "2024-02-01",
    effective_to: "2026-08-03",
    status: "terminated",
  });
});

class ReceiptDatabase implements TransactionalPostgres {
  readonly statements: Readonly<{ sql: string; values: readonly unknown[] }>[] = [];

  async transaction<T>(work: (client: PostgresQueryClient) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<Readonly<{ rows: readonly Row[] }>> {
    (this.statements as { sql: string; values: readonly unknown[] }[]).push({
      sql: sql.replace(/\s+/gu, " ").trim(),
      values,
    });
    if (sql.includes("finalize_attested_deputy_webhook")) {
      return { rows: [{ routed_count: 1 } as unknown as Row] };
    }
    return { rows: [] };
  }
}

test("gateway persists verified deletion identity before enqueuing read-only reconciliation", async () => {
  const db = new ReceiptDatabase();
  const store = new WebhookStore(db, createWebhookAttestor({
    keyId: "test-webhook-v1",
    encodedSecret: Buffer.alloc(32, 11).toString("base64url"),
    now: () => Date.parse(observedAt),
    nonce: () => Buffer.alloc(16, 12).toString("base64url"),
  }));
  const routed = await store.finalize({
    connection: { tenantId, connectionId, connectorKey: "deputy", externalAccountReference: "albert.au.deputy.com" },
    receiptId,
    streams: ["employees"],
    receivedAt: observedAt,
    accepted: true,
    reconciliationSignals: [{
      kind: "tombstone",
      stream: "employees",
      sourceObjectType: "Employee",
      sourceRecordId: "42",
      observedAt,
    }],
  });
  assert.equal(routed, 1);
  const persisted = db.statements.find((statement) =>
    statement.sql.includes("finalize_attested_deputy_webhook")
  );
  assert.ok(persisted);
  assert.match(String(persisted?.values[0]), /"sourceRecordId":"42"/u);
  assert.match(String(persisted?.values[4]), /^[0-9a-f]{64}$/u);
});

test("delete-signal migration and worker composition keep identity durable through landing", async () => {
  const [migration, worker] = await Promise.all([
    readFile(new URL("infra/migrations/control-plane/0029_m7_deputy_delete_reconciliation_signals.sql", root), "utf8"),
    readFile(new URL("services/sync-workers/src/worker.ts", root), "utf8"),
  ]);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS reconciliation_signals jsonb/iu);
  assert.match(migration, /'webhookTombstones', stream_signals/u);
  assert.match(migration, /'connectionGeneration', connection_generation/u);
  assert.match(worker, /appendVerifiedWebhookTombstones/u);
});
