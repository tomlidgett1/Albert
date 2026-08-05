import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { loadEncodedAes256Keyring } from "../../../packages/security/src/index.js";
import { parseSuppressedInitialBackfillConnectors } from "./config.js";
import { ProductionConnectorFactory } from "./connector-factory.js";
import { AesKeyringWrapper, EnvelopeCryptography } from "./credential-vault.js";
import { OAuthWorkerHttpHandler } from "./oauth-http.js";
import { OAuthSessionStore } from "./oauth-session-store.js";
import { PgTransactionalDatabase } from "./postgres.js";

const MAX_BODY_BYTES = 64 * 1024;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Albert OAuth worker is missing ${name}.`);
  return value;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

async function toFetchRequest(request: IncomingMessage): Promise<Request> {
  const url = new URL(request.url ?? "/", "http://oauth-worker.internal");
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: await requestBody(request) }),
  });
}

async function writeFetchResponse(source: Response, target: ServerResponse): Promise<void> {
  const payload = Buffer.from(await source.arrayBuffer());
  const headers: Record<string, string> = {};
  source.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") headers[name] = value;
  });
  headers["content-length"] = String(payload.byteLength);
  target.writeHead(source.status, headers);
  target.end(payload);
}

function publicOrigin(): URL {
  const origin = new URL(required("ALBERT_PUBLIC_ORIGIN"));
  const localHttp = origin.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(origin.hostname);
  if (
    (!localHttp && origin.protocol !== "https:") || origin.username || origin.password ||
    origin.pathname !== "/" || origin.search || origin.hash
  ) {
    throw new Error("ALBERT_PUBLIC_ORIGIN must be a clean HTTPS or localhost origin.");
  }
  return origin;
}

/**
 * Runs the credential-owning OAuth edge without extraction loops. This is a
 * local-development entry point for exercising real vendor consent journeys;
 * production continues to use runSyncWorker(), whose readiness includes the
 * queue, analytical cell, and raw object store.
 */
export async function runOAuthOnlyWorker(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The OAuth-only worker is unavailable in production.");
  }
  const origin = publicOrigin();
  const tokenKeyring = loadEncodedAes256Keyring({
    currentKey: required("TOKEN_ENCRYPTION_KEY"),
    currentKeyId: required("TOKEN_ENCRYPTION_KEY_ID"),
    previousKeysJson: process.env.TOKEN_PREVIOUS_ENCRYPTION_KEYS,
    keyName: "TOKEN_ENCRYPTION_KEY",
    keyIdName: "TOKEN_ENCRYPTION_KEY_ID",
    previousKeysName: "TOKEN_PREVIOUS_ENCRYPTION_KEYS",
    maxPreviousKeys: 4,
  });
  const database = new PgTransactionalDatabase(required("CONTROL_PLANE_DATABASE_URL"), {
    applicationName: "albert-oauth-worker/development",
    assumedRole: "albert_sync_control",
    maxConnections: 6,
  });
  const wrapper = new AesKeyringWrapper({
    currentKeyReference: "env:TOKEN_ENCRYPTION_KEY",
    currentKeyVersion: tokenKeyring.currentKeyId,
    encodedKeys: tokenKeyring.keys,
  });
  const connectorFactory = new ProductionConnectorFactory({
    lightspeedClientId: required("LIGHTSPEED_CLIENT_ID"),
    lightspeedClientSecret: required("LIGHTSPEED_CLIENT_SECRET"),
    xeroClientId: required("XERO_CLIENT_ID"),
    xeroEnableAdvancedJournals: process.env.XERO_ENABLE_ADVANCED_JOURNALS === "true",
    deputyClientId: required("DEPUTY_CLIENT_ID"),
    deputyClientSecret: required("DEPUTY_CLIENT_SECRET"),
    deputyRedirectUri: new URL("/api/oauth/deputy/callback", origin).toString(),
  });
  const handler = new OAuthWorkerHttpHandler({
    oauthWorkerSigningSecret: required("ALBERT_OAUTH_WORKER_SIGNING_SECRET"),
    allowedRedirectUris: new Set(["lightspeed", "xero", "deputy"].map((provider) =>
      new URL(`/api/oauth/${provider}/callback`, origin).toString()
    )),
    sessions: new OAuthSessionStore(database, new EnvelopeCryptography(wrapper), {
      suppressInitialBackfillFor: parseSuppressedInitialBackfillConnectors(
        process.env.ALBERT_OAUTH_SUPPRESS_INITIAL_BACKFILL,
      ),
    }),
    connectors: connectorFactory,
  });
  await database.ping();

  const port = Number(process.env.PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid.");
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://oauth-worker.internal").pathname;
      if (request.method === "GET" && pathname === "/livez") {
        json(response, 200, { live: true, service: "albert-oauth-worker" });
        return;
      }
      if (request.method === "GET" && pathname === "/readyz") {
        await database.ping();
        json(response, 200, { ready: true, service: "albert-oauth-worker" });
        return;
      }
      if (pathname.startsWith("/v1/oauth/")) {
        await writeFetchResponse(await handler.handle(await toFetchRequest(request)), response);
        return;
      }
      json(response, 404, { error: "not_found" });
    })().catch((error) => {
      if (!response.headersSent) {
        json(response, error instanceof Error && error.message === "request_too_large" ? 413 : 500, {
          error: error instanceof Error && error.message === "request_too_large"
            ? "request_too_large"
            : "internal_error",
        });
      } else {
        response.destroy();
      }
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 50_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  process.stdout.write(`Albert OAuth worker listening on http://127.0.0.1:${port}\n`);

  const shutdown = async () => {
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runOAuthOnlyWorker();
}
