import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { WebhookTombstoneSignal } from "../../../packages/connector-sdk/src/index.js";
import type { MachineSessionIdentity } from "../../../packages/storage/src/session-credentials.js";
import type { TransactionalPostgres } from "../../sync-workers/src/database.js";
import {
  attestWebhookDocument,
  type WebhookAttestor,
} from "./attestation.js";
import type { RawStorageWebhookGrant } from "./raw-storage.js";

export type WebhookConnection = Readonly<{
  tenantId: string;
  connectionId: string;
  connectorKey: "xero" | "deputy";
  externalAccountReference: string;
}>;

export type ReservedWebhook = Readonly<{
  receiptId: string;
  status: "received" | "queued" | "duplicate" | "ignored" | "failed";
  rawObjectKey: string | null;
  duplicate: boolean;
  receivedAt: string;
}>;

export function webhookBodySha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function validatedReconciliationSignals(
  signals: readonly WebhookTombstoneSignal[],
  routedStreams: readonly string[],
): readonly WebhookTombstoneSignal[] {
  if (signals.length > 5_000) throw new Error("webhook_reconciliation_signals_too_large");
  const streams = new Set(routedStreams);
  const identities = new Set<string>();
  return Object.freeze(signals.map((signal) => {
    const identity = `${signal.stream}:${signal.sourceObjectType}:${signal.sourceRecordId}`;
    if (signal.kind !== "tombstone" || !streams.has(signal.stream) ||
        !signal.sourceObjectType.trim() || signal.sourceObjectType.length > 160 ||
        !signal.sourceRecordId.trim() || signal.sourceRecordId.length > 300 ||
        /[\u0000-\u001f\u007f]/u.test(signal.sourceRecordId) ||
        Number.isNaN(Date.parse(signal.observedAt)) || identities.has(identity)) {
      throw new Error("webhook_reconciliation_signal_invalid");
    }
    identities.add(identity);
    return Object.freeze({ ...signal });
  }));
}

export class WebhookStore {
  constructor(
    private readonly db: TransactionalPostgres,
    private readonly attestor: WebhookAttestor,
  ) {}

  async resolveXero(externalAccountIds: readonly string[]): Promise<readonly WebhookConnection[]> {
    if (externalAccountIds.length === 0) return [];
    const externalAccountReferences = [...new Set(externalAccountIds)].sort();
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "xero.resolve",
      "xero-connections",
      {
        version: 1,
        operation: "xero.resolve",
        externalAccountReferences,
      },
    );
    const result = await this.db.query<{
      tenant_id: string;
      connection_id: string;
      connector_key: "xero";
      external_account_reference: string;
    }>(
      `select * from control_plane.resolve_attested_xero_webhook_connections(
         $1, $2, $3, $4, $5
       )`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
    return result.rows.map((row) => ({
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      connectorKey: row.connector_key,
      externalAccountReference: row.external_account_reference,
    }));
  }

  async reserve(input: Readonly<{
    connection: WebhookConnection;
    dedupeKey: string;
    vendorEventId?: string;
    bodySha256: string;
    verificationReference: string;
    leaseOwner?: string;
    leaseToken?: string;
    leaseVersion?: number;
    safeHeaders: Readonly<Record<string, string>>;
    receivedAt: string;
  }>): Promise<ReservedWebhook> {
    if (!input.dedupeKey.trim() || input.dedupeKey.length > 1000) {
      throw new Error("webhook_dedupe_key_invalid");
    }
    const receiptId = ulid();
    const document = JSON.stringify({
      version: 1,
      operation: "receipt.reserve",
      tenantId: input.connection.tenantId,
      connectionId: input.connection.connectionId,
      connectorKey: input.connection.connectorKey,
      verificationReference: input.verificationReference,
      leaseOwner: input.leaseOwner ?? null,
      leaseToken: input.leaseToken ?? null,
      leaseVersion: input.leaseVersion ?? null,
      receiptId,
      dedupeKey: input.dedupeKey,
      vendorEventId: input.vendorEventId ?? null,
      bodySha256: input.bodySha256,
      safeHeaders: input.safeHeaders,
      receivedAt: input.receivedAt,
    });
    const proof = this.attestor.attest("receipt.reserve", receiptId, document);
    const result = await this.db.query<{
      webhook_receipt_id: string;
      status: ReservedWebhook["status"];
      raw_object_key: string | null;
      duplicate: boolean;
      received_at: string;
    }>(
      `select * from control_plane.reserve_attested_webhook_receipt(
         $1, $2, $3, $4, $5, $6
       )`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature, receiptId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("webhook_receipt_reservation_failed");
    return {
      receiptId: row.webhook_receipt_id,
      status: row.status,
      rawObjectKey: row.raw_object_key,
      duplicate: row.duplicate,
      receivedAt: row.received_at,
    };
  }

  async attachRaw(
    connection: WebhookConnection,
    receiptId: string,
    objectKey: string,
    verificationReference: string,
    leaseOwner?: string,
    leaseToken?: string,
    leaseVersion?: number,
  ): Promise<void> {
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "receipt.attach",
      receiptId,
      {
        version: 1,
        operation: "receipt.attach",
        tenantId: connection.tenantId,
        connectionId: connection.connectionId,
        connectorKey: connection.connectorKey,
        verificationReference,
        leaseOwner: leaseOwner ?? null,
        leaseToken: leaseToken ?? null,
        leaseVersion: leaseVersion ?? null,
        receiptId,
        objectKey,
      },
    );
    const attached = await this.db.query<{ attached: boolean }>(
      `select control_plane.attach_attested_webhook_raw(
         $1, $2, $3, $4, $5
       ) as attached`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
    if (attached.rows[0]?.attached !== true) throw new Error("webhook_raw_attachment_conflict");
  }

  async issueRawStorageWebhookSession(input: Readonly<{
    tenantId: string;
    connectionId: string;
    receiptId: string;
    connectorKey: "xero" | "deputy";
    verificationReference: string;
    xeroLeaseOwner?: string;
    xeroLeaseToken?: string;
    xeroLeaseVersion?: number;
    identity: MachineSessionIdentity;
  }>): Promise<RawStorageWebhookGrant> {
    const result = await this.db.query<{
      grant_id: unknown;
      tenant_id: unknown;
      connection_id: unknown;
      object_key: unknown;
      expires_at: unknown;
    }>(
      `select * from control_plane.issue_raw_storage_webhook_session(
         $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::bigint,
         $8::uuid,$9::uuid,$10::timestamptz
       )`,
      [
        input.tenantId,input.connectionId,input.receiptId,input.verificationReference,
        input.xeroLeaseOwner ?? null,input.xeroLeaseToken ?? null,
        input.xeroLeaseVersion ?? null,input.identity.userId,input.identity.sessionId,
        input.identity.tokenExpiresAt.toISOString(),
      ],
    );
    const row = result.rows[0];
    if (
      typeof row?.grant_id !== "string" ||
      typeof row.tenant_id !== "string" ||
      typeof row.connection_id !== "string" ||
      typeof row.object_key !== "string" ||
      !(typeof row.expires_at === "string" || row.expires_at instanceof Date)
    ) {
      throw new Error("webhook_raw_storage_grant_invalid");
    }
    return Object.freeze({
      grantId: row.grant_id,
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      objectKey: row.object_key,
      expiresAt: new Date(row.expires_at).toISOString(),
    });
  }

  async revokeRawStorageWebhookSession(input: Readonly<{
    tenantId: string;
    receiptId: string;
    grantId: string;
  }>): Promise<void> {
    const result = await this.db.query<{ revoked: boolean }>(
      `select control_plane.revoke_raw_storage_webhook_session(
         $1::text,$2::text,$3::text
       ) as revoked`,
      [input.tenantId,input.receiptId,input.grantId],
    );
    if (result.rows[0]?.revoked !== true) {
      throw new Error("webhook_raw_storage_grant_revocation_failed");
    }
  }

  async finalize(input: Readonly<{
    connection: WebhookConnection;
    receiptId: string;
    streams: readonly string[];
    receivedAt: string;
    accepted: boolean;
    reconciliationSignals?: readonly WebhookTombstoneSignal[];
  }>): Promise<number> {
    if (input.connection.connectorKey !== "deputy") {
      throw new Error("generic_xero_webhook_routing_forbidden");
    }
    const streams = [...new Set(input.streams)].sort();
    const reconciliationSignals = validatedReconciliationSignals(
      input.reconciliationSignals ?? [],
      streams,
    );
    const document = JSON.stringify({
      version: 1,
      operation: "receipt.finalize",
      tenantId: input.connection.tenantId,
      connectionId: input.connection.connectionId,
      receiptId: input.receiptId,
      accepted: input.accepted,
      streams,
      reconciliationSignals,
      receivedAt: input.receivedAt,
    });
    const proof = this.attestor.attest("receipt.finalize", input.receiptId, document);
    const result = await this.db.query<{ routed_count: number | string }>(
      `select control_plane.finalize_attested_deputy_webhook(
         $1, $2, $3, $4, $5, $6
       ) as routed_count`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature, input.receiptId],
    );
    const count = Number(result.rows[0]?.routed_count);
    if (!Number.isInteger(count) || count < 0) throw new Error("webhook_finalize_failed");
    return count;
  }

  async finalizeXero(input: Readonly<{
    connection: WebhookConnection;
    inboxId: string;
    receiptId: string;
    stream: "contacts" | "invoices" | "credit_notes";
    receivedAt: string;
    workerId: string;
    leaseToken: string;
    leaseVersion: number;
  }>): Promise<boolean> {
    if (input.connection.connectorKey !== "xero") {
      throw new Error("xero_webhook_connection_invalid");
    }
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "xero.enqueue",
      input.receiptId,
      {
        version: 1,
        operation: "xero.enqueue",
        tenantId: input.connection.tenantId,
        connectionId: input.connection.connectionId,
        inboxId: input.inboxId,
        workerId: input.workerId,
        leaseToken: input.leaseToken,
        leaseVersion: input.leaseVersion,
        receiptId: input.receiptId,
        stream: input.stream,
        receivedAt: input.receivedAt,
      },
    );
    const result = await this.db.query<{ enqueued: boolean }>(
      `select control_plane.enqueue_attested_xero_webhook_incremental(
         $1, $2, $3, $4, $5
       ) as enqueued`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
    return result.rows[0]?.enqueued === true;
  }

  async markFailed(
    connection: WebhookConnection,
    receiptId: string,
    verificationReference: string,
    leaseOwner?: string,
    leaseToken?: string,
    leaseVersion?: number,
  ): Promise<void> {
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "receipt.fail",
      receiptId,
      {
        version: 1,
        operation: "receipt.fail",
        tenantId: connection.tenantId,
        connectionId: connection.connectionId,
        connectorKey: connection.connectorKey,
        verificationReference,
        leaseOwner: leaseOwner ?? null,
        leaseToken: leaseToken ?? null,
        leaseVersion: leaseVersion ?? null,
        receiptId,
      },
    );
    await this.db.query(
      `select control_plane.fail_attested_webhook_receipt(
         $1, $2, $3, $4, $5
       )`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
  }
}
