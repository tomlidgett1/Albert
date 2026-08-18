/** Signed HTTP smoke against the local official Xero MCP sidecar. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ulid } from "ulid";

import { XeroMcpClient } from "../packages/xero-mcp/src/client.js";
import { runXeroMcpTurn } from "../packages/xero-mcp/src/agent.js";
import { PgTransactionalDatabase } from "../services/sync-workers/src/postgres.js";

const TENANT_ID = "01KZN20VTX2EWW1TQ2AA3MCPW6";

function environment(): Record<string, string> {
  const values = { ...process.env } as Record<string, string>;
  let contents = "";
  try { contents = readFileSync(resolve(".env.local"), "utf8"); } catch { return values; }
  for (const line of contents.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]!] ??= value;
  }
  return values;
}

function required(values: Record<string, string>, name: string): string {
  const value = values[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function poolerUrl(value: string): URL {
  const url = new URL(value);
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/u.exec(url.hostname);
  if (direct) {
    const projectRef = direct[1]!;
    const username = decodeURIComponent(url.username);
    url.hostname = "aws-0-ap-southeast-2.pooler.supabase.com";
    url.port = "5432";
    if (!username.endsWith(`.${projectRef}`)) url.username = `${username}.${projectRef}`;
  }
  return url;
}

async function main(): Promise<void> {
  const values = environment();
  const controlUrl = values.CONTROL_PLANE_MIGRATION_URL || required(values, "CONTROL_PLANE_ADMIN_DATABASE_URL");
  const database = new PgTransactionalDatabase(poolerUrl(controlUrl).toString(), {
    applicationName: "xero-mcp-http-smoke",
    assumedRole: "albert_control_migration_owner",
    maxConnections: 1,
  });
  try {
    const owner = await database.query<{ user_id: string; role: string }>(
      `select user_id::text as user_id, role
         from control_plane.memberships
        where tenant_id = $1 and status = 'active' and role = 'owner'
        limit 1`,
      [TENANT_ID],
    );
    const member = owner.rows[0];
    if (!member) throw new Error("No active owner for Ashburton Cycles");
    const conversationId = ulid();
    const turnId = ulid();
    const client = new XeroMcpClient("http://127.0.0.1:8791", required(values, "ALBERT_OAUTH_WORKER_SIGNING_SECRET"), {
      tenantId: TENANT_ID,
      actorId: member.user_id,
      role: "owner",
      conversationId,
      turnId,
    });
    const tools = await client.listTools();
    if (!tools.organisation.displayName.toLowerCase().includes("ashburton")) {
      throw new Error("HTTP tools did not resolve Ashburton Cycles");
    }
    const org = await client.callTool("list-organisation-details", {});
    if (org.isError || !org.text.toLowerCase().includes("ashburton")) {
      throw new Error("HTTP list-organisation-details failed");
    }
    console.log(`xero-mcp-http-ok organisation=${tools.organisation.displayName} tools=${tools.tools.length}`);

    const events: string[] = [];
    const result = await runXeroMcpTurn({
      message: "What is the organisation name and base currency in Xero?",
      conversation: [],
      preferences: { model: "gpt-5.6-luna", reasoningEffort: "low", fastMode: true },
      client,
      openaiApiKey: required(values, "OPENAI_API_KEY"),
      openaiBaseUrl: values.OPENAI_BASE_URL || "https://api.openai.com/v1",
      emit: (async (event) => {
        events.push(event.type);
        return {
          ...event,
          id: ulid(),
          sequence: events.length,
          occurredAt: new Date().toISOString(),
        } as never;
      }) as never,
    });
    if (!result.answerText.toLowerCase().includes("ashburton")) {
      throw new Error(`Agent answer missed Ashburton: ${result.answerText.slice(0, 200)}`);
    }
    console.log(`xero-mcp-agent-ok toolsUsed=${result.toolsUsed} events=${events.join(",")}`);
    console.log(result.answerText.slice(0, 400));
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
