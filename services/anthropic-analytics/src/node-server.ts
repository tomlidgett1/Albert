import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export async function startAnthropicAnalyticsNodeServer(input: Readonly<{
  handler: (request: Request) => Promise<Response>;
  host?: string;
  port?: number;
  closeRepository: () => Promise<void>;
}>): Promise<Readonly<{ url: string; close: () => Promise<void> }>> {
  const host = input.host ?? "127.0.0.1";
  const port = input.port ?? 8791;
  const sockets = new Set<Socket>();
  let closing = false;
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    try {
      if (closing) return send(response, new Response(JSON.stringify({ error: "Service is stopping." }), { status: 503 }));
      const body = await readBody(request, 1_048_576);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(new Error("Anthropic turn deadline exceeded.")), 195_000);
      const abortDisconnected = () => abortController.abort(new Error("Anthropic client disconnected."));
      request.once("aborted", abortDisconnected);
      response.once("close", abortDisconnected);
      const webRequest = new Request(new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`), {
        method: request.method ?? "GET",
        headers,
        ...((request.method ?? "GET") === "GET" || request.method === "HEAD" ? {} : { body }),
        signal: abortController.signal,
      });
      try {
        await send(response, await input.handler(webRequest));
      } finally {
        clearTimeout(timeout);
        request.off("aborted", abortDisconnected);
        response.off("close", abortDisconnected);
      }
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Anthropic analytics request failed." } });
      else response.destroy();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 200_000;
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolve(); }); });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
    async close() {
      if (closing) return;
      closing = true;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await input.closeRepository();
    },
  };
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new Error("Request body exceeds the service limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function send(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  if (!webResponse.body) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) await new Promise<void>((resolve) => response.once("drain", resolve));
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}
