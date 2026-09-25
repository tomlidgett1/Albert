import { ulid } from "ulid";
import { XeroWebhookValidationError } from "../../../connectors/xero/webhooks.js";
import {
  ConnectorError,
  type WebhookDisposition,
} from "../../../packages/connector-sdk/src/index.js";
import type { WebhookRawWriter } from "../../../packages/storage/src/index.js";
import {
  DeputyWebhookResolver,
  DeputyWebhookVerifier,
} from "./deputy.js";
import {
  WebhookStore,
  webhookBodySha256,
  type WebhookConnection,
} from "./store.js";
import type { XeroWebhookIngress } from "./xero-inbox.js";
import {
  ShopifyWebhookValidationError,
  type ShopifyComplianceWebhookIngress,
} from "./shopify-compliance.js";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const DEPUTY_PATH = /^\/v1\/webhooks\/deputy\/([0-9A-HJKMNP-TV-Z]{26})\/([0-9A-HJKMNP-TV-Z]{26})$/;

function headers(request: Request): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(request.headers.entries()));
}

function safeHeaders(request: Request): Readonly<Record<string, string>> {
  const allowed = new Set([
    "content-type",
    "user-agent",
    "x-request-id",
    "x-deputy-generation-time",
  ]);
  return Object.freeze(Object.fromEntries(
    [...request.headers.entries()]
      .filter(([name]) => allowed.has(name.toLowerCase()))
      .map(([name, value]) => [
        name.toLowerCase(),
        value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300),
      ]),
  ));
}

function result(status: number, value: unknown): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function webhookBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_WEBHOOK_BYTES) {
    throw new Error("webhook_too_large");
  }
  const value = new Uint8Array(await request.arrayBuffer());
  if (value.byteLength > MAX_WEBHOOK_BYTES) throw new Error("webhook_too_large");
  return value;
}

function errorResponse(error: unknown): Response {
  if (error instanceof ShopifyWebhookValidationError) {
    if (error.code === "signature_invalid") {
      return result(401, { error: "invalid_signature" });
    }
    if (error.code === "topic_unsupported") return result(404, { error: "not_found" });
    return result(400, { error: "invalid_payload" });
  }
  if (error instanceof XeroWebhookValidationError) {
    if (error.code === "signature_invalid") return result(401, { error: "invalid_signature" });
    if (error.code === "payload_too_large") return result(413, { error: "payload_too_large" });
    return result(400, { error: "invalid_payload" });
  }
  if (error instanceof ConnectorError) {
    if (error.code === "WEBHOOK_SIGNATURE_INVALID") return result(401, { error: "invalid_signature" });
    if (error.code === "REMOTE_RESPONSE_INVALID") return result(400, { error: "invalid_payload" });
    if (error.code === "CONFIGURATION_INVALID") return result(503, { error: "gateway_not_ready" });
  }
  if (error instanceof Error && error.message === "webhook_too_large") {
    return result(413, { error: "payload_too_large" });
  }
  if (error instanceof Error && error.message === "deputy_connection_not_found") {
    return result(404, { error: "not_found" });
  }
  return result(503, { error: "temporarily_unavailable" });
}

export class WebhookGatewayHandler {
  constructor(private readonly dependencies: Readonly<{
    store: Pick<WebhookStore, "reserve" | "attachRaw" | "finalize" | "markFailed">;
    xero: Pick<XeroWebhookIngress, "accept">;
    shopify: Pick<ShopifyComplianceWebhookIngress, "accept">;
    deputy: Readonly<{
      resolver: Pick<DeputyWebhookResolver, "resolve">;
      verifier: Pick<DeputyWebhookVerifier, "verify">;
    }>;
    raw: Pick<WebhookRawWriter, "put">;
  }>) {}

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return result(405, { error: "method_not_allowed" });
    try {
      const pathname = new URL(request.url).pathname;
      const body = await webhookBody(request);
      const receivedAt = new Date().toISOString();
      const event = {
        id: request.headers.get("x-request-id")?.slice(0, 160) || ulid(),
        receivedAt,
        headers: headers(request),
        body,
      } as const;

      if (pathname === "/v1/webhooks/xero") {
        // Xero must receive an acknowledgement within five seconds. This path
        // authenticates the exact bytes and commits only an encrypted,
        // tenant-neutral inbox item; resolution, raw storage, and fan-out are
        // performed by the leased background processor.
        const accepted = await this.dependencies.xero.accept(
          body,
          request.headers.get("x-xero-signature"),
          receivedAt,
        );
        return result(200, {
          accepted: true,
          queued: accepted.status !== "processed",
          duplicate: !accepted.created,
          intentToReceive: accepted.intentToReceive,
        });
      }

      if (pathname === "/v1/webhooks/shopify/compliance") {
        // Compliance is always on, including before Start ingestion and after
        // uninstall. Authentication uses only the app secret and exact bytes;
        // the accepted envelope never enters raw source storage.
        const accepted = await this.dependencies.shopify.accept(
          body,
          request.headers,
          receivedAt,
        );
        return result(200, {
          accepted: true,
          duplicate: accepted.duplicate,
          status: accepted.status,
        });
      }

      const deputyMatch = DEPUTY_PATH.exec(pathname);
      if (deputyMatch) {
        const connection = await this.dependencies.deputy.resolver.resolve(
          deputyMatch[1]!,
          deputyMatch[2]!,
        );
        if (!connection) throw new Error("deputy_connection_not_found");
        const disposition = await this.dependencies.deputy.verifier.verify(connection, event);
        const routed = await this.persistAndRoute(
          request,
          connection,
          disposition,
          body,
          receivedAt,
          null,
          connection.materialId,
        );
        return result(200, { accepted: true, routed });
      }
      return result(404, { error: "not_found" });
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async persistAndRoute(
    request: Request,
    connection: WebhookConnection,
    disposition: WebhookDisposition,
    body: Uint8Array,
    receivedAt: string,
    vendorEventId?: string | null,
    verificationReference?: string,
  ): Promise<number> {
    const bodySha256 = webhookBodySha256(body);
    const reservation = await this.dependencies.store.reserve({
      connection,
      dedupeKey: disposition.dedupeKey ?? `${connection.connectorKey}:${bodySha256}`,
      vendorEventId: vendorEventId === null
        ? undefined
        : (vendorEventId ?? request.headers.get("x-request-id")?.slice(0, 300)) || undefined,
      bodySha256,
      verificationReference: verificationReference ?? connection.connectionId,
      safeHeaders: safeHeaders(request),
      receivedAt,
    });
    if (reservation.status === "queued" || reservation.status === "ignored") return 0;
    try {
      if (!reservation.rawObjectKey) {
        const raw = await this.dependencies.raw.put({
          tenantId: connection.tenantId,
          connectionId: connection.connectionId,
          receiptId: reservation.receiptId,
          connectorKey: connection.connectorKey,
          receivedAt: reservation.receivedAt,
          body,
          authority: {
            verificationReference: verificationReference ?? connection.connectionId,
          },
        });
        if (raw.bodySha256 !== bodySha256) throw new Error("webhook_raw_hash_mismatch");
        await this.dependencies.store.attachRaw(
          connection,
          reservation.receiptId,
          raw.objectKey,
          verificationReference ?? connection.connectionId,
        );
      }
      return await this.dependencies.store.finalize({
        connection,
        receiptId: reservation.receiptId,
        streams: disposition.streams,
        receivedAt: reservation.receivedAt,
        accepted: disposition.accepted,
        reconciliationSignals: disposition.reconciliationSignals,
      });
    } catch (error) {
      await this.dependencies.store.markFailed(
        connection,
        reservation.receiptId,
        verificationReference ?? connection.connectionId,
      ).catch(() => undefined);
      throw error;
    }
  }
}
