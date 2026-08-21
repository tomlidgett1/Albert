import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { assertEmbeddedServiceBuildIdentity } from "../../../packages/config/src/build-identity.js";
import { loadCodexRuntimeConfig } from "./config.js";
import { CodexRuntimeHttpHandler } from "./http.js";

const releaseSha = assertEmbeddedServiceBuildIdentity(process.env);
const config = loadCodexRuntimeConfig();
const handler = new CodexRuntimeHttpHandler(config);

async function readBody(request: IncomingMessage, maxBytes = 200 * 1024): Promise<Buffer> {
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
    const abort = new AbortController();
    incoming.once("aborted", () => abort.abort("request_aborted"));
    outgoing.once("close", () => {
      if (!outgoing.writableFinished) abort.abort("response_closed");
    });
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
      signal: abort.signal,
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
    event: "codex_runtime_started",
    port: config.port,
    buildSha: releaseSha,
    pinnedCliVersion: config.pinnedCliVersion,
  })}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  // A running Codex turn (spawned CLI child) or a lingering connection must
  // not block replacement: force the exit after a short drain window.
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
