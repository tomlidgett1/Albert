import type { AlbertRateLimitDecision } from "./web-repository.js";
import { ControlPlaneError } from "./web-repository.js";

export const COOKIE_MUTATION_BODY_LIMIT_BYTES = 32_000;

function configuredOrigin(request: Request): string {
  const configured = process.env.ALBERT_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      const localHttp = process.env.NODE_ENV !== "production" && parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(parsed.hostname);
      if (
        (parsed.protocol !== "https:" && !localHttp) || parsed.username || parsed.password ||
        parsed.pathname !== "/" || parsed.search || parsed.hash
      ) throw new Error("unsafe_public_origin");
      return parsed.origin;
    } catch {
      throw new ControlPlaneError("The public application origin is invalid.", 503);
    }
  }
  if (process.env.NODE_ENV === "production") {
    throw new ControlPlaneError("The public application origin is not configured.", 503);
  }
  const requestUrl = new URL(request.url);
  const localHttp = requestUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(requestUrl.hostname);
  if ((requestUrl.protocol !== "https:" && !localHttp) || requestUrl.username || requestUrl.password) {
    throw new ControlPlaneError("The public application origin is invalid.", 503);
  }
  return requestUrl.origin;
}

function requestHeaderOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username && !parsed.password
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

/** Rejects cookie-authenticated cross-site mutations before any body is read. */
export function assertSameOriginMutation(request: Request): void {
  const expected = configuredOrigin(request);
  const origin = requestHeaderOrigin(request.headers.get("origin"));
  if (!origin || origin !== expected) {
    throw new ControlPlaneError("Cross-site request rejected.", 403);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ControlPlaneError("Content-Type must be application/json.", 415);
  }
}

/**
 * Reads a cookie-authenticated JSON mutation through an enforced byte ceiling.
 * Content-Length is only an early rejection hint: chunked bodies and dishonest
 * lengths are still stopped while streaming, before unbounded buffering.
 */
export async function readBoundedJsonBody(
  request: Request,
  maxBytes = COOKIE_MUTATION_BODY_LIMIT_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("The JSON request-body limit must be a positive safe integer.");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      throw new ControlPlaneError("Content-Length is invalid.", 400);
    }
    if (Number(declaredLength) > maxBytes) {
      throw new ControlPlaneError("Request body is too large.", 413);
    }
  }

  const body = request.body;
  if (!body) throw new ControlPlaneError("Request body must be valid JSON.", 400);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ControlPlaneError("Request body is too large.", 413);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new ControlPlaneError("Request body must be valid JSON.", 400);
  }
}

/** OAuth starts are navigations, so validate Fetch Metadata and the referrer. */
export function assertSameOriginNavigation(request: Request): void {
  const expected = configuredOrigin(request);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ControlPlaneError("Cross-site OAuth initiation rejected.", 403);
  }
  const referrer = request.headers.get("referer");
  if (fetchSite !== "none" && requestHeaderOrigin(referrer) !== expected) {
    throw new ControlPlaneError("OAuth initiation requires a same-origin navigation.", 403);
  }
}

export function rateLimitHeaders(
  decision: AlbertRateLimitDecision,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "Cache-Control": "no-store",
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    ...(decision.allowed ? {} : { "Retry-After": String(decision.retryAfterSeconds) }),
  });
}

export function rateLimitExceededResponse(decision: AlbertRateLimitDecision): Response {
  return Response.json(
    { error: "Too many requests. Try again shortly." },
    { status: 429, headers: rateLimitHeaders(decision) },
  );
}
