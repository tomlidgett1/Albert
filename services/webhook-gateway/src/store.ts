import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { TransactionalPostgres } from "../../sync-workers/src/database.js";

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
}>;

export function webhookBodySha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export class WebhookStore {
  constructor(private readonly db: TransactionalPostgres) {}

  async resolveXero(externalAccountIds: readonly string[]): Promise<readonly WebhookConnection[]> {
    if (externalAccountIds.length === 0) return [];
    const result = await this.db.query<{
      tenant_id: string;
      connection_id: string;
      connector_key: "xero";
      external_account_reference: string;
    }>(
      `select connection.tenant_id, connection.connection_id,
              connection.connector_key, connection.external_account_reference
         from control_plane.connections as connection
        where connection.connector_key = 'xero'
          and connection.external_account_reference = any($1::text[])
          and connection.status in ('connected', 'degraded')`,
      [[...externalAccountIds]],
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
    safeHeaders: Readonly<Record<string, string>>;
    receivedAt: string;
  }>): Promise<ReservedWebhook> {
    if (!input.dedupeKey.trim() || input.dedupeKey.length > 1000) {
      throw new Error("webhook_dedupe_key_invalid");
    }
    return this.db.transaction(async (client) => {
      const receiptId = ulid();
      const inserted = await client.query<{ webhook_receipt_id: string }>(
        `insert into control_plane.webhook_receipts (
           tenant_id, webhook_receipt_id, connection_id, connector_key,
           vendor_event_id, dedupe_key, body_sha256, signature_verified,
           safe_headers, status, received_at
         ) values ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb, 'received', $9)
         on conflict (tenant_id, connection_id, dedupe_key) do nothing
         returning webhook_receipt_id`,
        [
          input.connection.tenantId,
          receiptId,
          input.connection.connectionId,
          input.connection.connectorKey,
          input.vendorEventId ?? null,
          input.dedupeKey,
          input.bodySha256,
          JSON.stringify(input.safeHeaders),
          input.receivedAt,
        ],
      );
      const selected = await client.query<{
        webhook_receipt_id: string;
        body_sha256: string;
        status: ReservedWebhook["status"];
        raw_object_key: string | null;
      }>(
        `select webhook_receipt_id, body_sha256, status, raw_object_key
           from control_plane.webhook_receipts
          where tenant_id = $1 and connection_id = $2 and dedupe_key = $3
          for update`,
        [input.connection.tenantId, input.connection.connectionId, input.dedupeKey],
      );
      const row = selected.rows[0];
      if (!row || row.body_sha256 !== input.bodySha256) {
        throw new Error("webhook_dedupe_collision");
      }
      return {
        receiptId: row.webhook_receipt_id,
        status: row.status,
        rawObjectKey: row.raw_object_key,
        duplicate: inserted.rows.length === 0,
      };
    });
  }

  async attachRaw(connection: WebhookConnection, receiptId: string, objectKey: string): Promise<void> {
    const attached = await this.db.query<{ webhook_receipt_id: string }>(
      `update control_plane.webhook_receipts
          set raw_object_key = coalesce(raw_object_key, $3)
        where tenant_id = $1 and webhook_receipt_id = $2
          and connection_id = $4
          and (raw_object_key is null or raw_object_key = $3)
        returning webhook_receipt_id`,
      [connection.tenantId, receiptId, objectKey, connection.connectionId],
    );
    if (!attached.rows[0]) throw new Error("webhook_raw_attachment_conflict");
  }

  async finalize(input: Readonly<{
    connection: WebhookConnection;
    receiptId: string;
    streams: readonly string[];
    receivedAt: string;
    accepted: boolean;
  }>): Promise<number> {
    if (input.connection.connectorKey !== "deputy") {
      throw new Error("generic_xero_webhook_routing_forbidden");
    }
    return this.db.transaction(async (client) => {
      const locked = await client.query<{
        status: ReservedWebhook["status"];
        raw_object_key: string | null;
      }>(
        `select status, raw_object_key
           from control_plane.webhook_receipts
          where tenant_id = $1 and webhook_receipt_id = $2 and connection_id = $3
          for update`,
        [input.connection.tenantId, input.receiptId, input.connection.connectionId],
      );
      const receipt = locked.rows[0];
      if (!receipt || !receipt.raw_object_key) throw new Error("webhook_raw_not_attached");
      if (receipt.status === "queued" || receipt.status === "ignored") return 0;

      if (!input.accepted || input.streams.length === 0) {
        await client.query(
          `update control_plane.webhook_receipts
              set status = 'ignored', routed_streams = $3::text[]
            where tenant_id = $1 and webhook_receipt_id = $2`,
          [input.connection.tenantId, input.receiptId, [...input.streams]],
        );
        return 0;
      }
      const streams = [...new Set(input.streams)].sort();
      for (const stream of streams) {
        await client.query(
          `select control_plane.enqueue_deputy_webhook_sync($1, $2, $3, $4, $5)`,
          [
            input.connection.tenantId,
            input.connection.connectionId,
            input.receiptId,
            stream,
            input.receivedAt,
          ],
        );
      }
      await client.query(
        `update control_plane.webhook_receipts
            set status = 'queued', routed_streams = $3::text[], queued_at = now()
          where tenant_id = $1 and webhook_receipt_id = $2`,
        [input.connection.tenantId, input.receiptId, streams],
      );
      return streams.length;
    });
  }

  async finalizeXero(input: Readonly<{
    connection: WebhookConnection;
    inboxId: string;
    receiptId: string;
    stream: "contacts" | "invoices" | "credit_notes";
    receivedAt: string;
  }>): Promise<boolean> {
    if (input.connection.connectorKey !== "xero") {
      throw new Error("xero_webhook_connection_invalid");
    }
    const result = await this.db.query<{ enqueued: boolean }>(
      `select control_plane.enqueue_xero_webhook_incremental(
         $1, $2, $3, $4, $5, $6
       ) as enqueued`,
      [
        input.connection.tenantId,
        input.connection.connectionId,
        input.inboxId,
        input.receiptId,
        input.stream,
        input.receivedAt,
      ],
    );
    return result.rows[0]?.enqueued === true;
  }

  async markFailed(connection: WebhookConnection, receiptId: string): Promise<void> {
    await this.db.query(
      `update control_plane.webhook_receipts set status = 'failed'
        where tenant_id = $1 and webhook_receipt_id = $2
          and status not in ('queued', 'ignored')`,
      [connection.tenantId, receiptId],
    );
  }
}
