import { SQUARE_ALLOWED_SCOPES, SQUARE_DEFAULT_SCOPES } from "./manifest.js";

export const SQUARE_PRODUCTION_CONNECT_ORIGIN = "https://connect.squareup.com";
export const SQUARE_SANDBOX_CONNECT_ORIGIN = "https://connect.squareupsandbox.com";

export type SquareAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
  scopes?: readonly string[];
}>;

/**
 * Square sandbox application IDs are prefixed `sandbox-`. Using that prefix
 * selects the sandbox connect host so dummy sellers never hit production.
 */
export function squareConnectOrigin(clientId: string): string {
  return clientId.startsWith("sandbox-")
    ? SQUARE_SANDBOX_CONNECT_ORIGIN
    : SQUARE_PRODUCTION_CONNECT_ORIGIN;
}

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
  const url = new URL(`${squareConnectOrigin(input.clientId)}/oauth2/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);
  // Square documents redirect_uri as optional when a single URL is registered,
  // but sending it makes the registered-value mismatch fail at the vendor
  // rather than silently returning the seller to a stale redirect.
  url.searchParams.set("redirect_uri", input.redirectUri);
  // Production requires session=false so Square re-prompts instead of silently
  // reusing whichever seller session the browser already holds. Sandbox only
  // supports the default session=true and renders a blank authorize page if
  // this flag is sent; Square also requires an open Sandbox Dashboard tab.
  if (!input.clientId.startsWith("sandbox-")) {
    url.searchParams.set("session", "false");
  }
  return url.toString();
}
