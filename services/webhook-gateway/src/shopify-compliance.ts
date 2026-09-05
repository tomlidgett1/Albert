import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ulid } from "ulid";

import type { TransactionalPostgres } from "../../sync-workers/src/database.js";
import {
  attestWebhookDocument,
  type WebhookAttestor,
} from "./attestation.js";

/**
 * Shopify requires every public app to implement the three compliance topics.
 * `app/uninstalled` is included at this always-on lifecycle boundary so an
 * uninstall can fence ingestion even when the store never chose Start
 * ingestion. Operational data topics are intentionally absent.
 *
 * Official sources (API version pinned to 2026-07):
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 * https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
 * https://shopify.dev/docs/apps/build/webhooks/delivery-structure
 * https://shopify.dev/docs/api/webhooks/2026-07
 */
export const SHOPIFY_COMPLIANCE_TOPICS = Object.freeze([
  "customers/data_request",
  "customers/redact",
  "shop/redact",
  "app/uninstalled",
] as const);

export type ShopifyComplianceTopic = (typeof SHOPIFY_COMPLIANCE_TOPICS)[number];

const TOPICS = new Set<string>(SHOPIFY_COMPLIANCE_TOPICS);
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,61}\.myshopify\.com$/u;
const DECIMAL_REFERENCE = /^(0|[1-9][0-9]{0,29})$/u;
const API_VERSION = "2026-07";

export class ShopifyWebhookValidationError extends Error {
  constructor(readonly code:
    | "signature_invalid"
    | "identity_invalid"
    | "topic_unsupported"
    | "api_version_invalid"
    | "payload_invalid") {
    super(code);
    this.name = "ShopifyWebhookValidationError";
  }
}

export type AcceptedShopifyComplianceWebhook = Readonly<{
  inboxId: string;
  status: "dispatched" | "unresolved";
  duplicate: boolean;
  targetCount: number;
}>;

type NormalizedShopifyComplianceWebhook = Readonly<{
  webhookId: string;
  eventId: string | null;
  topic: ShopifyComplianceTopic;
  shopDomain: string;
  shopReferenceHmac: string;
  apiVersion: typeof API_VERSION;
  bodySha256: string;
  shopId: string;
  customerReference: string | null;
  customerContactHmac: string | null;
  orderReferences: readonly string[];
  dataRequestReference: string | null;
  receivedAt: string;
}>;

function invalid(code: ShopifyWebhookValidationError["code"]): never {
  throw new ShopifyWebhookValidationError(code);
}

function exactHeader(headers: Headers, name: string, maximum = 300): string {
  const value = headers.get(name)?.trim();
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid("identity_invalid");
  }
  return value;
}

function canonicalBase64Sha256(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === 32 && decoded.toString("base64") === value
    ? decoded
    : null;
}

function normalizeDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!SHOP_DOMAIN.test(normalized)) invalid("identity_invalid");
  return normalized;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("payload_invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}

function reference(value: unknown, required: boolean): string | null {
  if (value === null || value === undefined) {
    if (required) invalid("payload_invalid");
    return null;
  }
  const normalized = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === "string"
      ? value
      : "";
  if (!DECIMAL_REFERENCE.test(normalized)) invalid("payload_invalid");
  return normalized;
}

function references(value: unknown): readonly string[] {
  if (value === null || value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 5_000) invalid("payload_invalid");
  const normalized = value.map((item) => reference(item, true)!);
  if (new Set(normalized).size !== normalized.length) invalid("payload_invalid");
  return Object.freeze(normalized.sort());
}

function contactPart(value: unknown, maximum: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") invalid("payload_invalid");
  const normalized = value.trim().toLowerCase();
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    invalid("payload_invalid");
  }
  return normalized;
}

function hmacReference(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", secret)
    .update(`albert:shopify:${purpose}:v1:${value}`, "utf8")
    .digest("hex");
}

function normalizePayload(input: Readonly<{
  body: Uint8Array;
  headers: Headers;
  clientSecret: string;
  receivedAt: string;
}>): NormalizedShopifyComplianceWebhook {
  const receivedSignature = exactHeader(input.headers, "x-shopify-hmac-sha256", 64);
  const actual = canonicalBase64Sha256(receivedSignature);
  const expected = createHmac("sha256", input.clientSecret).update(input.body).digest();
  if (!actual || actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    invalid("signature_invalid");
  }

  const contentType = input.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") invalid("payload_invalid");
  const topicValue = exactHeader(input.headers, "x-shopify-topic", 80).toLowerCase();
  if (!TOPICS.has(topicValue)) invalid("topic_unsupported");
  const topic = topicValue as ShopifyComplianceTopic;
  const apiVersion = exactHeader(input.headers, "x-shopify-api-version", 20);
  if (apiVersion !== API_VERSION) invalid("api_version_invalid");
  const webhookId = exactHeader(input.headers, "x-shopify-webhook-id", 160);
  const eventIdHeader = input.headers.get("x-shopify-event-id")?.trim() || null;
  if (eventIdHeader && (
    eventIdHeader.length > 160 || /[\u0000-\u001f\u007f]/u.test(eventIdHeader)
  )) {
    invalid("identity_invalid");
  }
  const shopDomain = normalizeDomain(exactHeader(
    input.headers,
    "x-shopify-shop-domain",
    253,
  ));

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body));
  } catch {
    invalid("payload_invalid");
  }
  const payload = record(decoded);
  if (typeof payload.shop_domain === "string" &&
      normalizeDomain(payload.shop_domain) !== shopDomain) {
    invalid("identity_invalid");
  }

  const shopId = reference(
    topic === "app/uninstalled" ? payload.id : payload.shop_id,
    true,
  )!;
  let customerReference: string | null = null;
  let customerContactHmac: string | null = null;
  let orderReferences: readonly string[] = Object.freeze([]);
  let dataRequestReference: string | null = null;

  if (topic === "customers/data_request" || topic === "customers/redact") {
    const customer = record(payload.customer);
    customerReference = reference(customer.id, false);
    const email = contactPart(customer.email, 320);
    const phone = contactPart(customer.phone, 80);
    if (!customerReference && !email && !phone) invalid("payload_invalid");
    if (email || phone) {
      customerContactHmac = hmacReference(
        input.clientSecret,
        "customer-contact",
        `${shopDomain}\n${email}\n${phone}`,
      );
    }
    orderReferences = references(
      topic === "customers/data_request"
        ? payload.orders_requested
        : payload.orders_to_redact,
    );
    if (topic === "customers/data_request") {
      dataRequestReference = reference(record(payload.data_request).id, true);
    }
  }

  const received = new Date(input.receivedAt);
  if (!Number.isFinite(received.getTime()) || received.toISOString() !== input.receivedAt) {
    invalid("identity_invalid");
  }
  return Object.freeze({
    webhookId,
    eventId: eventIdHeader,
    topic,
    shopDomain,
    shopReferenceHmac: hmacReference(input.clientSecret, "shop", shopDomain),
    apiVersion: API_VERSION,
    bodySha256: createHash("sha256").update(input.body).digest("hex"),
    shopId,
    customerReference,
    customerContactHmac,
    orderReferences,
    dataRequestReference,
    receivedAt: input.receivedAt,
  });
}

export class ShopifyComplianceWebhookStore {
  constructor(
    private readonly db: TransactionalPostgres,
    private readonly attestor: WebhookAttestor,
  ) {}

  async accept(input: NormalizedShopifyComplianceWebhook): Promise<AcceptedShopifyComplianceWebhook> {
    const inboxId = ulid();
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "shopify.accept",
      inboxId,
      {
        version: 1,
        operation: "shopify.accept",
        inboxId,
        webhookId: input.webhookId,
        eventId: input.eventId,
        topic: input.topic,
        shopDomain: input.shopDomain,
        shopReferenceHmac: input.shopReferenceHmac,
        apiVersion: input.apiVersion,
        bodySha256: input.bodySha256,
        shopId: input.shopId,
        customerReference: input.customerReference,
        customerContactHmac: input.customerContactHmac,
        orderReferences: input.orderReferences,
        dataRequestReference: input.dataRequestReference,
        receivedAt: input.receivedAt,
      },
    );
    const result = await this.db.query<{
      inbox_id: unknown;
      status: unknown;
      duplicate: unknown;
      target_count: unknown;
    }>(
      `select * from control_plane.accept_attested_shopify_compliance_webhook(
         $1, $2, $3, $4, $5
       )`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
    const row = result.rows[0];
    const targetCount = Number(row?.target_count);
    if (
      typeof row?.inbox_id !== "string" ||
      (row.status !== "dispatched" && row.status !== "unresolved") ||
      typeof row.duplicate !== "boolean" ||
      !Number.isSafeInteger(targetCount) || targetCount < 0
    ) {
      throw new Error("shopify_compliance_receipt_invalid");
    }
    return Object.freeze({
      inboxId: row.inbox_id,
      status: row.status,
      duplicate: row.duplicate,
      targetCount,
    });
  }
}

export class ShopifyComplianceWebhookIngress {
  constructor(private readonly dependencies: Readonly<{
    clientSecret: string;
    store: Pick<ShopifyComplianceWebhookStore, "accept">;
  }>) {
    if (dependencies.clientSecret.trim().length < 16) {
      throw new Error("shopify_webhook_secret_invalid");
    }
  }

  async accept(
    body: Uint8Array,
    headers: Headers,
    receivedAt: string,
  ): Promise<AcceptedShopifyComplianceWebhook> {
    return await this.dependencies.store.accept(normalizePayload({
      body,
      headers,
      clientSecret: this.dependencies.clientSecret,
      receivedAt,
    }));
  }
}
