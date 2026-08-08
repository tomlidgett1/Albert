import { authorizationOnlyManifest } from "../../packages/connector-sdk/src/index.js";

/**
 * The Google Ads API is gated by a single OAuth scope; read-only separation is
 * enforced by Google's developer-token access level and by this pack containing
 * no mutate method, not by a narrower scope.
 */
export const GOOGLE_ADS_DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/adwords",
] as const;

export const GOOGLE_ADS_ALLOWED_SCOPES = GOOGLE_ADS_DEFAULT_SCOPES;

export const googleAdsManifest = authorizationOnlyManifest({
  id: "google-ads",
  displayName: "Google Ads",
  packVersion: "0.1.0",
  apiVersion: "Google Ads API OAuth 2.0",
  releasedAt: "2026-08-06",
  documentation: [
    "https://developers.google.com/identity/protocols/oauth2/web-server",
    "https://developers.google.com/google-ads/api/docs/oauth/cloud-project",
    "https://developers.google.com/google-ads/api/docs/oauth/overview",
  ],
  scopes: GOOGLE_ADS_DEFAULT_SCOPES,
  leastPrivilegeNotes: [
    "Google Ads publishes exactly one OAuth scope (.../auth/adwords) and no read-only variant. Albert requests the only documented scope and contains no Google Ads mutate method.",
    "Calling the Google Ads API additionally requires an approved developer token, which is separate from OAuth. Authorization alone therefore grants no data access.",
  ],
  refreshTokenRotation: false,
  remoteRevocation: "supported",
  identityRules: [
    "A Google Ads connection is identified by the OpenID subject of the authorising Google account. Customer IDs are not enumerated, because listing accessible customers requires the developer token this pack deliberately does not use.",
  ],
  topology: [],
  qualityAssertions: [
    "Google issues a refresh token only when access_type=offline and prompt=consent are both sent; the pack sends both so a connection cannot silently become unrenewable.",
  ],
  limitations: [
    "Google refresh tokens are revoked if unused for six months, if the user revokes access, or if the OAuth app remains in testing status, where they expire after seven days.",
  ],
});
