import { META_ADS_ALLOWED_SCOPES, META_ADS_DEFAULT_SCOPES, META_GRAPH_VERSION } from "./manifest";

export type MetaAdsAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
  scopes?: readonly string[];
}>;

/** Browser-safe authorization builder; never accepts an app secret. */
export function buildMetaAdsAuthorizationUrl(input: MetaAdsAuthorizationUrlInput): string {
  const scopes = input.scopes?.length ? input.scopes : META_ADS_DEFAULT_SCOPES;
  const unsupported = scopes.filter(
    (scope) => !META_ADS_ALLOWED_SCOPES.includes(scope as (typeof META_ADS_ALLOWED_SCOPES)[number]),
  );
  if (!input.clientId || !input.state || !input.redirectUri || unsupported.length > 0) {
    throw new Error("Invalid Meta Ads authorization parameters.");
  }
  const url = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(","));
  url.searchParams.set("state", input.state);
  return url.toString();
}
