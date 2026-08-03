import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { RawObjectStore } from "./raw-batch.js";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CONNECTORS = new Set(["xero", "deputy"]);

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export type WebhookRawReceipt = Readonly<{
  objectKey: string;
  bodySha256: string;
  compressedBytes: number;
}>;

export type WebhookRawWriteAuthority = Readonly<{
  verificationReference: string;
  xeroLeaseOwner?: string;
  xeroLeaseToken?: string;
  xeroLeaseVersion?: number;
}>;

export type WebhookRawWriteInput = Readonly<{
  tenantId: string;
  connectionId: string;
  receiptId: string;
  connectorKey: "xero" | "deputy";
  receivedAt: string;
  body: Uint8Array;
  authority?: WebhookRawWriteAuthority;
}>;

export function buildWebhookRawObjectKey(input: Omit<WebhookRawWriteInput, "body">): string {
  if (
    !ULID_PATTERN.test(input.tenantId) ||
    !ULID_PATTERN.test(input.connectionId) ||
    !ULID_PATTERN.test(input.receiptId) ||
    !CONNECTORS.has(input.connectorKey)
  ) {
    throw new Error("webhook_raw_identity_invalid");
  }
  const date = new Date(input.receivedAt);
  if (!Number.isFinite(date.valueOf())) throw new Error("webhook_received_at_invalid");
  return [
    "tenant",
    input.tenantId,
    "connection",
    input.connectionId,
    "stream",
    `webhook_${input.connectorKey}`,
    "date",
    date.toISOString().slice(0, 10),
    `batch-${input.receiptId}.json.gz`,
  ].join("/");
}

/** Writes the exact signed vendor bytes, gzip-compressed, to a service-only bucket. */
export class WebhookRawWriter {
  constructor(
    private readonly objectStore: RawObjectStore,
    private readonly bucket = "raw-payloads",
  ) {
    if (bucket !== "raw-payloads") throw new Error("Webhook raw data must use raw-payloads.");
  }

  async put(input: WebhookRawWriteInput): Promise<WebhookRawReceipt> {
    const bodySha256 = sha256(input.body);
    const compressed = gzipSync(input.body, { level: 9 });
    const objectKey = buildWebhookRawObjectKey(input);
    const result = await this.objectStore.putIfAbsent({
      key:objectKey,
      body:compressed,
      contentType:"application/gzip",
      metadata:{receiptId:input.receiptId,contentSha256:bodySha256},
    });
    if(result==="exists"){
      const existing=await this.objectStore.read(objectKey);
      if(!existing||existing.byteLength!==compressed.byteLength||sha256(existing)!==sha256(compressed)){
        throw new Error("webhook_raw_conflict");
      }
    }
    return { objectKey, bodySha256, compressedBytes: compressed.byteLength };
  }
}

/** Source-compatible alias; production injects the ADR 0031 webhook-purpose
 * S3 ingestion adapter backed by a short-lived, RLS-scoped Auth session. */
export { WebhookRawWriter as SupabaseWebhookRawWriter };
