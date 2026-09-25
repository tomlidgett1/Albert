import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { xeroToolTextFailed } from "./reports.js";
import type { XeroMcpTool, XeroMcpToolResult } from "./types.js";

const OFFICIAL_PACKAGE = "@xeroapi/xero-mcp-server@0.0.17";
const MAX_RESULT_CHARS = 80_000;

export type XeroMcpSession = Readonly<{
  listTools: () => Promise<readonly XeroMcpTool[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<XeroMcpToolResult>;
  close: () => Promise<void>;
}>;

function officialServerLaunch(): Readonly<{ command: string; args: string[]; cwd?: string }> {
  const packageDir = resolve(process.cwd(), ".albert-vendor/package");
  const entry = resolve(packageDir, "dist/index.js");
  if (existsSync(entry)) {
    return { command: process.execPath, args: [entry], cwd: packageDir };
  }
  return { command: "npx", args: ["-y", OFFICIAL_PACKAGE] };
}

function toolText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return JSON.stringify(value).slice(0, MAX_RESULT_CHARS);
  const parts = content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { type?: unknown; text?: unknown };
    return typeof row.text === "string" ? [row.text] : [];
  });
  return parts.join("\n").slice(0, MAX_RESULT_CHARS);
}

export async function openXeroMcpSession(accessToken: string): Promise<XeroMcpSession> {
  const launch = officialServerLaunch();
  const transport = new StdioClientTransport({
    command: launch.command,
    args: [...launch.args],
    cwd: launch.cwd,
    stderr: "pipe",
    env: {
      ...getDefaultEnvironment(),
      XERO_CLIENT_BEARER_TOKEN: accessToken,
    },
  });
  const client = new Client({ name: "albert-xero-mcp", version: "0.1.0" });
  await client.connect(transport);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close().catch(() => undefined);
  };

  return Object.freeze({
    async listTools() {
      const listed = await client.listTools();
      return listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      }));
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const text = toolText(result) || "The Xero MCP tool returned no text.";
      return {
        text,
        isError: Boolean((result as { isError?: boolean }).isError) || xeroToolTextFailed(text),
      };
    },
    close,
  });
}
