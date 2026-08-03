import { createHash } from "node:crypto";

import type {
  ConnectorManifest,
  RawSourceRecord,
} from "../../../packages/connector-sdk/src/index.js";
import type { IncrementalSyncJob } from "../../../packages/queue/src/index.js";

/**
 * Convert verified Deputy DELETE identities into source records without a
 * vendor write or a fragile read-after-delete dependency. The exact event body
 * remains attached to webhookReceiptId; this immutable envelope carries only
 * the minimum identity needed to tombstone an existing source record.
 */
export function appendVerifiedWebhookTombstones(input: Readonly<{
  job: IncrementalSyncJob;
  manifest: ConnectorManifest;
  records: readonly RawSourceRecord[];
}>): readonly RawSourceRecord[] {
  const signals = input.job.webhookTombstones;
  if (!signals?.length) return input.records;
  if (input.job.connectorId !== "deputy" || input.job.reason !== "webhook" ||
      !input.job.webhookReceiptId) {
    throw new Error("webhook_tombstone_job_invalid");
  }
  const contract = input.manifest.streams.find((stream) => stream.id === input.job.stream);
  if (!contract) throw new Error(`webhook_tombstone_stream_unknown:${input.job.stream}`);

  const tombstones: RawSourceRecord[] = [];
  for (const signal of signals) {
    if (signal.stream !== contract.id || signal.sourceObjectType !== contract.resource) {
      throw new Error("webhook_tombstone_contract_mismatch");
    }
    const existingTombstone = input.records.some((record) =>
      record.sourceObjectType === signal.sourceObjectType &&
      record.sourceRecordId === signal.sourceRecordId &&
      record.normalized?.tombstone === true
    );
    if (existingTombstone) continue;
    const payload = Object.freeze({
      schemaVersion: 1,
      signalType: "verified_deputy_webhook_tombstone",
      webhookReceiptId: input.job.webhookReceiptId,
      stream: signal.stream,
      sourceObjectType: signal.sourceObjectType,
      sourceRecordId: signal.sourceRecordId,
      observedAt: signal.observedAt,
    });
    const encoded = JSON.stringify(payload);
    tombstones.push(Object.freeze({
      sourceObjectType: signal.sourceObjectType,
      sourceRecordId: signal.sourceRecordId,
      sourceUpdatedAt: new Date(signal.observedAt).toISOString(),
      payload,
      normalized: Object.freeze({
        schemaVersion: input.manifest.packVersion,
        fields: Object.freeze({ [contract.recordIdField]: signal.sourceRecordId }),
        tombstone: true,
      }),
      deletionSignal: Object.freeze({
        kind: "verified_webhook_tombstone" as const,
        webhookReceiptId: input.job.webhookReceiptId,
      }),
      payloadHash: createHash("sha256").update(encoded).digest("hex"),
    }));
  }
  return tombstones.length > 0
    ? Object.freeze([...input.records, ...tombstones])
    : input.records;
}
