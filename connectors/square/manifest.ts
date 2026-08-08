import type { ConnectorManifest } from "../../packages/connector-sdk/src/index.js";

/**
 * Every documented Square read permission. Square grants permissions to the
 * whole application, so a narrower request would only have to be widened later
 * behind a second seller consent. No write permission is listed: the pack
 * contains no Square write method, so a write grant could only ever exceed what
 * the code can use.
 *
 * `DEVICE_CREDENTIAL_MANAGEMENT` is deliberately absent — it is a management
 * capability, not a read scope.
 */
export const SQUARE_DEFAULT_SCOPES = [
  "MERCHANT_PROFILE_READ",
  "ORDERS_READ",
  "PAYMENTS_READ",
  "PAYOUTS_READ",
  "ITEMS_READ",
  "INVENTORY_READ",
  "CUSTOMERS_READ",
  "EMPLOYEES_READ",
  "TIMECARDS_READ",
  "TIMECARDS_SETTINGS_READ",
  "BANK_ACCOUNTS_READ",
  "CASH_DRAWER_READ",
  "DISPUTES_READ",
  "GIFTCARDS_READ",
  "INVOICES_READ",
  "LOYALTY_READ",
  "SUBSCRIPTIONS_READ",
  "VENDOR_READ",
  "DEVICES_READ",
  "APPOINTMENTS_READ",
  "APPOINTMENTS_ALL_READ",
  "APPOINTMENTS_BUSINESS_SETTINGS_READ",
  "ONLINE_STORE_SITE_READ",
  "ONLINE_STORE_SNIPPETS_READ",
] as const;

export const SQUARE_ALLOWED_SCOPES = SQUARE_DEFAULT_SCOPES;

/**
 * Square pins behaviour to a dated API version rather than a URL path segment.
 * Every request sends it explicitly so a vendor default rollover cannot change
 * response shapes underneath the pack.
 */
export const SQUARE_API_VERSION = "2026-07-15";

/**
 * Authorization-only pack. Square is connectable, refreshable and revocable,
 * and its merchant/location identity is discovered, but it declares no stream:
 * nothing is extracted, staged or projected. `streams` and `capabilities` stay
 * empty on purpose so no runtime can believe Square data exists, and so the
 * readiness surface reports Square as connected-without-coverage rather than
 * silently implying a domain it cannot answer from.
 */
export const squareManifest: ConnectorManifest = {
  id: "square",
  displayName: "Square",
  packVersion: "0.1.0",
  apiVersion: `Square-Version ${SQUARE_API_VERSION}`,
  releasedAt: "2026-08-06",
  documentation: [
    "https://developer.squareup.com/docs/oauth-api/overview",
    "https://developer.squareup.com/docs/oauth-api/create-urls-for-square-authorization",
    "https://developer.squareup.com/docs/oauth-api/square-permissions",
    "https://developer.squareup.com/reference/square/o-auth-api/obtain-token",
    "https://developer.squareup.com/reference/square/o-auth-api/revoke-token",
    "https://developer.squareup.com/reference/square/merchants-api/retrieve-merchant",
    "https://developer.squareup.com/reference/square/locations-api/list-locations",
  ],
  oauth: {
    scopes: SQUARE_DEFAULT_SCOPES,
    leastPrivilegeNotes: [
      "Square scopes an OAuth grant to the application, not to an individual endpoint, so a seller re-consents whenever the requested permission set grows. Albert therefore requests the complete documented read set once and contains no Square write method.",
      "Albert uses Square's confidential code flow rather than PKCE. Square's PKCE refresh tokens are single-use and expire after 90 days, which cannot survive an unattended worker, and RevokeToken authenticates with the application secret in every flow.",
    ],
    refreshTokenRotation: false,
    remoteRevocation: "supported",
  },
  streams: [],
  sourceAuthority: { defaults: [] },
  rateLimit: {
    algorithm: "vendor_response_directed_backoff",
    concurrency: 2,
    responseHeaders: ["Retry-After"],
    reservations: [],
  },
  capabilities: {},
  identityRules: [
    "A Square connection is identified by its merchant_id, which Square returns from the token exchange and which survives access-token rotation.",
    "Locations are recorded as connection metadata only. Until Square declares a stream they are never promoted to a canonical location identity.",
  ],
  topology: [
    "Authorization only. The pack exchanges, refreshes and revokes credentials and reads merchant and location identity; it enqueues no sync job and writes no source record.",
  ],
  fieldCoverage: [],
  qualityAssertions: [
    "The pack declares no stream, so no coverage, freshness or completeness claim can be made from a Square connection.",
    "Square access tokens last 30 days; the credential vault refreshes ahead of expiry rather than relying on a request failing first.",
  ],
  limitations: [
    "No Square data is extracted, staged or projected. A connected Square account contributes nothing to an answer and must not be treated as coverage for sales, payments, inventory or workforce questions.",
    "Square revocation without revoke_only_access_token terminates every token the application holds for that merchant, so disconnect revokes the single access token and then destroys Albert's local credential.",
  ],
  unknownFieldPolicy: "quarantine_schema_drift",
};
