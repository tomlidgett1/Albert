import { createHash } from "node:crypto";
import {
  partitionXeroWebhook,
  serializeXeroWebhookPartition,
  xeroWebhookPayloadSchema,
  type XeroWebhookPayload,
  type XeroWebhookStream,
} from "../../../connectors/xero/webhooks.js";
import { createServiceLogger } from "../../../packages/observability/src/index.js";
import type { WebhookRawWriter } from "../../../packages/storage/src/index.js";
import type { WebhookConnection, WebhookStore } from "./store.js";
import {
  XeroWebhookDecryptionError,
  decryptXeroWebhookBody,
  type XeroWebhookInboxKeyring,
} from "./xero-crypto.js";
import {
  XeroWebhookInboxStore,
  type ClaimedXeroWebhook,
  type XeroWebhookInboxHealth,
} from "./xero-inbox.js";

type XeroRouteStore = Pick<
  WebhookStore,
  "resolveXero" | "reserve" | "attachRaw" | "markFailed"
> & Readonly<{
  finalizeXero(input: Readonly<{
    connection: WebhookConnection;
    inboxId: string;
    receiptId: string;
    stream: XeroWebhookStream;
    receivedAt: string;
  }>): Promise<boolean>;
}>;

export type XeroWebhookProcessorConfig = Readonly<{
  workerId: string;
  keyring: XeroWebhookInboxKeyring;
  leaseSeconds: number;
  pollIntervalMs: number;
  maxAttempts: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  serviceVersion: string;
  deploymentId?: string;
}>;

class XeroProcessingError extends Error {
  constructor(readonly code: string, readonly permanent: boolean) {
    super(code);
    this.name = "XeroProcessingError";
  }
}

function parseDecryptedPayload(item: ClaimedXeroWebhook, body: Uint8Array): XeroWebhookPayload {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new XeroProcessingError("decrypted_payload_invalid", true);
  }
  const parsed = xeroWebhookPayloadSchema.safeParse(value);
  if (!parsed.success) throw new XeroProcessingError("decrypted_payload_invalid", true);
  if (
    parsed.data.firstEventSequence !== item.firstEventSequence ||
    parsed.data.lastEventSequence !== item.lastEventSequence ||
    parsed.data.events.length !== item.eventCount ||
    body.byteLength !== item.bodyBytes
  ) {
    throw new XeroProcessingError("inbox_metadata_mismatch", true);
  }
  return parsed.data;
}

function errorEvidence(error: unknown): Readonly<{ code: string; permanent: boolean }> {
  if (error instanceof XeroProcessingError) {
    return { code: error.code, permanent: error.permanent };
  }
  if (error instanceof XeroWebhookDecryptionError) {
    return { code: error.code, permanent: true };
  }
  const candidate = error instanceof Error ? error.message.split(":", 1)[0] : "unknown_error";
  const safe = candidate && /^[a-z][a-z0-9_.-]{0,79}$/u.test(candidate)
    ? candidate
    : "processing_failed";
  const permanent = new Set([
    "webhook_dedupe_collision",
    "webhook_raw_conflict",
    "webhook_raw_hash_mismatch",
    "webhook_raw_attachment_conflict",
  ]).has(safe);
  return { code: safe, permanent };
}

function retryDelay(config: XeroWebhookProcessorConfig, attemptCount: number): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 10);
  return Math.min(config.retryMaxSeconds, config.retryBaseSeconds * (2 ** exponent));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ms);
    timeout.unref?.();
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class XeroWebhookProcessor {
  private running = false;
  private lastLoopFailureAt: string | null = null;
  private readonly logger;

  constructor(private readonly dependencies: Readonly<{
    config: XeroWebhookProcessorConfig;
    inbox: Pick<XeroWebhookInboxStore,
      "claim" | "renew" | "recordSequence" | "recordConnection" |
      "enqueueGapSweeps" | "complete" | "fail" | "purge" | "health"
    >;
    routes: XeroRouteStore;
    raw: Pick<WebhookRawWriter, "put">;
  }>) {
    this.logger = createServiceLogger("xero.webhook.processor", {
      serviceVersion: dependencies.config.serviceVersion,
      deploymentId: dependencies.config.deploymentId,
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error("xero_processor_already_running");
    this.running = true;
    let nextRetentionSweepAt = 0;
    try {
      while (!signal.aborted) {
        const now = Date.now();
        if (now >= nextRetentionSweepAt) {
          // Retention must advance even during a quiet webhook period. In
          // particular, permanently failed ciphertext cannot wait for another
          // successful delivery before reaching its cryptographic expiry.
          nextRetentionSweepAt = now + 60_000;
          await this.dependencies.inbox.purge().catch((error) => {
            this.logger.warn("retention_purge_failed", { code: errorEvidence(error).code });
          });
        }
        let item: ClaimedXeroWebhook | null = null;
        try {
          item = await this.dependencies.inbox.claim(
            this.dependencies.config.workerId,
            this.dependencies.config.leaseSeconds,
          );
          this.lastLoopFailureAt = null;
        } catch (error) {
          this.lastLoopFailureAt = new Date().toISOString();
          this.logger.error("claim_failed", { code: errorEvidence(error).code });
          await delay(Math.max(1_000, this.dependencies.config.pollIntervalMs), signal);
          continue;
        }
        if (!item) {
          await delay(this.dependencies.config.pollIntervalMs, signal);
          continue;
        }
        await this.processWithLease(item);
      }
    } finally {
      this.running = false;
    }
  }

  private async processWithLease(item: ClaimedXeroWebhook): Promise<void> {
    let leaseLost = false;
    let renewing = false;
    const renewalMs = Math.max(10_000, Math.floor(this.dependencies.config.leaseSeconds * 1_000 / 3));
    const renewal = setInterval(() => {
      if (renewing || leaseLost) return;
      renewing = true;
      void this.dependencies.inbox.renew(
        item.inboxId,
        this.dependencies.config.workerId,
        this.dependencies.config.leaseSeconds,
      ).then((value) => {
        if (!value) leaseLost = true;
      }).catch(() => {
        leaseLost = true;
      }).finally(() => {
        renewing = false;
      });
    }, renewalMs);
    renewal.unref?.();
    try {
      await this.process(item);
      if (leaseLost) throw new XeroProcessingError("inbox_lease_lost", false);
    } catch (error) {
      const evidence = errorEvidence(error);
      if (evidence.code === "inbox_lease_lost" || leaseLost) {
        this.logger.warn("lease_lost", { inboxId: item.inboxId });
        return;
      }
      const status = await this.dependencies.inbox.fail({
        inboxId: item.inboxId,
        workerId: this.dependencies.config.workerId,
        errorCode: evidence.code,
        retryDelaySeconds: retryDelay(this.dependencies.config, item.attemptCount),
        maxAttempts: this.dependencies.config.maxAttempts,
        permanent: evidence.permanent,
      }).catch(() => "lease_lost");
      this.logger.error("processing_failed", {
        inboxId: item.inboxId,
        code: evidence.code,
        attemptCount: item.attemptCount,
        status,
      });
    } finally {
      clearInterval(renewal);
    }
  }

  private async process(item: ClaimedXeroWebhook): Promise<void> {
    const body = decryptXeroWebhookBody({
      inboxId: item.inboxId,
      keyId: item.encryptionKeyId,
      bodySha256: item.bodySha256,
      nonce: item.nonce,
      ciphertext: item.ciphertext,
      authTag: item.authTag,
      keyring: this.dependencies.config.keyring,
    });
    const payload = parseDecryptedPayload(item, body);
    const sequence = await this.dependencies.inbox.recordSequence(
      item.inboxId,
      this.dependencies.config.workerId,
    );
    let gapRecoveryCount = 0;
    if (sequence.gapId) {
      gapRecoveryCount = await this.dependencies.inbox.enqueueGapSweeps(
        sequence.gapId,
        item.firstReceivedAt,
      );
    }

    const partitions = partitionXeroWebhook(payload);
    const externalIds = [...new Set(partitions.map((partition) => partition.xeroTenantId))];
    const connections = externalIds.length > 0
      ? await this.dependencies.routes.resolveXero(externalIds)
      : [];
    const matchedConnections = new Set<string>();
    const matchedPartitions = new Set<string>();
    let routedStreamCount = 0;

    for (const connection of connections) {
      const matching = partitions.filter(
        (partition) => partition.xeroTenantId === connection.externalAccountReference,
      );
      if (matching.length === 0) continue;
      const streams: XeroWebhookStream[] = [];
      for (const partition of matching) {
        const partitionKey = `${partition.xeroTenantId}\u0000${partition.category}`;
        const partitionBody = serializeXeroWebhookPartition({
          sourceBodySha256: item.bodySha256,
          payload,
          partition,
        });
        const partitionSha256 = createHash("sha256").update(partitionBody).digest("hex");
        const reservation = await this.dependencies.routes.reserve({
          connection,
          dedupeKey: `xero:${item.inboxId}:${partition.stream}`,
          vendorEventId: item.inboxId,
          bodySha256: partitionSha256,
          safeHeaders: Object.freeze({
            source_body_sha256: item.bodySha256,
            inbox_key_id: item.encryptionKeyId,
          }),
          receivedAt: item.firstReceivedAt,
        });
        try {
          if (!reservation.rawObjectKey) {
            const raw = await this.dependencies.raw.put({
              tenantId: connection.tenantId,
              connectionId: connection.connectionId,
              receiptId: reservation.receiptId,
              connectorKey: "xero",
              receivedAt: item.firstReceivedAt,
              body: partitionBody,
            });
            if (raw.bodySha256 !== partitionSha256) {
              throw new XeroProcessingError("webhook_raw_hash_mismatch", true);
            }
            await this.dependencies.routes.attachRaw(
              connection,
              reservation.receiptId,
              raw.objectKey,
            );
          }
          await this.dependencies.routes.finalizeXero({
            connection,
            inboxId: item.inboxId,
            receiptId: reservation.receiptId,
            stream: partition.stream,
            receivedAt: item.firstReceivedAt,
          });
        } catch (error) {
          await this.dependencies.routes.markFailed(
            connection,
            reservation.receiptId,
          ).catch(() => undefined);
          throw error;
        }
        streams.push(partition.stream);
        routedStreamCount += 1;
        matchedPartitions.add(partitionKey);
      }
      await this.dependencies.inbox.recordConnection({
        tenantId: connection.tenantId,
        connectionId: connection.connectionId,
        inboxId: item.inboxId,
        streams: [...new Set(streams)].sort(),
      });
      matchedConnections.add(`${connection.tenantId}:${connection.connectionId}`);
    }

    await this.dependencies.inbox.complete(
      item.inboxId,
      this.dependencies.config.workerId,
      Object.freeze({
        partitionCount: partitions.length,
        matchedConnectionCount: matchedConnections.size,
        routedStreamCount,
        unmatchedPartitionCount: partitions.length - matchedPartitions.size,
        ignoredEventCount: payload.events.filter((event) => event.eventCategory === "SUBSCRIPTION").length,
        sequenceDisposition: sequence.disposition,
        gapRecoveryCount,
      }),
    );
    this.logger.info("processed", {
      inboxId: item.inboxId,
      sequenceDisposition: sequence.disposition,
      matchedConnectionCount: matchedConnections.size,
      routedStreamCount,
    });
  }

  async health(): Promise<Readonly<{
    running: boolean;
    lastLoopFailureAt: string | null;
    inbox: XeroWebhookInboxHealth;
    missingKeyIds: readonly string[];
  }>> {
    const inbox = await this.dependencies.inbox.health();
    const missingKeyIds = inbox.activeKeyIds.filter(
      (keyId) => !this.dependencies.config.keyring.keys.has(keyId),
    );
    return Object.freeze({
      running: this.running,
      lastLoopFailureAt: this.lastLoopFailureAt,
      inbox,
      missingKeyIds: Object.freeze(missingKeyIds),
    });
  }

  async assertReady(): Promise<void> {
    const health = await this.health();
    if (
      !health.running ||
      health.lastLoopFailureAt !== null ||
      health.missingKeyIds.length > 0
    ) {
      throw new Error("xero_webhook_processor_not_ready");
    }
  }
}
