import assert from "node:assert/strict";
import test from "node:test";
import { renderBusinessContextSection, renderCalendarLine, renderOmniInstructions } from "../../packages/albert-omni/src/prompts";
import { omniServiceTurnSchema } from "../../packages/albert-omni/src/contracts";
import { deriveConnectorFreshness, type FreshnessProbeCube } from "../../packages/albert-v3/src/engine/freshness";

// ADR 0142: a business profile's dated coverage notes must never read as
// today's data cutoff, and every turn must carry a present-day freshness
// anchor derived from the data when the control plane has none.

const PROFILE = [
  "# About this business",
  "**Connected tools**: Lightspeed Retail (R-Series) (lightspeed-r): source of truth for sales [data from 2016-01-01 through 2026-08-24]. Deputy (deputy): rosters [data from 2018-04-14 through 2026-08-24].",
].join("\n");

test("the business-context section stamps the profile date and rewrites every coverage note as historical", () => {
  const section = renderBusinessContextSection({
    businessContext: PROFILE,
    businessContextGeneratedAt: "2026-08-24T10:36:28.601493+00:00",
    timezone: "Australia/Melbourne",
  });
  assert.match(section, /written on 24 August 2026 from the data available then/u);
  assert.match(section, /never as evidence of current data freshness/u);
  assert.equal(section.includes("[data from"), false, "raw coverage notes never reach the model");
  assert.equal(
    (section.match(/\[covered 2016-01-01 through 2026-08-24 when this profile was written on 24 August 2026; not today's cutoff\]/gu) ?? []).length,
    1,
  );
  assert.match(section, /\[covered 2018-04-14 through 2026-08-24 when this profile was written on 24 August 2026; not today's cutoff\]/u);

  const undated = renderBusinessContextSection({ businessContext: PROFILE });
  assert.match(undated, /written at an earlier date/u);
  assert.match(undated, /when this profile was written at an earlier date; not today's cutoff/u);
  assert.equal(renderBusinessContextSection({}), "");
});

test("the analyst instructions forbid taking a cutoff from the profile and require a latest-date query for recency questions", () => {
  const instructions = renderOmniInstructions({
    topicIndex: "- sales_analytics", topicCount: 1, timezone: "Australia/Melbourne", currency: "AUD",
    todayLine: "Today is Friday, 18 September 2026 (2026-09-18).", activeConnectors: ["lightspeed-r"], freshnessLines: "",
    businessContext: PROFILE, businessContextGeneratedAt: "2026-08-24T10:36:28Z",
  });
  assert.match(instructions, /Never take a cutoff from the business context or any earlier profile, and never cap a dateRange at such a date/u);
  assert.match(instructions, /when the store was last open or closed/u);
  assert.match(instructions, /latest-date query \(daily grain over the most recent 14 days, ordered descending\)/u);
  // With syncing stopped, a live answer blamed a sync that "typically completes
  // within a few hours of trading": the model cannot see sync status, so it
  // states the last date and never explains or predicts the gap.
  assert.match(instructions, /When a source's data ends before yesterday, say so plainly with its last date/u);
  assert.match(instructions, /You cannot see why a source is behind or when it will catch up, so never guess at either/u);
  assert.doesNotMatch(instructions, /kept syncing|keep syncing/u);
  assert.match(instructions, /# Business Context\n\nBackground knowledge about the business, written on 24 August 2026/u);
  assert.doesNotMatch(instructions, /\[data from/u);
});

test("the service turn carries the profile's generation date optionally", () => {
  const id = "01J00000000000000000000001";
  const base = {
    protocolVersion: 1, requestId: id, tenantId: id, actorId: "00000000-0000-4000-8000-000000000001", role: "owner",
    conversationId: id, turnId: id, message: "When was the store last closed?", priorConversation: [],
    activeConnectors: ["lightspeed-r"], connectorFreshness: [], cubeBearer: "a.b.c", model: "gpt-5.6-luna", effort: "max", fastMode: false,
  };
  assert.equal(omniServiceTurnSchema.safeParse(base).success, true);
  assert.equal(omniServiceTurnSchema.safeParse({ ...base, businessContext: PROFILE, businessContextGeneratedAt: "2026-08-24T10:36:28Z" }).success, true);
  assert.equal(omniServiceTurnSchema.safeParse({ ...base, businessContextGeneratedAt: "" }).success, false);
});

test("freshness is derived from latest-date probes through any governed Cube client and control-plane watermarks still win", async () => {
  const queries: Array<{ member: string; direction: string }> = [];
  const cube: FreshnessProbeCube = {
    loadQuery: async (query) => {
      const dimension = query.timeDimensions?.[0]?.dimension ?? "";
      const direction = Object.values(query.order ?? {})[0] ?? "";
      queries.push({ member: dimension, direction });
      const latestByMember: Record<string, string> = {
        "sales_analytics.completed_at": "2026-09-18T00:00:00.000",
        "workforce_analytics.shift_date": "2026-09-12T00:00:00.000",
      };
      const value = direction === "desc" ? latestByMember[dimension] : "2016-01-04T00:00:00.000";
      return { result: { ok: true, rows: value ? [{ [`${dimension}.day`]: value }] : [], executionMs: 3 } };
    },
  };
  const freshness = await deriveConnectorFreshness({
    cube,
    tenantId: `01J0000000000000000000${Date.now().toString(36).slice(-4).toUpperCase().padStart(4, "0")}`,
    probes: [
      { connector: "lightspeed", domain: "sales", member: "sales_analytics.completed_at" },
      { connector: "deputy", domain: "timesheets", member: "workforce_analytics.shift_date" },
      { connector: "xero", domain: "bank", member: "xero_finance_analytics.bank_occurred_on" },
    ],
    activeConnectors: ["lightspeed", "deputy", "xero"],
    known: [{ connector: "xero", domain: "bank", dataThrough: "2026-09-17" }],
  });
  assert.deepEqual(
    freshness.map((entry) => [entry.connector, entry.domain, entry.dataThrough, entry.dataFrom ?? null]),
    [["xero", "bank", "2026-09-17", null], ["lightspeed", "sales", "2026-09-18", "2016-01-04"], ["deputy", "timesheets", "2026-09-12", "2016-01-04"]],
  );
  assert.equal(queries.some((query) => query.member.startsWith("xero_")), false, "a known watermark is never re-probed");
});

// Four Omni turns starting together on a cold cache each fired the full probe
// set (56 queries), every set missed the critical-path budget, and all four
// went without a data cutoff: each spent a step finding the latest day itself
// and had correct dates after the cutoff refused by the composer.
const probeTenant = (suffix: string) => `01J1${suffix}${Date.now().toString(36).toUpperCase()}`.slice(0, 26).padEnd(26, "0");
const PROBES = [
  { connector: "lightspeed", domain: "sales", member: "sales_analytics.completed_at" },
  { connector: "deputy", domain: "timesheets", member: "workforce_analytics.shift_date" },
] as const;
const probeCube = (delays: Record<string, number>, queries: Array<{ member: string; direction: string }>): FreshnessProbeCube => ({
  loadQuery: async (query) => {
    const member = query.timeDimensions?.[0]?.dimension ?? "";
    const direction = String(Object.values(query.order ?? {})[0] ?? "");
    queries.push({ member, direction });
    await new Promise((resolve) => setTimeout(resolve, delays[member] ?? 0));
    const value = direction === "desc" ? "2026-09-19T00:00:00.000" : "2016-01-04T00:00:00.000";
    return { result: { ok: true, rows: [{ [`${member}.day`]: value }], executionMs: 1 } };
  },
});

test("a slow source costs only its own cutoff: probes that landed within the budget are kept", async () => {
  const queries: Array<{ member: string; direction: string }> = [];
  const started = Date.now();
  const freshness = await deriveConnectorFreshness({
    cube: probeCube({ "workforce_analytics.shift_date": 2_000 }, queries), tenantId: probeTenant("A"),
    probes: PROBES, activeConnectors: ["lightspeed", "deputy"], known: [], budgetMs: 200,
  });
  assert.ok(Date.now() - started < 1_000, "the caller stops waiting at the budget");
  assert.deepEqual(freshness.map((entry) => [entry.connector, entry.dataThrough]), [["lightspeed", "2026-09-19"]]);
});

test("turns that start together share one probe run, and Omni probes only the last day", async () => {
  const queries: Array<{ member: string; direction: string }> = [];
  const cube = probeCube({ "sales_analytics.completed_at": 50, "workforce_analytics.shift_date": 50 }, queries);
  const tenantId = probeTenant("B");
  const derive = () => deriveConnectorFreshness({ cube, tenantId, probes: PROBES, activeConnectors: ["lightspeed", "deputy"], known: [], edges: "latest" });
  const results = await Promise.all([derive(), derive(), derive(), derive()]);
  assert.equal(queries.length, 2, "one latest-date query per probe, for all four turns");
  assert.equal(queries.some((query) => query.direction === "asc"), false);
  for (const freshness of results) {
    assert.deepEqual(freshness.map((entry) => [entry.connector, entry.domain, entry.dataThrough, entry.dataFrom ?? null]),
      [["lightspeed", "sales", "2026-09-19", null], ["deputy", "timesheets", "2026-09-19", null]], "probe order, whatever order they land in");
  }
  await derive();
  assert.equal(queries.length, 2, "a later turn reads the cache");
});

test("an aborted turn stops waiting without cancelling the probes other turns share", async () => {
  const queries: Array<{ member: string; direction: string }> = [];
  const cube = probeCube({ "sales_analytics.completed_at": 300, "workforce_analytics.shift_date": 300 }, queries);
  const tenantId = probeTenant("C");
  const controller = new AbortController();
  const first = deriveConnectorFreshness({ cube, tenantId, probes: PROBES, activeConnectors: ["lightspeed", "deputy"], known: [], edges: "latest", signal: controller.signal });
  const second = deriveConnectorFreshness({ cube, tenantId, probes: PROBES, activeConnectors: ["lightspeed", "deputy"], known: [], edges: "latest" });
  controller.abort(new Error("turn cancelled"));
  assert.deepEqual(await first, []);
  assert.equal((await second).length, 2);
});

test("the prompt spells out yesterday and the week boundaries, so no model counts weekdays itself", () => {
  // Haiku compared "15–19 September" as last week (the week began Monday 14)
  // and had "Monday 15" refused as a wrong weekday.
  assert.equal(renderCalendarLine("Today is Wednesday 23 September 2026 (2026-09-23)."),
    "Yesterday was Tuesday 22 September. This week began Monday 21 September; last week ran Monday 14 September to Sunday 20 September.");
  assert.equal(renderCalendarLine("Today is Monday 21 September 2026 (2026-09-21)."),
    "Yesterday was Sunday 20 September. This week began Monday 21 September; last week ran Monday 14 September to Sunday 20 September.");
  assert.equal(renderCalendarLine("Today is Sunday 27 September 2026 (2026-09-27)."),
    "Yesterday was Saturday 26 September. This week began Monday 21 September; last week ran Monday 14 September to Sunday 20 September.");
  assert.equal(renderCalendarLine("Today is Friday 1 January 2027 (2027-01-01)."),
    "Yesterday was Thursday 31 December. This week began Monday 28 December; last week ran Monday 21 December to Sunday 27 December.");
  assert.equal(renderCalendarLine("Today is 2026-09-23 (UTC)."), "");
  const instructions = renderOmniInstructions({
    topicIndex: "- sales_analytics", topicCount: 1, timezone: "Australia/Melbourne", currency: "AUD",
    todayLine: "Today is Wednesday 23 September 2026 (2026-09-23).", activeConnectors: ["lightspeed-r"], freshnessLines: "- Data freshness: lightspeed sales through 2026-09-19",
  });
  assert.match(instructions, /Today is Wednesday 23 September 2026 \(2026-09-23\)\. Yesterday was Tuesday 22 September\. This week began Monday 21 September/u);
  // An empty asked-for period is said first and answered with the latest period that has data, not turned into a question.
  assert.match(instructions, /When the period asked about has no data yet \(today, yesterday, this week\), say so in the first sentence and answer with the latest period that does/u);
});
