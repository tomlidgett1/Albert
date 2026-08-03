import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  ConnectorError,
  type WebhookDisposition,
  type WebhookEnvelope,
} from "../../packages/connector-sdk/src/index.js";

export const DEPUTY_WEBHOOK_TOPICS = Object.freeze([
  "Company.Update",
  "OperationalUnit.Insert",
  "OperationalUnit.Update",
  "OperationalUnit.Delete",
  "Employee.Insert",
  "Employee.Update",
  "Employee.Delete",
  "Roster.Insert",
  "Roster.Update",
  "Roster.Delete",
  "Timesheet.Insert",
  "Timesheet.Update",
  "Timesheet.Delete",
  "Leave.Insert",
  "Leave.Update",
  "Leave.Delete",
] as const);

export type DeputyWebhookTopic = (typeof DEPUTY_WEBHOOK_TOPICS)[number];

export type DeputyWebhookVerificationMaterial = Readonly<{
  version: 1;
  customHeaderSecret: string;
  /** Deputy Enterprise API-signing private key, when separately supplied. */
  enterpriseHmacKey?: string;
}>;

export type DeputyWebhookProvisioningInput = Readonly<{
  callbackUrl: string;
  customHeaderSecret: string;
  existingHooks: readonly DeputyVendorWebhook[];
}>;

export type DeputyVendorWebhook = Readonly<{
  id: string;
  topic: string;
  address: string;
  headers: string;
  enabled: boolean;
  type: string;
}>;

const payloadSchema = z.object({
  topic: z.string().min(1).max(160),
  data: z.union([
    z.record(z.string(), z.unknown()),
    z.array(z.record(z.string(), z.unknown())).max(5_000),
  ]),
}).passthrough();

const vendorWebhookSchema = z.object({
  Id: z.union([z.string().min(1).max(200), z.number().int().nonnegative()]),
  Topic: z.string().min(1).max(160),
  Address: z.string().min(1).max(2_000),
  Headers: z.string().max(2_000).nullish(),
  Enabled: z.union([
    z.boolean(),
    z.number().int().min(0).max(1),
    z.string().min(1).max(20),
  ]),
  Type: z.string().min(1).max(40),
}).passthrough();

const createdWebhookSchema = z.union([
  z.string().min(1).max(200),
  z.number().int().nonnegative(),
  z.object({
    Id: z.union([z.string().min(1).max(200), z.number().int().nonnegative()]),
  }).passthrough(),
]);

const verificationMaterialSchema = z.object({
  version: z.literal(1),
  customHeaderSecret: z.string().min(32).max(512).refine((value) => !/[\r\n]/u.test(value)),
  enterpriseHmacKey: z.string().min(16).max(4096).optional(),
});

const STREAM_BY_RESOURCE = Object.freeze({
  company: "companies",
  operationalunit: "operational_units",
  employee: "employees",
  roster: "rosters",
  timesheet: "timesheets",
  leave: "leave",
  contact: "contacts",
} as const);

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function decodeHmac(value: string): readonly Buffer[] {
  const normalized = value.trim();
  const candidates: Buffer[] = [];
  if (/^[0-9a-f]{64}$/iu.test(normalized)) candidates.push(Buffer.from(normalized, "hex"));
  if (/^[A-Za-z0-9+/]{43}=?$/u.test(normalized)) {
    const decoded = Buffer.from(normalized, "base64");
    if (decoded.byteLength === 32) candidates.push(decoded);
  }
  return candidates;
}

function unixGenerationTime(value: string | undefined): number {
  if (!value || !/^[0-9]{10}$/u.test(value)) {
    throw new ConnectorError("WEBHOOK_SIGNATURE_INVALID", "Deputy webhook generation time is missing or invalid.");
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    throw new ConnectorError("WEBHOOK_SIGNATURE_INVALID", "Deputy webhook generation time is invalid.");
  }
  return seconds * 1_000;
}

function verifyAuthentication(
  event: WebhookEnvelope,
  material: DeputyWebhookVerificationMaterial,
): void {
  if (material.version !== 1 || Buffer.byteLength(material.customHeaderSecret, "utf8") < 32) {
    throw new ConnectorError("CONFIGURATION_INVALID", "Deputy webhook verification material is invalid.");
  }
  const customSecret = header(event.headers, "x-albert-webhook-secret");
  if (!customSecret || !constantTimeTextEqual(customSecret, material.customHeaderSecret)) {
    throw new ConnectorError("WEBHOOK_SIGNATURE_INVALID", "Deputy webhook authentication failed.");
  }

  const deputySignature = header(event.headers, "x-deputy-secret");
  if (material.enterpriseHmacKey) {
    if (!deputySignature) {
      throw new ConnectorError("WEBHOOK_SIGNATURE_INVALID", "Deputy Enterprise webhook signature is missing.");
    }
    const expected = createHmac("sha256", material.enterpriseHmacKey).update(event.body).digest();
    if (!decodeHmac(deputySignature).some((candidate) =>
      candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected)
    )) {
      throw new ConnectorError("WEBHOOK_SIGNATURE_INVALID", "Deputy Enterprise webhook signature is invalid.");
    }
  }
}

/**
 * Verify and normalize a Deputy webhook. Deputy documents the HMAC as covering
 * the raw body only, so replay identity deliberately excludes request IDs,
 * callback headers, and generation-time headers.
 */
export function parseDeputyWebhook(input: Readonly<{
  event: WebhookEnvelope;
  material: DeputyWebhookVerificationMaterial;
  expectedCallbackUrl: string;
  nowMs?: number;
  maxClockSkewMs?: number;
}>): WebhookDisposition {
  verifyAuthentication(input.event, input.material);
  const nowMs = input.nowMs ?? Date.now();
  const generatedAt = unixGenerationTime(header(input.event.headers, "x-deputy-generation-time"));
  const maxClockSkewMs = input.maxClockSkewMs ?? 5 * 60_000;
  if (!Number.isFinite(nowMs) || maxClockSkewMs < 30_000 || maxClockSkewMs > 15 * 60_000) {
    throw new ConnectorError("CONFIGURATION_INVALID", "Deputy webhook freshness policy is invalid.");
  }
  if (Math.abs(nowMs - generatedAt) > maxClockSkewMs) {
    throw new ConnectorError("WEBHOOK_SIGNATURE_INVALID", "Deputy webhook generation time is outside the accepted window.");
  }

  const callback = header(input.event.headers, "x-deputy-webhook-callback");
  if (!callback || !constantTimeTextEqual(callback, input.expectedCallbackUrl)) {
    throw new ConnectorError("WEBHOOK_SIGNATURE_INVALID", "Deputy webhook callback identity does not match.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.event.body));
  } catch (cause) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Deputy webhook JSON is invalid.", { cause });
  }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Deputy webhook payload is invalid.", {
      cause: parsed.error,
    });
  }
  const resource = parsed.data.topic.split(".")[0]?.toLowerCase();
  const stream = resource
    ? STREAM_BY_RESOURCE[resource as keyof typeof STREAM_BY_RESOURCE]
    : undefined;
  const bodySha256 = createHash("sha256").update(input.event.body).digest("hex");
  return Object.freeze({
    accepted: Boolean(stream),
    // The raw body is authenticated in Enterprise mode and transported with a
    // unique per-connection secret otherwise. No mutable header enters this key.
    dedupeKey: `deputy:${parsed.data.topic}:${bodySha256}`,
    streams: stream ? [stream] : [],
    reason: stream ? undefined : "Webhook topic is outside Albert's Deputy stream catalogue.",
  });
}

export function parseDeputyVendorWebhooks(value: unknown): readonly DeputyVendorWebhook[] {
  const parsed = z.array(vendorWebhookSchema).max(500).safeParse(value);
  if (!parsed.success) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Deputy Webhook QUERY returned an invalid response.", {
      cause: parsed.error,
    });
  }
  return Object.freeze(parsed.data.map((hook) => Object.freeze({
    id: String(hook.Id),
    topic: hook.Topic,
    address: hook.Address,
    headers: hook.Headers ?? "",
    enabled: hook.Enabled === true || hook.Enabled === 1 || hook.Enabled === "1" || hook.Enabled === "true",
    type: hook.Type,
  })));
}

export function parseCreatedDeputyWebhookId(value: unknown): string {
  const parsed = createdWebhookSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Deputy did not return a webhook identifier.", {
      cause: parsed.error,
    });
  }
  return typeof parsed.data === "object" ? String(parsed.data.Id) : String(parsed.data);
}

export function deputyWebhookHeaderValue(secret: string): string {
  if (Buffer.byteLength(secret, "utf8") < 32 || /[\r\n]/u.test(secret)) {
    throw new ConnectorError("CONFIGURATION_INVALID", "Deputy webhook custom-header secret is invalid.");
  }
  // Deputy documents this exact newline-delimited `Name: value` representation.
  return `X-Albert-Webhook-Secret: ${secret}`;
}

export function parseDeputyWebhookVerificationMaterial(
  value: unknown,
): DeputyWebhookVerificationMaterial {
  const parsed = verificationMaterialSchema.safeParse(value);
  if (!parsed.success) throw new Error("deputy_webhook_material_invalid");
  return Object.freeze(parsed.data);
}
