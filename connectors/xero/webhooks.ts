import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Xero requires the HMAC to be computed over the exact request bytes. Keep
 * this limit aligned with the gateway's streaming request limit so an
 * attacker cannot make either layer buffer an unbounded body.
 */
export const XERO_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const XERO_WEBHOOK_MAX_EVENTS = 1_000;
export const XERO_WEBHOOK_MAX_SEQUENCE = 2_147_483_647;

const uuid = z.string().uuid().max(36);
const eventDateUtc = z.iso.datetime({ offset: true }).max(64);
const resourceUrl = z.string().url().max(2_048).refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && parsed.hostname === "api.xero.com";
}, "resourceUrl must be an HTTPS Xero API URL");

const creditNoteDataSchema = z.object({
  Type: z.enum(["ACCPAYCREDIT", "ACCRECCREDIT"]),
  Status: z.enum(["DRAFT", "SUBMITTED", "DELETED", "AUTHORISED", "PAID", "VOIDED"]),
}).passthrough();

const eventSchema = z.object({
  resourceUrl,
  resourceId: uuid,
  eventDateUtc,
  eventType: z.enum(["CREATE", "UPDATE"]),
  eventCategory: z.enum(["CONTACT", "INVOICE", "SUBSCRIPTION", "CREDITNOTE"]),
  tenantId: uuid,
  tenantType: z.enum(["ORGANISATION", "APPLICATION"]),
  data: z.record(z.string(), z.unknown()).optional(),
}).passthrough().superRefine((event, context) => {
  if (event.eventCategory === "SUBSCRIPTION") {
    if (event.tenantType !== "APPLICATION") {
      context.addIssue({
        code: "custom",
        path: ["tenantType"],
        message: "subscription events must identify an application",
      });
    }
    return;
  }
  if (event.tenantType !== "ORGANISATION") {
    context.addIssue({
      code: "custom",
      path: ["tenantType"],
      message: "accounting events must identify an organisation",
    });
  }
  if (event.eventCategory === "CREDITNOTE") {
    const parsed = creditNoteDataSchema.safeParse(event.data);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "credit-note webhook data is invalid",
      });
    }
  }
});

export const xeroWebhookPayloadSchema = z.object({
  events: z.array(eventSchema).max(XERO_WEBHOOK_MAX_EVENTS),
  firstEventSequence: z.number().int().min(0).max(XERO_WEBHOOK_MAX_SEQUENCE),
  lastEventSequence: z.number().int().min(0).max(XERO_WEBHOOK_MAX_SEQUENCE),
  entropy: z.string().min(1).max(1_024),
}).passthrough().superRefine((payload, context) => {
  if (payload.events.length === 0) {
    if (payload.firstEventSequence !== 0 || payload.lastEventSequence !== 0) {
      context.addIssue({
        code: "custom",
        path: ["firstEventSequence"],
        message: "intent-to-receive payloads must use sequence zero",
      });
    }
    return;
  }
  if (
    payload.firstEventSequence < 1 ||
    payload.lastEventSequence < payload.firstEventSequence
  ) {
    context.addIssue({
      code: "custom",
      path: ["lastEventSequence"],
      message: "live webhook sequence range is invalid",
    });
  }
});

export type XeroWebhookPayload = z.infer<typeof xeroWebhookPayloadSchema>;
export type XeroWebhookEvent = XeroWebhookPayload["events"][number];
export type XeroWebhookCategory = XeroWebhookEvent["eventCategory"];
export type XeroWebhookStream = "contacts" | "invoices" | "credit_notes";

export const XERO_WEBHOOK_CATEGORY_STREAM: Readonly<
  Partial<Record<XeroWebhookCategory, XeroWebhookStream>>
> = Object.freeze({
  CONTACT: "contacts",
  INVOICE: "invoices",
  CREDITNOTE: "credit_notes",
});

export class XeroWebhookValidationError extends Error {
  constructor(
    readonly code: "signature_invalid" | "payload_invalid" | "payload_too_large",
  ) {
    super(code);
    this.name = "XeroWebhookValidationError";
  }
}

function decodeSignature(value: string | null | undefined): Buffer | null {
  // A SHA-256 digest is 32 bytes and its padded standard-base64 encoding is
  // exactly 44 characters. Buffer.from is intentionally preceded by a strict
  // grammar check because its base64 decoder otherwise accepts malformed text.
  if (!value || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === 32 ? decoded : null;
}

export function verifyAndParseXeroWebhook(
  body: Uint8Array,
  signature: string | null | undefined,
  signingKey: string,
): XeroWebhookPayload {
  if (body.byteLength > XERO_WEBHOOK_MAX_BODY_BYTES) {
    throw new XeroWebhookValidationError("payload_too_large");
  }
  const expected = createHmac("sha256", signingKey).update(body).digest();
  const received = decodeSignature(signature);
  if (!received || !timingSafeEqual(received, expected)) {
    throw new XeroWebhookValidationError("signature_invalid");
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new XeroWebhookValidationError("payload_invalid");
  }
  const parsed = xeroWebhookPayloadSchema.safeParse(value);
  if (!parsed.success) throw new XeroWebhookValidationError("payload_invalid");
  return parsed.data;
}

export type XeroWebhookPartition = Readonly<{
  xeroTenantId: string;
  category: Exclude<XeroWebhookCategory, "SUBSCRIPTION">;
  stream: XeroWebhookStream;
  events: readonly XeroWebhookEvent[];
}>;

/** Partition before tenant resolution so no tenant raw object can contain
 * another Xero organisation's events. Unsupported subscription events remain
 * acknowledged but never enter an accounting connection stream. */
export function partitionXeroWebhook(payload: XeroWebhookPayload): readonly XeroWebhookPartition[] {
  const grouped = new Map<string, XeroWebhookPartition>();
  for (const event of payload.events) {
    const stream = XERO_WEBHOOK_CATEGORY_STREAM[event.eventCategory];
    if (!stream || event.eventCategory === "SUBSCRIPTION") continue;
    const key = `${event.tenantId}\u0000${event.eventCategory}`;
    const existing = grouped.get(key);
    if (existing) {
      grouped.set(key, { ...existing, events: [...existing.events, event] });
    } else {
      grouped.set(key, {
        xeroTenantId: event.tenantId,
        category: event.eventCategory,
        stream,
        events: [event],
      });
    }
  }
  return [...grouped.values()].sort((left, right) =>
    left.xeroTenantId.localeCompare(right.xeroTenantId) ||
    left.category.localeCompare(right.category)
  );
}

export function serializeXeroWebhookPartition(input: Readonly<{
  sourceBodySha256: string;
  payload: XeroWebhookPayload;
  partition: XeroWebhookPartition;
}>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    source: "xero_webhook",
    sourceBodySha256: input.sourceBodySha256,
    firstEventSequence: input.payload.firstEventSequence,
    lastEventSequence: input.payload.lastEventSequence,
    entropy: input.payload.entropy,
    xeroTenantId: input.partition.xeroTenantId,
    category: input.partition.category,
    events: input.partition.events,
  }));
}
