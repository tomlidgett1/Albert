import assert from "node:assert/strict";
import test from "node:test";
import { renderBusinessContextSection, renderOmniInstructions } from "../../packages/albert-omni/src/prompts";
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
