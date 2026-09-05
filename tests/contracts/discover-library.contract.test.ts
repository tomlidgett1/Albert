import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCOVER_CARD_TARGET,
  DISCOVER_CAPABILITY_CONNECTORS,
  DISCOVER_DOMAINS,
  DISCOVER_LIBRARY,
  normaliseDiscoverConnectors,
  normaliseDiscoverTitle,
  resolveDiscoverLibrary,
  selectDiscoverCards,
} from "../../services/discover/src/library.ts";
import {
  DISCOVER_MAX_PER_DOMAIN,
  DISCOVER_MODEL_MIN_CARDS,
  acceptModelCards,
} from "../../services/discover/src/synthesize.ts";

const wordCount = (value: string) => value.trim().split(/\s+/u).filter(Boolean).length;

test("every library entry is short, imperative copy with a self-contained prompt", () => {
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const item of DISCOVER_LIBRARY) {
    assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
    ids.add(item.id);
    const titleKey = normaliseDiscoverTitle(item.title);
    assert.ok(!titles.has(titleKey), `duplicate title ${item.title}`);
    titles.add(titleKey);
    assert.ok(wordCount(item.title) >= 3 && wordCount(item.title) <= 8, `title length: ${item.title}`);
    assert.ok(!/[.?!]$/u.test(item.title), `title punctuation: ${item.title}`);
    assert.ok(item.why.length >= 20 && item.why.length <= 160, `why length: ${item.id}`);
    assert.ok(item.prompt.length >= 20 && item.prompt.length <= 240, `prompt length: ${item.id}`);
    assert.ok(/[?.]$/u.test(item.prompt), `prompt must end as a sentence: ${item.id}`);
    assert.ok(!/\b(this|that|it)\b\s*$/iu.test(item.prompt), `prompt anaphora: ${item.id}`);
    assert.ok(item.needs.length >= 1 && item.needs.length <= 3, `needs: ${item.id}`);
    assert.ok((DISCOVER_DOMAINS as readonly string[]).includes(item.domain));
    for (const need of item.needs) assert.ok(DISCOVER_CAPABILITY_CONNECTORS[need].length > 0);
  }
  assert.ok(DISCOVER_LIBRARY.length >= DISCOVER_CARD_TARGET + 20, "the library must comfortably exceed one grid");
});

test("control-plane connector keys normalise to the public tool identifiers", () => {
  assert.deepEqual(
    [...normaliseDiscoverConnectors(["fivetran-xero", "deputy", "lightspeed-r", "fivetran-lightspeed", "unknown"])],
    ["lightspeed", "xero", "deputy"],
  );
  assert.deepEqual([...normaliseDiscoverConnectors([])], []);
});

test("a fully connected retailer gets thirty cards that only name connected tools, domains interleaved", () => {
  const connected = ["fivetran-xero", "fivetran-deputy", "lightspeed-r"];
  const cards = selectDiscoverCards(connected);
  assert.equal(cards.length, DISCOVER_CARD_TARGET);
  const allowed = new Set(normaliseDiscoverConnectors(connected));
  for (const card of cards) {
    assert.ok(card.tools.length >= 1 && card.tools.length <= 3);
    for (const tool of card.tools) assert.ok(allowed.has(tool), `${card.id} names ${tool}`);
  }
  const domainsPresent = new Set(cards.map((card) => card.domain));
  const firstRound = cards.slice(0, domainsPresent.size).map((card) => card.domain);
  assert.equal(new Set(firstRound).size, firstRound.length, "the first row of cards tours every available domain");
  const ids = cards.map((card) => card.id);
  assert.equal(new Set(ids).size, ids.length);
  // Cross-tool questions show what connecting tools unlocks.
  const takings = cards.find((card) => card.id === "cash-takings-to-bank");
  assert.ok(takings, "the POS-to-bank reconciliation card appears when both are connected");
  assert.deepEqual([...takings.tools], ["lightspeed", "xero"]);
  assert.deepEqual(selectDiscoverCards(connected), cards, "selection is deterministic");
});

test("an accounting-only tenant never sees point-of-sale or workforce questions", () => {
  const cards = selectDiscoverCards(["fivetran-xero"]);
  assert.ok(cards.length >= 6);
  for (const card of cards) {
    assert.deepEqual([...card.tools], ["xero"]);
    assert.ok(!["sales", "products", "inventory", "workshop", "online", "memberships"].includes(card.domain), card.id);
  }
  assert.deepEqual(selectDiscoverCards([]), []);
  assert.deepEqual(resolveDiscoverLibrary(["nothing-connected"]), []);
});

test("capabilities resolve to the tenant's own tool when several could answer", () => {
  const square = selectDiscoverCards(["square", "fivetran-stripe"]);
  assert.ok(square.every((card) => card.tools.every((tool) => tool === "square" || tool === "stripe")));
  assert.ok(square.some((card) => card.domain === "memberships"), "Stripe unlocks subscription questions");
  assert.ok(square.some((card) => card.id === "staff-sales-per-labour-hour" && card.tools.join(",") === "square"),
    "Square covers both the point of sale and the labour capability on its own");
});

test("model output is accepted only when it is grounded, deduplicated and balanced", () => {
  const base = {
    why: "This is a reason with enough words to explain what changes.",
    prompt: "Show me the thing over the last 12 weeks by week?",
  };
  const cards = Array.from({ length: DISCOVER_CARD_TARGET }, (_, index) => ({
    ...base,
    title: `Look at area number ${index}`,
    prompt: `Show me area number ${index} over the last 12 weeks by week?`,
    domain: DISCOVER_DOMAINS[index % DISCOVER_DOMAINS.length],
    tools: ["xero" as const],
  }));
  const accepted = acceptModelCards(cards, ["xero"]);
  assert.ok(accepted && accepted.length === DISCOVER_CARD_TARGET);
  assert.ok(accepted.every((card) => card.id.startsWith("disc-")));

  const withUnknownTool = acceptModelCards(cards.map((card) => ({ ...card, tools: ["shopify" as const] })), ["xero"]);
  assert.equal(withUnknownTool, null, "cards naming unconnected tools are dropped");

  const duplicated = acceptModelCards(cards.map((card) => ({ ...card, title: "Explore the same idea", prompt: "Same question again for the last month?" })), ["xero"]);
  assert.equal(duplicated, null, "duplicate titles collapse to one card");

  const lopsided = acceptModelCards(cards.map((card) => ({ ...card, domain: "sales" as const })), ["xero"]);
  assert.equal(lopsided, null, `no domain may exceed ${DISCOVER_MAX_PER_DOMAIN} cards`);

  const questionTitles = acceptModelCards(cards.map((card) => ({ ...card, title: `${card.title}?` })), ["xero"]);
  assert.equal(questionTitles, null, "titles are imperative, never questions");

  const tooFew = acceptModelCards(cards.slice(0, DISCOVER_MODEL_MIN_CARDS - 1), ["xero"]);
  assert.equal(tooFew, null);
});
