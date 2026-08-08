import {
  SHOPIFY_ALLOWED_SCOPES,
  SHOPIFY_DEFAULT_SCOPES,
  normalizeShopifyShopDomain,
} from "./manifest";

export type ShopifyAuthorizationUrlInput = Readonly<{
  clientId: string;
  state: string;
  redirectUri: string;
  shopDomain: string;
  scopes?: readonly string[];
}>;

/**
 * Browser-safe authorization builder; never accepts an app secret. Unlike
 * every other connector the authorize host is the merchant's own shop, so the
 * domain is re-validated here rather than trusted from the caller.
 */
export function buildShopifyAuthorizationUrl(input: ShopifyAuthorizationUrlInput): string {
  const scopes = input.scopes?.length ? input.scopes : SHOPIFY_DEFAULT_SCOPES;
  const unsupported = scopes.filter(
    (scope) => !SHOPIFY_ALLOWED_SCOPES.includes(scope as (typeof SHOPIFY_ALLOWED_SCOPES)[number]),
  );
  if (!input.clientId || !input.state || !input.redirectUri || unsupported.length > 0) {
    throw new Error("Invalid Shopify authorization parameters.");
  }
  const shop = normalizeShopifyShopDomain(input.shopDomain);
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", input.clientId);
  // Shopify separates access scopes with commas, not spaces.
  url.searchParams.set("scope", scopes.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  // Offline access: a durable token for unattended use. Omitting this would
  // yield a per-user token tied to the browser session that authorised it.
  url.searchParams.set("grant_options[]", "");
  return url.toString();
}
