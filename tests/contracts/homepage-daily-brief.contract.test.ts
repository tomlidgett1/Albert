import assert from "node:assert/strict";
import test from "node:test";
import { homepageDailyBrief } from "../../services/recommended-analysis/src/homepage-brief";
import { dailyBriefModelLabel, dailyBriefWindow } from "../../services/recommended-analysis/src/daily-brief";
import type { RecommendedQuestion } from "../../services/recommended-analysis/src/playbook";

const now = new Date("2026-09-10T10:00:00Z");
const row: RecommendedQuestion = { id: "daily-one", title: "Sales slowed despite more customers visiting", question: "What explains the lower sales in the last 24 hours?", why: "Sales fell against comparable weekday windows.", domain: "sales", move: "diagnose", tool: "lightspeed", fromTitle: "Daily look", fromConversationId: null };
const cached = { model: dailyBriefModelLabel("gpt-5.6-luna"), generatedAt: now.toISOString(), ...dailyBriefWindow(now), sourceFingerprint: "a".repeat(64), sourceCount: 1, verdict: "Sales need attention.", recommendations: [row] };

test("the homepage only serves current observed recommendations from connected sources", () => {
  assert.deepEqual(homepageDailyBrief(cached, ["lightspeed-r"], "Australia/Melbourne", now).recommendations, [row]);
  assert.deepEqual(homepageDailyBrief(cached, ["xero"], "Australia/Melbourne", now).recommendations, []);
  for (const cache of [null, { ...cached, model: "playbook" }, { ...cached, model: "omni:gpt-5.6-luna" }, { ...cached, ...dailyBriefWindow(new Date(+now - 7_200_000)) }]) {
    assert.deepEqual(homepageDailyBrief(cache, ["lightspeed-r"], "Australia/Melbourne", now).recommendations, []);
  }
});

test("an explicit quiet look remains empty and retains its genuine update time", () => {
  const result = homepageDailyBrief({ ...cached, recommendations: [] }, ["lightspeed-r"], "Australia/Melbourne", now);
  assert.equal(result.source, "daily");
  assert.equal(result.generatedAt, now.toISOString());
  assert.deepEqual(result.recommendations, []);
});
