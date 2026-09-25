import type { TraceProvenance } from "@/packages/shared/src";

export type TraceConnectorId = TraceProvenance["sources"][number]["connector"];

/** Logo assets for every tool Albert can source data from. */
export const CONNECTOR_LOGOS: Record<TraceConnectorId, string> = {
  lightspeed: "/logos/lightspeed.png",
  "lightspeed-x": "/logos/lightspeed.png",
  xero: "/logos/xero.svg",
  deputy: "/logos/deputy.png",
  square: "/logos/square.svg",
  shopify: "/logos/shopify.svg",
  stripe: "/logos/stripe.svg",
  momence: "/logos/momence.svg",
  "meta-ads": "/logos/meta.svg",
  "google-ads": "/logos/google-ads.svg",
};

export const CONNECTOR_NAMES: Record<TraceConnectorId, string> = {
  lightspeed: "Lightspeed",
  "lightspeed-x": "Lightspeed X-Series",
  xero: "Xero",
  deputy: "Deputy",
  square: "Square",
  shopify: "Shopify",
  stripe: "Stripe",
  momence: "Momence",
  "meta-ads": "Meta Ads",
  "google-ads": "Google Ads",
};
