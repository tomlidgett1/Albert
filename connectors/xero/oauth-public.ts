import { XERO_ALLOWED_SCOPES, XERO_DEFAULT_SCOPES } from "./manifest";

/** Sanity cap for worker-returned Xero AUTH. The live default set is 44 scopes. */
export const XERO_OAUTH_SCOPE_LIMIT = Math.max(64, XERO_ALLOWED_SCOPES.length);

/** Union the worker's recorded grant with the current AUTH set so a stale
 *  OAuth worker cannot drop report or write scopes from the consent URL. */
export function xeroAuthorizeScopes(workerScopes: readonly string[]): readonly string[] {
  const allowed = new Set<string>(XERO_ALLOWED_SCOPES);
  return [...new Set([...XERO_DEFAULT_SCOPES, ...workerScopes])].filter((scope) => allowed.has(scope));
}

export type XeroAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
  codeChallenge: string;
  scopes?: readonly string[];
}>;

/** Browser-safe PKCE authorization builder; never accepts a client secret. */
export function buildXeroAuthorizationUrl(input: XeroAuthorizationUrlInput): string {
  const scopes = input.scopes?.length ? input.scopes : XERO_DEFAULT_SCOPES;
  const unsupported = scopes.filter(
    (scope) => !XERO_ALLOWED_SCOPES.includes(scope as (typeof XERO_ALLOWED_SCOPES)[number]),
  );
  if (
    !input.clientId ||
    !input.state ||
    !input.redirectUri ||
    !input.codeChallenge ||
    unsupported.length > 0
  ) {
    throw new Error("Invalid Xero PKCE authorization parameters.");
  }
  const url = new URL("https://login.xero.com/identity/connect/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
