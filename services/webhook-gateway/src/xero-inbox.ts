import { createHash } from "node:crypto";
import { ulid } from "ulid";
import {
  verifyAndParseXeroWebhook,
  type XeroWebhookPayload,
} from "../../../connectors/xero/webhooks.js";
import type { TransactionalPostgres } from "../../sync-workers/src/database.js";
import {
  encryptXeroWebhookBody,
  type XeroWebhookInboxKeyring,
} from "./xero-crypto.js";

export type AcceptedXeroWebhook = Readonly<{
  inboxId: string;
  status: "pending" | "processing" | "retry_wait" | "processed" | "failed" | "expired";
  created: boolean;
  deliveryCount: number;
  intentToReceive: boolean;
}>;

export type ClaimedXeroWebhook = Readonly<{
  inboxId: string;
  bodySha256: string;
  encryptionKeyId: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
  bodyBytes: number;
  firstEventSequence: number;
  lastEventSequence: number;
  eventCount: number;
  firstReceivedAt: string;
  attemptCount: number;
}>;

export type XeroSequenceObservation = Readonly<{
  disposition: "intent" | "initial" | "contiguous" | "gap" | "overlap" | "out_of_order";
  gapId: string | null;
  gapFirstSequence: number | null;
  gapLastSequence: number | null;
}>;

export type XeroWebhookInboxHealth = Readonly<{
  pendingCount: number;
  processingCount: number;
  retryCount: number;
  failedCount: number;
  expiredCount: number;
  oldestUnprocessedAt: string | null;
  activeKeyIds: readonly string[];
}>;

export class XeroWebhookInboxStore {
  constructor(private readonly db: TransactionalPostgres) {}

  async accept(input: Readonly<{
    inboxId: string;
    bodySha256: string;
    encryptionKeyId: string;
    nonce: Uint8Array;
    ciphertext: Uint8Array;
    authTag: Uint8Array;
    bodyBytes: number;
    firstEventSequence: number;
    lastEventSequence: number;
    eventCount: number;
    receivedAt: string;
    expiresAt: string;
    retainUntil: string;
  }>): Promise<Omit<AcceptedXeroWebhook, "intentToReceive">> {
    const result = await this.db.query<{
      inbox_id: string;
      status: AcceptedXeroWebhook["status"];
      created: boolean;
      delivery_count: number;
    }>(
      `select * from control_plane.accept_xero_webhook_inbox(
         $1, $2, $3, $4::bytea, $5::bytea, $6::bytea,
         $7, $8, $9, $10, $11, $12, $13
       )`,
      [
        input.inboxId,
        input.bodySha256,
        input.encryptionKeyId,
        Buffer.from(input.nonce),
        Buffer.from(input.ciphertext),
        Buffer.from(input.authTag),
        input.bodyBytes,
        input.firstEventSequence,
        input.lastEventSequence,
        input.eventCount,
        input.receivedAt,
        input.expiresAt,
        input.retainUntil,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("xero_inbox_accept_failed");
    return Object.freeze({
      inboxId: row.inbox_id,
      status: row.status,
      created: row.created,
      deliveryCount: Number(row.delivery_count),
    });
  }

  async claim(workerId: string, leaseSeconds: number): Promise<ClaimedXeroWebhook | null> {
    const result = await this.db.query<{
      inbox_id: string;
      body_sha256: string;
      encryption_key_id: string;
      nonce: Uint8Array;
      ciphertext: Uint8Array;
      auth_tag: Uint8Array;
      body_bytes: number;
      first_event_sequence: number;
      last_event_sequence: number;
      event_count: number;
      first_received_at: string;
      attempt_count: number;
    }>(
      "select * from control_plane.claim_xero_webhook_inbox($1, 1, $2)",
      [workerId, leaseSeconds],
    );
    const row = result.rows[0];
    return row ? Object.freeze({
      inboxId: row.inbox_id,
      bodySha256: row.body_sha256,
      encryptionKeyId: row.encryption_key_id,
      nonce: new Uint8Array(row.nonce),
      ciphertext: new Uint8Array(row.ciphertext),
      authTag: new Uint8Array(row.auth_tag),
      bodyBytes: Number(row.body_bytes),
      firstEventSequence: Number(row.first_event_sequence),
      lastEventSequence: Number(row.last_event_sequence),
      eventCount: Number(row.event_count),
      firstReceivedAt: new Date(row.first_received_at).toISOString(),
      attemptCount: Number(row.attempt_count),
    }) : null;
  }

  async renew(inboxId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const result = await this.db.query<{ renewed: boolean }>(
      "select control_plane.renew_xero_webhook_inbox_lease($1, $2, $3) as renewed",
      [inboxId, workerId, leaseSeconds],
    );
    return result.rows[0]?.renewed === true;
  }

  async recordSequence(inboxId: string, workerId: string): Promise<XeroSequenceObservation> {
    const result = await this.db.query<{
      disposition: XeroSequenceObservation["disposition"];
      gap_id: string | null;
      gap_first_sequence: number | null;
      gap_last_sequence: number | null;
    }>(
      "select * from control_plane.record_xero_webhook_sequence($1, $2)",
      [inboxId, workerId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("xero_sequence_record_failed");
    return Object.freeze({
      disposition: row.disposition,
      gapId: row.gap_id,
      gapFirstSequence: row.gap_first_sequence === null ? null : Number(row.gap_first_sequence),
      gapLastSequence: row.gap_last_sequence === null ? null : Number(row.gap_last_sequence),
    });
  }

  async recordConnection(input: Readonly<{
    tenantId: string;
    connectionId: string;
    inboxId: string;
    streams: readonly string[];
  }>): Promise<void> {
    await this.db.query(
      "select * from control_plane.record_xero_webhook_connection_delivery($1, $2, $3, $4::text[])",
      [input.tenantId, input.connectionId, input.inboxId, [...input.streams]],
    );
  }

  async enqueueGapSweeps(gapId: string, observedAt: string): Promise<number> {
    const result = await this.db.query<{ count: number }>(
      "select control_plane.enqueue_xero_webhook_gap_sweeps($1, $2) as count",
      [gapId, observedAt],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async complete(
    inboxId: string,
    workerId: string,
    summary: Readonly<Record<string, string | number>>,
  ): Promise<void> {
    await this.db.query(
      "select control_plane.complete_xero_webhook_inbox($1, $2, $3::jsonb)",
      [inboxId, workerId, JSON.stringify(summary)],
    );
  }

  async fail(input: Readonly<{
    inboxId: string;
    workerId: string;
    errorCode: string;
    retryDelaySeconds: number;
    maxAttempts: number;
    permanent: boolean;
  }>): Promise<string> {
    const result = await this.db.query<{ status: string }>(
      `select control_plane.fail_xero_webhook_inbox(
         $1, $2, $3, $4, $5, $6
       ) as status`,
      [
        input.inboxId,
        input.workerId,
        input.errorCode,
        input.retryDelaySeconds,
        input.maxAttempts,
        input.permanent,
      ],
    );
    return result.rows[0]?.status ?? "unknown";
  }

  async purge(limit = 500): Promise<number> {
    const result = await this.db.query<{ count: number }>(
      "select control_plane.purge_xero_webhook_inbox($1) as count",
      [limit],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async health(): Promise<XeroWebhookInboxHealth> {
    const result = await this.db.query<{
      pending_count: string | number;
      processing_count: string | number;
      retry_count: string | number;
      failed_count: string | number;
      expired_count: string | number;
      oldest_unprocessed_at: string | null;
      active_key_ids: string[];
    }>("select * from control_plane.xero_webhook_inbox_health()");
    const row = result.rows[0];
    if (!row) throw new Error("xero_inbox_health_unavailable");
    return Object.freeze({
      pendingCount: Number(row.pending_count),
      processingCount: Number(row.processing_count),
      retryCount: Number(row.retry_count),
      failedCount: Number(row.failed_count),
      expiredCount: Number(row.expired_count),
      oldestUnprocessedAt: row.oldest_unprocessed_at
        ? new Date(row.oldest_unprocessed_at).toISOString()
        : null,
      activeKeyIds: Object.freeze([...(row.active_key_ids ?? [])]),
    });
  }
}

export type XeroWebhookIngressConfig = Readonly<{
  signingKey: string;
  keyring: XeroWebhookInboxKeyring;
  encryptedRetentionDays: number;
  metadataRetentionDays: number;
  persistenceTimeoutMs: number;
}>;

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("xero_inbox_persist_timeout")), timeoutMs);
    timeout.unref?.();
    work.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export class XeroWebhookIngress {
  constructor(
    private readonly config: XeroWebhookIngressConfig,
    private readonly store: Pick<XeroWebhookInboxStore, "accept">,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = ulid,
  ) {}

  async accept(
    body: Uint8Array,
    signature: string | null | undefined,
    receivedAt = new Date(this.now()).toISOString(),
  ): Promise<AcceptedXeroWebhook> {
    const payload: XeroWebhookPayload = verifyAndParseXeroWebhook(
      body,
      signature,
      this.config.signingKey,
    );
    const bodySha256 = createHash("sha256").update(body).digest("hex");
    const inboxId = this.newId();
    const encrypted = encryptXeroWebhookBody({
      inboxId,
      bodySha256,
      body,
      keyring: this.config.keyring,
    });
    const receivedTime = new Date(receivedAt).getTime();
    if (!Number.isFinite(receivedTime)) throw new Error("xero_received_at_invalid");
    const expiresAt = new Date(
      receivedTime + this.config.encryptedRetentionDays * 86_400_000,
    ).toISOString();
    const retainUntil = new Date(
      receivedTime + this.config.metadataRetentionDays * 86_400_000,
    ).toISOString();
    const accepted = await withDeadline(this.store.accept({
      inboxId,
      bodySha256,
      encryptionKeyId: encrypted.keyId,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
      authTag: encrypted.authTag,
      bodyBytes: body.byteLength,
      firstEventSequence: payload.firstEventSequence,
      lastEventSequence: payload.lastEventSequence,
      eventCount: payload.events.length,
      receivedAt: new Date(receivedTime).toISOString(),
      expiresAt,
      retainUntil,
    }), this.config.persistenceTimeoutMs);
    return Object.freeze({
      ...accepted,
      intentToReceive: payload.events.length === 0,
    });
  }
}
