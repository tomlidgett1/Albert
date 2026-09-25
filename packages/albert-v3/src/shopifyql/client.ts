import { ulid } from "ulid";
import { signInternalRequest } from "../../../security/src/index.js";
import {
  shopifyQLCatalogueInputSchema,
  shopifyQLQueryInputSchema,
  shopifyQLServiceResultSchema,
  type ShopifyQLCatalogueInput,
  type ShopifyQLQueryInput,
  type ShopifyQLServiceResult,
} from "../../../shopifyql/src/contract.js";

export class ShopifyQLServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ShopifyQLServiceError";
  }
}

export type ShopifyQLClientContext = Readonly<{
  tenantId: string;
  actorId: string;
  role: "owner" | "manager";
  conversationId: string;
  turnId: string;
}>;

export class ShopifyQLClient {
  constructor(
    private readonly baseUrl: string,
    private readonly signingSecret: string,
    private readonly context: ShopifyQLClientContext,
  ) {
    if (Buffer.byteLength(signingSecret, "utf8") < 32) {
      throw new Error("ShopifyQL signing secret must contain at least 32 UTF-8 bytes.");
    }
  }

  async search(input: ShopifyQLCatalogueInput, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
    return this.request("/v1/shopifyql/catalogue", {
      requestId: ulid(),
      tenantId: this.context.tenantId,
      actorId: this.context.actorId,
      role: this.context.role,
      conversationId: this.context.conversationId,
      turnId: this.context.turnId,
      input: shopifyQLCatalogueInputSchema.parse(input),
    }, 12_000, signal) as Promise<Readonly<Record<string, unknown>>>;
  }

  async execute(
    input: ShopifyQLQueryInput,
    options: Readonly<{ connectionId?: string; signal?: AbortSignal }> = {},
  ): Promise<ShopifyQLServiceResult> {
    const raw = await this.request("/v1/shopifyql/query", {
      requestId: ulid(),
      tenantId: this.context.tenantId,
      actorId: this.context.actorId,
      role: this.context.role,
      conversationId: this.context.conversationId,
      turnId: this.context.turnId,
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      input: shopifyQLQueryInputSchema.parse(input),
    }, 40_000, options.signal);
    return shopifyQLServiceResultSchema.parse(raw);
  }

  private async request(
    path: string,
    value: unknown,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const body = JSON.stringify(value);
    const signed = await signInternalRequest({ method: "POST", path, body, secret: this.signingSecret });
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...signed },
      body,
      signal,
    });
    const payload = await response.json().catch(() => null) as
      | { result?: unknown; error?: { code?: string; message?: string; details?: unknown } | string }
      | null;
    if (!response.ok) {
      const error = payload?.error;
      throw new ShopifyQLServiceError(
        typeof error === "object" && error?.message
          ? error.message
          : "The governed Shopify report service rejected the request.",
        response.status,
        typeof error === "object" && error?.code ? error.code : "shopifyql_unavailable",
        typeof error === "object" ? error?.details : undefined,
      );
    }
    if (!payload || !("result" in payload)) {
      throw new ShopifyQLServiceError(
        "The governed Shopify report service returned an invalid response.",
        502,
        "shopifyql_response_invalid",
      );
    }
    return payload.result;
  }
}
