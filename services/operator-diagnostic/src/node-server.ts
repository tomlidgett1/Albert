import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createOperatorDiagnosticHttpHandler } from "./http.js";
import type {
  PostgresOperatorDiagnosticControlStore,
  PostgresOperatorDiagnosticReadStore,
} from "./database.js";

export type RunningOperatorDiagnosticServer = Readonly<{
  url: string;
  close(): Promise<void>;
}>;

export async function startOperatorDiagnosticNodeServer(options: Readonly<{
  controlStore: PostgresOperatorDiagnosticControlStore;
  readStore: PostgresOperatorDiagnosticReadStore;
  signingSecret: string;
  closeStores(): Promise<void>;
  host?: string;
  port?: number;
  shutdownGraceMs?: number;
  releaseSha?: string | null;
  deploymentId?: string | null;
}>): Promise<RunningOperatorDiagnosticServer> {
  if (new TextEncoder().encode(options.signingSecret).byteLength < 32) {
    throw new Error("ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET must be at least 32 bytes.");
  }
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8790;
  const handler = createOperatorDiagnosticHttpHandler(options);
  const sockets = new Set<Socket>();
  let closing = false;
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/livez") {
        return sendJson(response, closing ? 503 : 200, { status: closing ? "stopping" : "ok" });
      }
      if (request.method === "GET" && (request.url === "/readyz" || request.url?.startsWith("/readyz?"))) {
        try {
          const [controlReady, analyticalReady] = closing
            ? [false, false]
            : await Promise.all([options.controlStore.ready(), options.readStore.ready()]);
          const ready = !closing && controlReady && analyticalReady;
          return sendJson(response, ready ? 200 : 503, {
            status: ready ? "ready" : "not_ready",
            runtime: "operator-diagnostic",
            releaseSha: options.releaseSha ?? null,
            deploymentId: options.deploymentId ?? null,
          });
        } catch {
          return sendJson(response, 503, {
            status: "not_ready",
            runtime: "operator-diagnostic",
            releaseSha: options.releaseSha ?? null,
            deploymentId: options.deploymentId ?? null,
          });
        }
      }
      if (closing) return sendJson(response, 503, { error: { code: "SHUTTING_DOWN", message: "Diagnostic service is stopping." } });
      const body = await readBody(request, 4_096);
      const origin = `http://${request.headers.host ?? `${host}:${port}`}`;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const webRequest = new Request(new URL(request.url ?? "/", origin), {
        method: request.method ?? "GET",
        headers,
        ...((request.method ?? "GET") === "GET" || request.method === "HEAD" ? {} : { body }),
      });
      const webResponse = await handler(webRequest);
      response.statusCode = webResponse.status;
      webResponse.headers.forEach((value, name) => response.setHeader(name, value));
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch (error) {
      const tooLarge = error instanceof BodyLimitError;
      sendJson(response, tooLarge ? 413 : 500, {
        error: {
          code: tooLarge ? "BODY_TOO_LARGE" : "INTERNAL_ERROR",
          message: tooLarge ? "Diagnostic request body is too large." : "Diagnostic request failed.",
        },
      });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxHeadersCount = 64;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const url = `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`;
  return {
    url,
    async close() {
      if (closing) return;
      closing = true;
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const timeout = setTimeout(() => sockets.forEach((socket) => socket.destroy()), options.shutdownGraceMs ?? 10_000);
      timeout.unref();
      try { await closed; } finally {
        clearTimeout(timeout);
        await options.closeStores();
      }
    },
  };
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new BodyLimitError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(value));
}

class BodyLimitError extends Error {}
