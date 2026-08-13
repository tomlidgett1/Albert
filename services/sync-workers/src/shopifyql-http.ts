import { createHash } from "node:crypto";

import { verifyInternalRequest } from "../../../packages/security/src/index.js";
import {
  createDeadlineSignal,
  raceWithSignal,
  type ConnectorContext,
} from "../../../packages/connector-sdk/src/index.js";
import {
  SHOPIFYQL_MAX_RESPONSE_BYTES,
  shopifyQLCatalogueInvocationSchema,
  shopifyQLInvocationSchema,
} from "../../../packages/shopifyql/src/contract.js";
import { shopifyManifest } from "../../../connectors/shopify/manifest.js";
import {
  compileShopifyQLQuery,
  searchShopifyQLCatalogue,
  ShopifyQLPolicyError,
} from "../../../connectors/shopify/shopifyql-query.js";
import {
  ShopifyConnector,
} from "../../../connectors/shopify/index.js";
import type { ProductionConnectorRegistry } from "./connector-factory.js";
import type { ControlPlaneStore } from "./control-plane-store.js";
import type { ShopifyQLRuntimeStore } from "./shopifyql-store.js";

const MAX_REQUEST_BYTES = 32 * 1024;

function result(value: unknown, status = 200): Response {
  return Response.json({ result: value }, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function error(code: string, status: number): Response {
  return Response.json({ error: { code, message: safeMessage(code) } }, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function safeMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    shopifyql_actor_not_authorized: "Owner or manager access is required for live Shopify reports.",
    shopifyql_level2_approval_required: "The Shopify app does not have active Level-2 protected-customer-data approval evidence.",
    shopifyql_connection_not_found: "No eligible Shopify connection is available.",
    shopifyql_connection_ambiguous: "More than one Shopify store is connected; select a store before running this report.",
    shopifyql_connection_selection_not_catalogued: "List the connected Shopify stores in this turn before selecting one.",
    shopifyql_read_reports_required: "The Shopify grant does not include read_reports.",
    shopifyql_request_replayed: "This ShopifyQL request has already been used.",
    shopifyql_turn_limit_exceeded: "This turn has reached the live Shopify report limit.",
    shopifyql_catalogue_limit_exceeded: "This turn has reached the Shopify catalogue-search limit.",
    shopifyql_timeout: "Shopify did not complete the bounded report request in time.",
    shopifyql_response_too_large: "Shopify returned more report data than the governed response limit permits.",
    shopifyql_parse_error: "Shopify rejected the compiled report query.",
    shopifyql_binding_stale: "The Shopify connection or caller authorization changed while the report was running.",
  };
  return messages[code] ?? "The governed Shopify report request is unavailable.";
}

function publicCode(value: unknown): string {
  if (value instanceof ShopifyQLPolicyError) return `shopifyql_${value.code}`;
  const raw = value instanceof Error ? value.message.split(":", 1)[0] : "shopifyql_unavailable";
  return /^shopifyql_[a-z0-9_]+$/u.test(raw) ? raw : "shopifyql_unavailable";
}

function statusFor(code: string): number {
  if (code === "shopifyql_actor_not_authorized") return 403;
  if (code.endsWith("_not_found")) return 404;
  if (code.includes("replayed") || code.includes("ambiguous") || code.includes("stale") || code.includes("not_catalogued")) return 409;
  if (code.includes("limit_exceeded")) return 429;
  if (code.includes("timeout")) return 504;
  if (
    code.includes("invalid") || code.includes("unknown") || code.includes("undocumented") ||
    code.includes("not_selected") || code.includes("not_returned") || code.includes("not_grouped") ||
    code.includes("_metric") || code.includes("arity") || code.includes("duplicate") ||
    code.includes("unsupported") || code.includes("requires_aggregation") ||
    code.includes("required_conditions_missing") || code.includes("too_wide") ||
    code.includes("query_too_large") || code.includes("parse_error")
  ) return 400;
  if (code.includes("required")) return 403;
  return 503;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ShopifyQLWorkerHttpHandler {
  private readonly appClientIdSha256: string;

  constructor(private readonly dependencies: Readonly<{
    signingSecret: string;
    shopifyClientId: string;
    store: ShopifyQLRuntimeStore;
    connectors: ProductionConnectorRegistry;
    control: ControlPlaneStore;
    operationTimeoutMs?: number;
  }>) {
    if (Buffer.byteLength(dependencies.signingSecret, "utf8") < 32) {
      throw new Error("ALBERT_SHOPIFYQL_SIGNING_SECRET must contain at least 32 UTF-8 bytes.");
    }
    if (!dependencies.shopifyClientId.trim()) {
      throw new Error("SHOPIFY_CLIENT_ID is required for ShopifyQL approval binding.");
    }
    this.appClientIdSha256 = digest(dependencies.shopifyClientId.trim());
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return error("method_not_allowed", 405);
    const url = new URL(request.url);
    if (!["/v1/shopifyql/catalogue", "/v1/shopifyql/query"].includes(url.pathname)) {
      return error("not_found", 404);
    }
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) return error("request_too_large", 413);
    const verified = await verifyInternalRequest({
      method: request.method,
      path: url.pathname,
      body,
      secret: this.dependencies.signingSecret,
      timestamp: request.headers.get("x-albert-timestamp"),
      signature: request.headers.get("x-albert-signature"),
      maxSkewMs: 60_000,
    }).catch(() => false);
    if (!verified) return error("unauthorised", 401);

    let payload: unknown;
    try { payload = JSON.parse(body); } catch { return error("invalid_request", 400); }
    if (url.pathname === "/v1/shopifyql/catalogue") {
      const parsed = shopifyQLCatalogueInvocationSchema.safeParse(payload);
      if (!parsed.success) return error("invalid_request", 400);
      try {
        await this.dependencies.store.authorizeCatalogue({
          requestId: parsed.data.requestId,
          tenantId: parsed.data.tenantId,
          actorId: parsed.data.actorId,
          role: parsed.data.role,
          conversationId: parsed.data.conversationId,
          turnId: parsed.data.turnId,
          searchDigest: digest(JSON.stringify(parsed.data.input)),
        });
        return result(searchShopifyQLCatalogue(parsed.data.input));
      } catch (caught) {
        const code = publicCode(caught);
        return error(code, statusFor(code));
      }
    }

    const parsed = shopifyQLInvocationSchema.safeParse(payload);
    if (!parsed.success) return error("invalid_request", 400);
    const started = Date.now();
    const deadline = createDeadlineSignal(this.dependencies.operationTimeoutMs ?? 35_000);
    const signal = request.signal
      ? AbortSignal.any([request.signal, deadline.signal])
      : deadline.signal;
    let binding: Awaited<ReturnType<ShopifyQLRuntimeStore["reserve"]>> | undefined;
    try {
      const compiled = compileShopifyQLQuery(parsed.data.input);
      binding = await this.dependencies.store.reserve({
        requestId: parsed.data.requestId,
        tenantId: parsed.data.tenantId,
        actorId: parsed.data.actorId,
        role: parsed.data.role,
        conversationId: parsed.data.conversationId,
        turnId: parsed.data.turnId,
        ...(parsed.data.connectionId ? { connectionId: parsed.data.connectionId } : {}),
        registrySha256: compiled.registrySha256,
        queryDigest: compiled.queryDigest,
        schema: compiled.schema,
        since: compiled.normalizedInput.timeWindow.since,
        until: compiled.normalizedInput.timeWindow.until,
        rowLimit: compiled.normalizedInput.limit,
        appClientIdSha256: this.appClientIdSha256,
      });
      const connector = this.dependencies.connectors.get("shopify", {
        externalAccountReference: binding.externalAccountReference,
      });
      if (!(connector instanceof ShopifyConnector)) throw new Error("shopifyql_connector_invalid");
      const context: ConnectorContext = {
        tenantId: binding.tenantId,
        connectionId: binding.connectionId,
        credentialRef: binding.credentialRef,
        abortSignal: signal,
        vendorRateBudget: this.dependencies.control.vendorRateBudget(
          binding.tenantId,
          binding.connectionId,
          shopifyManifest,
        ),
      };
      // Re-check explicit activation, generation, membership, PCD approval and
      // deletion/readiness fences immediately before touching Shopify.
      await this.dependencies.store.assertCurrent(binding);
      const vendor = await raceWithSignal(
        () => connector.execute_shopifyql(context, compiled),
        signal,
      );
      // A block that races the vendor request may never expose its result.
      await this.dependencies.store.assertCurrent(binding);
      const rows = vendor.tableData?.rows ?? [];
      if (rows.length > compiled.normalizedInput.limit) throw new Error("shopifyql_response_row_limit_exceeded");
      const output = {
        requestId: parsed.data.requestId,
        apiVersion: compiled.apiVersion,
        registrySha256: compiled.registrySha256,
        queryDigest: compiled.queryDigest,
        schema: compiled.schema,
        connection: {
          connectionId: binding.connectionId,
          connectionGeneration: binding.connectionGeneration,
          displayName: binding.displayName,
        },
        approvalEvidenceDigest: binding.approvalEvidenceDigest,
        timeWindow: compiled.normalizedInput.timeWindow,
        metrics: compiled.metrics,
        dimensions: compiled.dimensions,
        deprecatedFields: compiled.deprecatedFields,
        definitions: compiled.definitions,
        columns: vendor.tableData?.columns ?? [],
        rows,
        rowMetadata: vendor.tableData?.rowMetadata ?? [],
        parseErrors: vendor.parseErrors,
        executedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      };
      const serialized = JSON.stringify(output);
      const responseBytes = Buffer.byteLength(serialized, "utf8");
      if (responseBytes > SHOPIFYQL_MAX_RESPONSE_BYTES) {
        await this.dependencies.store.complete({
          requestId: parsed.data.requestId,
          binding,
          status: "response_rejected",
          rowCount: rows.length,
          responseBytes,
          durationMs: Date.now() - started,
          errorCode: "shopifyql_response_too_large",
        });
        return error("shopifyql_response_too_large", 413);
      }
      const responseDigest = digest(serialized);
      await this.dependencies.store.complete({
        requestId: parsed.data.requestId,
        binding,
        status: vendor.parseErrors.length > 0 ? "parse_error" : "succeeded",
        rowCount: rows.length,
        responseBytes,
        responseDigest,
        durationMs: Date.now() - started,
        ...(vendor.parseErrors.length > 0 ? { errorCode: "shopifyql_parse_error" } : {}),
      });
      return result({ ...output, responseDigest });
    } catch (caught) {
      const code = signal.aborted ? "shopifyql_timeout" : publicCode(caught);
      if (binding) {
        await this.dependencies.store.complete({
          requestId: parsed.data.requestId,
          binding,
          status: "failed",
          rowCount: 0,
          responseBytes: 0,
          durationMs: Date.now() - started,
          errorCode: code,
        }).catch(() => undefined);
      }
      console.error("Governed ShopifyQL request failed", {
        requestId: parsed.data.requestId,
        code,
        errorName: caught instanceof Error ? caught.name : "UnknownError",
      });
      return error(code, statusFor(code));
    } finally {
      deadline.clear();
    }
  }
}
