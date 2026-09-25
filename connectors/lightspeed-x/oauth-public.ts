export type LightspeedXAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
  scopes: readonly string[];
}>;

/** Browser-safe construction of the official X-Series authorization request. */
export function buildLightspeedXAuthorizationUrl(
  input: LightspeedXAuthorizationUrlInput,
): string {
  if (input.state.length < 8) {
    throw new Error("Lightspeed X-Series OAuth state must contain at least 8 characters.");
  }
  if (!input.clientId.trim() || !input.redirectUri.trim()) {
    throw new Error("Lightspeed X-Series clientId and redirectUri are required.");
  }
  const url = new URL("https://secure.retail.lightspeed.app/connect");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", [...new Set(input.scopes)].sort().join(" "));
  return url.toString();
}
