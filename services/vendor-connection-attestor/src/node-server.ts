import { timingSafeEqual } from "node:crypto";
import {
  createServer as createHealthServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createTlsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import type { VendorConnectionAttestorService } from "./service.js";

const MAX_TOKEN_BYTES = 65_536;
const MAX_HEADER_BYTES = 8 * 1024;

export async function startVendorAttestorServers(options: Readonly<{
  service: VendorConnectionAttestorService;
  ready(): Promise<boolean>;
  closeDependencies(): Promise<void>;
  tls: Readonly<{ key: Buffer; cert: Buffer; ca: Buffer; clientFingerprints: ReadonlySet<string> }>;
  host: string;
  port: number;
  healthPort: number;
  toolRef: string;
  buildDigest: string;
}>): Promise<Readonly<{ url: string; close(): Promise<void> }>> {
  let closing = false;
  const sockets = new Set<Socket>();
  const health = createHealthServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://vendor-attestor-health").pathname;
      if (request.method === "GET" && path === "/livez") {
        sendJson(response, closing ? 503 : 200, { status: closing ? "stopping" : "ok" });
        return;
      }
      if (request.method === "GET" && path === "/readyz") {
        const ready = !closing && await options.ready().catch(() => false);
        sendJson(response, ready ? 200 : 503, {
          status: ready ? "ready" : "not_ready",
          toolRef: options.toolRef,
          buildDigest: options.buildDigest,
        });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    })().catch(() => sendJson(response, 503, { error: "health_unavailable" }));
  });
  const server = createTlsServer({
    key: options.tls.key,
    cert: options.tls.cert,
    ca: options.tls.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    maxHeaderSize: MAX_HEADER_BYTES,
  }, (request, response) => {
    void (async () => {
      if (closing) return sendJson(response, 503, { error: "shutting_down" });
      const path = new URL(request.url ?? "/", "https://vendor-attestor.internal").pathname;
      const tlsSocket = request.socket as TLSSocket;
      if (!tlsSocket.authorized || !trustedFingerprint(
        tlsSocket.getPeerCertificate().fingerprint256,
        options.tls.clientFingerprints,
      )) return sendJson(response, 401, { error: "mtls_identity_rejected" });
      if (request.method === "GET" && path === "/readyz") {
        const ready = await options.ready().catch(() => false);
        return sendJson(response, ready ? 200 : 503, {
          status: ready ? "ready" : "not_ready",
          toolRef: options.toolRef,
          buildDigest: options.buildDigest,
        });
      }
      if (request.method !== "POST" || path !== "/v1/vendor-connection-attestations") {
        return sendJson(response, 404, { error: "not_found" });
      }
      if (request.headers["content-type"] !== "application/octet-stream") {
        return sendJson(response, 415, { error: "content_type_invalid" });
      }
      const challengeId = singleHeader(request.headers["x-albert-challenge-id"]);
      const nonce = singleHeader(request.headers["x-albert-challenge-nonce"]);
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(challengeId) || !/^[A-Za-z0-9_-]{43}$/u.test(nonce)) {
        return sendJson(response, 400, { error: "challenge_invalid" });
      }
      const token = await readExactToken(request);
      const result = await options.service.attest(challengeId, nonce, token);
      sendJson(response, result.passed ? 200 : 422, result);
    })().catch((error) => {
      const code = safeErrorCode(error);
      sendJson(response, code === "request_too_large" ? 413 : code === "request_length_invalid" ? 400 : 409, {
        error: code,
      });
    });
  });
  for (const candidate of [health, server]) {
    candidate.headersTimeout = 10_000;
    candidate.requestTimeout = 25_000;
    candidate.keepAliveTimeout = 2_000;
    candidate.maxRequestsPerSocket = 4;
    candidate.maxHeadersCount = 32;
    candidate.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
  }
  await Promise.all([
    listen(health, options.host, options.healthPort),
    listen(server, options.host, options.port),
  ]);
  const address = server.address() as AddressInfo;
  return Object.freeze({
    url: `https://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
    async close() {
      if (closing) return;
      closing = true;
      const timeout = setTimeout(() => sockets.forEach((socket) => socket.destroy()), 10_000);
      timeout.unref();
      try {
        await Promise.all([close(health), close(server)]);
      } finally {
        clearTimeout(timeout);
        await options.closeDependencies();
      }
    },
  });
}

async function readExactToken(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (!Number.isInteger(declared) || declared < 1) throw new Error("request_length_invalid");
  if (declared > MAX_TOKEN_BYTES) throw new Error("request_too_large");
  const token = Buffer.allocUnsafe(declared);
  let offset = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (offset + bytes.byteLength > declared) throw new Error("request_length_invalid");
      bytes.copy(token, offset);
      offset += bytes.byteLength;
    }
    if (offset !== declared || token.includes(0x00) || token.includes(0x0a) || token.includes(0x0d)) {
      throw new Error("request_length_invalid");
    }
    return token;
  } catch (error) {
    token.fill(0);
    throw error;
  }
}

function trustedFingerprint(value: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!value) return false;
  const normalized = value.replaceAll(":", "").toLowerCase();
  for (const candidate of allowed) {
    const left = Buffer.from(normalized, "hex");
    const right = Buffer.from(candidate, "hex");
    if (left.byteLength === right.byteLength && timingSafeEqual(left, right)) return true;
  }
  return false;
}

function singleHeader(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function safeErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message.split(":", 1)[0] : "attestation_failed";
  return /^[a-z][a-z0-9_]{2,79}$/u.test(code) ? code : "attestation_failed";
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function listen(server: HttpServer | HttpsServer, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
}

async function close(server: HttpServer | HttpsServer): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
