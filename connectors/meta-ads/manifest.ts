import { authorizationOnlyManifest } from "../../packages/connector-sdk/src/index.js";

/** Read-only Marketing API permissions. `ads_management` is deliberately absent. */
export const META_ADS_DEFAULT_SCOPES = [
  "ads_read",
  "read_insights",
  "business_management",
] as const;

export const META_ADS_ALLOWED_SCOPES = META_ADS_DEFAULT_SCOPES;

/** Pinned Graph API version; Meta rolls defaults, so it is always explicit. */
export const META_GRAPH_VERSION = "v25.0";

export const metaAdsManifest = authorizationOnlyManifest({
  id: "meta-ads",
  displayName: "Meta Ads",
  packVersion: "0.1.0",
  apiVersion: `Graph API ${META_GRAPH_VERSION}`,
  releasedAt: "2026-08-06",
  documentation: [
    "https://developers.facebook.com/docs/marketing-api/overview/authorization",
    "https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived",
    "https://developers.facebook.com/docs/graph-api/reference/user/permissions/",
  ],
  scopes: META_ADS_DEFAULT_SCOPES,
  leastPrivilegeNotes: [
    "Albert requests ads_read rather than ads_management. ads_management would grant campaign mutation the pack contains no method for.",
    "Meta requires Advanced Access through App Review for these permissions in production; Standard Access only covers ad accounts the app itself owns.",
  ],
  refreshTokenRotation: false,
  remoteRevocation: "supported",
  identityRules: [
    "A Meta Ads connection is identified by the Graph user ID of the authorising person. Ad accounts are recorded as connection metadata only.",
  ],
  topology: [],
  qualityAssertions: [
    "The short-lived code-exchange token is immediately exchanged for a long-lived token, so a connection never persists a token that dies within hours.",
  ],
  limitations: [
    "Meta issues no refresh token. Long-lived tokens last about 60 days and are renewed by re-exchanging an unexpired token; once one lapses the seller must re-authorize.",
  ],
});
