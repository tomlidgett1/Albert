/**
 * Which connected tool a recommended question reads, for the logo beside
 * it on the homepage panel (ADR 0117 surface, ADR 0133 daily look).
 * Pure: no I/O, no model.
 */
import { normalizeV3Connector } from "../../../packages/albert-v3/src/engine/connector-routing.js";
import type { TraceConnector } from "../../../packages/shared/src/index.js";
import type { AnalysisDomain, RecommendedQuestion } from "./playbook.js";

/** Owner-facing tool names; also how a model names the tool in a daily-look line. */
export const RECOMMENDED_TOOL_NAMES: Readonly<Record<TraceConnector, string>> = Object.freeze({
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
});

const RECOMMENDED_TOOLS = Object.freeze(Object.keys(RECOMMENDED_TOOL_NAMES) as TraceConnector[]);

/** Connected tools in preference order for each analysis domain. */
const DOMAIN_TOOLS: Readonly<Record<AnalysisDomain, readonly TraceConnector[]>> = Object.freeze({
  sales: ["lightspeed", "lightspeed-x", "square", "shopify", "momence", "stripe"],
  customers: ["lightspeed", "lightspeed-x", "square", "shopify", "momence", "stripe"],
  products: ["lightspeed", "lightspeed-x", "square", "shopify"],
  inventory: ["lightspeed", "lightspeed-x", "square", "shopify"],
  cash: ["xero", "square", "stripe", "shopify", "lightspeed", "lightspeed-x"],
  profit: ["xero", "lightspeed", "lightspeed-x", "square", "shopify"],
  staff: ["deputy", "square", "lightspeed", "lightspeed-x"],
  workshop: ["lightspeed", "lightspeed-x"],
});

export function isRecommendedTool(value: unknown): value is TraceConnector {
  return typeof value === "string" && (RECOMMENDED_TOOLS as readonly string[]).includes(value);
}

/** Control-plane connector keys (lightspeed-r, fivetran-xero, …) → public tool ids, deduplicated, catalogue order. */
export function normaliseRecommendedTools(connectorKeys: readonly string[]): readonly TraceConnector[] {
  const found = new Set<TraceConnector>();
  for (const key of connectorKeys) {
    const tool = normalizeV3Connector(key);
    if (tool) found.add(tool);
  }
  return Object.freeze(RECOMMENDED_TOOLS.filter((tool) => found.has(tool)));
}

/** The connected tool that answers a domain, or null when none of the connected tools can. */
export function toolForDomain(domain: AnalysisDomain, connectorKeys: readonly string[]): TraceConnector | null {
  const connected = new Set(normaliseRecommendedTools(connectorKeys));
  return DOMAIN_TOOLS[domain].find((tool) => connected.has(tool)) ?? null;
}

/** The domain a tool most naturally speaks for, when the question itself names none. */
export function domainForTool(tool: TraceConnector): AnalysisDomain {
  switch (tool) {
    case "xero":
    case "stripe":
      return "cash";
    case "deputy":
      return "staff";
    default:
      return "sales";
  }
}

/**
 * Reads a tool name the way a model wrote it ("Lightspeed", "Lightspeed
 * Retail", "xero", "Deputy") back to a connected tool; null for anything
 * else, including a tool that is not connected.
 */
export function toolFromLabel(label: string, connectorKeys: readonly string[]): TraceConnector | null {
  const connected = normaliseRecommendedTools(connectorKeys);
  const words = label.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().split(" ").filter(Boolean);
  const head = words[0];
  if (!head) return null;
  if (head === "lightspeed") {
    const wantsX = words.some((word) => word === "x" || word === "xseries" || word === "vend");
    if (wantsX && connected.includes("lightspeed-x")) return "lightspeed-x";
    if (connected.includes("lightspeed")) return "lightspeed";
    return connected.includes("lightspeed-x") ? "lightspeed-x" : null;
  }
  return connected.find((tool) => {
    const name = RECOMMENDED_TOOL_NAMES[tool].toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
    return name === words.join(" ") || name.split(" ")[0] === head;
  }) ?? null;
}

/** Every row carries the tool its logo shows; a stored row without one is read from its domain. */
export function withRecommendedTools(
  recommendations: readonly RecommendedQuestion[],
  connectorKeys: readonly string[],
): readonly RecommendedQuestion[] {
  return Object.freeze(recommendations.map((item) => Object.freeze({
    ...item,
    tool: isRecommendedTool(item.tool) ? item.tool : toolForDomain(item.domain, connectorKeys),
  })));
}
