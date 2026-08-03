import { createHash } from "node:crypto";
import { ulid } from "ulid";
import {
  verifyAndParseXeroWebhook,
  type XeroWebhookPayload,
} from "../../../connectors/xero/webhooks.js";
import type { TransactionalPostgres } from "../../sync-workers/src/database.js";
import {
  attestWebhookDocument,
  type WebhookAttestor,
} from "./attestation.js";
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
  leaseToken: string;
  leaseVersion: number;
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
  constructor(
    private readonly db: TransactionalPostgres,
    private readonly attestor: WebhookAttestor,
  ) {}

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
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "xero.accept",
      input.inboxId,
      {
        version: 1,
        operation: "xero.accept",
        inboxId: input.inboxId,
        bodySha256: input.bodySha256,
        encryptionKeyId: input.encryptionKeyId,
        nonceHex: Buffer.from(input.nonce).toString("hex"),
        ciphertextSha256: createHash("sha256").update(input.ciphertext).digest("hex"),
        authTagHex: Buffer.from(input.authTag).toString("hex"),
        bodyBytes: input.bodyBytes,
        firstEventSequence: input.firstEventSequence,
        lastEventSequence: input.lastEventSequence,
        eventCount: input.eventCount,
        receivedAt: input.receivedAt,
        expiresAt: input.expiresAt,
        retainUntil: input.retainUntil,
      },
    );
    const result = await this.db.query<{
      inbox_id: string;
      status: AcceptedXeroWebhook["status"];
      created: boolean;
      delivery_count: number;
    }>(
      `select * from control_plane.accept_attested_xero_webhook_inbox(
         $1, $2, $3, $4, $5, $6::bytea, $7::bytea, $8::bytea
       )`,
      [
        document,
        proof.issuedAt,
        proof.nonce,
        proof.keyId,
        proof.signature,
        Buffer.from(input.nonce),
        Buffer.from(input.ciphertext),
        Buffer.from(input.authTag),
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
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "xero.claim",
      workerId,
      { version: 1, operation: "xero.claim", workerId, limit: 1, leaseSeconds },
    );
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
      lease_token: string;
      lease_version: string | number;
    }>(
      `select * from control_plane.claim_attested_xero_webhook_inbox(
         $1, $2, $3, $4, $5
       )`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!/^[A-Za-z0-9_-]{22}$/u.test(row.lease_token)) {
      throw new Error("xero_lease_token_invalid");
    }
    const leaseVersion = Number(row.lease_version);
    if (!Number.isSafeInteger(leaseVersion) || leaseVersion < 1) {
      throw new Error("xero_lease_version_invalid");
    }
    return Object.freeze({
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
      leaseToken: row.lease_token,
      leaseVersion,
    });
  }

  async renew(
    inboxId: string,
    workerId: string,
    leaseToken: string,
    leaseVersion: number,
    leaseSeconds: number,
  ): Promise<boolean> {
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "xero.renew",
      inboxId,
      {
        version: 1,
        operation: "xero.renew",
        inboxId,
        workerId,
        leaseToken,
        leaseVersion,
        leaseSeconds,
      },
    );
    const result = await this.db.query<{ renewed: boolean }>(
      `select control_plane.renew_attested_xero_webhook_inbox_lease(
         $1, $2, $3, $4, $5
       ) as renewed`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
    return result.rows[0]?.renewed === true;
  }

  async recordSequence(
    inboxId: string,
    workerId: string,
    leaseToken: string,
    leaseVersion: number,
  ): Promise<XeroSequenceObservation> {
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "xero.sequence",
      inboxId,
      { version: 1, operation: "xero.sequence", inboxId, workerId, leaseToken, leaseVersion },
    );
    const result = await this.db.query<{
      disposition: XeroSequenceObservation["disposition"];
      gap_id: string | null;
      gap_first_sequence: number | null;
      gap_last_sequence: number | null;
    }>(
      `select * from control_plane.record_attested_xero_webhook_sequence(
         $1, $2, $3, $4, $5
       )`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
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
    workerId: string;
    leaseToken: string;
    leaseVersion: number;
    streams: readonly string[];
  }>): Promise<void> {
    const streams = [...input.streams];
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "xero.connection",
      input.inboxId,
      {
        version: 1,
        operation: "xero.connection",
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        inboxId: input.inboxId,
        workerId: input.workerId,
        leaseToken: input.leaseToken,
        leaseVersion: input.leaseVersion,
        streams,
      },
    );
    await this.db.query(
      `select * from control_plane.record_attested_xero_webhook_connection_delivery(
         $1, $2, $3, $4, $5
       )`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
  }

  async enqueueGapSweeps(
    gapId: string,
    inboxId: string,
    workerId: string,
    leaseToken: string,
    leaseVersion: number,
    observedAt: string,
  ): Promise<number> {
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "xero.gap",
      gapId,
      {
        version: 1,
        operation: "xero.gap",
        gapId,
        inboxId,
        workerId,
        leaseToken,
        leaseVersion,
        observedAt,
      },
    );
    const result = await this.db.query<{ count: number }>(
      `select control_plane.enqueue_attested_xero_webhook_gap_sweeps(
         $1, $2, $3, $4, $5
       ) as count`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async complete(
    inboxId: string,
    workerId: string,
    leaseToken: string,
    leaseVersion: number,
    summary: Readonly<Record<string, string | number>>,
  ): Promise<void> {
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "xero.complete",
      inboxId,
      {
        version: 1,
        operation: "xero.complete",
        inboxId,
        workerId,
        leaseToken,
        leaseVersion,
        summary,
      },
    );
    await this.db.query(
      `select control_plane.complete_attested_xero_webhook_inbox(
         $1, $2, $3, $4, $5
       )`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
  }

  async fail(input: Readonly<{
    inboxId: string;
    workerId: string;
    leaseToken: string;
    leaseVersion: number;
    errorCode: string;
    retryDelaySeconds: number;
    maxAttempts: number;
    permanent: boolean;
  }>): Promise<string> {
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "xero.fail",
      input.inboxId,
      { version: 1, operation: "xero.fail", ...input },
    );
    const result = await this.db.query<{ status: string }>(
      `select control_plane.fail_attested_xero_webhook_inbox(
         $1, $2, $3, $4, $5
       ) as status`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
    return result.rows[0]?.status ?? "unknown";
  }

  async health(): Promise<XeroWebhookInboxHealth> {
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "xero.health",
      "xero-inbox",
      { version: 1, operation: "xero.health" },
    );
    const result = await this.db.query<{
      pending_count: string | number;
      processing_count: string | number;
      retry_count: string | number;
      failed_count: string | number;
      expired_count: string | number;
      oldest_unprocessed_at: string | null;
      active_key_ids: string[];
    }>(
      `select * from control_plane.attested_xero_webhook_inbox_health(
         $1, $2, $3, $4, $5
       )`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
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
