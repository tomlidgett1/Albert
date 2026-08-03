import type { AlbertRateLimitDecision } from "./web-repository.js";
import { ControlPlaneError } from "./web-repository.js";

function configuredOrigin(request: Request): string {
  const configured = process.env.ALBERT_PUBLIC_ORIGIN?.trim();
  if (configured) return new URL(configured).origin;
  if (process.env.NODE_ENV === "production") {
    throw new ControlPlaneError("The public application origin is not configured.", 503);
  }
  return new URL(request.url).origin;
}

/** Rejects cookie-authenticated cross-site mutations before any body is read. */
export function assertSameOriginMutation(request: Request): void {
  const expected = configuredOrigin(request);
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).origin !== expected) {
    throw new ControlPlaneError("Cross-site request rejected.", 403);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ControlPlaneError("Content-Type must be application/json.", 415);
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
  if (fetchSite !== "none" && (!referrer || new URL(referrer).origin !== expected)) {
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
