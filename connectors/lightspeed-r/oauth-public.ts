import type { AuthorizationRequest } from "../../packages/connector-sdk/src";
import { LIGHTSPEED_R_DEFAULT_SCOPES } from "./manifest";

export type LightspeedRAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
  codeChallenge: string;
  scopes?: readonly string[];
}>;

/** Browser-safe: contains no client secret, token-vault or Node-only import. */
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
    !input.codeChallenge ||
    unsupported.length > 0
  ) {
    throw new Error("Invalid Lightspeed R-Series OAuth authorization parameters.");
  }
  const url = new URL("https://cloud.lightspeedapp.com/auth/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
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
    codeChallenge: request.codeChallenge ?? "",
    scopes: request.scopes,
  };
}
