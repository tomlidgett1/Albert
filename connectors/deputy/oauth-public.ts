export type DeputyAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
}>;

/** Browser-safe: only public OAuth values are accepted. */
export function buildDeputyAuthorizationUrl(input: DeputyAuthorizationUrlInput): string {
  if (!input.clientId || !input.state || !input.redirectUri) {
    throw new Error("Invalid Deputy OAuth authorization parameters.");
  }
  const url = new URL("https://once.deputy.com/my/oauth/login");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "longlife_refresh_token");
  url.searchParams.set("state", input.state);
  return url.toString();
}
