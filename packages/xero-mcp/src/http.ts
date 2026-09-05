import { z } from "zod";
import { verifyInternalRequest } from "../../security/src/index.js";
import { XeroConnector } from "../../../connectors/xero/index.js";
import type { WorkerCredentialVault } from "../../connector-sdk/src/index.js";
import { resolveXeroMcpCredential } from "./credential.js";
import { normaliseProfitAndLossArgs } from "./reports.js";
import { openXeroMcpSession, type XeroMcpSession } from "./session.js";
import type { XeroMcpOrganisation, XeroMcpTool } from "./types.js";

const MAX_REQUEST_BYTES = 48 * 1024;
const SESSION_TTL_MS = 4 * 60_000;

const invocationSchema = z.object({
  requestId: z.string().min(1).max(80),
  tenantId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  actorId: z.string().uuid(),
  role: z.enum(["owner", "manager", "bookkeeper", "internal_operator"]),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  turnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
}).strict();

const callSchema = invocationSchema.extend({
  name: z.string().trim().min(1).max(120),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict();

type CachedSession = {
  session: XeroMcpSession;
  organisation: XeroMcpOrganisation;
  tools: readonly XeroMcpTool[];
  expiresAt: number;
  queue: Promise<unknown>;
};

function result(value: unknown, status = 200): Response {
  return Response.json({ result: value }, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

function error(code: string, status: number, message?: string): Response {
  return Response.json({
    error: { code, message: message ?? publicMessage(code) },
  }, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

function publicMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    xero_mcp_actor_not_authorized: "A workspace role is required to ask Xero live questions.",
    xero_mcp_connection_not_found: "No connected Xero organisation is available.",
    xero_mcp_token_missing: "The Xero connection needs to be reconnected.",
    xero_mcp_tool_not_found: "That Xero MCP tool is not available in this test mode.",
    xero_mcp_unavailable: "The official Xero MCP server could not be reached.",
    unauthorised: "The Xero MCP request was rejected.",
    invalid_request: "The Xero MCP request was invalid.",
  };
  return messages[code] ?? "The Xero MCP test is unavailable.";
}

function publicCode(value: unknown): string {
  const raw = value instanceof Error ? value.message.split(":", 1)[0] : "xero_mcp_unavailable";
  return /^xero_mcp_[a-z0-9_]+$/u.test(raw) ? raw : "xero_mcp_unavailable";
}

function statusFor(code: string): number {
  if (code === "xero_mcp_actor_not_authorized" || code === "unauthorised") return 403;
  if (code.endsWith("_not_found")) return 404;
  if (code.includes("invalid")) return 400;
  return 503;
}

function isReadTool(name: string): boolean {
  return name.startsWith("list-") || name.startsWith("get-");
}

export class XeroMcpWorkerHttpHandler {
  private readonly sessions = new Map<string, CachedSession>();

  constructor(private readonly dependencies: Readonly<{
    signingSecret: string;
    store: {
      query<T extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[],
      ): Promise<Readonly<{ rows: readonly T[] }>>;
    };
    vault: WorkerCredentialVault;
    connectors: { get(provider: "xero"): unknown };
  }>) {
    if (Buffer.byteLength(dependencies.signingSecret, "utf8") < 32) {
      throw new Error("Xero MCP signing secret must contain at least 32 UTF-8 bytes.");
    }
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return error("method_not_allowed", 405);
    const url = new URL(request.url);
    if (!["/v1/xero-mcp/tools", "/v1/xero-mcp/call"].includes(url.pathname)) {
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

    try {
      if (url.pathname === "/v1/xero-mcp/tools") {
        const parsed = invocationSchema.safeParse(payload);
        if (!parsed.success) return error("invalid_request", 400);
        await this.assertMember(parsed.data.tenantId, parsed.data.actorId, parsed.data.role);
        const cached = await this.sessionFor(parsed.data.tenantId, request.signal);
        return result({
          organisation: cached.organisation,
          tools: cached.tools,
        });
      }
      const parsed = callSchema.safeParse(payload);
      if (!parsed.success) return error("invalid_request", 400);
      if (!isReadTool(parsed.data.name)) return error("xero_mcp_tool_not_found", 404);
      await this.assertMember(parsed.data.tenantId, parsed.data.actorId, parsed.data.role);
      const cached = await this.sessionFor(parsed.data.tenantId, request.signal);
      const tool = cached.tools.find((item) => item.name === parsed.data.name);
      if (!tool) return error("xero_mcp_tool_not_found", 404);
      const requested = parsed.data.arguments ?? {};
      const toolArgs = parsed.data.name === "list-profit-and-loss"
        ? { ...normaliseProfitAndLossArgs(requested).arguments }
        : requested;
      const output = await this.enqueue(cached, () => (
        cached.session.callTool(parsed.data.name, toolArgs)
      ));
      return result({
        organisation: cached.organisation,
        name: parsed.data.name,
        ...output,
      });
    } catch (caught) {
      const code = publicCode(caught);
      return error(code, statusFor(code));
    }
  }

  private async assertMember(
    tenantId: string,
    actorId: string,
    role: string,
  ): Promise<void> {
    const membership = await this.dependencies.store.query<{ role: string }>(
      `select role
         from control_plane.memberships
        where tenant_id=$1 and user_id=$2::uuid and status='active'`,
      [tenantId, actorId],
    );
    if (membership.rows[0]?.role !== role) throw new Error("xero_mcp_actor_not_authorized");
  }

  private async sessionFor(tenantId: string, signal?: AbortSignal): Promise<CachedSession> {
    const existing = this.sessions.get(tenantId);
    if (existing && existing.expiresAt > Date.now()) {
      existing.expiresAt = Date.now() + SESSION_TTL_MS;
      return existing;
    }
    if (existing) await existing.session.close().catch(() => undefined);
    const connector = this.dependencies.connectors.get("xero");
    if (!(connector instanceof XeroConnector)) throw new Error("xero_mcp_unavailable");
    const resolved = await resolveXeroMcpCredential({
      tenantId,
      db: this.dependencies.store,
      vault: this.dependencies.vault,
      connector,
      signal,
    });
    const session = await openXeroMcpSession(resolved.accessToken);
    const tools = (await session.listTools()).filter((tool) => isReadTool(tool.name));
    const cached: CachedSession = {
      session,
      organisation: resolved.organisation,
      tools,
      expiresAt: Date.now() + SESSION_TTL_MS,
      queue: Promise.resolve(),
    };
    this.sessions.set(tenantId, cached);
    return cached;
  }

  private enqueue<T>(cached: CachedSession, work: () => Promise<T>): Promise<T> {
    const run = cached.queue.then(work, work);
    cached.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
