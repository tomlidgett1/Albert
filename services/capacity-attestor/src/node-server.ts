import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

class BodyLimitError extends Error {}

export async function startCapacityAttestorNodeServer(options: Readonly<{
  handler(request: Request): Promise<Response>;
  ready(): Promise<boolean>;
  closeDependencies(): Promise<void>;
  host?: string;
  port?: number;
}>): Promise<Readonly<{ url: string; close(): Promise<void> }>> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8791;
  const sockets = new Set<Socket>();
  let closing = false;
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "capacity-attestor"}`).pathname;
      if (request.method === "GET" && pathname === "/livez") {
        return sendJson(response, closing ? 503 : 200, { status: closing ? "stopping" : "ok" });
      }
      if (request.method === "GET" && pathname === "/readyz") {
        const ready = !closing && await options.ready();
        return sendJson(response, ready ? 200 : 503, {
          status: ready ? "ready" : "not_ready",
          toolRef: process.env.ALBERT_CAPACITY_ATTESTOR_TOOL_REF?.trim() ?? null,
          buildDigest: process.env.ALBERT_CAPACITY_ATTESTOR_BUILD_DIGEST?.trim() ?? null,
        });
      }
      if (closing) return sendJson(response, 503, { error: { code: "SHUTTING_DOWN", message: "Attestor is stopping." } });
      const rawBody = await readBody(request, 32 * 1024);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const method = request.method ?? "GET";
      const webRequest = new Request(new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`), {
        method,
        headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: rawBody }),
      });
      const result = await options.handler(webRequest);
      response.statusCode = result.status;
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      sendJson(response, error instanceof BodyLimitError ? 413 : 500, {
        error: {
          code: error instanceof BodyLimitError ? "BODY_TOO_LARGE" : "INTERNAL_ERROR",
          message: error instanceof BodyLimitError ? "Request body is too large." : "Attestation request failed.",
        },
      });
    }
  });
  server.headersTimeout = 10_000;
  // Observation is asynchronous and durable; every POST/poll request is short.
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 20;
  server.maxHeadersCount = 64;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  const url = `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`;
  return Object.freeze({
    url,
    async close() {
      if (closing) return;
      closing = true;
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const timeout = setTimeout(() => sockets.forEach((socket) => socket.destroy()), 15_000);
      timeout.unref();
      try { await closed; } finally { clearTimeout(timeout); await options.closeDependencies(); }
    },
  });
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) throw new BodyLimitError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
