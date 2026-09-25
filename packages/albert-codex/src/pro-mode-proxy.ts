import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const MAX_PROXY_REQUEST_BYTES = 32 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type CodexProReasoningSummaryEvent = Readonly<{
  kind: "delta" | "done";
  itemId: string;
  summaryIndex: number;
  text: string;
}>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply the documented GPT-5.6 Pro execution mode while preserving Codex's
 * selected effort, summary, and any future reasoning properties.
 */
export function withCodexProReasoningMode(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("The Codex Responses request body must be an object.");
  const reasoning = isObject(value.reasoning) ? value.reasoning : {};
  return {
    ...value,
    reasoning: {
      ...reasoning,
      mode: "pro",
    },
  };
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_PROXY_REQUEST_BYTES) {
      throw new Error("The Codex provider request exceeded the bounded proxy body size.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(request: IncomingMessage, apiKey: string): Headers {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(request.headers)) {
    const normalized = name.toLocaleLowerCase("en-US");
    if (HOP_BY_HOP_HEADERS.has(normalized) || rawValue === undefined) continue;
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      headers.append(name, value);
    }
  }
  // Node fetch transparently decodes compressed responses. Asking for identity
  // avoids forwarding a stale content-encoding header to the Codex child.
  headers.set("accept-encoding", "identity");
  // API credentials remain in the parent runtime. The Codex child receives
  // only a random, per-turn loopback capability path.
  headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

function responseHeaders(response: Response, target: ServerResponse): void {
  for (const [name, value] of response.headers) {
    const normalized = name.toLocaleLowerCase("en-US");
    if (
      HOP_BY_HOP_HEADERS.has(normalized)
      || normalized === "content-encoding"
    ) continue;
    target.setHeader(name, value);
  }
}

function reasoningSummaryEvent(value: unknown): CodexProReasoningSummaryEvent | null {
  if (!isObject(value) || typeof value.type !== "string") return null;
  if (
    value.type !== "response.reasoning_summary_text.delta"
    && value.type !== "response.reasoning_summary_text.done"
  ) return null;
  const text = value.type.endsWith(".delta") ? value.delta : value.text;
  if (
    typeof value.item_id !== "string"
    || !Number.isInteger(value.summary_index)
    || typeof text !== "string"
    || !text
  ) return null;
  return {
    kind: value.type.endsWith(".delta") ? "delta" : "done",
    itemId: value.item_id,
    summaryIndex: Number(value.summary_index),
    text,
  };
}

function consumeSseBlocks(
  buffer: string,
  onReasoningSummary?: (event: CodexProReasoningSummaryEvent) => void,
): string {
  const normalized = buffer.replace(/\r\n/gu, "\n");
  const blocks = normalized.split("\n\n");
  const remainder = blocks.pop() ?? "";
  for (const block of blocks) {
    const payload = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = reasoningSummaryEvent(JSON.parse(payload));
      if (event) onReasoningSummary?.(event);
    } catch {
      // Forward provider bytes unchanged. Optional summary parsing never owns
      // the model response lifecycle.
    }
  }
  return remainder;
}

async function streamResponse(
  response: Response,
  target: ServerResponse,
  onReasoningSummary?: (event: CodexProReasoningSummaryEvent) => void,
): Promise<void> {
  if (!response.body) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (target.destroyed) {
        await reader.cancel();
        return;
      }
      sseBuffer = consumeSseBlocks(
        `${sseBuffer}${decoder.decode(next.value, { stream: true })}`,
        onReasoningSummary,
      );
      if (!target.write(Buffer.from(next.value))) await once(target, "drain");
    }
    consumeSseBlocks(`${sseBuffer}${decoder.decode()}\n\n`, onReasoningSummary);
    target.end();
  } finally {
    reader.releaseLock();
  }
}

async function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstreamOrigin: URL,
  capabilityPath: string,
  apiKey: string,
  receipt: { injectedRequests: number; acceptedResponses: number },
  onReasoningSummary?: (event: CodexProReasoningSummaryEvent) => void,
): Promise<void> {
  const incomingUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!incomingUrl.pathname.startsWith(`${capabilityPath}/`)) {
    response.statusCode = 404;
    response.end();
    return;
  }
  const upstreamPath = incomingUrl.pathname.slice(capabilityPath.length);
  const targetUrl = new URL(`${upstreamPath}${incomingUrl.search}`, upstreamOrigin.origin);
  const method = request.method?.toUpperCase() || "GET";
  const rawBody = method === "GET" || method === "HEAD"
    ? Buffer.alloc(0)
    : await readBoundedBody(request);
  const isResponsesRequest = method === "POST" && /\/responses\/?$/u.test(upstreamPath);
  const body = isResponsesRequest
    ? Buffer.from(JSON.stringify(withCodexProReasoningMode(JSON.parse(rawBody.toString("utf8")))), "utf8")
    : rawBody;
  const fetchBody: Uint8Array<ArrayBuffer> = new Uint8Array(body.byteLength);
  fetchBody.set(body);
  if (isResponsesRequest) receipt.injectedRequests += 1;
  const abort = new AbortController();
  request.once("aborted", () => abort.abort());
  response.once("close", () => {
    if (!response.writableEnded) abort.abort();
  });
  const upstreamResponse = await fetch(targetUrl, {
    method,
    headers: requestHeaders(request, apiKey),
    ...(fetchBody.byteLength > 0 ? { body: fetchBody } : {}),
    redirect: "manual",
    signal: abort.signal,
  });
  if (isResponsesRequest && upstreamResponse.ok) receipt.acceptedResponses += 1;
  response.statusCode = upstreamResponse.status;
  response.statusMessage = upstreamResponse.statusText;
  responseHeaders(upstreamResponse, response);
  await streamResponse(upstreamResponse, response, onReasoningSummary);
}

export type CodexProModeProxy = Readonly<{
  /** Loopback base URL retaining the upstream base path (normally `/v1`). */
  baseUrl: string;
  /** Provider acceptance receipt containing no request, response, or credential data. */
  receipt: () => Readonly<{
    injectedRequests: number;
    acceptedResponses: number;
    verified: boolean;
  }>;
  close: () => Promise<void>;
}>;

/**
 * Codex app-server does not yet expose Responses `reasoning.mode`. For
 * API-authenticated runs, this loopback-only adapter adds `mode: "pro"` to
 * the exact outgoing `/responses` request and streams the provider response
 * back untouched. It never logs headers, bodies, or credentials.
 */
export async function startCodexProModeProxy(
  upstreamBaseUrl: string,
  apiKey: string,
  onReasoningSummary?: (event: CodexProReasoningSummaryEvent) => void,
): Promise<CodexProModeProxy> {
  const upstream = new URL(upstreamBaseUrl);
  if (!apiKey.trim()) throw new Error("The Codex Pro adapter requires an OpenAI API key.");
  if (!new Set(["http:", "https:"]).has(upstream.protocol)) {
    throw new Error("The Codex Pro upstream must use HTTP or HTTPS.");
  }
  if (
    upstream.protocol !== "https:"
    && !["127.0.0.1", "localhost", "::1"].includes(upstream.hostname)
  ) {
    throw new Error("The Codex Pro upstream must use HTTPS outside loopback tests.");
  }
  const capabilityPath = `/${randomUUID().replaceAll("-", "")}`;
  const receipt = { injectedRequests: 0, acceptedResponses: 0 };
  const server = createServer((request, response) => {
    void proxyRequest(
      request,
      response,
      upstream,
      capabilityPath,
      apiKey,
      receipt,
      onReasoningSummary,
    ).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.statusCode = 502;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({ error: { message: "The Codex Pro provider request failed." } }));
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The Codex Pro loopback adapter did not receive a TCP address.");
  }
  const basePath = upstream.pathname.replace(/\/+$/u, "");
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${address.port}${capabilityPath}${basePath}`,
    receipt: () => Object.freeze({
      injectedRequests: receipt.injectedRequests,
      acceptedResponses: receipt.acceptedResponses,
      verified: receipt.injectedRequests > 0 && receipt.acceptedResponses > 0,
    }),
    close: async () => {
      server.closeIdleConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  });
}
