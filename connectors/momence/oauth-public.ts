import { MOMENCE_ALLOWED_SCOPES, MOMENCE_DEFAULT_SCOPES } from "./manifest";

export type MomenceAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
  scopes?: readonly string[];
}>;

/** Browser-safe authorization builder; never accepts a client secret. */
export function buildMomenceAuthorizationUrl(input: MomenceAuthorizationUrlInput): string {
  const scopes = input.scopes?.length ? input.scopes : MOMENCE_DEFAULT_SCOPES;
  const unsupported = scopes.filter(
    (scope) => !MOMENCE_ALLOWED_SCOPES.includes(scope as (typeof MOMENCE_ALLOWED_SCOPES)[number]),
  );
  if (!input.clientId || !input.state || !input.redirectUri || unsupported.length > 0) {
    throw new Error("Invalid Momence authorization parameters.");
  }
  const url = new URL("https://api.momence.com/api/v2/auth/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);
  // `login` forces Momence to sign the user out first, so a shared browser
  // session cannot silently connect the wrong studio.
  url.searchParams.set("prompt", "login");
  return url.toString();
}
