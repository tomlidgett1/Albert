import type { AuthorizationRequest } from "../../packages/connector-sdk/src";
import { LIGHTSPEED_R_DEFAULT_SCOPES } from "./manifest";

export type LightspeedRAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
  /** Optional. bike-dashboard's working confidential-client flow omits PKCE. */
  codeChallenge?: string;
  scopes?: readonly string[];
}>;

/**
 * Browser-safe: contains no client secret, token-vault or Node-only import.
 *
 * Authorize params follow the R-Series Authorization Code Grant docs and the
 * live-proven bike-dashboard shape: `employee:all`, registered redirect URI,
 * and no PKCE on the authorize URL for confidential server clients.
 * @see https://developers.lightspeedhq.com/retail/authentication/authorization-code-grant/
 */
export function buildLightspeedRAuthorizationUrl(
  input: LightspeedRAuthorizationUrlInput,
): string {
  const scopes = input.scopes?.length ? input.scopes : LIGHTSPEED_R_DEFAULT_SCOPES;
  const unsupported = scopes.filter(
    (scope) => !LIGHTSPEED_R_DEFAULT_SCOPES.includes(scope as (typeof LIGHTSPEED_R_DEFAULT_SCOPES)[number]),
  );
  if (
    !input.clientId ||
    !input.state ||
    !input.redirectUri ||
    unsupported.length > 0
  ) {
    throw new Error("Invalid Lightspeed R-Series OAuth authorization parameters.");
  }
  // Param order matches bike-dashboard's live-working builder:
  // response_type, client_id, scope, state, redirect_uri.
  const url = new URL("https://cloud.lightspeedapp.com/auth/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  // Lightspeed documents scopes as a space-separated list; URLSearchParams
  // encodes spaces as `+`, matching their `employee:a+employee:b` examples.
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("redirect_uri", input.redirectUri);
  // PKCE is optional for confidential clients. bike-dashboard omits it; sending
  // code_challenge has correlated with Safari merchantos OIDC redirect loops.
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export function lightspeedAuthorizationInput(
  clientId: string,
  request: AuthorizationRequest,
): LightspeedRAuthorizationUrlInput {
  return {
    clientId,
    state: request.state,
    redirectUri: request.redirectUri,
    ...(request.codeChallenge ? { codeChallenge: request.codeChallenge } : {}),
    scopes: request.scopes,
  };
}
