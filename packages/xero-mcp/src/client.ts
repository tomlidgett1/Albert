import { ulid } from "ulid";
import { signInternalRequest } from "../../security/src/index.js";
import type { XeroMcpOrganisation, XeroMcpTool, XeroMcpToolResult } from "./types.js";

export class XeroMcpServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "XeroMcpServiceError";
  }
}

export type XeroMcpClientContext = Readonly<{
  tenantId: string;
  actorId: string;
  role: "owner" | "manager" | "bookkeeper" | "internal_operator";
  conversationId: string;
  turnId: string;
}>;

/**
 * Where live Xero MCP calls go, in every environment:
 *   1. XERO_MCP_SERVICE_URL — explicit override (e.g. the local sidecar from
 *      `npm run dev:xero-mcp` while working on the MCP layer itself);
 *   2. SYNC_WORKER_INTERNAL_URL — the credential-owning sync worker, which
 *      serves /v1/xero-mcp/* on Vercel AND on localhost (.env.local points at
 *      the same Fly worker the rest of the dash already talks to);
 *   3. the local sidecar as a last resort when neither is configured.
 * Previously localhost always demanded the sidecar, so Xero MCP "worked in
 * production but not locally" even though the worker was reachable.
 */
export function xeroMcpServiceUrl(): string {
  const explicit = process.env.XERO_MCP_SERVICE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/u, "");
  const worker = process.env.SYNC_WORKER_INTERNAL_URL?.trim();
  if (worker) return worker.replace(/\/+$/u, "");
  return "http://127.0.0.1:8791";
}

export class XeroMcpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly signingSecret: string,
    private readonly context: XeroMcpClientContext,
  ) {
    if (Buffer.byteLength(signingSecret, "utf8") < 32) {
      throw new Error("Xero MCP signing secret must contain at least 32 UTF-8 bytes.");
    }
  }

  async listTools(signal?: AbortSignal): Promise<Readonly<{
    organisation: XeroMcpOrganisation;
    tools: readonly XeroMcpTool[];
  }>> {
    return this.request("/v1/xero-mcp/tools", {
      requestId: ulid(),
      tenantId: this.context.tenantId,
      actorId: this.context.actorId,
      role: this.context.role,
      conversationId: this.context.conversationId,
      turnId: this.context.turnId,
    }, 45_000, signal) as Promise<Readonly<{
      organisation: XeroMcpOrganisation;
      tools: readonly XeroMcpTool[];
    }>>;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<XeroMcpToolResult & { organisation: XeroMcpOrganisation; name: string }> {
    return this.request("/v1/xero-mcp/call", {
      requestId: ulid(),
      tenantId: this.context.tenantId,
      actorId: this.context.actorId,
      role: this.context.role,
      conversationId: this.context.conversationId,
      turnId: this.context.turnId,
      name,
      arguments: args,
    }, 75_000, signal) as Promise<XeroMcpToolResult & {
      organisation: XeroMcpOrganisation;
      name: string;
    }>;
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
    let response: Response;
    try {
      response = await fetch(new URL(path, `${this.baseUrl}/`), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...signed },
        body,
        signal,
      });
    } catch {
      throw new XeroMcpServiceError(
        this.baseUrl.includes("127.0.0.1") || this.baseUrl.includes("localhost")
          ? "The local Xero MCP service is not running. Start it with npm run dev:xero-mcp, "
            + "or set SYNC_WORKER_INTERNAL_URL / XERO_MCP_SERVICE_URL to the sync worker."
          : "The Xero MCP service could not be reached.",
        503,
        "xero_mcp_unavailable",
      );
    }
    const payload = await response.json().catch(() => null) as
      | { result?: unknown; error?: { code?: string; message?: string } | string }
      | null;
    if (!response.ok) {
      const error = payload?.error;
      throw new XeroMcpServiceError(
        typeof error === "object" && error?.message
          ? error.message
          : "The Xero MCP service rejected the request.",
        response.status,
        typeof error === "object" && error?.code ? error.code : "xero_mcp_unavailable",
      );
    }
    if (!payload || !("result" in payload)) {
      throw new XeroMcpServiceError(
        "The Xero MCP service returned an invalid response.",
        502,
        "xero_mcp_response_invalid",
      );
    }
    return payload.result;
  }
}
