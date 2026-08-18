/** Live smoke test: official Xero MCP against the Ashburton Cycles connection. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { XeroConnector } from "../connectors/xero/index.js";
import { loadEncodedAes256Keyring } from "../packages/security/src/index.js";
import { resolveXeroMcpCredential } from "../packages/xero-mcp/src/credential.js";
import { openXeroMcpSession } from "../packages/xero-mcp/src/session.js";
import {
  AesKeyringWrapper,
  EnvelopeCryptography,
  PostgresCredentialVault,
} from "../services/sync-workers/src/credential-vault.js";
import { PgTransactionalDatabase } from "../services/sync-workers/src/postgres.js";

const ORGANISATION = "Ashburton Cycles";
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
    applicationName: "xero-mcp-smoke",
    assumedRole: "albert_control_migration_owner",
    maxConnections: 1,
  });
  try {
    const keyring = loadEncodedAes256Keyring({
      currentKey: required(values, "TOKEN_ENCRYPTION_KEY"),
      currentKeyId: required(values, "TOKEN_ENCRYPTION_KEY_ID"),
      previousKeysJson: values.TOKEN_PREVIOUS_ENCRYPTION_KEYS,
      keyName: "TOKEN_ENCRYPTION_KEY",
      keyIdName: "TOKEN_ENCRYPTION_KEY_ID",
      previousKeysName: "TOKEN_PREVIOUS_ENCRYPTION_KEYS",
      maxPreviousKeys: 4,
    });
    const vault = new PostgresCredentialVault(
      database,
      new EnvelopeCryptography(new AesKeyringWrapper({
        currentKeyReference: "env:TOKEN_ENCRYPTION_KEY",
        currentKeyVersion: keyring.currentKeyId,
        encodedKeys: keyring.keys,
      })),
    );
    const connector = new XeroConnector({
      clientId: required(values, "XERO_CLIENT_ID"),
      oauthMode: "pkce",
      vault,
    });
    const resolved = await resolveXeroMcpCredential({
      tenantId: TENANT_ID,
      db: database,
      vault,
      connector,
    });
    if (resolved.organisation.displayName.toLowerCase() !== ORGANISATION.toLowerCase()) {
      throw new Error(`Expected ${ORGANISATION}; found ${resolved.organisation.displayName}`);
    }
    const session = await openXeroMcpSession(resolved.accessToken);
    try {
      const tools = await session.listTools();
      const readTools = tools.filter((tool) => tool.name.startsWith("list-") || tool.name.startsWith("get-"));
      const org = await session.callTool("list-organisation-details", {});
      if (org.isError) throw new Error(org.text);
      const named = /Name:\s*(.+)/u.exec(org.text)?.[1]?.trim() ?? "";
      if (!named.toLowerCase().includes("ashburton")) {
        throw new Error("Xero MCP did not return Ashburton Cycles organisation details.");
      }
      console.log(`xero-mcp-ok organisation=${named} readTools=${readTools.length}`);
    } finally {
      await session.close();
    }
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
