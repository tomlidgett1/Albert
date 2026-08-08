import { GOOGLE_ADS_ALLOWED_SCOPES, GOOGLE_ADS_DEFAULT_SCOPES } from "./manifest";

export type GoogleAdsAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
  scopes?: readonly string[];
}>;

/** Browser-safe authorization builder; never accepts a client secret. */
export function buildGoogleAdsAuthorizationUrl(input: GoogleAdsAuthorizationUrlInput): string {
  const scopes = input.scopes?.length ? input.scopes : GOOGLE_ADS_DEFAULT_SCOPES;
  const unsupported = scopes.filter(
    (scope) => !GOOGLE_ADS_ALLOWED_SCOPES.includes(scope as (typeof GOOGLE_ADS_ALLOWED_SCOPES)[number]),
  );
  if (!input.clientId || !input.state || !input.redirectUri || unsupported.length > 0) {
    throw new Error("Invalid Google Ads authorization parameters.");
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);
  // Both are required for a refresh token. `prompt=consent` is not cosmetic:
  // without it Google omits the refresh token on every re-authorization after
  // the first, leaving a connection that cannot be renewed unattended.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}
