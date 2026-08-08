import { authorizationOnlyManifest } from "../../packages/connector-sdk/src/index.js";

/**
 * Stripe documents `read_only` as available to extensions only; a standard
 * platform must request `read_write`. The grant is therefore deliberately
 * wider than Albert can use, and the pack contains no Stripe write method.
 */
export const STRIPE_DEFAULT_SCOPES = ["read_write"] as const;

export const STRIPE_ALLOWED_SCOPES = ["read_write", "read_only"] as const;

export const stripeManifest = authorizationOnlyManifest({
  id: "stripe",
  displayName: "Stripe",
  packVersion: "0.1.0",
  apiVersion: "Stripe Connect OAuth",
  releasedAt: "2026-08-06",
  documentation: [
    "https://docs.stripe.com/connect/oauth-reference",
    "https://docs.stripe.com/connect/oauth-changes-for-standard-platforms",
    "https://docs.stripe.com/connect/authentication",
  ],
  scopes: STRIPE_DEFAULT_SCOPES,
  leastPrivilegeNotes: [
    "Stripe restricts read_only to extensions, so a standard platform can only request read_write. The grant exceeds what Albert can use by vendor constraint, not by choice, and the pack contains no Stripe write method.",
    "Stripe deprecated per-connection access and refresh tokens in favour of the platform secret key with a Stripe-Account header. The durable credential for a Stripe connection is therefore the connected account id, not a bearer token.",
  ],
  refreshTokenRotation: false,
  remoteRevocation: "supported",
  identityRules: [
    "A Stripe connection is identified by its stripe_user_id (the connected account id). That id, not a token, is what authorises later platform-key requests.",
  ],
  topology: [],
  qualityAssertions: [
    "Stripe authorization codes are single use and expire in five minutes; consuming one twice revokes the connection, so the exchange is never retried against the same code.",
  ],
  limitations: [
    "No Stripe access token is persisted as a usable bearer credential. Stripe access is exercised with the platform secret key plus the Stripe-Account header, which lives outside this pack.",
    "Deauthorization only applies to Standard accounts; accounts controlled by another platform must be handled through Stripe's rejection API instead.",
  ],
});
