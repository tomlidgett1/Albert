import { authorizationOnlyManifest } from "../../packages/connector-sdk/src/index.js";

/** Momence documents a single public API scope; there is no narrower variant. */
export const MOMENCE_DEFAULT_SCOPES = ["public-api-v2"] as const;

export const MOMENCE_ALLOWED_SCOPES = MOMENCE_DEFAULT_SCOPES;

export const momenceManifest = authorizationOnlyManifest({
  id: "momence",
  displayName: "Momence",
  packVersion: "0.1.0",
  apiVersion: "Momence public API v2",
  releasedAt: "2026-08-06",
  documentation: [
    "https://api.docs.momence.com/docs/get-started",
    "https://api.docs.momence.com/docs/getting-started",
    "https://api.docs.momence.com/reference/apiv2authcontroller_authorize",
  ],
  scopes: MOMENCE_DEFAULT_SCOPES,
  leastPrivilegeNotes: [
    "Momence publishes one public API scope (public-api-v2) rather than resource-specific read scopes. Albert requests it and contains no Momence write method.",
  ],
  refreshTokenRotation: true,
  remoteRevocation: "not_documented",
  identityRules: [
    "A Momence connection is identified by the host (studio) id returned for the authorising user. Momence access tokens are short lived, so identity is re-read rather than cached across renewals.",
  ],
  topology: [],
  qualityAssertions: [
    "Momence access tokens expire within hours, so the credential vault renews ahead of expiry rather than waiting for a request to fail.",
  ],
  limitations: [
    "Momence documents no OAuth revocation endpoint. Disconnect destroys Albert's encrypted credential; the studio must also remove the API client in Momence to fully revoke access.",
    "Momence's authorization-code flow is used exclusively. The documented password grant is never used, because it would require handling staff credentials directly.",
  ],
});
