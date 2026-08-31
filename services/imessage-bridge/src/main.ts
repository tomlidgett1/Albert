import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { assertEmbeddedServiceBuildIdentity } from "../../../packages/config/src/build-identity.js";
import { loadImessageBridgeConfig } from "./config.js";
import { ImessageBridgeHandler } from "./bridge.js";

const releaseSha = assertEmbeddedServiceBuildIdentity(process.env);
const config = loadImessageBridgeConfig();
const handler = new ImessageBridgeHandler(config);

async function readBody(request: IncomingMessage, maxBytes = 600 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function sendWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, key) => target.setHeader(key, value));
  if (!response.body) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!target.write(Buffer.from(value))) await once(target, "drain");
    }
    target.end();
  } finally {
    reader.releaseLock();
  }
}

const server = createServer((incoming, outgoing) => {
  void (async () => {
    let body: Buffer | undefined;
    try {
      body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await readBody(incoming);
    } catch {
      outgoing.statusCode = 413;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ error: { code: "request_too_large", message: "Request too large." } }));
      return;
    }
    const host = incoming.headers.host ?? `127.0.0.1:${config.port}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
      else if (value) headers.set(key, value);
    }
    const request = new Request(`http://${host}${incoming.url ?? "/"}`, {
      method: incoming.method ?? "GET",
      headers,
      ...(body ? { body: new TextDecoder().decode(body) } : {}),
    });
    const response = await handler.handle(request);
    await sendWebResponse(response, outgoing);
  })().catch(() => {
    if (outgoing.headersSent) {
      outgoing.destroy();
      return;
    }
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ error: { code: "internal_error", message: "Internal error." } }));
  });
});

server.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({
    event: "imessage_bridge_started",
    port: config.port,
    buildSha: releaseSha,
    botNumber: config.botNumber,
    model: config.model,
  })}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  // An in-flight Omni turn should not block replacement indefinitely; Linq
  // retries undelivered webhooks for ~25 minutes, so a redeploy mid-turn is
  // recovered by the retry rather than by holding the old machine open.
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
