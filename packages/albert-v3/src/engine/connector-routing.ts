import type { TraceConnector } from "../../../shared/src/index.js";
import type { AlbertV3AgentConfig } from "../agent-config/loader.js";
import type { ConversationMessage, Lane } from "./orchestrator.js";

export type V3ToolRoute = Readonly<{
  cube: boolean;
  shopifyQL: boolean;
  shopifyAdmin: boolean;
  /** Tenant-connected Cube connectors visible to catalogue retrieval. */
  activeCubeConnectors: readonly string[];
  /** Explicit/inherited source hints boost search but never erase other active views. */
  preferredCubeConnectors: readonly string[];
  mode: "cube" | "shopifyql" | "shopify_admin" | "mixed" | "explain";
  reasons: readonly string[];
}>;

const KNOWN_TRACE_CONNECTORS = new Set<TraceConnector>([
  "lightspeed", "lightspeed-x", "xero", "deputy", "square", "shopify", "stripe",
  "momence", "meta-ads", "google-ads",
]);

/** Control-plane connector keys and public trace identifiers are intentionally not identical. */
export function normalizeV3Connector(value: string): TraceConnector | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "lightspeed-r") return "lightspeed";
  return KNOWN_TRACE_CONNECTORS.has(normalized as TraceConnector)
    ? normalized as TraceConnector
    : undefined;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[’']/gu, "").replace(/[^a-z0-9]+/gu, " ").trim();
}

function explicitConnectorHints(value: string, available: ReadonlySet<string>): readonly string[] {
  const text = compact(value);
  const found = new Set<string>();
  const add = (connector: string) => {
    if (available.has(connector)) found.add(connector);
  };

  // R-Series and X-Series are distinct products. Bare "Lightspeed" is
  // deliberately ambiguous and widens to both when both are connected.
  if (/\b(?:lightspeed retail )?(?:x series|xseries)|\bvend\b/u.test(text)) add("lightspeed-x");
  if (/\b(?:lightspeed retail )?(?:r series|rseries)\b/u.test(text)) add("lightspeed");
  if (/\blightspeed\b/u.test(text) && !/\b(?:x series|xseries|r series|rseries)\b/u.test(text)) {
    add("lightspeed");
    add("lightspeed-x");
  }
  for (const connector of [
    "xero", "deputy", "square", "shopify", "stripe", "momence", "meta-ads", "google-ads",
  ]) {
    const aliases = connector === "meta-ads"
      ? ["meta ads", "facebook ads", "instagram ads"]
      : connector === "google-ads"
        ? ["google ads", "adwords"]
        : [connector];
    if (aliases.some((alias) => text.includes(alias))) add(connector);
  }
  return [...found].sort();
}

function inferredCubeConnectorHints(
  value: string,
  available: ReadonlySet<string>,
): readonly string[] {
  const text = compact(value);
  const found = new Set<string>();
  if (available.has("xero") && /\b(?:profit and loss|p l|balance sheet|cash flow statement|accounts? payable|accounts? receivable|aged payables?|aged receivables?|bank reconciliation|general ledger|chart of accounts|journal entries?|supplier bills?|customer invoices?|bas return|gst return|pay runs?|payslips?|superannuation)\b/u.test(text)) {
    found.add("xero");
  }
  if (available.has("deputy") && /\b(?:rosters?|rostered hours?|employee availability|leave requests?|leave balances?|scheduled shifts?)\b/u.test(text)) {
    found.add("deputy");
  }
  if (found.size === 0 && ORDINARY_COMMERCE.test(value)) {
    const connectedCommerce = ["lightspeed", "lightspeed-x", "square", "shopify", "momence"]
      .filter((connector) => available.has(connector));
    if (connectedCommerce.length === 1) found.add(connectedCommerce[0]!);
  }
  return [...found].sort();
}

function isRefinement(value: string): boolean {
  const text = value.trim().toLowerCase();
  return text.length <= 220 && (
    /^(?:add|also|and|but|compare|include|now|same|what about|break (?:it|that) down)\b/u.test(text)
    || /\b(?:as well|instead|too)\b/u.test(text)
  );
}

function inheritedViewNames(conversation: readonly ConversationMessage[]): readonly string[] {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message?.role !== "assistant" || !message.governedQueries?.length) continue;
    return message.governedQueries.map(({ view }) => view);
  }
  return [];
}

function connectorForView(view: string, config: AlbertV3AgentConfig): string | undefined {
  return config.accessibleViews.find((candidate) => candidate.name === view)?.connector;
}

const SHOPIFY_QL_NATIVE = /\b(?:website traffic|web traffic|storefront|landing pages?|sessions?|visitors?|conversion(?: rate| funnel)?|checkout conversion|search(?:ing|es| terms?| queries)?|attribution|referr(?:al|er|ing)|marketing channels?|cohorts?|bounce rate|web performance|chargebacks?)\b/iu;
const SHOPIFY_ADMIN_NATIVE = /\b(?:admin api|metafields?|metaobjects?|custom fields?|graphql fields?|gid|seo title|seo description|product handles?|variant barcodes?|merchant notes?|order notes?|customer tags?|product tags?|publication status|inventory items?)\b/iu;
const ORDINARY_COMMERCE = /\b(?:sales?|revenue|takings?|turnover|orders?|refunds?|returns?|products?|inventory|stock|customers?|profit|margin|discounts?|fulfilments?|fulfillments?)\b/iu;

/** High-precision Shopify-native reporting detector retained for route compatibility tests. */
export function looksLikeShopifyQLQuestion(value: string): boolean {
  return SHOPIFY_QL_NATIVE.test(value)
    || (/\bshopify\b/iu.test(value) && /\b(?:profitability|gross margins?)\b/iu.test(value));
}

export function looksLikeShopifyAdminQuestion(value: string): boolean {
  const hasShopifyAnchor = /\bshopify\b/iu.test(value);
  return hasShopifyAnchor && SHOPIFY_ADMIN_NATIVE.test(value);
}

/**
 * Resolves execution planes before any model tool schema is exposed. Ambiguous
 * Cube-source wording stays broad across connected sources; only high-precision
 * Shopify-native intents hide unrelated tool families.
 */
export function resolveV3ToolRoute(input: Readonly<{
  question: string;
  resolvedQuestion: string;
  lane: Lane;
  conversation: readonly ConversationMessage[];
  config: AlbertV3AgentConfig;
  activeConnectors?: readonly string[];
  cubeAvailable: boolean;
  shopifyQLAvailable: boolean;
  shopifyAdminAvailable: boolean;
}>): V3ToolRoute {
  const configured = new Set(input.config.accessibleViews.map(({ connector }) => connector));
  const normalizedActive = [...new Set((input.activeConnectors ?? [])
    .flatMap((connector) => {
      const normalized = normalizeV3Connector(connector);
      return normalized && configured.has(normalized) ? [normalized] : [];
    }))].sort();
  // Missing/stale connection state widens safely to the full configured
  // surface. It is a cost optimisation, never a semantic authorization gate.
  const activeCubeConnectors = normalizedActive.length > 0
    ? normalizedActive
    : [...configured].sort();
  const available = new Set(activeCubeConnectors);
  const combinedQuestion = `${input.question}\n${input.resolvedQuestion}`;
  const explicit = explicitConnectorHints(combinedQuestion, available);
  const inferred = explicit.length === 0
    ? inferredCubeConnectorHints(combinedQuestion, available)
    : [];
  const priorViews = inheritedViewNames(input.conversation);
  const inherit = input.lane === "explain" || isRefinement(input.question);
  const inheritedCubeConnectors = inherit
    ? priorViews.flatMap((view) => {
        if (view.startsWith("shopifyql:") || view.startsWith("shopify-admin:")) return [];
        const connector = connectorForView(view, input.config);
        return connector && available.has(connector) ? [connector] : [];
      })
    : [];
  const preferredCubeConnectors = [...new Set([
    ...explicit,
    ...inferred,
    ...inheritedCubeConnectors,
  ])].sort();

  const shopifyConnected = input.activeConnectors === undefined
    || input.activeConnectors.length === 0
    || input.activeConnectors.some((connector) => normalizeV3Connector(connector) === "shopify");
  const qlIntent = looksLikeShopifyQLQuestion(combinedQuestion);
  const adminIntent = looksLikeShopifyAdminQuestion(combinedQuestion);
  const inheritedQL = inherit && priorViews.some((view) => view.startsWith("shopifyql:"));
  const inheritedAdmin = inherit && priorViews.some((view) => view.startsWith("shopify-admin:"));
  const deepShopifyReview = input.lane === "deep" && /\bshopify\b/iu.test(combinedQuestion);
  const shopifyQL = input.shopifyQLAvailable && shopifyConnected && (qlIntent || inheritedQL || deepShopifyReview);
  const shopifyAdmin = input.shopifyAdminAvailable && shopifyConnected && (adminIntent || inheritedAdmin);

  const hasNonShopifyPreferred = preferredCubeConnectors.some((connector) => connector !== "shopify");
  const mixedCommerce = (hasNonShopifyPreferred && (shopifyQL || shopifyAdmin))
    || (/\b(?:compare|reconcile|versus|vs)\b/iu.test(combinedQuestion) && explicit.length > 1);
  let nativeRemainder = combinedQuestion
    .replace(SHOPIFY_QL_NATIVE, "")
    .replace(SHOPIFY_ADMIN_NATIVE, "")
    .replace(/\b(?:profitability|gross margins?)\b/giu, "");
  if (adminIntent) {
    // Object names qualify the Admin field lookup; they do not independently
    // request the canonical Cube concept. Material commerce terms such as
    // sales/refunds remain and correctly create a mixed route.
    nativeRemainder = nativeRemainder.replace(
      /\b(?:products?|variants?|orders?|customers?|inventory|items?|metaobjects?)\b/giu,
      "",
    );
  }
  const purelyNativeLive = (shopifyQL || shopifyAdmin)
    && !mixedCommerce
    && !ORDINARY_COMMERCE.test(nativeRemainder);
  const cube = input.cubeAvailable && !purelyNativeLive;

  const reasons: string[] = [];
  if (explicit.length > 0) reasons.push(`explicit connectors: ${explicit.join(", ")}`);
  if (inferred.length > 0) reasons.push(`deterministic domain route: ${inferred.join(", ")}`);
  if (inheritedCubeConnectors.length > 0 || inheritedQL || inheritedAdmin) reasons.push("prior governed query");
  if (qlIntent) reasons.push("Shopify-native reporting intent");
  if (adminIntent) reasons.push("Shopify Admin object/field intent");
  if (reasons.length === 0) reasons.push("broad connected semantic route");

  const mode: V3ToolRoute["mode"] = input.lane === "explain"
    ? "explain"
    : cube && (shopifyQL || shopifyAdmin)
      ? "mixed"
      : shopifyAdmin
        ? "shopify_admin"
        : shopifyQL
          ? "shopifyql"
          : "cube";
  return Object.freeze({
    cube,
    shopifyQL,
    shopifyAdmin,
    activeCubeConnectors: Object.freeze(activeCubeConnectors),
    preferredCubeConnectors: Object.freeze(preferredCubeConnectors),
    mode,
    reasons: Object.freeze(reasons),
  });
}
