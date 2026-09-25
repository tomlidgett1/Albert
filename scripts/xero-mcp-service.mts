/** Local official Xero MCP sidecar for the dash XERO MCP test button. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { XeroConnector } from "../connectors/xero/index.js";
import { loadEncodedAes256Keyring } from "../packages/security/src/index.js";
import { XeroMcpWorkerHttpHandler } from "../packages/xero-mcp/src/http.js";
import {
  AesKeyringWrapper,
  EnvelopeCryptography,
  PostgresCredentialVault,
} from "../services/sync-workers/src/credential-vault.js";
import { PgTransactionalDatabase } from "../services/sync-workers/src/postgres.js";

const PORT = Number(process.env.XERO_MCP_SERVICE_PORT ?? 8791);

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

async function toFetchRequest(request: IncomingMessage, body: string): Promise<Request> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const values = environment();
  const controlUrl = values.CONTROL_PLANE_MIGRATION_URL || required(values, "CONTROL_PLANE_ADMIN_DATABASE_URL");
  const database = new PgTransactionalDatabase(poolerUrl(controlUrl).toString(), {
    applicationName: "xero-mcp-service",
    assumedRole: "albert_control_migration_owner",
    maxConnections: 2,
  });
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
  const handler = new XeroMcpWorkerHttpHandler({
    signingSecret: required(values, "ALBERT_OAUTH_WORKER_SIGNING_SECRET"),
    store: database,
    vault,
    connectors: { get: () => connector },
  });

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`).pathname;
      if (request.method === "GET" && pathname === "/livez") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ live: true, service: "albert-xero-mcp" }));
        return;
      }
      const body = await readBody(request);
      const source = await handler.handle(await toFetchRequest(request, body));
      const payload = Buffer.from(await source.arrayBuffer());
      const headers: Record<string, string> = {};
      source.headers.forEach((value, name) => {
        if (name.toLowerCase() !== "set-cookie") headers[name] = value;
      });
      headers["content-length"] = String(payload.byteLength);
      response.writeHead(source.status, headers);
      response.end(payload);
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "internal_error", message: "The Xero MCP service failed." } }));
      } else {
        response.destroy();
      }
    });
  });
  server.requestTimeout = 120_000;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolveListen());
  });
  console.log(`xero-mcp-service listening on 127.0.0.1:${PORT}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
