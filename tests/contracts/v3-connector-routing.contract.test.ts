import assert from "node:assert/strict";
import test from "node:test";

import { loadAgentConfig } from "../../packages/albert-v3/src/agent-config/loader.ts";
import {
  normalizeV3Connector,
  resolveV3ToolRoute,
} from "../../packages/albert-v3/src/engine/connector-routing.ts";
import { createV3Tools } from "../../packages/albert-v3/src/engine/tools.ts";

type RouteInput = Parameters<typeof resolveV3ToolRoute>[0];

const config = loadAgentConfig();
const activeConnectors = [
  "lightspeed-r",
  "lightspeed-x",
  "xero",
  "deputy",
  "square",
  "shopify",
  "momence",
] as const;

function route(question: string, overrides: Partial<RouteInput> = {}) {
  return resolveV3ToolRoute({
    question,
    resolvedQuestion: question,
    lane: "quick",
    conversation: [],
    config,
    activeConnectors,
    cubeAvailable: true,
    shopifyQLAvailable: true,
    shopifyAdminAvailable: true,
    ...overrides,
  });
}

function toolNames(result: ReturnType<typeof route>): readonly string[] {
  return createV3Tools({ route: result, lane: "quick", purpose: "answer" })
    .map(({ name }) => name);
}

test("connector normalization preserves distinct Lightspeed products and rejects unknown keys", () => {
  assert.equal(normalizeV3Connector("lightspeed-r"), "lightspeed");
  assert.equal(normalizeV3Connector("lightspeed-x"), "lightspeed-x");
  assert.equal(normalizeV3Connector(" XERO "), "xero");
  assert.equal(normalizeV3Connector("fivetran-stripe"), "stripe");
  assert.equal(normalizeV3Connector("fivetran-xero"), "xero");
  assert.equal(normalizeV3Connector("fivetran-deputy"), "deputy");
  assert.equal(normalizeV3Connector("future-connector"), undefined);
});

test("ordinary governed analytics takes the Cube route with deterministic connector preference", () => {
  const result = route("Show unpaid Xero invoices by month");

  assert.equal(result.mode, "cube");
  assert.equal(result.cube, true);
  assert.equal(result.shopifyQL, false);
  assert.equal(result.shopifyAdmin, false);
  assert.deepEqual(result.preferredCubeConnectors, ["xero"]);
  assert.deepEqual(toolNames(result), [
    // Native reports ride alongside Cube. The governed CubeCore views stay
    // the authority for P&L FIGURES; the live P&L tool presents the full
    // statement when the owner asks to see it (ADR 0099 + 0108).
    "xero_profit_and_loss",
    "xero_balance_sheet",
    "xero_trial_balance",
    "xero_find_contact",
    "xero_aged_receivables",
    "xero_aged_payables",
    "xero_organisation_details",
    "search_semantic_catalogue",
    "get_view_schema",
    "run_cube_query",
    "make_chart",
    "record_source_finding",
    "present_result",
  ]);
});

test("high-confidence accounting and roster domains route deterministically without vendor words", () => {
  const accounting = route("Show the profit and loss, aged receivables and bank reconciliation");
  assert.deepEqual(accounting.preferredCubeConnectors, ["xero"]);
  assert.equal(accounting.cube, true);

  const workforce = route("Compare rostered hours with leave requests");
  assert.deepEqual(workforce.preferredCubeConnectors, ["deputy", "square"]);
  assert.equal(workforce.cube, true);

  const ambiguousTax = route("How much GST did we collect on sales?");
  assert.deepEqual(ambiguousTax.preferredCubeConnectors, []);
});

test("a sole active commerce connector narrows generic sales without guessing across tenants", () => {
  const single = route("How were sales yesterday?", { activeConnectors: ["square"] });
  assert.deepEqual(single.activeCubeConnectors, ["square"]);
  assert.deepEqual(single.preferredCubeConnectors, ["square"]);

  const multiple = route("How were sales yesterday?");
  assert.deepEqual(multiple.preferredCubeConnectors, []);
});

test("Shopify-native reporting exposes ShopifyQL without unrelated Cube tools", () => {
  const result = route("Show Shopify storefront sessions and conversion rate by landing page");

  assert.equal(result.mode, "shopifyql");
  assert.equal(result.cube, false);
  assert.equal(result.shopifyQL, true);
  assert.equal(result.shopifyAdmin, false);
  assert.deepEqual(toolNames(result), [
    "list_shopify_admin_stores",
    "search_shopifyql_catalogue",
    "run_shopifyql_query",
    "make_chart",
    "record_source_finding",
    "present_result",
  ]);
});

test("Shopify long-tail object metadata exposes the Admin read plane only", () => {
  const result = route("Which Shopify metaobjects have publication status active?");

  assert.equal(result.mode, "shopify_admin");
  assert.equal(result.cube, false);
  assert.equal(result.shopifyQL, false);
  assert.equal(result.shopifyAdmin, true);
  assert.deepEqual(toolNames(result), [
    "list_shopify_admin_stores",
    "search_shopify_admin_catalogue",
    "run_shopify_admin_query",
    "make_chart",
    "record_source_finding",
    "present_result",
  ]);
});

test("Shopify long-tail fields do not expose Cube merely because their object is named", () => {
  for (const question of [
    "Show Shopify product metafields",
    "Look up the SEO title of Shopify products",
    "Which Shopify orders have merchant notes?",
  ]) {
    const result = route(question);
    assert.equal(result.mode, "shopify_admin", question);
    assert.equal(result.cube, false, question);
    assert.equal(result.shopifyAdmin, true, question);
  }

  const canonical = route("Show ordinary Shopify product sales");
  assert.equal(canonical.mode, "cube");
  assert.equal(canonical.cube, true);
  assert.equal(canonical.shopifyAdmin, false);
});

test("cross-connector questions expose the union of required execution planes", () => {
  const result = route("Compare Shopify storefront conversion with Square sales");

  assert.equal(result.mode, "mixed");
  assert.equal(result.cube, true);
  assert.equal(result.shopifyQL, true);
  assert.equal(result.shopifyAdmin, false);
  assert.deepEqual(result.preferredCubeConnectors, ["shopify", "square"]);
});

test("Shopify-native reporting plus an inferred accounting domain exposes both planes", () => {
  const result = route("Compare storefront conversion with the profit and loss");
  assert.equal(result.mode, "mixed");
  assert.equal(result.cube, true);
  assert.equal(result.shopifyQL, true);
  assert.deepEqual(result.preferredCubeConnectors, ["xero"]);
});

test("short follow-ups inherit the previous governed execution plane", () => {
  const cubeFollowUp = route("And break that down by month", {
    conversation: [{
      role: "assistant",
      text: "Here is the prior result.",
      governedQueries: [{
        view: "xero_finance_analytics",
        topic: "Outstanding invoices",
        queryYaml: "measures:\n  - xero_finance_analytics.outstanding_amount",
      }],
    }],
  });
  assert.equal(cubeFollowUp.mode, "cube");
  assert.deepEqual(cubeFollowUp.preferredCubeConnectors, ["xero"]);

  const qlFollowUp = route("Now by device type", {
    conversation: [{
      role: "assistant",
      text: "Here is the prior result.",
      governedQueries: [{
        view: "shopifyql:sessions",
        topic: "Storefront sessions",
        queryYaml: "shopifyql.ir: {}",
      }],
    }],
  });
  assert.equal(qlFollowUp.mode, "shopifyql");
  assert.equal(qlFollowUp.cube, false);
  assert.equal(qlFollowUp.shopifyQL, true);

  const adminFollowUp = route("And include publication status", {
    conversation: [{
      role: "assistant",
      text: "Here is the prior result.",
      governedQueries: [{
        view: "shopify-admin:metaobjects",
        topic: "Metaobjects",
        queryYaml: "shopify-admin.ir: {}",
      }],
    }],
  });
  assert.equal(adminFollowUp.mode, "shopify_admin");
  assert.equal(adminFollowUp.cube, false);
  assert.equal(adminFollowUp.shopifyAdmin, true);
});

test("missing or stale connection metadata fails open to configured Cube coverage", () => {
  const configured = [...new Set(config.accessibleViews.map(({ connector }) => connector))].sort();

  const missing = route("How are sales this week?", { activeConnectors: undefined });
  assert.equal(missing.cube, true);
  assert.deepEqual(missing.activeCubeConnectors, configured);

  const stale = route("How are sales this week?", { activeConnectors: ["future-connector"] });
  assert.equal(stale.cube, true);
  assert.deepEqual(stale.activeCubeConnectors, configured);
  assert.equal(stale.shopifyQL, false);
  assert.equal(stale.shopifyAdmin, false);
});

test("an unavailable live plane degrades to the governed Cube surface", () => {
  const result = route("Show Shopify storefront sessions and conversion rate", {
    shopifyQLAvailable: false,
  });

  assert.equal(result.mode, "cube");
  assert.equal(result.cube, true);
  assert.equal(result.shopifyQL, false);
  assert.equal(result.shopifyAdmin, false);
});

test("bare 'Lightspeed' resolves to the connected series and is never disclosed as unconnected", () => {
  // R-Series only tenant (the common Fivetran path). Bare "Lightspeed" must not
  // produce a "lightspeed-x is not connected" disclosure.
  const rOnly = route("Labour efficiency using Deputy and Lightspeed data", {
    activeConnectors: ["fivetran-lightspeed", "xero", "deputy"],
  });
  assert.deepEqual(rOnly.unavailableRequestedConnectors, []);
  assert.deepEqual(rOnly.preferredCubeConnectors, ["deputy", "lightspeed"]);
  assert.ok(!rOnly.reasons.some((reason) => reason.includes("not connected")));

  // X-Series only tenant, mirror case.
  const xOnly = route("Sales from Lightspeed last week", {
    activeConnectors: ["lightspeed-x"],
  });
  assert.deepEqual(xOnly.unavailableRequestedConnectors, []);
  assert.deepEqual(xOnly.preferredCubeConnectors, ["lightspeed-x"]);

  // Naming the series explicitly still discloses a genuinely unconnected product.
  const namedX = route("Show me Lightspeed X-Series sales", {
    activeConnectors: ["lightspeed-r", "xero"],
  });
  assert.deepEqual(namedX.unavailableRequestedConnectors, ["lightspeed-x"]);
  const namedVend = route("What did Vend record yesterday?", {
    activeConnectors: ["lightspeed-r"],
  });
  assert.deepEqual(namedVend.unavailableRequestedConnectors, ["lightspeed-x"]);

  // No Lightspeed at all: bare mention is a real gap and is disclosed.
  const none = route("Sales from Lightspeed last week", {
    activeConnectors: ["xero", "deputy"],
  });
  assert.deepEqual(none.unavailableRequestedConnectors, ["lightspeed", "lightspeed-x"]);
});
