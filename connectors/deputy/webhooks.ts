import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  ConnectorError,
  type WebhookDisposition,
  type WebhookEnvelope,
  type WebhookTombstoneSignal,
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

const payloadSchema = z.object({
  topic: z.string().min(1).max(160),
  data: z.union([
    z.record(z.string(), z.unknown()),
    z.array(z.record(z.string(), z.unknown())).max(5_000),
  ]),
}).passthrough();

const verificationMaterialSchema = z.object({
  version: z.literal(1),
  customHeaderSecret: z.string().min(32).max(512).refine((value) => !/[\r\n]/u.test(value)),
  enterpriseHmacKey: z.string().min(16).max(4096).optional(),
});

const ROUTE_BY_RESOURCE = Object.freeze({
  company: { stream: "companies", sourceObjectType: "Company" },
  operationalunit: { stream: "operational_units", sourceObjectType: "OperationalUnit" },
  employee: { stream: "employees", sourceObjectType: "Employee" },
  roster: { stream: "rosters", sourceObjectType: "Roster" },
  timesheet: { stream: "timesheets", sourceObjectType: "Timesheet" },
  leave: { stream: "leave", sourceObjectType: "Leave" },
  contact: { stream: "contacts", sourceObjectType: "Contact" },
} as const);
const SUPPORTED_TOPICS = new Set<string>(DEPUTY_WEBHOOK_TOPICS);

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

function sourceRecordId(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 300 && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function deletionSignals(input: Readonly<{
  topic: string;
  data: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[];
  observedAt: string;
  stream: string;
  sourceObjectType: string;
}>): readonly WebhookTombstoneSignal[] {
  if (!input.topic.endsWith(".Delete")) return [];
  const records = Array.isArray(input.data) ? input.data : [input.data];
  const identities = [...new Set(records.map((record) => sourceRecordId(record.Id ?? record.id)))];
  if (identities.length === 0 || identities.some((identity) => identity === null)) {
    throw new ConnectorError(
      "REMOTE_RESPONSE_INVALID",
      "Deputy deletion webhook did not contain a valid source record identity.",
    );
  }
  return identities.map((identity) => Object.freeze({
    kind: "tombstone" as const,
    stream: input.stream,
    sourceObjectType: input.sourceObjectType,
    sourceRecordId: identity!,
    observedAt: input.observedAt,
  }));
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
  const supportedTopic = SUPPORTED_TOPICS.has(parsed.data.topic);
  const resource = parsed.data.topic.split(".")[0]?.toLowerCase();
  const route = supportedTopic && resource
    ? ROUTE_BY_RESOURCE[resource as keyof typeof ROUTE_BY_RESOURCE]
    : undefined;
  const reconciliationSignals = route
    ? deletionSignals({
        topic: parsed.data.topic,
        data: parsed.data.data,
        observedAt: new Date(generatedAt).toISOString(),
        stream: route.stream,
        sourceObjectType: route.sourceObjectType,
      })
    : [];
  const bodySha256 = createHash("sha256").update(input.event.body).digest("hex");
  return Object.freeze({
    accepted: Boolean(route),
    // The raw body is authenticated in Enterprise mode and transported with a
    // unique per-connection secret otherwise. No mutable header enters this key.
    dedupeKey: `deputy:${parsed.data.topic}:${bodySha256}`,
    streams: route ? [route.stream] : [],
    reconciliationSignals,
    reason: route ? undefined : "Webhook topic is outside Albert's Deputy stream catalogue.",
  });
}

export function parseDeputyWebhookVerificationMaterial(
  value: unknown,
): DeputyWebhookVerificationMaterial {
  const parsed = verificationMaterialSchema.safeParse(value);
  if (!parsed.success) throw new Error("deputy_webhook_material_invalid");
  return Object.freeze(parsed.data);
}
