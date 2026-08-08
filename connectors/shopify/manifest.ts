import { authorizationOnlyManifest } from "../../packages/connector-sdk/src/index.js";

/** Read-only Admin API access scopes. No write_* scope is ever requested. */
export const SHOPIFY_DEFAULT_SCOPES = [
  "read_products",
  "read_orders",
  "read_customers",
  "read_inventory",
  "read_locations",
  "read_fulfillments",
  "read_price_rules",
  "read_discounts",
  "read_shipping",
  "read_analytics",
] as const;

export const SHOPIFY_ALLOWED_SCOPES = SHOPIFY_DEFAULT_SCOPES;

export const SHOPIFY_API_VERSION = "2026-07";

/**
 * Shopify shop domains are the authorization host, so they are validated
 * strictly: a bad value here would send the merchant's browser, and the
 * authorization code, to an attacker-chosen origin.
 */
const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]\.myshopify\.com$/u;

export function normalizeShopifyShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
  // Accept a bare shop name as a convenience, but never a bare hostname that
  // is not myshopify.com — custom domains do not host the OAuth endpoint.
  const candidate = trimmed.includes(".") ? trimmed : `${trimmed}.myshopify.com`;
  if (!SHOP_DOMAIN_PATTERN.test(candidate)) {
    throw new Error("A Shopify shop domain must look like your-store.myshopify.com.");
  }
  return candidate;
}

export const shopifyManifest = authorizationOnlyManifest({
  id: "shopify",
  displayName: "Shopify",
  packVersion: "0.1.0",
  apiVersion: `Admin API ${SHOPIFY_API_VERSION}`,
  releasedAt: "2026-08-06",
  documentation: [
    "https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant",
    "https://shopify.dev/docs/api/usage/access-scopes",
    "https://shopify.dev/docs/apps/build/authentication-authorization/session-tokens",
  ],
  scopes: SHOPIFY_DEFAULT_SCOPES,
  leastPrivilegeNotes: [
    "Only read_* access scopes are requested. Shopify pairs every read scope with a write counterpart; none is requested, and the pack contains no Admin API mutation.",
  ],
  refreshTokenRotation: false,
  remoteRevocation: "not_documented",
  identityRules: [
    "A Shopify connection is identified by its myshopify.com shop domain, which is both the authorization host and the stable account identity.",
  ],
  topology: [
    "The shop domain must be supplied before authorization begins, because Shopify hosts the authorize endpoint on the shop itself rather than on a central domain.",
  ],
  qualityAssertions: [
    "The OAuth callback is rejected unless Shopify's HMAC-SHA256 signature over the sorted query string verifies against the app secret, and unless the returned shop matches the shop the flow started for.",
  ],
  limitations: [
    "Offline access tokens do not expire and Shopify documents no OAuth revocation endpoint. Disconnect destroys Albert's encrypted credential; the merchant uninstalls the app in Shopify to fully revoke it.",
  ],
});
