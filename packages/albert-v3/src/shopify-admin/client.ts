import { ulid } from "ulid";

import { signInternalRequest } from "../../../security/src/index.js";
import {
  shopifyAdminCatalogueInputSchema,
  shopifyAdminQueryInputSchema,
  shopifyAdminServiceResultSchema,
  shopifyAdminStoreCatalogueResultSchema,
  type ShopifyAdminCatalogueInput,
  type ShopifyAdminQueryInput,
  type ShopifyAdminServiceResult,
  type ShopifyAdminStoreCatalogueResult,
} from "../../../shopify-admin/src/contract.js";

export class ShopifyAdminServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ShopifyAdminServiceError";
  }
}

export type ShopifyAdminClientContext = Readonly<{
  tenantId: string;
  actorId: string;
  role: "owner" | "manager";
  conversationId: string;
  turnId: string;
}>;

export class ShopifyAdminClient {
  constructor(
    private readonly baseUrl: string,
    private readonly signingSecret: string,
    private readonly context: ShopifyAdminClientContext,
  ) {
    if (Buffer.byteLength(signingSecret, "utf8") < 32) {
      throw new Error("Shopify Admin signing secret must contain at least 32 UTF-8 bytes.");
    }
  }

  async search(input: ShopifyAdminCatalogueInput, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
    return this.request("/v1/shopify-admin/catalogue", {
      requestId: ulid(),
      tenantId: this.context.tenantId,
      actorId: this.context.actorId,
      role: this.context.role,
      conversationId: this.context.conversationId,
      turnId: this.context.turnId,
      input: shopifyAdminCatalogueInputSchema.parse(input),
    }, 12_000, signal) as Promise<Readonly<Record<string, unknown>>>;
  }

  async listStores(signal?: AbortSignal): Promise<ShopifyAdminStoreCatalogueResult> {
    const raw = await this.request("/v1/shopify-admin/stores", {
      requestId: ulid(),
      tenantId: this.context.tenantId,
      actorId: this.context.actorId,
      role: this.context.role,
      conversationId: this.context.conversationId,
      turnId: this.context.turnId,
    }, 12_000, signal);
    return shopifyAdminStoreCatalogueResultSchema.parse(raw);
  }

  async execute(
    input: ShopifyAdminQueryInput,
    options: Readonly<{ connectionId?: string; signal?: AbortSignal }> = {},
  ): Promise<ShopifyAdminServiceResult> {
    const raw = await this.request("/v1/shopify-admin/query", {
      requestId: ulid(),
      tenantId: this.context.tenantId,
      actorId: this.context.actorId,
      role: this.context.role,
      conversationId: this.context.conversationId,
      turnId: this.context.turnId,
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      input: shopifyAdminQueryInputSchema.parse(input),
    }, 30_000, options.signal);
    return shopifyAdminServiceResultSchema.parse(raw);
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
      throw new ShopifyAdminServiceError(
        typeof error === "object" && error?.message ? error.message : "The governed Shopify store lookup was rejected.",
        response.status,
        typeof error === "object" && error?.code ? error.code : "shopify_admin_unavailable",
        typeof error === "object" ? error.details : undefined,
      );
    }
    if (!payload || !("result" in payload)) {
      throw new ShopifyAdminServiceError(
        "The governed Shopify store lookup returned an invalid response.",
        502,
        "shopify_admin_response_invalid",
      );
    }
    return payload.result;
  }
}
