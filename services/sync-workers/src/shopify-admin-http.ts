import { createHash } from "node:crypto";

import { verifyInternalRequest } from "../../../packages/security/src/index.js";
import {
  createDeadlineSignal,
  raceWithSignal,
  type ConnectorContext,
} from "../../../packages/connector-sdk/src/index.js";
import {
  SHOPIFY_ADMIN_MAX_RESPONSE_BYTES,
  SHOPIFY_ADMIN_MAX_RESULT_LEAVES,
  shopifyAdminCatalogueInvocationSchema,
  shopifyAdminInvocationSchema,
  shopifyAdminStoreCatalogueInvocationSchema,
} from "../../../packages/shopify-admin/src/contract.js";
import {
  compileShopifyAdminQuery,
  countShopifyAdminResultLeaves,
  searchShopifyAdminCatalogue,
  ShopifyAdminPolicyError,
} from "../../../connectors/shopify/admin-query.js";
import { ShopifyConnector } from "../../../connectors/shopify/index.js";
import { shopifyManifest } from "../../../connectors/shopify/manifest.js";
import type { ProductionConnectorRegistry } from "./connector-factory.js";
import type { ControlPlaneStore } from "./control-plane-store.js";
import type { ShopifyAdminRuntimeBinding, ShopifyAdminRuntimeStore } from "./shopify-admin-store.js";

const MAX_REQUEST_BYTES = 48 * 1024;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function result(value: unknown, status = 200): Response {
  return Response.json({ result: value }, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

function safeMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    shopify_admin_actor_not_authorized: "Owner or manager access is required for live Shopify store lookups.",
    shopify_admin_level2_approval_required: "The Shopify app does not have active Level-2 protected-customer-data approval evidence for these fields.",
    shopify_admin_connection_not_found: "No eligible Shopify connection is available.",
    shopify_admin_connection_ambiguous: "More than one Shopify store is connected; select a store before running this lookup.",
    shopify_admin_connection_selection_not_catalogued: "List the connected Shopify stores in this turn before selecting one.",
    shopify_admin_required_scope_missing: "The Shopify grant does not include every scope required by these fields.",
    shopify_admin_request_replayed: "This Shopify Admin request has already been used.",
    shopify_admin_turn_limit_exceeded: "This turn has reached the live Shopify lookup limit.",
    shopify_admin_catalogue_limit_exceeded: "This turn has reached the Shopify Admin catalogue-search limit.",
    shopify_admin_timeout: "Shopify did not complete the bounded lookup in time.",
    shopify_admin_response_too_large: "The Shopify result exceeded the governed response limit.",
    shopify_admin_result_too_many_leaves: "The Shopify result contained too many values for one governed lookup.",
    shopify_admin_binding_stale: "The Shopify connection or caller authorization changed while the lookup was running.",
  };
  return messages[code] ?? "The governed Shopify store lookup is unavailable.";
}

function error(code: string, status: number): Response {
  return Response.json({ error: { code, message: safeMessage(code) } }, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

function publicCode(value: unknown): string {
  if (value instanceof ShopifyAdminPolicyError) return `shopify_admin_${value.code}`;
  const raw = value instanceof Error ? value.message.split(":", 1)[0] : "shopify_admin_unavailable";
  return /^shopify_admin_[a-z0-9_]+$/u.test(raw) ? raw : "shopify_admin_unavailable";
}

function statusFor(code: string): number {
  if (code === "shopify_admin_actor_not_authorized") return 403;
  if (code.endsWith("_not_found")) return 404;
  if (code.includes("ambiguous") || code.includes("replayed") || code.includes("stale") || code.includes("not_catalogued")) return 409;
  if (code.includes("limit_exceeded")) return 429;
  if (code.includes("timeout")) return 504;
  if (code.includes("response_too_large") || code.includes("too_many_leaves")) return 413;
  if (
    code.includes("invalid") || code.includes("unknown") || code.includes("excluded")
    || code.includes("unsupported") || code.includes("required") || code.includes("duplicate")
    || code.includes("restricted") || code.includes("documented") || code.includes("limit")
  ) return code.includes("approval") || code.includes("scope") ? 403 : 400;
  return 503;
}

export class ShopifyAdminWorkerHttpHandler {
  private readonly appClientIdSha256: string;

  constructor(private readonly dependencies: Readonly<{
    signingSecret: string;
    shopifyClientId: string;
    store: ShopifyAdminRuntimeStore;
    connectors: ProductionConnectorRegistry;
    control: ControlPlaneStore;
    operationTimeoutMs?: number;
  }>) {
    if (Buffer.byteLength(dependencies.signingSecret, "utf8") < 32) {
      throw new Error("ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET must contain at least 32 UTF-8 bytes.");
    }
    if (!dependencies.shopifyClientId.trim()) throw new Error("SHOPIFY_CLIENT_ID is required for Admin protected-data approval binding.");
    this.appClientIdSha256 = digest(dependencies.shopifyClientId.trim());
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return error("method_not_allowed", 405);
    const url = new URL(request.url);
    if (!["/v1/shopify-admin/stores", "/v1/shopify-admin/catalogue", "/v1/shopify-admin/query"].includes(url.pathname)) return error("not_found", 404);
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

    if (url.pathname === "/v1/shopify-admin/stores") {
      const parsed = shopifyAdminStoreCatalogueInvocationSchema.safeParse(payload);
      if (!parsed.success) return error("invalid_request", 400);
      try {
        const stores = await this.dependencies.store.listConnections(parsed.data);
        return result({ stores });
      } catch (caught) {
        const code = publicCode(caught);
        return error(code, statusFor(code));
      }
    }

    if (url.pathname === "/v1/shopify-admin/catalogue") {
      const parsed = shopifyAdminCatalogueInvocationSchema.safeParse(payload);
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
        return result(searchShopifyAdminCatalogue(parsed.data.input));
      } catch (caught) {
        const code = publicCode(caught);
        return error(code, statusFor(code));
      }
    }

    const parsed = shopifyAdminInvocationSchema.safeParse(payload);
    if (!parsed.success) return error("invalid_request", 400);
    const started = Date.now();
    const deadline = createDeadlineSignal(this.dependencies.operationTimeoutMs ?? 25_000);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal;
    let binding: ShopifyAdminRuntimeBinding | undefined;
    try {
      const compiled = compileShopifyAdminQuery(parsed.data.input);
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
        rootField: compiled.rootField,
        selectedFieldCount: compiled.selectedPaths.length,
        requiredScopes: compiled.requiredScopes,
        requiredScopeGroups: compiled.requiredScopeGroups,
        requiresLevel2: compiled.requiresLevel2,
        appClientIdSha256: this.appClientIdSha256,
      });
      const connector = this.dependencies.connectors.get("shopify", {
        externalAccountReference: binding.externalAccountReference,
      });
      if (!(connector instanceof ShopifyConnector)) throw new Error("shopify_admin_connector_invalid");
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
      // The reservation is deliberately revalidated at the last possible
      // moment. A manual-activation revocation or deletion-continuity block
      // that lands after reservation must prevent the vendor request.
      await this.dependencies.store.assertCurrent(binding);
      const vendor = await raceWithSignal(() => connector.execute_admin_query(context, compiled), signal);
      const resultLeafCount = countShopifyAdminResultLeaves(vendor.data);
      if (resultLeafCount > SHOPIFY_ADMIN_MAX_RESULT_LEAVES) throw new Error("shopify_admin_result_too_many_leaves");
      await this.dependencies.store.assertCurrent(binding);
      const scopeEvidenceDigest = digest(vendor.liveGrantedScopes.join("\n"));
      const output = {
        requestId: parsed.data.requestId,
        apiVersion: compiled.apiVersion,
        registrySha256: compiled.registrySha256,
        queryDigest: compiled.queryDigest,
        scopeEvidenceDigest,
        connection: {
          connectionId: binding.connectionId,
          connectionGeneration: binding.connectionGeneration,
          displayName: binding.displayName,
        },
        approvalEvidenceDigest: binding.approvalEvidenceDigest,
        rootField: compiled.rootField,
        selectedPaths: compiled.selectedPaths,
        requiredScopes: compiled.requiredScopes,
        accessLimitations: compiled.accessLimitations,
        definitions: compiled.definitions,
        data: vendor.data,
        resultLeafCount,
        executedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      };
      const serialized = JSON.stringify(output);
      const responseBytes = Buffer.byteLength(serialized, "utf8");
      if (responseBytes > SHOPIFY_ADMIN_MAX_RESPONSE_BYTES) {
        await this.dependencies.store.complete({
          requestId: parsed.data.requestId,
          binding,
          status: "response_rejected",
          resultLeafCount,
          responseBytes,
          scopeEvidenceDigest,
          durationMs: Date.now() - started,
          errorCode: "shopify_admin_response_too_large",
        });
        return error("shopify_admin_response_too_large", 413);
      }
      const responseDigest = digest(serialized);
      await this.dependencies.store.complete({
        requestId: parsed.data.requestId,
        binding,
        status: "succeeded",
        resultLeafCount,
        responseBytes,
        responseDigest,
        scopeEvidenceDigest,
        durationMs: Date.now() - started,
      });
      return result({ ...output, responseDigest });
    } catch (caught) {
      const code = signal.aborted ? "shopify_admin_timeout" : publicCode(caught);
      if (binding) {
        await this.dependencies.store.complete({
          requestId: parsed.data.requestId,
          binding,
          status: "failed",
          resultLeafCount: 0,
          responseBytes: 0,
          durationMs: Date.now() - started,
          errorCode: code,
        }).catch(() => undefined);
      }
      console.error("Governed Shopify Admin request failed", {
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
