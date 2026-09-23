/**
 * API clients (ADR 0144) authenticate with an explicit Supabase access token
 * in `Authorization: Bearer …` instead of the browser's session cookies.
 *
 * Only a JWT-shaped token is accepted (three base64url segments). Anything
 * else is treated as absent, so a malformed header can never switch a
 * request out of the cookie path and around the same-origin guard.
 */
// The auth scheme is case-insensitive (RFC 9110 §11.1); the token is not.
const BEARER_ACCESS_TOKEN_PATTERN =
  /^Bearer ([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})$/iu;

/** Longest access token an API client may present; Supabase JWTs are ~1 KB. */
const MAX_BEARER_HEADER_LENGTH = 8_192;

export function bearerAccessToken(authorization: string | null | undefined): string | null {
  if (!authorization || authorization.length > MAX_BEARER_HEADER_LENGTH) return null;
  const match = BEARER_ACCESS_TOKEN_PATTERN.exec(authorization.trim());
  return match ? match[1]! : null;
}
