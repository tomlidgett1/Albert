import { SQUARE_ALLOWED_SCOPES, SQUARE_DEFAULT_SCOPES } from "./manifest";

export type SquareAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
  scopes?: readonly string[];
}>;

/**
 * Browser-safe authorization builder; never accepts a client secret. Square's
 * confidential code flow carries no code_challenge — the secret authenticates
 * the token exchange from the credential-owning worker instead.
 */
export function buildSquareAuthorizationUrl(input: SquareAuthorizationUrlInput): string {
  const scopes = input.scopes?.length ? input.scopes : SQUARE_DEFAULT_SCOPES;
  const unsupported = scopes.filter(
    (scope) => !SQUARE_ALLOWED_SCOPES.includes(scope as (typeof SQUARE_ALLOWED_SCOPES)[number]),
  );
  if (!input.clientId || !input.state || !input.redirectUri || unsupported.length > 0) {
    throw new Error("Invalid Square authorization parameters.");
  }
  const url = new URL("https://connect.squareup.com/oauth2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);
  // Square documents redirect_uri as optional when a single URL is registered,
  // but sending it makes the registered-value mismatch fail at the vendor
  // rather than silently returning the seller to a stale redirect.
  url.searchParams.set("redirect_uri", input.redirectUri);
  // `session=false` forces Square to re-prompt for the seller account instead
  // of silently reusing whichever Square session the browser already holds.
  url.searchParams.set("session", "false");
  return url.toString();
}
